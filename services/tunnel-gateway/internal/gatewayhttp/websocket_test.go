package gatewayhttp

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/danjonesio/reviewplane/services/tunnel-gateway/datachannel"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/internal/metrics"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/internal/registry"
)

// A WebSocket client and a WebSocket development server, written here rather
// than taken from services/tunnel-gateway/wsx.
//
// wsx is deliberately not a general WebSocket implementation: it pins the
// connector data channel's subprotocol, refuses text messages and refuses every
// extension, because that is the whole surface the data channel needs. What
// these tests need is the opposite — an ordinary browser-shaped client and an
// ordinary development server — including the malformed handshakes and frames
// that must be refused without a panic. Reusing wsx would test wsx's opinions
// rather than the gateway's behaviour, and could not express the failures at
// all.

const websocketGUID = "258EAFA5-E914-47DA-95CA-5AB0DC85B11F"

const (
	wsOpcodeText  = 0x1
	wsOpcodeClose = 0x8
	wsOpcodePing  = 0x9
	wsOpcodePong  = 0xa
)

// wsConn is one end of a WebSocket connection over a raw socket.
type wsConn struct {
	conn   net.Conn
	reader *bufio.Reader
	// client masks its frames; a server must not (RFC 6455 section 5.1).
	client bool
}

type wsFrame struct {
	opcode  byte
	payload []byte
}

func (c *wsConn) write(opcode byte, payload []byte) error {
	header := []byte{0x80 | opcode}
	mask := byte(0)
	if c.client {
		mask = 0x80
	}
	switch {
	case len(payload) < 126:
		header = append(header, mask|byte(len(payload)))
	default:
		header = append(header, mask|126)
		header = binary.BigEndian.AppendUint16(header, uint16(len(payload)))
	}
	body := payload
	if c.client {
		var key [4]byte
		if _, err := rand.Read(key[:]); err != nil {
			return err
		}
		header = append(header, key[:]...)
		body = make([]byte, len(payload))
		for index := range payload {
			body[index] = payload[index] ^ key[index%4]
		}
	}
	_, err := c.conn.Write(append(header, body...))
	return err
}

func (c *wsConn) read() (wsFrame, error) {
	var head [2]byte
	if _, err := io.ReadFull(c.reader, head[:]); err != nil {
		return wsFrame{}, err
	}
	opcode := head[0] & 0x0f
	masked := head[1]&0x80 != 0
	length := int(head[1] & 0x7f)
	switch length {
	case 126:
		var extended [2]byte
		if _, err := io.ReadFull(c.reader, extended[:]); err != nil {
			return wsFrame{}, err
		}
		length = int(binary.BigEndian.Uint16(extended[:]))
	case 127:
		return wsFrame{}, errors.New("test websocket: 64-bit lengths are not used here")
	}
	if length > 1<<20 {
		return wsFrame{}, errors.New("test websocket: frame exceeds the test bound")
	}
	var key [4]byte
	if masked {
		if _, err := io.ReadFull(c.reader, key[:]); err != nil {
			return wsFrame{}, err
		}
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(c.reader, payload); err != nil {
		return wsFrame{}, err
	}
	if masked {
		for index := range payload {
			payload[index] ^= key[index%4]
		}
	}
	return wsFrame{opcode: opcode, payload: payload}, nil
}

func (c *wsConn) writeText(text string) error { return c.write(wsOpcodeText, []byte(text)) }

func (c *wsConn) writeClose(code int, reason string) error {
	payload := binary.BigEndian.AppendUint16(nil, uint16(code))
	return c.write(wsOpcodeClose, append(payload, reason...))
}

func closeCode(frame wsFrame) int {
	if frame.opcode != wsOpcodeClose || len(frame.payload) < 2 {
		return 0
	}
	return int(binary.BigEndian.Uint16(frame.payload[:2]))
}

// echoWebSocketHandler is a development server that speaks WebSocket.
//
// It answers a text frame with "echo:" and the same text, answers a ping with a
// pong, mirrors a close frame back and closes, and closes on its own when it is
// told to, which is how a dev-server-initiated close is exercised. onOpen, when
// set, is called once the handshake has completed.
func echoWebSocketHandler(t *testing.T, onOpen func(*wsConn)) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("Sec-WebSocket-Key")
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || key == "" {
			http.Error(w, "not a websocket handshake", http.StatusBadRequest)
			return
		}
		conn, buffered, err := http.NewResponseController(w).Hijack()
		if err != nil {
			t.Errorf("development server could not hijack: %v", err)
			return
		}
		defer func() { _ = conn.Close() }()

		sum := sha1.Sum([]byte(key + websocketGUID))
		head := "HTTP/1.1 101 Switching Protocols\r\n" +
			"Upgrade: websocket\r\n" +
			"Connection: Upgrade\r\n" +
			"Sec-WebSocket-Accept: " + base64.StdEncoding.EncodeToString(sum[:]) + "\r\n"
		if offered := r.Header.Get("Sec-WebSocket-Protocol"); offered != "" {
			head += "Sec-WebSocket-Protocol: " + strings.TrimSpace(strings.Split(offered, ",")[0]) + "\r\n"
		}
		head += "\r\n"
		if _, err := io.WriteString(conn, head); err != nil {
			return
		}

		server := &wsConn{conn: conn, reader: buffered.Reader}
		if onOpen != nil {
			onOpen(server)
		}
		for {
			frame, err := server.read()
			if err != nil {
				return
			}
			switch frame.opcode {
			case wsOpcodeText:
				if string(frame.payload) == "close-me" {
					_ = server.writeClose(1000, "server-initiated")
					return
				}
				if err := server.writeText("echo:" + string(frame.payload)); err != nil {
					return
				}
			case wsOpcodePing:
				if err := server.write(wsOpcodePong, frame.payload); err != nil {
					return
				}
			case wsOpcodeClose:
				_ = server.write(wsOpcodeClose, frame.payload)
				return
			}
		}
	}
}

type upgradeAttempt struct {
	path       string
	host       string
	capability string
	headers    http.Header
	// protocol overrides the Upgrade token.
	protocol string
}

// openUpgrade performs the handshake against the gateway over a raw socket.
//
// It is raw rather than through net/http's client because the request has to
// carry a Host that is not the address dialled, and because the tests below
// need to see the exact response bytes when the gateway refuses.
func (h *harness) openUpgrade(attempt upgradeAttempt) (*wsConn, *http.Response) {
	h.t.Helper()
	address := strings.TrimPrefix(h.proxy.URL, "http://")
	conn, err := net.DialTimeout("tcp", address, 5*time.Second)
	if err != nil {
		h.t.Fatalf("dial the gateway: %v", err)
	}
	h.t.Cleanup(func() { _ = conn.Close() })

	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		h.t.Fatalf("generate handshake key: %v", err)
	}
	key := base64.StdEncoding.EncodeToString(nonce)

	host := attempt.host
	if host == "" {
		host = testAlias + "." + testSuffix
	}
	path := attempt.path
	if path == "" {
		path = "/"
	}
	protocol := attempt.protocol
	if protocol == "" {
		protocol = "websocket"
	}
	head := "GET " + path + " HTTP/1.1\r\n" +
		"Host: " + host + "\r\n" +
		"Upgrade: " + protocol + "\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Version: 13\r\n" +
		"Sec-WebSocket-Key: " + key + "\r\n"
	if attempt.capability != "" {
		head += CapabilityHeader + ": " + attempt.capability + "\r\n"
	}
	for name, values := range attempt.headers {
		for _, value := range values {
			head += name + ": " + value + "\r\n"
		}
	}
	head += "\r\n"
	if _, err := io.WriteString(conn, head); err != nil {
		h.t.Fatalf("write handshake: %v", err)
	}

	reader := bufio.NewReaderSize(conn, 4096)
	response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodGet})
	if err != nil {
		h.t.Fatalf("read handshake response: %v", err)
	}
	if response.StatusCode != http.StatusSwitchingProtocols {
		return nil, response
	}
	if response.Header.Get("Sec-WebSocket-Accept") != expectedAccept(key) {
		h.t.Fatal("the handshake response does not confirm the key the browser sent")
	}
	return &wsConn{conn: conn, reader: reader, client: true}, response
}

func expectedAccept(key string) string {
	sum := sha1.Sum([]byte(key + websocketGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

func (h *harness) mustOpenUpgrade(attempt upgradeAttempt) *wsConn {
	h.t.Helper()
	socket, response := h.openUpgrade(attempt)
	if socket == nil {
		h.t.Fatalf("the upgrade was refused with %d %s",
			response.StatusCode, response.Header.Get(ErrorCodeHeader))
	}
	return socket
}

func TestAWebSocketCarriesFramesInBothDirections(t *testing.T) {
	// docs/ARCHITECTURE.md section 7.4 lists WebSockets as a mandatory tunnel
	// capability, and docs/TESTING.md section 6 asks for an echo through the
	// route. Every hop is real: a gateway, a data channel, a connector and a
	// development server that speaks WebSocket.
	h := newHarness(t, harnessOptions{devHandler: echoWebSocketHandler(t, nil)})
	h.publish(RegisterRequest{})

	socket := h.mustOpenUpgrade(upgradeAttempt{capability: h.defaultCapability()})
	for _, message := range []string{"hello", "again", strings.Repeat("x", 4096)} {
		if err := socket.writeText(message); err != nil {
			t.Fatalf("write %q: %v", message[:5], err)
		}
		frame, err := socket.read()
		if err != nil {
			t.Fatalf("read echo: %v", err)
		}
		if frame.opcode != wsOpcodeText || string(frame.payload) != "echo:"+message {
			t.Fatalf("echo returned opcode %d and %d bytes", frame.opcode, len(frame.payload))
		}
	}

	// A ping and its pong prove control frames survive the relay untouched.
	if err := socket.write(wsOpcodePing, []byte("ping")); err != nil {
		t.Fatalf("ping: %v", err)
	}
	frame, err := socket.read()
	if err != nil {
		t.Fatalf("read pong: %v", err)
	}
	if frame.opcode != wsOpcodePong || string(frame.payload) != "ping" {
		t.Fatalf("pong returned opcode %d payload %q", frame.opcode, frame.payload)
	}
}

func TestABrowserInitiatedCloseIsMirroredByTheDevelopmentService(t *testing.T) {
	h := newHarness(t, harnessOptions{devHandler: echoWebSocketHandler(t, nil)})
	h.publish(RegisterRequest{})
	socket := h.mustOpenUpgrade(upgradeAttempt{capability: h.defaultCapability()})

	if err := socket.writeClose(1000, "bye"); err != nil {
		t.Fatalf("close: %v", err)
	}
	frame, err := socket.read()
	if err != nil {
		t.Fatalf("read close: %v", err)
	}
	if code := closeCode(frame); code != 1000 {
		t.Fatalf("the development service answered close code %d, want 1000", code)
	}
	// The socket is then closed by the far end, which the browser sees as EOF.
	if _, err := socket.read(); err == nil {
		t.Fatal("the connection stayed open after both close frames")
	}
}

func TestAServerInitiatedCloseReachesTheBrowser(t *testing.T) {
	// The fault-injection case of docs/TESTING.md section 11: the development
	// server closes the WebSocket, and the closure propagates with the right
	// semantics rather than as a silent hang.
	h := newHarness(t, harnessOptions{devHandler: echoWebSocketHandler(t, nil)})
	h.publish(RegisterRequest{})
	socket := h.mustOpenUpgrade(upgradeAttempt{capability: h.defaultCapability()})

	if err := socket.writeText("close-me"); err != nil {
		t.Fatalf("write: %v", err)
	}
	frame, err := socket.read()
	if err != nil {
		t.Fatalf("read close: %v", err)
	}
	if code := closeCode(frame); code != 1000 {
		t.Fatalf("close code %d, want 1000", code)
	}
	if reason := string(frame.payload[2:]); reason != "server-initiated" {
		t.Fatalf("close reason %q", reason)
	}
	_ = socket.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := socket.read(); err == nil {
		t.Fatal("the browser side stayed open after the development service closed")
	}
}

func TestRouteRevocationClosesAnAlreadyUpgradedConnection(t *testing.T) {
	// docs/ARCHITECTURE.md section 7.3 requires immediate revocation, and
	// docs/CONNECTOR_PROTOCOL.md section 13.3 states what that means for a
	// connection that is already switched. A persistent WebSocket MUST NOT be a
	// way to hold access open past the route that authorised it.
	h := newHarness(t, harnessOptions{devHandler: echoWebSocketHandler(t, nil)})
	h.publish(RegisterRequest{})
	socket := h.mustOpenUpgrade(upgradeAttempt{capability: h.defaultCapability()})

	if err := socket.writeText("still here"); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := socket.read(); err != nil {
		t.Fatalf("read echo: %v", err)
	}

	h.gateway.Routes().Revoke(testRouteID, registry.ReasonRevoked)

	_ = socket.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := socket.read(); err == nil {
		t.Fatal("an upgraded connection survived the revocation of its route")
	}
}

func TestRouteExpiryClosesAnAlreadyUpgradedConnection(t *testing.T) {
	h := newHarness(t, harnessOptions{devHandler: echoWebSocketHandler(t, nil)})
	registration := h.defaultRegistration()
	registration.ExpiresAt = h.clock.Now().Add(2 * time.Minute).Format(time.RFC3339)
	h.publish(registration)
	socket := h.mustOpenUpgrade(upgradeAttempt{capability: h.defaultCapability()})

	h.clock.advance(3 * time.Minute)
	if expired, _ := h.gateway.Sweep(h.clock.Now()); expired != 1 {
		t.Fatalf("the sweep expired %d routes, want 1", expired)
	}
	_ = socket.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := socket.read(); err == nil {
		t.Fatal("an upgraded connection survived its route's expiry")
	}
}

func TestAnUpgradedConnectionSurvivesALongEditingPause(t *testing.T) {
	// The hot-reload case. A WebSocket carrying no traffic while a developer
	// reads code MUST NOT be closed by the tunnel: the page would then be stale
	// while still looking live, which is the correctness failure this issue
	// exists to remove. The request/response idle window is deliberately tiny
	// here, so a stream that took the wrong window would be closed at once.
	h := newHarness(t, harnessOptions{
		devHandler: echoWebSocketHandler(t, nil),
		sessionCfg: datachannel.SessionConfig{
			IdleTimeout:        time.Second,
			UpgradeIdleTimeout: 30 * time.Minute,
		},
	})
	registration := h.defaultRegistration()
	registration.ExpiresAt = h.clock.Now().Add(8 * time.Hour).Format(time.RFC3339)
	h.publish(registration)
	socket := h.mustOpenUpgrade(upgradeAttempt{capability: h.defaultCapability()})

	// Twenty minutes of silence: far beyond the request/response window and
	// inside the upgrade one.
	h.clock.advance(20 * time.Minute)
	if _, closed := h.gateway.Sweep(h.clock.Now()); closed != 0 {
		t.Fatalf("the sweep closed %d streams during an editing pause", closed)
	}
	if err := socket.writeText("back"); err != nil {
		t.Fatalf("write after the pause: %v", err)
	}
	frame, err := socket.read()
	if err != nil {
		t.Fatalf("read after the pause: %v", err)
	}
	if string(frame.payload) != "echo:back" {
		t.Fatalf("after the pause the echo was %q", frame.payload)
	}

	// Past the upgrade window it is closed, so the longer window is a window
	// and not an exemption.
	h.clock.advance(31 * time.Minute)
	if _, closed := h.gateway.Sweep(h.clock.Now()); closed != 1 {
		t.Fatal("a stream idle beyond the upgrade window was not closed")
	}
}

func TestTheUpgradeHandshakeIsNormalisedLikeAnyOtherRequest(t *testing.T) {
	// docs/CONNECTOR_PROTOCOL.md section 13.1's rules are not suspended for an
	// upgrade: the caller's forwarded headers are gone, the gateway's own are
	// present, the capability never reaches the development service, and the
	// upgrade tokens are the ones the gateway validated.
	received := make(chan http.Header, 1)
	h := newHarness(t, harnessOptions{devHandler: func(w http.ResponseWriter, r *http.Request) {
		received <- r.Header.Clone()
		echoWebSocketHandler(t, nil)(w, r)
	}})
	h.publish(RegisterRequest{})
	socket := h.mustOpenUpgrade(upgradeAttempt{
		capability: h.defaultCapability(),
		headers: http.Header{
			"X-Forwarded-Host":  []string{"attacker.internal.invalid"},
			"X-Forwarded-Proto": []string{"http"},
			"X-Real-Ip":         []string{"10.0.0.1"},
			"Origin":            []string{"https://" + testAlias + "." + testSuffix},
		},
	})
	defer func() { _ = socket.conn.Close() }()

	header := <-received
	if got := header.Get("X-Forwarded-Host"); got != testAlias+"."+testSuffix {
		t.Fatalf("X-Forwarded-Host reached the development service as %q", got)
	}
	if got := header.Get("X-Forwarded-Proto"); got != "https" {
		t.Fatalf("X-Forwarded-Proto reached the development service as %q", got)
	}
	if header.Get("X-Real-Ip") != "" {
		t.Fatal("a route-confusion header reached the development service")
	}
	if header.Get(CapabilityHeader) != "" {
		t.Fatal("the capability reached the development service")
	}
	if got := header.Get("Origin"); got != "https://"+testAlias+"."+testSuffix {
		t.Fatalf("Origin was rewritten to %q; section 13.1 forwards it unchanged", got)
	}
	if !strings.EqualFold(header.Get("Upgrade"), "websocket") {
		t.Fatalf("the development service was asked to upgrade to %q", header.Get("Upgrade"))
	}
	if header.Get("Content-Length") != "" {
		t.Fatal("the handshake carried a Content-Length")
	}
}

func TestAnUpgradeTheDevelopmentServiceRefusesIsDeliveredAsAnOrdinaryResponse(t *testing.T) {
	// A gateway that turned the development service's refusal into an error of
	// its own would hide which end said no.
	h := newHarness(t, harnessOptions{devHandler: func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, "this development server refuses websockets")
	}})
	h.publish(RegisterRequest{})

	socket, response := h.openUpgrade(upgradeAttempt{capability: h.defaultCapability()})
	if socket != nil {
		t.Fatal("the gateway switched protocols on a refused handshake")
	}
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("status %d, want the development service's 403", response.StatusCode)
	}
	if response.Header.Get(ErrorCodeHeader) != "" {
		t.Fatal("the gateway replaced the development service's refusal with one of its own")
	}
	body := readBody(t, response)
	if !strings.Contains(body, "refuses websockets") {
		t.Fatalf("the development service's own body was not delivered: %q", body)
	}
}

func TestAMalformedFrameOnAnUpgradedConnectionDoesNotPanicTheGateway(t *testing.T) {
	// After the switch the gateway is moving bytes, so a malformed frame is the
	// development service's business, not the gateway's. What MUST hold is that
	// nothing here can take the gateway down: docs/TESTING.md section 6 asks for
	// malformed frames, and the assertion is that the gateway is still serving
	// afterwards.
	h := newHarness(t, harnessOptions{devHandler: func(w http.ResponseWriter, r *http.Request) {
		if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			echoWebSocketHandler(t, nil)(w, r)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ordinary response")
	}})
	h.publish(RegisterRequest{})

	socket := h.mustOpenUpgrade(upgradeAttempt{capability: h.defaultCapability()})
	// A reserved opcode, a frame claiming 64 KiB it does not send, and a
	// truncated header. Each is written straight onto the switched connection.
	if _, err := socket.conn.Write([]byte{0x8f, 0x80, 0, 0, 0, 0}); err != nil {
		t.Fatalf("write reserved opcode: %v", err)
	}
	if _, err := socket.conn.Write([]byte{0x81, 0xfe, 0xff, 0xff, 0, 0, 0, 0, 'x'}); err != nil {
		t.Fatalf("write oversized frame: %v", err)
	}
	if _, err := socket.conn.Write([]byte{0x81}); err != nil {
		t.Fatalf("write truncated frame: %v", err)
	}
	_ = socket.conn.Close()

	// The gateway is still serving, on the same route, over the same channel.
	response := h.browse(browserRequest{capability: h.defaultCapability()})
	body := readBody(t, response)
	if response.StatusCode != http.StatusOK || !strings.Contains(body, "ordinary response") {
		t.Fatalf("after malformed frames the gateway answered %d %q", response.StatusCode, body)
	}
}

func TestUpgradesAreCountedInTheGatewayMetrics(t *testing.T) {
	h := newHarness(t, harnessOptions{devHandler: echoWebSocketHandler(t, nil)})
	h.publish(RegisterRequest{})
	socket := h.mustOpenUpgrade(upgradeAttempt{capability: h.defaultCapability()})

	if err := socket.writeText("counted"); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := socket.read(); err != nil {
		t.Fatalf("read: %v", err)
	}
	waitFor(t, "the upgrade gauge to record one open connection", func() bool {
		return h.gateway.Metrics().Value(metrics.UpgradesActive) == 1
	})
	text := h.metricsText()
	for _, want := range []string{
		`reviewplane_tunnel_upgrades_total{outcome="requested"} 1`,
		`reviewplane_tunnel_upgrades_total{outcome="switched"} 1`,
		"reviewplane_tunnel_upgrades_open 1",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("the metrics do not carry %q:\n%s", want, text)
		}
	}

	_ = socket.writeClose(1000, "done")
	waitFor(t, "the upgrade gauge to fall back to zero", func() bool {
		return h.gateway.Metrics().Value(metrics.UpgradesActive) == 0
	})
	if bytes := h.gateway.Metrics().Value(metrics.Bytes, "direction", metrics.DirectionFromDestination); bytes <= 0 {
		t.Fatal("an upgraded connection recorded no bytes from the destination")
	}
}

func TestTheStreamLimitAppliesToUpgradedConnections(t *testing.T) {
	// An upgraded connection holds its stream for a review session, so the
	// per-route bound is also the bound on long-lived connections. Exceeding it
	// is STREAM_LIMIT_EXCEEDED (docs/CONNECTOR_PROTOCOL.md section 21).
	h := newHarness(t, harnessOptions{
		devHandler: echoWebSocketHandler(t, nil),
		proxyCfg:   ProxyConfig{MaxStreamsPerRoute: 2},
	})
	h.publish(RegisterRequest{})

	for attempt := 0; attempt < 2; attempt++ {
		socket := h.mustOpenUpgrade(upgradeAttempt{capability: h.defaultCapability()})
		if err := socket.writeText("open"); err != nil {
			t.Fatalf("write: %v", err)
		}
		if _, err := socket.read(); err != nil {
			t.Fatalf("read: %v", err)
		}
	}
	socket, response := h.openUpgrade(upgradeAttempt{capability: h.defaultCapability()})
	if socket != nil {
		t.Fatal("a third upgraded connection was accepted past the route's stream limit")
	}
	assertCode(t, response, http.StatusTooManyRequests, CodeStreamLimitExceeded)
}

func TestConnectorDisconnectDuringAnUpgradedConnectionClosesIt(t *testing.T) {
	// docs/TESTING.md section 11: the connector goes away mid-connection, and
	// the browser sees a close rather than a connection that hangs for ever.
	h := newHarness(t, harnessOptions{devHandler: echoWebSocketHandler(t, nil)})
	h.publish(RegisterRequest{})
	socket := h.mustOpenUpgrade(upgradeAttempt{capability: h.defaultCapability()})
	if err := socket.writeText("before"); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := socket.read(); err != nil {
		t.Fatalf("read: %v", err)
	}

	h.session.Close(errors.New("test: the connector went away"))

	_ = socket.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := socket.read(); err == nil {
		t.Fatal("the upgraded connection outlived its data channel")
	}
	// The route is then unreachable with a stable code rather than a hang.
	response := h.browse(browserRequest{capability: h.defaultCapability()})
	assertCode(t, response, http.StatusServiceUnavailable, CodeConnectorOffline)
}
