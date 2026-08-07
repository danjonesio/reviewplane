package registry

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
)

// The withdrawal set (RVP-76, ADR-0038).
//
// The defect these cover is not "revocation does not work". It did: the route
// went, and a request for it answered 404. The defect was that the route's
// absence *was* the revocation, so registering the identifier again brought
// back every capability that had been minted for it.

func claimsFor(routeID string, issuedAt time.Time) connectorv1.CapabilityClaims {
	return connectorv1.CapabilityClaims{
		KeyID:            "stage0-a",
		CapabilityID:     "cap_" + routeID,
		RouteID:          routeID,
		ProjectID:        "prj_a",
		BrowserSessionID: "brs_a",
		IssuedAt:         issuedAt.Unix(),
		ExpiresAt:        issuedAt.Add(time.Hour).Unix(),
	}
}

// A capability revoked with its route stays revoked when the route identifier
// is registered again. This is the reported exploit, at the layer that decides
// it: publish, revoke, re-register, present the original capability.
func TestReRegisteringARevokedRouteIdentifierResurrectsNoCapability(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	registry, _ := testRegistry(t, &now, 10)
	if _, rejection := registry.Register(registration(now)); rejection != nil {
		t.Fatalf("register: %v", rejection)
	}
	outstanding := claimsFor("svc_a", now)
	if registry.Withdrawn(outstanding) {
		t.Fatal("a live capability was reported as withdrawn")
	}

	now = now.Add(time.Minute)
	if _, err := registry.Revoke("svc_a", ReasonRevoked); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if !registry.Withdrawn(outstanding) {
		t.Fatal("revoking the route did not withdraw the capabilities it had outstanding")
	}

	// Re-registration under the same identifier is designed behaviour
	// (docs/DOMAIN_MODEL.md section 10), so it is allowed and must not restore
	// anything.
	now = now.Add(time.Minute)
	if _, rejection := registry.Register(registration(now)); rejection != nil {
		t.Fatalf("re-register: %v", rejection)
	}
	if _, ok := registry.LookupAlias("svc-a"); !ok {
		t.Fatal("re-registration was refused, which is not the fix this issue asks for")
	}
	if !registry.Withdrawn(outstanding) {
		t.Fatal("re-registering the route identifier resurrected a revoked capability")
	}
}

// The guard against the fix being undone: if Revoke stops recording the
// withdrawal, this fails. It asserts on the recorded set directly rather than
// only through a request, so removing the record is caught even if some other
// check happens to refuse the request that day.
func TestRevokeRecordsTheWithdrawalAndNotOnlyTheRouteRemoval(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	registry, _ := testRegistry(t, &now, 10)
	if _, rejection := registry.Register(registration(now)); rejection != nil {
		t.Fatalf("register: %v", rejection)
	}
	if _, err := registry.Revoke("svc_a", ReasonRevoked); err != nil {
		t.Fatalf("revoke: %v", err)
	}

	entries := registry.Revocations()
	if len(entries) != 1 {
		t.Fatalf("the withdrawal set holds %d entries, want 1", len(entries))
	}
	entry := entries[0]
	if entry.Kind != RevokeRouteSubject || entry.Subject != "svc_a" {
		t.Fatalf("recorded %q %q, want a route subject for svc_a", entry.Kind, entry.Subject)
	}
	if !entry.RevokedAt.Equal(now) {
		t.Fatalf("recorded the revocation at %s, want %s", entry.RevokedAt, now)
	}
	// The record must outlive every capability that could still be presented.
	// The gateway does not verify a capability's expiry against its route's —
	// that bound is applied by the control plane at minting — so the retention
	// is the gateway's own maximum route lifetime and not the route's expiry.
	if !entry.NotAfter.Equal(now.Add(8 * time.Hour)) {
		t.Fatalf("the record is kept until %s, want the maximum route lifetime from now (%s)",
			entry.NotAfter, now.Add(8*time.Hour))
	}
}

// A withdrawal outlives the route's own expiry, because a capability minted
// with a longer life than its route is something the gateway does not refuse on
// its own. Dropping the record at the route's expiry would reopen the exploit
// for exactly that capability.
func TestAWithdrawalOutlivesTheRouteItEnded(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	registry, _ := testRegistry(t, &now, 10)
	if _, rejection := registry.Register(registration(now)); rejection != nil {
		t.Fatalf("register: %v", rejection)
	}
	// The route expires in an hour; this credential claims four.
	overlong := claimsFor("svc_a", now)
	overlong.ExpiresAt = now.Add(4 * time.Hour).Unix()

	if _, err := registry.Revoke("svc_a", ReasonRevoked); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	now = now.Add(2 * time.Hour)
	registry.ForgetRevocations(now)

	if !registry.Withdrawn(overlong) {
		t.Fatal("the withdrawal was forgotten while the capability it refuses was still presentable")
	}
}

// A capability minted after the revocation instant is not one that revocation
// covered, so the recorded instant must not become a permanent ban on the
// identifier. This is what lets a route resume under the same identifier.
func TestAWithdrawalCoversTheCapabilitiesOutstandingWhenItWasMade(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	registry, _ := testRegistry(t, &now, 10)
	if _, rejection := registry.Register(registration(now)); rejection != nil {
		t.Fatalf("register: %v", rejection)
	}
	before := claimsFor("svc_a", now)

	now = now.Add(time.Minute)
	if _, err := registry.Revoke("svc_a", ReasonRevoked); err != nil {
		t.Fatalf("revoke: %v", err)
	}

	now = now.Add(time.Minute)
	if _, rejection := registry.Register(registration(now)); rejection != nil {
		t.Fatalf("re-register: %v", rejection)
	}
	after := claimsFor("svc_a", now)

	if !registry.Withdrawn(before) {
		t.Fatal("a capability outstanding at the revocation was admitted")
	}
	if registry.Withdrawn(after) {
		t.Fatal("a capability minted after the revocation was refused, which forbids resumption")
	}
}

// A capability minted in the same second as the revocation is refused. The
// comparison is at-or-before rather than strictly-before, because a second is
// wide enough to hold both and refusing is the only safe reading.
func TestAWithdrawalCoversTheSecondItWasMadeIn(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	registry, _ := testRegistry(t, &now, 10)
	if _, rejection := registry.Register(registration(now)); rejection != nil {
		t.Fatalf("register: %v", rejection)
	}
	if _, err := registry.Revoke("svc_a", ReasonRevoked); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if !registry.Withdrawn(claimsFor("svc_a", now)) {
		t.Fatal("a capability issued in the revocation's own second was admitted")
	}
}

// The withdrawal set is reloaded from the journal, so a gateway that starts
// again refuses what the one before it refused.
func TestTheWithdrawalSetIsReloadedFromTheJournal(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	path := filepath.Join(t.TempDir(), "revocations.jsonl")
	journal, err := NewFileJournal(path)
	if err != nil {
		t.Fatalf("open journal: %v", err)
	}

	first, _, _ := testRegistryWithJournal(t, &now, 10, journal)
	if _, rejection := first.Register(registration(now)); rejection != nil {
		t.Fatalf("register: %v", rejection)
	}
	outstanding := claimsFor("svc_a", now)
	if err := first.RevokeCapability("cap_other", now.Add(time.Hour)); err != nil {
		t.Fatalf("revoke capability: %v", err)
	}
	now = now.Add(time.Minute)
	if _, err := first.Revoke("svc_a", ReasonRevoked); err != nil {
		t.Fatalf("revoke: %v", err)
	}

	// A second gateway process reading the same journal. Nothing in memory
	// crosses this line: the registry, its maps and its route set are new.
	reopened, err := NewFileJournal(path)
	if err != nil {
		t.Fatalf("reopen journal: %v", err)
	}
	second, _, _ := testRegistryWithJournal(t, &now, 10, reopened)
	if !second.Withdrawn(outstanding) {
		t.Fatal("a restarted gateway forgot a route revocation")
	}
	if !second.CapabilityRevoked("cap_other") {
		t.Fatal("a restarted gateway forgot a capability revocation")
	}
	// And the route itself is not restored: routes are the control plane's to
	// re-register, and a gateway that resurrected them from its own file would
	// carry traffic nobody had asked it to carry.
	if _, live := second.Lookup("svc_a"); live {
		t.Fatal("the journal restored a route as well as a revocation")
	}
}

// failingJournal refuses to write, which is the case where the gateway must not
// claim a revocation it cannot keep.
type failingJournal struct {
	appended int
}

func (j *failingJournal) Load() ([]Revocation, error) { return nil, nil }
func (j *failingJournal) Append(Revocation) error {
	j.appended++
	return errors.New("journal: disk is full")
}
func (j *failingJournal) Compact([]Revocation) error { return nil }

func TestARevocationThatCannotBeRecordedIsNotPerformed(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	journal := &failingJournal{}
	registry, observer, _ := testRegistryWithJournal(t, &now, 10, journal)
	if _, rejection := registry.Register(registration(now)); rejection != nil {
		t.Fatalf("register: %v", rejection)
	}

	route, err := registry.Revoke("svc_a", ReasonRevoked)
	if err == nil {
		t.Fatal("a revocation that could not be recorded was reported as done")
	}
	if !errors.Is(err, ErrJournalUnwritable) {
		t.Fatalf("error %v, want an unwritable journal", err)
	}
	if route != nil {
		t.Fatal("a route was returned for a revocation that did not happen")
	}
	// Nothing moved: the route is still carried, which is the honest state for
	// a caller that has to retry.
	if _, live := registry.Lookup("svc_a"); !live {
		t.Fatal("the route was removed even though the withdrawal was not recorded")
	}
	if len(observer.ended) != 0 {
		t.Fatalf("lifecycle reasons %v, want none", observer.ended)
	}
	if err := registry.RevokeCapability("cap_a", now.Add(time.Hour)); err == nil {
		t.Fatal("a capability revocation that could not be recorded was reported as done")
	}
	if registry.CapabilityRevoked("cap_a") {
		t.Fatal("an unrecorded capability revocation was held in memory only")
	}
}

// The set is pruned by what it can still refuse and not by how old it is, and
// the journal is rewritten to match so that a restart does not reload what was
// dropped.
func TestForgettingIsBoundedByTheRecordAndCompactsTheJournal(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	path := filepath.Join(t.TempDir(), "revocations.jsonl")
	journal, err := NewFileJournal(path)
	if err != nil {
		t.Fatalf("open journal: %v", err)
	}
	registry, _, _ := testRegistryWithJournal(t, &now, 10, journal)

	if err := registry.RevokeCapability("cap_short", now.Add(time.Minute)); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if err := registry.RevokeCapability("cap_long", now.Add(4*time.Hour)); err != nil {
		t.Fatalf("revoke: %v", err)
	}

	// An hour on, only the short one can be forgotten — and it is forgotten
	// because nothing can present it, not because the record is an hour old.
	if dropped := registry.ForgetRevocations(now.Add(time.Hour)); dropped != 1 {
		t.Fatalf("forgot %d records, want 1", dropped)
	}
	if registry.CapabilityRevoked("cap_short") {
		t.Fatal("a record that could still be needed was kept")
	}
	if !registry.CapabilityRevoked("cap_long") {
		t.Fatal("a record that is still needed was dropped")
	}

	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read journal: %v", err)
	}
	if strings.Contains(string(contents), "cap_short") {
		t.Fatal("the journal still holds a forgotten record, so a restart would reload it")
	}
	if !strings.Contains(string(contents), "cap_long") {
		t.Fatal("compaction dropped a record that is still needed")
	}
}

// A journal line the gateway cannot parse is skipped rather than fatal: a torn
// write must not keep the deployment down.
func TestAPartialJournalLineIsSkippedAndTheRestSurvives(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	path := filepath.Join(t.TempDir(), "revocations.jsonl")
	journal, err := NewFileJournal(path)
	if err != nil {
		t.Fatalf("open journal: %v", err)
	}
	registry, _, _ := testRegistryWithJournal(t, &now, 10, journal)
	if err := registry.RevokeCapability("cap_a", now.Add(time.Hour)); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatalf("open journal for a torn write: %v", err)
	}
	if _, err := file.WriteString(`{"kind":"capability","subj`); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	reopened, err := NewFileJournal(path)
	if err != nil {
		t.Fatalf("reopen journal: %v", err)
	}
	second, _, _ := testRegistryWithJournal(t, &now, 10, reopened)
	if !second.CapabilityRevoked("cap_a") {
		t.Fatal("a complete record was lost because a later line was torn")
	}
}

// Revocation reaches the streams a route is already carrying, and it does so
// after the withdrawal is recorded rather than instead of it.
func TestRecordingTheWithdrawalDoesNotDelayTerminatingStreams(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	registry, _ := testRegistry(t, &now, 10)
	if _, rejection := registry.Register(registration(now)); rejection != nil {
		t.Fatalf("register: %v", rejection)
	}
	terminated := make(chan connectorv1.ErrorClass, 1)
	if _, err := registry.AttachStream("svc_a", func(class connectorv1.ErrorClass) {
		terminated <- class
	}); err != nil {
		t.Fatalf("attach: %v", err)
	}
	if _, err := registry.Revoke("svc_a", ReasonRevoked); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	select {
	case class := <-terminated:
		if class != connectorv1.ErrorClassRouteExpired {
			t.Fatalf("the stream was terminated with %q", class)
		}
	default:
		t.Fatal("revocation did not reach the in-flight stream")
	}
}

// Enumeration and revocation carry the caller's tenancy (ADR-0038).
func TestOrganisationScopeBoundsEnumerationAndRevocation(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	registry, _ := testRegistry(t, &now, 10)

	mine := registration(now)
	if _, rejection := registry.Register(mine); rejection != nil {
		t.Fatalf("register: %v", rejection)
	}
	theirs := registration(now)
	theirs.RouteID, theirs.PublicAlias = "svc_b", "svc-b"
	theirs.OrganisationID, theirs.ConnectorID = "org_b", "con_b"
	if _, rejection := registry.Register(theirs); rejection != nil {
		t.Fatalf("register: %v", rejection)
	}

	scope := OrganisationScope{Organisations: []string{"org_a"}}
	listed := registry.RoutesIn(scope)
	if len(listed) != 1 || listed[0].RouteID != "svc_a" {
		t.Fatalf("an organisation-scoped enumeration returned %d routes", len(listed))
	}
	if _, found := registry.LookupIn("svc_b", scope); found {
		t.Fatal("a route outside the scope was readable")
	}
	if _, err := registry.RevokeIn("svc_b", ReasonRevoked, scope); !errors.Is(err, ErrRouteNotRegistered) {
		t.Fatalf("a route outside the scope was revocable: %v", err)
	}
	if _, live := registry.Lookup("svc_b"); !live {
		t.Fatal("another organisation's route was ended")
	}

	ended, err := registry.RevokeConnector("con_b", scope)
	if err != nil {
		t.Fatalf("revoke connector: %v", err)
	}
	if len(ended) != 0 {
		t.Fatalf("an organisation-scoped connector revocation ended %d foreign routes", len(ended))
	}
	if organisations := registry.ConnectorOrganisations("con_b"); len(organisations) != 1 ||
		organisations[0] != "org_b" {
		t.Fatalf("connector organisations %v", organisations)
	}
}
