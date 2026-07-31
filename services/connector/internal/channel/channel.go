// Package channel holds the connector's outbound, mutually authenticated
// control channel.
//
// docs/CONNECTOR_PROTOCOL.md section 5 fixes the transport: an outbound TLS
// connection with mutual authentication after enrolment, carrying WebSocket
// control and heartbeat channels with reconnect support. The connection is
// always initiated by the connector; nothing here listens.
//
// docs/ARCHITECTURE.md section 14 requires bounded reconnect on connector
// disconnect, and docs/CONNECTOR_PROTOCOL.md section 18 forbids reusing a
// revoked credential. Those two rules meet here: a transport failure is
// retried with jittered bounded backoff, and a refusal that names a terminal
// error class stops the loop instead.
package channel

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	connectorv1 "github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/connector/internal/backoff"
	"github.com/danjonesio/reviewplane/services/connector/internal/buildinfo"
	"github.com/danjonesio/reviewplane/services/connector/internal/config"
	"github.com/danjonesio/reviewplane/services/connector/internal/hostinfo"
	"github.com/danjonesio/reviewplane/services/connector/internal/identity"
	"github.com/danjonesio/reviewplane/services/connector/internal/logging"
	"github.com/danjonesio/reviewplane/services/connector/internal/protocolio"
	"github.com/danjonesio/reviewplane/services/connector/internal/routes"
	"github.com/danjonesio/reviewplane/services/connector/internal/transport"
	"github.com/danjonesio/reviewplane/services/connector/internal/ws"
)

// writeTimeout bounds one frame write.
const writeTimeout = 15 * time.Second

// DefaultDesiredStateTimeout bounds the wait for the control plane's desired
// state after a channel is established (docs/CONNECTOR_PROTOCOL.md section 17).
//
// The wait is bounded because the connector serves nothing while it lasts. A
// control plane that never answers must not leave the connector permanently
// mute either, so the timeout ends the channel and the backoff loop of section
// 5 tries again — with no route being served in the meantime.
const DefaultDesiredStateTimeout = 15 * time.Second

// Workspaces reports bounded Git context for the configured workspaces
// (docs/CONNECTOR_PROTOCOL.md section 9).
//
// It is a separate interface from Publisher because the two answer to different
// parts of the protocol and fail independently: a connector whose workspaces
// cannot be observed must still serve its routes, and one whose routes were all
// revoked must still say what its checkouts are doing. A nil Workspaces reports
// none, exactly as a nil Routes publishes none.
type Workspaces interface {
	// Refresh re-observes every configured workspace.
	Refresh(ctx context.Context)
	// HeadState is the section 17 reconnect claim, from the last observation.
	HeadState() []connectorv1.WorkspaceHead
	// Report is every current observation, sent once per established channel
	// after reconciliation has completed.
	Report() []connectorv1.WorkspaceObservation
	// Changed observes again and returns only what moved since it was last
	// reported.
	Changed(ctx context.Context) []connectorv1.WorkspaceObservation
	// Forget clears what has been reported, so that the next channel starts
	// with a full report.
	Forget()
	// Interval is how often Changed is polled.
	Interval() time.Duration
}

// Publisher answers a route publication and reconciles on reconnect.
//
// It is an interface so that the control channel can be tested without a
// gateway to dial; the production implementation is internal/routes.Manager.
type Publisher interface {
	Publish(request connectorv1.RoutePublish) connectorv1.RoutePublishAck
	ActiveRoutes() int
	ActiveStreams() int
	// BeginReconciliation withdraws every route from service and reports what
	// was withdrawn, which is the section 17 reconnect payload.
	BeginReconciliation() connectorv1.ReconnectRequest
	// ApplyDesiredState obeys the control plane's answer.
	ApplyDesiredState(
		connectorID string,
		response connectorv1.ReconnectResponse,
		logger *slog.Logger,
	) routes.ReconciliationResult
	// AbandonReconciliation records that the desired state never arrived. No
	// route is served, because BeginReconciliation already withdrew them all.
	AbandonReconciliation(reason string)
}

// Runner maintains the channel for one enrolled connector.
type Runner struct {
	Config *config.Config
	Store  *identity.Store
	Logger *slog.Logger

	// Routes answers route publications. A nil Routes refuses every
	// publication with PROTOCOL_UNSUPPORTED rather than leaving the control
	// plane waiting: an unanswered command is indistinguishable from a lost
	// one, and docs/UX_FLOWS.md section 18 requires an actionable cause.
	Routes Publisher

	// Workspaces supplies the section 9 observations and the section 17 head
	// state. A nil Workspaces claims and reports none, which is what a
	// connector with no workspaces block does.
	Workspaces Workspaces

	// DesiredStateTimeout bounds the wait for the section 17 desired state.
	// Zero means DefaultDesiredStateTimeout.
	DesiredStateTimeout time.Duration

	// OnConnected and OnHeartbeat let tests observe progress without parsing
	// log output. They are nil in production.
	OnConnected func(attempt int)
	OnHeartbeat func(sequence int)
	// OnPublished reports each acknowledgement the connector sent.
	OnPublished func(ack connectorv1.RoutePublishAck)
	// OnReconciled reports the outcome of each reconciliation exchange.
	OnReconciled func(result routes.ReconciliationResult)
	// OnObserved reports each batch of workspace observations sent.
	OnObserved func(observations []connectorv1.WorkspaceObservation)

	startedAt time.Time
}

// ErrNotEnrolled reports a data directory with no identity.
var ErrNotEnrolled = errors.New(
	"channel: this environment holds no connector identity; run \"reviewplane-connector enrol\" first")

// Run holds the channel open until ctx is cancelled or a terminal refusal
// arrives.
func (r *Runner) Run(ctx context.Context) error {
	if r.startedAt.IsZero() {
		r.startedAt = time.Now()
	}
	// The private key's permissions are validated on every start, not only at
	// enrolment (docs/DEVELOPMENT.md section 10).
	if err := r.Store.CheckKeyPermissions(); err != nil {
		return err
	}
	if !r.Store.Enrolled() {
		return ErrNotEnrolled
	}

	// The workspaces are observed once before the first dial, so that the very
	// first reconnect claim carries real head state rather than an empty array.
	// It runs here rather than inside the session because the claim is the first
	// frame on an established channel and nothing may delay it: a checkout on a
	// stalled mount would otherwise hold up reconciliation, during which the
	// connector serves no route at all (docs/CONNECTOR_PROTOCOL.md section 17).
	if r.Workspaces != nil {
		r.Workspaces.Refresh(ctx)
	}

	policy := backoff.Policy{
		Initial: r.Config.Reconnect.InitialDelay,
		Max:     r.Config.Reconnect.MaxDelay,
		Factor:  r.Config.Reconnect.Factor,
		Jitter:  r.Config.Reconnect.Jitter,
	}
	maxAttempts := r.Config.Reconnect.MaxAttempts

	// The attempt counter grows the backoff, so it bounds consecutive failures
	// rather than the connector's lifetime: a channel that stayed up longer than
	// the longest backoff delay ends the incident, and the next failure starts a
	// new one. Without that, a connector connected for hours would retry its next
	// unrelated drop at the maximum delay, turning a momentary interruption into
	// a minute of unavailability nothing in the failure justified. The window is
	// the maximum delay rather than "it connected at all", because a control
	// plane that accepts a channel and drops it immediately must still be backed
	// off from; otherwise flapping becomes a tight loop.
	attempt := 0
	for {
		attempt++
		uptime, err := r.session(ctx, attempt)
		switch {
		case err == nil, errors.Is(err, context.Canceled), ctx.Err() != nil:
			return nil
		}
		failure := transport.Classify(err)
		if failure.Terminal {
			// Failing closed here is the point: docs/CONNECTOR_PROTOCOL.md
			// section 18 requires that a revoked connector cannot reuse its
			// prior credentials, so the loop stops rather than retrying with
			// the credential the control plane just refused.
			r.Logger.Error("channel refused; not retrying with this identity",
				slog.String("error_class", string(failure.Class)),
				slog.String("error", failure.Err.Error()),
			)
			return failure
		}
		if maxAttempts > 0 && attempt >= maxAttempts {
			return fmt.Errorf("channel: giving up after %d attempts: %w", attempt, failure)
		}
		if policy.Max > 0 && uptime >= policy.Max {
			attempt = 1
		}
		delay, sleepErr := policy.Sleep(ctx, attempt)
		r.Logger.Warn("channel lost; reconnecting",
			slog.Int("attempt", attempt),
			slog.String("error_class", string(failure.Class)),
			slog.String("error", failure.Err.Error()),
			slog.Duration("retry_in", delay),
		)
		if sleepErr != nil {
			return nil
		}
	}
}

// session runs one connection from dial to close, and reports how long the
// channel was up. That is what tells a failed dial from a channel that worked
// for a while and then dropped.
func (r *Runner) session(ctx context.Context, attempt int) (time.Duration, error) {
	record, err := r.Store.LoadRecord()
	if err != nil {
		return 0, err
	}
	clientCertificate, leaf, err := r.Store.ClientCertificate()
	if err != nil {
		return 0, err
	}
	if time.Now().After(leaf.NotAfter) {
		return 0, &transport.Failure{
			Class:    connectorv1.ErrorClassIdentityRevoked,
			Terminal: true,
			Err: fmt.Errorf("channel: the device identity expired at %s; re-enrol this environment",
				leaf.NotAfter.UTC().Format(time.RFC3339)),
		}
	}

	tlsConfig, err := transport.NewTLSConfig(transport.TLSOptions{
		CAFile:            r.Config.ControlPlane.TLS.CAFile,
		ClientCertificate: &clientCertificate,
	})
	if err != nil {
		return 0, err
	}

	// Two loggers, one attribute apart. Most lines want the connector identity
	// attached; the reconciliation lines carry it themselves, because the
	// requirement in docs/ARCHITECTURE.md section 15 is about the decision record
	// rather than about whoever happened to log it, and a JSON handler would
	// otherwise emit the key twice.
	correlated := r.Logger.With(slog.String("correlation_id", logging.NewCorrelationID("cor_")))
	logger := correlated.With(slog.String("connector_id", record.ConnectorID))

	conn, err := ws.Dial(ctx, record.ControlURL, ws.DialOptions{
		TLSConfig:       tlsConfig,
		MaxMessageBytes: connectorv1.MaxControlFrameBytes,
		Header:          http.Header{"User-Agent": []string{buildinfo.UserAgent}},
	})
	if err != nil {
		return 0, err
	}
	establishedAt := time.Now()
	uptime := func() time.Duration { return time.Since(establishedAt) }
	defer func() { _ = conn.CloseNow() }()

	logger.Info("control channel established",
		slog.String("control_url", record.ControlURL),
		slog.Int("attempt", attempt),
		slog.String("certificate_fingerprint", record.CertificateFingerprint),
	)
	if r.OnConnected != nil {
		r.OnConnected(attempt)
	}

	sessionCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	idle := r.idleTimeout()
	conn.SetPongHandler(func() { _ = conn.SetReadDeadline(time.Now().Add(idle)) })

	// One writer serialises the heartbeat loop and the acknowledgements the
	// read loop produces. Two goroutines writing to one WebSocket would
	// interleave frames, which the peer would read as a malformed message and
	// close the channel over.
	writer := &frameWriter{conn: conn, connectorID: record.ConnectorID}

	state := &sessionState{conn: conn, connectorID: record.ConnectorID, logger: correlated}

	// Reconciliation runs before anything else this channel does. Every route
	// the connector held is withdrawn from service by BeginReconciliation, so
	// between here and the desired state arriving the connector serves nothing:
	// a route that is not reconciled is not authorised
	// (docs/CONNECTOR_PROTOCOL.md section 17).
	if err := r.openReconciliation(sessionCtx, state, writer, logger); err != nil {
		return uptime(), err
	}

	var finished sync.WaitGroup
	finished.Add(2)
	go func() {
		defer finished.Done()
		err := r.heartbeatLoop(sessionCtx, writer, logger)
		if err != nil && sessionCtx.Err() == nil {
			state.fail(err)
		}
	}()
	go func() {
		defer finished.Done()
		err := r.observationLoop(sessionCtx, state, writer, logger)
		if err != nil && sessionCtx.Err() == nil {
			state.fail(err)
		}
	}()

	readErr := r.readLoop(sessionCtx, conn, writer, idle, state, logger)
	cancel()
	finished.Wait()
	// The next channel starts with a full report. A control plane that restarted
	// has no memory of what this connector sent, and a workspace suppressed as
	// unchanged would stay invisible until it happened to change.
	if r.Workspaces != nil {
		r.Workspaces.Forget()
	}

	if failure := state.failure(); failure != nil {
		return uptime(), failure
	}
	if ctx.Err() != nil {
		_ = conn.Close(ws.CloseGoingAway, "")
		logger.Info("control channel closed by the connector")
		return uptime(), nil
	}
	return uptime(), readErr
}

// sessionState carries what one connection needs to end deliberately.
//
// Three things can decide a session is over before the peer does: a heartbeat
// that cannot be written, a desired state that never arrives, and an upgrade
// classification the connector must stop on. Each records why and unblocks the
// reader, so the session ends with a cause rather than with a bare read error.
type sessionState struct {
	conn        *ws.Conn
	connectorID string
	// logger carries the connection's correlation identifier but not its
	// connector identity, for the lines that state that identity themselves.
	logger *slog.Logger

	mu sync.Mutex
	// cause is the first deliberate failure recorded.
	cause error
	// pendingReconciliation is the message identifier of the reconnect request
	// still awaiting an answer, or empty.
	pendingReconciliation string
	// reconciled is closed once the desired state has been applied.
	reconciled chan struct{}
}

func (s *sessionState) fail(err error) {
	s.mu.Lock()
	if s.cause == nil {
		s.cause = err
	}
	s.mu.Unlock()
	// Unblock the reader so that the session ends promptly.
	_ = s.conn.CloseNow()
}

func (s *sessionState) failure() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cause
}

// claimReconciliation reports whether frame answers the outstanding request,
// and clears it so that a second answer is refused.
func (s *sessionState) claimReconciliation(correlationID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pendingReconciliation == "" || s.pendingReconciliation != correlationID {
		return false
	}
	s.pendingReconciliation = ""
	return true
}

// markReconciled releases whatever is waiting for reconciliation to finish. It
// is idempotent, because a duplicate desired state is refused rather than
// applied and must not close the channel a second time.
func (s *sessionState) markReconciled() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.reconciled == nil {
		return
	}
	select {
	case <-s.reconciled:
	default:
		close(s.reconciled)
	}
}

// openReconciliation withdraws every route and sends the section 17 reconnect
// payload, then arms the bounded wait for the answer.
func (r *Runner) openReconciliation(
	ctx context.Context,
	state *sessionState,
	writer *frameWriter,
	logger *slog.Logger,
) error {
	state.mu.Lock()
	state.reconciled = make(chan struct{})
	state.mu.Unlock()
	if r.Routes == nil {
		// Nothing to reconcile, so nothing waits: the observation loop is
		// released rather than left blocked on an exchange that will not happen.
		state.markReconciled()
		return nil
	}
	request := r.Routes.BeginReconciliation()
	// The route manager owns the route half of the claim and knows nothing about
	// workspaces; the head state is filled in here rather than by widening the
	// Publisher interface with a responsibility it does not have. All six fields
	// stay present, and workspace_head_state is now the connector's real
	// observed state rather than an empty array.
	request.WorkspaceHeadState = []connectorv1.WorkspaceHead{}
	if r.Workspaces != nil {
		if claimed := r.Workspaces.HeadState(); len(claimed) > 0 {
			request.WorkspaceHeadState = claimed
		}
	}
	messageID, err := protocolio.NewMessageID()
	if err != nil {
		return err
	}
	state.mu.Lock()
	state.pendingReconciliation = messageID
	state.mu.Unlock()

	if err := writer.sendWithID(messageID, request); err != nil {
		return err
	}
	logger.Info("reconciliation requested",
		slog.String("connector_id", state.connectorID),
		slog.String("message_id", messageID),
		slog.Int("claimed_routes", len(request.ActiveRoutes)),
		slog.Int("claimed_streams", len(request.ActiveStreams)),
		slog.Int("claimed_workspaces", len(request.WorkspaceHeadState)),
	)

	timeout := r.DesiredStateTimeout
	if timeout <= 0 {
		timeout = DefaultDesiredStateTimeout
	}
	go func() {
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		select {
		case <-state.reconciled:
		case <-ctx.Done():
		case <-timer.C:
			if !state.claimReconciliation(messageID) {
				return
			}
			// Nothing is being served, because BeginReconciliation withdrew every
			// route before the request went out. The channel is dropped so that
			// the bounded backoff of section 5 tries again.
			r.Routes.AbandonReconciliation("the control plane did not answer within " + timeout.String())
			state.fail(&transport.Failure{
				Class: connectorv1.ErrorClassControlPlaneUnavailable,
				Err: fmt.Errorf(
					"channel: the control plane did not send its desired state within %s; no route is being served",
					timeout),
			})
		}
	}()
	return nil
}

func (r *Runner) idleTimeout() time.Duration {
	idle := 3 * r.Config.Heartbeat.Interval
	if idle < 30*time.Second {
		idle = 30 * time.Second
	}
	return idle
}

// heartbeatLoop sends the section 8 heartbeat at the configured interval, and a
// WebSocket ping alongside it so that a control plane with nothing to say still
// proves the channel is alive.
func (r *Runner) heartbeatLoop(
	ctx context.Context,
	writer *frameWriter,
	logger *slog.Logger,
) error {
	ticker := time.NewTicker(r.Config.Heartbeat.Interval)
	defer ticker.Stop()

	for sequence := 1; ; sequence++ {
		if err := r.sendHeartbeat(writer); err != nil {
			return err
		}
		logger.Debug("heartbeat sent", slog.Int("sequence", sequence))
		if r.OnHeartbeat != nil {
			r.OnHeartbeat(sequence)
		}
		if err := writer.ping(); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// observationLoop reports workspace Git context for the life of one channel
// (docs/CONNECTOR_PROTOCOL.md section 9).
//
// It waits for reconciliation before it sends anything. Reconciliation is the
// first frame on every established channel (section 8), and a connector that
// interleaved an observation with its own claim would be describing workspaces
// to a control plane that has not yet said which routes it authorises. The
// initial full report therefore follows the desired state, and only changes
// follow it after that.
//
// Every frame goes through the same frameWriter as the heartbeat, so the
// single-writer discipline holds: two goroutines writing to one WebSocket would
// interleave frames, which the peer would read as a malformed message.
func (r *Runner) observationLoop(
	ctx context.Context,
	state *sessionState,
	writer *frameWriter,
	logger *slog.Logger,
) error {
	if r.Workspaces == nil {
		return nil
	}
	state.mu.Lock()
	reconciled := state.reconciled
	state.mu.Unlock()
	select {
	case <-ctx.Done():
		return nil
	case <-reconciled:
	}

	if err := r.sendObservations(ctx, writer, logger, r.Workspaces.Report(), "initial"); err != nil {
		return err
	}

	ticker := time.NewTicker(r.Workspaces.Interval())
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
		if err := r.sendObservations(ctx, writer, logger, r.Workspaces.Changed(ctx), "changed"); err != nil {
			return err
		}
	}
}

// sendObservations writes one frame per observation.
//
// Each observation is its own message rather than a batch, because the schema
// binds one workspace_observation to one envelope and bounds its payload at
// 2 048 bytes; batching would need a message type version 1 does not define.
func (r *Runner) sendObservations(
	ctx context.Context,
	writer *frameWriter,
	logger *slog.Logger,
	observations []connectorv1.WorkspaceObservation,
	trigger string,
) error {
	if len(observations) == 0 {
		return nil
	}
	for _, observation := range observations {
		if ctx.Err() != nil {
			return nil
		}
		if err := writer.send(observation); err != nil {
			return err
		}
		// The path is not logged, for the same reason it is not sent: the
		// workspace identifier and the display label are what identify a
		// checkout (docs/DOMAIN_MODEL.md section 9).
		logger.Debug("workspace observed",
			slog.String("workspace_id", observation.WorkspaceID),
			slog.String("project_id", observation.ProjectID),
			slog.String("branch", observation.Branch),
			slog.Bool("dirty", observation.Dirty),
			slog.String("trigger", trigger),
		)
	}
	logger.Info("workspace observations sent",
		slog.Int("observations", len(observations)),
		slog.String("trigger", trigger),
	)
	if r.OnObserved != nil {
		r.OnObserved(observations)
	}
	return nil
}

func (r *Runner) sendHeartbeat(writer *frameWriter) error {
	activeRoutes, activeStreams := 0, 0
	if r.Routes != nil {
		activeRoutes = r.Routes.ActiveRoutes()
		activeStreams = r.Routes.ActiveStreams()
	}
	payload := connectorv1.Heartbeat{
		Status:        connectorv1.HeartbeatStatusHealthy,
		UptimeSeconds: int64(time.Since(r.startedAt).Seconds()),
		Version:       buildinfo.Version,
		ActiveRoutes:  int64(activeRoutes),
		ActiveStreams: int64(activeStreams),
	}
	if summary := hostinfo.ReadResources(); summary.Load != nil || summary.MemoryAvailableBytes != nil {
		// Only load and memory_available_bytes exist in the schema, so no
		// process detail can be attached (docs/CONNECTOR_PROTOCOL.md section 8).
		payload.ResourceSummary = &connectorv1.ResourceSummary{
			Load:                 summary.Load,
			MemoryAvailableBytes: summary.MemoryAvailableBytes,
		}
	}
	return writer.send(payload)
}

// frameWriter serialises every frame this connector sends on one channel.
type frameWriter struct {
	mu          sync.Mutex
	conn        *ws.Conn
	connectorID string
}

// send encodes payload as a control frame and writes it.
func (w *frameWriter) send(payload connectorv1.Payload) error {
	frame, err := protocolio.NewFrame(payload, w.connectorID, time.Now())
	if err != nil {
		return err
	}
	return w.write(frame)
}

// sendWithID sends a frame under a caller-chosen message identifier, so that the
// answer can be correlated to it (docs/CONNECTOR_PROTOCOL.md section 7).
func (w *frameWriter) sendWithID(messageID string, payload connectorv1.Payload) error {
	frame, err := protocolio.NewFrame(payload, w.connectorID, time.Now())
	if err != nil {
		return err
	}
	frame.Envelope.MessageID = messageID
	return w.write(frame)
}

func (w *frameWriter) write(frame connectorv1.Frame) error {
	encoded, err := protocolio.Encode(frame)
	if err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.conn.SetWriteDeadline(time.Now().Add(writeTimeout)); err != nil {
		return err
	}
	return w.conn.WriteText(encoded)
}

func (w *frameWriter) ping() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.conn.Ping()
}

// readLoop consumes control-plane frames. Every frame passes through the
// generated decoder, so bounds, version, type and schema are checked before any
// field is read, and an unknown type is refused rather than ignored.
func (r *Runner) readLoop(
	ctx context.Context,
	conn *ws.Conn,
	writer *frameWriter,
	idle time.Duration,
	state *sessionState,
	logger *slog.Logger,
) error {
	for {
		if err := conn.SetReadDeadline(time.Now().Add(idle)); err != nil {
			return err
		}
		opcode, payload, err := conn.ReadMessage(ctx)
		if err != nil {
			return err
		}
		if opcode != ws.OpText {
			logger.Warn("refusing a non-text control frame", slog.Int("opcode", int(opcode)))
			_ = conn.Close(ws.CloseInvalidPayload, "control frames are UTF-8 JSON")
			return fmt.Errorf("channel: refused a frame with opcode %#x", opcode)
		}
		frame, protocolErr := connectorv1.DecodeControlFrame(payload)
		if protocolErr != nil {
			// The refusal reason is logged; the untrusted frame body is not.
			// A refused frame ends the session rather than being skipped:
			// docs/CONNECTOR_PROTOCOL.md section 7 requires refusal, never
			// best-effort parsing, and a peer sending frames this build cannot
			// verify is not a peer to keep talking to.
			logger.Warn("refusing a control frame",
				slog.String("reason", string(protocolErr.Reason)),
				slog.String("error_class", string(protocolErr.ErrorClass)),
			)
			_ = conn.Close(closeCodeFor(protocolErr.Reason), string(protocolErr.ErrorClass))
			return protocolErr
		}
		if direction := connectorv1.MessageDirections[frame.Envelope.Type]; direction != connectorv1.DirectionControlPlaneToConnector {
			logger.Warn("refusing a frame sent in the wrong direction",
				slog.String("message_type", string(frame.Envelope.Type)),
			)
			_ = conn.Close(ws.ClosePolicyViolation, string(connectorv1.ErrorClassProtocolUnsupported))
			return fmt.Errorf("channel: refused a %s frame, which only the connector sends", frame.Envelope.Type)
		}
		r.dispatch(frame, writer, state, logger)
	}
}

func (r *Runner) dispatch(
	frame connectorv1.Frame,
	writer *frameWriter,
	state *sessionState,
	logger *slog.Logger,
) {
	switch payload := frame.Payload.(type) {
	case connectorv1.RoutePublish:
		r.handleRoutePublish(payload, writer, logger)
	case connectorv1.ReconnectResponse:
		r.handleDesiredState(frame, payload, state, logger)
	case connectorv1.RegistrationResponse:
		logger.Warn("ignoring a registration response on an established channel",
			slog.String("message_id", frame.Envelope.MessageID),
		)
	default:
		logger.Warn("no handler for message type",
			slog.String("message_type", string(frame.Envelope.Type)),
		)
	}
}

// handleDesiredState applies the control plane's authoritative answer.
//
// It is accepted only as the answer to the request this channel actually sent.
// An unsolicited desired state, or a second one, is refused rather than applied:
// reconciliation is an exchange, and a response nobody asked for would be a way
// to reinstate a route outside one.
func (r *Runner) handleDesiredState(
	frame connectorv1.Frame,
	payload connectorv1.ReconnectResponse,
	state *sessionState,
	logger *slog.Logger,
) {
	correlation := ""
	if frame.Envelope.CorrelationID != nil {
		correlation = *frame.Envelope.CorrelationID
	}
	if !state.claimReconciliation(correlation) {
		logger.Warn("ignoring a desired state that answers no outstanding request",
			slog.String("message_id", frame.Envelope.MessageID),
			slog.String("correlation_id", correlation),
		)
		return
	}
	state.markReconciled()

	if r.Routes != nil {
		decisionLogger := state.logger
		if decisionLogger == nil {
			decisionLogger = logger
		}
		result := r.Routes.ApplyDesiredState(state.connectorID, payload, decisionLogger)
		if r.OnReconciled != nil {
			r.OnReconciled(result)
		}
	}

	// Section 19: upgrade_required and unsupported are terminal. Stage 0 reports
	// the classification and stops rather than self-updating, and no route is
	// left being served, because a refused connector serves nothing.
	switch payload.Upgrade {
	case connectorv1.UpgradeClassificationUpgradeRequired:
		state.fail(&transport.Failure{
			Class:    connectorv1.ErrorClassUpgradeRequired,
			Terminal: true,
			Err: fmt.Errorf(
				"channel: the control plane requires a newer connector than %s; upgrade this environment",
				buildinfo.Version),
		})
	case connectorv1.UpgradeClassificationUnsupported:
		state.fail(&transport.Failure{
			Class:    connectorv1.ErrorClassProtocolUnsupported,
			Terminal: true,
			Err: fmt.Errorf(
				"channel: the control plane does not support connector %s; upgrade this environment",
				buildinfo.Version),
		})
	case connectorv1.UpgradeClassificationUpgradeRecommended:
		logger.Warn("an upgrade is recommended for this connector",
			slog.String("connector_id", state.connectorID),
			slog.String("version", buildinfo.Version),
		)
	case connectorv1.UpgradeClassificationCompatible:
	}
}

// handleRoutePublish validates a publication and answers it.
//
// Every publication is answered. A `ready` acknowledgement carries the
// destination the connector observed; a `rejected` one carries a stable error
// class from docs/CONNECTOR_PROTOCOL.md section 21 and no free text
// (docs/SECURITY.md section 18). Leaving one unanswered would leave the control
// plane unable to tell a refusal from a lost frame, which
// docs/UX_FLOWS.md section 18 forbids.
func (r *Runner) handleRoutePublish(
	payload connectorv1.RoutePublish,
	writer *frameWriter,
	logger *slog.Logger,
) {
	var ack connectorv1.RoutePublishAck
	if r.Routes == nil {
		class := connectorv1.ErrorClassProtocolUnsupported
		ack = connectorv1.RoutePublishAck{
			RouteID:    payload.RouteID,
			Status:     connectorv1.RoutePublishAckStatusRejected,
			ErrorClass: &class,
		}
		logger.Warn("route publication refused: this connector carries no routes",
			slog.String("route_id", payload.RouteID))
	} else {
		ack = r.Routes.Publish(payload)
	}
	if r.OnPublished != nil {
		r.OnPublished(ack)
	}
	if err := writer.send(ack); err != nil {
		logger.Error("could not acknowledge a route publication",
			slog.String("route_id", payload.RouteID),
			slog.String("error", err.Error()),
		)
	}
}

func closeCodeFor(reason connectorv1.ViolationReason) int {
	switch reason {
	case connectorv1.ReasonFrameTooLarge, connectorv1.ReasonPayloadTooLarge:
		return ws.CloseMessageTooBig
	case connectorv1.ReasonUnsupportedProtocolVersion, connectorv1.ReasonUnknownMessageType:
		return ws.ClosePolicyViolation
	default:
		return ws.CloseInvalidPayload
	}
}
