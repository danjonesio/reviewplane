package gatewayhttp

import (
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/danjonesio/reviewplane/services/tunnel-gateway/internal/metrics"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/internal/registry"
)

// errReplacedChannel ends a data channel that a newer channel for the same
// connector identity has replaced.
var errReplacedChannel = errors.New("gatewayhttp: connector opened a replacement data channel")

// Auditor records the gateway's security-relevant transitions.
//
// docs/SECURITY.md section 16 requires published-service lifecycle to be
// audited, and docs/EVENTS.md section 7 names the events:
// published_service.requested, .ready, .failed, .expired and .revoked. The
// durable event rows of docs/EVENTS.md section 2 are written by the control
// plane, which owns the database and the project event sequence; the gateway
// has neither. What the gateway owns is the moment a route actually stopped
// carrying traffic, so it emits the same event names as structured audit
// records, correlated by route identifier.
//
// The split is deliberate rather than a shortcut: giving the gateway a database
// connection would put the most exposed component inside the control plane's
// persistence boundary, which docs/SECURITY.md section 3 places on the other
// side of the trust line.
type Auditor interface {
	// RouteReady records a route the gateway has begun carrying.
	RouteReady(route *registry.Route)
	// RouteFailed records a registration the gateway refused.
	RouteFailed(registration registry.Registration, rejection *registry.Rejection)
	// RouteEnded records expiry or revocation.
	RouteEnded(route *registry.Route, reason registry.LifecycleReason)
	// ConnectorChannelOpened records a terminated data channel.
	ConnectorChannelOpened(connectorID, remote string)
	// ConnectorChannelClosed records a data channel ending.
	ConnectorChannelClosed(connectorID string, cause error)
	// ConnectorChannelRefused records an unauthenticated or wrong-identity
	// channel.
	ConnectorChannelRefused(reason, remote string)
	// RequestRefused records a browser request the gateway would not carry.
	RequestRefused(requestID, code, reason string)
	// ControlAction records one call on the gateway control API, and which
	// credential made it.
	//
	// docs/SECURITY.md section 16 requires an audit trail to say who did
	// something. While the control API took one shared token, this record could
	// not have existed: every call would have named the same principal, and
	// "which process registered this route" would have had no answer (ADR-0038).
	ControlAction(action ControlAction)
}

// ControlAction is one call on the gateway control API.
type ControlAction struct {
	// CredentialID names the acting credential. It is empty only when the
	// presented secret matched no credential at all.
	CredentialID string
	// Operation is the authority the call required.
	Operation string
	// Subject is the route, connector or capability identifier it was about.
	Subject string
	// OrganisationID is the tenancy the subject belongs to, where the gateway
	// knows it.
	OrganisationID string
	// Outcome is allowed, refused or failed.
	Outcome string
	// Reason classifies a refusal or a failure.
	Reason string
	// Count reports how many objects an enumeration or a sweep touched.
	Count int
	// OccurredAt is set by the recorder.
	OccurredAt time.Time
}

// Record is one audit entry. It is retained in a bounded ring so that the
// control plane and the operator can read what the gateway did, without the
// gateway keeping a durable store.
type Record struct {
	OccurredAt time.Time      `json:"occurred_at"`
	Type       string         `json:"type"`
	Payload    map[string]any `json:"payload"`
}

// Event names, matching docs/EVENTS.md section 7 where one exists.
const (
	EventPublishedServiceReady   = "published_service.ready"
	EventPublishedServiceFailed  = "published_service.failed"
	EventPublishedServiceExpired = "published_service.expired"
	EventPublishedServiceRevoked = "published_service.revoked"
	EventConnectorConnected      = "connector.connected"
	EventConnectorDisconnected   = "connector.disconnected"
	EventChannelRefused          = "connector.channel_refused"
	EventRequestRefused          = "tunnel.request_refused"
	// EventControlAction is gateway-local: docs/EVENTS.md section 7 is the
	// control plane's durable project event vocabulary, and this is neither
	// durable nor project-scoped. It is named in the same shape so that an
	// operator reading one log reads one vocabulary.
	EventControlAction = "tunnel.control_action"
)

// SlogAuditor writes audit records to a structured logger, keeps a bounded
// ring of them and updates the lifecycle metrics.
type SlogAuditor struct {
	logger  *slog.Logger
	metrics *metrics.Registry
	now     func() time.Time

	mu       sync.Mutex
	ring     []Record
	capacity int
}

// NewSlogAuditor builds an auditor retaining the most recent capacity records.
func NewSlogAuditor(logger *slog.Logger, registryMetrics *metrics.Registry, now func() time.Time, capacity int) *SlogAuditor {
	if capacity <= 0 {
		capacity = 256
	}
	if now == nil {
		now = time.Now
	}
	return &SlogAuditor{logger: logger, metrics: registryMetrics, now: now, capacity: capacity}
}

func (a *SlogAuditor) record(eventType string, payload map[string]any) {
	entry := Record{OccurredAt: a.now().UTC(), Type: eventType, Payload: payload}
	a.mu.Lock()
	a.ring = append(a.ring, entry)
	if len(a.ring) > a.capacity {
		a.ring = a.ring[len(a.ring)-a.capacity:]
	}
	a.mu.Unlock()

	attributes := make([]any, 0, len(payload)+1)
	attributes = append(attributes, slog.String("event", eventType))
	for key, value := range payload {
		attributes = append(attributes, slog.Any(key, value))
	}
	a.logger.Info("audit", attributes...)
}

// Records returns a copy of the retained ring.
func (a *SlogAuditor) Records() []Record {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]Record(nil), a.ring...)
}

func (a *SlogAuditor) RouteReady(route *registry.Route) {
	a.metrics.Count(metrics.RouteLifecycle, "transition", "ready")
	a.record(EventPublishedServiceReady, map[string]any{
		"route_id":                    route.RouteID,
		"project_id":                  route.ProjectID,
		"connector_id":                route.ConnectorID,
		"workspace_id":                route.WorkspaceID,
		"public_alias":                route.PublicAlias,
		"observed_destination":        route.ObservedDestination,
		"expires_at":                  route.ExpiresAt.UTC().Format(time.RFC3339),
		"allowed_browser_session_ids": route.AllowedBrowserSessionIDs,
	})
}

func (a *SlogAuditor) RouteFailed(registration registry.Registration, rejection *registry.Rejection) {
	a.metrics.Count(metrics.RouteLifecycle, "transition", "failed")
	payload := map[string]any{
		"route_id":     registration.RouteID,
		"project_id":   registration.ProjectID,
		"connector_id": registration.ConnectorID,
		"reason":       string(rejection.Reason),
		"error_class":  string(rejection.Class),
	}
	if rejection.PolicyReason != "" {
		payload["policy_reason"] = string(rejection.PolicyReason)
	}
	a.record(EventPublishedServiceFailed, payload)
}

func (a *SlogAuditor) RouteEnded(route *registry.Route, reason registry.LifecycleReason) {
	eventType := EventPublishedServiceRevoked
	transition := "revoked"
	if reason == registry.ReasonExpired {
		eventType, transition = EventPublishedServiceExpired, "expired"
	}
	a.metrics.Count(metrics.RouteLifecycle, "transition", transition)
	toDestination, fromDestination, opened, _ := route.Counters()
	a.record(eventType, map[string]any{
		"route_id":               route.RouteID,
		"project_id":             route.ProjectID,
		"connector_id":           route.ConnectorID,
		"reason":                 string(reason),
		"previous_status":        string(registry.StatusReady),
		"new_status":             string(route.Status),
		"streams_opened":         opened,
		"bytes_to_destination":   toDestination,
		"bytes_from_destination": fromDestination,
	})
}

func (a *SlogAuditor) ConnectorChannelOpened(connectorID, remote string) {
	a.metrics.Count(metrics.ConnectorChannels, "outcome", "accepted")
	a.record(EventConnectorConnected, map[string]any{
		"connector_id": connectorID,
		"remote":       remote,
		"channel":      "data",
	})
}

func (a *SlogAuditor) ConnectorChannelClosed(connectorID string, cause error) {
	reason := "closed"
	if cause != nil {
		reason = cause.Error()
	}
	a.record(EventConnectorDisconnected, map[string]any{
		"connector_id": connectorID,
		"channel":      "data",
		"reason":       reason,
	})
}

func (a *SlogAuditor) ConnectorChannelRefused(reason, remote string) {
	a.metrics.Count(metrics.ConnectorChannels, "outcome", "refused")
	a.record(EventChannelRefused, map[string]any{
		"reason": reason,
		"remote": remote,
	})
}

func (a *SlogAuditor) RequestRefused(requestID, code, reason string) {
	a.record(EventRequestRefused, map[string]any{
		"request_id": requestID,
		"code":       code,
		"reason":     reason,
	})
}

func (a *SlogAuditor) ControlAction(action ControlAction) {
	a.metrics.Count(metrics.ControlActions, "outcome", action.Outcome)
	payload := map[string]any{
		// An unrecognised secret has no credential to name. Recording the
		// absence explicitly is better than an empty field a reader has to
		// interpret, and it is the one case where attribution is impossible.
		"credential_id": credentialOrUnknown(action.CredentialID),
		"operation":     action.Operation,
		"outcome":       action.Outcome,
	}
	if action.Subject != "" {
		payload["subject"] = action.Subject
	}
	if action.OrganisationID != "" {
		payload["organisation_id"] = action.OrganisationID
	}
	if action.Reason != "" {
		payload["reason"] = action.Reason
	}
	if action.Count > 0 {
		payload["count"] = action.Count
	}
	a.record(EventControlAction, payload)
}

func credentialOrUnknown(credentialID string) string {
	if credentialID == "" {
		return "unknown"
	}
	return credentialID
}

// observer adapts the registry's lifecycle callbacks onto the auditor and the
// route gauges.
type observer struct {
	auditor  Auditor
	metrics  *metrics.Registry
	registry func() []*registry.Route
}

func (o *observer) RouteRegistered(route *registry.Route) {
	o.auditor.RouteReady(route)
	o.refresh()
}

func (o *observer) RouteEnded(route *registry.Route, reason registry.LifecycleReason) {
	o.auditor.RouteEnded(route, reason)
	o.refresh()
}

func (o *observer) RouteRejected(registration registry.Registration, rejection *registry.Rejection) {
	o.auditor.RouteFailed(registration, rejection)
}

// refresh rewrites the per-route gauges from the live set. Clearing first is
// what keeps the series bounded: a route that has gone stops being reported
// rather than freezing at its last value for ever.
func (o *observer) refresh() {
	if o.registry == nil {
		return
	}
	routes := o.registry()
	o.metrics.ClearGauge(metrics.RouteBytes)
	o.metrics.ClearGauge(metrics.RouteStreams)
	o.metrics.SetGauge(metrics.RoutesActive, float64(len(routes)))
	for _, route := range routes {
		toDestination, fromDestination, opened, active := route.Counters()
		o.metrics.SetGauge(metrics.RouteBytes, float64(toDestination),
			"route_id", route.RouteID, "direction", metrics.DirectionToDestination)
		o.metrics.SetGauge(metrics.RouteBytes, float64(fromDestination),
			"route_id", route.RouteID, "direction", metrics.DirectionFromDestination)
		o.metrics.SetGauge(metrics.RouteStreams, float64(opened),
			"route_id", route.RouteID, "state", "opened")
		o.metrics.SetGauge(metrics.RouteStreams, float64(active),
			"route_id", route.RouteID, "state", "active")
	}
}
