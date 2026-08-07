package gatewayhttp

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// The gateway control API's authority, and the durability of a withdrawal
// (RVP-76, ADR-0038).

// The reported exploit, run through the whole gateway: publish, browse,
// revoke, browse, re-register the same identifier and alias, and present the
// capability that was already revoked.
//
// Before the fix the last step answered 200 with the development server's body,
// because the revocation was the route's absence and registering the identifier
// again undid it.
func TestARevokedCapabilityStaysRevokedWhenItsRouteIsRegisteredAgain(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})
	capability := h.mint(testRouteID, testProjectID, testSessionID, time.Hour)

	carried := h.browse(browserRequest{capability: capability})
	if body := readBody(t, carried); !strings.Contains(body, "hello from the development server") {
		t.Fatalf("the route was not carrying traffic to begin with: %s", body)
	}
	h.recorded()

	revocation := h.adminRequest(http.MethodDelete, "/internal/v1/routes/"+testRouteID)
	if revocation.StatusCode != http.StatusOK {
		t.Fatalf("revoke: %s", readBody(t, revocation))
	}
	_ = readBody(t, revocation)

	assertCode(t, h.browse(browserRequest{capability: capability}),
		http.StatusNotFound, CodePublishedServiceUnavailable)

	// Re-registration under the same identifier is designed behaviour
	// (docs/DOMAIN_MODEL.md section 10), so it must succeed. The fix is not
	// forbidding it.
	h.clock.advance(time.Minute)
	again := h.publish(h.defaultRegistration())
	if again.StatusCode != http.StatusOK {
		t.Fatalf("the route identifier could not be registered again: %s", readBody(t, again))
	}
	_ = readBody(t, again)

	// The proof. A fresh capability works, so the route really is carrying
	// traffic again and this is not a route-level 404 in disguise.
	fresh := h.browse(browserRequest{capability: h.mint(testRouteID, testProjectID, testSessionID, time.Hour)})
	if body := readBody(t, fresh); !strings.Contains(body, "hello from the development server") {
		t.Fatalf("the re-registered route is not carrying traffic: %s", body)
	}
	h.recorded()

	assertCode(t, h.browse(browserRequest{capability: capability}),
		http.StatusForbidden, CodeRouteExpired)
	h.settle()
	if !strings.Contains(h.logs.String(), "capability_revoked") {
		t.Fatalf("the refusal was not recorded as a revocation:\n%s", h.logs.String())
	}
}

// The same for a connector revocation: ending a connector withdraws the
// capabilities its routes had outstanding, and re-enrolling the identifier does
// not bring them back.
func TestConnectorRevocationWithdrawsTheCapabilitiesItsRoutesHeld(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})
	capability := h.mint(testRouteID, testProjectID, testSessionID, time.Hour)

	response := h.adminRequest(http.MethodDelete, "/internal/v1/connectors/"+testConnectorID)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("revoke connector: %s", readBody(t, response))
	}
	_ = readBody(t, response)

	h.clock.advance(time.Minute)
	h.connect(testConnectorID, h.authority.ConnectorCertificate(t, testConnectorID), "")
	if again := h.publish(h.defaultRegistration()); again.StatusCode != http.StatusOK {
		t.Fatalf("republish after re-enrolment: %s", readBody(t, again))
	}

	assertCode(t, h.browse(browserRequest{capability: capability}),
		http.StatusForbidden, CodeRouteExpired)
}

// Expiry withdraws too, so a route that ran out and was published again under
// the same identifier does not honour the old credential either.
func TestExpiryWithdrawsTheCapabilitiesTheRouteHeld(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})
	capability := h.mint(testRouteID, testProjectID, testSessionID, 8*time.Hour)

	h.clock.advance(2 * time.Hour)
	if expired, _ := h.gateway.Sweep(h.clock.Now()); expired != 1 {
		t.Fatalf("the sweep expired %d routes, want 1", expired)
	}
	if again := h.publish(h.defaultRegistration()); again.StatusCode != http.StatusOK {
		t.Fatalf("republish after expiry: %s", readBody(t, again))
	}
	assertCode(t, h.browse(browserRequest{capability: capability}),
		http.StatusForbidden, CodeRouteExpired)
}

// Enumeration carries the caller's tenancy. An unscoped credential used to hand
// back every route in the deployment, across every organisation.
func TestEnumerationIsBoundedByTheCredentialsOrganisation(t *testing.T) {
	// A credential that acts for one organisation only.
	scoped := ControlCredential{
		ID:            "tenant",
		Secret:        strings.Repeat("s", 40),
		Operations:    []ControlOperation{OperationRouteRead, OperationRouteRevoke},
		Organisations: []string{testOrgID},
	}
	h := newHarness(t, harnessOptions{extraCredentials: ControlCredentials{scoped}})
	h.publish(RegisterRequest{})
	other := h.defaultRegistration()
	other.RouteID, other.PublicAlias = "svc_test_02", "svc-test-02"
	other.OrganisationID, other.ProjectID = "org_test_02", "prj_test_02"
	if response := h.publish(other); response.StatusCode != http.StatusOK {
		t.Fatalf("publish the second organisation's route: %s", readBody(t, response))
	}

	listed := h.listRoutesAs(scoped.Secret)
	if len(listed) != 1 {
		t.Fatalf("an organisation-scoped enumeration returned %d routes, want 1", len(listed))
	}
	if listed[0].RouteID != testRouteID || listed[0].OrganisationID != testOrgID {
		t.Fatalf("the enumeration returned %+v", listed[0])
	}

	// The deployment's own control plane still sees both.
	if all := h.listRoutesAs(testAdminToken); len(all) != 2 {
		t.Fatalf("the unbounded credential saw %d routes, want 2", len(all))
	}

	// A foreign identifier is absent rather than found-and-refused
	// (docs/API.md section 5).
	assertCode(t, h.adminRequestAs(scoped.Secret, http.MethodGet, "/internal/v1/routes/svc_test_02"),
		http.StatusNotFound, CodePublishedServiceUnavailable)
	assertCode(t, h.adminRequestAs(scoped.Secret, http.MethodDelete, "/internal/v1/routes/svc_test_02"),
		http.StatusNotFound, CodePublishedServiceUnavailable)
	if _, live := h.gateway.Routes().Lookup("svc_test_02"); !live {
		t.Fatal("another organisation's route was revoked by a scoped credential")
	}
}

// A credential may not register a route into an organisation it does not act
// for, and it may not plant one and then read it back.
func TestRegistrationIsBoundedByTheCredentialsOrganisation(t *testing.T) {
	scoped := ControlCredential{
		ID:            "tenant",
		Secret:        strings.Repeat("s", 40),
		Operations:    []ControlOperation{OperationRouteRegister, OperationRouteRead},
		Organisations: []string{"org_test_09"},
	}
	h := newHarness(t, harnessOptions{extraCredentials: ControlCredentials{scoped}})

	assertCode(t, h.registerAs(scoped.Secret, h.defaultRegistration()),
		http.StatusForbidden, CodeAuthorisationDenied)
	if _, live := h.gateway.Routes().Lookup(testRouteID); live {
		t.Fatal("a route was registered into an organisation the credential may not act for")
	}

	// The same credential may register into the organisation it does act for.
	own := h.defaultRegistration()
	own.OrganisationID = "org_test_09"
	if response := h.registerAs(scoped.Secret, own); response.StatusCode != http.StatusOK {
		t.Fatalf("the credential could not register into its own organisation: %s", readBody(t, response))
	}
}

// The MCP process's credential. ADR-0021 says it "holds no connector channel
// and registers no route; it withdraws" — this is that sentence as authority
// rather than as restraint.
func TestTheWithdrawOnlyCredentialCannotRegisterOrEnumerate(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})
	capability := h.mint(testRouteID, testProjectID, testSessionID, time.Hour)

	registration := h.defaultRegistration()
	registration.RouteID, registration.PublicAlias = "svc_test_03", "svc-test-03"
	assertCode(t, h.registerAs(testWithdrawToken, registration),
		http.StatusForbidden, CodeAuthorisationDenied)
	if _, live := h.gateway.Routes().Lookup("svc_test_03"); live {
		t.Fatal("the withdraw-only credential registered a route")
	}

	assertCode(t, h.adminRequestAs(testWithdrawToken, http.MethodGet, "/internal/v1/routes"),
		http.StatusForbidden, CodeAuthorisationDenied)
	assertCode(t, h.adminRequestAs(testWithdrawToken, http.MethodGet, "/metrics"),
		http.StatusForbidden, CodeAuthorisationDenied)
	assertCode(t, h.adminRequestAs(testWithdrawToken, http.MethodDelete,
		"/internal/v1/connectors/"+testConnectorID), http.StatusForbidden, CodeAuthorisationDenied)

	// And it can do the one thing ADR-0021 gave it the credential for.
	withdrawal := h.adminRequestAs(testWithdrawToken, http.MethodDelete,
		"/internal/v1/capabilities/cap_"+testRouteID+"_"+testSessionID)
	if withdrawal.StatusCode != http.StatusOK {
		t.Fatalf("the withdraw-only credential could not withdraw: %s", readBody(t, withdrawal))
	}
	_ = readBody(t, withdrawal)
	assertCode(t, h.browse(browserRequest{capability: capability}),
		http.StatusForbidden, CodeRouteExpired)
}

// A credential granted only reads may not revoke, and a credential granted only
// revocation may not read. The two are separate grants and not one "admin".
func TestOperationsAreGrantedSeparately(t *testing.T) {
	readOnly := ControlCredential{
		ID: "reader", Secret: strings.Repeat("r", 40),
		Operations: []ControlOperation{OperationRouteRead},
	}
	revokeOnly := ControlCredential{
		ID: "revoker", Secret: strings.Repeat("v", 40),
		Operations: []ControlOperation{OperationRouteRevoke},
	}
	h := newHarness(t, harnessOptions{
		extraCredentials: ControlCredentials{readOnly, revokeOnly},
	})
	h.publish(RegisterRequest{})

	assertCode(t, h.adminRequestAs(readOnly.Secret, http.MethodDelete, "/internal/v1/routes/"+testRouteID),
		http.StatusForbidden, CodeAuthorisationDenied)
	if _, live := h.gateway.Routes().Lookup(testRouteID); !live {
		t.Fatal("a read-only credential revoked a route")
	}

	assertCode(t, h.adminRequestAs(revokeOnly.Secret, http.MethodGet, "/internal/v1/routes"),
		http.StatusForbidden, CodeAuthorisationDenied)
	response := h.adminRequestAs(revokeOnly.Secret, http.MethodDelete, "/internal/v1/routes/"+testRouteID)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("the revoke credential could not revoke: %s", readBody(t, response))
	}
	_ = readBody(t, response)
}

// Every control action names the credential that made it. With one shared token
// this record could not have existed.
func TestControlActionsAreAttributedToACredential(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.publish(RegisterRequest{})
	_ = readBody(t, h.adminRequestAs(testWithdrawToken, http.MethodDelete,
		"/internal/v1/routes/"+testRouteID))
	_ = readBody(t, h.adminRequestAs("a-secret-nothing-here-recognises-0000", http.MethodGet,
		"/internal/v1/routes"))

	records := h.auditRecords(EventControlAction)
	if len(records) < 3 {
		t.Fatalf("recorded %d control actions, want at least 3", len(records))
	}

	want := []struct{ credential, operation, outcome string }{
		{"api", string(OperationRouteRegister), "allowed"},
		{"mcp", string(OperationRouteRevoke), "allowed"},
		{"unknown", string(OperationRouteRead), "refused"},
	}
	for _, expected := range want {
		found := false
		for _, record := range records {
			if record.Payload["credential_id"] == expected.credential &&
				record.Payload["operation"] == expected.operation &&
				record.Payload["outcome"] == expected.outcome {
				found = true
			}
		}
		if !found {
			encoded, _ := json.Marshal(records)
			t.Fatalf("no audit record for %+v: %s", expected, encoded)
		}
	}

	// The record says who, and never what they presented.
	encoded, err := json.Marshal(records)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	for name, secret := range map[string]string{
		"control plane secret": testAdminToken,
		"withdrawal secret":    testWithdrawToken,
	} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("the %s appears in an audit record", name)
		}
	}
}

// A refused operation is recorded as refused rather than not recorded at all.
func TestARefusedControlActionIsAudited(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	_ = readBody(t, h.adminRequestAs(testWithdrawToken, http.MethodGet, "/internal/v1/routes"))
	for _, record := range h.auditRecords(EventControlAction) {
		if record.Payload["credential_id"] == "mcp" &&
			record.Payload["outcome"] == "refused" &&
			record.Payload["reason"] == "operation_not_granted" {
			return
		}
	}
	t.Fatal("a refused control action produced no audit record naming the credential")
}
