package registry

import (
	"errors"
	"net/netip"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/policy"
)

// Unit layer (docs/TESTING.md section 2): expiry arithmetic, limits and the
// alias mapping, all of which the request path depends on being exact.

type recorder struct {
	registered []*Route
	ended      []LifecycleReason
	rejected   []*Rejection
}

func (r *recorder) RouteRegistered(route *Route)                { r.registered = append(r.registered, route) }
func (r *recorder) RouteEnded(_ *Route, reason LifecycleReason) { r.ended = append(r.ended, reason) }
func (r *recorder) RouteRejected(_ Registration, x *Rejection)  { r.rejected = append(r.rejected, x) }

func testRegistry(t *testing.T, now *time.Time, maxRoutes int) (*Registry, *recorder) {
	t.Helper()
	registry, observer, _ := testRegistryWithJournal(t, now, maxRoutes, nil)
	return registry, observer
}

// testRegistryWithJournal builds a registry over a real on-disk journal unless
// one is supplied, so the ordinary unit tests exercise the durable path rather
// than a memory-only shortcut nothing ships with.
func testRegistryWithJournal(t *testing.T, now *time.Time, maxRoutes int, journal Journal) (*Registry, *recorder, Journal) {
	t.Helper()
	observer := &recorder{}
	if journal == nil {
		file, err := NewFileJournal(filepath.Join(t.TempDir(), "revocations.jsonl"))
		if err != nil {
			t.Fatalf("open journal: %v", err)
		}
		journal = file
	}
	registry, err := New(Config{
		Policy: policy.Policy{
			AllowedHosts:     []netip.Addr{netip.MustParseAddr("127.0.0.1")},
			AllowedPorts:     []policy.PortRange{{Low: 3000, High: 5999}},
			AllowedProtocols: []connectorv1.DestinationProtocol{connectorv1.DestinationProtocolHTTP},
		},
		MaxRoutesPerConnector: maxRoutes,
		MaxRouteTTL:           8 * time.Hour,
		Journal:               journal,
		Now:                   func() time.Time { return *now },
	}, observer)
	if err != nil {
		t.Fatalf("build registry: %v", err)
	}
	return registry, observer, journal
}

func registration(now time.Time) Registration {
	return Registration{
		RouteID:                  "svc_a",
		OrganisationID:           "org_a",
		ProjectID:                "prj_a",
		ConnectorID:              "con_a",
		WorkspaceID:              "wsp_a",
		PublicAlias:              "svc-a",
		LocalHost:                "127.0.0.1",
		LocalPort:                5173,
		Protocol:                 connectorv1.DestinationProtocolHTTP,
		Scope:                    ScopeBrowserSession,
		ExpiresAt:                now.Add(time.Hour),
		AllowedBrowserSessionIDs: []string{"brs_a"},
		ObservedDestination:      "127.0.0.1:5173",
	}
}

func TestARegisteredRouteResolvesThroughItsAlias(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	registry, observer := testRegistry(t, &now, 10)
	route, rejection := registry.Register(registration(now))
	if rejection != nil {
		t.Fatalf("register: %v", rejection)
	}
	if route.Status != StatusReady {
		t.Fatalf("status %q", route.Status)
	}
	if len(observer.registered) != 1 {
		t.Fatal("the observer was not told about the registration")
	}
	if _, ok := registry.LookupAlias("svc-a"); !ok {
		t.Fatal("the alias does not resolve")
	}
	if _, ok := registry.LookupAlias("svc-b"); ok {
		t.Fatal("an unregistered alias resolved")
	}
}

func TestARouteIsUnreachableTheInstantItExpires(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	registry, _ := testRegistry(t, &now, 10)
	if _, rejection := registry.Register(registration(now)); rejection != nil {
		t.Fatalf("register: %v", rejection)
	}

	now = now.Add(time.Hour - time.Nanosecond)
	if _, ok := registry.LookupAlias("svc-a"); !ok {
		t.Fatal("the route expired early")
	}
	now = now.Add(time.Nanosecond)
	if _, ok := registry.LookupAlias("svc-a"); ok {
		t.Fatal("the route was reachable at its expiry instant")
	}
}

func TestExpiringSweepsTerminateStreamsAndRecordTheReason(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	registry, observer := testRegistry(t, &now, 10)
	if _, rejection := registry.Register(registration(now)); rejection != nil {
		t.Fatalf("register: %v", rejection)
	}
	terminated := make(chan connectorv1.ErrorClass, 1)
	if _, err := registry.AttachStream("svc_a", func(class connectorv1.ErrorClass) {
		terminated <- class
	}); err != nil {
		t.Fatalf("attach: %v", err)
	}

	now = now.Add(2 * time.Hour)
	expired, err := registry.ExpireDue()
	if err != nil {
		t.Fatalf("expire: %v", err)
	}
	if len(expired) != 1 || expired[0].Status != StatusExpired {
		t.Fatalf("expired %d routes", len(expired))
	}
	select {
	case class := <-terminated:
		if class != connectorv1.ErrorClassRouteExpired {
			t.Fatalf("the stream was terminated with %q", class)
		}
	default:
		t.Fatal("an in-flight stream was not terminated by expiry")
	}
	if len(observer.ended) != 1 || observer.ended[0] != ReasonExpired {
		t.Fatalf("lifecycle reasons %v", observer.ended)
	}
}

func TestRevocationTerminatesStreamsAndReportsRevoked(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	registry, observer := testRegistry(t, &now, 10)
	if _, rejection := registry.Register(registration(now)); rejection != nil {
		t.Fatalf("register: %v", rejection)
	}
	terminated := make(chan connectorv1.ErrorClass, 1)
	if _, err := registry.AttachStream("svc_a", func(class connectorv1.ErrorClass) {
		terminated <- class
	}); err != nil {
		t.Fatalf("attach: %v", err)
	}
	route, err := registry.Revoke("svc_a", ReasonRevoked)
	if err != nil || route.Status != StatusRevoked {
		t.Fatalf("the route was not revoked: %v", err)
	}
	select {
	case <-terminated:
	default:
		t.Fatal("revocation did not reach the in-flight stream")
	}
	if len(observer.ended) != 1 || observer.ended[0] != ReasonRevoked {
		t.Fatalf("lifecycle reasons %v", observer.ended)
	}
	if _, err := registry.Revoke("svc_a", ReasonRevoked); !errors.Is(err, ErrRouteNotRegistered) {
		t.Fatalf("a route was revoked twice: %v", err)
	}
}

func TestTheRouteLimitIsPerConnector(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	registry, _ := testRegistry(t, &now, 2)
	for index := 0; index < 2; index++ {
		entry := registration(now)
		entry.RouteID = "svc_" + string(rune('a'+index))
		entry.PublicAlias = "svc-" + string(rune('a'+index))
		if _, rejection := registry.Register(entry); rejection != nil {
			t.Fatalf("register %d: %v", index, rejection)
		}
	}
	entry := registration(now)
	entry.RouteID = "svc_c"
	entry.PublicAlias = "svc-c"
	_, rejection := registry.Register(entry)
	if rejection == nil || rejection.Reason != RejectRouteLimit {
		t.Fatalf("rejection %v, want the route limit", rejection)
	}

	// Another connector still has its own budget.
	entry.ConnectorID = "con_b"
	if _, rejection := registry.Register(entry); rejection != nil {
		t.Fatalf("a second connector was refused: %v", rejection)
	}
}

func TestRegistrationRefusals(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name   string
		mutate func(*Registration)
		want   RejectionReason
	}{
		{"missing project", func(r *Registration) { r.ProjectID = "" }, RejectMissingIdentifier},
		{"missing organisation", func(r *Registration) { r.OrganisationID = "" }, RejectMissingIdentifier},
		{"missing connector", func(r *Registration) { r.ConnectorID = "" }, RejectMissingIdentifier},
		{"alias with an underscore", func(r *Registration) { r.PublicAlias = "svc_a" }, RejectAliasInvalid},
		{"alias too long", func(r *Registration) { r.PublicAlias = strings.Repeat("a", MaxAliasLength+1) }, RejectAliasInvalid},
		{"no browser session", func(r *Registration) { r.AllowedBrowserSessionIDs = nil }, RejectNoSession},
		{"expiry in the past", func(r *Registration) { r.ExpiresAt = now.Add(-time.Minute) }, RejectExpiryInPast},
		{"expiry beyond the maximum", func(r *Registration) { r.ExpiresAt = now.Add(9 * time.Hour) }, RejectExpiryTooDistant},
		{"link-local destination", func(r *Registration) { r.LocalHost = "169.254.10.1" }, RejectDestination},
		{"unsupported scope", func(r *Registration) { r.Scope = "organisation" }, RejectScopeUnsupported},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			registry, observer := testRegistry(t, &now, 10)
			entry := registration(now)
			testCase.mutate(&entry)
			_, rejection := registry.Register(entry)
			if rejection == nil {
				t.Fatal("the registration was accepted")
			}
			if rejection.Reason != testCase.want {
				t.Fatalf("reason %q, want %q", rejection.Reason, testCase.want)
			}
			if len(observer.rejected) != 1 {
				t.Fatal("the refusal was not reported to the observer")
			}
		})
	}
}

func TestAnAliasCannotBeRegisteredTwice(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	registry, _ := testRegistry(t, &now, 10)
	if _, rejection := registry.Register(registration(now)); rejection != nil {
		t.Fatalf("register: %v", rejection)
	}
	entry := registration(now)
	entry.RouteID = "svc_b"
	_, rejection := registry.Register(entry)
	if rejection == nil || rejection.Reason != RejectAliasTaken {
		t.Fatalf("rejection %v, want the alias to be taken", rejection)
	}
}

func TestConnectorRevocationEndsEveryRouteItCarries(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	registry, _ := testRegistry(t, &now, 10)
	for index := 0; index < 2; index++ {
		entry := registration(now)
		entry.RouteID = "svc_" + string(rune('a'+index))
		entry.PublicAlias = "svc-" + string(rune('a'+index))
		if _, rejection := registry.Register(entry); rejection != nil {
			t.Fatalf("register: %v", rejection)
		}
	}
	other := registration(now)
	other.RouteID, other.PublicAlias, other.ConnectorID = "svc_c", "svc-c", "con_b"
	if _, rejection := registry.Register(other); rejection != nil {
		t.Fatalf("register: %v", rejection)
	}

	ended, err := registry.RevokeConnector("con_a", OrganisationScope{})
	if err != nil {
		t.Fatalf("revoke connector: %v", err)
	}
	if len(ended) != 2 {
		t.Fatalf("revoked %d routes, want 2", len(ended))
	}
	if _, ok := registry.Lookup("svc_c"); !ok {
		t.Fatal("another connector's route was revoked too")
	}
}

func TestCapabilityRevocationIsRememberedAndBounded(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	registry, _ := testRegistry(t, &now, 10)
	if err := registry.RevokeCapability("cap_a", now.Add(30*time.Minute)); err != nil {
		t.Fatalf("revoke capability: %v", err)
	}
	if !registry.CapabilityRevoked("cap_a") {
		t.Fatal("a revoked capability was not remembered")
	}
	if registry.CapabilityRevoked("cap_b") {
		t.Fatal("an unrevoked capability was reported as revoked")
	}
	if dropped := registry.ForgetRevocations(now.Add(time.Hour)); dropped != 1 {
		t.Fatalf("forgot %d revocations, want 1", dropped)
	}
	if registry.CapabilityRevoked("cap_a") {
		t.Fatal("the revocation set is not bounded")
	}
}

func TestDNSLabelValidation(t *testing.T) {
	for _, valid := range []string{"a", "svc-a", "svc-01k9g3zj", "0", "abc"} {
		if !IsDNSLabel(valid) {
			t.Fatalf("%q was refused", valid)
		}
	}
	for _, invalid := range []string{
		"", "-a", "a-", "A", "svc_a", "svc.a", "svc a", "svc/a", "café",
		strings.Repeat("a", MaxAliasLength+1), string(make([]byte, 8)),
	} {
		if IsDNSLabel(invalid) {
			t.Fatalf("%q was accepted", invalid)
		}
	}
	// A label of exactly the maximum length is accepted.
	maximum := strings.Repeat("a", MaxAliasLength)
	if !IsDNSLabel(maximum) {
		t.Fatal("a label of the maximum length was refused")
	}
	if IsDNSLabel(maximum + "a") {
		t.Fatal("a label beyond the maximum length was accepted")
	}
}

func TestASessionMustBeNamedOnTheRoute(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	registry, _ := testRegistry(t, &now, 10)
	entry := registration(now)
	entry.AllowedBrowserSessionIDs = []string{"brs_a", "brs_b"}
	route, rejection := registry.Register(entry)
	if rejection != nil {
		t.Fatalf("register: %v", rejection)
	}
	if !route.AuthorisesSession("brs_a") || !route.AuthorisesSession("brs_b") {
		t.Fatal("a named session was not authorised")
	}
	if route.AuthorisesSession("brs_c") {
		t.Fatal("an unnamed session was authorised")
	}
}

func TestByteAndStreamCountersAccumulate(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	registry, _ := testRegistry(t, &now, 10)
	route, rejection := registry.Register(registration(now))
	if rejection != nil {
		t.Fatalf("register: %v", rejection)
	}
	handle, err := registry.AttachStream("svc_a", func(connectorv1.ErrorClass) {})
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	registry.RecordBytes("svc_a", 120, 3400)
	toDestination, fromDestination, opened, active := route.Counters()
	if toDestination != 120 || fromDestination != 3400 || opened != 1 || active != 1 {
		t.Fatalf("counters %d %d %d %d", toDestination, fromDestination, opened, active)
	}
	registry.DetachStream("svc_a", handle)
	if _, _, _, active := route.Counters(); active != 0 {
		t.Fatalf("active streams %d after detaching", active)
	}
}

func TestDestinationRenderingHandlesIPv6(t *testing.T) {
	route := &Route{Registration: Registration{LocalHost: "::1", LocalPort: 5173}}
	if route.Destination() != "[::1]:5173" {
		t.Fatalf("destination %q", route.Destination())
	}
}
