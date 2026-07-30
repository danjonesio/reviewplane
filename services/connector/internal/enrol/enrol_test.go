package enrol_test

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	connectorv1 "github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/connector/internal/buildinfo"
	"github.com/danjonesio/reviewplane/services/connector/internal/config"
	"github.com/danjonesio/reviewplane/services/connector/internal/controlplanetest"
	"github.com/danjonesio/reviewplane/services/connector/internal/enrol"
	"github.com/danjonesio/reviewplane/services/connector/internal/identity"
	"github.com/danjonesio/reviewplane/services/connector/internal/logging"
	"github.com/danjonesio/reviewplane/services/connector/internal/transport"
)

const testToken = "test-enrolment-token-0123456789"

func newConfig(t *testing.T, controlPlane, caFile, dataDir string) *config.Config {
	t.Helper()
	source := "control_plane:\n  url: " + controlPlane + "\n" +
		"  tls:\n    ca_file: " + caFile + "\n" +
		"identity:\n  data_dir: " + dataDir + "\n" +
		"heartbeat:\n  interval: 1s\n" +
		"reconnect:\n  initial_delay: 20ms\n  max_delay: 100ms\n" +
		"environment:\n  name: dev-ai-03\n  labels: [proxmox, development]\n"
	cfg, err := config.Parse([]byte(source))
	if err != nil {
		t.Fatalf("building test configuration: %v", err)
	}
	return cfg
}

func TestEnrolSuccess(t *testing.T) {
	server := controlplanetest.Start(t, controlplanetest.Options{Token: testToken})
	dataDir := filepath.Join(t.TempDir(), "data")
	cfg := newConfig(t, server.URL, server.CAFile, dataDir)

	var logs bytes.Buffer
	result, err := enrol.Run(context.Background(), enrol.Options{
		Config: cfg,
		Token:  connectorv1.EnrolmentToken(testToken),
		Logger: logging.New(&logs, "debug"),
	})
	if err != nil {
		t.Fatalf("enrol.Run: %v", err)
	}
	if !strings.HasPrefix(result.ConnectorID, "con_") {
		t.Fatalf("connector id %q", result.ConnectorID)
	}
	if result.ReusedKey {
		t.Fatal("a first enrolment must generate a key")
	}

	registrations := server.Registrations()
	if len(registrations) != 1 {
		t.Fatalf("the control plane received %d registrations", len(registrations))
	}
	request := registrations[0]

	// docs/CONNECTOR_PROTOCOL.md section 4.3: the request carries the public
	// key only, the environment descriptor and the connector descriptor.
	if request.PublicKey == "" {
		t.Fatal("the registration request carries no public key")
	}
	if request.Environment.Name != "dev-ai-03" {
		t.Fatalf("environment name = %q", request.Environment.Name)
	}
	if !slices.Contains(connectorv1.KnownPlatforms, request.Environment.Platform) {
		t.Fatalf("environment platform %q is not a known platform", request.Environment.Platform)
	}
	if !slices.Equal(request.Environment.Labels, []string{"proxmox", "development"}) {
		t.Fatalf("environment labels = %v", request.Environment.Labels)
	}
	if request.Connector.Version != buildinfo.Version {
		t.Fatalf("connector version = %q", request.Connector.Version)
	}
	for _, capability := range []string{"http-tunnel", "websocket-tunnel"} {
		if !slices.Contains(request.Connector.Capabilities, capability) {
			t.Fatalf("capabilities %v do not advertise %q", request.Connector.Capabilities, capability)
		}
	}

	// The private key never leaves the environment: it exists on disk with
	// owner-only permissions and appears in no wire field.
	store := identity.NewStore(dataDir)
	if err := store.CheckKeyPermissions(); err != nil {
		t.Fatalf("the stored key is not owner-only: %v", err)
	}
	keyPEM, err := os.ReadFile(store.KeyPath())
	if err != nil {
		t.Fatalf("reading the device key: %v", err)
	}
	block, _ := pem.Decode(keyPEM)
	if block == nil {
		t.Fatal("the device key is not PEM encoded")
	}
	if strings.Contains(request.PublicKey, string(block.Bytes)) {
		t.Fatal("the registration request carries private key material")
	}

	// The issued certificate is usable as a client identity.
	tlsCertificate, leaf, err := store.ClientCertificate()
	if err != nil {
		t.Fatalf("ClientCertificate: %v", err)
	}
	if len(tlsCertificate.Certificate) == 0 {
		t.Fatal("no client certificate was stored")
	}
	if leaf.Subject.CommonName != result.ConnectorID {
		t.Fatalf("certificate subject %q does not name the connector", leaf.Subject.CommonName)
	}
	if !slices.Contains(leaf.ExtKeyUsage, x509.ExtKeyUsageClientAuth) {
		t.Fatal("the issued certificate is not usable for client authentication")
	}
	if identity.Fingerprint(leaf.Raw) != result.CertificateFingerprint {
		t.Fatal("the recorded fingerprint does not match the stored certificate")
	}

	assertNoSecrets(t, logs.String(), testToken, string(keyPEM))
}

// docs/SECURITY.md section 18 and the issue's acceptance criteria: no enrolment
// token, private key or signed identity appears in any log output.
func assertNoSecrets(t *testing.T, logs, token, keyPEM string) {
	t.Helper()
	if logs == "" {
		t.Fatal("no log output was captured, so the assertion would be vacuous")
	}
	if strings.Contains(logs, token) {
		t.Fatal("the enrolment token appears in the log output")
	}
	for _, line := range strings.Split(strings.TrimSpace(keyPEM), "\n") {
		if strings.HasPrefix(line, "-----") || len(line) < 16 {
			continue
		}
		if strings.Contains(logs, line) {
			t.Fatal("private key material appears in the log output")
		}
	}
	if strings.Contains(logs, "BEGIN PRIVATE KEY") || strings.Contains(logs, "BEGIN CERTIFICATE") {
		t.Fatal("PEM material appears in the log output")
	}
}

// docs/CONNECTOR_PROTOCOL.md section 4.1 and docs/SECURITY.md section 6.2: the
// enrolment token is consumed on success and a second use is denied.
func TestEnrolReusedTokenIsDenied(t *testing.T) {
	server := controlplanetest.Start(t, controlplanetest.Options{Token: testToken, MaxUses: 1})
	logger := logging.New(&bytes.Buffer{}, "info")

	first := newConfig(t, server.URL, server.CAFile, filepath.Join(t.TempDir(), "first"))
	if _, err := enrol.Run(context.Background(), enrol.Options{
		Config: first, Token: connectorv1.EnrolmentToken(testToken), Logger: logger,
	}); err != nil {
		t.Fatalf("first enrolment: %v", err)
	}

	second := newConfig(t, server.URL, server.CAFile, filepath.Join(t.TempDir(), "second"))
	_, err := enrol.Run(context.Background(), enrol.Options{
		Config: second, Token: connectorv1.EnrolmentToken(testToken), Logger: logger, MaxAttempts: 3,
	})
	assertErrorClass(t, err, connectorv1.ErrorClassEnrolmentTokenInvalid, true)

	// A denial must not leave an identity behind.
	if identity.NewStore(second.Identity.DataDir).Enrolled() {
		t.Fatal("a denied enrolment left an identity record")
	}
}

func TestEnrolWrongTokenIsDenied(t *testing.T) {
	server := controlplanetest.Start(t, controlplanetest.Options{Token: testToken})
	cfg := newConfig(t, server.URL, server.CAFile, filepath.Join(t.TempDir(), "data"))
	_, err := enrol.Run(context.Background(), enrol.Options{
		Config: cfg,
		Token:  connectorv1.EnrolmentToken("a-token-that-was-never-issued"),
		Logger: logging.New(&bytes.Buffer{}, "info"),
	})
	assertErrorClass(t, err, connectorv1.ErrorClassEnrolmentTokenInvalid, true)
}

func TestEnrolExpiredOrOutOfScopeTokenIsDenied(t *testing.T) {
	// The control plane reports an expired or wrongly scoped token with the
	// same stable class, so the connector's handling is identical.
	server := controlplanetest.Start(t, controlplanetest.Options{
		RefuseEnrolmentWith: connectorv1.ErrorClassEnrolmentTokenInvalid,
	})
	cfg := newConfig(t, server.URL, server.CAFile, filepath.Join(t.TempDir(), "data"))
	_, err := enrol.Run(context.Background(), enrol.Options{
		Config: cfg, Token: connectorv1.EnrolmentToken(testToken),
		Logger: logging.New(&bytes.Buffer{}, "info"), MaxAttempts: 3,
	})
	assertErrorClass(t, err, connectorv1.ErrorClassEnrolmentTokenInvalid, true)
}

// docs/TESTING.md section 11: the control plane being unavailable at enrolment
// produces a clear CONTROL_PLANE_UNAVAILABLE and a bounded retry.
func TestEnrolControlPlaneUnavailable(t *testing.T) {
	server := controlplanetest.Start(t, controlplanetest.Options{Token: testToken})
	url, caFile := server.URL, server.CAFile
	server.Close()

	dataDir := filepath.Join(t.TempDir(), "data")
	cfg := newConfig(t, url, caFile, dataDir)
	var logs bytes.Buffer

	started := time.Now()
	_, err := enrol.Run(context.Background(), enrol.Options{
		Config: cfg, Token: connectorv1.EnrolmentToken(testToken),
		Logger: logging.New(&logs, "info"), MaxAttempts: 3,
	})
	if err == nil {
		t.Fatal("enrolment against an unreachable control plane must fail")
	}
	failure := transport.Classify(err)
	if failure.Class != connectorv1.ErrorClassControlPlaneUnavailable {
		t.Fatalf("error class = %q, want CONTROL_PLANE_UNAVAILABLE", failure.Class)
	}
	if failure.Terminal {
		t.Fatal("an unreachable control plane is not a terminal refusal")
	}
	if !strings.Contains(err.Error(), "after 3 attempts") {
		t.Fatalf("error %q does not report the bounded retry", err)
	}
	if elapsed := time.Since(started); elapsed > 30*time.Second {
		t.Fatalf("the bounded retry took %s", elapsed)
	}

	// Interrupted after key generation and before identity issuance: the key
	// exists, no identity does, and nothing was orphaned on the control plane.
	store := identity.NewStore(dataDir)
	if _, err := os.Stat(store.KeyPath()); err != nil {
		t.Fatalf("the device key should survive an interrupted enrolment: %v", err)
	}
	if store.Enrolled() {
		t.Fatal("an interrupted enrolment must not record an identity")
	}
}

// Retrying an interrupted enrolment reuses the device key and produces exactly
// one identity.
func TestEnrolRetryAfterInterruptionReusesTheKey(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "data")
	logger := logging.New(&bytes.Buffer{}, "info")

	dead := controlplanetest.Start(t, controlplanetest.Options{Token: testToken})
	deadURL, deadCA := dead.URL, dead.CAFile
	dead.Close()
	interrupted := newConfig(t, deadURL, deadCA, dataDir)
	if _, err := enrol.Run(context.Background(), enrol.Options{
		Config: interrupted, Token: connectorv1.EnrolmentToken(testToken),
		Logger: logger, MaxAttempts: 1,
	}); err == nil {
		t.Fatal("the interrupted attempt must fail")
	}
	store := identity.NewStore(dataDir)
	firstKey, err := store.LoadKey()
	if err != nil {
		t.Fatalf("reading the key left by the interrupted attempt: %v", err)
	}

	live := controlplanetest.Start(t, controlplanetest.Options{Token: testToken})
	retry := newConfig(t, live.URL, live.CAFile, dataDir)
	result, err := enrol.Run(context.Background(), enrol.Options{
		Config: retry, Token: connectorv1.EnrolmentToken(testToken), Logger: logger,
	})
	if err != nil {
		t.Fatalf("the retry must succeed: %v", err)
	}
	if !result.ReusedKey {
		t.Fatal("the retry must reuse the key the interrupted attempt generated")
	}
	if registrations := live.Registrations(); len(registrations) != 1 {
		t.Fatalf("the control plane received %d registrations, want exactly one", len(registrations))
	}
	secondKey, err := store.LoadKey()
	if err != nil {
		t.Fatalf("reading the key after the retry: %v", err)
	}
	if !firstKey.PublicKey.Equal(&secondKey.PublicKey) {
		t.Fatal("the retry replaced the device key")
	}
}

func TestEnrolRefusesToOverwriteAnIdentity(t *testing.T) {
	server := controlplanetest.Start(t, controlplanetest.Options{Token: testToken, MaxUses: 5})
	dataDir := filepath.Join(t.TempDir(), "data")
	cfg := newConfig(t, server.URL, server.CAFile, dataDir)
	logger := logging.New(&bytes.Buffer{}, "info")

	first, err := enrol.Run(context.Background(), enrol.Options{
		Config: cfg, Token: connectorv1.EnrolmentToken(testToken), Logger: logger,
	})
	if err != nil {
		t.Fatalf("first enrolment: %v", err)
	}

	_, err = enrol.Run(context.Background(), enrol.Options{
		Config: cfg, Token: connectorv1.EnrolmentToken(testToken), Logger: logger,
	})
	if !errors.Is(err, enrol.ErrAlreadyEnrolled) {
		t.Fatalf("second enrolment error = %v, want ErrAlreadyEnrolled", err)
	}

	// docs/CONNECTOR_PROTOCOL.md section 18: re-enrolment creates a new
	// connector identity, so --force generates a new key pair.
	store := identity.NewStore(dataDir)
	before, err := store.LoadKey()
	if err != nil {
		t.Fatalf("LoadKey: %v", err)
	}
	forced, err := enrol.Run(context.Background(), enrol.Options{
		Config: cfg, Token: connectorv1.EnrolmentToken(testToken), Logger: logger, Force: true,
	})
	if err != nil {
		t.Fatalf("forced re-enrolment: %v", err)
	}
	if forced.ConnectorID == first.ConnectorID {
		t.Fatal("re-enrolment must produce a new connector identity")
	}
	after, err := store.LoadKey()
	if err != nil {
		t.Fatalf("LoadKey after re-enrolment: %v", err)
	}
	if before.PublicKey.Equal(&after.PublicKey) {
		t.Fatal("re-enrolment must generate a new device key")
	}
}

func assertErrorClass(t *testing.T, err error, want connectorv1.ErrorClass, terminal bool) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected a failure with class %s", want)
	}
	failure := transport.Classify(err)
	if failure.Class != want {
		t.Fatalf("error class = %q, want %q (error: %v)", failure.Class, want, err)
	}
	if failure.Terminal != terminal {
		t.Fatalf("terminal = %v, want %v", failure.Terminal, terminal)
	}
}
