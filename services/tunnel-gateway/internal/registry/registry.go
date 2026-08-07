// Package registry holds the routes the gateway will carry traffic for, and
// nothing it will not.
//
// The published service of docs/DOMAIN_MODEL.md section 10 is the authoritative
// record and lives in the control plane's database. This is the gateway's
// working copy of the subset it must enforce: the destination, the project, the
// browser sessions authorised for it, the expiry and the alias the internal
// origin resolves through. Every route property of docs/ARCHITECTURE.md
// section 7.3 has its enforcement point here or in the request path that reads
// from here.
//
// A route is never inferred. If the control plane has not registered it, the
// gateway does not carry it, which is what keeps docs/ARCHITECTURE.md section
// 4.6's "must not become an unrestricted proxy" a property of the design rather
// than of the configuration.
package registry

import (
	"errors"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/policy"
)

// Status mirrors the published-service status of docs/DOMAIN_MODEL.md section
// 10. The gateway only ever holds a route in one of the last three: requested
// and failed belong to the publication exchange, which the control plane owns.
type Status string

const (
	StatusRequested Status = "requested"
	StatusReady     Status = "ready"
	StatusFailed    Status = "failed"
	StatusExpired   Status = "expired"
	StatusRevoked   Status = "revoked"
)

// ScopeBrowserSession is the Stage 0 value of the published service's scope
// field: the route is usable only by the browser sessions named on it.
const ScopeBrowserSession = "browser_session"

// MaxAliasLength is the DNS label bound. The alias is the leftmost label of the
// internal origin, so it cannot be longer than a label may be.
const MaxAliasLength = 63

// Registration is a route the control plane asks the gateway to carry.
type Registration struct {
	RouteID string
	// OrganisationID is the tenancy the route belongs to. The gateway does not
	// resolve organisations and never infers one; it is carried so that a
	// control credential scoped to an organisation can be held to it
	// (docs/SECURITY.md section 9, ADR-0038). A registration without one is
	// refused rather than treated as belonging to everybody.
	OrganisationID string
	ProjectID      string
	ConnectorID    string
	WorkspaceID    string
	// PublicAlias is the leftmost label of the internal origin
	// (docs/DOMAIN_MODEL.md section 10). It is a DNS label, so it cannot be the
	// route identifier when that identifier carries an underscore.
	PublicAlias string
	LocalHost   string
	LocalPort   int
	Protocol    connectorv1.DestinationProtocol
	Scope       string
	ExpiresAt   time.Time
	// AllowedBrowserSessionIDs must name at least one session
	// (docs/CONNECTOR_PROTOCOL.md section 11): a route no session may use is
	// not published.
	AllowedBrowserSessionIDs []string
	// ObservedDestination is what the connector reported it opened, from the
	// route.publish.ack. The gateway records it so that a mismatch between the
	// requested and the opened destination is visible in an audit trail.
	ObservedDestination string
}

// Route is a registered route and its running totals.
type Route struct {
	Registration
	Status       Status
	RegisteredAt time.Time

	bytesToDestination   atomic.Int64
	bytesFromDestination atomic.Int64
	streamsOpened        atomic.Int64
	streamsActive        atomic.Int64
}

// Counters reports the route's running totals.
func (r *Route) Counters() (toDestination, fromDestination, opened, active int64) {
	return r.bytesToDestination.Load(), r.bytesFromDestination.Load(),
		r.streamsOpened.Load(), r.streamsActive.Load()
}

// Destination renders the upstream as host:port, as the acknowledgement of
// docs/CONNECTOR_PROTOCOL.md section 11 does.
func (r *Route) Destination() string {
	if strings.Contains(r.LocalHost, ":") {
		return "[" + r.LocalHost + "]:" + strconv.Itoa(r.LocalPort)
	}
	return r.LocalHost + ":" + strconv.Itoa(r.LocalPort)
}

// LifecycleReason classifies why a route left the registry. It is the reason
// code the audit event carries; the wire reports only ROUTE_EXPIRED, because
// docs/CONNECTOR_PROTOCOL.md section 21 is a closed vocabulary and extending it
// needs an ADR.
type LifecycleReason string

const (
	ReasonExpired          LifecycleReason = "expired"
	ReasonRevoked          LifecycleReason = "revoked"
	ReasonConnectorRevoked LifecycleReason = "connector_revoked"
)

// RejectionReason classifies a refused registration.
type RejectionReason string

const (
	RejectAliasInvalid      RejectionReason = "public_alias_is_not_a_dns_label"
	RejectAliasTaken        RejectionReason = "public_alias_already_registered"
	RejectRouteTaken        RejectionReason = "route_already_registered"
	RejectNoSession         RejectionReason = "no_browser_session_authorised"
	RejectTooManySessions   RejectionReason = "too_many_browser_sessions"
	RejectExpiryInPast      RejectionReason = "expiry_is_not_in_the_future"
	RejectExpiryTooDistant  RejectionReason = "expiry_exceeds_the_maximum_route_lifetime"
	RejectRouteLimit        RejectionReason = "connector_route_limit_exceeded"
	RejectDestination       RejectionReason = "destination_not_allowed"
	RejectMissingIdentifier RejectionReason = "identifier_missing"
	RejectScopeUnsupported  RejectionReason = "scope_not_supported"
)

// Rejection reports a refused registration and the stable wire class for it.
type Rejection struct {
	Reason RejectionReason
	Class  connectorv1.ErrorClass
	// PolicyReason is set when the destination policy refused, so that the
	// audit trail records which control fired.
	PolicyReason policy.Reason
}

func (r *Rejection) Error() string {
	if r == nil {
		return "<nil>"
	}
	if r.PolicyReason != "" {
		return "registry: registration refused: " + string(r.Reason) + ": " + string(r.PolicyReason)
	}
	return "registry: registration refused: " + string(r.Reason)
}

// Config bounds the registry.
type Config struct {
	// Policy is the destination allow-list applied at registration.
	Policy policy.Policy
	// MaxRoutesPerConnector mirrors the connector's own max_routes
	// (docs/CONNECTOR_PROTOCOL.md section 20). Both sides enforce it.
	MaxRoutesPerConnector int
	// MaxRouteTTL bounds how far ahead a route may expire
	// (docs/CONFIGURATION.md section 4, route_ttl_max).
	MaxRouteTTL time.Duration
	// MaxBrowserSessionsPerRoute mirrors the schema's maxItems on
	// allowed_browser_session_ids.
	MaxBrowserSessionsPerRoute int
	// Journal makes the withdrawal set survive a restart. It may be nil, and a
	// nil journal is a gateway whose revocations last only as long as the
	// process — which is what RVP-76 recorded as the defect, so the shipped
	// deployment configures one and New reports the difference to its caller.
	Journal Journal
	// Now supplies the clock so that expiry arithmetic is testable.
	Now func() time.Time
}

func (c Config) withDefaults() Config {
	if c.MaxRoutesPerConnector <= 0 {
		c.MaxRoutesPerConnector = 10
	}
	if c.MaxRouteTTL <= 0 {
		c.MaxRouteTTL = 8 * time.Hour
	}
	if c.MaxBrowserSessionsPerRoute <= 0 {
		c.MaxBrowserSessionsPerRoute = 32
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	return c
}

// Terminator ends one in-flight stream with a stable error class. The request
// path registers one per stream so that revocation and expiry reach traffic
// that is already moving, which is what docs/SECURITY.md section 9's
// "immediate revocation" means in practice.
type Terminator func(connectorv1.ErrorClass)

// Observer receives route lifecycle transitions, so that the gateway can emit
// the docs/EVENTS.md section 7 published-service events and its metrics without
// the registry knowing about either.
type Observer interface {
	RouteRegistered(route *Route)
	RouteEnded(route *Route, reason LifecycleReason)
	RouteRejected(registration Registration, rejection *Rejection)
}

// Registry is the gateway's set of carryable routes.
type Registry struct {
	config   Config
	observer Observer

	journal Journal

	mu       sync.RWMutex
	byID     map[string]*Route
	byAlias  map[string]*Route
	revoked  map[string]Revocation
	streams  map[string]map[uint64]Terminator
	streamID atomic.Uint64
}

// New builds a registry and reloads the withdrawal set from its journal.
//
// It returns an error rather than starting without the journal it was given: a
// gateway that came up unable to read what it had revoked would answer requests
// it has already refused once, and would do it silently.
func New(config Config, observer Observer) (*Registry, error) {
	registry := &Registry{
		config:   config.withDefaults(),
		observer: observer,
		journal:  config.Journal,
		byID:     map[string]*Route{},
		byAlias:  map[string]*Route{},
		revoked:  map[string]Revocation{},
		streams:  map[string]map[uint64]Terminator{},
	}
	if registry.journal != nil {
		entries, err := registry.journal.Load()
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			registry.revoked[entry.Key()] = entry
		}
	}
	return registry, nil
}

// Register validates and admits a route.
func (r *Registry) Register(registration Registration) (*Route, *Rejection) {
	rejection := r.validate(registration)
	if rejection != nil {
		if r.observer != nil {
			r.observer.RouteRejected(registration, rejection)
		}
		return nil, rejection
	}

	route := &Route{
		Registration: registration,
		Status:       StatusReady,
		RegisteredAt: r.config.Now(),
	}
	r.mu.Lock()
	if _, exists := r.byID[registration.RouteID]; exists {
		r.mu.Unlock()
		rejection = &Rejection{Reason: RejectRouteTaken, Class: connectorv1.ErrorClassRouteLimitExceeded}
		if r.observer != nil {
			r.observer.RouteRejected(registration, rejection)
		}
		return nil, rejection
	}
	if _, exists := r.byAlias[registration.PublicAlias]; exists {
		r.mu.Unlock()
		rejection = &Rejection{Reason: RejectAliasTaken, Class: connectorv1.ErrorClassDestinationNotAllowed}
		if r.observer != nil {
			r.observer.RouteRejected(registration, rejection)
		}
		return nil, rejection
	}
	r.byID[route.RouteID] = route
	r.byAlias[route.PublicAlias] = route
	r.streams[route.RouteID] = map[uint64]Terminator{}
	r.mu.Unlock()

	if r.observer != nil {
		r.observer.RouteRegistered(route)
	}
	return route, nil
}

func (r *Registry) validate(registration Registration) *Rejection {
	for _, identifier := range []string{
		registration.RouteID, registration.OrganisationID, registration.ProjectID,
		registration.ConnectorID, registration.WorkspaceID, registration.PublicAlias,
	} {
		if strings.TrimSpace(identifier) == "" {
			return &Rejection{Reason: RejectMissingIdentifier, Class: connectorv1.ErrorClassProjectNotAuthorised}
		}
	}
	if registration.Scope != "" && registration.Scope != ScopeBrowserSession {
		return &Rejection{Reason: RejectScopeUnsupported, Class: connectorv1.ErrorClassProjectNotAuthorised}
	}
	if !IsDNSLabel(registration.PublicAlias) {
		return &Rejection{Reason: RejectAliasInvalid, Class: connectorv1.ErrorClassDestinationNotAllowed}
	}
	if len(registration.AllowedBrowserSessionIDs) == 0 {
		return &Rejection{Reason: RejectNoSession, Class: connectorv1.ErrorClassProjectNotAuthorised}
	}
	if len(registration.AllowedBrowserSessionIDs) > r.config.MaxBrowserSessionsPerRoute {
		return &Rejection{Reason: RejectTooManySessions, Class: connectorv1.ErrorClassProjectNotAuthorised}
	}
	now := r.config.Now()
	if !registration.ExpiresAt.After(now) {
		return &Rejection{Reason: RejectExpiryInPast, Class: connectorv1.ErrorClassRouteExpired}
	}
	if registration.ExpiresAt.Sub(now) > r.config.MaxRouteTTL {
		return &Rejection{Reason: RejectExpiryTooDistant, Class: connectorv1.ErrorClassRouteExpired}
	}
	if rejection := r.config.Policy.Evaluate(policy.Destination{
		Host:     registration.LocalHost,
		Port:     registration.LocalPort,
		Protocol: registration.Protocol,
	}); rejection != nil {
		return &Rejection{
			Reason:       RejectDestination,
			Class:        rejection.Class,
			PolicyReason: rejection.Reason,
		}
	}

	r.mu.RLock()
	count := 0
	for _, route := range r.byID {
		if route.ConnectorID == registration.ConnectorID {
			count++
		}
	}
	r.mu.RUnlock()
	if count >= r.config.MaxRoutesPerConnector {
		return &Rejection{Reason: RejectRouteLimit, Class: connectorv1.ErrorClassRouteLimitExceeded}
	}
	return nil
}

// IsDNSLabel reports whether a value may be the leftmost label of the internal
// origin. The mapping from origin to route must be injective and total, so an
// alias that a resolver would normalise differently is refused at registration
// rather than guessed at request time.
func IsDNSLabel(candidate string) bool {
	if len(candidate) == 0 || len(candidate) > MaxAliasLength {
		return false
	}
	if candidate[0] == '-' || candidate[len(candidate)-1] == '-' {
		return false
	}
	for index := 0; index < len(candidate); index++ {
		character := candidate[index]
		switch {
		case character >= 'a' && character <= 'z':
		case character >= '0' && character <= '9':
		case character == '-':
		default:
			return false
		}
	}
	return true
}

// LookupAlias resolves an internal-origin label to a live route.
//
// A route past its expiry is not returned, so a sweeper that has not run yet
// cannot leave an expired route reachable.
func (r *Registry) LookupAlias(alias string) (*Route, bool) {
	r.mu.RLock()
	route, ok := r.byAlias[alias]
	r.mu.RUnlock()
	if !ok {
		return nil, false
	}
	if !r.config.Now().Before(route.ExpiresAt) {
		return nil, false
	}
	return route, true
}

// Lookup resolves a route identifier to a live route.
func (r *Registry) Lookup(routeID string) (*Route, bool) {
	r.mu.RLock()
	route, ok := r.byID[routeID]
	r.mu.RUnlock()
	if !ok || !r.config.Now().Before(route.ExpiresAt) {
		return nil, false
	}
	return route, true
}

// Routes lists every registered route, expired or not.
//
// It is the gateway's own view — the metrics gauges and the sweep — and carries
// no tenancy term. Nothing serves it to a caller: the admin surface reads
// RoutesIn, which takes the caller's scope.
func (r *Registry) Routes() []*Route {
	return r.RoutesIn(OrganisationScope{})
}

// RoutesIn lists the registered routes an organisation scope admits.
//
// Enumeration is where an unscoped credential did the most damage: a listing
// with no tenancy term hands every organisation's routes, aliases, destinations
// and connector identifiers to any holder of the token (ADR-0038).
func (r *Registry) RoutesIn(scope OrganisationScope) []*Route {
	r.mu.RLock()
	defer r.mu.RUnlock()
	routes := make([]*Route, 0, len(r.byID))
	for _, route := range r.byID {
		if !scope.Admits(route.OrganisationID) {
			continue
		}
		routes = append(routes, route)
	}
	return routes
}

// LookupIn resolves a route identifier inside a scope. A route outside the
// scope is absent rather than found-and-refused, which is docs/API.md section
// 5's rule that a foreign identifier and an unknown one are indistinguishable.
func (r *Registry) LookupIn(routeID string, scope OrganisationScope) (*Route, bool) {
	route, found := r.Lookup(routeID)
	if !found || !scope.Admits(route.OrganisationID) {
		return nil, false
	}
	return route, true
}

// AttachStream registers a terminator for one in-flight stream and returns the
// handle that detaches it.
func (r *Registry) AttachStream(routeID string, terminate Terminator) (uint64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	route, ok := r.byID[routeID]
	if !ok {
		return 0, errors.New("registry: route is not registered")
	}
	handle := r.streamID.Add(1)
	r.streams[routeID][handle] = terminate
	route.streamsOpened.Add(1)
	route.streamsActive.Add(1)
	return handle, nil
}

// DetachStream removes a terminator once its stream has finished.
func (r *Registry) DetachStream(routeID string, handle uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if streams, ok := r.streams[routeID]; ok {
		delete(streams, handle)
	}
	if route, ok := r.byID[routeID]; ok {
		route.streamsActive.Add(-1)
	}
}

// RecordBytes accumulates a route's transfer totals.
func (r *Registry) RecordBytes(routeID string, toDestination, fromDestination int64) {
	r.mu.RLock()
	route, ok := r.byID[routeID]
	r.mu.RUnlock()
	if !ok {
		return
	}
	route.bytesToDestination.Add(toDestination)
	route.bytesFromDestination.Add(fromDestination)
}

// routeRevocationNotAfter is how long a route's withdrawal has to be kept.
//
// The obvious answer — the route's own expiry, because a capability may not
// outlive its route (docs/ARCHITECTURE.md section 7.3) — is the control plane's
// rule at minting, not something the gateway verifies: the capability codec
// checks the token's own expiry and nothing compares it with the route's. So a
// record kept only to the route's expiry would be dropped while a capability
// minted with a longer life was still presentable, and re-registering the
// identifier would then work again. The configured maximum route lifetime is
// the gateway's own bound on how long anything here may live, so the record is
// kept for that long from the revocation, and never for less than the route's
// remaining life.
func routeRevocationNotAfter(expiresAt, revokedAt time.Time, maxRouteTTL time.Duration) time.Time {
	horizon := revokedAt.Add(maxRouteTTL)
	if expiresAt.After(horizon) {
		return expiresAt
	}
	return horizon
}

// ErrRouteNotRegistered reports a revocation of a route the gateway does not
// hold. It is not a failure: revocation is idempotent, and the control plane's
// record is authoritative either way.
var ErrRouteNotRegistered = errors.New("registry: no such route is registered")

// Revoke removes a route immediately, records the withdrawal durably, and
// terminates every stream on it.
//
// It is the enforcement point for "revocable immediately"
// (docs/ARCHITECTURE.md section 7.3): a revocation that left an in-flight
// transfer running would only be a revocation of future requests.
//
// The withdrawal is written down **before** the route is removed, which is the
// same ordering the control plane uses when it tells the gateway before it
// marks its own record closed. Removing the route first and failing to record
// the withdrawal would leave the gateway having forgotten a route it could be
// told to carry again, with nothing remembering that the capabilities minted
// for it are dead — which is exactly the defect this ordering exists to close.
// The route's absence is not the revocation; the recorded instant is.
func (r *Registry) Revoke(routeID string, reason LifecycleReason) (*Route, error) {
	return r.RevokeIn(routeID, reason, OrganisationScope{})
}

// RevokeIn revokes a route only if the scope admits its organisation. A route
// outside the scope is reported as absent, for the reason LookupIn gives.
func (r *Registry) RevokeIn(routeID string, reason LifecycleReason, scope OrganisationScope) (*Route, error) {
	r.mu.RLock()
	existing, known := r.byID[routeID]
	r.mu.RUnlock()
	if !known || !scope.Admits(existing.OrganisationID) {
		return nil, ErrRouteNotRegistered
	}

	now := r.config.Now().UTC()
	if err := r.record(Revocation{
		Kind:      RevokeRouteSubject,
		Subject:   routeID,
		RevokedAt: now,
		NotAfter:  routeRevocationNotAfter(existing.ExpiresAt.UTC(), now, r.config.MaxRouteTTL),
	}); err != nil {
		return nil, err
	}

	route, terminators := r.remove(routeID)
	if route == nil {
		// Another caller revoked it between the read and the removal. The
		// withdrawal is recorded either way, which is the outcome that matters.
		return nil, ErrRouteNotRegistered
	}
	switch reason {
	case ReasonExpired:
		route.Status = StatusExpired
	default:
		route.Status = StatusRevoked
	}
	for _, terminate := range terminators {
		terminate(connectorv1.ErrorClassRouteExpired)
	}
	if r.observer != nil {
		r.observer.RouteEnded(route, reason)
	}
	return route, nil
}

// RevokeConnector removes every route a connector carries. It is how connector
// revocation (docs/CONNECTOR_PROTOCOL.md section 18) reaches the tunnel.
//
// only, when non-empty, restricts the sweep to routes in those organisations,
// so that an organisation-scoped control credential cannot end another
// organisation's routes through a connector identifier (ADR-0038).
func (r *Registry) RevokeConnector(connectorID string, only OrganisationScope) ([]*Route, error) {
	r.mu.RLock()
	identifiers := make([]string, 0, len(r.byID))
	for id, route := range r.byID {
		if route.ConnectorID == connectorID && only.Admits(route.OrganisationID) {
			identifiers = append(identifiers, id)
		}
	}
	r.mu.RUnlock()

	ended := make([]*Route, 0, len(identifiers))
	for _, id := range identifiers {
		route, err := r.Revoke(id, ReasonConnectorRevoked)
		switch {
		case err == nil:
			ended = append(ended, route)
		case errors.Is(err, ErrRouteNotRegistered):
		default:
			return ended, err
		}
	}
	return ended, nil
}

// ConnectorOrganisations reports every organisation the gateway currently holds
// a route for on this connector. The gateway has no connector directory, so
// this is the only tenancy it can attribute a connector to.
func (r *Registry) ConnectorOrganisations(connectorID string) []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	seen := map[string]struct{}{}
	organisations := make([]string, 0, 1)
	for _, route := range r.byID {
		if route.ConnectorID != connectorID {
			continue
		}
		if _, already := seen[route.OrganisationID]; already {
			continue
		}
		seen[route.OrganisationID] = struct{}{}
		organisations = append(organisations, route.OrganisationID)
	}
	return organisations
}

// ExpireDue removes every route whose expiry has passed and terminates their
// streams. The caller runs it on a ticker and records the events.
func (r *Registry) ExpireDue() ([]*Route, error) {
	now := r.config.Now()
	r.mu.RLock()
	identifiers := make([]string, 0)
	for id, route := range r.byID {
		if !now.Before(route.ExpiresAt) {
			identifiers = append(identifiers, id)
		}
	}
	r.mu.RUnlock()

	expired := make([]*Route, 0, len(identifiers))
	var failure error
	for _, id := range identifiers {
		route, err := r.Revoke(id, ReasonExpired)
		switch {
		case err == nil:
			expired = append(expired, route)
		case errors.Is(err, ErrRouteNotRegistered):
		default:
			// An expired route is already unreachable — LookupAlias refuses one
			// past its expiry — so the sweep carries on and reports the fault
			// rather than stopping on it.
			if failure == nil {
				failure = err
			}
		}
	}
	return expired, failure
}

func (r *Registry) remove(routeID string) (*Route, []Terminator) {
	r.mu.Lock()
	defer r.mu.Unlock()
	route, ok := r.byID[routeID]
	if !ok {
		return nil, nil
	}
	delete(r.byID, routeID)
	delete(r.byAlias, route.PublicAlias)
	terminators := make([]Terminator, 0, len(r.streams[routeID]))
	for _, terminate := range r.streams[routeID] {
		terminators = append(terminators, terminate)
	}
	delete(r.streams, routeID)
	return route, terminators
}

// RevokeCapability records a single capability identifier as no longer usable.
//
// Revoking the route revokes every capability bound to it; this is the narrower
// case, where one browser session's access is withdrawn while the route stays
// up for the others named on it.
//
// notAfter is when the record may be forgotten, and must be at or after the
// capability's own expiry: a record dropped while the credential it refuses is
// still presentable is a revocation with a hole in it.
func (r *Registry) RevokeCapability(capabilityID string, notAfter time.Time) error {
	return r.record(Revocation{
		Kind:      RevokeCapabilitySubject,
		Subject:   capabilityID,
		RevokedAt: r.config.Now().UTC(),
		NotAfter:  notAfter.UTC(),
	})
}

// CapabilityRevoked reports whether a capability identifier has been withdrawn
// by identity. It answers the narrow question only; Withdrawn is what the
// request path asks.
func (r *Registry) CapabilityRevoked(capabilityID string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	_, revoked := r.revoked[capabilityKey(capabilityID)]
	return revoked
}

// Withdrawn reports whether an authenticated capability has been withdrawn,
// either by its own identity or with the route it belongs to.
//
// The claims must already have been verified: the route identifier and the
// issue instant it reads are signed, and reading either from an unauthenticated
// token would let a bearer choose which revocation applied to it.
func (r *Registry) Withdrawn(claims connectorv1.CapabilityClaims) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if _, revoked := r.revoked[capabilityKey(claims.CapabilityID)]; revoked {
		return true
	}
	entry, revoked := r.revoked[routeKey(claims.RouteID)]
	if !revoked {
		return false
	}
	// Issued at or before the route was revoked, so it was one of the
	// capabilities that revocation covered. Registering the route identifier
	// again does not change when this credential was minted.
	return claims.IssuedAt <= entry.RevokedAt.Unix()
}

// Revocations reports the withdrawal set, for the admin surface and for tests.
func (r *Registry) Revocations() []Revocation {
	r.mu.RLock()
	defer r.mu.RUnlock()
	entries := make([]Revocation, 0, len(r.revoked))
	for _, entry := range r.revoked {
		entries = append(entries, entry)
	}
	return entries
}

// ForgetRevocations drops withdrawal records that nothing can still present,
// so the set stays bounded, and compacts the journal to match.
//
// The test is the record's own NotAfter and not how long ago it was written: a
// capability lives until it expires, and a set pruned by age would forget a
// revocation while the credential it refuses was still usable.
func (r *Registry) ForgetRevocations(now time.Time) int {
	r.mu.Lock()
	dropped := 0
	surviving := make([]Revocation, 0, len(r.revoked))
	for key, entry := range r.revoked {
		if entry.NotAfter.After(now) {
			surviving = append(surviving, entry)
			continue
		}
		delete(r.revoked, key)
		dropped++
	}
	r.mu.Unlock()
	if dropped > 0 && r.journal != nil {
		// A compaction that fails leaves a journal holding more than the memory
		// does, which is safe: reloading it refuses more, never less.
		_ = r.journal.Compact(surviving)
	}
	return dropped
}

// record makes a withdrawal durable and then visible.
//
// The order is the property. Recording it in memory first and failing to write
// it would produce a gateway that refuses the credential until it restarts and
// then accepts it, which is worse than refusing the revocation outright,
// because nothing would ever say so.
func (r *Registry) record(entry Revocation) error {
	if r.journal != nil {
		if err := r.journal.Append(entry); err != nil {
			return errors.Join(ErrJournalUnwritable, err)
		}
	}
	r.mu.Lock()
	r.revoked[entry.Key()] = entry
	r.mu.Unlock()
	return nil
}

// OrganisationScope bounds an action to a set of organisations. The zero value
// admits every organisation and is what a deployment-wide credential carries.
type OrganisationScope struct {
	// Organisations is the allow-list. Empty means unbounded.
	Organisations []string
}

// Admits reports whether the scope covers an organisation.
func (s OrganisationScope) Admits(organisationID string) bool {
	if len(s.Organisations) == 0 {
		return true
	}
	for _, candidate := range s.Organisations {
		if candidate == organisationID {
			return true
		}
	}
	return false
}

// Unbounded reports whether the scope covers every organisation.
func (s OrganisationScope) Unbounded() bool { return len(s.Organisations) == 0 }

// AuthorisesSession reports whether a browser session may use the route.
func (route *Route) AuthorisesSession(browserSessionID string) bool {
	for _, candidate := range route.AllowedBrowserSessionIDs {
		if candidate == browserSessionID {
			return true
		}
	}
	return false
}
