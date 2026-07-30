package gatewayhttp

import (
	"bufio"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/datachannel"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/internal/metrics"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/internal/registry"
)

// The upgrade half of the browser-facing path.
//
// docs/ARCHITECTURE.md section 7.4 makes WebSockets and development hot reload
// mandatory tunnel capabilities, and docs/CONNECTOR_PROTOCOL.md section 13.3
// fixes what that means here: the handshake is carried, the framing after it is
// relayed untouched in both directions, and closure propagates each way. The
// gateway understands the handshake and nothing beyond it — after the switch it
// is moving bytes, exactly as the connector already does, because frames on an
// upgraded connection are browser-adjacent untrusted content (ADR-0010) and
// MUST NOT influence routing.
//
// Two properties are load-bearing and are the reason this is a separate path
// rather than a flag on the ordinary one:
//
//   - Lifetime. An ordinary stream lives for one exchange; an upgraded one
//     lives for a review session. Its absolute deadline is still the route's
//     expiry, so an upgraded connection can never extend the access the route
//     authorised, and route expiry or revocation closes it (section 13.3).
//   - Framing. After 101 there is no HTTP left to parse, so the gateway must
//     stop being an HTTP server on that connection. It hijacks, writes the
//     switch itself, and relays.

// upgradeProtocolWebSocket is the only upgrade token this gateway carries.
//
// h2c is refused because HTTP/2 is deferred by docs/ARCHITECTURE.md section 7.4
// and docs/CONNECTOR_PROTOCOL.md section 5; anything else is refused because
// carrying a protocol whose framing the gateway has never seen is
// indistinguishable from being a raw TCP forwarder, which docs/SECURITY.md
// section 9 excludes permanently.
const upgradeProtocolWebSocket = "websocket"

// upgradeRequest is a classified HTTP upgrade: the token the client asked for,
// normalised to the one form the gateway relays.
type upgradeRequest struct {
	Protocol string
}

// classifyUpgrade decides whether a request is an upgrade this gateway carries.
//
// It returns (nil, nil) for an ordinary request. RFC 9110 section 7.8 makes an
// upgrade both an Upgrade header and a Connection header nominating it, and
// both are required here: a stray Upgrade header on an otherwise ordinary
// request is not an upgrade, and treating it as one would let a caller change
// how the request is framed by adding a header.
func classifyUpgrade(r *http.Request) (*upgradeRequest, *denial) {
	requested := strings.TrimSpace(r.Header.Get("Upgrade"))
	nominated := headerHasToken(r.Header, "Connection", "upgrade")
	if requested == "" && !nominated {
		return nil, nil
	}
	if requested == "" || !nominated {
		// One half of the pair without the other is malformed rather than
		// ambiguous, and is refused rather than guessed at.
		return nil, &denial{http.StatusBadRequest, CodeUnsupportedCapability, "upgrade_half_declared"}
	}
	if len(r.Header.Values("Upgrade")) > 1 || strings.Contains(requested, ",") {
		// A list of alternatives would make which protocol was carried depend
		// on the far end's choice, which the gateway would then have to trust.
		return nil, &denial{http.StatusBadRequest, CodeUnsupportedCapability, "upgrade_multiple_protocols"}
	}
	if !strings.EqualFold(requested, upgradeProtocolWebSocket) {
		return nil, &denial{http.StatusNotImplemented, CodeUnsupportedCapability, "upgrade_protocol_unsupported"}
	}
	if r.Method != http.MethodGet {
		return nil, &denial{http.StatusMethodNotAllowed, CodeUnsupportedCapability, "upgrade_method_not_get"}
	}
	if r.ContentLength > 0 {
		// A handshake carries no body. One that does is either a client bug or
		// an attempt to pipeline a second request behind the switch, and the
		// gateway has no way to tell them apart.
		return nil, &denial{http.StatusBadRequest, CodeUnsupportedCapability, "upgrade_with_body"}
	}
	return &upgradeRequest{Protocol: upgradeProtocolWebSocket}, nil
}

func headerHasToken(header http.Header, name, token string) bool {
	for _, value := range header.Values(name) {
		for _, candidate := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(candidate), token) {
				return true
			}
		}
	}
	return false
}

// forwardUpgrade carries an upgrade handshake to the development service and,
// if it succeeds, relays the switched connection until either end closes it.
func (p *Proxy) forwardUpgrade(
	w http.ResponseWriter,
	r *http.Request,
	requestID string,
	route *registry.Route,
	claims connectorv1.CapabilityClaims,
	upgrade upgradeRequest,
	started time.Time,
) {
	session, live := p.channels.Get(route.ConnectorID)
	if !live {
		p.refuse(w, r, requestID, &denial{http.StatusServiceUnavailable, CodeConnectorOffline, "connector_offline"})
		return
	}
	p.metrics.Count(metrics.Upgrades, "outcome", "requested")

	deadline := p.streamDeadline(route)
	stream, err := session.Open(p.streamHeader(r, requestID, route, claims, deadline, true))
	if err != nil {
		code := CodeInternalError
		reason := "stream_open_failed"
		status := http.StatusBadGateway
		var streamErr *datachannel.StreamError
		if errors.As(err, &streamErr) && streamErr.Class == connectorv1.ErrorClassStreamLimitExceeded {
			code, reason, status = CodeStreamLimitExceeded, "connector_stream_limit", http.StatusTooManyRequests
		}
		p.metrics.Count(metrics.Upgrades, "outcome", "refused")
		p.refuse(w, r, requestID, &denial{status, code, reason})
		return
	}
	stream.SetPolicyDeadline(deadline)

	// The terminator is what makes revocation reach a connection that is
	// already switched. docs/ARCHITECTURE.md section 7.3 requires a route to be
	// revocable immediately, and an upgraded connection that survived its
	// route's revocation would make that only a revocation of future requests.
	handle, attachErr := p.routes.AttachStream(route.RouteID, func(class connectorv1.ErrorClass) {
		_ = stream.Reset(class)
	})
	if attachErr != nil {
		_ = stream.Reset(connectorv1.ErrorClassRouteExpired)
		p.metrics.Count(metrics.Upgrades, "outcome", "refused")
		p.refuse(w, r, requestID, &denial{http.StatusNotFound, CodePublishedServiceUnavailable, "route_not_registered"})
		return
	}
	p.metrics.Count(metrics.Streams, "outcome", "opened")
	defer func() {
		p.routes.DetachStream(route.RouteID, handle)
		_ = stream.Close()
	}()

	sent, err := p.writeRequest(stream, r, route, &upgrade)
	if err != nil {
		p.metrics.Count(metrics.Upgrades, "outcome", "failed")
		p.finishStream(w, r, requestID, route, stream, err, sent, 0)
		return
	}

	// The response head is read through a buffered reader that may also hold
	// the first bytes the development service sent after it. Those bytes are
	// not re-read from the stream later; the relay reads through this same
	// reader, which is what stops a first WebSocket frame arriving inside the
	// handshake read from being silently dropped.
	upstream := bufio.NewReaderSize(stream, 4096)
	response, err := http.ReadResponse(upstream, r)
	if err != nil {
		p.metrics.Count(metrics.Upgrades, "outcome", "failed")
		p.finishStream(w, r, requestID, route, stream, err, sent, 0)
		return
	}
	if headerBytes(response) > p.config.MaxResponseHeaderBytes {
		_ = response.Body.Close()
		p.metrics.Count(metrics.Upgrades, "outcome", "failed")
		p.finishStream(w, r, requestID, route, stream, errors.New(
			"gatewayhttp: upstream upgrade response head exceeds the configured bound"), sent, 0)
		return
	}

	if response.StatusCode != http.StatusSwitchingProtocols {
		// The development service refused the upgrade. Its answer is a
		// perfectly ordinary HTTP response and is delivered as one: a gateway
		// that turned a refusal into an error of its own would hide which end
		// said no.
		defer func() { _ = response.Body.Close() }()
		received, writeErr := p.writeResponse(w, response)
		p.recordUpgradeBytes(route, stream, sent)
		p.metrics.Count(metrics.Upgrades, "outcome", "declined_by_destination")
		p.metrics.Count(metrics.Streams, "outcome", "completed")
		p.logger.Info("tunnel upgrade declined by the development service",
			slog.String("request_id", requestID),
			slog.String("route_id", route.RouteID),
			slog.String("project_id", route.ProjectID),
			slog.String("browser_session_id", claims.BrowserSessionID),
			slog.Int("status", response.StatusCode),
			slog.Int64("bytes_from_destination", received),
			slog.Duration("duration", p.config.Now().Sub(started)),
		)
		if writeErr == nil {
			p.metrics.Count(metrics.Requests, "code", "ok")
		}
		return
	}

	client, buffered, hijackErr := http.NewResponseController(w).Hijack()
	if hijackErr != nil {
		p.metrics.Count(metrics.Upgrades, "outcome", "failed")
		p.finishStream(w, r, requestID, route, stream, hijackErr, sent, 0)
		return
	}
	defer func() { _ = client.Close() }()

	if err := writeSwitchingProtocols(client, response); err != nil {
		p.metrics.Count(metrics.Upgrades, "outcome", "failed")
		p.metrics.Count(metrics.Streams, "outcome", "aborted")
		p.recordUpgradeBytes(route, stream, sent)
		return
	}

	// The connection may not outlive its route, and after the hijack net/http
	// enforces nothing on it. The deadline is the stream's, which is already
	// clipped to the route's expiry.
	//
	// It is a policy instant and this is a real socket, so what crosses is the
	// lifetime still remaining rather than the instant itself. The two agree
	// whenever the injected clock is the real one, which is every deployment;
	// they do not agree under a test clock, and a socket cannot be told about a
	// test clock.
	_ = client.SetDeadline(datachannel.SocketDeadline(deadline, p.config.Now))

	p.metrics.Count(metrics.Upgrades, "outcome", "switched")
	p.metrics.SetGauge(metrics.UpgradesActive, float64(p.upgradesOpen.Add(1)))
	p.logger.Info("tunnel upgrade established",
		slog.String("request_id", requestID),
		slog.String("route_id", route.RouteID),
		slog.String("project_id", route.ProjectID),
		slog.String("browser_session_id", claims.BrowserSessionID),
		slog.String("protocol", upgrade.Protocol),
		slog.Duration("idle_timeout", stream.IdleTimeout()),
		slog.Time("deadline", deadline),
	)

	toDestination, fromDestination, cause := p.relay(client, buffered.Reader, stream, upstream)
	p.metrics.SetGauge(metrics.UpgradesActive, float64(p.upgradesOpen.Add(-1)))

	total := sent + toDestination
	p.routes.RecordBytes(route.RouteID, total, fromDestination)
	p.metrics.Add(metrics.Bytes, float64(total), "direction", metrics.DirectionToDestination)
	p.metrics.Add(metrics.Bytes, float64(fromDestination), "direction", metrics.DirectionFromDestination)

	outcome := "closed"
	var streamErr *datachannel.StreamError
	if errors.As(cause, &streamErr) {
		outcome = "reset"
	}
	p.metrics.Count(metrics.Upgrades, "outcome", outcome)
	p.metrics.Count(metrics.Streams, "outcome", "completed")
	p.metrics.Count(metrics.Requests, "code", "ok")
	p.logger.Info("tunnel upgrade closed",
		slog.String("request_id", requestID),
		slog.String("route_id", route.RouteID),
		slog.String("project_id", route.ProjectID),
		slog.String("browser_session_id", claims.BrowserSessionID),
		slog.String("outcome", outcome),
		slog.Int64("bytes_to_destination", total),
		slog.Int64("bytes_from_destination", fromDestination),
		slog.Duration("duration", p.config.Now().Sub(started)),
	)
}

func (p *Proxy) recordUpgradeBytes(route *registry.Route, stream *datachannel.Stream, sent int64) {
	_, received := stream.Counters()
	p.routes.RecordBytes(route.RouteID, sent, received)
	p.metrics.Add(metrics.Bytes, float64(sent), "direction", metrics.DirectionToDestination)
	p.metrics.Add(metrics.Bytes, float64(received), "direction", metrics.DirectionFromDestination)
}

// writeSwitchingProtocols re-serialises the 101 onto the hijacked connection.
//
// It is written by hand for the same reason the request is: the response the
// browser sees is one this gateway constructed. The upgrade's own connection
// headers are kept, because dropping them as hop-by-hop would leave a 101 that
// no client accepts, and the reserved namespace is still removed, so a
// development service cannot forge the gateway's own metadata on the way out.
// Sec-WebSocket-Accept is the development service's, computed from the key the
// browser sent and relayed unchanged, so the browser validates the handshake
// against the far end rather than against the gateway.
func writeSwitchingProtocols(client io.Writer, response *http.Response) error {
	var head strings.Builder
	head.WriteString("HTTP/1.1 101 Switching Protocols\r\n")
	for name, values := range response.Header {
		canonical := http.CanonicalHeaderKey(name)
		switch canonical {
		case "Content-Length", "Transfer-Encoding":
			continue
		}
		if strings.HasPrefix(strings.ToLower(canonical), "x-reviewplane-") {
			continue
		}
		for _, value := range values {
			if !isSafeHeaderValue(value) {
				continue
			}
			head.WriteString(canonical + ": " + value + "\r\n")
		}
	}
	head.WriteString("\r\n")
	_, err := io.WriteString(client, head.String())
	return err
}

// relay moves bytes both ways until either end finishes, then ends the other.
//
// Memory is bounded by construction: one copy buffer per direction, and beyond
// them the stream's flow-control window, which is returned only as bytes are
// consumed (docs/CONNECTOR_PROTOCOL.md section 12.2). A browser that stops
// reading therefore stops the development service rather than filling a queue
// here, and a development service that floods stops itself.
func (p *Proxy) relay(
	client net.Conn,
	fromClient io.Reader,
	stream *datachannel.Stream,
	fromDestination io.Reader,
) (int64, int64, error) {
	type result struct {
		copied int64
		err    error
	}
	toDestination := make(chan result, 1)
	toClient := make(chan result, 1)

	go func() {
		copied, err := io.CopyBuffer(stream, fromClient, make([]byte, p.config.RelayBufferBytes))
		// The development service learns that the browser has finished, which
		// is how a browser-side close reaches it rather than being swallowed.
		_ = stream.CloseWrite()
		toDestination <- result{copied, err}
	}()
	go func() {
		copied, err := io.CopyBuffer(client, fromDestination, make([]byte, p.config.RelayBufferBytes))
		toClient <- result{copied, err}
	}()

	var sent, received int64
	var cause error
	// Whichever direction ends first ends the connection. On an upgraded
	// connection the two directions are one conversation, not a request and an
	// answer, so a half that kept running after the other had gone would be
	// holding a stream open for a peer that is no longer there.
	select {
	case first := <-toDestination:
		sent, cause = first.copied, first.err
		_ = client.Close()
		_ = stream.Close()
		second := <-toClient
		received = second.copied
		if cause == nil {
			cause = second.err
		}
	case first := <-toClient:
		received, cause = first.copied, first.err
		_ = client.Close()
		_ = stream.Close()
		second := <-toDestination
		sent = second.copied
		if cause == nil {
			cause = second.err
		}
	}
	return sent, received, cause
}
