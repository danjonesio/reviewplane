package gatewayhttp

import (
	"encoding/json"
	"net/http"

	"github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
)

// Stable error codes the gateway answers with.
//
// docs/SECURITY.md section 18 requires stable codes rather than free text, and
// two vocabularies already exist: docs/MCP_SPEC.md section 12 for
// authorisation and availability outcomes, and docs/CONNECTOR_PROTOCOL.md
// section 21 for route and stream lifecycle outcomes. The gateway answers with
// a value from one of them and never invents a third.
//
// The code a caller receives is deliberately coarser than the reason recorded
// in the audit trail: an unknown route, a route in another project and a route
// whose capability names a different session all answer the same way, because a
// caller that can tell them apart has an enumeration oracle.
const (
	// CodeAuthenticationRequired: no capability was presented.
	CodeAuthenticationRequired = "AUTHENTICATION_REQUIRED"
	// CodeAuthorisationDenied: a capability was presented and does not
	// authorise this route, project or browser session.
	CodeAuthorisationDenied = "AUTHORISATION_DENIED"
	// CodePublishedServiceUnavailable: the origin does not resolve to a route
	// the gateway carries.
	CodePublishedServiceUnavailable = "PUBLISHED_SERVICE_UNAVAILABLE"
	// CodeConnectorOffline: the route exists but its connector has no data
	// channel.
	CodeConnectorOffline = "CONNECTOR_OFFLINE"
	// CodeUnsupportedCapability: the request asked the gateway to be something
	// it is not, such as a forward proxy.
	CodeUnsupportedCapability = "UNSUPPORTED_CAPABILITY"
	// CodeRateLimited: a bound was exceeded.
	CodeRateLimited = "RATE_LIMITED"
	// CodeInternalError: the gateway failed.
	CodeInternalError = "INTERNAL_ERROR"

	// CodeRouteExpired is docs/CONNECTOR_PROTOCOL.md section 21's ROUTE_EXPIRED.
	// Expiry and revocation share it: section 21 is a closed vocabulary, and
	// adding a class is a protocol change requiring an ADR. Which of the two
	// occurred is recorded in the audit trail and in the metrics, not on the
	// wire.
	CodeRouteExpired = string(connectorv1.ErrorClassRouteExpired)
	// CodeStreamLimitExceeded is section 21's STREAM_LIMIT_EXCEEDED.
	CodeStreamLimitExceeded = string(connectorv1.ErrorClassStreamLimitExceeded)
	// CodePortNotListening is section 21's PORT_NOT_LISTENING, reported when the
	// connector could not open the pre-authorised destination.
	CodePortNotListening = string(connectorv1.ErrorClassPortNotListening)
	// CodeDestinationNotAllowed is section 21's DESTINATION_NOT_ALLOWED.
	CodeDestinationNotAllowed = string(connectorv1.ErrorClassDestinationNotAllowed)
	// CodeRouteLimitExceeded is section 21's ROUTE_LIMIT_EXCEEDED.
	CodeRouteLimitExceeded = string(connectorv1.ErrorClassRouteLimitExceeded)
)

// ErrorCodeHeader carries the stable code alongside the JSON body, so that a
// protocol-level client can assert on it without parsing. It carries no detail
// beyond the code.
const ErrorCodeHeader = "X-ReviewPlane-Error-Code"

// RequestIDHeader carries the correlation identifier of
// docs/ARCHITECTURE.md section 15.
const RequestIDHeader = "X-ReviewPlane-Request-Id"

type errorBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
	Meta struct {
		RequestID string `json:"request_id"`
	} `json:"meta"`
}

// writeError answers with the envelope of docs/API.md section 5.
//
// The message is a fixed sentence chosen by the code, never assembled from
// request data: echoing what the caller sent is how a probing oracle and a
// reflected-content bug both start.
func writeError(w http.ResponseWriter, status int, code, requestID string) {
	body := errorBody{}
	body.Error.Code = code
	body.Error.Message = messageFor(code)
	body.Meta.RequestID = requestID

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set(ErrorCodeHeader, code)
	w.Header().Set(RequestIDHeader, requestID)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func messageFor(code string) string {
	switch code {
	case CodeAuthenticationRequired:
		return "This route requires a session-scoped capability."
	case CodeAuthorisationDenied:
		return "The capability presented does not authorise this route."
	case CodePublishedServiceUnavailable:
		return "No published service is reachable at this origin."
	case CodeConnectorOffline:
		return "The connector for this published service is not connected."
	case CodeUnsupportedCapability:
		return "The tunnel gateway serves published routes only."
	case CodeRateLimited:
		return "A tunnel limit was exceeded."
	case CodeRouteExpired:
		return "This published service is no longer available."
	case CodeStreamLimitExceeded:
		return "Too many concurrent streams."
	case CodePortNotListening:
		return "The published service is not listening."
	default:
		return "The tunnel gateway could not complete this request."
	}
}
