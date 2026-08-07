package gatewayhttp

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/datachannel"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/internal/metrics"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/internal/registry"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/wsx"
)

// DataChannelPath is where a connector opens its multiplexed data channel. It
// matches the data_url of the registration response
// (docs/CONNECTOR_PROTOCOL.md section 4.3).
const DataChannelPath = "/connector/data"

// ConnectorIDHeader is the identity a connector claims on the data-channel
// handshake. It must equal the identity derived from its verified client
// certificate; a mismatch is refused. Claiming an identity that the transport
// then has to confirm turns a silent mix-up into a rejection.
const ConnectorIDHeader = "X-ReviewPlane-Connector-Id"

// CapabilityKeys verifies route capabilities against the control plane's
// signing keys.
type CapabilityKeys struct {
	Keyring connectorv1.CapabilityKeyring
}

// Verify authenticates one capability token.
func (k CapabilityKeys) Verify(token string, nowUnix int64) (connectorv1.CapabilityClaims, *connectorv1.CapabilityError) {
	return connectorv1.VerifyCapability(k.Keyring, token, nowUnix)
}

// Config is everything the gateway needs to run.
type Config struct {
	Proxy    ProxyConfig
	Admin    AdminConfig
	Registry registry.Config
	Session  datachannel.SessionConfig
	Identity IdentityPolicy
	// Keyring holds the capability signing keys shared with the control plane.
	Keyring connectorv1.CapabilityKeyring
	// SweepInterval is how often expiry and stream deadlines are enforced.
	SweepInterval time.Duration
	// MaxDataChannelMessageBytes bounds one data-channel message.
	MaxDataChannelMessageBytes int
	Now                        func() time.Time
}

func (c Config) withDefaults() Config {
	if c.SweepInterval <= 0 {
		c.SweepInterval = 5 * time.Second
	}
	if c.MaxDataChannelMessageBytes <= 0 {
		c.MaxDataChannelMessageBytes = 64 << 10
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	c.Proxy.Now = c.Now
	c.Registry.Now = c.Now
	c.Session.Now = c.Now
	c.Admin.Now = c.Now
	if c.Admin.InternalSuffix == "" {
		c.Admin.InternalSuffix = c.Proxy.InternalSuffix
	}
	if c.Admin.MaxCapabilityLifetime <= 0 {
		// A capability may not outlive its route, so the maximum route lifetime
		// is the upper bound on how long a withdrawal has to be remembered.
		c.Admin.MaxCapabilityLifetime = c.Registry.MaxRouteTTL
	}
	return c
}

// Gateway is the assembled service.
type Gateway struct {
	config   Config
	metrics  *metrics.Registry
	logger   *slog.Logger
	auditor  *SlogAuditor
	routes   *registry.Registry
	channels *Channels
	proxy    *Proxy
	admin    *Admin

	stop chan struct{}
}

// New assembles the gateway.
func New(config Config, logger *slog.Logger) (*Gateway, error) {
	config = config.withDefaults()
	if len(config.Keyring) == 0 {
		return nil, errors.New("gatewayhttp: no capability signing key is configured")
	}
	registryMetrics := metrics.New()
	auditor := NewSlogAuditor(logger, registryMetrics, config.Now, 512)
	channels := NewChannels()

	lifecycle := &observer{auditor: auditor, metrics: registryMetrics}
	routes, err := registry.New(config.Registry, lifecycle)
	if err != nil {
		return nil, err
	}
	lifecycle.registry = routes.Routes

	proxy := NewProxy(config.Proxy, routes, channels, CapabilityKeys{Keyring: config.Keyring},
		registryMetrics, logger, auditor)
	admin, err := NewAdmin(config.Admin, routes, channels, registryMetrics, auditor, logger)
	if err != nil {
		return nil, err
	}
	reportRevocations(registryMetrics, routes)
	return &Gateway{
		config:   config,
		metrics:  registryMetrics,
		logger:   logger,
		auditor:  auditor,
		routes:   routes,
		channels: channels,
		proxy:    proxy,
		admin:    admin,
		stop:     make(chan struct{}),
	}, nil
}

// ProxyHandler is the browser-facing handler.
func (g *Gateway) ProxyHandler() http.Handler { return g.proxy }

// AdminHandler is the control-plane-facing handler.
func (g *Gateway) AdminHandler() http.Handler { return g.admin.Handler() }

// Routes exposes the registry, for the connector listener and for tests.
func (g *Gateway) Routes() *registry.Registry { return g.routes }

// Channels exposes the connector channel set.
func (g *Gateway) Channels() *Channels { return g.channels }

// Metrics exposes the counter set.
func (g *Gateway) Metrics() *metrics.Registry { return g.metrics }

// Auditor exposes the audit ring.
func (g *Gateway) Auditor() *SlogAuditor { return g.auditor }

// ConnectorHandler terminates connector data channels.
//
// The order of the checks is the identity boundary: TLS has already required a
// client certificate chaining to the configured authority, so the identity is
// derived from the verified chain before the WebSocket upgrade is answered. An
// upgrade is never completed for a channel whose identity the gateway cannot
// establish.
func (g *Gateway) ConnectorHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		remote := r.RemoteAddr
		if r.URL.Path != DataChannelPath {
			g.auditor.ConnectorChannelRefused("unknown_path", remote)
			writeError(w, http.StatusNotFound, CodePublishedServiceUnavailable, newRequestID())
			return
		}
		if r.TLS == nil {
			g.auditor.ConnectorChannelRefused("no_tls", remote)
			writeError(w, http.StatusForbidden, CodeAuthenticationRequired, newRequestID())
			return
		}
		connectorID, err := ConnectorIdentity(*r.TLS, g.config.Identity)
		if err != nil {
			reason := "identity_underivable"
			if errors.Is(err, ErrNoClientCertificate) {
				reason = "no_client_certificate"
			}
			g.auditor.ConnectorChannelRefused(reason, remote)
			writeError(w, http.StatusForbidden, CodeAuthenticationRequired, newRequestID())
			return
		}
		if claimed := r.Header.Get(ConnectorIDHeader); claimed != "" && claimed != connectorID {
			g.auditor.ConnectorChannelRefused("identity_mismatch", remote)
			writeError(w, http.StatusForbidden, CodeAuthorisationDenied, newRequestID())
			return
		}

		conn, err := wsx.Accept(w, r, wsx.Options{MaxMessageBytes: g.config.MaxDataChannelMessageBytes})
		if err != nil {
			g.auditor.ConnectorChannelRefused("handshake_failed", remote)
			return
		}
		session := datachannel.NewSession(conn, datachannel.RoleGateway, g.config.Session)
		g.channels.Put(connectorID, session, remote, g.config.Now())
		g.auditor.ConnectorChannelOpened(connectorID, remote)
		g.metrics.SetGauge(metrics.ConnectorChannelsOpen, float64(g.channels.Count()))

		go func() {
			<-session.Done()
			g.channels.Remove(connectorID, session)
			g.auditor.ConnectorChannelClosed(connectorID, session.Err())
			g.metrics.SetGauge(metrics.ConnectorChannelsOpen, float64(g.channels.Count()))
		}()
	})
}

// TLSConfig builds the connector listener's TLS configuration.
//
// Client authentication is required and verified: docs/ARCHITECTURE.md section
// 11 and docs/SECURITY.md section 15 both make the connector channel mutually
// authenticated, and RequireAndVerifyClientCert is the difference between
// asking for a certificate and requiring one that chains to the control
// plane's authority.
func TLSConfig(serverCertificate tls.Certificate, clientAuthority *x509.CertPool) *tls.Config {
	return &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{serverCertificate},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    clientAuthority,
	}
}

// Sweep enforces route expiry and stream deadlines once.
//
// It is exported and takes an instant so that a test can drive it, and so that
// the caller decides the cadence. Expiry that only happened on a timer would be
// untestable without sleeping.
func (g *Gateway) Sweep(now time.Time) (routesExpired int, streamsClosed int) {
	expired, err := g.routes.ExpireDue()
	if err != nil {
		// An expired route is already unreachable, so the sweep does not stop
		// here; but a journal the gateway cannot write is the durability
		// guarantee failing, and it says so at error level rather than once.
		g.logger.Error("the gateway could not record an expiry",
			slog.String("error", err.Error()))
	}
	closed := g.channels.EnforceDeadlines(now)
	if closed.Deadline > 0 {
		g.metrics.Add(metrics.Streams, float64(closed.Deadline), "outcome", "deadline_exceeded")
	}
	if closed.Idle > 0 {
		// Idle is counted apart from deadline because the two say different
		// things to an operator: a deadline means the route ran out, and idle
		// means nothing moved for the window that stream's mode allows.
		g.metrics.Add(metrics.Streams, float64(closed.Idle), "outcome", "idle_timeout")
	}
	// Withdrawals are dropped when nothing could still present them, which is
	// the record's own NotAfter and not how long ago it was written. The sweep
	// used to pass now-24h, so a revocation was forgotten by age while the
	// credential it refused might still be live, and kept long after it could
	// not be.
	g.routes.ForgetRevocations(now)
	reportRevocations(g.metrics, g.routes)
	g.metrics.SetGauge(metrics.RoutesActive, float64(len(g.routes.Routes())))
	return len(expired), closed.Total()
}

// reportRevocations publishes the size of the withdrawal set. It is a gauge an
// operator can watch across a restart: a gateway that came up having forgotten
// what it revoked reports zero, and that is visible rather than silent.
func reportRevocations(registryMetrics *metrics.Registry, routes *registry.Registry) {
	byKind := map[registry.RevocationKind]float64{
		registry.RevokeRouteSubject:      0,
		registry.RevokeCapabilitySubject: 0,
	}
	for _, entry := range routes.Revocations() {
		byKind[entry.Kind]++
	}
	registryMetrics.SetGauge(metrics.Revocations, byKind[registry.RevokeRouteSubject],
		"subject", metrics.SubjectRoute)
	registryMetrics.SetGauge(metrics.Revocations, byKind[registry.RevokeCapabilitySubject],
		"subject", metrics.SubjectCapability)
}

// Run sweeps until the context-like stop channel is closed.
func (g *Gateway) Run() {
	ticker := time.NewTicker(g.config.SweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-g.stop:
			return
		case <-ticker.C:
			g.Sweep(g.config.Now())
		}
	}
}

// Shutdown stops sweeping and closes every connector channel.
func (g *Gateway) Shutdown() {
	select {
	case <-g.stop:
	default:
		close(g.stop)
	}
	g.channels.CloseAll(errors.New("gatewayhttp: gateway shutting down"))
}
