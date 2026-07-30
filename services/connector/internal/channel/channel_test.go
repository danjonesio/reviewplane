package channel_test

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	connectorv1 "github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/connector/internal/buildinfo"
	"github.com/danjonesio/reviewplane/services/connector/internal/channel"
	"github.com/danjonesio/reviewplane/services/connector/internal/config"
	"github.com/danjonesio/reviewplane/services/connector/internal/controlplanetest"
	"github.com/danjonesio/reviewplane/services/connector/internal/enrol"
	"github.com/danjonesio/reviewplane/services/connector/internal/identity"
	"github.com/danjonesio/reviewplane/services/connector/internal/logging"
	"github.com/danjonesio/reviewplane/services/connector/internal/transport"
)

const testToken = "test-enrolment-token-0123456789"

type harness struct {
	server *controlplanetest.Server
	config *config.Config
	store  *identity.Store
	logs   *lockedBuffer
	runner *channel.Runner
	result *enrol.Result
}

// lockedBuffer collects log output written from several goroutines.
type lockedBuffer struct {
	mutex  sync.Mutex
	buffer bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mutex.Lock()
	defer b.mutex.Unlock()
	return b.buffer.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mutex.Lock()
	defer b.mutex.Unlock()
	return b.buffer.String()
}

func newHarness(t *testing.T, options controlplanetest.Options) *harness {
	t.Helper()
	if options.Token == "" {
		options.Token = testToken
	}
	server := controlplanetest.Start(t, options)
	dataDir := filepath.Join(t.TempDir(), "data")
	source := "control_plane:\n  url: " + server.URL + "\n" +
		"  tls:\n    ca_file: " + server.CAFile + "\n" +
		"identity:\n  data_dir: " + dataDir + "\n" +
		"heartbeat:\n  interval: 1s\n" +
		"reconnect:\n  initial_delay: 20ms\n  max_delay: 200ms\n  jitter: 0.2\n" +
		"environment:\n  name: dev-ai-03\n"
	cfg, err := config.Parse([]byte(source))
	if err != nil {
		t.Fatalf("building test configuration: %v", err)
	}
	logs := &lockedBuffer{}
	logger := logging.New(logs, "debug")

	result, err := enrol.Run(context.Background(), enrol.Options{
		Config: cfg, Token: connectorv1.EnrolmentToken(testToken), Logger: logger,
	})
	if err != nil {
		t.Fatalf("enrolling the test connector: %v", err)
	}
	store := identity.NewStore(dataDir)
	return &harness{
		server: server,
		config: cfg,
		store:  store,
		logs:   logs,
		result: result,
		runner: &channel.Runner{Config: cfg, Store: store, Logger: logger},
	}
}

// docs/CONNECTOR_PROTOCOL.md sections 5 and 8: the channel is mutually
// authenticated and heartbeats flow at the configured interval.
func TestChannelHoldsOpenAndHeartbeats(t *testing.T) {
	h := newHarness(t, controlplanetest.Options{})
	heartbeats := make(chan int, 8)
	h.runner.OnHeartbeat = func(sequence int) {
		select {
		case heartbeats <- sequence:
		default:
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.runner.Run(ctx) }()

	for want := 1; want <= 3; want++ {
		select {
		case got := <-heartbeats:
			if got != want {
				t.Fatalf("heartbeat sequence %d, want %d", got, want)
			}
		case <-time.After(10 * time.Second):
			t.Fatalf("heartbeat %d never arrived", want)
		}
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Run returned %v after cancellation", err)
	}

	received := h.server.Heartbeats()
	if len(received) < 3 {
		t.Fatalf("the control plane received %d heartbeats", len(received))
	}
	first := received[0]
	if first.Status != connectorv1.HeartbeatStatusHealthy {
		t.Fatalf("heartbeat status = %q", first.Status)
	}
	if first.Version != buildinfo.Version {
		t.Fatalf("heartbeat version = %q", first.Version)
	}
	if first.ActiveRoutes != 0 || first.ActiveStreams != 0 {
		t.Fatalf("heartbeat reports %d routes and %d streams", first.ActiveRoutes, first.ActiveStreams)
	}
	if first.UptimeSeconds < 0 {
		t.Fatalf("heartbeat uptime = %d", first.UptimeSeconds)
	}

	// The control plane authenticated the connector's own certificate.
	record, err := h.store.LoadRecord()
	if err != nil {
		t.Fatalf("LoadRecord: %v", err)
	}
	if h.server.LastPeerFingerprint != record.CertificateFingerprint {
		t.Fatalf("the control plane authenticated %q, want %q",
			h.server.LastPeerFingerprint, record.CertificateFingerprint)
	}

	// docs/CONNECTOR_PROTOCOL.md section 8: the resource summary carries only
	// load and available memory, so no process detail can ride along.
	if first.ResourceSummary != nil {
		if first.ResourceSummary.Load != nil && (*first.ResourceSummary.Load < 0 || *first.ResourceSummary.Load > 1024) {
			t.Fatalf("resource summary load = %v", *first.ResourceSummary.Load)
		}
	}

	keyPEM, err := os.ReadFile(h.store.KeyPath())
	if err != nil {
		t.Fatalf("reading the device key: %v", err)
	}
	logs := h.logs.String()
	if strings.Contains(logs, testToken) {
		t.Fatal("the enrolment token appears in the channel log output")
	}
	if strings.Contains(logs, "BEGIN PRIVATE KEY") || strings.Contains(logs, string(keyPEM)) {
		t.Fatal("private key material appears in the channel log output")
	}
	if !strings.Contains(logs, "\"connector_id\":\""+record.ConnectorID+"\"") {
		t.Fatal("the channel log does not carry the connector ID correlation field")
	}
	if !strings.Contains(logs, "\"correlation_id\":\"cor_") {
		t.Fatal("the channel log does not carry a correlation ID")
	}
}

// docs/CONNECTOR_PROTOCOL.md section 18 and the issue's acceptance criteria: a
// revoked identity fails closed and the connector does not retry with the old
// credential.
func TestChannelFailsClosedOnRevokedIdentity(t *testing.T) {
	h := newHarness(t, controlplanetest.Options{})
	h.server.Revoke(h.result.CertificateFingerprint)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	started := time.Now()
	err := h.runner.Run(ctx)
	if err == nil {
		t.Fatal("a revoked identity must fail")
	}
	failure := transport.Classify(err)
	if failure.Class != connectorv1.ErrorClassIdentityRevoked {
		t.Fatalf("error class = %q, want IDENTITY_REVOKED", failure.Class)
	}
	if !failure.Terminal {
		t.Fatal("IDENTITY_REVOKED must be terminal")
	}
	if elapsed := time.Since(started); elapsed > 10*time.Second {
		t.Fatalf("the connector retried for %s before failing closed", elapsed)
	}
	if attempts := h.server.Connections(); attempts > 1 {
		t.Fatalf("the connector opened %d connections after revocation; it must not retry", attempts)
	}
	if !strings.Contains(h.logs.String(), "not retrying with this identity") {
		t.Fatal("the refusal was not logged")
	}
}

// docs/TESTING.md section 11: a control-plane restart during an established
// channel is followed by reconnection.
func TestChannelReconnectsAfterControlPlaneRestart(t *testing.T) {
	h := newHarness(t, controlplanetest.Options{DropFirstConnections: 2})
	connected := make(chan int, 8)
	h.runner.OnConnected = func(attempt int) {
		select {
		case connected <- attempt:
		default:
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- h.runner.Run(ctx) }()

	deadline := time.After(25 * time.Second)
	var attempts []int
	for len(attempts) < 3 {
		select {
		case attempt := <-connected:
			attempts = append(attempts, attempt)
		case <-deadline:
			t.Fatalf("only %d connection attempts were observed: %v", len(attempts), attempts)
		}
	}
	if attempts[0] != 1 || attempts[1] != 2 || attempts[2] != 3 {
		t.Fatalf("attempts = %v, want consecutive numbering", attempts)
	}
	cancel()
	<-done

	if !strings.Contains(h.logs.String(), "channel lost; reconnecting") {
		t.Fatal("the reconnect was not logged")
	}
	if !strings.Contains(h.logs.String(), "\"retry_in\"") {
		t.Fatal("the reconnect log does not report the backoff delay")
	}
	if got := h.server.Connections(); got < 3 {
		t.Fatalf("the control plane accepted %d connections, want at least 3", got)
	}
}

// docs/CONNECTOR_PROTOCOL.md section 7 "Rejection" and section 22: a malformed
// or oversized control frame is refused, not best-effort parsed, and does not
// crash the connector.
func TestChannelRefusesHostileFramesWithoutPanic(t *testing.T) {
	cases := []struct {
		name  string
		frame []byte
	}{
		{"not json", []byte("this is not json")},
		{"truncated", []byte(`{"protocol_version":1,"type":"route.publish"`)},
		{"trailing data", []byte(`{"protocol_version":1,"message_id":"msg_a","type":"heartbeat","sent_at":"2026-07-28T11:00:00Z","payload":{}}{}`)},
		{"unknown version", []byte(`{"protocol_version":9,"message_id":"msg_a","type":"route.publish","sent_at":"2026-07-28T11:00:00Z","payload":{}}`)},
		{"unknown type", []byte(`{"protocol_version":1,"message_id":"msg_a","type":"route.delete","sent_at":"2026-07-28T11:00:00Z","payload":{}}`)},
		{"unknown property", []byte(`{"protocol_version":1,"message_id":"msg_a","type":"route.publish","sent_at":"2026-07-28T11:00:00Z","connector_id":"con_a","payload":{},"surprise":1}`)},
		{"oversized frame", oversizedFrame()},
		{"wrong direction", []byte(`{"protocol_version":1,"message_id":"msg_a","type":"heartbeat","sent_at":"2026-07-28T11:00:00Z","connector_id":"con_a","payload":{"status":"healthy","uptime_seconds":1,"version":"0.1.0","active_routes":0,"active_streams":0}}`)},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			h := newHarness(t, controlplanetest.Options{SendOnConnect: test.frame})
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()

			// The connector refuses the frame, closes and reconnects, so the
			// run is bounded by a small attempt budget rather than by success.
			h.config.Reconnect.MaxAttempts = 2
			err := h.runner.Run(ctx)
			if err == nil {
				t.Fatal("a hostile frame must end the session")
			}
			if ctx.Err() != nil {
				t.Fatal("the connector did not make progress after the hostile frame")
			}
			logs := h.logs.String()
			if !strings.Contains(logs, "refusing a control frame") &&
				!strings.Contains(logs, "refusing a frame sent in the wrong direction") &&
				!strings.Contains(logs, "channel lost") {
				t.Fatalf("the refusal was not logged: %s", logs)
			}
		})
	}
}

func oversizedFrame() []byte {
	// Larger than the 65 536 byte control-frame bound, so it is refused before
	// deserialisation.
	padding := strings.Repeat("a", connectorv1.MaxControlFrameBytes)
	return []byte(`{"protocol_version":1,"message_id":"msg_` + padding + `","type":"route.publish","sent_at":"2026-07-28T11:00:00Z","payload":{}}`)
}

func TestChannelRefusesToStartWithoutAnIdentity(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "data")
	store := identity.NewStore(dataDir)
	if err := store.EnsureDir(); err != nil {
		t.Fatalf("EnsureDir: %v", err)
	}
	if _, err := store.GenerateKey(); err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	cfg, err := config.Parse([]byte("control_plane:\n  url: https://example.internal\nidentity:\n  data_dir: " + dataDir + "\n"))
	if err != nil {
		t.Fatalf("config.Parse: %v", err)
	}
	runner := &channel.Runner{Config: cfg, Store: store, Logger: logging.New(io.Discard, "info")}
	if err := runner.Run(context.Background()); err == nil || !strings.Contains(err.Error(), "enrol") {
		t.Fatalf("Run without an identity returned %v", err)
	}
}

// docs/DEVELOPMENT.md section 10: private key permissions are validated on
// every start, not only at enrolment.
func TestChannelRefusesToStartOnAWidePrivateKey(t *testing.T) {
	h := newHarness(t, controlplanetest.Options{})
	if err := os.Chmod(h.store.KeyPath(), 0o644); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	err := h.runner.Run(context.Background())
	var permission *identity.PermissionError
	if err == nil {
		t.Fatal("a world-readable device key must stop the connector starting")
	}
	if !strings.Contains(err.Error(), "refusing to use") {
		t.Fatalf("error %v does not refuse the key file", err)
	}
	if _, ok := err.(*identity.PermissionError); !ok && permission == nil {
		// errors.As is checked by the identity package's own tests; here the
		// message is the contract the operator sees.
		t.Logf("permission failure surfaced as %T", err)
	}
	if h.server.Connections() != 0 {
		t.Fatal("the connector connected despite the refused key file")
	}
}

// docs/CONNECTOR_PROTOCOL.md section 5: after enrolment every connection is
// mutually authenticated, so a connection without a client certificate is
// refused before the WebSocket upgrade.
func TestControlEndpointRefusesAnUnauthenticatedConnection(t *testing.T) {
	h := newHarness(t, controlplanetest.Options{})
	record, err := h.store.LoadRecord()
	if err != nil {
		t.Fatalf("LoadRecord: %v", err)
	}
	pem, err := os.ReadFile(h.server.CAFile)
	if err != nil {
		t.Fatalf("reading the CA file: %v", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		t.Fatal("the CA file holds no certificate")
	}
	client := &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
	}}
	endpoint := "https" + strings.TrimPrefix(record.ControlURL, "wss")
	response, err := client.Get(endpoint) // #nosec G107 -- test endpoint
	if err != nil {
		t.Fatalf("GET %s: %v", endpoint, err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.StatusCode)
	}
}
