package gatewayhttp

import (
	"bufio"
	"crypto/rand"
	"encoding/base32"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/datachannel"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/internal/metrics"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/internal/registry"
)

// CapabilityHeader carries the session-scoped route capability.
//
// It is a header rather than part of the origin or a query parameter because
// both of those end up somewhere durable: an origin appears in Referer and in
// the development server's access log, and a query parameter appears in both
// plus the browser's history. A header is scoped to the request, and the
// gateway strips it before the request reaches the development service, so the
// credential never leaves the control-plane zone.
const CapabilityHeader = "X-ReviewPlane-Capability"

// HostHeaderMode fixes what Host the development service sees.
//
// docs/CONNECTOR_PROTOCOL.md section 13 requires header rewriting to be
// deterministic and documented, and docs/ARCHITECTURE.md section 7.3 requires
// predictable Host and origin behaviour, so this is a choice made once in
// configuration rather than per request.
type HostHeaderMode string

const (
	// HostUpstream sends the destination the connector opened, for example
	// 127.0.0.1:5173. It is the default because a development server's
	// DNS-rebinding protection accepts loopback and rejects an unfamiliar name.
	HostUpstream HostHeaderMode = "upstream"
	// HostOriginal sends the internal origin, for example
	// alias.internal.invalid. It suits an application that generates absolute
	// URLs from Host.
	HostOriginal HostHeaderMode = "original"
)

// ForwardedHeaderMode fixes which forwarded headers the gateway adds.
type ForwardedHeaderMode string

const (
	// ForwardedStandard adds X-Forwarded-Proto and X-Forwarded-Host. It adds no
	// X-Forwarded-For: the client is a browser worker inside the control-plane
	// zone, and its address is internal topology the development service has no
	// use for.
	ForwardedStandard ForwardedHeaderMode = "standard"
	// ForwardedNone adds nothing.
	ForwardedNone ForwardedHeaderMode = "none"
)

// hopByHopHeaders are removed in both directions (RFC 9110 section 7.6.1).
var hopByHopHeaders = []string{
	"Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization",
	"Proxy-Connection", "TE", "Trailer", "Transfer-Encoding", "Upgrade",
}

// routeConfusionHeaders are headers a caller might use to make the gateway or
// the development service believe the request was for a different origin. They
// are dropped from the inbound request unconditionally: the gateway derives the
// route from Host alone, and the development service must not be told
// otherwise.
var routeConfusionHeaders = []string{
	"X-Forwarded-Host", "X-Forwarded-For", "X-Forwarded-Proto", "X-Forwarded-Port",
	"X-Forwarded-Server", "Forwarded", "X-Real-Ip", "X-Original-Host",
	"X-Original-Url", "X-Rewrite-Url", "X-Http-Host-Override", "Host-Override",
}

// ProxyConfig bounds the browser-facing request path.
type ProxyConfig struct {
	// InternalSuffix is the domain the internal origin lives under, without a
	// leading dot: "internal.invalid".
	InternalSuffix string
	// HostHeader fixes the Host the development service sees.
	HostHeader HostHeaderMode
	// Forwarded fixes which forwarded headers are added.
	Forwarded ForwardedHeaderMode
	// StreamMaxLifetime bounds one stream's absolute life, and is the deadline
	// carried in the data-stream header. A route expiring sooner shortens it,
	// and it never lengthens one: a stream MUST NOT outlive its route.
	//
	// It is a backstop rather than the working control. What ends an ordinary
	// stream is the exchange finishing, and what ends a stalled or silent one
	// is the idle timeout of docs/CONNECTOR_PROTOCOL.md section 13.3. A short
	// absolute lifetime here would cut a server-sent-event stream or a
	// hot-reload WebSocket in the middle of working correctly, so the default
	// is the maximum route lifetime and the route's own expiry is what
	// normally applies.
	StreamMaxLifetime time.Duration
	// MaxRequestBodyBytes bounds a request body the gateway must buffer, which
	// it does only when the client sent no Content-Length.
	MaxRequestBodyBytes int64
	// MaxResponseHeaderBytes bounds the upstream response head.
	MaxResponseHeaderBytes int
	// MaxStreamsPerRoute bounds concurrent streams on one route.
	MaxStreamsPerRoute int
	// RelayBufferBytes bounds the copy buffer each direction of an upgraded
	// connection holds. It is the only per-connection allocation the relay
	// makes; everything else it moves is bounded by the stream's flow-control
	// window (docs/CONNECTOR_PROTOCOL.md section 12.2).
	RelayBufferBytes int
	// Now supplies the clock.
	Now func() time.Time
}

func (c ProxyConfig) withDefaults() ProxyConfig {
	if c.InternalSuffix == "" {
		c.InternalSuffix = "internal.invalid"
	}
	if c.HostHeader == "" {
		c.HostHeader = HostUpstream
	}
	if c.Forwarded == "" {
		c.Forwarded = ForwardedStandard
	}
	if c.StreamMaxLifetime <= 0 {
		c.StreamMaxLifetime = 8 * time.Hour
	}
	if c.RelayBufferBytes <= 0 {
		c.RelayBufferBytes = 32 << 10
	}
	if c.MaxRequestBodyBytes <= 0 {
		c.MaxRequestBodyBytes = 8 << 20
	}
	if c.MaxResponseHeaderBytes <= 0 {
		c.MaxResponseHeaderBytes = 64 << 10
	}
	if c.MaxStreamsPerRoute <= 0 {
		c.MaxStreamsPerRoute = 64
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	return c
}

// Verifier authenticates a route capability. The gateway verifies; the control
// plane mints.
type Verifier interface {
	Verify(token string, nowUnix int64) (connectorv1.CapabilityClaims, *connectorv1.CapabilityError)
}

// Proxy is the browser-facing half of the gateway.
//
// It exposes exactly one behaviour: forward a request whose Host names a
// registered route and whose capability authorises it, to the destination fixed
// when that route was published. There is no CONNECT method, no absolute-form
// request target, no destination taken from the request, and therefore no
// arbitrary-destination path at all (docs/SECURITY.md section 9,
// docs/ARCHITECTURE.md section 4.6).
type Proxy struct {
	config    ProxyConfig
	routes    *registry.Registry
	channels  *Channels
	verifier  Verifier
	metrics   *metrics.Registry
	logger    *slog.Logger
	auditSink Auditor

	// upgradesOpen counts upgraded connections the gateway is carrying now. It
	// is a gauge rather than a derived figure because an upgraded connection
	// lives for a review session, so "how many are open" is a different
	// question from "how many were opened".
	upgradesOpen atomic.Int64
}

// NewProxy builds the browser-facing handler.
func NewProxy(
	config ProxyConfig,
	routes *registry.Registry,
	channels *Channels,
	verifier Verifier,
	registryMetrics *metrics.Registry,
	logger *slog.Logger,
	auditor Auditor,
) *Proxy {
	return &Proxy{
		config:    config.withDefaults(),
		routes:    routes,
		channels:  channels,
		verifier:  verifier,
		metrics:   registryMetrics,
		logger:    logger,
		auditSink: auditor,
	}
}

// denial is an authorisation outcome: the code the caller sees and the reason
// the operator sees. They are separate on purpose.
type denial struct {
	status int
	code   string
	reason string
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	requestID := newRequestID()
	started := p.config.Now()

	// Normalisation runs before anything reads the request, and therefore
	// before the origin is resolved to a route. docs/SECURITY.md section 9
	// names header-based route confusion as an SSRF vector, and the defence is
	// ordering: a header that could name a different origin is gone by the
	// time a route is looked up, on the upgrade path exactly as on the
	// ordinary one.
	p.normaliseHeaders(r)

	route, claims, upgrade, failure := p.authorise(r)
	if failure != nil {
		p.refuse(w, r, requestID, failure)
		return
	}
	if upgrade != nil {
		p.forwardUpgrade(w, r, requestID, route, claims, *upgrade, started)
		return
	}

	status, sent, received, err := p.forward(w, r, requestID, route, claims)
	duration := p.config.Now().Sub(started)
	if err != nil {
		p.logger.Warn("tunnel request failed",
			slog.String("request_id", requestID),
			slog.String("route_id", route.RouteID),
			slog.String("project_id", route.ProjectID),
			slog.String("browser_session_id", claims.BrowserSessionID),
			slog.String("method", r.Method),
			slog.String("error", err.Error()),
			slog.Int64("bytes_to_destination", sent),
			slog.Int64("bytes_from_destination", received),
			slog.Duration("duration", duration),
		)
		return
	}
	p.logger.Info("tunnel request",
		slog.String("request_id", requestID),
		slog.String("route_id", route.RouteID),
		slog.String("project_id", route.ProjectID),
		slog.String("browser_session_id", claims.BrowserSessionID),
		slog.String("method", r.Method),
		slog.Int("status", status),
		slog.Int64("bytes_to_destination", sent),
		slog.Int64("bytes_from_destination", received),
		slog.Duration("duration", duration),
	)
	p.metrics.Count(metrics.Requests, "code", "ok")
}

func (p *Proxy) refuse(w http.ResponseWriter, r *http.Request, requestID string, failure *denial) {
	writeError(w, failure.status, failure.code, requestID)
	p.metrics.Count(metrics.Requests, "code", failure.code)
	p.metrics.Count(metrics.Denials, "reason", failure.reason)
	// The log line names the reason and the method, and nothing the caller
	// supplied beyond them: docs/SECURITY.md section 18 forbids authorisation
	// headers, cookies and raw credentials in logs, and a refused request is
	// exactly where they would otherwise be attractive to record.
	p.logger.Warn("tunnel request refused",
		slog.String("request_id", requestID),
		slog.String("code", failure.code),
		slog.String("reason", failure.reason),
		slog.String("method", r.Method),
	)
	p.auditSink.RequestRefused(requestID, failure.code, failure.reason)
}

// authorise runs the checks of docs/SECURITY.md section 9 in a fixed order.
//
// The order matters. Nothing about the route is read before the origin has
// resolved to one, and nothing in the capability is trusted before it has been
// authenticated, so neither an unauthorised route identifier nor a forged
// capability reaches a decision.
func (p *Proxy) authorise(r *http.Request) (*registry.Route, connectorv1.CapabilityClaims, *upgradeRequest, *denial) {
	var noClaims connectorv1.CapabilityClaims

	// 1. The gateway is not a forward proxy. CONNECT and an absolute-form
	//    request target are the two ways to ask it to be one, and both are
	//    refused before anything else is considered.
	if r.Method == http.MethodConnect {
		return nil, noClaims, nil, &denial{http.StatusMethodNotAllowed, CodeUnsupportedCapability, "connect_method"}
	}
	if r.URL != nil && (r.URL.IsAbs() || r.URL.Host != "") {
		return nil, noClaims, nil, &denial{http.StatusBadRequest, CodeUnsupportedCapability, "absolute_request_target"}
	}
	if r.RequestURI == "*" {
		return nil, noClaims, nil, &denial{http.StatusBadRequest, CodeUnsupportedCapability, "asterisk_request_target"}
	}

	// 2. Exactly one Host. net/http rejects an HTTP/1.1 request with more than
	//    one Host header before this point, and the check is repeated here
	//    because the route is derived from it.
	if len(r.Header.Values("Host")) > 1 {
		return nil, noClaims, nil, &denial{http.StatusBadRequest, CodeUnsupportedCapability, "ambiguous_host_header"}
	}
	alias, ok := p.aliasFromHost(r.Host)
	if !ok {
		return nil, noClaims, nil, &denial{http.StatusNotFound, CodePublishedServiceUnavailable, "origin_not_an_internal_route"}
	}

	// 3. Exactly one capability, presented in exactly one place.
	presented := r.Header.Values(CapabilityHeader)
	if len(presented) == 0 || strings.TrimSpace(presented[0]) == "" {
		return nil, noClaims, nil, &denial{http.StatusUnauthorized, CodeAuthenticationRequired, "capability_absent"}
	}
	if len(presented) > 1 {
		return nil, noClaims, nil, &denial{http.StatusUnauthorized, CodeAuthenticationRequired, "capability_ambiguous"}
	}

	claims, capabilityErr := p.verifier.Verify(strings.TrimSpace(presented[0]), p.config.Now().Unix())
	if capabilityErr != nil {
		reason := "capability_" + string(capabilityErr.Rejection)
		if capabilityErr.Rejection == connectorv1.CapabilityRejectionExpired {
			return nil, noClaims, nil, &denial{http.StatusForbidden, CodeRouteExpired, reason}
		}
		return nil, noClaims, nil, &denial{http.StatusForbidden, CodeAuthorisationDenied, reason}
	}

	// 4. The route the origin names must exist and must still be live.
	route, found := p.routes.LookupAlias(alias)
	if !found {
		return nil, noClaims, nil, &denial{http.StatusNotFound, CodePublishedServiceUnavailable, "route_not_registered"}
	}

	// 5. The capability must be for this route, this project and a browser
	//    session the route authorises. Each is a separate rejection in the
	//    audit trail and the same answer on the wire.
	if claims.RouteID != route.RouteID {
		return nil, noClaims, nil, &denial{http.StatusForbidden, CodeAuthorisationDenied, "capability_for_another_route"}
	}
	if claims.ProjectID != route.ProjectID {
		return nil, noClaims, nil, &denial{http.StatusForbidden, CodeAuthorisationDenied, "capability_for_another_project"}
	}
	if !route.AuthorisesSession(claims.BrowserSessionID) {
		return nil, noClaims, nil, &denial{http.StatusForbidden, CodeAuthorisationDenied, "browser_session_not_authorised"}
	}
	if p.routes.CapabilityRevoked(claims.CapabilityID) {
		return nil, noClaims, nil, &denial{http.StatusForbidden, CodeRouteExpired, "capability_revoked"}
	}

	// 6. An HTTP upgrade is a different transport with different framing, and
	//    is carried only in the one form this gateway understands. It is
	//    classified here, after every authorisation check above and before any
	//    of the availability checks below, so that the upgrade path is subject
	//    to exactly the checks the ordinary path is: an upgrade is never an
	//    authorisation bypass.
	upgrade, upgradeDenial := classifyUpgrade(r)
	if upgradeDenial != nil {
		return nil, noClaims, nil, upgradeDenial
	}

	// 7. The connector must have a live data channel.
	if _, live := p.channels.Get(route.ConnectorID); !live {
		return nil, noClaims, nil, &denial{http.StatusServiceUnavailable, CodeConnectorOffline, "connector_offline"}
	}

	// 8. Per-route stream bound. An upgraded connection holds its stream for
	//    the length of a review session rather than for one exchange, so this
	//    is also the bound on how many long-lived connections one route can
	//    hold open.
	if _, _, _, active := route.Counters(); active >= int64(p.config.MaxStreamsPerRoute) {
		return nil, noClaims, nil, &denial{http.StatusTooManyRequests, CodeStreamLimitExceeded, "route_stream_limit"}
	}
	return route, claims, upgrade, nil
}

// normaliseHeaders removes, before anything resolves a route, every header a
// caller might use to claim the request was for a different origin.
//
// It is a separate step from the drop list applied when the request is
// re-serialised. That list protects the development service; this one protects
// the gateway's own routing decision, and the difference is ordering:
// docs/SECURITY.md section 9 requires header-based route confusion to be
// rejected, and a check that ran after the route had been chosen would be
// checking the wrong thing.
func (p *Proxy) normaliseHeaders(r *http.Request) {
	for _, name := range routeConfusionHeaders {
		r.Header.Del(name)
	}
	// A header value carrying CR, LF or NUL is dropped rather than escaped, in
	// both directions and on both paths. Deleting it here means the upgrade
	// path cannot carry one either.
	for name, values := range r.Header {
		for _, value := range values {
			if !isSafeHeaderValue(value) {
				r.Header.Del(name)
				break
			}
		}
	}
}

// aliasFromHost maps an internal origin to a route alias.
//
// The mapping is total and injective by construction: the host is lowercased,
// any port is dropped, any trailing dot is dropped, and what remains must be
// exactly one label followed by the configured suffix. A host with two labels
// before the suffix, an empty label or a different suffix resolves to nothing
// rather than to a best guess.
func (p *Proxy) aliasFromHost(host string) (string, bool) {
	if host == "" {
		return "", false
	}
	if hostname, _, err := net.SplitHostPort(host); err == nil {
		host = hostname
	}
	host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	suffix := "." + strings.ToLower(p.config.InternalSuffix)
	if !strings.HasSuffix(host, suffix) {
		return "", false
	}
	alias := strings.TrimSuffix(host, suffix)
	if alias == "" || strings.Contains(alias, ".") {
		return "", false
	}
	if !registry.IsDNSLabel(alias) {
		return "", false
	}
	return alias, true
}

func (p *Proxy) forward(
	w http.ResponseWriter,
	r *http.Request,
	requestID string,
	route *registry.Route,
	claims connectorv1.CapabilityClaims,
) (int, int64, int64, error) {
	session, live := p.channels.Get(route.ConnectorID)
	if !live {
		p.refuse(w, r, requestID, &denial{http.StatusServiceUnavailable, CodeConnectorOffline, "connector_offline"})
		return 0, 0, 0, nil
	}

	deadline := p.streamDeadline(route)
	stream, err := session.Open(p.streamHeader(r, requestID, route, claims, deadline, false))
	if err != nil {
		code := CodeInternalError
		reason := "stream_open_failed"
		status := http.StatusBadGateway
		var streamErr *datachannel.StreamError
		if errors.As(err, &streamErr) && streamErr.Class == connectorv1.ErrorClassStreamLimitExceeded {
			code, reason, status = CodeStreamLimitExceeded, "connector_stream_limit", http.StatusTooManyRequests
		}
		p.refuse(w, r, requestID, &denial{status, code, reason})
		return 0, 0, 0, nil
	}
	stream.SetDeadline(deadline)

	handle, attachErr := p.routes.AttachStream(route.RouteID, func(class connectorv1.ErrorClass) {
		_ = stream.Reset(class)
	})
	if attachErr != nil {
		_ = stream.Reset(connectorv1.ErrorClassRouteExpired)
		p.refuse(w, r, requestID, &denial{http.StatusNotFound, CodePublishedServiceUnavailable, "route_not_registered"})
		return 0, 0, 0, nil
	}
	p.metrics.Count(metrics.Streams, "outcome", "opened")
	defer func() {
		p.routes.DetachStream(route.RouteID, handle)
		_ = stream.Close()
	}()

	sent, err := p.writeRequest(stream, r, route, nil)
	if err != nil {
		p.finishStream(w, r, requestID, route, stream, err, sent, 0)
		return 0, sent, 0, err
	}

	response, err := readUpstreamResponse(stream, r, p.config.MaxResponseHeaderBytes)
	if err != nil {
		p.finishStream(w, r, requestID, route, stream, err, sent, 0)
		return 0, sent, 0, err
	}
	defer func() { _ = response.Body.Close() }()

	received, err := p.writeResponse(w, response)
	_, streamReceived := stream.Counters()
	p.routes.RecordBytes(route.RouteID, sent, streamReceived)
	p.metrics.Add(metrics.Bytes, float64(sent), "direction", metrics.DirectionToDestination)
	p.metrics.Add(metrics.Bytes, float64(streamReceived), "direction", metrics.DirectionFromDestination)
	if err != nil {
		p.metrics.Count(metrics.Streams, "outcome", "aborted")
		return response.StatusCode, sent, received, err
	}
	p.metrics.Count(metrics.Streams, "outcome", "completed")
	return response.StatusCode, sent, received, nil
}

// finishStream turns a stream failure into an answer, when one can still be
// sent, and records it either way.
func (p *Proxy) finishStream(
	w http.ResponseWriter,
	r *http.Request,
	requestID string,
	route *registry.Route,
	stream *datachannel.Stream,
	cause error,
	sent int64,
	received int64,
) {
	_, streamReceived := stream.Counters()
	p.routes.RecordBytes(route.RouteID, sent, streamReceived)
	p.metrics.Add(metrics.Bytes, float64(sent), "direction", metrics.DirectionToDestination)
	p.metrics.Add(metrics.Bytes, float64(streamReceived), "direction", metrics.DirectionFromDestination)
	_ = received

	failure := &denial{http.StatusBadGateway, CodeInternalError, "upstream_failed"}
	var streamErr *datachannel.StreamError
	if errors.As(cause, &streamErr) {
		switch streamErr.Class {
		case connectorv1.ErrorClassPortNotListening:
			failure = &denial{http.StatusBadGateway, CodePortNotListening, "port_not_listening"}
		case connectorv1.ErrorClassRouteExpired:
			failure = &denial{http.StatusForbidden, CodeRouteExpired, "route_ended_mid_stream"}
		case connectorv1.ErrorClassStreamLimitExceeded:
			failure = &denial{http.StatusTooManyRequests, CodeStreamLimitExceeded, "stream_limit"}
		case connectorv1.ErrorClassDestinationNotAllowed:
			failure = &denial{http.StatusForbidden, CodeDestinationNotAllowed, "destination_refused_by_connector"}
		default:
			failure = &denial{http.StatusBadGateway, CodeConnectorOffline, "connector_reset_stream"}
		}
	}
	p.metrics.Count(metrics.Streams, "outcome", "reset")
	p.refuse(w, r, requestID, failure)
}

// streamDeadline is the absolute instant a stream must be closed by.
//
// It is the earlier of the configured maximum stream lifetime and the route's
// expiry, which is docs/CONNECTOR_PROTOCOL.md section 12.3's "a stream MUST NOT
// outlive the route it belongs to" stated as arithmetic. The same rule governs
// an upgraded connection: a persistent WebSocket is not a way to hold access
// open past the route that authorised it.
func (p *Proxy) streamDeadline(route *registry.Route) time.Time {
	deadline := p.config.Now().Add(p.config.StreamMaxLifetime)
	if route.ExpiresAt.Before(deadline) {
		return route.ExpiresAt
	}
	return deadline
}

// streamHeader builds the data-stream header from the route and the
// authenticated capability. It carries no host and no port, and the schema has
// no field for one, so a destination cannot be smuggled through it
// (docs/CONNECTOR_PROTOCOL.md section 12).
func (p *Proxy) streamHeader(
	r *http.Request,
	requestID string,
	route *registry.Route,
	claims connectorv1.CapabilityClaims,
	deadline time.Time,
	upgraded bool,
) connectorv1.DataStreamHeader {
	header := connectorv1.DataStreamHeader{
		RouteID:             route.RouteID,
		BrowserSessionID:    claims.BrowserSessionID,
		SessionCapability:   connectorv1.SensitiveString(r.Header.Get(CapabilityHeader)),
		StreamID:            requestID,
		DestinationProtocol: route.Protocol,
		Deadline:            deadline.UTC().Format("2006-01-02T15:04:05Z"),
	}
	if upgraded {
		// The connector relays bytes without parsing them, so it cannot see
		// that this connection was switched to another framing. The mode is
		// declared rather than inferred, which is what lets the connector give
		// the stream the longer idle window of section 13.3 without ever
		// looking at what is flowing through it.
		mode := connectorv1.StreamModeUpgrade
		header.StreamMode = &mode
	}
	return header
}

// writeRequest re-serialises the request onto the stream.
//
// It is re-serialised rather than relayed byte for byte so that the request the
// development service sees is one this gateway constructed: origin-form target,
// one Host, no hop-by-hop headers, no forwarded headers the caller supplied and
// no capability. A relayed request would carry whatever the caller framed.
//
// upgrade is non-nil when the request is the handshake of an HTTP upgrade. The
// difference is narrow and deliberate: the connection tokens are rewritten from
// the upgrade the gateway validated rather than dropped as hop-by-hop, and no
// Content-Length is emitted, because a handshake carries no body and one is
// refused before this is reached.
func (p *Proxy) writeRequest(
	stream io.Writer,
	r *http.Request,
	route *registry.Route,
	upgrade *upgradeRequest,
) (int64, error) {
	var body []byte
	var contentLength int64
	if upgrade == nil {
		var err error
		body, contentLength, err = p.readRequestBody(r)
		if err != nil {
			return 0, err
		}
	}

	target := r.URL.RequestURI()
	if target == "" {
		target = "/"
	}
	var head strings.Builder
	head.WriteString(r.Method + " " + target + " HTTP/1.1\r\n")

	hostHeader := route.Destination()
	if p.config.HostHeader == HostOriginal {
		hostHeader = route.PublicAlias + "." + p.config.InternalSuffix
	}
	head.WriteString("Host: " + hostHeader + "\r\n")
	if upgrade != nil {
		// The two connection tokens are written from the upgrade the gateway
		// classified, not copied from the caller: the development service is
		// asked for exactly the protocol the gateway is prepared to relay.
		head.WriteString("Connection: Upgrade\r\n")
		head.WriteString("Upgrade: " + upgrade.Protocol + "\r\n")
	} else {
		// One stream carries one exchange, so the upstream connection is closed
		// after it. That keeps response framing unambiguous and means a stream
		// cannot be reused for a request the gateway never authorised.
		head.WriteString("Connection: close\r\n")
		head.WriteString("Content-Length: " + strconv.FormatInt(contentLength, 10) + "\r\n")
	}

	forwarded := http.Header{}
	if p.config.Forwarded == ForwardedStandard {
		forwarded.Set("X-Forwarded-Proto", "https")
		forwarded.Set("X-Forwarded-Host", route.PublicAlias+"."+p.config.InternalSuffix)
	}
	for name, values := range forwarded {
		for _, value := range values {
			head.WriteString(name + ": " + value + "\r\n")
		}
	}

	dropped := droppedRequestHeaders(r.Header)
	for name, values := range r.Header {
		canonical := http.CanonicalHeaderKey(name)
		if dropped[canonical] {
			continue
		}
		for _, value := range values {
			if !isSafeHeaderValue(value) {
				// A header value carrying CR or LF would let a caller inject a
				// second request into the stream. Refusing the value is the only
				// safe reading of it.
				return 0, errors.New("gatewayhttp: header value carries a line break")
			}
			head.WriteString(canonical + ": " + value + "\r\n")
		}
	}
	head.WriteString("\r\n")

	written, err := stream.Write([]byte(head.String()))
	total := int64(written)
	if err != nil {
		return total, err
	}
	if contentLength > 0 {
		count, err := stream.Write(body)
		total += int64(count)
		if err != nil {
			return total, err
		}
	}
	return total, nil
}

func (p *Proxy) readRequestBody(r *http.Request) ([]byte, int64, error) {
	if r.Body == nil {
		return nil, 0, nil
	}
	limit := p.config.MaxRequestBodyBytes
	if r.ContentLength > limit {
		return nil, 0, errors.New("gatewayhttp: request body exceeds the configured bound")
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		return nil, 0, err
	}
	if int64(len(body)) > limit {
		return nil, 0, errors.New("gatewayhttp: request body exceeds the configured bound")
	}
	return body, int64(len(body)), nil
}

func droppedRequestHeaders(header http.Header) map[string]bool {
	dropped := map[string]bool{
		"Host":           true,
		"Content-Length": true,
	}
	for _, name := range hopByHopHeaders {
		dropped[http.CanonicalHeaderKey(name)] = true
	}
	for _, name := range routeConfusionHeaders {
		dropped[http.CanonicalHeaderKey(name)] = true
	}
	// Anything a Connection header nominates is hop-by-hop for this exchange.
	for _, value := range header.Values("Connection") {
		for _, token := range strings.Split(value, ",") {
			token = strings.TrimSpace(token)
			if token != "" {
				dropped[http.CanonicalHeaderKey(token)] = true
			}
		}
	}
	// The reserved namespace, including the capability, never reaches the
	// development service.
	for name := range header {
		if strings.HasPrefix(strings.ToLower(name), "x-reviewplane-") {
			dropped[http.CanonicalHeaderKey(name)] = true
		}
	}
	return dropped
}

func isSafeHeaderValue(value string) bool {
	return !strings.ContainsAny(value, "\r\n\x00")
}

func readUpstreamResponse(stream io.Reader, r *http.Request, maxHeaderBytes int) (*http.Response, error) {
	reader := bufio.NewReaderSize(io.Reader(stream), 4096)
	response, err := http.ReadResponse(reader, r)
	if err != nil {
		return nil, err
	}
	if headerBytes(response) > maxHeaderBytes {
		_ = response.Body.Close()
		return nil, errors.New("gatewayhttp: upstream response head exceeds the configured bound")
	}
	return response, nil
}

func headerBytes(response *http.Response) int {
	total := 0
	for name, values := range response.Header {
		for _, value := range values {
			total += len(name) + len(value) + 4
		}
	}
	return total
}

func (p *Proxy) writeResponse(w http.ResponseWriter, response *http.Response) (int64, error) {
	dropped := map[string]bool{"Content-Length": true}
	for _, name := range hopByHopHeaders {
		dropped[http.CanonicalHeaderKey(name)] = true
	}
	for _, value := range response.Header.Values("Connection") {
		for _, token := range strings.Split(value, ",") {
			if trimmed := strings.TrimSpace(token); trimmed != "" {
				dropped[http.CanonicalHeaderKey(trimmed)] = true
			}
		}
	}
	for name, values := range response.Header {
		canonical := http.CanonicalHeaderKey(name)
		if dropped[canonical] {
			continue
		}
		// A development service must not be able to forge the gateway's own
		// metadata headers.
		if strings.HasPrefix(strings.ToLower(canonical), "x-reviewplane-") {
			continue
		}
		for _, value := range values {
			if isSafeHeaderValue(value) {
				w.Header().Add(canonical, value)
			}
		}
	}
	if response.ContentLength >= 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(response.ContentLength, 10))
	}
	w.WriteHeader(response.StatusCode)

	// Copying in bounded chunks and flushing each one is what makes a slow
	// consumer produce backpressure: the stream's flow-control credit is
	// returned only as these bytes are read, so the connector stops sending
	// rather than the gateway buffering.
	flusher, _ := w.(http.Flusher)
	if flusher != nil {
		// The head goes out as soon as the upstream has sent it. A development
		// server that answers immediately and then streams must not have its
		// status line held back waiting for a first body byte.
		flusher.Flush()
	}
	buffer := make([]byte, 32*1024)
	var total int64
	for {
		count, readErr := response.Body.Read(buffer)
		if count > 0 {
			written, writeErr := w.Write(buffer[:count])
			total += int64(written)
			if flusher != nil {
				flusher.Flush()
			}
			if writeErr != nil {
				return total, writeErr
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return total, nil
			}
			return total, readErr
		}
	}
}

var requestIDEncoding = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)

// newRequestID produces the correlation identifier of docs/ARCHITECTURE.md
// section 15. It is also the stream identifier, so that a log line, a metric
// and a connector-side stream all name the same thing.
func newRequestID() string {
	raw := make([]byte, 10)
	if _, err := rand.Read(raw); err != nil {
		return "req0000000000000000"
	}
	return "req" + requestIDEncoding.EncodeToString(raw)
}
