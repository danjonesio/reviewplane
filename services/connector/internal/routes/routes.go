// Package routes is the connector's half of route publication and its data
// plane.
//
// docs/CONNECTOR_PROTOCOL.md section 11 gives the connector its own say over
// every publication: the control plane decides, and the connector validates
// independently and answers with an acknowledgement. Section 12 then makes the
// connector open exactly the destination that acknowledgement named, and
// nothing the browser request contains can change it.
//
// The validation and the multiplexer both live in
// services/tunnel-gateway/datachannel, and are imported rather than reimplemented.
// Both ends of the data channel must agree byte for byte on framing, on the
// 256 KiB initial window and on which side may open a stream; two
// implementations written against the same prose would be two things to keep in
// step. The same argument applies to the destination policy in
// services/tunnel-gateway/policy, which all three components share along with
// its corpus.
//
// Nothing here listens. The data channel is dialled outbound to the gateway,
// and the only inbound socket in the whole design is the loopback dial to the
// development service.
package routes

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"
	"sync"
	"time"

	connectorv1 "github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/connector/internal/buildinfo"
	"github.com/danjonesio/reviewplane/services/connector/internal/config"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/datachannel"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/policy"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/wsx"
)

// DefaultStartupGrace is the bounded window of docs/CONNECTOR_PROTOCOL.md
// section 11 in which a destination that is not listening yet may still become
// available.
//
// Agents commonly publish before the development server has finished booting,
// so a publication that failed the instant the port was closed would be a
// race the operator has to lose before learning anything. The grace is bounded
// and ends in PORT_NOT_LISTENING; it never becomes an indefinite wait.
const DefaultStartupGrace = 10 * time.Second

// dataChannelMessageBytes bounds one data-channel message. It matches the
// gateway's default so that neither side can send a message the other refuses.
const dataChannelMessageBytes = 64 << 10

// Options configures a Manager.
type Options struct {
	// Publication is the operator's publication block.
	Publication config.Publication
	// AuthorisedProjects lists the projects this connector serves. A
	// publication for another project is refused as PROJECT_NOT_AUTHORISED.
	AuthorisedProjects []string
	// KnownWorkspaces lists the workspace identifiers this connector has
	// observed.
	KnownWorkspaces []string
	// StartupGrace overrides DefaultStartupGrace.
	StartupGrace time.Duration
	// Probe reports whether a destination is listening within a bound. A nil
	// probe dials it.
	Probe func(destination string, within time.Duration) bool
	// Now supplies the clock.
	Now func() time.Time
	// Logger receives publication decisions. Destinations and route
	// identifiers are logged; no capability and no request byte ever is.
	Logger *slog.Logger
}

// Manager holds the routes this connector carries and the data channel that
// serves them.
type Manager struct {
	table     *datachannel.RouteTable
	publish   datachannel.PublicationConfig
	logger    *slog.Logger
	sessionMu sync.Mutex
	session   *datachannel.Session
	streams   func() int
}

// BuildPolicy turns the operator's publication block into the shared
// destination policy.
//
// An empty allow-list means "the Stage 0 default", not "everything": a
// configuration file that omits the block must not be the widest one.
func BuildPolicy(publication config.Publication) (policy.Policy, error) {
	result := policy.DefaultPolicy()
	if len(publication.AllowedHosts) > 0 {
		hosts := make([]netip.Addr, 0, len(publication.AllowedHosts))
		for _, host := range publication.AllowedHosts {
			address, err := netip.ParseAddr(host)
			if err != nil {
				// A name would have to be resolved, and a resolver is a
				// rebinding surface: the name that passed the check need not
				// be the address the connector later opens.
				return policy.Policy{}, fmt.Errorf(
					"publication.allowed_hosts: %q is not a literal IP address", host)
			}
			hosts = append(hosts, address)
		}
		result.AllowedHosts = hosts
	}
	if len(publication.AllowedPorts) > 0 {
		ranges := make([]policy.PortRange, 0, len(publication.AllowedPorts))
		for _, entry := range publication.AllowedPorts {
			parsed, err := policy.ParsePortRange(entry)
			if err != nil {
				return policy.Policy{}, fmt.Errorf("publication.allowed_ports: %w", err)
			}
			ranges = append(ranges, parsed)
		}
		result.AllowedPorts = ranges
	}
	return result, nil
}

// NewManager builds a manager from the operator's configuration.
func NewManager(options Options) (*Manager, error) {
	destinationPolicy, err := BuildPolicy(options.Publication)
	if err != nil {
		return nil, err
	}
	grace := options.StartupGrace
	if grace <= 0 {
		grace = DefaultStartupGrace
	}
	maxRoutes := options.Publication.MaxRoutes
	if maxRoutes <= 0 {
		maxRoutes = 10
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	manager := &Manager{
		table:  datachannel.NewRouteTable(),
		logger: logger,
		publish: datachannel.PublicationConfig{
			AuthorisedProjects: append([]string(nil), options.AuthorisedProjects...),
			KnownWorkspaces:    append([]string(nil), options.KnownWorkspaces...),
			Policy:             destinationPolicy,
			MaxRoutes:          maxRoutes,
			StartupGrace:       grace,
		},
	}
	if options.Probe != nil {
		manager.publish.Probe = options.Probe
	}
	if options.Now != nil {
		manager.publish.Now = options.Now
	}
	return manager, nil
}

// Table exposes the routes this connector carries.
func (m *Manager) Table() *datachannel.RouteTable { return m.table }

// ActiveRoutes counts carried routes, for the section 8 heartbeat.
func (m *Manager) ActiveRoutes() int { return m.table.Len() }

// ActiveStreams counts streams in flight, for the section 8 heartbeat.
func (m *Manager) ActiveStreams() int {
	m.sessionMu.Lock()
	defer m.sessionMu.Unlock()
	if m.streams == nil {
		return 0
	}
	return m.streams()
}

// Publish runs the connector-side validation of docs/CONNECTOR_PROTOCOL.md
// section 11 and returns the acknowledgement to send.
//
// A rejection carries a stable error class and no free text
// (docs/SECURITY.md section 18), and admits no route: the table is only written
// when the destination was allowed and observed listening.
func (m *Manager) Publish(request connectorv1.RoutePublish) connectorv1.RoutePublishAck {
	ack := datachannel.ValidatePublication(m.table, request, m.publish)
	if ack.Status == connectorv1.RoutePublishAckStatusReady {
		m.logger.Info("route published",
			slog.String("route_id", ack.RouteID),
			slog.String("project_id", request.ProjectID),
			slog.String("observed_destination", derefString(ack.ObservedDestination)),
			slog.Int("active_routes", m.table.Len()),
		)
		return ack
	}
	m.logger.Warn("route publication refused",
		slog.String("route_id", ack.RouteID),
		slog.String("project_id", request.ProjectID),
		slog.String("error_class", string(derefClass(ack.ErrorClass))),
	)
	return ack
}

// Withdraw drops a route. A stream that arrives for it afterwards is reset.
func (m *Manager) Withdraw(routeID string) {
	m.table.Remove(routeID)
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func derefClass(value *connectorv1.ErrorClass) connectorv1.ErrorClass {
	if value == nil {
		return ""
	}
	return *value
}

// DataChannelOptions configures the outbound data channel.
type DataChannelOptions struct {
	// Endpoint is the wss data URL from the registration response.
	Endpoint string
	// ConnectorID is the identity claimed on the handshake. The gateway
	// confirms it against the verified client certificate, so a mix-up is a
	// rejection rather than a silently mismatched channel.
	ConnectorID string
	// TLSConfig carries the connector's client certificate and the trust
	// anchor for the gateway.
	TLSConfig *tls.Config
	// HandshakeTimeout bounds the dial.
	HandshakeTimeout time.Duration
	// Session bounds the multiplexer.
	Session datachannel.SessionConfig
	// Dial bounds one loopback dial to the development service.
	DialTimeout time.Duration
	// OnEstablished is called once the channel is open, so that a supervisor can
	// tell a failed dial from a channel that worked and then dropped.
	OnEstablished func()
}

// ErrNoDataEndpoint reports an identity record with no data URL.
var ErrNoDataEndpoint = errors.New(
	"routes: the registration response named no data URL; re-enrol this environment")

// ServeDataChannel dials the gateway and serves streams until the channel ends
// or ctx is cancelled.
//
// The connector dials; the gateway never dials the connector. That is the
// outbound-only rule of ADR-0002, and it is why this returns rather than
// listening.
func (m *Manager) ServeDataChannel(ctx context.Context, options DataChannelOptions) error {
	if options.Endpoint == "" {
		return ErrNoDataEndpoint
	}
	header := http.Header{
		"User-Agent":                 []string{buildinfo.UserAgent},
		"X-ReviewPlane-Connector-Id": []string{options.ConnectorID},
	}
	conn, err := wsx.Dial(options.Endpoint, options.TLSConfig, header, wsx.Options{
		MaxMessageBytes:  dataChannelMessageBytes,
		HandshakeTimeout: options.HandshakeTimeout,
	})
	if err != nil {
		return fmt.Errorf("routes: dialling the data channel: %w", err)
	}

	sessionConfig := options.Session
	if sessionConfig.Now == nil && m.publish.Now != nil {
		sessionConfig.Now = m.publish.Now
	}
	session := datachannel.NewSession(conn, datachannel.RoleConnector, sessionConfig)

	m.sessionMu.Lock()
	m.session = session
	m.streams = session.ActiveStreams
	m.sessionMu.Unlock()
	defer func() {
		m.sessionMu.Lock()
		if m.session == session {
			m.session = nil
			m.streams = nil
		}
		m.sessionMu.Unlock()
		session.Close(nil)
	}()

	m.logger.Info("data channel established", slog.String("data_url", options.Endpoint))
	if options.OnEstablished != nil {
		options.OnEstablished()
	}

	served := make(chan error, 1)
	go func() {
		served <- datachannel.ServeConnector(session, datachannel.ConnectorConfig{
			Routes:      m.table,
			DialTimeout: options.DialTimeout,
			Now:         sessionConfig.Now,
		})
	}()

	select {
	case <-ctx.Done():
		return nil
	case err := <-served:
		return err
	}
}
