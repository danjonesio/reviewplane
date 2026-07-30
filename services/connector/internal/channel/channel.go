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
	"github.com/danjonesio/reviewplane/services/connector/internal/transport"
	"github.com/danjonesio/reviewplane/services/connector/internal/ws"
)

// writeTimeout bounds one frame write.
const writeTimeout = 15 * time.Second

// Runner maintains the channel for one enrolled connector.
type Runner struct {
	Config *config.Config
	Store  *identity.Store
	Logger *slog.Logger

	// OnConnected and OnHeartbeat let tests observe progress without parsing
	// log output. They are nil in production.
	OnConnected func(attempt int)
	OnHeartbeat func(sequence int)

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

	policy := backoff.Policy{
		Initial: r.Config.Reconnect.InitialDelay,
		Max:     r.Config.Reconnect.MaxDelay,
		Factor:  r.Config.Reconnect.Factor,
		Jitter:  r.Config.Reconnect.Jitter,
	}
	maxAttempts := r.Config.Reconnect.MaxAttempts

	for attempt := 1; ; attempt++ {
		err := r.session(ctx, attempt)
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

// session runs one connection from dial to close.
func (r *Runner) session(ctx context.Context, attempt int) error {
	record, err := r.Store.LoadRecord()
	if err != nil {
		return err
	}
	clientCertificate, leaf, err := r.Store.ClientCertificate()
	if err != nil {
		return err
	}
	if time.Now().After(leaf.NotAfter) {
		return &transport.Failure{
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
		return err
	}

	logger := r.Logger.With(
		slog.String("connector_id", record.ConnectorID),
		slog.String("correlation_id", logging.NewCorrelationID("cor_")),
	)

	conn, err := ws.Dial(ctx, record.ControlURL, ws.DialOptions{
		TLSConfig:       tlsConfig,
		MaxMessageBytes: connectorv1.MaxControlFrameBytes,
		Header:          http.Header{"User-Agent": []string{buildinfo.UserAgent}},
	})
	if err != nil {
		return err
	}
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

	var (
		writeMutex   sync.Mutex
		writeFailure error
		finished     = make(chan struct{})
	)
	go func() {
		defer close(finished)
		err := r.heartbeatLoop(sessionCtx, conn, record.ConnectorID, logger)
		if err != nil && sessionCtx.Err() == nil {
			writeMutex.Lock()
			writeFailure = err
			writeMutex.Unlock()
			// Unblock the reader so that the session ends promptly.
			_ = conn.CloseNow()
		}
	}()

	readErr := r.readLoop(sessionCtx, conn, idle, logger)
	cancel()
	<-finished

	writeMutex.Lock()
	failure := writeFailure
	writeMutex.Unlock()
	if failure != nil {
		return failure
	}
	if ctx.Err() != nil {
		_ = conn.Close(ws.CloseGoingAway, "")
		logger.Info("control channel closed by the connector")
		return nil
	}
	return readErr
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
	conn *ws.Conn,
	connectorID string,
	logger *slog.Logger,
) error {
	ticker := time.NewTicker(r.Config.Heartbeat.Interval)
	defer ticker.Stop()

	for sequence := 1; ; sequence++ {
		if err := r.sendHeartbeat(conn, connectorID); err != nil {
			return err
		}
		logger.Debug("heartbeat sent", slog.Int("sequence", sequence))
		if r.OnHeartbeat != nil {
			r.OnHeartbeat(sequence)
		}
		if err := conn.Ping(); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (r *Runner) sendHeartbeat(conn *ws.Conn, connectorID string) error {
	payload := connectorv1.Heartbeat{
		Status:        connectorv1.HeartbeatStatusHealthy,
		UptimeSeconds: int64(time.Since(r.startedAt).Seconds()),
		Version:       buildinfo.Version,
		// Route publication and data streams are separate changes; this build
		// holds none open, and reports that honestly rather than omitting it.
		ActiveRoutes:  0,
		ActiveStreams: 0,
	}
	if summary := hostinfo.ReadResources(); summary.Load != nil || summary.MemoryAvailableBytes != nil {
		// Only load and memory_available_bytes exist in the schema, so no
		// process detail can be attached (docs/CONNECTOR_PROTOCOL.md section 8).
		payload.ResourceSummary = &connectorv1.ResourceSummary{
			Load:                 summary.Load,
			MemoryAvailableBytes: summary.MemoryAvailableBytes,
		}
	}
	frame, err := protocolio.NewFrame(payload, connectorID, time.Now())
	if err != nil {
		return err
	}
	encoded, err := protocolio.Encode(frame)
	if err != nil {
		return err
	}
	if err := conn.SetWriteDeadline(time.Now().Add(writeTimeout)); err != nil {
		return err
	}
	return conn.WriteText(encoded)
}

// readLoop consumes control-plane frames. Every frame passes through the
// generated decoder, so bounds, version, type and schema are checked before any
// field is read, and an unknown type is refused rather than ignored.
func (r *Runner) readLoop(ctx context.Context, conn *ws.Conn, idle time.Duration, logger *slog.Logger) error {
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
		r.dispatch(frame, logger)
	}
}

func (r *Runner) dispatch(frame connectorv1.Frame, logger *slog.Logger) {
	switch payload := frame.Payload.(type) {
	case connectorv1.RoutePublish:
		// Route publication is a separate change ("Publish a loopback
		// development service and reach it from central Chromium"). This build
		// advertises the tunnel capabilities but does not yet open routes, so
		// the request is recorded and left unacknowledged rather than answered
		// with an error class that would misdescribe the reason.
		logger.Warn("route publication is not implemented by this connector build",
			slog.String("route_id", payload.RouteID),
			slog.String("message_id", frame.Envelope.MessageID),
		)
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
