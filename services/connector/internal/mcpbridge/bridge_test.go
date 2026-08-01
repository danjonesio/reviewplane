package mcpbridge

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// docs/CONNECTOR_PROTOCOL.md section 16 gives the notification's exact form.
// A test on the rendered string is what keeps it stable for an operator's log
// filter and a shell prompt.
func TestNotificationHasTheDocumentedForm(t *testing.T) {
	line := Notification(Work{
		Type:         "review_assigned",
		ReviewSlug:   "bugs-on-homepage",
		FindingCount: 3,
		Priority:     "high",
	})
	want := "[ReviewPlane] New review assigned: bugs-on-homepage (3 findings, high priority)"
	if line != want {
		t.Fatalf("notification = %q, want %q", line, want)
	}
}

func TestNotificationDistinguishesAReopenAndASingleFinding(t *testing.T) {
	reopen := Notification(Work{Type: "finding_reopened", ReviewSlug: "bugs-on-homepage", FindingCount: 1})
	if !strings.Contains(reopen, "Finding reopened") || !strings.Contains(reopen, "1 finding)") {
		t.Fatalf("notification = %q", reopen)
	}
}

// Section 16 forbids injecting text into an active terminal. A control
// character in a notification would be the closest this command comes to it, so
// the value is stripped rather than escaped.
func TestNotificationCarriesNoControlCharacter(t *testing.T) {
	line := Notification(Work{Type: "review_assigned", ReviewSlug: "bugs\r\n[ReviewPlane] forged"})
	if strings.Count(line, "\n") != 0 || strings.Count(line, "\r") != 0 {
		t.Fatalf("notification = %q, want a single line with no control characters", line)
	}
	if strings.Count(line, NotificationPrefix) != 1 {
		t.Fatalf("notification = %q, want exactly one product marker", line)
	}
}

func TestNotifyWritesABoundedStatusFileWithOwnerOnlyPermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "reviewplane-status")
	items := make([]Work, 0, MaxNotifications+3)
	for index := 0; index < MaxNotifications+3; index++ {
		items = append(items, Work{Type: "review_assigned", ReviewSlug: "review"})
	}
	var stderr bytes.Buffer
	if err := Notify(items, NotifyOptions{Stderr: &stderr, StatusFile: path}); err != nil {
		t.Fatalf("Notify: %v", err)
	}
	contents, err := os.ReadFile(path) // #nosec G304 -- test-owned temporary path
	if err != nil {
		t.Fatalf("reading the status file: %v", err)
	}
	lines := strings.Split(strings.TrimRight(string(contents), "\n"), "\n")
	if len(lines) != MaxNotifications+1 {
		t.Fatalf("status file has %d lines, want %d", len(lines), MaxNotifications+1)
	}
	if !strings.Contains(lines[len(lines)-1], "3 more waiting") {
		t.Fatalf("last line = %q, want the remainder to be counted", lines[len(lines)-1])
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("status file mode = %v, want 0600", info.Mode().Perm())
	}
}

func TestNotifyWithNoWorkWritesNothing(t *testing.T) {
	path := filepath.Join(t.TempDir(), "reviewplane-status")
	var stderr bytes.Buffer
	if err := Notify(nil, NotifyOptions{Stderr: &stderr, StatusFile: path}); err != nil {
		t.Fatalf("Notify: %v", err)
	}
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q, want nothing", stderr.String())
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("an empty inbox must not create a status file")
	}
}

// The credential is never rendered into a log line (docs/SECURITY.md
// section 18), and this type is passed to a logger.
func TestCredentialStringOmitsTheToken(t *testing.T) {
	credential := Credential{Token: "rpa_supersecrettoken", CredentialID: "agc_1", ProjectSlug: "refresh-surplus"}
	if strings.Contains(credential.String(), "rpa_") {
		t.Fatalf("String() = %q, want no token", credential.String())
	}
}

func TestCredentialEndpointIsDerivedFromTheControlURL(t *testing.T) {
	endpoint, err := credentialEndpoint("wss://agents.example.internal:8443/connector/v1/control")
	if err != nil {
		t.Fatalf("credentialEndpoint: %v", err)
	}
	want := "https://agents.example.internal:8443/connector/v1/agent-credentials"
	if endpoint != want {
		t.Fatalf("endpoint = %q, want %q", endpoint, want)
	}
	if _, err := credentialEndpoint("ws://agents.example.internal/connector/v1/control"); err == nil {
		t.Fatal("an unencrypted control URL must be refused")
	}
}

// docs/SECURITY.md section 18 forbids a credential in a URL. The hints ride on
// the query string; the token does not.
func TestMCPEndpointCarriesHintsAndNeverACredential(t *testing.T) {
	endpoint, err := MCPEndpoint("https://reviewplane.example", "refresh-surplus", "/workspace/refresh-surplus")
	if err != nil {
		t.Fatalf("MCPEndpoint: %v", err)
	}
	if !strings.Contains(endpoint, "project_hint=refresh-surplus") {
		t.Fatalf("endpoint = %q", endpoint)
	}
	if !strings.Contains(endpoint, "workspace_hint=") {
		t.Fatalf("endpoint = %q", endpoint)
	}
	if strings.Contains(endpoint, "token") || strings.Contains(endpoint, "rpa_") {
		t.Fatalf("endpoint = %q, want no credential", endpoint)
	}
	if _, err := MCPEndpoint("http://reviewplane.example", "p", ""); err == nil {
		t.Fatal("a plaintext control-plane URL must be refused")
	}
}

/*
The proxy tests below run against an in-process TLS server. `httptest` is
permitted in a test file: the connector's guard test scans only non-test sources
of the packages the binary links, because what it forbids is a listening socket
in the shipped binary rather than in a test that drives it.
*/

func startEndpoint(t *testing.T, handler http.HandlerFunc) (string, string) {
	t.Helper()
	server := httptest.NewTLSServer(handler)
	t.Cleanup(server.Close)
	certificate := server.Certificate()
	pemBytes := pemEncode(t, certificate)
	caFile := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(caFile, pemBytes, 0o600); err != nil {
		t.Fatalf("writing the trust anchor: %v", err)
	}
	return server.URL, caFile
}

func pemEncode(t *testing.T, certificate *x509.Certificate) []byte {
	t.Helper()
	var buffer bytes.Buffer
	buffer.WriteString("-----BEGIN CERTIFICATE-----\n")
	encoded := encodeBase64Lines(certificate.Raw)
	buffer.WriteString(encoded)
	buffer.WriteString("-----END CERTIFICATE-----\n")
	return buffer.Bytes()
}

func encodeBase64Lines(raw []byte) string {
	const width = 64
	encoded := base64Std(raw)
	var out strings.Builder
	for index := 0; index < len(encoded); index += width {
		end := index + width
		if end > len(encoded) {
			end = len(encoded)
		}
		out.WriteString(encoded[index:end])
		out.WriteString("\n")
	}
	return out.String()
}

// Proxying carries each JSON-RPC message to the endpoint and each response
// back, and captures the MCP session identifier so the exchange is one session
// rather than a sequence of unrelated calls.
func TestProxyCarriesMessagesAndKeepsTheSession(t *testing.T) {
	var seen []string
	origin, caFile := startEndpoint(t, func(writer http.ResponseWriter, request *http.Request) {
		body := make([]byte, 4096)
		read, _ := request.Body.Read(body)
		seen = append(seen, request.Header.Get("mcp-session-id"))
		if request.Header.Get("authorization") != "Bearer rpa_test" {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		writer.Header().Set("mcp-session-id", "session-one")
		writer.Header().Set("content-type", "application/json")
		_, _ = writer.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"echoed":` + string(body[:read]) + `}}`))
	})

	var out bytes.Buffer
	in := strings.NewReader("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n")
	if err := Proxy(context.Background(), ProxyOptions{
		Endpoint: origin + "/mcp/v1",
		Token:    "rpa_test",
		CAFile:   caFile,
		In:       in,
		Out:      &out,
	}); err != nil {
		t.Fatalf("Proxy: %v", err)
	}
	lines := strings.Split(strings.TrimRight(out.String(), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("wrote %d lines, want 2: %q", len(lines), out.String())
	}
	if len(seen) != 2 || seen[0] != "" || seen[1] != "session-one" {
		t.Fatalf("session identifiers = %v, want the minted one echoed on the second call", seen)
	}
}

// A control plane that goes away mid-session is reported to the agent in its
// own protocol rather than by the pipe closing under it, and the message names
// no host and no credential (docs/SECURITY.md section 18).
func TestProxyReportsAnUnreachableControlPlaneAsAJSONRPCError(t *testing.T) {
	var out bytes.Buffer
	caFile := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(caFile, pemEncode(t, selfSigned(t)), 0o600); err != nil {
		t.Fatalf("writing the trust anchor: %v", err)
	}
	in := strings.NewReader("{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/list\"}\n")
	if err := Proxy(context.Background(), ProxyOptions{
		// A port nothing is listening on.
		Endpoint: "https://127.0.0.1:1/mcp/v1",
		Token:    "rpa_test",
		CAFile:   caFile,
		In:       in,
		Out:      &out,
	}); err != nil {
		t.Fatalf("Proxy: %v", err)
	}
	var decoded struct {
		ID    float64 `json:"id"`
		Error struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(out.String())), &decoded); err != nil {
		t.Fatalf("the agent was not answered in JSON-RPC: %v (%q)", err, out.String())
	}
	if decoded.ID != 7 {
		t.Fatalf("id = %v, want the request's own identifier", decoded.ID)
	}
	if strings.Contains(decoded.Error.Message, "rpa_") || strings.Contains(decoded.Error.Message, "127.0.0.1") {
		t.Fatalf("message = %q, want no credential and no deployment data", decoded.Error.Message)
	}
}

// A peer outside the trust boundary must not be able to stop the bridge with
// one message (ADR-0022). An oversized line is refused rather than buffered.
func TestProxyRefusesAnOversizedMessage(t *testing.T) {
	caFile := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(caFile, pemEncode(t, selfSigned(t)), 0o600); err != nil {
		t.Fatalf("writing the trust anchor: %v", err)
	}
	oversized := strings.Repeat("x", MaxMessageBytes+16) + "\n"
	var out bytes.Buffer
	err := Proxy(context.Background(), ProxyOptions{
		Endpoint: "https://127.0.0.1:1/mcp/v1",
		Token:    "rpa_test",
		CAFile:   caFile,
		In:       strings.NewReader(oversized),
		Out:      &out,
	})
	if err == nil || !strings.Contains(err.Error(), "byte bound") {
		t.Fatalf("err = %v, want the bound to be enforced", err)
	}
}

// The exchange refuses a response that is not a created credential, and the
// refusal carries the control plane's stable code.
func TestExchangeReportsARefusal(t *testing.T) {
	origin, caFile := startEndpoint(t, func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("content-type", "application/json")
		writer.WriteHeader(http.StatusNotFound)
		_, _ = writer.Write([]byte(`{"error":{"code":"RESOURCE_NOT_FOUND","message":"The workspace was not found."}}`))
	})
	_, err := Exchange(context.Background(), ExchangeOptions{
		ControlURL:        strings.Replace(origin, "https://", "wss://", 1) + "/connector/v1/control",
		WorkspacePathHash: "sha256:" + strings.Repeat("a", 64),
		CAFile:            caFile,
	})
	if !errors.Is(err, ErrRefused) {
		t.Fatalf("err = %v, want a refusal", err)
	}
	if !strings.Contains(err.Error(), "RESOURCE_NOT_FOUND") {
		t.Fatalf("err = %v, want the stable code", err)
	}
}

func TestExchangeReturnsTheCredentialAndItsPendingWork(t *testing.T) {
	origin, caFile := startEndpoint(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("content-type") != "application/json" {
			writer.WriteHeader(http.StatusUnsupportedMediaType)
			return
		}
		writer.Header().Set("content-type", "application/json")
		writer.WriteHeader(http.StatusCreated)
		_, _ = writer.Write([]byte(`{"data":{
			"token":"rpa_issued","credential_id":"agc_1","project_id":"prj_1",
			"project_slug":"refresh-surplus","workspace_id":"wsp_1",
			"capabilities":["project:read"],"expires_at":"2026-07-31T12:00:00.000Z",
			"expires_in_seconds":3600,
			"pending_work":[{"type":"review_assigned","review_slug":"bugs-on-homepage","finding_count":3,"priority":"high"}]}}`))
	})
	credential, err := Exchange(context.Background(), ExchangeOptions{
		ControlURL:        strings.Replace(origin, "https://", "wss://", 1) + "/connector/v1/control",
		WorkspacePathHash: "sha256:" + strings.Repeat("b", 64),
		CAFile:            caFile,
	})
	if err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	if credential.Token != "rpa_issued" || credential.ProjectSlug != "refresh-surplus" {
		t.Fatalf("credential = %+v", credential)
	}
	if len(credential.PendingWork) != 1 || credential.PendingWork[0].ReviewSlug != "bugs-on-homepage" {
		t.Fatalf("pending work = %+v", credential.PendingWork)
	}
	line := Notification(credential.PendingWork[0])
	if line != "[ReviewPlane] New review assigned: bugs-on-homepage (3 findings, high priority)" {
		t.Fatalf("notification = %q", line)
	}
}

// A TLS configuration this package builds never disables verification.
func TestClientNeverDisablesVerification(t *testing.T) {
	client, err := newHTTPClient("", nil)
	if err != nil {
		t.Fatalf("newHTTPClient: %v", err)
	}
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatal("the client's transport is not an *http.Transport")
	}
	if transport.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("verification must never be disabled")
	}
	if transport.TLSClientConfig.MinVersion < tls.VersionTLS12 {
		t.Fatal("the minimum TLS version must be at least 1.2")
	}
}
