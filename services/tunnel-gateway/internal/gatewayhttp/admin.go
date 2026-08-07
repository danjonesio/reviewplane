package gatewayhttp

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/internal/metrics"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/internal/registry"
)

// The gateway control API.
//
// This is the interface the control plane uses to tell the gateway which routes
// it may carry, and to withdraw one immediately. It is not the connector
// protocol and not the public API of docs/API.md: it is a private, versioned
// interface between two components of the control-plane trust zone, served on
// its own listener that is never published to a host port
// (docs/DEPLOYMENT.md, only the gateway's public listener is).
//
// Private is not the same as unauthorised. Every route here names the operation
// it requires, the caller presents a named credential carrying a set of
// operations and an organisation scope, and every call — allowed, refused or
// failed — produces an audit record naming the credential that made it
// (credentials.go, ADR-0038).
//
// It is not yet generated from packages/protocol. docs/DEVELOPMENT.md section 3
// says API schemas belong there, and the generator is built for the connector
// protocol only; extending it is the work of the issue that brings API schemas
// into the package. Until then the two implementations are held together by
// testdata/gateway-api/, a committed corpus that the Go handler and the
// TypeScript client both run, which is the same mechanism the protocol package
// uses for the same problem.

// RegisterRequest asks the gateway to carry a route.
type RegisterRequest struct {
	RouteID string `json:"route_id"`
	// OrganisationID is the tenancy the route belongs to. It is required: it is
	// what an organisation-scoped control credential is held to, and a route
	// without one would belong to whichever credential asked about it.
	OrganisationID           string   `json:"organisation_id"`
	ProjectID                string   `json:"project_id"`
	ConnectorID              string   `json:"connector_id"`
	WorkspaceID              string   `json:"workspace_id"`
	PublicAlias              string   `json:"public_alias"`
	LocalHost                string   `json:"local_host"`
	LocalPort                int      `json:"local_port"`
	Protocol                 string   `json:"protocol"`
	Scope                    string   `json:"scope"`
	ExpiresAt                string   `json:"expires_at"`
	AllowedBrowserSessionIDs []string `json:"allowed_browser_session_ids"`
	ObservedDestination      string   `json:"observed_destination"`
}

// RouteView is the gateway's account of a route.
type RouteView struct {
	RouteID              string `json:"route_id"`
	OrganisationID       string `json:"organisation_id"`
	ProjectID            string `json:"project_id"`
	ConnectorID          string `json:"connector_id"`
	PublicAlias          string `json:"public_alias"`
	InternalOrigin       string `json:"internal_origin"`
	Status               string `json:"status"`
	ExpiresAt            string `json:"expires_at"`
	ObservedDestination  string `json:"observed_destination"`
	ConnectorConnected   bool   `json:"connector_connected"`
	StreamsOpened        int64  `json:"streams_opened"`
	StreamsActive        int64  `json:"streams_active"`
	BytesToDestination   int64  `json:"bytes_to_destination"`
	BytesFromDestination int64  `json:"bytes_from_destination"`
}

type dataEnvelope struct {
	Data any      `json:"data"`
	Meta metaBody `json:"meta"`
}

type metaBody struct {
	RequestID string `json:"request_id"`
}

type adminErrorBody struct {
	Error struct {
		Code    string            `json:"code"`
		Message string            `json:"message"`
		Details map[string]string `json:"details,omitempty"`
	} `json:"error"`
	Meta metaBody `json:"meta"`
}

// Admin serves the gateway control API.
type Admin struct {
	routes         *registry.Registry
	channels       *Channels
	metrics        *metrics.Registry
	auditor        Auditor
	logger         *slog.Logger
	credentials    ControlCredentials
	internalSuffix string
	maxBodyBytes   int64
	capabilityTTL  time.Duration
	now            func() time.Time
}

// AdminConfig configures the control API.
type AdminConfig struct {
	// Credentials are the named principals allowed on this surface, each
	// carrying the operations and the organisations it may act for (ADR-0038).
	Credentials ControlCredentials
	// InternalSuffix is the domain the internal origin lives under.
	InternalSuffix string
	// MaxBodyBytes bounds a request body.
	MaxBodyBytes int64
	// MaxCapabilityLifetime bounds how long a withdrawn capability's record is
	// kept. A capability may not outlive its route (docs/ARCHITECTURE.md
	// section 7.3), so the maximum route lifetime is an upper bound on any
	// capability the gateway could still be shown.
	MaxCapabilityLifetime time.Duration
	Now                   func() time.Time
}

// NewAdmin builds the control API handler.
func NewAdmin(
	config AdminConfig,
	routes *registry.Registry,
	channels *Channels,
	registryMetrics *metrics.Registry,
	auditor Auditor,
	logger *slog.Logger,
) (*Admin, error) {
	if err := config.Credentials.Validate(); err != nil {
		return nil, err
	}
	if config.InternalSuffix == "" {
		config.InternalSuffix = "internal.invalid"
	}
	if config.MaxBodyBytes <= 0 {
		config.MaxBodyBytes = 64 << 10
	}
	if config.MaxCapabilityLifetime <= 0 {
		config.MaxCapabilityLifetime = 8 * time.Hour
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	return &Admin{
		routes:         routes,
		channels:       channels,
		metrics:        registryMetrics,
		auditor:        auditor,
		logger:         logger,
		credentials:    config.Credentials,
		internalSuffix: config.InternalSuffix,
		maxBodyBytes:   config.MaxBodyBytes,
		capabilityTTL:  config.MaxCapabilityLifetime,
		now:            config.Now,
	}, nil
}

// controlHandler is a handler that has already been given the acting credential.
type controlHandler func(http.ResponseWriter, *http.Request, ControlCredential)

// Handler builds the control API's routes.
//
// Every route names the operation it needs at the point it is mounted, so the
// authority a call requires is readable beside the call rather than inferred
// from what the handler happens to touch.
func (a *Admin) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", a.health)
	mux.HandleFunc("GET /readyz", a.health)
	mux.Handle("GET /metrics", a.authorised(OperationMetricsRead, a.exposeMetrics))
	mux.Handle("GET /internal/v1/routes", a.authorised(OperationRouteRead, a.listRoutes))
	mux.Handle("PUT /internal/v1/routes/{routeId}", a.authorised(OperationRouteRegister, a.registerRoute))
	mux.Handle("GET /internal/v1/routes/{routeId}", a.authorised(OperationRouteRead, a.showRoute))
	mux.Handle("DELETE /internal/v1/routes/{routeId}", a.authorised(OperationRouteRevoke, a.revokeRoute))
	mux.Handle("DELETE /internal/v1/connectors/{connectorId}",
		a.authorised(OperationConnectorRevoke, a.revokeConnector))
	mux.Handle("DELETE /internal/v1/capabilities/{capabilityId}",
		a.authorised(OperationCapabilityRevoke, a.revokeCapability))
	return mux
}

func (a *Admin) health(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"data":{"status":"ok"}}` + "\n"))
}

// authorised resolves the bearer secret to a credential and checks that the
// credential carries the operation this route needs.
//
// Authentication and authorisation are one step here on purpose: the surface is
// small, every route on it changes or reveals something, and a middleware that
// only authenticated is what let "the MCP process only withdraws" be a property
// of the code rather than of the credential (ADR-0038).
//
// No secret reaches a log line, an error body or a metric label: a control
// credential in a log is exactly what docs/SECURITY.md section 18 forbids, and
// an admin endpoint is where one would otherwise be recorded "for diagnosis".
// The credential's *identifier* is recorded everywhere, because that is the
// attribution an operator needs and it is not secret.
func (a *Admin) authorised(operation ControlOperation, next controlHandler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		presented := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		credential, known := a.credentials.Authenticate(presented)
		if !known {
			a.recordAction(ControlAction{
				Operation: string(operation),
				Subject:   subjectOf(r),
				Outcome:   "refused",
				Reason:    "credential_not_recognised",
			})
			a.writeError(w, http.StatusUnauthorized, CodeAuthenticationRequired,
				"The gateway control API requires a control credential.", nil)
			return
		}
		if !credential.Permits(operation) {
			a.recordAction(ControlAction{
				CredentialID: credential.ID,
				Operation:    string(operation),
				Subject:      subjectOf(r),
				Outcome:      "refused",
				Reason:       "operation_not_granted",
			})
			a.writeError(w, http.StatusForbidden, CodeAuthorisationDenied,
				"This control credential may not perform that operation.",
				map[string]string{"operation": string(operation)})
			return
		}
		next(w, r, credential)
	})
}

// subjectOf names what a control call was about, for the audit record. It is
// read from the path and never from the body, so a refusal that never decoded a
// body still names its subject.
func subjectOf(r *http.Request) string {
	for _, name := range []string{"routeId", "connectorId", "capabilityId"} {
		if value := r.PathValue(name); value != "" {
			return value
		}
	}
	return ""
}

func (a *Admin) recordAction(action ControlAction) {
	action.OccurredAt = a.now().UTC()
	a.auditor.ControlAction(action)
}

func (a *Admin) exposeMetrics(w http.ResponseWriter, _ *http.Request, credential ControlCredential) {
	a.metrics.SetGauge(metrics.ConnectorChannelsOpen, float64(a.channels.Count()))
	a.recordAction(ControlAction{
		CredentialID: credential.ID,
		Operation:    string(OperationMetricsRead),
		Outcome:      "allowed",
	})
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(a.metrics.Expose()))
}

func (a *Admin) registerRoute(w http.ResponseWriter, r *http.Request, credential ControlCredential) {
	var request RegisterRequest
	if !a.decode(w, r, &request) {
		return
	}
	if request.RouteID != "" && request.RouteID != r.PathValue("routeId") {
		a.writeError(w, http.StatusBadRequest, CodeUnsupportedCapability,
			"The route identifier in the path and the body must agree.", nil)
		return
	}
	request.RouteID = r.PathValue("routeId")

	expiresAt, err := time.Parse(time.RFC3339, request.ExpiresAt)
	if err != nil {
		a.writeError(w, http.StatusBadRequest, CodeUnsupportedCapability,
			"expires_at must be an RFC 3339 timestamp.", nil)
		return
	}
	scope := request.Scope
	if scope == "" {
		scope = registry.ScopeBrowserSession
	}
	// The tenancy check comes before the registry sees the request, so a
	// credential bounded to one organisation cannot plant a route in another
	// and then read it back through the route it just created.
	if !credential.Scope().Admits(request.OrganisationID) {
		a.recordAction(ControlAction{
			CredentialID:   credential.ID,
			Operation:      string(OperationRouteRegister),
			Subject:        request.RouteID,
			OrganisationID: request.OrganisationID,
			Outcome:        "refused",
			Reason:         "organisation_out_of_scope",
		})
		a.writeError(w, http.StatusForbidden, CodeAuthorisationDenied,
			"This control credential may not act for that organisation.", nil)
		return
	}
	route, rejection := a.routes.Register(registry.Registration{
		RouteID:        request.RouteID,
		OrganisationID: request.OrganisationID,
		ProjectID:      request.ProjectID,
		ConnectorID:    request.ConnectorID,
		WorkspaceID:    request.WorkspaceID,
		// The alias is taken exactly as offered. It is not lowercased here: an
		// alias that had to be normalised to be accepted is one the control
		// plane and the gateway disagree about, and the origin-to-route mapping
		// has to be injective.
		PublicAlias:              request.PublicAlias,
		LocalHost:                request.LocalHost,
		LocalPort:                request.LocalPort,
		Protocol:                 connectorv1.DestinationProtocol(request.Protocol),
		Scope:                    scope,
		ExpiresAt:                expiresAt.UTC(),
		AllowedBrowserSessionIDs: request.AllowedBrowserSessionIDs,
		ObservedDestination:      request.ObservedDestination,
	})
	if rejection != nil {
		details := map[string]string{"reason": string(rejection.Reason)}
		if rejection.PolicyReason != "" {
			details["policy_reason"] = string(rejection.PolicyReason)
		}
		a.recordAction(ControlAction{
			CredentialID:   credential.ID,
			Operation:      string(OperationRouteRegister),
			Subject:        request.RouteID,
			OrganisationID: request.OrganisationID,
			Outcome:        "refused",
			Reason:         string(rejection.Reason),
		})
		a.writeError(w, statusForRejection(rejection), string(rejection.Class),
			"The gateway refused this publication.", details)
		return
	}
	a.recordAction(ControlAction{
		CredentialID:   credential.ID,
		Operation:      string(OperationRouteRegister),
		Subject:        route.RouteID,
		OrganisationID: route.OrganisationID,
		Outcome:        "allowed",
	})
	a.writeData(w, http.StatusOK, a.view(route))
}

func statusForRejection(rejection *registry.Rejection) int {
	switch rejection.Reason {
	case registry.RejectRouteTaken, registry.RejectAliasTaken:
		return http.StatusConflict
	case registry.RejectRouteLimit:
		return http.StatusTooManyRequests
	default:
		return http.StatusUnprocessableEntity
	}
}

func (a *Admin) listRoutes(w http.ResponseWriter, _ *http.Request, credential ControlCredential) {
	// The scope is the credential's, not the caller's request. An enumeration
	// that took its tenancy from a query parameter would be an enumeration with
	// no tenancy at all.
	routes := a.routes.RoutesIn(credential.Scope())
	views := make([]RouteView, 0, len(routes))
	for _, route := range routes {
		views = append(views, a.view(route))
	}
	a.recordAction(ControlAction{
		CredentialID: credential.ID,
		Operation:    string(OperationRouteRead),
		Outcome:      "allowed",
		Count:        len(views),
	})
	a.writeData(w, http.StatusOK, views)
}

func (a *Admin) showRoute(w http.ResponseWriter, r *http.Request, credential ControlCredential) {
	route, found := a.routes.LookupIn(r.PathValue("routeId"), credential.Scope())
	if !found {
		a.recordAction(ControlAction{
			CredentialID: credential.ID,
			Operation:    string(OperationRouteRead),
			Subject:      r.PathValue("routeId"),
			Outcome:      "refused",
			Reason:       "route_absent_in_scope",
		})
		a.writeError(w, http.StatusNotFound, CodePublishedServiceUnavailable,
			"No such route is registered.", nil)
		return
	}
	a.recordAction(ControlAction{
		CredentialID:   credential.ID,
		Operation:      string(OperationRouteRead),
		Subject:        route.RouteID,
		OrganisationID: route.OrganisationID,
		Outcome:        "allowed",
	})
	a.writeData(w, http.StatusOK, a.view(route))
}

func (a *Admin) revokeRoute(w http.ResponseWriter, r *http.Request, credential ControlCredential) {
	routeID := r.PathValue("routeId")
	route, err := a.routes.RevokeIn(routeID, registry.ReasonRevoked, credential.Scope())
	if errors.Is(err, registry.ErrRouteNotRegistered) {
		a.recordAction(ControlAction{
			CredentialID: credential.ID,
			Operation:    string(OperationRouteRevoke),
			Subject:      routeID,
			Outcome:      "refused",
			Reason:       "route_absent_in_scope",
		})
		a.writeError(w, http.StatusNotFound, CodePublishedServiceUnavailable,
			"No such route is registered.", nil)
		return
	}
	if err != nil {
		a.reportUnrecordedRevocation(w, credential, OperationRouteRevoke, routeID, err)
		return
	}
	a.recordAction(ControlAction{
		CredentialID:   credential.ID,
		Operation:      string(OperationRouteRevoke),
		Subject:        route.RouteID,
		OrganisationID: route.OrganisationID,
		Outcome:        "allowed",
	})
	a.writeData(w, http.StatusOK, a.view(route))
}

func (a *Admin) revokeConnector(w http.ResponseWriter, r *http.Request, credential ControlCredential) {
	connectorID := r.PathValue("connectorId")
	scope := credential.Scope()

	// A connector is not a tenanted object here: the gateway holds no connector
	// directory and can attribute one only through the routes it carries. So an
	// organisation-scoped credential may end a connector it can see entirely
	// inside its own scope, and nothing else. A connector the gateway holds no
	// route for is revocable only by a credential that acts for every
	// organisation, because there is nothing to attribute it with.
	if !scope.Unbounded() {
		organisations := a.routes.ConnectorOrganisations(connectorID)
		outside := len(organisations) == 0
		for _, organisation := range organisations {
			if !scope.Admits(organisation) {
				outside = true
			}
		}
		if outside {
			a.recordAction(ControlAction{
				CredentialID: credential.ID,
				Operation:    string(OperationConnectorRevoke),
				Subject:      connectorID,
				Outcome:      "refused",
				Reason:       "connector_not_attributable_in_scope",
			})
			a.writeError(w, http.StatusForbidden, CodeAuthorisationDenied,
				"This control credential may not revoke that connector.", nil)
			return
		}
	}

	ended, err := a.routes.RevokeConnector(connectorID, scope)
	if err != nil {
		a.reportUnrecordedRevocation(w, credential, OperationConnectorRevoke, connectorID, err)
		return
	}
	closed := a.channels.CloseConnector(connectorID, errors.New("gatewayhttp: connector identity revoked"))
	views := make([]RouteView, 0, len(ended))
	for _, route := range ended {
		views = append(views, a.view(route))
	}
	a.recordAction(ControlAction{
		CredentialID: credential.ID,
		Operation:    string(OperationConnectorRevoke),
		Subject:      connectorID,
		Outcome:      "allowed",
		Count:        len(views),
	})
	a.writeData(w, http.StatusOK, map[string]any{
		"connector_id":   connectorID,
		"channel_closed": closed,
		"routes_revoked": views,
	})
}

func (a *Admin) revokeCapability(w http.ResponseWriter, r *http.Request, credential ControlCredential) {
	capabilityID := r.PathValue("capabilityId")
	// The record is kept until nothing could still present the credential. A
	// capability is bounded by its route's expiry, and a route's expiry is
	// bounded by the configured maximum route lifetime, so this is an upper
	// bound on any capability the gateway could be shown from now on. The old
	// code recorded the revocation instant here and swept the set by age, which
	// meant the retention had nothing to do with the credential's own life.
	if err := a.routes.RevokeCapability(capabilityID, a.now().UTC().Add(a.capabilityTTL)); err != nil {
		a.reportUnrecordedRevocation(w, credential, OperationCapabilityRevoke, capabilityID, err)
		return
	}
	a.recordAction(ControlAction{
		CredentialID: credential.ID,
		Operation:    string(OperationCapabilityRevoke),
		Subject:      capabilityID,
		Outcome:      "allowed",
	})
	a.writeData(w, http.StatusOK, map[string]any{
		"capability_id": capabilityID,
		"status":        "revoked",
	})
}

// reportUnrecordedRevocation answers a withdrawal the gateway could not write
// down.
//
// It is a failure and not a warning. The control plane marks its own record
// closed only after the gateway has answered, so a revocation reported as
// successful but not made durable would be a closure that a restart silently
// reopens — the exact shape of RVP-76. Refusing lets the caller retry, and
// leaves the route carrying traffic in the meantime, which is the honest state.
func (a *Admin) reportUnrecordedRevocation(
	w http.ResponseWriter,
	credential ControlCredential,
	operation ControlOperation,
	subject string,
	cause error,
) {
	a.recordAction(ControlAction{
		CredentialID: credential.ID,
		Operation:    string(operation),
		Subject:      subject,
		Outcome:      "failed",
		Reason:       "revocation_not_recorded",
	})
	a.logger.Error("the gateway could not record a revocation",
		slog.String("credential_id", credential.ID),
		slog.String("operation", string(operation)),
		slog.String("subject", subject),
		slog.String("error", cause.Error()),
	)
	a.writeError(w, http.StatusServiceUnavailable, CodeInternalError,
		"The gateway could not record this revocation durably.", nil)
}

func (a *Admin) view(route *registry.Route) RouteView {
	toDestination, fromDestination, opened, active := route.Counters()
	_, connected := a.channels.Get(route.ConnectorID)
	return RouteView{
		RouteID:              route.RouteID,
		OrganisationID:       route.OrganisationID,
		ProjectID:            route.ProjectID,
		ConnectorID:          route.ConnectorID,
		PublicAlias:          route.PublicAlias,
		InternalOrigin:       "https://" + route.PublicAlias + "." + a.internalSuffix + "/",
		Status:               string(route.Status),
		ExpiresAt:            route.ExpiresAt.UTC().Format(time.RFC3339),
		ObservedDestination:  route.ObservedDestination,
		ConnectorConnected:   connected,
		StreamsOpened:        opened,
		StreamsActive:        active,
		BytesToDestination:   toDestination,
		BytesFromDestination: fromDestination,
	}
}

func (a *Admin) decode(w http.ResponseWriter, r *http.Request, target any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, a.maxBodyBytes))
	// Unknown fields are refused rather than ignored, for the reason
	// packages/protocol gives: a field the receiver drops is a field the two
	// sides disagree about silently.
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		a.writeError(w, http.StatusBadRequest, CodeUnsupportedCapability,
			"The request body is not a valid control-API document.", nil)
		return false
	}
	return true
}

func (a *Admin) writeData(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(dataEnvelope{Data: data, Meta: metaBody{RequestID: newRequestID()}})
}

func (a *Admin) writeError(w http.ResponseWriter, status int, code, message string, details map[string]string) {
	body := adminErrorBody{}
	body.Error.Code = code
	body.Error.Message = message
	body.Error.Details = details
	body.Meta.RequestID = newRequestID()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set(ErrorCodeHeader, code)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
