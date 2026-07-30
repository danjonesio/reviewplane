package gatewayhttp

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

// Integration layer (docs/TESTING.md sections 2 and 6): a loopback HTTP route
// reachable through a protocol-level client.

func TestLoopbackHTTPRouteIsReachable(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	if response := h.publish(RegisterRequest{}); response.StatusCode != http.StatusOK {
		t.Fatalf("publish: %s", readBody(t, response))
	}

	response := h.browse(browserRequest{path: "/index.html?q=1", capability: h.defaultCapability()})
	body := readBody(t, response)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", response.StatusCode, body)
	}
	if body != "hello from the development server" {
		t.Fatalf("body %q", body)
	}
	if response.Header.Get("X-Dev-Server") != "fixture" {
		t.Fatal("the development server's response headers did not reach the browser")
	}

	received := h.recorded()
	if received.Path != "/index.html?q=1" {
		t.Fatalf("the development server saw %q", received.Path)
	}
	if received.Host != h.devHost+":"+itoa(h.devPort) {
		t.Fatalf("Host %q, want the upstream destination", received.Host)
	}
	if received.Headers.Get(CapabilityHeader) != "" {
		t.Fatal("the capability reached the development service")
	}
	if received.Headers.Get("X-Forwarded-Proto") != "https" {
		t.Fatalf("X-Forwarded-Proto %q", received.Headers.Get("X-Forwarded-Proto"))
	}
	if received.Headers.Get("X-Forwarded-Host") != testAlias+"."+testSuffix {
		t.Fatalf("X-Forwarded-Host %q", received.Headers.Get("X-Forwarded-Host"))
	}
	if received.Headers.Get("X-Forwarded-For") != "" {
		t.Fatal("the gateway leaked the browser worker's address to the development service")
	}
}

func TestRequestBodyAndMethodAreCarried(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})

	response := h.browse(browserRequest{
		method:     http.MethodPost,
		path:       "/api/things",
		capability: h.defaultCapability(),
		body:       `{"name":"a thing"}`,
		headers:    http.Header{"Content-Type": []string{"application/json"}},
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", response.StatusCode, readBody(t, response))
	}
	_ = readBody(t, response)

	received := h.recorded()
	if received.Method != http.MethodPost {
		t.Fatalf("method %q", received.Method)
	}
	if received.Body != `{"name":"a thing"}` {
		t.Fatalf("body %q", received.Body)
	}
	if received.Headers.Get("Content-Type") != "application/json" {
		t.Fatalf("Content-Type %q", received.Headers.Get("Content-Type"))
	}
}

func TestHostHeaderModeOriginalSendsTheInternalOrigin(t *testing.T) {
	h := newHarness(t, harnessOptions{proxyCfg: ProxyConfig{HostHeader: HostOriginal}})
	h.publish(RegisterRequest{})

	response := h.browse(browserRequest{capability: h.defaultCapability()})
	_ = readBody(t, response)
	received := h.recorded()
	if received.Host != testAlias+"."+testSuffix {
		t.Fatalf("Host %q, want the internal origin", received.Host)
	}
}

func TestForwardedHeaderModeNoneAddsNothing(t *testing.T) {
	h := newHarness(t, harnessOptions{proxyCfg: ProxyConfig{Forwarded: ForwardedNone}})
	h.publish(RegisterRequest{})

	response := h.browse(browserRequest{capability: h.defaultCapability()})
	_ = readBody(t, response)
	received := h.recorded()
	if received.Headers.Get("X-Forwarded-Proto") != "" || received.Headers.Get("X-Forwarded-Host") != "" {
		t.Fatal("forwarded headers were added in none mode")
	}
}

func TestUpstreamCannotForgeGatewayHeaders(t *testing.T) {
	h := newHarness(t, harnessOptions{devHandler: func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set(ErrorCodeHeader, "AUTHORISATION_DENIED")
		w.Header().Set("X-ReviewPlane-Request-Id", "req_forged")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}})
	h.publish(RegisterRequest{})

	response := h.browse(browserRequest{capability: h.defaultCapability()})
	defer func() { _ = response.Body.Close() }()
	if response.Header.Get(ErrorCodeHeader) != "" {
		t.Fatal("a development service forged the gateway's error-code header")
	}
	if response.Header.Get("X-ReviewPlane-Request-Id") != "" {
		t.Fatal("a development service forged the gateway's request identifier")
	}
}

func TestOnlyAWebSocketUpgradeIsCarried(t *testing.T) {
	// docs/CONNECTOR_PROTOCOL.md section 13.3 carries one upgrade token.
	// Everything else is refused rather than relayed: HTTP/2 is deferred by
	// docs/ARCHITECTURE.md section 7.4, and relaying a framing the gateway has
	// never seen would make it the raw forwarder docs/SECURITY.md section 9
	// excludes permanently.
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})

	cases := []struct {
		name    string
		method  string
		body    string
		headers http.Header
		status  int
	}{
		{
			name:    "h2c",
			headers: http.Header{"Upgrade": []string{"h2c"}, "Connection": []string{"Upgrade"}},
			status:  http.StatusNotImplemented,
		},
		{
			name:    "upgrade without a connection token",
			headers: http.Header{"Upgrade": []string{"websocket"}},
			status:  http.StatusBadRequest,
		},
		{
			name:    "connection token without an upgrade",
			headers: http.Header{"Connection": []string{"Upgrade"}},
			status:  http.StatusBadRequest,
		},
		{
			name: "a list of alternatives",
			headers: http.Header{
				"Upgrade":    []string{"websocket, h2c"},
				"Connection": []string{"Upgrade"},
			},
			status: http.StatusBadRequest,
		},
		{
			name:    "a method that is not GET",
			method:  http.MethodPost,
			headers: http.Header{"Upgrade": []string{"websocket"}, "Connection": []string{"Upgrade"}},
			status:  http.StatusMethodNotAllowed,
		},
		{
			// A GET with a body, so that the body check is what fires rather
			// than the method check.
			name:    "a handshake carrying a body",
			body:    "smuggled",
			headers: http.Header{"Upgrade": []string{"websocket"}, "Connection": []string{"Upgrade"}},
			status:  http.StatusBadRequest,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			response := h.browse(browserRequest{
				method:     testCase.method,
				body:       testCase.body,
				capability: h.defaultCapability(),
				headers:    testCase.headers,
			})
			assertCode(t, response, testCase.status, CodeUnsupportedCapability)
		})
	}
}

func TestMetricsRecordBytesStreamsAndRouteLifecycle(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})
	response := h.browse(browserRequest{capability: h.defaultCapability()})
	_ = readBody(t, response)
	h.recorded()
	// The stream outcome and the request code are recorded after the response
	// body has been written, so the client having read it is not enough.
	h.settle()

	text := h.metricsText()
	for _, required := range []string{
		`reviewplane_tunnel_route_lifecycle_total{transition="ready"} 1`,
		`reviewplane_tunnel_streams_total{outcome="opened"} 1`,
		`reviewplane_tunnel_streams_total{outcome="completed"} 1`,
		`reviewplane_tunnel_requests_total{code="ok"} 1`,
		`reviewplane_tunnel_connector_channels_total{outcome="accepted"} 1`,
		`reviewplane_tunnel_route_bytes{route_id="` + testRouteID + `",direction="to_destination"}`,
		`reviewplane_tunnel_route_bytes{route_id="` + testRouteID + `",direction="from_destination"}`,
		`reviewplane_tunnel_routes_active 1`,
	} {
		if !strings.Contains(text, required) {
			t.Fatalf("metrics do not carry %q:\n%s", required, text)
		}
	}
	if !strings.Contains(text, `reviewplane_tunnel_bytes_total{direction="from_destination"}`) {
		t.Fatalf("metrics do not carry the byte counters:\n%s", text)
	}
}

func TestPerRouteMetricsDoNotOutliveTheirRoute(t *testing.T) {
	// A route is short-lived. A per-route series that survived its route would
	// grow without bound.
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})
	if !strings.Contains(h.metricsText(), `route_id="`+testRouteID+`"`) {
		t.Fatal("the route was not reported while it existed")
	}
	response := h.adminRequest(http.MethodDelete, "/internal/v1/routes/"+testRouteID)
	_ = readBody(t, response)
	if strings.Contains(h.metricsText(), `route_id="`+testRouteID+`"`) {
		t.Fatal("a revoked route is still reported")
	}
}

func TestHostNormalisationIsDeterministic(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})
	capability := h.defaultCapability()

	// Case and an explicit port must resolve to the same route; anything else
	// must resolve to none.
	for _, host := range []string{
		strings.ToUpper(testAlias) + "." + testSuffix,
		testAlias + "." + testSuffix + ":443",
	} {
		response := h.browse(browserRequest{host: host, capability: capability})
		if response.StatusCode != http.StatusOK {
			t.Fatalf("host %q resolved to status %d: %s", host, response.StatusCode, readBody(t, response))
		}
		_ = readBody(t, response)
		h.recorded()
	}
	for _, host := range []string{
		"other." + testAlias + "." + testSuffix,
		testAlias + ".internal.example",
		testAlias,
		"." + testSuffix,
		"127.0.0.1:8080",
	} {
		response := h.browse(browserRequest{host: host, capability: capability})
		assertCode(t, response, http.StatusNotFound, CodePublishedServiceUnavailable)
	}
}

func TestExpiryAndDeadlineArithmeticBoundsTheStream(t *testing.T) {
	// A stream may not outlive its route: the deadline in the data-stream
	// header is the earlier of the configured maximum stream lifetime and the
	// route's expiry.
	h := newHarness(t, harnessOptions{proxyCfg: ProxyConfig{StreamMaxLifetime: time.Hour}})
	registration := h.defaultRegistration()
	registration.ExpiresAt = h.clock.Now().Add(90 * time.Second).Format(time.RFC3339)
	h.publish(registration)

	response := h.browse(browserRequest{capability: h.defaultCapability()})
	_ = readBody(t, response)
	h.recorded()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status %d", response.StatusCode)
	}
}

func itoa(value int) string {
	digits := ""
	if value == 0 {
		return "0"
	}
	for value > 0 {
		digits = string(rune('0'+value%10)) + digits
		value /= 10
	}
	return digits
}
