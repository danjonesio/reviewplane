package routes_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	connectorv1 "github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/connector/internal/config"
	"github.com/danjonesio/reviewplane/services/connector/internal/routes"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/datachannel"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/policy"
)

const (
	testProject   = "prj_fixture"
	testWorkspace = "wsp_fixture"
)

// newManager builds a manager whose policy is the corpus-backed default,
// widened only to the ephemeral port the fixture server binds.
func newManager(t *testing.T, publication config.Publication) *routes.Manager {
	t.Helper()
	manager, err := routes.NewManager(routes.Options{
		Publication:        publication,
		AuthorisedProjects: []string{testProject},
		KnownWorkspaces:    []string{testWorkspace},
		StartupGrace:       200 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	return manager
}

func publication(host string, port int, expiry time.Time) connectorv1.RoutePublish {
	return connectorv1.RoutePublish{
		RouteID:                  "svc_test_route",
		ProjectID:                testProject,
		WorkspaceID:              testWorkspace,
		LocalHost:                host,
		LocalPort:                int64(port),
		Protocol:                 connectorv1.DestinationProtocolHTTP,
		ExpiresAt:                expiry.UTC().Format(time.RFC3339),
		AllowedBrowserSessionIDs: []string{"brs_test"},
	}
}

// startFixture serves one loopback HTTP service and reports its port.
func startFixture(t *testing.T, handler http.Handler) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	return listener.Addr().(*net.TCPAddr).Port
}

func widePolicy(port int) config.Publication {
	return config.Publication{
		AllowedHosts: []string{"127.0.0.1", "::1"},
		AllowedPorts: []string{strconv.Itoa(port)},
		MaxRoutes:    10,
	}
}

// docs/CONNECTOR_PROTOCOL.md section 11: a valid publication is acknowledged
// ready and carries the destination the connector observed.
func TestPublicationAcknowledgesTheObservedDestination(t *testing.T) {
	port := startFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	manager := newManager(t, widePolicy(port))

	ack := manager.Publish(publication("127.0.0.1", port, time.Now().Add(time.Hour)))

	if ack.Status != connectorv1.RoutePublishAckStatusReady {
		t.Fatalf("status = %q, want ready (error class %v)", ack.Status, ack.ErrorClass)
	}
	if ack.ObservedDestination == nil {
		t.Fatal("a ready acknowledgement must carry observed_destination")
	}
	if want := "127.0.0.1:" + strconv.Itoa(port); *ack.ObservedDestination != want {
		t.Fatalf("observed_destination = %q, want %q", *ack.ObservedDestination, want)
	}
	if ack.ErrorClass != nil {
		t.Fatalf("a ready acknowledgement must carry no error class, got %q", *ack.ErrorClass)
	}
	if manager.ActiveRoutes() != 1 {
		t.Fatalf("active routes = %d, want 1", manager.ActiveRoutes())
	}
}

// docs/CONNECTOR_PROTOCOL.md section 11: the startup grace is bounded and ends
// in PORT_NOT_LISTENING rather than in an indefinite wait.
func TestAPortThatNeverListensIsRefusedAfterABoundedGrace(t *testing.T) {
	// A port nothing is bound to. Port 1 needs privilege to bind, so no test
	// running in parallel can accidentally answer here.
	manager := newManager(t, config.Publication{
		AllowedHosts: []string{"127.0.0.1"},
		AllowedPorts: []string{"1"},
		MaxRoutes:    10,
	})

	started := time.Now()
	ack := manager.Publish(publication("127.0.0.1", 1, time.Now().Add(time.Hour)))
	elapsed := time.Since(started)

	if ack.Status != connectorv1.RoutePublishAckStatusRejected {
		t.Fatalf("status = %q, want rejected", ack.Status)
	}
	if ack.ErrorClass == nil || *ack.ErrorClass != connectorv1.ErrorClassPortNotListening {
		t.Fatalf("error class = %v, want PORT_NOT_LISTENING", ack.ErrorClass)
	}
	if ack.ObservedDestination != nil {
		t.Fatalf("a rejected acknowledgement must carry no destination, got %q", *ack.ObservedDestination)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("the connector waited %s; the grace must be bounded", elapsed)
	}
	if manager.ActiveRoutes() != 0 {
		t.Fatal("a refused publication must not admit a route")
	}
}

// docs/CONNECTOR_PROTOCOL.md section 11: a port that starts listening inside
// the grace is accepted, which is the case agents actually hit.
func TestAPortThatStartsInsideTheGraceIsAccepted(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()

	manager, err := routes.NewManager(routes.Options{
		Publication:        widePolicy(port),
		AuthorisedProjects: []string{testProject},
		KnownWorkspaces:    []string{testWorkspace},
		StartupGrace:       3 * time.Second,
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}

	// The service appears after the publication has already started waiting.
	ready := make(chan struct{})
	go func() {
		time.Sleep(300 * time.Millisecond)
		late, listenErr := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
		if listenErr != nil {
			close(ready)
			return
		}
		close(ready)
		<-time.After(2 * time.Second)
		_ = late.Close()
	}()

	ack := manager.Publish(publication("127.0.0.1", port, time.Now().Add(time.Hour)))
	<-ready
	if ack.Status != connectorv1.RoutePublishAckStatusReady {
		t.Fatalf("status = %q, want ready (error class %v)", ack.Status, ack.ErrorClass)
	}
}

// docs/CONNECTOR_PROTOCOL.md section 11 and docs/SECURITY.md section 9: the
// connector enforces its own configured policy, independently of the control
// plane.
func TestTheConfiguredPolicyIsEnforced(t *testing.T) {
	port := startFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))

	cases := []struct {
		name        string
		publication config.Publication
		request     connectorv1.RoutePublish
		want        connectorv1.ErrorClass
	}{
		{
			name:        "a host outside allowed_hosts",
			publication: config.Publication{AllowedHosts: []string{"::1"}, AllowedPorts: []string{strconv.Itoa(port)}},
			request:     publication("127.0.0.1", port, time.Now().Add(time.Hour)),
			want:        connectorv1.ErrorClassDestinationNotAllowed,
		},
		{
			name:        "a port outside allowed_ports",
			publication: config.Publication{AllowedHosts: []string{"127.0.0.1"}, AllowedPorts: []string{"4321"}},
			request:     publication("127.0.0.1", port, time.Now().Add(time.Hour)),
			want:        connectorv1.ErrorClassDestinationNotAllowed,
		},
		{
			name:        "an expiry already past",
			publication: widePolicy(port),
			request:     publication("127.0.0.1", port, time.Now().Add(-time.Minute)),
			want:        connectorv1.ErrorClassRouteExpired,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			manager := newManager(t, testCase.publication)
			ack := manager.Publish(testCase.request)
			if ack.Status != connectorv1.RoutePublishAckStatusRejected {
				t.Fatalf("status = %q, want rejected", ack.Status)
			}
			if ack.ErrorClass == nil || *ack.ErrorClass != testCase.want {
				t.Fatalf("error class = %v, want %s", ack.ErrorClass, testCase.want)
			}
		})
	}
}

// docs/CONNECTOR_PROTOCOL.md section 11: the concurrent-route limit is the
// connector's, not the control plane's.
func TestTheRouteLimitIsEnforced(t *testing.T) {
	port := startFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	limit := widePolicy(port)
	limit.MaxRoutes = 2
	manager := newManager(t, limit)

	for index := range 2 {
		request := publication("127.0.0.1", port, time.Now().Add(time.Hour))
		request.RouteID = fmt.Sprintf("svc_route_%d", index)
		if ack := manager.Publish(request); ack.Status != connectorv1.RoutePublishAckStatusReady {
			t.Fatalf("route %d: status = %q", index, ack.Status)
		}
	}
	third := publication("127.0.0.1", port, time.Now().Add(time.Hour))
	third.RouteID = "svc_route_2"
	ack := manager.Publish(third)
	if ack.ErrorClass == nil || *ack.ErrorClass != connectorv1.ErrorClassRouteLimitExceeded {
		t.Fatalf("error class = %v, want ROUTE_LIMIT_EXCEEDED", ack.ErrorClass)
	}
}

// docs/CONNECTOR_PROTOCOL.md section 11: project and workspace association are
// checked by the connector too.
func TestAnUnauthorisedProjectOrWorkspaceIsRefused(t *testing.T) {
	port := startFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	manager := newManager(t, widePolicy(port))

	other := publication("127.0.0.1", port, time.Now().Add(time.Hour))
	other.ProjectID = "prj_someone_else"
	if ack := manager.Publish(other); ack.ErrorClass == nil ||
		*ack.ErrorClass != connectorv1.ErrorClassProjectNotAuthorised {
		t.Fatalf("error class = %v, want PROJECT_NOT_AUTHORISED", ack.ErrorClass)
	}

	unknown := publication("127.0.0.1", port, time.Now().Add(time.Hour))
	unknown.WorkspaceID = "wsp_unknown"
	if ack := manager.Publish(unknown); ack.ErrorClass == nil ||
		*ack.ErrorClass != connectorv1.ErrorClassWorkspaceNotFound {
		t.Fatalf("error class = %v, want WORKSPACE_NOT_FOUND", ack.ErrorClass)
	}
}

// docs/SECURITY.md section 9: an empty allow-list means the Stage 0 default,
// never "everything".
func TestAnEmptyPublicationBlockIsTheStage0Default(t *testing.T) {
	built, err := routes.BuildPolicy(config.Publication{})
	if err != nil {
		t.Fatalf("BuildPolicy: %v", err)
	}
	expected := policy.DefaultPolicy()
	if len(built.AllowedHosts) != len(expected.AllowedHosts) {
		t.Fatalf("allowed hosts = %v, want the default %v", built.AllowedHosts, expected.AllowedHosts)
	}
	if built.AllowNonLoopback {
		t.Fatal("an omitted publication block must not lift the loopback requirement")
	}
	rejection := built.Evaluate(policy.Destination{
		Host: "10.0.0.5", Port: 4321, Protocol: connectorv1.DestinationProtocolHTTP,
	})
	if rejection == nil {
		t.Fatal("the default policy accepted a non-loopback destination")
	}
}

// A host name cannot be an allow-list entry: resolving one is a rebinding
// surface, so it is refused at load rather than resolved at publication.
func TestAHostNameInTheAllowListIsRefused(t *testing.T) {
	_, err := routes.BuildPolicy(config.Publication{AllowedHosts: []string{"localhost"}})
	if err == nil {
		t.Fatal("a host name was accepted in publication.allowed_hosts")
	}
	if !strings.Contains(err.Error(), "literal IP address") {
		t.Fatalf("the failure does not say why: %v", err)
	}
}

// The whole point of the connector: it runs the shared destination corpus, so
// the three implementations of one policy cannot drift apart
// (docs/CONNECTOR_PROTOCOL.md section 11).
func TestTheSharedDestinationCorpusPasses(t *testing.T) {
	corpus := "../../../tunnel-gateway/testdata/destination-policy.json"
	if _, err := os.Stat(corpus); err != nil {
		t.Fatalf("the shared corpus is missing: %v", err)
	}
	loaded, err := policy.LoadCorpus(corpus)
	if err != nil {
		t.Fatalf("loading the corpus: %v", err)
	}
	for _, testCase := range loaded.Cases {
		t.Run(testCase.Name, func(t *testing.T) {
			if problem := loaded.Check(testCase); problem != "" {
				t.Fatal(problem)
			}
		})
	}
}

// docs/CONNECTOR_PROTOCOL.md section 12: the connector opens only the
// pre-authorised destination, and a stream for a route it does not carry opens
// nothing at all.
func TestTheDataPlaneOpensOnlyTheAuthorisedDestination(t *testing.T) {
	var (
		mu    sync.Mutex
		hosts []string
	)
	port := startFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hosts = append(hosts, r.Host)
		mu.Unlock()
		w.Header().Set("content-type", "text/plain")
		_, _ = io.WriteString(w, "fixture:"+r.URL.Path)
	}))

	manager := newManager(t, widePolicy(port))
	ack := manager.Publish(publication("127.0.0.1", port, time.Now().Add(time.Hour)))
	if ack.Status != connectorv1.RoutePublishAckStatusReady {
		t.Fatalf("publication was refused: %v", ack.ErrorClass)
	}

	// The two ends of the mux, joined by an in-memory pipe: this exercises the
	// connector's stream server without a TLS handshake it is not testing.
	left, right := newPipe()
	gateway := datachannel.NewSession(left, datachannel.RoleGateway, datachannel.SessionConfig{})
	connector := datachannel.NewSession(right, datachannel.RoleConnector, datachannel.SessionConfig{})
	defer gateway.Close(nil)
	defer connector.Close(nil)
	go func() {
		_ = datachannel.ServeConnector(connector, datachannel.ConnectorConfig{Routes: manager.Table()})
	}()

	stream, err := gateway.Open(connectorv1.DataStreamHeader{
		RouteID:             "svc_test_route",
		BrowserSessionID:    "brs_test",
		SessionCapability:   connectorv1.SessionCapability("rp1.test-capability"),
		StreamID:            "str_one",
		DestinationProtocol: connectorv1.DestinationProtocolHTTP,
		Deadline:            time.Now().Add(30 * time.Second).UTC().Format(time.RFC3339),
	})
	if err != nil {
		t.Fatalf("opening a stream: %v", err)
	}
	if _, err := io.WriteString(stream, "GET /probe HTTP/1.1\r\nHost: alias.internal.invalid\r\nConnection: close\r\n\r\n"); err != nil {
		t.Fatalf("writing the request: %v", err)
	}
	response, err := io.ReadAll(stream)
	if err != nil && !errors.Is(err, io.EOF) {
		t.Fatalf("reading the response: %v", err)
	}
	if !strings.Contains(string(response), "fixture:/probe") {
		t.Fatalf("the development service did not answer through the route: %q", response)
	}

	mu.Lock()
	seen := append([]string(nil), hosts...)
	mu.Unlock()
	if len(seen) != 1 {
		t.Fatalf("the fixture saw %d requests, want 1", len(seen))
	}
	// The connector relays the bytes it was given without parsing them, so the
	// Host the development service sees is the one the gateway chose. Nothing
	// in it can change which socket was opened.
	if seen[0] != "alias.internal.invalid" {
		t.Fatalf("Host = %q", seen[0])
	}

	// A route this connector does not carry opens nothing.
	unknown, err := gateway.Open(connectorv1.DataStreamHeader{
		RouteID:             "svc_not_published",
		BrowserSessionID:    "brs_test",
		SessionCapability:   connectorv1.SessionCapability("rp1.test-capability"),
		StreamID:            "str_two",
		DestinationProtocol: connectorv1.DestinationProtocolHTTP,
		Deadline:            time.Now().Add(30 * time.Second).UTC().Format(time.RFC3339),
	})
	if err != nil {
		t.Fatalf("opening a second stream: %v", err)
	}
	if _, err := io.ReadAll(unknown); err == nil {
		t.Fatal("a stream for an unpublished route was served")
	}

	mu.Lock()
	total := len(hosts)
	mu.Unlock()
	if total != 1 {
		t.Fatalf("the fixture saw %d requests after the unknown route; want 1", total)
	}
}

// A withdrawn route stops being served immediately.
func TestAWithdrawnRouteIsNoLongerServed(t *testing.T) {
	port := startFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	manager := newManager(t, widePolicy(port))
	if ack := manager.Publish(publication("127.0.0.1", port, time.Now().Add(time.Hour))); ack.Status !=
		connectorv1.RoutePublishAckStatusReady {
		t.Fatalf("publication was refused: %v", ack.ErrorClass)
	}
	manager.Withdraw("svc_test_route")
	if manager.ActiveRoutes() != 0 {
		t.Fatalf("active routes = %d after withdrawal", manager.ActiveRoutes())
	}
}

// The data channel needs a data URL. Without one the connector says so rather
// than dialling something it guessed.
func TestServeDataChannelWithoutAnEndpointFails(t *testing.T) {
	manager := newManager(t, config.Publication{})
	err := manager.ServeDataChannel(context.Background(), routes.DataChannelOptions{})
	if !errors.Is(err, routes.ErrNoDataEndpoint) {
		t.Fatalf("err = %v, want ErrNoDataEndpoint", err)
	}
}

// pipeConn is an in-memory MessageConn pair.
type pipeConn struct {
	incoming <-chan []byte
	outgoing chan<- []byte
	closed   chan struct{}
	once     sync.Once
}

func newPipe() (*pipeConn, *pipeConn) {
	leftToRight := make(chan []byte, 64)
	rightToLeft := make(chan []byte, 64)
	left := &pipeConn{incoming: rightToLeft, outgoing: leftToRight, closed: make(chan struct{})}
	right := &pipeConn{incoming: leftToRight, outgoing: rightToLeft, closed: make(chan struct{})}
	return left, right
}

func (p *pipeConn) ReadMessage() ([]byte, error) {
	select {
	case <-p.closed:
		return nil, io.EOF
	case payload, ok := <-p.incoming:
		if !ok {
			return nil, io.EOF
		}
		return payload, nil
	}
}

func (p *pipeConn) WriteMessage(payload []byte) error {
	select {
	case <-p.closed:
		return io.ErrClosedPipe
	case p.outgoing <- append([]byte(nil), payload...):
		return nil
	}
}

func (p *pipeConn) Close(_ int, _ string) error {
	p.once.Do(func() { close(p.closed) })
	return nil
}
