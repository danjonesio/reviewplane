package gatewayhttp

import (
	"crypto/subtle"
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
// It is not yet generated from packages/protocol. docs/DEVELOPMENT.md section 3
// says API schemas belong there, and the generator is built for the connector
// protocol only; extending it is the work of the issue that brings API schemas
// into the package. Until then the two implementations are held together by
// testdata/gateway-api/, a committed corpus that the Go handler and the
// TypeScript client both run, which is the same mechanism the protocol package
// uses for the same problem.

// RegisterRequest asks the gateway to carry a route.
type RegisterRequest struct {
	RouteID                  string   `json:"route_id"`
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
	token          []byte
	internalSuffix string
	maxBodyBytes   int64
	now            func() time.Time
}

// AdminConfig configures the control API.
type AdminConfig struct {
	// Token authenticates the control plane. It is compared in constant time
	// and never logged.
	Token string
	// InternalSuffix is the domain the internal origin lives under.
	InternalSuffix string
	// MaxBodyBytes bounds a request body.
	MaxBodyBytes int64
	Now          func() time.Time
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
	if len(config.Token) < 32 {
		return nil, errors.New("gatewayhttp: the control-plane token must be at least 32 characters")
	}
	if config.InternalSuffix == "" {
		config.InternalSuffix = "internal.invalid"
	}
	if config.MaxBodyBytes <= 0 {
		config.MaxBodyBytes = 64 << 10
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
		token:          []byte(config.Token),
		internalSuffix: config.InternalSuffix,
		maxBodyBytes:   config.MaxBodyBytes,
		now:            config.Now,
	}, nil
}

// Handler builds the control API's routes.
func (a *Admin) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", a.health)
	mux.HandleFunc("GET /readyz", a.health)
	mux.Handle("GET /metrics", a.authenticated(http.HandlerFunc(a.exposeMetrics)))
	mux.Handle("GET /internal/v1/routes", a.authenticated(http.HandlerFunc(a.listRoutes)))
	mux.Handle("PUT /internal/v1/routes/{routeId}", a.authenticated(http.HandlerFunc(a.registerRoute)))
	mux.Handle("GET /internal/v1/routes/{routeId}", a.authenticated(http.HandlerFunc(a.showRoute)))
	mux.Handle("DELETE /internal/v1/routes/{routeId}", a.authenticated(http.HandlerFunc(a.revokeRoute)))
	mux.Handle("DELETE /internal/v1/connectors/{connectorId}", a.authenticated(http.HandlerFunc(a.revokeConnector)))
	mux.Handle("DELETE /internal/v1/capabilities/{capabilityId}", a.authenticated(http.HandlerFunc(a.revokeCapability)))
	return mux
}

func (a *Admin) health(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"data":{"status":"ok"}}` + "\n"))
}

// authenticated compares the bearer token in constant time.
//
// The token never reaches a log line, an error body or a metric label: a
// control-plane credential in a log is exactly what docs/SECURITY.md section 18
// forbids, and an admin endpoint is where one would otherwise be recorded
// "for diagnosis".
func (a *Admin) authenticated(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		presented := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(presented), a.token) != 1 {
			a.writeError(w, http.StatusUnauthorized, CodeAuthenticationRequired,
				"The gateway control API requires the control-plane token.", nil)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *Admin) exposeMetrics(w http.ResponseWriter, _ *http.Request) {
	a.metrics.SetGauge(metrics.ConnectorChannelsOpen, float64(a.channels.Count()))
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(a.metrics.Expose()))
}

func (a *Admin) registerRoute(w http.ResponseWriter, r *http.Request) {
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
	route, rejection := a.routes.Register(registry.Registration{
		RouteID:     request.RouteID,
		ProjectID:   request.ProjectID,
		ConnectorID: request.ConnectorID,
		WorkspaceID: request.WorkspaceID,
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
		a.writeError(w, statusForRejection(rejection), string(rejection.Class),
			"The gateway refused this publication.", details)
		return
	}
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

func (a *Admin) listRoutes(w http.ResponseWriter, _ *http.Request) {
	routes := a.routes.Routes()
	views := make([]RouteView, 0, len(routes))
	for _, route := range routes {
		views = append(views, a.view(route))
	}
	a.writeData(w, http.StatusOK, views)
}

func (a *Admin) showRoute(w http.ResponseWriter, r *http.Request) {
	route, found := a.routes.Lookup(r.PathValue("routeId"))
	if !found {
		a.writeError(w, http.StatusNotFound, CodePublishedServiceUnavailable,
			"No such route is registered.", nil)
		return
	}
	a.writeData(w, http.StatusOK, a.view(route))
}

func (a *Admin) revokeRoute(w http.ResponseWriter, r *http.Request) {
	route, revoked := a.routes.Revoke(r.PathValue("routeId"), registry.ReasonRevoked)
	if !revoked {
		a.writeError(w, http.StatusNotFound, CodePublishedServiceUnavailable,
			"No such route is registered.", nil)
		return
	}
	a.writeData(w, http.StatusOK, a.view(route))
}

func (a *Admin) revokeConnector(w http.ResponseWriter, r *http.Request) {
	connectorID := r.PathValue("connectorId")
	ended := a.routes.RevokeConnector(connectorID)
	closed := a.channels.CloseConnector(connectorID, errors.New("gatewayhttp: connector identity revoked"))
	views := make([]RouteView, 0, len(ended))
	for _, route := range ended {
		views = append(views, a.view(route))
	}
	a.writeData(w, http.StatusOK, map[string]any{
		"connector_id":   connectorID,
		"channel_closed": closed,
		"routes_revoked": views,
	})
}

func (a *Admin) revokeCapability(w http.ResponseWriter, r *http.Request) {
	capabilityID := r.PathValue("capabilityId")
	a.routes.RevokeCapability(capabilityID, a.now().UTC())
	a.writeData(w, http.StatusOK, map[string]any{
		"capability_id": capabilityID,
		"status":        "revoked",
	})
}

func (a *Admin) view(route *registry.Route) RouteView {
	toDestination, fromDestination, opened, active := route.Counters()
	_, connected := a.channels.Get(route.ConnectorID)
	return RouteView{
		RouteID:              route.RouteID,
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
