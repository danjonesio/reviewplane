package gatewayhttp

import (
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/danjonesio/reviewplane/services/tunnel-gateway/internal/metrics"
)

// Integration and fault-injection layers (docs/TESTING.md sections 6 and 11):
// expiry, revocation and connector loss, each while a stream is running.

// streamingHarness serves a response the test releases one chunk at a time, so
// that a revocation or an expiry lands while bytes are still moving.
func streamingHarness(t *testing.T, chunks chan string, options harnessOptions) *harness {
	t.Helper()
	options.devHandler = func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		if flusher != nil {
			flusher.Flush()
		}
		for chunk := range chunks {
			if _, err := io.WriteString(w, chunk); err != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
	}
	return newHarness(t, options)
}

func TestRevocationDuringAnActiveStreamTerminatesIt(t *testing.T) {
	chunks := make(chan string, 4)
	h := streamingHarness(t, chunks, harnessOptions{})
	h.publish(RegisterRequest{})

	response := h.browse(browserRequest{capability: h.defaultCapability()})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status %d", response.StatusCode)
	}
	defer func() { _ = response.Body.Close() }()

	chunks <- "first chunk\n"
	buffer := make([]byte, len("first chunk\n"))
	if _, err := io.ReadFull(response.Body, buffer); err != nil {
		t.Fatalf("read first chunk: %v", err)
	}

	// The route is revoked while the response is still being written.
	revocation := h.adminRequest(http.MethodDelete, "/internal/v1/routes/"+testRouteID)
	body := readBody(t, revocation)
	if revocation.StatusCode != http.StatusOK {
		t.Fatalf("revoke: %s", body)
	}
	if !strings.Contains(body, `"status":"revoked"`) {
		t.Fatalf("the revocation response does not report the new status: %s", body)
	}

	// The in-flight stream ends promptly rather than at its deadline.
	done := make(chan error, 1)
	go func() {
		_, err := io.Copy(io.Discard, response.Body)
		done <- err
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the in-flight stream survived revocation")
	}
	close(chunks)

	if _, live := h.gateway.Routes().Lookup(testRouteID); live {
		t.Fatal("the revoked route is still registered")
	}
	if !contains(h.auditTypes(), EventPublishedServiceRevoked) {
		t.Fatalf("no published_service.revoked audit record: %v", h.auditTypes())
	}
	if h.gateway.Metrics().Value(metrics.RouteLifecycle, "transition", "revoked") != 1 {
		t.Fatalf("the revocation was not counted:\n%s", h.metricsText())
	}
	// And the route is gone for new requests too.
	assertCode(t, h.browse(browserRequest{capability: h.defaultCapability()}),
		http.StatusNotFound, CodePublishedServiceUnavailable)
}

func TestRouteExpiryClosesStreamsAndIsRecorded(t *testing.T) {
	chunks := make(chan string, 4)
	h := streamingHarness(t, chunks, harnessOptions{})
	registration := h.defaultRegistration()
	registration.ExpiresAt = h.clock.Now().Add(2 * time.Minute).Format(time.RFC3339)
	h.publish(registration)

	response := h.browse(browserRequest{capability: h.mint(testRouteID, testProjectID, testSessionID, time.Hour)})
	defer func() { _ = response.Body.Close() }()
	chunks <- "before expiry\n"
	buffer := make([]byte, len("before expiry\n"))
	if _, err := io.ReadFull(response.Body, buffer); err != nil {
		t.Fatalf("read: %v", err)
	}

	h.clock.advance(3 * time.Minute)
	expired, _ := h.gateway.Sweep(h.clock.Now())
	if expired != 1 {
		t.Fatalf("the sweep expired %d routes, want 1", expired)
	}

	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, response.Body)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the in-flight stream survived expiry")
	}
	close(chunks)

	if !contains(h.auditTypes(), EventPublishedServiceExpired) {
		t.Fatalf("no published_service.expired audit record: %v", h.auditTypes())
	}
	if !strings.Contains(h.metricsText(), `reviewplane_tunnel_route_lifecycle_total{transition="expired"} 1`) {
		t.Fatalf("the expiry was not counted:\n%s", h.metricsText())
	}
}

func TestAnExpiredRouteIsUnreachableBeforeTheSweepRuns(t *testing.T) {
	// The sweeper is a tidying mechanism, not the enforcement point. A route
	// past its expiry must be unreachable the instant it expires.
	h := newHarness(t, harnessOptions{})
	registration := h.defaultRegistration()
	registration.ExpiresAt = h.clock.Now().Add(time.Minute).Format(time.RFC3339)
	h.publish(registration)
	capability := h.mint(testRouteID, testProjectID, testSessionID, time.Hour)

	h.clock.advance(2 * time.Minute)
	assertCode(t, h.browse(browserRequest{capability: capability}),
		http.StatusNotFound, CodePublishedServiceUnavailable)
}

func TestPublicationWithAnExpiryInThePastIsRefused(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	registration := h.defaultRegistration()
	registration.ExpiresAt = h.clock.Now().Add(-time.Minute).Format(time.RFC3339)
	assertCode(t, h.publish(registration), http.StatusUnprocessableEntity, CodeRouteExpired)

	registration.ExpiresAt = h.clock.Now().Add(9 * time.Hour).Format(time.RFC3339)
	assertCode(t, h.publish(registration), http.StatusUnprocessableEntity, CodeRouteExpired)
}

func TestCapabilityRevocationWithdrawsOneSessionWithoutEndingTheRoute(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	registration := h.defaultRegistration()
	registration.AllowedBrowserSessionIDs = []string{testSessionID, "brs_test_02"}
	h.publish(registration)

	first := h.mint(testRouteID, testProjectID, testSessionID, time.Hour)
	second := h.mint(testRouteID, testProjectID, "brs_test_02", time.Hour)

	response := h.adminRequest(http.MethodDelete,
		"/internal/v1/capabilities/cap_"+testRouteID+"_"+testSessionID)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("revoke capability: %s", readBody(t, response))
	}
	_ = readBody(t, response)

	assertCode(t, h.browse(browserRequest{capability: first}), http.StatusForbidden, CodeRouteExpired)

	surviving := h.browse(browserRequest{capability: second})
	if surviving.StatusCode != http.StatusOK {
		t.Fatalf("the other session lost access too: %d", surviving.StatusCode)
	}
	_ = readBody(t, surviving)
	h.recorded()
}

func TestConnectorDisconnectMidStreamFailsWithAStableCode(t *testing.T) {
	chunks := make(chan string, 4)
	h := streamingHarness(t, chunks, harnessOptions{})
	h.publish(RegisterRequest{})

	response := h.browse(browserRequest{capability: h.defaultCapability()})
	defer func() { _ = response.Body.Close() }()
	chunks <- "before the disconnect\n"
	buffer := make([]byte, len("before the disconnect\n"))
	if _, err := io.ReadFull(response.Body, buffer); err != nil {
		t.Fatalf("read: %v", err)
	}

	h.session.Close(nil)

	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, response.Body)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the stream survived the connector disconnect")
	}
	close(chunks)

	// The route stays registered and diagnosable; requests report the connector
	// is offline rather than the route being gone
	// (docs/ARCHITECTURE.md section 14: no silent redirection to another
	// environment).
	if _, live := h.gateway.Routes().Lookup(testRouteID); !live {
		t.Fatal("the route was discarded rather than marked unavailable")
	}
	assertCode(t, h.browse(browserRequest{capability: h.defaultCapability()}),
		http.StatusServiceUnavailable, CodeConnectorOffline)
	if !contains(h.auditTypes(), EventConnectorDisconnected) {
		t.Fatalf("the disconnect was not audited: %v", h.auditTypes())
	}
}

func TestConnectorRevocationClosesItsChannelAndItsRoutes(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})

	response := h.adminRequest(http.MethodDelete, "/internal/v1/connectors/"+testConnectorID)
	body := readBody(t, response)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("revoke connector: %s", body)
	}
	if !strings.Contains(body, `"channel_closed":true`) {
		t.Fatalf("the channel was not closed: %s", body)
	}
	if _, live := h.gateway.Channels().Get(testConnectorID); live {
		t.Fatal("the revoked connector still has a data channel")
	}
	assertCode(t, h.browse(browserRequest{capability: h.defaultCapability()}),
		http.StatusNotFound, CodePublishedServiceUnavailable)
}

func TestARestartedGatewayCarriesNoRoutes(t *testing.T) {
	// docs/TESTING.md section 11: after a restart, routes are reconciled or
	// closed, never silently retargeted. The gateway holds routes in memory, so
	// a restart closes them; the control plane republishes what it still wants.
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})
	if response := h.browse(browserRequest{capability: h.defaultCapability()}); response.StatusCode != http.StatusOK {
		t.Fatalf("status %d", response.StatusCode)
	} else {
		_ = readBody(t, response)
		h.recorded()
	}

	restarted := newHarness(t, harnessOptions{})
	// The same origin and the same capability, against a gateway that was never
	// told about the route.
	response := restarted.browse(browserRequest{capability: h.defaultCapability()})
	assertCode(t, response, http.StatusNotFound, CodePublishedServiceUnavailable)
}

func TestAReplacementChannelSupersedesTheOldOne(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	first := h.session
	h.connect(testConnectorID, h.authority.ConnectorCertificate(t, testConnectorID), "")
	select {
	case <-first.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("the superseded channel was left open")
	}
	h.publish(RegisterRequest{})
	response := h.browse(browserRequest{capability: h.defaultCapability()})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("the replacement channel does not carry traffic: %d", response.StatusCode)
	}
	_ = readBody(t, response)
	h.recorded()
}

func TestRouteViewReportsTheDomainModelFields(t *testing.T) {
	// docs/DOMAIN_MODEL.md section 10 fixes the published-service record. The
	// gateway's view of it must carry the fields it enforces.
	h := newHarness(t, harnessOptions{})
	response := h.publish(RegisterRequest{})
	body := readBody(t, response)
	for _, required := range []string{
		`"route_id":"` + testRouteID + `"`,
		`"project_id":"` + testProjectID + `"`,
		`"connector_id":"` + testConnectorID + `"`,
		`"public_alias":"` + testAlias + `"`,
		`"internal_origin":"https://` + testAlias + `.` + testSuffix + `/"`,
		`"status":"ready"`,
		`"expires_at":"`,
		`"observed_destination":"`,
		`"connector_connected":true`,
	} {
		if !strings.Contains(body, required) {
			t.Fatalf("the route view does not carry %s: %s", required, body)
		}
	}
	if !contains(h.auditTypes(), EventPublishedServiceReady) {
		t.Fatalf("no published_service.ready audit record: %v", h.auditTypes())
	}
}

func TestFailedPublicationIsAudited(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	registration := h.defaultRegistration()
	registration.LocalHost = "169.254.169.254"
	registration.LocalPort = 80
	_ = readBody(t, h.publish(registration))
	if !contains(h.auditTypes(), EventPublishedServiceFailed) {
		t.Fatalf("no published_service.failed audit record: %v", h.auditTypes())
	}
}

// A connector that goes away while a request is in flight, before the response
// head has arrived, must still answer CONNECTOR_OFFLINE.
//
// This is the case docs/MCP_SPEC.md section 12 and docs/TESTING.md section 11
// care about most: the request neither hangs nor reports a generic upstream
// failure. Before RVP-18 the stream ended with the session's own transport
// error, which had no stable class, and the caller was told INTERNAL_ERROR.
func TestConnectorLossBeforeTheResponseHeadIsConnectorOffline(t *testing.T) {
	reached := make(chan struct{})
	release := make(chan struct{})
	h := newHarness(t, harnessOptions{
		devHandler: func(w http.ResponseWriter, _ *http.Request) {
			close(reached)
			// The development service never answers: the connector disappears
			// first, which is what the test is about.
			<-release
			w.WriteHeader(http.StatusOK)
		},
	})
	defer close(release)
	h.publish(RegisterRequest{})

	type outcome struct {
		status int
		code   string
	}
	answered := make(chan outcome, 1)
	go func() {
		response := h.browse(browserRequest{capability: h.defaultCapability()})
		defer func() { _ = response.Body.Close() }()
		answered <- outcome{response.StatusCode, response.Header.Get(ErrorCodeHeader)}
	}()

	select {
	case <-reached:
	case <-time.After(5 * time.Second):
		t.Fatal("the request never reached the development service")
	}

	h.session.Close(nil)

	select {
	case got := <-answered:
		if got.status != http.StatusServiceUnavailable || got.code != CodeConnectorOffline {
			t.Fatalf("status %d code %q, want %d %s",
				got.status, got.code, http.StatusServiceUnavailable, CodeConnectorOffline)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the request hung after the connector disconnected")
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
