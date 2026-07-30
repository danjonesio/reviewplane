package datachannel

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/policy"
)

// The connector's half of the data channel.
//
// It lives beside the gateway's half so that both ends of the framing are one
// implementation. services/connector will use it as its data plane; the
// gateway's own tests use it as the protocol-level connector that
// docs/TESTING.md section 6 asks for, without a browser.
//
// Its defining property is the one docs/CONNECTOR_PROTOCOL.md section 12
// states: it opens only the pre-authorised local destination bound to the route
// identifier, and it does not accept a host or port supplied by the browser
// request. The request bytes are relayed to that socket without being parsed,
// so there is nothing in them for a destination to be read out of. That is the
// connector-side half of the defence in depth: the gateway also never forwards
// a client-supplied destination, and neither side relies on the other.

// LocalRoute is a route the connector has accepted and will serve.
type LocalRoute struct {
	RouteID     string
	ProjectID   string
	WorkspaceID string
	// Host and Port are fixed at publication. Nothing on the data channel can
	// change them.
	Host                     string
	Port                     int
	Protocol                 connectorv1.DestinationProtocol
	ExpiresAt                time.Time
	AllowedBrowserSessionIDs []string
}

// Destination renders the fixed upstream as host:port.
func (r LocalRoute) Destination() string {
	if strings.Contains(r.Host, ":") {
		return "[" + r.Host + "]:" + strconv.Itoa(r.Port)
	}
	return r.Host + ":" + strconv.Itoa(r.Port)
}

// RouteTable is the connector's local view of its published routes.
type RouteTable struct {
	mu     sync.RWMutex
	routes map[string]LocalRoute
}

// NewRouteTable builds an empty table.
func NewRouteTable() *RouteTable { return &RouteTable{routes: map[string]LocalRoute{}} }

// Put admits a route.
func (t *RouteTable) Put(route LocalRoute) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.routes[route.RouteID] = route
}

// Remove withdraws a route.
func (t *RouteTable) Remove(routeID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.routes, routeID)
}

// Get resolves a route identifier.
func (t *RouteTable) Get(routeID string) (LocalRoute, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	route, ok := t.routes[routeID]
	return route, ok
}

// Len counts admitted routes.
func (t *RouteTable) Len() int {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return len(t.routes)
}

// List returns every admitted route, ordered by route identifier so that two
// reads of an unchanged table produce the same reconnect payload
// (docs/CONNECTOR_PROTOCOL.md section 17).
func (t *RouteTable) List() []LocalRoute {
	t.mu.RLock()
	defer t.mu.RUnlock()
	routes := make([]LocalRoute, 0, len(t.routes))
	for _, route := range t.routes {
		routes = append(routes, route)
	}
	sort.Slice(routes, func(i, j int) bool { return routes[i].RouteID < routes[j].RouteID })
	return routes
}

// Drain removes every route and returns what was removed.
//
// It is how a connector enters the closed-route safe state of
// docs/CONNECTOR_PROTOCOL.md section 17 while it waits for the control plane's
// desired state: an unreconciled route serves nothing, so a reconciliation that
// times out cannot leave traffic flowing to a destination nobody has
// re-authorised.
func (t *RouteTable) Drain() []LocalRoute {
	t.mu.Lock()
	routes := make([]LocalRoute, 0, len(t.routes))
	for _, route := range t.routes {
		routes = append(routes, route)
	}
	t.routes = map[string]LocalRoute{}
	t.mu.Unlock()
	sort.Slice(routes, func(i, j int) bool { return routes[i].RouteID < routes[j].RouteID })
	return routes
}

// PublicationConfig is the connector's own publication policy, the
// configuration of docs/CONNECTOR_PROTOCOL.md section 20.
type PublicationConfig struct {
	// AuthorisedProjects lists the projects this connector serves. A publication
	// for another project is refused as PROJECT_NOT_AUTHORISED.
	AuthorisedProjects []string
	// KnownWorkspaces lists the workspaces this connector has observed.
	KnownWorkspaces []string
	// Policy is the local destination allow-list.
	Policy policy.Policy
	// MaxRoutes is the concurrent-route limit.
	MaxRoutes int
	// MaxTTL bounds an acceptable expiry.
	MaxTTL time.Duration
	// StartupGrace is the bounded window in which a port that is not listening
	// yet may still become available (docs/CONNECTOR_PROTOCOL.md section 11).
	StartupGrace time.Duration
	// Probe reports whether the destination is listening. A nil probe dials it.
	Probe func(destination string, within time.Duration) bool
	// Now supplies the clock.
	Now func() time.Time
}

func (c PublicationConfig) withDefaults() PublicationConfig {
	if c.MaxRoutes <= 0 {
		c.MaxRoutes = 10
	}
	if c.MaxTTL <= 0 {
		c.MaxTTL = 8 * time.Hour
	}
	if c.StartupGrace <= 0 {
		c.StartupGrace = 2 * time.Second
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.Probe == nil {
		c.Probe = dialProbe
	}
	return c
}

func dialProbe(destination string, within time.Duration) bool {
	deadline := time.Now().Add(within)
	for {
		conn, err := net.DialTimeout("tcp", destination, 250*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// ValidatePublication runs the connector-side checks of
// docs/CONNECTOR_PROTOCOL.md section 11 and returns the acknowledgement.
//
// The connector validates independently of the control plane. A control plane
// that had been persuaded to publish an unauthorised destination still gets a
// rejection here, which is the point of asking both sides.
func ValidatePublication(
	table *RouteTable,
	publish connectorv1.RoutePublish,
	config PublicationConfig,
) connectorv1.RoutePublishAck {
	return validate(table, publish, config, true)
}

// ValidateResumption runs the same checks for a route the control plane has
// told the connector to continue after a reconnect
// (docs/CONNECTOR_PROTOCOL.md section 17).
//
// It differs from ValidatePublication in exactly one way: it does not wait for
// the destination to be listening. The startup grace of section 11 answers a
// publication — "is this worth publishing yet?" — and the control plane has
// already answered that; on a resumption the same wait would make reconciliation
// take a bounded-but-real amount of time per route and would silently drop a
// route the control plane believes is live. A destination that has gone away is
// reported per stream as PORT_NOT_LISTENING, which is the diagnosis an operator
// can act on. Every authorisation check still runs, so the connector's own
// allow-list still refuses a destination the control plane should not have
// named.
func ValidateResumption(
	table *RouteTable,
	publish connectorv1.RoutePublish,
	config PublicationConfig,
) connectorv1.RoutePublishAck {
	return validate(table, publish, config, false)
}

func validate(
	table *RouteTable,
	publish connectorv1.RoutePublish,
	config PublicationConfig,
	probeDestination bool,
) connectorv1.RoutePublishAck {
	config = config.withDefaults()
	reject := func(class connectorv1.ErrorClass) connectorv1.RoutePublishAck {
		return connectorv1.RoutePublishAck{
			RouteID:    publish.RouteID,
			Status:     connectorv1.RoutePublishAckStatusRejected,
			ErrorClass: &class,
		}
	}

	if !contains(config.AuthorisedProjects, publish.ProjectID) {
		return reject(connectorv1.ErrorClassProjectNotAuthorised)
	}
	if !contains(config.KnownWorkspaces, publish.WorkspaceID) {
		return reject(connectorv1.ErrorClassWorkspaceNotFound)
	}
	if len(publish.AllowedBrowserSessionIDs) == 0 {
		return reject(connectorv1.ErrorClassProjectNotAuthorised)
	}
	if rejection := config.Policy.Evaluate(policy.Destination{
		Host:     publish.LocalHost,
		Port:     int(publish.LocalPort),
		Protocol: publish.Protocol,
	}); rejection != nil {
		return reject(rejection.Class)
	}

	expiresAt, err := time.Parse(time.RFC3339, publish.ExpiresAt)
	if err != nil {
		return reject(connectorv1.ErrorClassRouteExpired)
	}
	now := config.Now()
	if !expiresAt.After(now) || expiresAt.Sub(now) > config.MaxTTL {
		return reject(connectorv1.ErrorClassRouteExpired)
	}

	if _, already := table.Get(publish.RouteID); !already && table.Len() >= config.MaxRoutes {
		return reject(connectorv1.ErrorClassRouteLimitExceeded)
	}

	route := LocalRoute{
		RouteID:                  publish.RouteID,
		ProjectID:                publish.ProjectID,
		WorkspaceID:              publish.WorkspaceID,
		Host:                     publish.LocalHost,
		Port:                     int(publish.LocalPort),
		Protocol:                 publish.Protocol,
		ExpiresAt:                expiresAt,
		AllowedBrowserSessionIDs: append([]string(nil), publish.AllowedBrowserSessionIDs...),
	}
	if probeDestination && !config.Probe(route.Destination(), config.StartupGrace) {
		return reject(connectorv1.ErrorClassPortNotListening)
	}

	table.Put(route)
	destination := route.Destination()
	return connectorv1.RoutePublishAck{
		RouteID:             publish.RouteID,
		Status:              connectorv1.RoutePublishAckStatusReady,
		ObservedDestination: &destination,
	}
}

func contains(values []string, candidate string) bool {
	for _, value := range values {
		if value == candidate {
			return true
		}
	}
	return false
}

// RelayBufferBytes is the copy buffer one direction of one stream holds. It is
// the only per-stream allocation the relay makes; everything beyond it is
// bounded by the flow-control window of section 12.2, which is what turns a
// slow consumer into backpressure rather than into buffering on the developer's
// own machine.
const RelayBufferBytes = 32 << 10

// DefaultSweepInterval is how often the connector enforces stream deadlines and
// idle timeouts on the streams it is carrying.
const DefaultSweepInterval = 5 * time.Second

// ConnectorConfig configures the connector-side stream server.
type ConnectorConfig struct {
	Routes *RouteTable
	// Dial opens the local destination. A nil dialer uses a bounded TCP dial.
	Dial func(ctx context.Context, address string) (net.Conn, error)
	// DialTimeout bounds one dial.
	DialTimeout time.Duration
	// SweepInterval is how often deadlines and idle timeouts are enforced. The
	// connector runs its own sweep rather than trusting the gateway to close
	// everything: a channel that dies mid-stream would otherwise leave the
	// developer's machine holding open sockets nothing is going to end.
	SweepInterval time.Duration
	// Now supplies the clock.
	Now    func() time.Time
	Logger *slog.Logger
}

func (c ConnectorConfig) withDefaults() ConnectorConfig {
	if c.Dial == nil {
		dialer := &net.Dialer{}
		c.Dial = func(ctx context.Context, address string) (net.Conn, error) {
			return dialer.DialContext(ctx, "tcp", address)
		}
	}
	if c.DialTimeout <= 0 {
		c.DialTimeout = 5 * time.Second
	}
	if c.SweepInterval <= 0 {
		c.SweepInterval = DefaultSweepInterval
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.Logger == nil {
		c.Logger = slog.New(slog.DiscardHandler)
	}
	return c
}

// ServeConnector accepts streams and relays each to its route's fixed
// destination until the session ends.
func ServeConnector(session *Session, config ConnectorConfig) error {
	config = config.withDefaults()
	stop := make(chan struct{})
	defer close(stop)
	go sweepStreams(session, config, stop)
	for {
		stream, err := session.Accept()
		if err != nil {
			return err
		}
		go serveStream(stream, config)
	}
}

// sweepStreams enforces deadlines and idle timeouts until the session ends.
func sweepStreams(session *Session, config ConnectorConfig, stop <-chan struct{}) {
	ticker := time.NewTicker(config.SweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-session.Done():
			return
		case <-ticker.C:
			if closed := session.EnforceDeadlines(config.Now()); closed.Total() > 0 {
				config.Logger.Info("closed streams past their deadline or idle window",
					slog.Int("deadline", closed.Deadline),
					slog.Int("idle", closed.Idle),
				)
			}
		}
	}
}

func serveStream(stream *Stream, config ConnectorConfig) {
	header := stream.Header()
	route, known := config.Routes.Get(header.RouteID)
	if !known {
		// The gateway believes in a route this connector does not carry. That
		// is the reconnect-reconciliation case of
		// docs/CONNECTOR_PROTOCOL.md section 17, and until it is reconciled the
		// only safe answer is to open nothing.
		_ = stream.Reset(connectorv1.ErrorClassRouteExpired)
		return
	}
	if !config.Now().Before(route.ExpiresAt) {
		_ = stream.Reset(connectorv1.ErrorClassRouteExpired)
		return
	}
	if !contains(route.AllowedBrowserSessionIDs, header.BrowserSessionID) {
		// The gateway checks this too. Checking it again here is the second half
		// of the defence in depth: a gateway that had been persuaded to open a
		// stream for an unauthorised session still reaches nothing.
		_ = stream.Reset(connectorv1.ErrorClassProjectNotAuthorised)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), config.DialTimeout)
	// The address comes from the route table, never from the header and never
	// from the request bytes. The header schema has no host or port field, and
	// the bytes are relayed without being parsed. That is as true of an
	// upgraded stream as of any other: stream_mode selects an idle window and
	// nothing else.
	upstream, err := config.Dial(ctx, route.Destination())
	cancel()
	if err != nil {
		config.Logger.Warn("local destination is not listening",
			slog.String("route_id", route.RouteID),
			slog.String("destination", route.Destination()),
		)
		_ = stream.Reset(connectorv1.ErrorClassPortNotListening)
		return
	}
	defer func() { _ = upstream.Close() }()

	if err := stream.ConfirmAccepted(); err != nil {
		return
	}
	if deadline, ok := stream.Deadline(); ok {
		// The absolute deadline is the route's expiry, so the local socket
		// cannot outlive the authorisation that opened it even if every other
		// control failed. It is not the liveness control: that is the idle
		// window, enforced by the sweep above.
		_ = upstream.SetDeadline(deadline)
	}

	// A stream that ends while this goroutine is parked reading the local
	// socket would otherwise stay parked until that absolute deadline, which on
	// an upgraded stream is hours away. Closing the socket when the stream
	// terminates is what makes revocation, expiry and a lost data channel reach
	// the development service promptly.
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		select {
		case <-stream.Done():
			_ = upstream.Close()
		case <-finished:
		}
	}()

	upgraded := stream.Mode() == connectorv1.StreamModeUpgrade

	var wait sync.WaitGroup
	wait.Add(1)
	go func() {
		defer wait.Done()
		// Gateway to destination. CloseWrite tells the development service the
		// request is complete, which is what lets it answer a request with no
		// Content-Length, and on an upgraded connection it is how a browser-side
		// close reaches the far end.
		_, _ = io.CopyBuffer(upstream, stream, make([]byte, RelayBufferBytes))
		if closer, ok := upstream.(interface{ CloseWrite() error }); ok {
			_ = closer.CloseWrite()
		}
	}()

	_, copyErr := io.CopyBuffer(stream, upstream, make([]byte, RelayBufferBytes))
	_ = stream.CloseWrite()
	if upgraded {
		// An upgraded connection is one conversation, not a request followed by
		// an answer. Once the development service has closed its end there is
		// nothing further for the browser to send, and leaving the other
		// direction parked would hold the stream open until its deadline. This
		// is also what propagates a server-initiated close back to the browser.
		_ = stream.Close()
	}
	wait.Wait()
	if copyErr != nil && !errors.Is(copyErr, io.EOF) {
		config.Logger.Debug("stream ended",
			slog.String("route_id", route.RouteID),
			slog.String("stream_id", header.StreamID),
		)
	}
}
