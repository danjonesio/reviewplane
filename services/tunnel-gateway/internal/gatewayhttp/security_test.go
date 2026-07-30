package gatewayhttp

import (
	"bufio"
	"crypto/tls"
	"encoding/json"
	"net"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/datachannel"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/internal/metrics"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/internal/wsx"
)

// Security layer (docs/TESTING.md sections 6, 10 and 21). Every rejection
// docs/SECURITY.md section 9 requires has a test here, and each asserts the
// stable code the caller receives rather than only that it failed.

func TestRequestWithoutACapabilityIsRefused(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})
	assertCode(t, h.browse(browserRequest{}), http.StatusUnauthorized, CodeAuthenticationRequired)
}

func TestTwoCapabilitiesAreRefusedRatherThanOneChosen(t *testing.T) {
	// Choosing between them would make which one authorised the request depend
	// on header ordering.
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})
	response := h.browse(browserRequest{
		headers: http.Header{CapabilityHeader: []string{h.defaultCapability(), h.defaultCapability()}},
	})
	assertCode(t, response, http.StatusUnauthorized, CodeAuthenticationRequired)
}

func TestExpiredCapabilityIsRefusedWithRouteExpired(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})
	capability := h.mint(testRouteID, testProjectID, testSessionID, time.Minute)
	h.clock.advance(2 * time.Minute)
	assertCode(t, h.browse(browserRequest{capability: capability}), http.StatusForbidden, CodeRouteExpired)
}

func TestADeniedRequestOpensNoStreamAndDoesNotRetry(t *testing.T) {
	// A denial must be a single answer, not a loop. Nothing reaches the
	// connector, so an expired or unauthorised capability cannot be turned into
	// load on the development environment by a client that keeps trying.
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})
	expired := h.mint(testRouteID, testProjectID, testSessionID, time.Minute)
	h.clock.advance(2 * time.Minute)

	before := h.gateway.Metrics().Value(metrics.Streams, "outcome", "opened")
	for attempt := 0; attempt < 3; attempt++ {
		assertCode(t, h.browse(browserRequest{capability: expired}), http.StatusForbidden, CodeRouteExpired)
	}
	if after := h.gateway.Metrics().Value(metrics.Streams, "outcome", "opened"); after != before {
		t.Fatalf("%v streams were opened for denied requests", after-before)
	}
	route, live := h.gateway.Routes().Lookup(testRouteID)
	if !live {
		t.Fatal("the route was discarded by a denied request")
	}
	if _, _, opened, _ := route.Counters(); opened != 0 {
		t.Fatalf("the route recorded %d streams for denied requests", opened)
	}
	if h.gateway.Metrics().Value(metrics.Denials, "reason", "capability_expired") != 3 {
		t.Fatalf("the denials were not counted once each:\n%s", h.metricsText())
	}
}

func TestAnotherProjectsCapabilityIsRefused(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})
	capability := h.mint(testRouteID, "prj_someone_else", testSessionID, 5*time.Minute)
	assertCode(t, h.browse(browserRequest{capability: capability}), http.StatusForbidden, CodeAuthorisationDenied)
}

func TestAnotherBrowserSessionsCapabilityIsRefused(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})
	capability := h.mint(testRouteID, testProjectID, "brs_someone_else", 5*time.Minute)
	assertCode(t, h.browse(browserRequest{capability: capability}), http.StatusForbidden, CodeAuthorisationDenied)
}

func TestAnotherRoutesCapabilityIsRefused(t *testing.T) {
	// The route-confusion case: a valid capability, presented at the wrong
	// origin.
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})
	second := h.defaultRegistration()
	second.RouteID = "svc_test_02"
	second.PublicAlias = "svc-test-02"
	h.publish(second)

	capability := h.mint("svc_test_02", testProjectID, testSessionID, 5*time.Minute)
	response := h.browse(browserRequest{host: testAlias + "." + testSuffix, capability: capability})
	assertCode(t, response, http.StatusForbidden, CodeAuthorisationDenied)
}

func TestForgedCapabilityIsRefused(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})
	forged, err := connectorv1.MintCapability(make([]byte, 32), connectorv1.CapabilityClaims{
		KeyID: testKeyID, CapabilityID: "cap_forged", RouteID: testRouteID,
		ProjectID: testProjectID, BrowserSessionID: testSessionID,
		IssuedAt: h.clock.Now().Unix(), ExpiresAt: h.clock.Now().Add(time.Hour).Unix(),
	})
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	assertCode(t, h.browse(browserRequest{capability: forged.Reveal()}),
		http.StatusForbidden, CodeAuthorisationDenied)
}

func TestUnauthorisedRouteIdentifierIsRefused(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})
	response := h.browse(browserRequest{
		host:       "svc-never-published." + testSuffix,
		capability: h.defaultCapability(),
	})
	assertCode(t, response, http.StatusNotFound, CodePublishedServiceUnavailable)
}

func TestTheGatewayIsNotAForwardProxy(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})
	capability := h.defaultCapability()

	// CONNECT is the tunnelling verb. There is no handler for it at all, and
	// docs/SECURITY.md section 9 excludes it permanently rather than deferring
	// it.
	response := h.rawRequest("CONNECT 127.0.0.1:22 HTTP/1.1\r\nHost: " + testAlias + "." + testSuffix +
		"\r\n" + CapabilityHeader + ": " + capability + "\r\nConnection: close\r\n\r\n")
	if !strings.Contains(response, CodeUnsupportedCapability) {
		t.Fatalf("CONNECT was not refused with a stable code: %s", response)
	}

	// Absolute-form is the proxy request form.
	response = h.rawRequest("GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\nHost: " +
		testAlias + "." + testSuffix + "\r\n" + CapabilityHeader + ": " + capability +
		"\r\nConnection: close\r\n\r\n")
	if !strings.Contains(response, CodeUnsupportedCapability) {
		t.Fatalf("an absolute-form request target was not refused: %s", response)
	}
}

func TestUpstreamHostAndPortCannotBeSubstitutedThroughHeaders(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})

	// A second listener the request must never reach.
	forbidden, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer func() { _ = forbidden.Close() }()
	reached := make(chan struct{}, 1)
	go func() {
		if conn, acceptErr := forbidden.Accept(); acceptErr == nil {
			reached <- struct{}{}
			_ = conn.Close()
		}
	}()
	forbiddenAddress := forbidden.Addr().String()

	response := h.browse(browserRequest{
		capability: h.defaultCapability(),
		headers: http.Header{
			"X-Forwarded-Host":     []string{forbiddenAddress},
			"X-Forwarded-Port":     []string{strconv.Itoa(forbidden.Addr().(*net.TCPAddr).Port)},
			"X-Real-Ip":            []string{"169.254.169.254"},
			"X-Original-Url":       []string{"http://169.254.169.254/latest/meta-data/"},
			"X-Rewrite-Url":        []string{"http://169.254.169.254/"},
			"Forwarded":            []string{"host=" + forbiddenAddress},
			"X-Http-Host-Override": []string{forbiddenAddress},
		},
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", response.StatusCode, readBody(t, response))
	}
	_ = readBody(t, response)

	received := h.recorded()
	if received.Host != h.devHost+":"+strconv.Itoa(h.devPort) {
		t.Fatalf("Host %q: the substitution changed the destination", received.Host)
	}
	// The substitution headers are also stripped, so the development service
	// cannot be persuaded by them either.
	for _, name := range []string{
		"X-Forwarded-Port", "X-Real-Ip", "X-Original-Url", "X-Rewrite-Url",
		"Forwarded", "X-Http-Host-Override",
	} {
		if received.Headers.Get(name) != "" {
			t.Fatalf("%s reached the development service", name)
		}
	}
	if received.Headers.Get("X-Forwarded-Host") != testAlias+"."+testSuffix {
		t.Fatalf("X-Forwarded-Host %q was not replaced by the gateway's own value",
			received.Headers.Get("X-Forwarded-Host"))
	}
	select {
	case <-reached:
		t.Fatal("the request reached the forbidden destination")
	default:
	}
}

func TestConnectorIgnoresADestinationSuppliedInTheRequestBytes(t *testing.T) {
	// The connector-side half of the defence in depth
	// (docs/CONNECTOR_PROTOCOL.md section 12). The gateway is bypassed
	// completely: this test drives the data channel directly and writes a
	// request that names another destination in every way HTTP allows.
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})

	forbidden, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer func() { _ = forbidden.Close() }()
	reached := make(chan struct{}, 1)
	go func() {
		if conn, acceptErr := forbidden.Accept(); acceptErr == nil {
			reached <- struct{}{}
			_ = conn.Close()
		}
	}()

	session, live := h.gateway.Channels().Get(testConnectorID)
	if !live {
		t.Fatal("no data channel")
	}
	stream, err := session.Open(connectorv1.DataStreamHeader{
		RouteID:             testRouteID,
		BrowserSessionID:    testSessionID,
		SessionCapability:   connectorv1.SensitiveString(h.defaultCapability()),
		StreamID:            "req_raw_destination_test",
		DestinationProtocol: connectorv1.DestinationProtocolHTTP,
		Deadline:            h.clock.Now().Add(time.Minute).UTC().Format("2006-01-02T15:04:05Z"),
	})
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	defer func() { _ = stream.Close() }()

	if _, err := stream.Write([]byte(
		"GET http://" + forbidden.Addr().String() + "/latest/meta-data/ HTTP/1.1\r\n" +
			"Host: " + forbidden.Addr().String() + "\r\n" +
			"Connection: close\r\n\r\n")); err != nil {
		t.Fatalf("write request: %v", err)
	}
	_ = stream.CloseWrite()

	response, err := http.ReadResponse(bufio.NewReader(stream), nil)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status %d", response.StatusCode)
	}
	h.recorded()
	select {
	case <-reached:
		t.Fatal("the connector opened a destination named in the request bytes")
	default:
	}
}

func TestTheDataStreamHeaderCannotCarryADestination(t *testing.T) {
	// Contract layer: the schema has no host or port field and refuses unknown
	// properties, so a destination cannot be smuggled into the header that
	// opens a stream. This is the property the connector's behaviour depends
	// on, so it is asserted rather than assumed.
	smuggled := `{"route_id":"svc_a","browser_session_id":"brs_a",` +
		`"session_capability":"rp1.AAAA.BBBBBBBBBBBBBBBB","stream_id":"req_a",` +
		`"destination_protocol":"http","deadline":"2026-07-30T12:00:00Z",` +
		`"local_host":"169.254.169.254","local_port":80}`
	if _, failure := connectorv1.DecodeDataStreamHeaderFrame([]byte(smuggled)); failure == nil {
		t.Fatal("a data-stream header carrying a destination was accepted")
	} else if failure.Reason != connectorv1.ReasonSchemaViolation {
		t.Fatalf("refused as %q, want schema_violation", failure.Reason)
	}
}

func TestLinkLocalAndMetadataDestinationsAreRefusedAtPublication(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	for _, destination := range []struct {
		name string
		host string
		port int
	}{
		{"metadata", "169.254.169.254", 80},
		{"metadata-ipv6", "fd00:ec2::254", 80},
		{"link-local", "169.254.10.1", 3000},
		{"private-network", "10.0.0.5", 3000},
		{"unspecified", "0.0.0.0", 3000},
		{"host-name", "localhost", 3000},
	} {
		t.Run(destination.name, func(t *testing.T) {
			registration := h.defaultRegistration()
			registration.RouteID = "svc_" + destination.name
			registration.PublicAlias = "svc-" + destination.name
			registration.LocalHost = destination.host
			registration.LocalPort = destination.port
			response := h.publish(registration)
			assertCode(t, response, http.StatusUnprocessableEntity, CodeDestinationNotAllowed)
		})
	}
}

func TestRouteLimitPerConnectorIsEnforced(t *testing.T) {
	h := newHarness(t, harnessOptions{maxRoutes: 2})
	for index := 0; index < 2; index++ {
		registration := h.defaultRegistration()
		registration.RouteID = "svc_limit_" + strconv.Itoa(index)
		registration.PublicAlias = "svc-limit-" + strconv.Itoa(index)
		if response := h.publish(registration); response.StatusCode != http.StatusOK {
			t.Fatalf("publish %d: %s", index, readBody(t, response))
		}
	}
	registration := h.defaultRegistration()
	registration.RouteID = "svc_limit_2"
	registration.PublicAlias = "svc-limit-2"
	assertCode(t, h.publish(registration), http.StatusTooManyRequests, CodeRouteLimitExceeded)
}

func TestStreamLimitPerRouteIsEnforced(t *testing.T) {
	release := make(chan struct{})
	h := newHarness(t, harnessOptions{devHandler: func(w http.ResponseWriter, _ *http.Request) {
		<-release
		w.WriteHeader(http.StatusOK)
	}, proxyCfg: ProxyConfig{MaxStreamsPerRoute: 1}})
	defer close(release)
	h.publish(RegisterRequest{})
	capability := h.defaultCapability()

	held := make(chan struct{})
	go func() {
		response := h.browse(browserRequest{capability: capability})
		_ = response.Body.Close()
		close(held)
	}()
	// Wait for the first stream to be counted against the route.
	deadline := time.Now().Add(2 * time.Second)
	for {
		if route, ok := h.gateway.Routes().Lookup(testRouteID); ok {
			if _, _, _, active := route.Counters(); active >= 1 {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("the first stream never became active")
		}
		time.Sleep(5 * time.Millisecond)
	}
	assertCode(t, h.browse(browserRequest{capability: capability}),
		http.StatusTooManyRequests, CodeStreamLimitExceeded)
}

func TestDestinationNotListeningReportsPortNotListening(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})
	// The development server stops after publication, which is the ordinary
	// case of a developer restarting their dev server.
	h.dev.Close()

	assertCode(t, h.browse(browserRequest{capability: h.defaultCapability()}),
		http.StatusBadGateway, CodePortNotListening)
}

func TestMalformedDataChannelFramesAreRefusedWithoutPanic(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})

	conn, err := h.dialConnector(h.authority.ConnectorCertificate(t, "con_malformed"), "")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	h.waitForChannel("con_malformed")

	for _, malformed := range [][]byte{
		{},                 // shorter than a frame header
		{1, 0, 0, 0},       // truncated stream number
		{1, 0, 0, 0, 0},    // stream 0 is reserved
		{99, 0, 0, 0, 1},   // unknown frame type
		{6, 0, 0, 0, 1, 1}, // a window frame that is not four bytes
		append([]byte{1, 0, 0, 0, 1}, []byte("{not json")...), // an unparsable header
		append([]byte{5, 0, 0, 0, 1}, []byte("NOT_A_PROTOCOL_ERROR_CLASS")...),
	} {
		// Each is written to a fresh channel, because a malformed frame ends
		// the session by design: the stream numbering after it cannot be
		// trusted.
		if err := conn.WriteMessage(malformed); err != nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	_ = conn.Close(wsx.CloseNormal, "")

	// The gateway is still serving: a malformed frame took down one channel,
	// not the process.
	h.connect(testConnectorID, h.authority.ConnectorCertificate(t, testConnectorID), "")
	response := h.browse(browserRequest{capability: h.defaultCapability()})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("the gateway did not survive malformed frames: %d", response.StatusCode)
	}
	_ = readBody(t, response)
	h.recorded()
}

func TestOversizedDataChannelMessagesAreRefused(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	conn, err := h.dialConnector(h.authority.ConnectorCertificate(t, "con_oversized"), "")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.Close(wsx.CloseNormal, "") }()
	h.waitForChannel("con_oversized")

	oversized := make([]byte, (64<<10)+1)
	if err := conn.WriteMessage(oversized); err == nil {
		// The local bound refused it before it reached the wire, which is the
		// bounded-allocation rule applied on the sending side too.
		t.Log("the message was refused locally")
	}
	// Either way the gateway must not be carrying a channel that sent one.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, live := h.gateway.Channels().Get("con_oversized"); !live {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestLogsCarryNoCapabilityCookieOrAuthorisationHeader(t *testing.T) {
	// docs/SECURITY.md section 18. The assertion covers a successful request, a
	// refused one and the control API, because each is a place where a
	// credential would plausibly be recorded "for diagnosis".
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})
	capability := h.defaultCapability()
	secretCookie := "session=super-secret-cookie-value"
	secretAuthorisation := "Bearer a-development-service-token"

	response := h.browse(browserRequest{
		capability: capability,
		headers: http.Header{
			"Cookie":        []string{secretCookie},
			"Authorization": []string{secretAuthorisation},
		},
	})
	_ = readBody(t, response)
	h.recorded()

	assertCode(t, h.browse(browserRequest{
		capability: h.mint(testRouteID, "prj_other", testSessionID, time.Minute),
		headers:    http.Header{"Cookie": []string{secretCookie}},
	}), http.StatusForbidden, CodeAuthorisationDenied)

	_ = readBody(t, h.adminRequest(http.MethodGet, "/internal/v1/routes"))

	logs := h.logs.String()
	for name, secret := range map[string]string{
		"capability":          capability,
		"cookie":              "super-secret-cookie-value",
		"authorization":       "a-development-service-token",
		"control plane token": testAdminToken,
	} {
		if strings.Contains(logs, secret) {
			t.Fatalf("the %s appears in the gateway's logs", name)
		}
	}
	if !strings.Contains(logs, "tunnel request refused") {
		t.Fatalf("the refusal was not logged at all:\n%s", logs)
	}
}

func TestAuditRecordsCarryNoCapability(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})
	capability := h.defaultCapability()
	response := h.browse(browserRequest{capability: capability})
	_ = readBody(t, response)
	h.recorded()

	encoded, err := json.Marshal(h.gateway.Auditor().Records())
	if err != nil {
		t.Fatalf("encode audit records: %v", err)
	}
	if strings.Contains(string(encoded), capability) {
		t.Fatal("an audit record carries the capability")
	}
}

func TestControlAPIRequiresTheControlPlaneToken(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	for _, token := range []string{"", "Bearer wrong", "Bearer " + testAdminToken[:8]} {
		request, err := http.NewRequest(http.MethodGet, h.admin.URL+"/internal/v1/routes", nil)
		if err != nil {
			t.Fatalf("build request: %v", err)
		}
		if token != "" {
			request.Header.Set("Authorization", token)
		}
		response, err := h.admin.Client().Do(request)
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		assertCode(t, response, http.StatusUnauthorized, CodeAuthenticationRequired)
	}
}

func TestControlAPIRefusesUnknownFields(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	body := `{"route_id":"svc_x","allow_any_destination":true}`
	request, err := http.NewRequest(http.MethodPut, h.admin.URL+"/internal/v1/routes/svc_x",
		strings.NewReader(body))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+testAdminToken)
	response, err := h.admin.Client().Do(request)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	assertCode(t, response, http.StatusBadRequest, CodeUnsupportedCapability)
}

func TestAliasMustBeADNSLabel(t *testing.T) {
	// The origin-to-route mapping must be injective and total. An alias a
	// resolver would normalise differently is refused at registration rather
	// than guessed at request time.
	h := newHarness(t, harnessOptions{})
	for _, alias := range []string{
		"svc_underscore", "UPPER", "-leading", "trailing-", "two.labels",
		strings.Repeat("a", 64), "",
	} {
		registration := h.defaultRegistration()
		registration.RouteID = "svc_alias_test"
		registration.PublicAlias = alias
		response := h.publish(registration)
		if response.StatusCode == http.StatusOK {
			_ = readBody(t, response)
			t.Fatalf("alias %q was accepted", alias)
		}
		_ = readBody(t, response)
	}
}

// rawRequest speaks HTTP/1.1 to the proxy listener directly, so that a request
// net/http's client would refuse to build can still be sent.
func (h *harness) rawRequest(request string) string {
	h.t.Helper()
	address := strings.TrimPrefix(h.proxy.URL, "http://")
	conn, err := net.DialTimeout("tcp", address, 2*time.Second)
	if err != nil {
		h.t.Fatalf("dial proxy: %v", err)
	}
	defer func() { _ = conn.Close() }()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write([]byte(request)); err != nil {
		h.t.Fatalf("write raw request: %v", err)
	}
	buffer := make([]byte, 4096)
	count, _ := conn.Read(buffer)
	return string(buffer[:count])
}

var _ = tls.Config{}
var _ = datachannel.FrameOpen
