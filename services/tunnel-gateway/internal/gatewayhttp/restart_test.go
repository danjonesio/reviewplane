package gatewayhttp

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/internal/registry"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/policy"
)

// A withdrawal survives the gateway process (RVP-76, ADR-0038).
//
// Every other test here builds a gateway inside the test binary, and a "restart"
// expressed as a second object in the same process proves the journal is read
// but leaves the interesting question — does anything else carry the withdrawal
// across — answered by inspection. So this one starts the gateway as a real
// child process, kills it, and starts another over the same journal.
//
// The child is this test binary re-executed: it is the standard way to get a
// second process without a build step, and it keeps the gateway assembled by
// the same code path the command uses.

const (
	childMarker      = "REVIEWPLANE_TEST_GATEWAY_CHILD"
	childJournalPath = "REVIEWPLANE_TEST_GATEWAY_JOURNAL"
	childSigningKey  = "REVIEWPLANE_TEST_GATEWAY_SIGNING_KEY"
	childSecret      = "REVIEWPLANE_TEST_GATEWAY_SECRET"
)

func TestMain(m *testing.M) {
	if os.Getenv(childMarker) == "1" {
		runChildGateway()
		return
	}
	os.Exit(m.Run())
}

// runChildGateway assembles a gateway with a proxy and a control listener and
// serves until it is killed, printing the two addresses so the parent can find
// them.
//
// It runs no connector listener. Nothing here needs the tunnel to carry bytes:
// what is being proven is which answer the authorisation path reaches, and the
// two answers are distinguishable without a development server behind them.
func runChildGateway() {
	key, err := base64.StdEncoding.DecodeString(os.Getenv(childSigningKey))
	if err != nil {
		panic(err)
	}
	journal, err := registry.NewFileJournal(os.Getenv(childJournalPath))
	if err != nil {
		panic(err)
	}
	gateway, err := New(Config{
		Proxy: ProxyConfig{InternalSuffix: testSuffix},
		Admin: AdminConfig{
			Credentials: ControlCredentials{{
				ID:         "api",
				Secret:     os.Getenv(childSecret),
				Operations: ControlOperations(),
			}},
			InternalSuffix: testSuffix,
		},
		Registry: registry.Config{
			Policy: policy.Policy{
				AllowedHosts:     mustParseHosts("127.0.0.1,::1"),
				AllowedPorts:     []policy.PortRange{{Low: 1024, High: 65535}},
				AllowedProtocols: []connectorv1.DestinationProtocol{connectorv1.DestinationProtocolHTTP},
			},
			MaxRoutesPerConnector: 10,
			MaxRouteTTL:           8 * time.Hour,
			Journal:               journal,
		},
		Keyring: connectorv1.CapabilityKeyring{testKeyID: key},
	}, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		panic(err)
	}

	proxy := listen()
	admin := listen()
	// The addresses are announced only once both listeners exist, so a parent
	// that has read them can connect without polling.
	if _, err := os.Stdout.WriteString(
		"PROXY " + proxy.Addr().String() + "\nADMIN " + admin.Addr().String() + "\n"); err != nil {
		panic(err)
	}
	go func() { _ = (&http.Server{Handler: gateway.AdminHandler(), ReadHeaderTimeout: time.Second}).Serve(admin) }()
	_ = (&http.Server{Handler: gateway.ProxyHandler(), ReadHeaderTimeout: time.Second}).Serve(proxy)
}

func listen() net.Listener {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	return listener
}

func mustParseHosts(text string) []netip.Addr {
	hosts, err := policy.ParseHosts(text)
	if err != nil {
		panic(err)
	}
	return hosts
}

// child is a running gateway process and where to reach it.
type child struct {
	command *exec.Cmd
	proxy   string
	admin   string
}

func startChild(t *testing.T, journalPath, signingKey, secret string) *child {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=TestNothingRunsInTheChild")
	command.Env = append(os.Environ(),
		childMarker+"=1",
		childJournalPath+"="+journalPath,
		childSigningKey+"="+signingKey,
		childSecret+"="+secret,
	)
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatalf("child stdout: %v", err)
	}
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		t.Fatalf("start child gateway: %v", err)
	}
	running := &child{command: command}
	t.Cleanup(func() { running.stop() })

	reader := bufio.NewReader(stdout)
	for running.proxy == "" || running.admin == "" {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read child address: %v", err)
		}
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		switch fields[0] {
		case "PROXY":
			running.proxy = fields[1]
		case "ADMIN":
			running.admin = fields[1]
		}
	}
	return running
}

func (c *child) stop() {
	if c.command.Process == nil {
		return
	}
	_ = c.command.Process.Kill()
	_, _ = c.command.Process.Wait()
}

func (c *child) register(t *testing.T, secret string, request RegisterRequest) {
	t.Helper()
	body, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("encode registration: %v", err)
	}
	httpRequest, err := http.NewRequest(http.MethodPut,
		"http://"+c.admin+"/internal/v1/routes/"+request.RouteID, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("build registration: %v", err)
	}
	httpRequest.Header.Set("Authorization", "Bearer "+secret)
	httpRequest.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(httpRequest)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		payload, _ := io.ReadAll(response.Body)
		t.Fatalf("register: %d %s", response.StatusCode, payload)
	}
}

func (c *child) revokeRoute(t *testing.T, secret, routeID string) {
	t.Helper()
	httpRequest, err := http.NewRequest(http.MethodDelete,
		"http://"+c.admin+"/internal/v1/routes/"+routeID, nil)
	if err != nil {
		t.Fatalf("build revocation: %v", err)
	}
	httpRequest.Header.Set("Authorization", "Bearer "+secret)
	response, err := http.DefaultClient.Do(httpRequest)
	if err != nil {
		t.Fatalf("revoke: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		payload, _ := io.ReadAll(response.Body)
		t.Fatalf("revoke: %d %s", response.StatusCode, payload)
	}
}

// browse presents a capability at the child's proxy listener and reports the
// stable error code it answered with.
func (c *child) browse(t *testing.T, capability string) (int, string) {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, "http://"+c.proxy+"/", nil)
	if err != nil {
		t.Fatalf("build browser request: %v", err)
	}
	request.Host = testAlias + "." + testSuffix
	request.Header.Set(CapabilityHeader, capability)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("browse: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	_, _ = io.Copy(io.Discard, response.Body)
	return response.StatusCode, response.Header.Get(ErrorCodeHeader)
}

func mintFor(t *testing.T, key []byte, routeID string, issuedAt time.Time, ttl time.Duration) string {
	t.Helper()
	token, err := connectorv1.MintCapability(key, connectorv1.CapabilityClaims{
		KeyID:            testKeyID,
		CapabilityID:     "cap_" + routeID + "_" + testSessionID,
		RouteID:          routeID,
		ProjectID:        testProjectID,
		BrowserSessionID: testSessionID,
		IssuedAt:         issuedAt.Unix(),
		ExpiresAt:        issuedAt.Add(ttl).Unix(),
	})
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	return token.Reveal()
}

// waitPastSecond blocks until the wall clock has left the second the instant
// falls in. Capability issue instants are Unix seconds, so this is what lets a
// test say "minted after" rather than "minted at about the same time".
func waitPastSecond(instant time.Time) {
	for time.Now().Unix() <= instant.Unix() {
		time.Sleep(20 * time.Millisecond)
	}
}

func TestAWithdrawalSurvivesTheGatewayProcess(t *testing.T) {
	if testing.Short() {
		t.Skip("the restart proof starts a child process")
	}
	journalPath := filepath.Join(t.TempDir(), "revocations.jsonl")
	key := bytes.Repeat([]byte{0x22}, 32)
	encodedKey := base64.StdEncoding.EncodeToString(key)
	secret := strings.Repeat("c", 40)

	// The child's clock is the wall clock, so the capability is minted against
	// it rather than against a harness clock.
	issuedAt := time.Now().Add(-time.Second)
	capability := mintFor(t, key, testRouteID, issuedAt, time.Hour)

	registration := RegisterRequest{
		RouteID:                  testRouteID,
		OrganisationID:           testOrgID,
		ProjectID:                testProjectID,
		ConnectorID:              testConnectorID,
		WorkspaceID:              testWorkspaceID,
		PublicAlias:              testAlias,
		LocalHost:                "127.0.0.1",
		LocalPort:                5173,
		Protocol:                 "http",
		Scope:                    "browser_session",
		ExpiresAt:                time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
		AllowedBrowserSessionIDs: []string{testSessionID},
		ObservedDestination:      "127.0.0.1:5173",
	}

	first := startChild(t, journalPath, encodedKey, secret)
	first.register(t, secret, registration)

	// The capability is good before the revocation. There is no connector
	// channel, so the request gets as far as the availability check and stops:
	// CONNECTOR_OFFLINE is the answer a request reaches only after every
	// authorisation check has passed, which is what makes it the discriminator
	// for the rest of this test.
	if status, code := first.browse(t, capability); code != CodeConnectorOffline {
		t.Fatalf("before the revocation the request answered %d %s, want %s",
			status, code, CodeConnectorOffline)
	}

	first.revokeRoute(t, secret, testRouteID)
	// A withdrawal covers the capabilities issued at or before the second it
	// was made in, so a capability minted later in this test must be minted in
	// a later second. The child's revocation instant is at or before this one.
	waitPastSecond(time.Now())
	if status, code := first.browse(t, capability); code != CodePublishedServiceUnavailable {
		t.Fatalf("after the revocation the request answered %d %s, want %s",
			status, code, CodePublishedServiceUnavailable)
	}
	first.stop()

	// A second gateway process. It shares nothing with the first but the file.
	second := startChild(t, journalPath, encodedKey, secret)
	second.register(t, secret, registration)

	// A capability minted now works — so the route really is live in the new
	// process, and the answer below is about the withdrawal and not about a
	// route that failed to come back.
	fresh := mintFor(t, key, testRouteID, time.Now(), time.Hour)
	if status, code := second.browse(t, fresh); code != CodeConnectorOffline {
		t.Fatalf("a fresh capability answered %d %s in the restarted gateway, want %s",
			status, code, CodeConnectorOffline)
	}

	status, code := second.browse(t, capability)
	if code != CodeRouteExpired || status != http.StatusForbidden {
		t.Fatalf("the restarted gateway answered %d %s for a capability revoked before it started, want %d %s",
			status, code, http.StatusForbidden, CodeRouteExpired)
	}
}
