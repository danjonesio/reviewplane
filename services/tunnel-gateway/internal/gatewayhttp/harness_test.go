package gatewayhttp

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/datachannel"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/internal/registry"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/internal/testca"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/policy"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/wsx"
)

func registryConfigForTest(destinations policy.Policy, maxRoutes int) registry.Config {
	return registry.Config{
		Policy:                destinations,
		MaxRoutesPerConnector: maxRoutes,
		MaxRouteTTL:           8 * time.Hour,
	}
}

// The harness assembles a whole gateway: a real mutually authenticated TLS
// listener, a real WebSocket data channel, a real connector serving a real
// loopback development server. docs/TESTING.md section 6 asks for the tunnel to
// be proven with a protocol-level client rather than a browser, and this is
// that client.

const (
	testConnectorID = "con_test_01"
	testProjectID   = "prj_test_01"
	testWorkspaceID = "wsp_test_01"
	testRouteID     = "svc_test_01"
	testAlias       = "svc-test-01"
	testSessionID   = "brs_test_01"
	testAdminToken  = "gateway-control-plane-token-0123456789"
	testKeyID       = "stage0-a"
	testSuffix      = "internal.invalid"
)

type clock struct {
	mu  sync.Mutex
	now time.Time
}

func newClock() *clock {
	return &clock{now: time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)}
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

type harness struct {
	t         *testing.T
	gateway   *Gateway
	clock     *clock
	logs      *bytes.Buffer
	authority *testca.Authority

	proxy     *httptest.Server
	connector *httptest.Server
	admin     *httptest.Server

	dev         *httptest.Server
	devHost     string
	devPort     int
	lastRequest chan recordedRequest

	routes     *datachannel.RouteTable
	session    *datachannel.Session
	sessionCfg datachannel.SessionConfig
	wrapConn   func(datachannel.MessageConn) datachannel.MessageConn
	requests   *requestTracker

	signingKey []byte
}

// requestTracker counts browser requests the gateway is still handling.
//
// A client's request completes when it has read the response, but the gateway
// records the last of its counters — the stream outcome and the request code —
// after the body has been written. Anything that asserts on metrics, counters,
// logs or audit records after a request therefore has to wait for the handler
// itself, not for the response.
type requestTracker struct {
	started  atomic.Int64
	finished atomic.Int64
	// notify carries one wake-up. A completion that finds it full does not
	// block: the waiter re-reads the counters after every wake-up, so a dropped
	// signal cannot lose a completion.
	notify chan struct{}
}

func newRequestTracker() *requestTracker {
	return &requestTracker{notify: make(chan struct{}, 1)}
}

func (t *requestTracker) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.started.Add(1)
		defer func() {
			// The counter is incremented before the signal, so a waiter that
			// reads the counters after being woken always sees this completion.
			t.finished.Add(1)
			select {
			case t.notify <- struct{}{}:
			default:
			}
		}()
		next.ServeHTTP(w, r)
	})
}

type recordedRequest struct {
	Method  string
	Path    string
	Host    string
	Headers http.Header
	Body    string
}

type harnessOptions struct {
	devHandler   http.HandlerFunc
	sessionCfg   datachannel.SessionConfig
	proxyCfg     ProxyConfig
	identity     IdentityPolicy
	skipConnect  bool
	maxRoutes    int
	connectorTLS func(*tls.Config)
	// wrapConn lets a test observe the data channel's frames without changing
	// how the gateway or the connector behave.
	wrapConn func(datachannel.MessageConn) datachannel.MessageConn
}

func newHarness(t *testing.T, options harnessOptions) *harness {
	t.Helper()
	h := &harness{
		t:           t,
		clock:       newClock(),
		logs:        &bytes.Buffer{},
		authority:   testca.New(t, "reviewplane-stage0-connector-ca"),
		routes:      datachannel.NewRouteTable(),
		signingKey:  bytes.Repeat([]byte{0x11}, 32),
		lastRequest: make(chan recordedRequest, 16),
	}

	handler := options.devHandler
	if handler == nil {
		handler = func(w http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(r.Body)
			h.lastRequest <- recordedRequest{
				Method:  r.Method,
				Path:    r.URL.RequestURI(),
				Host:    r.Host,
				Headers: r.Header.Clone(),
				Body:    string(body),
			}
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.Header().Set("X-Dev-Server", "fixture")
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, "hello from the development server")
		}
	}
	h.dev = httptest.NewServer(handler)
	t.Cleanup(h.dev.Close)
	devURL := strings.TrimPrefix(h.dev.URL, "http://")
	host, port, err := net.SplitHostPort(devURL)
	if err != nil {
		t.Fatalf("split development server address: %v", err)
	}
	h.devHost = host
	h.devPort, _ = strconv.Atoi(port)

	logger := slog.New(slog.NewJSONHandler(h.logs, &slog.HandlerOptions{Level: slog.LevelDebug}))

	maxRoutes := options.maxRoutes
	if maxRoutes <= 0 {
		maxRoutes = 10
	}
	proxyCfg := options.proxyCfg
	proxyCfg.InternalSuffix = testSuffix

	gateway, err := New(Config{
		Proxy: proxyCfg,
		Admin: AdminConfig{Token: testAdminToken, InternalSuffix: testSuffix},
		Registry: registryConfigForTest(policy.Policy{
			AllowedHosts:     mustHosts(t, "127.0.0.1,::1"),
			AllowedPorts:     []policy.PortRange{{Low: 1024, High: 65535}},
			AllowedProtocols: []connectorv1.DestinationProtocol{connectorv1.DestinationProtocolHTTP},
		}, maxRoutes),
		Session:  options.sessionCfg,
		Identity: options.identity,
		Keyring:  connectorv1.CapabilityKeyring{testKeyID: h.signingKey},
		Now:      h.clock.Now,
	}, logger)
	if err != nil {
		t.Fatalf("assemble gateway: %v", err)
	}
	h.gateway = gateway
	t.Cleanup(gateway.Shutdown)

	h.requests = newRequestTracker()
	h.proxy = httptest.NewServer(h.requests.wrap(gateway.ProxyHandler()))
	t.Cleanup(h.proxy.Close)
	h.admin = httptest.NewServer(gateway.AdminHandler())
	t.Cleanup(h.admin.Close)

	connectorTLS := &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{h.authority.ServerCertificate(t, "127.0.0.1", "localhost")},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    h.authority.Pool(),
	}
	if options.connectorTLS != nil {
		options.connectorTLS(connectorTLS)
	}
	h.connector = httptest.NewUnstartedServer(gateway.ConnectorHandler())
	h.connector.TLS = connectorTLS
	h.connector.StartTLS()
	t.Cleanup(h.connector.Close)

	h.wrapConn = options.wrapConn
	// The connector end of the channel is configured exactly as the gateway
	// end is. Both ends must agree on the initial flow-control window in
	// particular: docs/CONNECTOR_PROTOCOL.md section 12.2 makes it a constant
	// of the protocol rather than of a deployment, and a harness that gave the
	// two ends different windows would produce a protocol violation rather than
	// the backpressure the test is asking about.
	h.sessionCfg = options.sessionCfg
	h.sessionCfg.Now = h.clock.Now
	if !options.skipConnect {
		h.connect(testConnectorID, h.authority.ConnectorCertificate(t, testConnectorID), "")
	}
	return h
}

// connect opens a connector data channel and starts serving streams on it.
func (h *harness) connect(connectorID string, certificate tls.Certificate, claimedID string) *datachannel.Session {
	h.t.Helper()
	// A reconnection replaces an existing channel, and Channels.Put closes the
	// one it replaced. Waiting for "a" live channel would therefore return the
	// channel on its way out, and a stream opened on that one dies with it. The
	// wait below is for a channel that is not the one seen here.
	previous, _ := h.gateway.Channels().Get(connectorID)
	conn, err := h.dialConnector(certificate, claimedID)
	if err != nil {
		h.t.Fatalf("dial connector data channel: %v", err)
	}
	var transport datachannel.MessageConn = conn
	if h.wrapConn != nil {
		transport = h.wrapConn(transport)
	}
	session := datachannel.NewSession(transport, datachannel.RoleConnector, h.sessionCfg)
	go func() {
		_ = datachannel.ServeConnector(session, datachannel.ConnectorConfig{Routes: h.routes, Now: h.clock.Now})
	}()
	h.session = session
	h.t.Cleanup(func() { session.Close(nil) })
	h.waitForChannel(connectorID, previous)
	return session
}

func (h *harness) dialConnector(certificate tls.Certificate, claimedID string) (*wsx.Conn, error) {
	endpoint := "wss://" + strings.TrimPrefix(h.connector.URL, "https://") + DataChannelPath
	header := http.Header{}
	if claimedID != "" {
		header.Set(ConnectorIDHeader, claimedID)
	}
	return wsx.Dial(endpoint, &tls.Config{
		MinVersion:   tls.VersionTLS13,
		RootCAs:      h.authority.Pool(),
		Certificates: []tls.Certificate{certificate},
	}, header, wsx.Options{MaxMessageBytes: 64 << 10})
}

// waitForChannel blocks until the gateway has registered a channel for the
// connector that is not the one previous names. Pass nil for a first connection.
func (h *harness) waitForChannel(connectorID string, previous *datachannel.Session) {
	h.t.Helper()
	for attempt := 0; attempt < 400; attempt++ {
		if current, live := h.gateway.Channels().Get(connectorID); live && current != previous {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	h.t.Fatalf("the data channel for %s never became live", connectorID)
}

// publish registers a route on the gateway and admits it to the connector, the
// two halves of a publication once the control channel exchange has succeeded.
func (h *harness) publish(request RegisterRequest) *http.Response {
	h.t.Helper()
	if request.RouteID == "" {
		request = h.defaultRegistration()
	}
	body, err := json.Marshal(request)
	if err != nil {
		h.t.Fatalf("encode registration: %v", err)
	}
	httpRequest, err := http.NewRequest(http.MethodPut,
		h.admin.URL+"/internal/v1/routes/"+request.RouteID, bytes.NewReader(body))
	if err != nil {
		h.t.Fatalf("build registration request: %v", err)
	}
	httpRequest.Header.Set("Authorization", "Bearer "+testAdminToken)
	httpRequest.Header.Set("Content-Type", "application/json")
	response, err := h.admin.Client().Do(httpRequest)
	if err != nil {
		h.t.Fatalf("register route: %v", err)
	}
	if response.StatusCode == http.StatusOK {
		expiresAt, _ := time.Parse(time.RFC3339, request.ExpiresAt)
		h.routes.Put(datachannel.LocalRoute{
			RouteID:                  request.RouteID,
			ProjectID:                request.ProjectID,
			WorkspaceID:              request.WorkspaceID,
			Host:                     request.LocalHost,
			Port:                     request.LocalPort,
			Protocol:                 connectorv1.DestinationProtocol(request.Protocol),
			ExpiresAt:                expiresAt,
			AllowedBrowserSessionIDs: request.AllowedBrowserSessionIDs,
		})
	}
	return response
}

func (h *harness) defaultRegistration() RegisterRequest {
	return RegisterRequest{
		RouteID:                  testRouteID,
		ProjectID:                testProjectID,
		ConnectorID:              testConnectorID,
		WorkspaceID:              testWorkspaceID,
		PublicAlias:              testAlias,
		LocalHost:                h.devHost,
		LocalPort:                h.devPort,
		Protocol:                 "http",
		Scope:                    "browser_session",
		ExpiresAt:                h.clock.Now().Add(time.Hour).Format(time.RFC3339),
		AllowedBrowserSessionIDs: []string{testSessionID},
		ObservedDestination:      h.devHost + ":" + strconv.Itoa(h.devPort),
	}
}

// mint produces a capability the way the control plane does.
func (h *harness) mint(routeID, projectID, sessionID string, ttl time.Duration) string {
	h.t.Helper()
	token, err := connectorv1.MintCapability(h.signingKey, connectorv1.CapabilityClaims{
		KeyID:            testKeyID,
		CapabilityID:     "cap_" + routeID + "_" + sessionID,
		RouteID:          routeID,
		ProjectID:        projectID,
		BrowserSessionID: sessionID,
		IssuedAt:         h.clock.Now().Unix(),
		ExpiresAt:        h.clock.Now().Add(ttl).Unix(),
	})
	if err != nil {
		h.t.Fatalf("mint capability: %v", err)
	}
	return token.Reveal()
}

func (h *harness) defaultCapability() string {
	return h.mint(testRouteID, testProjectID, testSessionID, 5*time.Minute)
}

type browserRequest struct {
	method     string
	path       string
	host       string
	capability string
	body       string
	headers    http.Header
}

// browse issues a request the way a browser worker would: to the gateway, with
// the internal origin in Host and the capability in its header.
func (h *harness) browse(request browserRequest) *http.Response {
	h.t.Helper()
	method := request.method
	if method == "" {
		method = http.MethodGet
	}
	path := request.path
	if path == "" {
		path = "/"
	}
	var body io.Reader
	if request.body != "" {
		body = strings.NewReader(request.body)
	}
	httpRequest, err := http.NewRequest(method, h.proxy.URL+path, body)
	if err != nil {
		h.t.Fatalf("build browser request: %v", err)
	}
	host := request.host
	if host == "" {
		host = testAlias + "." + testSuffix
	}
	httpRequest.Host = host
	if request.capability != "" {
		httpRequest.Header.Set(CapabilityHeader, request.capability)
	}
	for name, values := range request.headers {
		for _, value := range values {
			httpRequest.Header.Add(name, value)
		}
	}
	response, err := h.proxy.Client().Do(httpRequest)
	if err != nil {
		h.t.Fatalf("browser request: %v", err)
	}
	return response
}

// settle blocks until the gateway has finished handling every request whose
// response a client has already read.
//
// It is not a sleep and not a retry loop: it waits on the handler's own
// completion signal and re-reads the counters after each wake-up, so it returns
// exactly when the last handler has returned. Reading a metric, a counter, a log
// line or an audit record after a request without calling it is a race, because
// the gateway records the stream outcome and the request code after the response
// body has been written.
//
// A test that deliberately holds a request open — a streaming response, or one
// blocked against a stream limit — must not call it, and none does.
func (h *harness) settle() {
	h.t.Helper()
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	for {
		started := h.requests.started.Load()
		if h.requests.finished.Load() >= started {
			return
		}
		select {
		case <-h.requests.notify:
		case <-timer.C:
			h.t.Fatalf("the gateway is still handling %d request(s)",
				started-h.requests.finished.Load())
		}
	}
}

func (h *harness) recorded() recordedRequest {
	h.t.Helper()
	select {
	case request := <-h.lastRequest:
		return request
	case <-time.After(2 * time.Second):
		h.t.Fatal("the development server never received a request")
		return recordedRequest{}
	}
}

func (h *harness) adminRequest(method, path string) *http.Response {
	h.t.Helper()
	request, err := http.NewRequest(method, h.admin.URL+path, nil)
	if err != nil {
		h.t.Fatalf("build admin request: %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+testAdminToken)
	response, err := h.admin.Client().Do(request)
	if err != nil {
		h.t.Fatalf("admin request: %v", err)
	}
	return response
}

func (h *harness) auditTypes() []string {
	types := make([]string, 0)
	for _, record := range h.gateway.Auditor().Records() {
		types = append(types, record.Type)
	}
	return types
}

func (h *harness) metricsText() string {
	h.t.Helper()
	response := h.adminRequest(http.MethodGet, "/metrics")
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		h.t.Fatalf("read metrics: %v", err)
	}
	return string(body)
}

func readBody(t *testing.T, response *http.Response) string {
	t.Helper()
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return string(body)
}

func assertCode(t *testing.T, response *http.Response, status int, code string) {
	t.Helper()
	body := readBody(t, response)
	if response.StatusCode != status {
		t.Fatalf("status %d, want %d (body %s)", response.StatusCode, status, body)
	}
	if got := response.Header.Get(ErrorCodeHeader); got != code {
		t.Fatalf("error code %q, want %q (body %s)", got, code, body)
	}
	if !strings.Contains(body, `"code":"`+code+`"`) {
		t.Fatalf("body does not carry the stable code %q: %s", code, body)
	}
}

func mustHosts(t *testing.T, text string) []netip.Addr {
	t.Helper()
	hosts, err := policy.ParseHosts(text)
	if err != nil {
		t.Fatalf("parse hosts: %v", err)
	}
	return hosts
}

// waitFor polls a condition until it holds or the bound expires.
//
// It exists for the properties that a handler records after the client has
// already seen its answer: an upgraded connection is established before its
// gauge is set, so asserting on the gauge without waiting would be a race. The
// bound fails the test rather than hanging it.
func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}
