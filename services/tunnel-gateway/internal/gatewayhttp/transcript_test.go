package gatewayhttp

import (
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/datachannel"
)

// A protocol-level transcript of a publication, a proxied HTTP/1.1 request and
// a revocation, plus the SSRF rejection matrix and a metrics sample.
//
// It is a test rather than a script so that the evidence cannot drift from the
// behaviour: if the gateway stops refusing one of these, the transcript stops
// being producible. Run it with `go test -run TestProtocolTranscript -v ./...`.

// tap records every data-channel frame without changing what either end does
// with it.
type tap struct {
	inner datachannel.MessageConn
	t     *testing.T

	mu    sync.Mutex
	lines []string
	bytes map[string]int
}

func newTap(t *testing.T, inner datachannel.MessageConn) *tap {
	return &tap{inner: inner, t: t, bytes: map[string]int{}}
}

func (c *tap) record(direction string, raw []byte) {
	frame, err := datachannel.DecodeFrame(raw)
	if err != nil {
		return
	}
	detail := ""
	switch frame.Type {
	case datachannel.FrameOpen:
		header, failure := connectorv1.DecodeDataStreamHeaderFrame(frame.Payload)
		if failure == nil {
			// %+v on the header renders the capability as [redacted]: it is a
			// SensitiveString, so a transcript cannot leak it by accident.
			detail = fmt.Sprintf(" %+v", header)
		}
	case datachannel.FrameWindow:
		detail = fmt.Sprintf(" credit=%d", datachannel.WindowCredit(frame))
	case datachannel.FrameReset:
		detail = fmt.Sprintf(" class=%s", string(frame.Payload))
	case datachannel.FrameAccept, datachannel.FrameData, datachannel.FrameEnd:
	}
	c.mu.Lock()
	c.lines = append(c.lines, fmt.Sprintf("  %s %-6s stream=%d payload=%d bytes%s",
		direction, frame.Type, frame.Stream, len(frame.Payload), detail))
	c.bytes[direction+" "+frame.Type.String()] += len(frame.Payload)
	c.mu.Unlock()
}

func (c *tap) ReadMessage() ([]byte, error) {
	message, err := c.inner.ReadMessage()
	if err == nil {
		c.record("gateway -> connector", message)
	}
	return message, err
}

func (c *tap) WriteMessage(payload []byte) error {
	c.record("connector -> gateway", payload)
	return c.inner.WriteMessage(payload)
}

func (c *tap) Close(code int, reason string) error { return c.inner.Close(code, reason) }

func (c *tap) drain() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	lines := append([]string(nil), c.lines...)
	c.lines = nil
	return lines
}

func (c *tap) totals() map[string]int {
	c.mu.Lock()
	defer c.mu.Unlock()
	totals := map[string]int{}
	for key, value := range c.bytes {
		totals[key] = value
	}
	return totals
}

func TestProtocolTranscript(t *testing.T) {
	var recorder *tap
	h := newHarness(t, harnessOptions{
		wrapConn: func(inner datachannel.MessageConn) datachannel.MessageConn {
			recorder = newTap(t, inner)
			return recorder
		},
	})

	t.Log("=== 1. Publication ===")
	registration := h.defaultRegistration()
	t.Logf("PUT /internal/v1/routes/%s", registration.RouteID)
	t.Logf("  connector_id=%s project_id=%s workspace_id=%s",
		registration.ConnectorID, registration.ProjectID, registration.WorkspaceID)
	t.Logf("  local destination=%s:%d protocol=%s expires_at=%s",
		registration.LocalHost, registration.LocalPort, registration.Protocol, registration.ExpiresAt)
	t.Logf("  public_alias=%s allowed_browser_session_ids=%v",
		registration.PublicAlias, registration.AllowedBrowserSessionIDs)
	response := h.publish(registration)
	body := readBody(t, response)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("publish: %s", body)
	}
	t.Logf("  <- %d %s", response.StatusCode, strings.TrimSpace(body))

	t.Log("")
	t.Log("=== 2. Capability ===")
	capability := h.defaultCapability()
	t.Logf("  minted for browser_session_id=%s route_id=%s", testSessionID, testRouteID)
	t.Logf("  scheme=%s length=%d value=%s",
		connectorv1.CapabilityScheme, len(capability), connectorv1.SensitiveString(capability))

	t.Log("")
	t.Log("=== 3. Proxied HTTP/1.1 request ===")
	t.Logf("GET / HTTP/1.1  Host: %s.%s", testAlias, testSuffix)
	t.Logf("  %s: %s", CapabilityHeader, connectorv1.SensitiveString(capability))
	proxied := h.browse(browserRequest{path: "/index.html", capability: capability})
	proxiedBody := readBody(t, proxied)
	if proxied.StatusCode != http.StatusOK {
		t.Fatalf("proxied request: %d %s", proxied.StatusCode, proxiedBody)
	}
	upstream := h.recorded()
	// The counters and the frame tail are recorded after the response body, so
	// the transcript would otherwise be a snapshot of a half-finished request.
	h.settle()
	t.Logf("  <- %d, %d bytes of body", proxied.StatusCode, len(proxiedBody))
	t.Logf("  the development server saw: %s %s  Host: %s",
		upstream.Method, upstream.Path, upstream.Host)
	t.Logf("  capability reached the development server: %t",
		upstream.Headers.Get(CapabilityHeader) != "")
	t.Log("  data-channel frames:")
	for _, line := range recorder.drain() {
		t.Log(line)
	}
	route, live := h.gateway.Routes().Lookup(testRouteID)
	if !live {
		t.Fatal("the route is not registered")
	}
	toDestination, fromDestination, opened, active := route.Counters()
	t.Logf("  route %s: streams opened=%d active=%d bytes to=%d from=%d",
		route.RouteID, opened, active, toDestination, fromDestination)
	t.Logf("  frame byte totals: %v", recorder.totals())

	t.Log("")
	t.Log("=== 4. Revocation ===")
	revocation := h.adminRequest(http.MethodDelete, "/internal/v1/routes/"+testRouteID)
	revocationBody := readBody(t, revocation)
	t.Logf("DELETE /internal/v1/routes/%s", testRouteID)
	t.Logf("  <- %d %s", revocation.StatusCode, strings.TrimSpace(revocationBody))
	if _, stillLive := h.gateway.Routes().Lookup(testRouteID); stillLive {
		t.Fatal("the route survived revocation")
	}
	after := h.browse(browserRequest{capability: capability})
	afterBody := readBody(t, after)
	h.settle()
	t.Logf("  a request after revocation: %d %s", after.StatusCode, strings.TrimSpace(afterBody))

	t.Log("")
	t.Log("=== 5. Audit records ===")
	for _, record := range h.gateway.Auditor().Records() {
		t.Logf("  %s %s", record.OccurredAt.Format(time.RFC3339), record.Type)
	}

	t.Log("")
	t.Log("=== 6. Metrics ===")
	for _, line := range strings.Split(h.metricsText(), "\n") {
		if line != "" && !strings.HasPrefix(line, "# HELP") {
			t.Logf("  %s", line)
		}
	}

	// The transcript is evidence, so it must not contain the credential it
	// describes.
	if strings.Contains(strings.Join(recorder.drain(), " "), capability) {
		t.Fatal("the transcript leaked the capability")
	}
}

func TestSSRFRejectionMatrix(t *testing.T) {
	// Every rejection docs/SECURITY.md section 9 requires, with the stable code
	// the caller receives. The table is the evidence and the assertion at once.
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})
	second := h.defaultRegistration()
	second.RouteID, second.PublicAlias = "svc_transcript_02", "svc-transcript-02"
	h.publish(second)

	t.Log("case                                       | status | code")
	t.Log("-------------------------------------------|--------|------------------------------")

	report := func(name string, status int, code string) {
		t.Logf("%-42s | %6d | %s", name, status, code)
	}

	cases := []struct {
		name   string
		run    func() *http.Response
		status int
		code   string
	}{
		{
			"no capability",
			func() *http.Response { return h.browse(browserRequest{}) },
			http.StatusUnauthorized, CodeAuthenticationRequired,
		},
		{
			"two capabilities",
			func() *http.Response {
				return h.browse(browserRequest{headers: http.Header{
					CapabilityHeader: []string{h.defaultCapability(), h.defaultCapability()},
				}})
			},
			http.StatusUnauthorized, CodeAuthenticationRequired,
		},
		{
			"forged capability",
			func() *http.Response {
				forged, err := connectorv1.MintCapability(make([]byte, 32), connectorv1.CapabilityClaims{
					KeyID: testKeyID, CapabilityID: "cap_f", RouteID: testRouteID,
					ProjectID: testProjectID, BrowserSessionID: testSessionID,
					IssuedAt: h.clock.Now().Unix(), ExpiresAt: h.clock.Now().Add(time.Hour).Unix(),
				})
				if err != nil {
					t.Fatalf("mint: %v", err)
				}
				return h.browse(browserRequest{capability: forged.Reveal()})
			},
			http.StatusForbidden, CodeAuthorisationDenied,
		},
		{
			"another project's capability",
			func() *http.Response {
				return h.browse(browserRequest{
					capability: h.mint(testRouteID, "prj_other", testSessionID, time.Minute),
				})
			},
			http.StatusForbidden, CodeAuthorisationDenied,
		},
		{
			"another browser session's capability",
			func() *http.Response {
				return h.browse(browserRequest{
					capability: h.mint(testRouteID, testProjectID, "brs_other", time.Minute),
				})
			},
			http.StatusForbidden, CodeAuthorisationDenied,
		},
		{
			"another route's capability (route confusion)",
			func() *http.Response {
				return h.browse(browserRequest{
					capability: h.mint("svc_transcript_02", testProjectID, testSessionID, time.Minute),
				})
			},
			http.StatusForbidden, CodeAuthorisationDenied,
		},
		{
			"unauthorised route identifier",
			func() *http.Response {
				return h.browse(browserRequest{
					host: "svc-never-published." + testSuffix, capability: h.defaultCapability(),
				})
			},
			http.StatusNotFound, CodePublishedServiceUnavailable,
		},
		{
			"header-based route confusion",
			func() *http.Response {
				return h.browse(browserRequest{
					host:       "svc-never-published." + testSuffix,
					capability: h.defaultCapability(),
					headers:    http.Header{"X-Forwarded-Host": []string{testAlias + "." + testSuffix}},
				})
			},
			http.StatusNotFound, CodePublishedServiceUnavailable,
		},
		{
			"upgrade request",
			func() *http.Response {
				return h.browse(browserRequest{
					capability: h.defaultCapability(),
					headers:    http.Header{"Upgrade": []string{"websocket"}},
				})
			},
			http.StatusNotImplemented, CodeUnsupportedCapability,
		},
	}
	for _, testCase := range cases {
		response := testCase.run()
		status := response.StatusCode
		code := response.Header.Get(ErrorCodeHeader)
		report(testCase.name, status, code)
		assertCode(t, response, testCase.status, testCase.code)
	}

	// Publication-time destination rejections.
	for _, destination := range []struct {
		name string
		host string
		port int
	}{
		{"publish 169.254.169.254 (metadata)", "169.254.169.254", 80},
		{"publish fd00:ec2::254 (metadata, IPv6)", "fd00:ec2::254", 80},
		{"publish 169.254.10.1 (link-local)", "169.254.10.1", 3000},
		{"publish 10.0.0.5 (private network)", "10.0.0.5", 3000},
		{"publish localhost (not a literal address)", "localhost", 3000},
	} {
		registration := h.defaultRegistration()
		registration.RouteID = "svc_" + strings.ReplaceAll(destination.host, ".", "_")
		registration.PublicAlias = "svc-" + strings.ToLower(
			strings.NewReplacer(".", "-", ":", "-").Replace(destination.host))
		registration.LocalHost = destination.host
		registration.LocalPort = destination.port
		response := h.publish(registration)
		report(destination.name, response.StatusCode, response.Header.Get(ErrorCodeHeader))
		assertCode(t, response, http.StatusUnprocessableEntity, CodeDestinationNotAllowed)
	}

	// Proxy-shaped requests, sent raw because net/http's client will not build
	// them.
	capability := h.defaultCapability()
	for _, raw := range []struct {
		name    string
		request string
	}{
		{
			"CONNECT 127.0.0.1:22",
			"CONNECT 127.0.0.1:22 HTTP/1.1\r\nHost: " + testAlias + "." + testSuffix + "\r\n" +
				CapabilityHeader + ": " + capability + "\r\nConnection: close\r\n\r\n",
		},
		{
			"absolute-form target to metadata",
			"GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\nHost: " +
				testAlias + "." + testSuffix + "\r\n" + CapabilityHeader + ": " + capability +
				"\r\nConnection: close\r\n\r\n",
		},
	} {
		answer := h.rawRequest(raw.request)
		statusLine := strings.SplitN(answer, "\r\n", 2)[0]
		if !strings.Contains(answer, CodeUnsupportedCapability) {
			t.Fatalf("%s was not refused: %s", raw.name, answer)
		}
		report(raw.name, 0, statusLine+" "+CodeUnsupportedCapability)
	}
}
