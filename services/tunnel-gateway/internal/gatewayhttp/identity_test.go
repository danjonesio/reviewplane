package gatewayhttp

import (
	"crypto/tls"
	"strings"
	"testing"
	"time"

	"github.com/danjonesio/reviewplane/services/tunnel-gateway/internal/testca"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/internal/wsx"
)

// The connector data channel is mutually authenticated (docs/ARCHITECTURE.md
// section 11, docs/SECURITY.md section 15). These tests prove the gateway
// terminates a channel only for an identity that chains to the configured
// authority, and refuses one that does not.

func TestAChannelWithNoClientCertificateIsRefused(t *testing.T) {
	h := newHarness(t, harnessOptions{skipConnect: true})
	if _, err := h.dialConnector(tls.Certificate{}, ""); err == nil {
		t.Fatal("a channel with no client certificate was accepted")
	}
	if h.gateway.Channels().Count() != 0 {
		t.Fatal("the gateway recorded a channel for an unauthenticated connector")
	}
}

func TestAChannelSignedByAnotherAuthorityIsRefused(t *testing.T) {
	h := newHarness(t, harnessOptions{skipConnect: true})
	// A perfectly well-formed certificate, issued by an authority the gateway
	// was not configured with.
	other := testca.New(t, "someone-elses-ca")
	if _, err := h.dialConnector(other.ConnectorCertificate(t, testConnectorID), ""); err == nil {
		t.Fatal("a channel signed by another authority was accepted")
	}
	if h.gateway.Channels().Count() != 0 {
		t.Fatal("the gateway recorded a channel for an unverified identity")
	}
}

func TestAChannelClaimingAnotherIdentityIsRefused(t *testing.T) {
	// The certificate is valid, but the connector claims to be a different
	// connector. The transport decides, not the claim.
	h := newHarness(t, harnessOptions{skipConnect: true})
	_, err := h.dialConnector(h.authority.ConnectorCertificate(t, testConnectorID), "con_someone_else")
	if err == nil {
		t.Fatal("a channel claiming another identity was accepted")
	}
	if !strings.Contains(err.Error(), "403") {
		t.Fatalf("refused with %v, want a 403", err)
	}
	assertAudit(t, h, EventChannelRefused, "identity_mismatch")
}

func TestAChannelOnTheWrongPathIsRefused(t *testing.T) {
	// The data channel has one path. A connector that dials the control path
	// must not be handed a data session by accident.
	h := newHarness(t, harnessOptions{skipConnect: true})
	endpoint := "wss://" + strings.TrimPrefix(h.connector.URL, "https://") + "/connector/control"
	_, err := wsx.Dial(endpoint, &tls.Config{
		MinVersion:   tls.VersionTLS13,
		RootCAs:      h.authority.Pool(),
		Certificates: []tls.Certificate{h.authority.ConnectorCertificate(t, testConnectorID)},
	}, nil, wsx.Options{MaxMessageBytes: 1 << 10})
	if err == nil {
		t.Fatal("a data channel was opened on the control path")
	}
}

func TestIdentityCanBeReadFromAURISubjectAlternativeName(t *testing.T) {
	// The issuing side is being built separately. Making the identity source
	// configuration rather than a constant is what lets the two land
	// independently.
	prefix := "reviewplane:connector:"
	h := newHarness(t, harnessOptions{
		skipConnect: true,
		identity:    IdentityPolicy{Source: IdentityFromURISAN, URIPrefix: prefix},
	})
	h.connect(testConnectorID, h.authority.ConnectorCertificateWithURI(t, prefix, testConnectorID), "")
	h.publish(RegisterRequest{})
	response := h.browse(browserRequest{capability: h.defaultCapability()})
	if response.StatusCode != 200 {
		t.Fatalf("status %d: %s", response.StatusCode, readBody(t, response))
	}
	_ = readBody(t, response)
	h.recorded()
}

func TestACommonNameThatIsNotAnIdentifierIsRefused(t *testing.T) {
	h := newHarness(t, harnessOptions{skipConnect: true})
	// A common name carrying a value outside the schema's identifier character
	// class. Accepting it would let a certificate carry punctuation into a
	// route lookup.
	if _, err := h.dialConnector(h.authority.ConnectorCertificate(t, "con test/../.."), ""); err == nil {
		t.Fatal("a certificate with a non-identifier common name was accepted")
	}
}

func TestRoutesAreBoundToTheConnectorThatCarriesThem(t *testing.T) {
	// A route registered for one connector must not be served by another that
	// happens to be connected.
	h := newHarness(t, harnessOptions{})
	registration := h.defaultRegistration()
	registration.ConnectorID = "con_a_different_connector"
	h.publish(registration)
	assertCode(t, h.browse(browserRequest{capability: h.defaultCapability()}), 503, CodeConnectorOffline)
}

func assertAudit(t *testing.T, h *harness, eventType, reason string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, record := range h.gateway.Auditor().Records() {
			if record.Type != eventType {
				continue
			}
			if reason == "" {
				return
			}
			if value, ok := record.Payload["reason"].(string); ok && value == reason {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no %s audit record with reason %q: %v", eventType, reason, h.auditTypes())
}
