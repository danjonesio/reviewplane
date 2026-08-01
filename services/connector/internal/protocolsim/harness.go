package protocolsim

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	connectorv1 "github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/connector/internal/channel"
	"github.com/danjonesio/reviewplane/services/connector/internal/config"
	"github.com/danjonesio/reviewplane/services/connector/internal/controlplanetest"
	"github.com/danjonesio/reviewplane/services/connector/internal/enrol"
	"github.com/danjonesio/reviewplane/services/connector/internal/identity"
	"github.com/danjonesio/reviewplane/services/connector/internal/logging"
	"github.com/danjonesio/reviewplane/services/connector/internal/routes"
	"github.com/danjonesio/reviewplane/services/connector/internal/workspaces"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/datachannel"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/wsx"
)

// Fixed identifiers. They are opaque to the protocol (docs/DOMAIN_MODEL.md
// section 3); the values are chosen to read well in a transcript.
const (
	ProjectID   = "prj_protocolsim"
	WorkspaceID = "wsp_protocolsim"
	SessionID   = "brs_protocolsim"
	RouteID     = "svc_protocolsim"
	// DecoyRouteID names a second development environment on the same machine.
	// Nothing may ever be served from it through the authorised route:
	// docs/ARCHITECTURE.md section 14 forbids silently redirecting traffic to a
	// different environment, and a test with only one environment could not
	// observe the difference.
	DecoyRouteID = "svc_protocolsim_decoy"

	// DataChannelPath matches the tunnel gateway's own data-channel path.
	DataChannelPath = "/connector/data"

	capabilityKey   = "protocolsim-capability-signing-key-0001"
	capabilityKeyID = "k_protocolsim"
	enrolmentToken  = "protocolsim-enrolment-token-0001"

	// Stable codes the browser side answers with. They are
	// docs/MCP_SPEC.md section 12 values, chosen by the same rules the tunnel
	// gateway's request path applies (services/tunnel-gateway/internal/
	// gatewayhttp/proxy.go): no channel or a channel that died mid-stream is
	// CONNECTOR_OFFLINE, and a route the connector will not serve is whatever
	// section 21 class it reset with.
	CodeConnectorOffline = "CONNECTOR_OFFLINE"
	CodeRouteExpired     = string(connectorv1.ErrorClassRouteExpired)
)

// Environment is a loopback development service. Its response names it, so a
// response proves which environment produced it.
type Environment struct {
	Name string

	server *http.Server
	port   int
	// Requests counts what actually reached this environment.
	Requests atomic.Int64
}

// Port is the loopback port the environment listens on.
func (e *Environment) Port() int { return e.port }

// Destination renders the environment as the connector reports it.
func (e *Environment) Destination() string { return "127.0.0.1:" + strconv.Itoa(e.port) }

func startEnvironment(t *testing.T, name string) *Environment {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("binding the %s environment: %v", name, err)
	}
	address, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatalf("the %s environment did not bind a TCP address", name)
	}
	environment := &Environment{Name: name, port: address.Port}
	environment.server = &http.Server{
		ReadHeaderTimeout: 5 * time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			environment.Requests.Add(1)
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.Header().Set("X-Environment", name)
			fmt.Fprintf(w, "environment=%s path=%s", name, r.URL.Path)
		}),
	}
	go func() { _ = environment.server.Serve(listener) }()
	t.Cleanup(func() {
		shutdown, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = environment.server.Shutdown(shutdown)
	})
	return environment
}

// Response is the outcome of one browser-side request through the tunnel.
type Response struct {
	// Status is the HTTP status the development service answered with, or zero
	// when the request never reached one.
	Status int
	// Code is the stable failure code, empty on success.
	Code string
	Body string
	// Environment is the X-Environment header the development service set, which
	// is how a response is attributed to an environment.
	Environment string
}

// Harness is the assembled Stage 0 tunnel, minus the browser.
type Harness struct {
	T            *testing.T
	ControlPlane *controlplanetest.Server
	ConnectorID  string
	Manager      *routes.Manager
	Runner       *channel.Runner
	// Authorised is the environment the route points at.
	Authorised *Environment
	// Decoy is a second environment the route must never reach.
	Decoy *Environment

	capability    connectorv1.SensitiveString
	logs          *logBuffer
	acceptingData atomic.Bool

	sessionMu sync.Mutex
	session   *datachannel.Session

	reconcileMu sync.Mutex
	reconcile   func(connectorID string, request connectorv1.ReconnectRequest) connectorv1.ReconnectResponse

	// reconcileSeq counts the reconciliations the control plane has answered;
	// reconcileBaseline is its value when the connection was last broken. A
	// route is only servable again once a reconciliation newer than the break
	// has re-admitted it, so WaitForRoute compares the two.
	reconcileSeq      atomic.Uint64
	reconcileBaseline atomic.Uint64

	streamSeq atomic.Uint64
	cancel    context.CancelFunc
	stopped   chan struct{}

	// WorkspacePath is the checkout the connector observes, when the harness was
	// asked for one.
	WorkspacePath string
}

// logBuffer collects the connector's structured log so that a test can read the
// reconciliation decisions and the backoff delays it recorded.
type logBuffer struct {
	mu    sync.Mutex
	lines []string
}

func (b *logBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, line := range strings.Split(strings.TrimRight(string(p), "\n"), "\n") {
		if line != "" {
			b.lines = append(b.lines, line)
		}
	}
	return len(p), nil
}

func (b *logBuffer) Lines() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.lines...)
}

// Options configures the harness.
type Options struct {
	// Reconnect overrides the connector's backoff. Tests use short delays so
	// that the bound and the jitter are observable without waiting a minute.
	Reconnect config.Reconnect
	// DesiredStateTimeout bounds the wait for the section 17 desired state.
	DesiredStateTimeout time.Duration
	// WithholdDesiredState accepts the reconnect request and never answers it.
	WithholdDesiredState bool
	// SkipWaitForRoute returns before the route is serving, for a test that
	// asserts the connector never gets there.
	SkipWaitForRoute bool
	// ObserveWorkspaces initialises a real Git checkout at the configured
	// workspace path and wires the workspaces package into the connector, so
	// that section 9 observations cross the same wire every other frame does.
	// It is off by default: most of these tests are about the tunnel, and
	// spawning git for them would add cost and flakiness for nothing.
	ObserveWorkspaces bool
	// ObserveInterval overrides the workspace observation interval. Tests use a
	// short one so that a change is reported without waiting half a minute.
	ObserveInterval time.Duration
}

// Start assembles the harness and, unless asked not to, waits until a request
// can be served.
func Start(t *testing.T, options Options) *Harness {
	t.Helper()
	harness := &Harness{T: t, stopped: make(chan struct{})}
	harness.acceptingData.Store(true)
	harness.Authorised = startEnvironment(t, "authorised")
	harness.Decoy = startEnvironment(t, "decoy")
	harness.reconcile = harness.ContinueAuthorisedRoute

	harness.ControlPlane = controlplanetest.Start(t, controlplanetest.Options{
		Token:                enrolmentToken,
		WithholdDesiredState: options.WithholdDesiredState,
		Reconcile: func(connectorID string, request connectorv1.ReconnectRequest) connectorv1.ReconnectResponse {
			harness.reconcileMu.Lock()
			answer := harness.reconcile
			harness.reconcileMu.Unlock()
			response := answer(connectorID, request)
			// The connector has already drained its table by the time this
			// request arrives, so counting answers here is what lets
			// WaitForRoute tell a re-admitted route from the pre-break entry.
			harness.reconcileSeq.Add(1)
			return response
		},
	})

	harness.startDataListener(t)
	harness.mintCapability(t)
	harness.enrolAndRun(t, options)
	if !options.SkipWaitForRoute {
		harness.WaitForRoute(20 * time.Second)
	}
	return harness
}

// startDataListener stands up the gateway side of the data channel.
//
// It is the gateway's role, not the gateway's process: the multiplexer, the
// framing and the stream header all come from the same packages the real
// gateway uses, so the bytes on the wire are the product's. What it deliberately
// does not include is the gateway's HTTP request path, which has its own tests
// in its own module.
func (h *Harness) startDataListener(t *testing.T) {
	t.Helper()
	certificate, err := h.ControlPlane.IssueServerCertificate([]string{"127.0.0.1", "localhost"})
	if err != nil {
		t.Fatalf("issuing the data listener certificate: %v", err)
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != DataChannelPath {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		// The partition gate. A connector whose data channel is refused is
		// offline from the gateway's point of view, with its own process still
		// running and still retrying.
		if !h.acceptingData.Load() {
			http.Error(w, "partitioned", http.StatusServiceUnavailable)
			return
		}
		// Mutual authentication, as docs/CONNECTOR_PROTOCOL.md section 5.2
		// requires of a data-channel verifier.
		if r.TLS == nil || len(r.TLS.VerifiedChains) == 0 {
			http.Error(w, "AUTHENTICATION_REQUIRED", http.StatusForbidden)
			return
		}
		conn, err := wsx.Accept(w, r, wsx.Options{MaxMessageBytes: 64 << 10})
		if err != nil {
			return
		}
		session := datachannel.NewSession(conn, datachannel.RoleGateway, datachannel.SessionConfig{})
		h.sessionMu.Lock()
		previous := h.session
		h.session = session
		h.sessionMu.Unlock()
		if previous != nil {
			previous.Close(errors.New("protocolsim: replaced by a reconnect"))
		}
		go func() {
			<-session.Done()
			h.sessionMu.Lock()
			if h.session == session {
				h.session = nil
			}
			h.sessionMu.Unlock()
		}()
	})

	listener := httptest.NewUnstartedServer(handler)
	listener.TLS = &tls.Config{
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{certificate},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    h.ControlPlane.CAPool(),
	}
	listener.StartTLS()
	t.Cleanup(listener.Close)
	h.ControlPlane.SetDataURL("wss://" + strings.TrimPrefix(listener.URL, "https://") + DataChannelPath)
}

func (h *Harness) mintCapability(t *testing.T) {
	t.Helper()
	token, err := connectorv1.MintCapability([]byte(capabilityKey), connectorv1.CapabilityClaims{
		KeyID:            capabilityKeyID,
		CapabilityID:     "cap_protocolsim",
		RouteID:          RouteID,
		ProjectID:        ProjectID,
		BrowserSessionID: SessionID,
		IssuedAt:         time.Now().Add(-time.Minute).Unix(),
		ExpiresAt:        time.Now().Add(time.Hour).Unix(),
	})
	if err != nil {
		t.Fatalf("minting a capability: %v", err)
	}
	h.capability = token
}

func (h *Harness) enrolAndRun(t *testing.T, options Options) {
	t.Helper()
	dataDir := t.TempDir()
	cfg := config.Defaults()
	parsed, err := config.ParseControlPlaneURL(h.ControlPlane.URL)
	if err != nil {
		t.Fatalf("parsing the control-plane URL: %v", err)
	}
	cfg.ControlPlane.URL = parsed
	cfg.ControlPlane.TLS.CAFile = h.ControlPlane.CAFile
	cfg.Identity.DataDir = dataDir
	cfg.Heartbeat.Interval = time.Second
	workspacePath := filepath.Join(dataDir, "workspace")
	h.WorkspacePath = workspacePath
	cfg.Workspaces = []config.Workspace{
		{ID: WorkspaceID, Path: workspacePath, Project: ProjectID},
	}
	cfg.GitContext.Interval = options.ObserveInterval
	if cfg.GitContext.Interval <= 0 {
		cfg.GitContext.Interval = 200 * time.Millisecond
	}
	cfg.Publication = config.Publication{
		AllowedHosts: []string{"127.0.0.1"},
		AllowedPorts: []string{"1024-65535"},
		MaxRoutes:    16,
	}
	cfg.Reconnect = options.Reconnect
	if cfg.Reconnect.InitialDelay <= 0 {
		cfg.Reconnect = config.Reconnect{
			InitialDelay: 100 * time.Millisecond,
			MaxDelay:     800 * time.Millisecond,
			Factor:       2,
			Jitter:       0.3,
		}
	}

	h.logs = &logBuffer{}
	logger := logging.New(h.logs, "debug")

	result, err := enrol.Run(context.Background(), enrol.Options{
		Config:      cfg,
		Token:       connectorv1.EnrolmentToken(enrolmentToken),
		MaxAttempts: 1,
		Logger:      logger,
	})
	if err != nil {
		t.Fatalf("enrolling the connector: %v", err)
	}
	h.ConnectorID = result.ConnectorID

	manager, err := routes.NewManager(routes.Options{
		Publication:        cfg.Publication,
		AuthorisedProjects: cfg.AuthorisedProjects(),
		KnownWorkspaces:    cfg.KnownWorkspaces(),
		StartupGrace:       time.Second,
		Logger:             logger,
	})
	if err != nil {
		t.Fatalf("building the route manager: %v", err)
	}
	h.Manager = manager

	store := identity.NewStore(dataDir)
	runner := &channel.Runner{Config: cfg, Store: store, Logger: logger, Routes: manager}
	if options.ObserveWorkspaces {
		initialiseWorkspace(t, workspacePath)
		runner.Workspaces = workspaces.New(workspaces.Options{
			Workspaces: cfg.Workspaces,
			Interval:   cfg.GitContext.Interval,
			Logger:     logger,
		})
	}
	if options.DesiredStateTimeout > 0 {
		runner.DesiredStateTimeout = options.DesiredStateTimeout
	}
	h.Runner = runner

	ctx, cancel := context.WithCancel(context.Background())
	h.cancel = cancel
	var running sync.WaitGroup
	running.Add(2)
	go func() {
		defer running.Done()
		manager.SuperviseDataChannel(ctx, routes.SupervisorOptions{
			Store:  store,
			Config: cfg,
			Logger: logger,
			Reconnect: routes.ReconnectPolicy{
				Initial: cfg.Reconnect.InitialDelay,
				Max:     cfg.Reconnect.MaxDelay,
				Factor:  cfg.Reconnect.Factor,
				Jitter:  cfg.Reconnect.Jitter,
			},
		})
	}()
	go func() {
		defer running.Done()
		_ = runner.Run(ctx)
	}()
	go func() {
		running.Wait()
		close(h.stopped)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-h.stopped:
		case <-time.After(15 * time.Second):
			t.Error("the connector did not stop within fifteen seconds")
		}
	})
}

// initialiseWorkspace makes a real checkout at path, with a remote whose
// canonical identity a test can assert.
//
// A real repository rather than a stub: what is being proved is that the
// connector reports what git actually says, and a stub would prove only that
// the harness agrees with itself.
func initialiseWorkspace(t *testing.T, path string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed; a connector on such a machine reports no workspace context")
	}
	if err := os.MkdirAll(path, 0o750); err != nil {
		t.Fatalf("creating the workspace: %v", err)
	}
	run := func(args ...string) {
		t.Helper()
		command := exec.Command("git", args...)
		command.Dir = path
		command.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, output)
		}
	}
	run("init", "--initial-branch=main")
	run("config", "user.email", "connector@example.internal")
	run("config", "user.name", "Protocol Simulation")
	run("config", "commit.gpgsign", "false")
	run("remote", "add", "origin", "git@github.com:example/refresh-surplus.git")
	if err := os.WriteFile(filepath.Join(path, "README.md"), []byte("# fixture\n"), 0o600); err != nil {
		t.Fatalf("writing the workspace file: %v", err)
	}
	run("add", "-A")
	run("commit", "-m", "first")
}

// DirtyWorkspace makes the observed checkout dirty, so that a test can watch a
// change reach the control plane.
func (h *Harness) DirtyWorkspace() {
	h.T.Helper()
	if h.WorkspacePath == "" {
		h.T.Fatal("this harness observes no workspace")
	}
	name := filepath.Join(h.WorkspacePath, "uncommitted.txt")
	if err := os.WriteFile(name, []byte("edited\n"), 0o600); err != nil {
		h.T.Fatalf("dirtying the workspace: %v", err)
	}
}

// AuthorisedPublication is the publication the control plane restates when it
// continues the route.
func (h *Harness) AuthorisedPublication() connectorv1.RoutePublish {
	return connectorv1.RoutePublish{
		RouteID:                  RouteID,
		ProjectID:                ProjectID,
		WorkspaceID:              WorkspaceID,
		LocalHost:                "127.0.0.1",
		LocalPort:                int64(h.Authorised.Port()),
		Protocol:                 connectorv1.DestinationProtocolHTTP,
		ExpiresAt:                time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
		AllowedBrowserSessionIDs: []string{SessionID},
	}
}

// ContinueAuthorisedRoute is the default desired state: the route the connector
// is meant to serve continues, and nothing else does.
func (h *Harness) ContinueAuthorisedRoute(
	_ string,
	_ connectorv1.ReconnectRequest,
) connectorv1.ReconnectResponse {
	publication := h.AuthorisedPublication()
	return connectorv1.ReconnectResponse{
		ReconciledAt: time.Now().UTC().Format(time.RFC3339),
		Upgrade:      connectorv1.UpgradeClassificationCompatible,
		Routes: []connectorv1.RouteDecision{{
			RouteID:  RouteID,
			Decision: connectorv1.RouteReconciliationDecisionContinue,
			Reason:   connectorv1.RouteReconciliationReasonAuthorised,
			Route:    &publication,
		}},
		Sessions: []connectorv1.SessionDecision{{
			BrowserSessionID: SessionID,
			Decision:         connectorv1.SessionReconciliationDecisionReEstablish,
			Reason:           connectorv1.SessionReconciliationReasonRouteResumed,
		}},
	}
}

// SetReconciler replaces the desired state the control plane answers with.
func (h *Harness) SetReconciler(
	answer func(connectorID string, request connectorv1.ReconnectRequest) connectorv1.ReconnectResponse,
) {
	h.reconcileMu.Lock()
	h.reconcile = answer
	h.reconcileMu.Unlock()
}

// Get issues one browser-side request through the tunnel, on the authorised
// route.
func (h *Harness) Get(path string) Response { return h.GetRoute(RouteID, path) }

// GetRoute issues a request on a named route.
//
// The decision rules mirror the gateway's request path: no live channel is
// CONNECTOR_OFFLINE before anything is opened, and a stream the connector resets
// carries the section 21 class it chose.
func (h *Harness) GetRoute(routeID, path string) Response {
	h.T.Helper()
	h.sessionMu.Lock()
	session := h.session
	h.sessionMu.Unlock()
	if session == nil {
		return Response{Code: CodeConnectorOffline}
	}
	select {
	case <-session.Done():
		return Response{Code: CodeConnectorOffline}
	default:
	}

	header := connectorv1.DataStreamHeader{
		RouteID:             routeID,
		BrowserSessionID:    SessionID,
		SessionCapability:   h.capability,
		StreamID:            "str_" + strconv.FormatUint(h.streamSeq.Add(1), 10),
		DestinationProtocol: connectorv1.DestinationProtocolHTTP,
		Deadline:            time.Now().Add(20 * time.Second).UTC().Format(time.RFC3339),
	}
	stream, err := session.Open(header)
	if err != nil {
		return Response{Code: classify(err)}
	}
	stream.SetPolicyDeadline(time.Now().Add(20 * time.Second))
	defer func() { _ = stream.Close() }()

	request := "GET " + path + " HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
	if _, err := io.WriteString(stream, request); err != nil {
		return Response{Code: classify(err)}
	}
	if err := stream.CloseWrite(); err != nil {
		return Response{Code: classify(err)}
	}

	response, err := http.ReadResponse(bufio.NewReader(io.LimitReader(stream, 1<<20)), nil)
	if err != nil {
		return Response{Code: classify(err)}
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return Response{Code: classify(err)}
	}
	return Response{
		Status:      response.StatusCode,
		Body:        string(body),
		Environment: response.Header.Get("X-Environment"),
	}
}

// classify turns a stream failure into a stable code, the way the gateway does.
func classify(err error) string {
	var sessionClosed *datachannel.SessionClosedError
	if errors.As(err, &sessionClosed) {
		return CodeConnectorOffline
	}
	var streamErr *datachannel.StreamError
	if errors.As(err, &streamErr) && streamErr.Class != "" {
		return string(streamErr.Class)
	}
	return CodeConnectorOffline
}

// Partition drops the connector's data channel and refuses new ones, and severs
// the control channel: a connector that has gone away, with its own process
// still running and still retrying.
func (h *Harness) Partition() {
	h.reconcileBaseline.Store(h.reconcileSeq.Load())
	h.acceptingData.Store(false)
	h.sessionMu.Lock()
	session := h.session
	h.session = nil
	h.sessionMu.Unlock()
	if session != nil {
		session.Close(errors.New("protocolsim: partitioned"))
	}
	h.ControlPlane.Sever()
}

// Heal lets the connector reconnect. It takes no action on the connector: the
// whole point is that recovery needs none.
func (h *Harness) Heal() { h.acceptingData.Store(true) }

// SeverControlOnly drops the control channel and leaves the data channel alone.
func (h *Harness) SeverControlOnly() int {
	h.reconcileBaseline.Store(h.reconcileSeq.Load())
	return h.ControlPlane.Sever()
}

// DataChannelLive reports whether a data channel is terminated for the connector.
func (h *Harness) DataChannelLive() bool {
	h.sessionMu.Lock()
	session := h.session
	h.sessionMu.Unlock()
	if session == nil {
		return false
	}
	select {
	case <-session.Done():
		return false
	default:
		return true
	}
}

// WaitForRoute blocks until the connector is serving the authorised route again
// over a live data channel.
//
// A live data channel and a carried route are not on their own enough to make
// the route servable. BeginReconciliation drains the whole table before it asks
// the control plane what to keep (docs/CONNECTOR_PROTOCOL.md section 17), and
// re-admits only once the answer arrives. Waiting on carriage alone is
// therefore satisfied by the entry left over from before the break, which the
// drain is about to remove — and a request issued in that window is correctly
// answered ROUTE_EXPIRED. Requiring a reconciliation newer than the break means
// the carried route can only be one this reconciliation re-admitted.
func (h *Harness) WaitForRoute(within time.Duration) {
	h.T.Helper()
	h.WaitUntil("the connector to resume "+RouteID, within, func() bool {
		if !h.DataChannelLive() {
			return false
		}
		if h.reconcileSeq.Load() <= h.reconcileBaseline.Load() {
			return false
		}
		_, carried := h.Manager.Table().Get(RouteID)
		return carried
	})
}

// WaitUntil polls condition until it holds or the bound expires.
func (h *Harness) WaitUntil(what string, within time.Duration, condition func() bool) {
	h.T.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	h.T.Fatalf("timed out waiting for %s after %s", what, within)
}

// LogLines returns the connector's structured log.
func (h *Harness) LogLines() []string { return h.logs.Lines() }

// LogsContaining returns the log lines mentioning every fragment.
func (h *Harness) LogsContaining(fragments ...string) []string {
	matched := make([]string, 0)
	for _, line := range h.logs.Lines() {
		hit := true
		for _, fragment := range fragments {
			if !strings.Contains(line, fragment) {
				hit = false
				break
			}
		}
		if hit {
			matched = append(matched, line)
		}
	}
	return matched
}

// Stop ends the connector early, for a test that asserts on its exit.
func (h *Harness) Stop() {
	if h.cancel != nil {
		h.cancel()
	}
	select {
	case <-h.stopped:
	case <-time.After(15 * time.Second):
	}
}
