// Package ws is a bounded RFC 6455 WebSocket implementation for the connector's
// outbound control channel.
//
// docs/CONNECTOR_PROTOCOL.md section 3 packages the connector as a statically
// linked binary and docs/SECURITY.md section 19 governs its supply chain, so it
// carries no third-party dependency. The standard library has no WebSocket
// client, and the connector needs a small, auditable one: outbound dial only,
// one message at a time, every allocation bounded before it is made
// (docs/DEVELOPMENT.md section 10, docs/CONNECTOR_PROTOCOL.md section 22).
//
// Deliberately absent: compression extensions, subprotocol negotiation, and any
// form of listening socket. Accept exists for tests and for a future
// control-plane-side Go component; it upgrades a connection the caller already
// owns and never opens one.
package ws

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1" // #nosec G505 -- required by RFC 6455 for the handshake accept value
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Opcodes defined by RFC 6455 section 5.2.
const (
	OpContinuation byte = 0x0
	OpText         byte = 0x1
	OpBinary       byte = 0x2
	OpClose        byte = 0x8
	OpPing         byte = 0x9
	OpPong         byte = 0xa
)

// Close codes used by this implementation (RFC 6455 section 7.4.1).
const (
	CloseNormalClosure   = 1000
	CloseGoingAway       = 1001
	CloseProtocolError   = 1002
	CloseInvalidPayload  = 1007
	ClosePolicyViolation = 1008
	CloseMessageTooBig   = 1009
	CloseInternalError   = 1011
	// CloseNoStatus is reported when the peer closed without a status code. It
	// is never sent on the wire.
	CloseNoStatus = 1005
	// CloseAbnormal is reported when the connection dropped without a close
	// frame. It is never sent on the wire.
	CloseAbnormal = 1006
)

// handshakeGUID is the fixed value RFC 6455 section 1.3 mixes into the accept
// token.
const handshakeGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// maxControlPayload is the RFC 6455 section 5.5 bound on a control frame.
const maxControlPayload = 125

// DefaultMaxMessageBytes bounds an assembled message when the caller sets no
// bound of its own.
const DefaultMaxMessageBytes = 1 << 20

// CloseError reports that the peer closed the connection.
//
// The control plane refuses a connector by closing with a policy-violation code
// and a reason equal to the stable error class of
// docs/CONNECTOR_PROTOCOL.md section 21, so Reason is load-bearing rather than
// diagnostic text.
type CloseError struct {
	Code   int
	Reason string
}

func (e *CloseError) Error() string {
	if e.Reason == "" {
		return "ws: peer closed with code " + strconv.Itoa(e.Code)
	}
	return "ws: peer closed with code " + strconv.Itoa(e.Code) + ": " + e.Reason
}

// HandshakeError reports an upgrade that the server refused. StatusCode is the
// HTTP status the server answered with, which is how an unauthenticated or
// wrong-identity connection is refused before any frame is exchanged.
type HandshakeError struct {
	StatusCode int
	Status     string
	Body       string
}

func (e *HandshakeError) Error() string {
	detail := e.Status
	if e.Body != "" {
		detail += ": " + e.Body
	}
	return "ws: handshake refused: " + detail
}

// Conn is one WebSocket connection.
type Conn struct {
	conn            net.Conn
	reader          *bufio.Reader
	isClient        bool
	maxMessageBytes int

	writeMutex sync.Mutex
	closeOnce  sync.Once
	closeSent  bool

	// deadlineMutex orders every change to the read deadline against the one
	// cancellation makes, and readEnded records that cancellation has made it.
	deadlineMutex sync.Mutex
	readEnded     bool

	// onPong runs on the reading goroutine when a pong arrives. The connector
	// uses it to extend its read deadline, so that a control plane that has
	// nothing to say still proves the channel is alive.
	onPong func()
}

// SetPongHandler registers a callback invoked on the reading goroutine each
// time a pong frame arrives.
func (c *Conn) SetPongHandler(handler func()) { c.onPong = handler }

// DialOptions configures an outbound connection.
type DialOptions struct {
	TLSConfig        *tls.Config
	HandshakeTimeout time.Duration
	Header           http.Header
	MaxMessageBytes  int
}

// Dial opens an outbound WebSocket connection.
//
// Only the wss scheme is accepted: the protocol schema's websocket_url
// definition refuses a plaintext endpoint, and docs/SECURITY.md section 15
// makes TLS mandatory on this boundary.
func Dial(ctx context.Context, rawURL string, options DialOptions) (*Conn, error) {
	endpoint, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("ws: %q is not a URL: %w", rawURL, err)
	}
	if endpoint.Scheme != "wss" {
		return nil, fmt.Errorf("ws: endpoint must use the wss scheme, found %q", endpoint.Scheme)
	}
	host := endpoint.Host
	if endpoint.Port() == "" {
		host = net.JoinHostPort(endpoint.Hostname(), "443")
	}

	timeout := options.HandshakeTimeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	dialCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	dialer := &net.Dialer{}
	raw, err := dialer.DialContext(dialCtx, "tcp", host)
	if err != nil {
		return nil, fmt.Errorf("ws: dialling %s: %w", host, err)
	}

	tlsConfig := options.TLSConfig
	if tlsConfig == nil {
		tlsConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	} else {
		tlsConfig = tlsConfig.Clone()
	}
	if tlsConfig.ServerName == "" {
		tlsConfig.ServerName = endpoint.Hostname()
	}
	if tlsConfig.MinVersion == 0 {
		tlsConfig.MinVersion = tls.VersionTLS12
	}
	secure := tls.Client(raw, tlsConfig)
	if err := secure.HandshakeContext(dialCtx); err != nil {
		_ = raw.Close()
		return nil, fmt.Errorf("ws: TLS handshake with %s: %w", host, err)
	}

	conn, err := clientHandshake(dialCtx, secure, endpoint, options)
	if err != nil {
		_ = secure.Close()
		return nil, err
	}
	return conn, nil
}

func clientHandshake(ctx context.Context, conn net.Conn, endpoint *url.URL, options DialOptions) (*Conn, error) {
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	defer func() { _ = conn.SetDeadline(time.Time{}) }()

	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("ws: generating handshake key: %w", err)
	}
	key := base64.StdEncoding.EncodeToString(nonce)

	header := http.Header{}
	for name, values := range options.Header {
		for _, value := range values {
			header.Add(name, value)
		}
	}
	header.Set("Upgrade", "websocket")
	header.Set("Connection", "Upgrade")
	header.Set("Sec-WebSocket-Key", key)
	header.Set("Sec-WebSocket-Version", "13")

	requestURL := *endpoint
	requestURL.Scheme = "https"
	request := &http.Request{
		Method:     http.MethodGet,
		URL:        &requestURL,
		Proto:      "HTTP/1.1",
		ProtoMajor: 1,
		ProtoMinor: 1,
		Header:     header,
		Host:       endpoint.Host,
	}
	if err := request.Write(conn); err != nil {
		return nil, fmt.Errorf("ws: writing handshake: %w", err)
	}

	reader := bufio.NewReaderSize(conn, 4096)
	response, err := http.ReadResponse(reader, request)
	if err != nil {
		return nil, fmt.Errorf("ws: reading handshake response: %w", err)
	}
	defer func() { _ = response.Body.Close() }()

	if response.StatusCode != http.StatusSwitchingProtocols {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		return nil, &HandshakeError{
			StatusCode: response.StatusCode,
			Status:     response.Status,
			Body:       strings.TrimSpace(string(body)),
		}
	}
	if !strings.EqualFold(response.Header.Get("Upgrade"), "websocket") ||
		!headerContainsToken(response.Header, "Connection", "upgrade") {
		return nil, errors.New("ws: server did not complete the WebSocket upgrade")
	}
	if response.Header.Get("Sec-WebSocket-Accept") != acceptToken(key) {
		return nil, errors.New("ws: server returned an invalid Sec-WebSocket-Accept value")
	}
	if extensions := response.Header.Get("Sec-WebSocket-Extensions"); extensions != "" {
		return nil, fmt.Errorf("ws: server negotiated unsupported extension %q", extensions)
	}

	maximum := options.MaxMessageBytes
	if maximum <= 0 {
		maximum = DefaultMaxMessageBytes
	}
	return &Conn{conn: conn, reader: reader, isClient: true, maxMessageBytes: maximum}, nil
}

// AcceptOptions configures a server-side upgrade.
type AcceptOptions struct {
	MaxMessageBytes int
	Header          http.Header
}

// Accept upgrades a connection the caller already accepted. It opens no
// listening socket of its own.
func Accept(w http.ResponseWriter, r *http.Request, options AcceptOptions) (*Conn, error) {
	if r.Method != http.MethodGet {
		return nil, errors.New("ws: upgrade requires GET")
	}
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") ||
		!headerContainsToken(r.Header, "Connection", "upgrade") {
		return nil, errors.New("ws: request is not a WebSocket upgrade")
	}
	if r.Header.Get("Sec-WebSocket-Version") != "13" {
		return nil, errors.New("ws: only WebSocket version 13 is supported")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		return nil, errors.New("ws: request carries no Sec-WebSocket-Key")
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("ws: response writer does not support hijacking")
	}
	conn, buffered, err := hijacker.Hijack()
	if err != nil {
		return nil, fmt.Errorf("ws: hijacking connection: %w", err)
	}

	var response strings.Builder
	response.WriteString("HTTP/1.1 101 Switching Protocols\r\n")
	response.WriteString("Upgrade: websocket\r\n")
	response.WriteString("Connection: Upgrade\r\n")
	response.WriteString("Sec-WebSocket-Accept: " + acceptToken(key) + "\r\n")
	for name, values := range options.Header {
		for _, value := range values {
			response.WriteString(name + ": " + value + "\r\n")
		}
	}
	response.WriteString("\r\n")
	if _, err := io.WriteString(conn, response.String()); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("ws: writing upgrade response: %w", err)
	}

	maximum := options.MaxMessageBytes
	if maximum <= 0 {
		maximum = DefaultMaxMessageBytes
	}
	return &Conn{conn: conn, reader: buffered.Reader, maxMessageBytes: maximum}, nil
}

func acceptToken(key string) string {
	sum := sha1.Sum([]byte(key + handshakeGUID)) // #nosec G401 -- RFC 6455 handshake, not a security digest
	return base64.StdEncoding.EncodeToString(sum[:])
}

func headerContainsToken(header http.Header, name, token string) bool {
	for _, value := range header.Values(name) {
		for _, part := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}

// SetReadDeadline bounds how long the next read may block. The connector uses
// it to notice a control plane that stopped answering without closing.
//
// Once a read's context has ended the deadline is fixed in the past and this
// call does nothing. That is what makes cancellation final: see endRead.
func (c *Conn) SetReadDeadline(deadline time.Time) error {
	c.deadlineMutex.Lock()
	defer c.deadlineMutex.Unlock()
	if c.readEnded {
		return nil
	}
	return c.conn.SetReadDeadline(deadline)
}

// endRead is how a cancelled context reaches a parked read: the deadline is
// moved into the past, and no later call may move it forward again.
//
// The second half is the load-bearing one. The read deadline is the only route
// by which cancellation reaches a goroutine parked in a socket read, and the
// signal that carries it is one-shot — context.AfterFunc fires once. Anything
// that pushed the deadline forward afterwards would park the reader again for a
// whole idle window with nothing left to wake it, which is a stall rather than
// a slow shutdown.
//
// Something does. A pong handler runs on the reading goroutine between frames
// and exists precisely to restore the idle window, so a pong that was already
// in the socket buffer when cancellation landed is enough to undo it. The window
// between reading that frame and running the handler is a few instructions wide,
// which is why the failure needed CPU contention to be seen at all and why it
// then looked like an unbounded hang rather than slowness (RVP-88). Ordering
// both under one mutex and latching the outcome makes the loss impossible in
// either interleaving rather than unlikely in one.
//
// The latch is never cleared. Every caller of ReadMessage in this repository
// treats a cancelled read context as the end of the connection, so there is no
// read after this one to bound.
func (c *Conn) endRead() {
	c.deadlineMutex.Lock()
	defer c.deadlineMutex.Unlock()
	c.readEnded = true
	_ = c.conn.SetReadDeadline(time.Now())
}

// RemoteAddr reports the peer address.
func (c *Conn) RemoteAddr() net.Addr { return c.conn.RemoteAddr() }

type frameHeader struct {
	final   bool
	opcode  byte
	masked  bool
	length  int64
	maskKey [4]byte
}

func (c *Conn) readFrameHeader() (frameHeader, error) {
	var head [2]byte
	if _, err := io.ReadFull(c.reader, head[:]); err != nil {
		return frameHeader{}, err
	}
	header := frameHeader{
		final:  head[0]&0x80 != 0,
		opcode: head[0] & 0x0f,
		masked: head[1]&0x80 != 0,
	}
	if head[0]&0x70 != 0 {
		return frameHeader{}, errors.New("ws: reserved frame bits are set")
	}
	switch length := int64(head[1] & 0x7f); {
	case length < 126:
		header.length = length
	case length == 126:
		var extended [2]byte
		if _, err := io.ReadFull(c.reader, extended[:]); err != nil {
			return frameHeader{}, err
		}
		header.length = int64(binary.BigEndian.Uint16(extended[:]))
	default:
		var extended [8]byte
		if _, err := io.ReadFull(c.reader, extended[:]); err != nil {
			return frameHeader{}, err
		}
		value := binary.BigEndian.Uint64(extended[:])
		if value > 1<<62 {
			return frameHeader{}, errors.New("ws: frame length is out of range")
		}
		header.length = int64(value)
	}
	if header.masked {
		if _, err := io.ReadFull(c.reader, header.maskKey[:]); err != nil {
			return frameHeader{}, err
		}
	}
	// RFC 6455 section 5.1: a client masks, a server does not.
	if c.isClient && header.masked {
		return frameHeader{}, errors.New("ws: server sent a masked frame")
	}
	if !c.isClient && !header.masked {
		return frameHeader{}, errors.New("ws: client sent an unmasked frame")
	}
	if header.opcode >= OpClose {
		switch {
		case !header.final:
			return frameHeader{}, errors.New("ws: control frame is fragmented")
		case header.length > maxControlPayload:
			return frameHeader{}, errors.New("ws: control frame payload exceeds 125 bytes")
		}
	}
	return header, nil
}

func (c *Conn) readFramePayload(header frameHeader) ([]byte, error) {
	if header.length == 0 {
		return nil, nil
	}
	// The length is checked against the message bound before the buffer is
	// allocated, so an oversized frame costs no memory.
	payload := make([]byte, header.length)
	if _, err := io.ReadFull(c.reader, payload); err != nil {
		return nil, err
	}
	if header.masked {
		for i := range payload {
			payload[i] ^= header.maskKey[i%4]
		}
	}
	return payload, nil
}

// discard drops an oversized payload without buffering it, so that refusing a
// frame does not itself allocate what the frame asked for.
func (c *Conn) discard(length int64) error {
	_, err := io.CopyN(io.Discard, c.reader, length)
	return err
}

// ReadMessage returns the next application message. Ping frames are answered
// and pong frames dropped inside this call.
//
// A message larger than the configured bound is refused: the connection is
// closed with 1009 and the payload is discarded rather than assembled.
func (c *Conn) ReadMessage(ctx context.Context) (byte, []byte, error) {
	if ctx != nil {
		stop := context.AfterFunc(ctx, c.endRead)
		defer stop()
	}

	var (
		assembled []byte
		opcode    byte
		started   bool
	)
	for {
		header, err := c.readFrameHeader()
		if err != nil {
			return 0, nil, c.readError(err)
		}
		switch header.opcode {
		case OpClose:
			payload, err := c.readFramePayload(header)
			if err != nil {
				return 0, nil, c.readError(err)
			}
			closeErr := decodeClosePayload(payload)
			c.writeCloseFrame(closeErr.Code, "")
			return 0, nil, closeErr
		case OpPing:
			payload, err := c.readFramePayload(header)
			if err != nil {
				return 0, nil, c.readError(err)
			}
			if err := c.writeFrame(OpPong, payload); err != nil {
				return 0, nil, err
			}
			continue
		case OpPong:
			if _, err := c.readFramePayload(header); err != nil {
				return 0, nil, c.readError(err)
			}
			if c.onPong != nil {
				c.onPong()
			}
			continue
		case OpText, OpBinary:
			if started {
				c.failConnection(CloseProtocolError, "unexpected data frame inside a fragmented message")
				return 0, nil, errors.New("ws: data frame arrived inside a fragmented message")
			}
			started = true
			opcode = header.opcode
		case OpContinuation:
			if !started {
				c.failConnection(CloseProtocolError, "continuation frame without a start frame")
				return 0, nil, errors.New("ws: continuation frame without a start frame")
			}
		default:
			c.failConnection(CloseProtocolError, "unknown opcode")
			return 0, nil, fmt.Errorf("ws: unknown opcode %#x", header.opcode)
		}

		if int64(len(assembled))+header.length > int64(c.maxMessageBytes) {
			_ = c.discard(header.length)
			c.failConnection(CloseMessageTooBig, "message exceeds the negotiated bound")
			return 0, nil, fmt.Errorf("ws: message exceeds the %d byte bound", c.maxMessageBytes)
		}
		payload, err := c.readFramePayload(header)
		if err != nil {
			return 0, nil, c.readError(err)
		}
		assembled = append(assembled, payload...)
		if header.final {
			return opcode, assembled, nil
		}
	}
}

func (c *Conn) readError(err error) error {
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return &CloseError{Code: CloseAbnormal, Reason: "connection closed without a close frame"}
	}
	return err
}

func decodeClosePayload(payload []byte) *CloseError {
	if len(payload) < 2 {
		return &CloseError{Code: CloseNoStatus}
	}
	code := int(binary.BigEndian.Uint16(payload[:2]))
	reason := string(payload[2:])
	return &CloseError{Code: code, Reason: reason}
}

// WriteText sends one text message.
func (c *Conn) WriteText(payload []byte) error { return c.writeFrame(OpText, payload) }

// WriteBinary sends one binary message.
func (c *Conn) WriteBinary(payload []byte) error { return c.writeFrame(OpBinary, payload) }

// Ping sends a ping frame.
func (c *Conn) Ping() error { return c.writeFrame(OpPing, nil) }

func (c *Conn) writeFrame(opcode byte, payload []byte) error {
	c.writeMutex.Lock()
	defer c.writeMutex.Unlock()
	return c.writeFrameLocked(opcode, payload)
}

func (c *Conn) writeFrameLocked(opcode byte, payload []byte) error {
	header := make([]byte, 0, 14)
	header = append(header, 0x80|opcode)
	maskBit := byte(0)
	if c.isClient {
		maskBit = 0x80
	}
	switch length := len(payload); {
	case length < 126:
		header = append(header, maskBit|byte(length))
	case length <= 0xffff:
		header = append(header, maskBit|126, byte(length>>8), byte(length))
	default:
		header = append(header, maskBit|127)
		var extended [8]byte
		binary.BigEndian.PutUint64(extended[:], uint64(length))
		header = append(header, extended[:]...)
	}

	body := payload
	if c.isClient {
		var mask [4]byte
		if _, err := rand.Read(mask[:]); err != nil {
			return fmt.Errorf("ws: generating frame mask: %w", err)
		}
		header = append(header, mask[:]...)
		body = make([]byte, len(payload))
		for i := range payload {
			body[i] = payload[i] ^ mask[i%4]
		}
	}
	if _, err := c.conn.Write(append(header, body...)); err != nil {
		return fmt.Errorf("ws: writing frame: %w", err)
	}
	return nil
}

// SetWriteDeadline bounds how long a write may block.
func (c *Conn) SetWriteDeadline(deadline time.Time) error {
	return c.conn.SetWriteDeadline(deadline)
}

// Close sends a close frame with the given code and reason and then closes the
// underlying connection. The reason is bounded to the RFC 6455 control-frame
// limit.
func (c *Conn) Close(code int, reason string) error {
	c.writeCloseFrame(code, reason)
	return c.conn.Close()
}

// CloseNow closes the underlying connection without a close handshake.
func (c *Conn) CloseNow() error { return c.conn.Close() }

func (c *Conn) writeCloseFrame(code int, reason string) {
	c.closeOnce.Do(func() {
		if code == CloseNoStatus || code == CloseAbnormal {
			code = CloseNormalClosure
		}
		payload := make([]byte, 2, 2+len(reason))
		binary.BigEndian.PutUint16(payload, uint16(code)) // #nosec G115 -- close codes are 16-bit by definition
		if len(reason) > maxControlPayload-2 {
			reason = reason[:maxControlPayload-2]
		}
		payload = append(payload, reason...)
		_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		c.writeMutex.Lock()
		_ = c.writeFrameLocked(OpClose, payload)
		c.closeSent = true
		c.writeMutex.Unlock()
	})
}

// failConnection closes after a protocol error, per RFC 6455 section 7.1.7.
func (c *Conn) failConnection(code int, reason string) {
	c.writeCloseFrame(code, reason)
	_ = c.conn.Close()
}
