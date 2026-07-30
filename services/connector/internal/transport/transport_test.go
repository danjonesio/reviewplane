package transport

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	connectorv1 "github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/connector/internal/ws"
)

func TestNewTLSConfigRequiresVerification(t *testing.T) {
	config, err := NewTLSConfig(TLSOptions{})
	if err != nil {
		t.Fatalf("NewTLSConfig: %v", err)
	}
	// There is no setting that disables verification, so this must never be
	// true (docs/SECURITY.md section 5).
	if config.InsecureSkipVerify {
		t.Fatal("certificate verification was disabled")
	}
	if config.MinVersion < 0x0303 {
		t.Fatalf("MinVersion = %#x, want TLS 1.2 or later", config.MinVersion)
	}
}

func TestNewTLSConfigRejectsAnUnreadableTrustAnchor(t *testing.T) {
	_, err := NewTLSConfig(TLSOptions{CAFile: filepath.Join(t.TempDir(), "absent.pem")})
	if err == nil || !strings.Contains(err.Error(), "trust anchor") {
		t.Fatalf("error = %v", err)
	}
}

func TestNewTLSConfigRejectsANonCertificateTrustAnchor(t *testing.T) {
	path := filepath.Join(t.TempDir(), "not-a-certificate.pem")
	if err := os.WriteFile(path, []byte("this is not PEM"), 0o600); err != nil {
		t.Fatalf("writing fixture: %v", err)
	}
	_, err := NewTLSConfig(TLSOptions{CAFile: path})
	if err == nil || !strings.Contains(err.Error(), "no PEM certificate") {
		t.Fatalf("error = %v", err)
	}
}

// The refusal vocabulary on the wire is the generated section 21 enumeration,
// so a class added to the schema is recognised without a code change here.
func TestIsKnownErrorClassTracksTheSchema(t *testing.T) {
	for _, class := range connectorv1.ErrorClassValues {
		if !IsKnownErrorClass(string(class)) {
			t.Fatalf("%q is generated but not recognised", class)
		}
	}
	for _, text := range []string{"", "not a class", "identity_revoked", "IDENTITY REVOKED"} {
		if IsKnownErrorClass(text) {
			t.Fatalf("%q was recognised as an error class", text)
		}
	}
}

func TestClassifyTerminalRefusals(t *testing.T) {
	terminal := []connectorv1.ErrorClass{
		connectorv1.ErrorClassEnrolmentTokenInvalid,
		connectorv1.ErrorClassIdentityRevoked,
		connectorv1.ErrorClassProtocolUnsupported,
		connectorv1.ErrorClassUpgradeRequired,
	}
	for _, class := range terminal {
		failure := Classify(&ws.CloseError{Code: ws.ClosePolicyViolation, Reason: string(class)})
		if failure.Class != class {
			t.Fatalf("class = %q, want %q", failure.Class, class)
		}
		if !failure.Terminal {
			t.Fatalf("%s must be terminal", class)
		}
	}
}

func TestClassifyRetryableRefusals(t *testing.T) {
	cases := []error{
		&ws.CloseError{Code: ws.CloseAbnormal},
		&ws.CloseError{Code: ws.CloseNormalClosure, Reason: "restarting"},
		&ws.HandshakeError{StatusCode: 503, Status: "503 Service Unavailable"},
		errors.New("dial tcp: connection refused"),
	}
	for _, err := range cases {
		failure := Classify(err)
		if failure.Class != connectorv1.ErrorClassControlPlaneUnavailable {
			t.Fatalf("Classify(%v) class = %q", err, failure.Class)
		}
		if failure.Terminal {
			t.Fatalf("Classify(%v) must not be terminal", err)
		}
	}
}

func TestClassifyHandshakeRefusalCarryingAnErrorClass(t *testing.T) {
	failure := Classify(&ws.HandshakeError{
		StatusCode: 401,
		Status:     "401 Unauthorized",
		Body:       string(connectorv1.ErrorClassIdentityRevoked),
	})
	if failure.Class != connectorv1.ErrorClassIdentityRevoked || !failure.Terminal {
		t.Fatalf("failure = %+v", failure)
	}
}

func TestClassifyPassesThroughProtocolErrors(t *testing.T) {
	_, protocolErr := connectorv1.DecodeControlFrame([]byte(`{"protocol_version":7}`))
	if protocolErr == nil {
		t.Fatal("the decoder accepted an unsupported protocol version")
	}
	failure := Classify(protocolErr)
	if failure.Class != connectorv1.ErrorClassProtocolUnsupported {
		t.Fatalf("class = %q", failure.Class)
	}
}

func TestClassifyIsIdempotent(t *testing.T) {
	first := Classify(&ws.CloseError{Code: ws.ClosePolicyViolation, Reason: "IDENTITY_REVOKED"})
	second := Classify(first)
	if first != second {
		t.Fatal("Classify must return the same Failure when given one")
	}
	if Classify(nil) != nil {
		t.Fatal("Classify(nil) must be nil")
	}
}

func TestFailureUnwraps(t *testing.T) {
	inner := errors.New("inner")
	failure := &Failure{Class: connectorv1.ErrorClassIdentityRevoked, Err: inner}
	if !errors.Is(failure, inner) {
		t.Fatal("Failure must unwrap to its cause")
	}
	if !strings.HasPrefix(failure.Error(), "IDENTITY_REVOKED: ") {
		t.Fatalf("Error() = %q", failure.Error())
	}
}
