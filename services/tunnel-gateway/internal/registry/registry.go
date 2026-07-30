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
	RouteID     string
	ProjectID   string
	ConnectorID string
	WorkspaceID string
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

	mu       sync.RWMutex
	byID     map[string]*Route
	byAlias  map[string]*Route
	revoked  map[string]time.Time
	streams  map[string]map[uint64]Terminator
	streamID atomic.Uint64
}

// New builds a registry. observer may be nil.
func New(config Config, observer Observer) *Registry {
	return &Registry{
		config:   config.withDefaults(),
		observer: observer,
		byID:     map[string]*Route{},
		byAlias:  map[string]*Route{},
		revoked:  map[string]time.Time{},
		streams:  map[string]map[uint64]Terminator{},
	}
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
		registration.RouteID, registration.ProjectID, registration.ConnectorID,
		registration.WorkspaceID, registration.PublicAlias,
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

// Routes lists every registered route, expired or not, for the admin API.
func (r *Registry) Routes() []*Route {
	r.mu.RLock()
	defer r.mu.RUnlock()
	routes := make([]*Route, 0, len(r.byID))
	for _, route := range r.byID {
		routes = append(routes, route)
	}
	return routes
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

// Revoke removes a route immediately and terminates every stream on it.
//
// It is the enforcement point for "revocable immediately"
// (docs/ARCHITECTURE.md section 7.3): a revocation that left an in-flight
// transfer running would only be a revocation of future requests.
func (r *Registry) Revoke(routeID string, reason LifecycleReason) (*Route, bool) {
	route, terminators := r.remove(routeID)
	if route == nil {
		return nil, false
	}
	switch reason {
	case ReasonExpired:
		route.Status = StatusExpired
	default:
		route.Status = StatusRevoked
	}
	r.mu.Lock()
	r.revoked[routeID] = r.config.Now()
	r.mu.Unlock()
	for _, terminate := range terminators {
		terminate(connectorv1.ErrorClassRouteExpired)
	}
	if r.observer != nil {
		r.observer.RouteEnded(route, reason)
	}
	return route, true
}

// RevokeConnector removes every route a connector carries. It is how connector
// revocation (docs/CONNECTOR_PROTOCOL.md section 18) reaches the tunnel.
func (r *Registry) RevokeConnector(connectorID string) []*Route {
	r.mu.RLock()
	identifiers := make([]string, 0, len(r.byID))
	for id, route := range r.byID {
		if route.ConnectorID == connectorID {
			identifiers = append(identifiers, id)
		}
	}
	r.mu.RUnlock()

	ended := make([]*Route, 0, len(identifiers))
	for _, id := range identifiers {
		if route, ok := r.Revoke(id, ReasonConnectorRevoked); ok {
			ended = append(ended, route)
		}
	}
	return ended
}

// ExpireDue removes every route whose expiry has passed and terminates their
// streams. The caller runs it on a ticker and records the events.
func (r *Registry) ExpireDue() []*Route {
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
	for _, id := range identifiers {
		if route, ok := r.Revoke(id, ReasonExpired); ok {
			expired = append(expired, route)
		}
	}
	return expired
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
func (r *Registry) RevokeCapability(capabilityID string, notAfter time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.revoked["cap:"+capabilityID] = notAfter
}

// CapabilityRevoked reports whether a capability identifier has been withdrawn.
func (r *Registry) CapabilityRevoked(capabilityID string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	_, revoked := r.revoked["cap:"+capabilityID]
	return revoked
}

// ForgetRevocations drops revocation records whose subject has expired anyway,
// so the set stays bounded.
func (r *Registry) ForgetRevocations(olderThan time.Time) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	dropped := 0
	for key, recorded := range r.revoked {
		if recorded.Before(olderThan) {
			delete(r.revoked, key)
			dropped++
		}
	}
	return dropped
}

// AuthorisesSession reports whether a browser session may use the route.
func (route *Route) AuthorisesSession(browserSessionID string) bool {
	for _, candidate := range route.AllowedBrowserSessionIDs {
		if candidate == browserSessionID {
			return true
		}
	}
	return false
}
