// Package wsx is the bounded WebSocket subset the connector data channel
// needs, and nothing else.
//
// docs/CONNECTOR_PROTOCOL.md section 5 fixes the transport as an outbound,
// mutually authenticated TLS connection carrying WebSocket control and
// multiplexed data streams, and the registration response refuses any endpoint
// that is not wss. So the data channel is a WebSocket, and the gateway needs
// both ends of one: the server side it terminates, and the client side its
// protocol-level tests and services/connector dial.
//
// It is written here rather than taken from a library for the reason ADR-0013
// gives for generating protocol validators instead of depending on a JSON
// Schema library: this is the highest-value security boundary in Stage 0
// (docs/SECURITY.md section 9), and a purpose-built implementation that
// supports exactly one subprotocol, binary messages only, no extensions, no
// compression and one hard message bound is a smaller thing to audit than a
// general-purpose implementation configured down to the same subset. It also
// keeps the Go services free of third-party dependencies under the
// docs/SECURITY.md section 19 supply-chain rules.
//
// Deliberately absent: permessage-deflate and every other extension, text
// messages, automatic reconnection, and any read path that allocates before it
// has checked a declared length against the message bound.
//
// It is an exported package rather than an internal one because both ends of
// the data channel must be one implementation: services/connector dials with
// Dial and the gateway terminates with Accept. A second client written against
// the same prose would be a second thing to keep in step with the handshake,
// the subprotocol and the message bound.
package wsx

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Subprotocol pins the data-channel wire contract. A connector built against a
// different data-channel version fails the handshake instead of exchanging
// frames that one side misreads.
const Subprotocol = "reviewplane.connector.data.v1"

// handshakeGUID is the constant of RFC 6455 section 1.3.
const handshakeGUID = "258EAFA5-E914-47DA-95CA-5AB0DC85B11F"

const (
	opcodeContinuation = 0x0
	opcodeText         = 0x1
	opcodeBinary       = 0x2
	opcodeClose        = 0x8
	opcodePing         = 0x9
	opcodePong         = 0xa
)

// Close codes used by this package (RFC 6455 section 7.4.1).
const (
	CloseNormal        = 1000
	CloseGoingAway     = 1001
	CloseProtocolError = 1002
	CloseUnsupported   = 1003
	ClosePolicy        = 1008
	CloseTooLarge      = 1009
	CloseInternal      = 1011
)

// maxControlPayload is the RFC 6455 section 5.5 bound on a control frame.
const maxControlPayload = 125

// ErrClosed reports that the peer closed the connection, or that this side did.
var ErrClosed = errors.New("wsx: connection closed")

// Options bound a connection. Every field has a safe default so that a caller
// cannot create an unbounded connection by forgetting one.
type Options struct {
	// MaxMessageBytes bounds one assembled application message. A frame that
	// declares more is refused before anything is allocated for it.
	MaxMessageBytes int
	// HandshakeTimeout bounds the upgrade exchange.
	HandshakeTimeout time.Duration
	// WriteTimeout bounds one write, so a stalled peer cannot pin a writer.
	WriteTimeout time.Duration
}

func (o Options) withDefaults() Options {
	if o.MaxMessageBytes <= 0 {
		o.MaxMessageBytes = 1 << 20
	}
	if o.HandshakeTimeout <= 0 {
		o.HandshakeTimeout = 10 * time.Second
	}
	if o.WriteTimeout <= 0 {
		o.WriteTimeout = 30 * time.Second
	}
	return o
}

// Conn is one WebSocket connection carrying binary messages.
//
// A Conn is safe for one concurrent reader and any number of concurrent
// writers. Reads are not safe to call concurrently, which matches the single
// demultiplexing goroutine the data channel runs.
type Conn struct {
	conn    net.Conn
	reader  *bufio.Reader
	options Options
	client  bool

	writeMu sync.Mutex
	closeMu sync.Mutex
	closed  bool
}

// RemoteAddr reports the peer address, for logging that carries no credential.
func (c *Conn) RemoteAddr() net.Addr { return c.conn.RemoteAddr() }

// ConnectionState exposes the TLS state so that the caller can derive connector
// identity from the verified client certificate.
func (c *Conn) ConnectionState() (tls.ConnectionState, bool) {
	if tlsConn, ok := c.conn.(*tls.Conn); ok {
		return tlsConn.ConnectionState(), true
	}
	return tls.ConnectionState{}, false
}

// Accept completes the server side of the handshake and takes over the
// connection.
//
// It refuses anything but a version 13 upgrade that offers this package's
// subprotocol, so a browser or a generic WebSocket client cannot open a data
// channel by accident.
func Accept(w http.ResponseWriter, r *http.Request, options Options) (*Conn, error) {
	options = options.withDefaults()
	if !headerHasToken(r.Header, "Connection", "upgrade") {
		return nil, handshakeError(w, http.StatusBadRequest, "Connection header does not request an upgrade")
	}
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return nil, handshakeError(w, http.StatusBadRequest, "Upgrade header is not websocket")
	}
	if r.Header.Get("Sec-WebSocket-Version") != "13" {
		w.Header().Set("Sec-WebSocket-Version", "13")
		return nil, handshakeError(w, http.StatusBadRequest, "only WebSocket version 13 is supported")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if len(key) == 0 {
		return nil, handshakeError(w, http.StatusBadRequest, "Sec-WebSocket-Key is missing")
	}
	if !headerHasToken(r.Header, "Sec-WebSocket-Protocol", Subprotocol) {
		return nil, handshakeError(w, http.StatusBadRequest, "the "+Subprotocol+" subprotocol was not offered")
	}

	controller := http.NewResponseController(w)
	netConn, buffered, err := controller.Hijack()
	if err != nil {
		return nil, handshakeError(w, http.StatusInternalServerError, "connection cannot be hijacked")
	}
	_ = netConn.SetDeadline(time.Now().Add(options.HandshakeTimeout))
	response := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + acceptKey(key) + "\r\n" +
		"Sec-WebSocket-Protocol: " + Subprotocol + "\r\n\r\n"
	if _, err := netConn.Write([]byte(response)); err != nil {
		_ = netConn.Close()
		return nil, fmt.Errorf("wsx: write handshake response: %w", err)
	}
	_ = netConn.SetDeadline(time.Time{})
	// The hijacked reader may already hold bytes the client pipelined behind
	// its handshake. Reading through it rather than around it is what stops
	// those bytes from being silently dropped.
	return &Conn{conn: netConn, reader: buffered.Reader, options: options}, nil
}

func handshakeError(w http.ResponseWriter, status int, reason string) error {
	http.Error(w, http.StatusText(status), status)
	return errors.New("wsx: handshake refused: " + reason)
}

// Dial opens the client side of a data channel.
//
// The connector uses it to dial outbound (ADR-0002); the gateway's own tests
// use it to stand in for a connector. Only wss is accepted for a real
// deployment; ws is permitted solely when tlsConfig is nil, which is how the
// in-process tests avoid a TLS handshake they are not testing.
func Dial(endpoint string, tlsConfig *tls.Config, header http.Header, options Options) (*Conn, error) {
	options = options.withDefaults()
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return nil, fmt.Errorf("wsx: parse endpoint: %w", err)
	}
	secure := parsed.Scheme == "wss"
	if !secure && parsed.Scheme != "ws" {
		return nil, errors.New("wsx: endpoint scheme must be ws or wss")
	}
	if secure && tlsConfig == nil {
		return nil, errors.New("wsx: wss requires a TLS configuration")
	}
	address := parsed.Host
	if parsed.Port() == "" {
		if secure {
			address = net.JoinHostPort(parsed.Hostname(), "443")
		} else {
			address = net.JoinHostPort(parsed.Hostname(), "80")
		}
	}
	dialer := &net.Dialer{Timeout: options.HandshakeTimeout}
	var netConn net.Conn
	if secure {
		netConn, err = tls.DialWithDialer(dialer, "tcp", address, tlsConfig)
	} else {
		netConn, err = dialer.Dial("tcp", address)
	}
	if err != nil {
		return nil, fmt.Errorf("wsx: dial: %w", err)
	}
	_ = netConn.SetDeadline(time.Now().Add(options.HandshakeTimeout))

	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		_ = netConn.Close()
		return nil, fmt.Errorf("wsx: generate handshake key: %w", err)
	}
	key := base64.StdEncoding.EncodeToString(nonce)
	path := parsed.RequestURI()
	request := "GET " + path + " HTTP/1.1\r\n" +
		"Host: " + parsed.Host + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Version: 13\r\n" +
		"Sec-WebSocket-Key: " + key + "\r\n" +
		"Sec-WebSocket-Protocol: " + Subprotocol + "\r\n"
	for name, values := range header {
		for _, value := range values {
			request += name + ": " + value + "\r\n"
		}
	}
	request += "\r\n"
	if _, err := netConn.Write([]byte(request)); err != nil {
		_ = netConn.Close()
		return nil, fmt.Errorf("wsx: write handshake: %w", err)
	}
	reader := bufio.NewReaderSize(netConn, 4096)
	response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodGet})
	if err != nil {
		_ = netConn.Close()
		return nil, fmt.Errorf("wsx: read handshake response: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusSwitchingProtocols {
		_ = netConn.Close()
		return nil, fmt.Errorf("wsx: handshake refused with status %d", response.StatusCode)
	}
	if response.Header.Get("Sec-WebSocket-Accept") != acceptKey(key) {
		_ = netConn.Close()
		return nil, errors.New("wsx: handshake response does not confirm the key")
	}
	if response.Header.Get("Sec-WebSocket-Protocol") != Subprotocol {
		_ = netConn.Close()
		return nil, errors.New("wsx: handshake response does not confirm the subprotocol")
	}
	if response.Header.Get("Sec-WebSocket-Extensions") != "" {
		// No extension was offered, so any that is confirmed was invented by
		// the peer and would change how frames are read.
		_ = netConn.Close()
		return nil, errors.New("wsx: handshake response confirms an extension that was not offered")
	}
	_ = netConn.SetDeadline(time.Time{})
	return &Conn{conn: netConn, reader: reader, options: options, client: true}, nil
}

func acceptKey(key string) string {
	sum := sha1.Sum([]byte(key + handshakeGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
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

// ReadMessage returns the next binary application message.
//
// Control frames are handled here: a ping is answered, a pong is ignored and a
// close ends the connection with ErrClosed. A text message is refused, because
// this protocol carries none.
func (c *Conn) ReadMessage() ([]byte, error) {
	var assembled []byte
	var assembling bool
	for {
		frame, err := c.readFrame()
		if err != nil {
			return nil, err
		}
		switch frame.opcode {
		case opcodeClose:
			c.writeControl(opcodeClose, closePayload(CloseNormal, ""))
			_ = c.closeNow()
			return nil, ErrClosed
		case opcodePing:
			c.writeControl(opcodePong, frame.payload)
			continue
		case opcodePong:
			continue
		case opcodeText:
			c.failConnection(CloseUnsupported)
			return nil, errors.New("wsx: text messages are not part of this protocol")
		case opcodeBinary:
			if assembling {
				c.failConnection(CloseProtocolError)
				return nil, errors.New("wsx: a new message started before the previous one finished")
			}
			assembled = frame.payload
			assembling = true
		case opcodeContinuation:
			if !assembling {
				c.failConnection(CloseProtocolError)
				return nil, errors.New("wsx: continuation frame without a message to continue")
			}
			if len(assembled)+len(frame.payload) > c.options.MaxMessageBytes {
				c.failConnection(CloseTooLarge)
				return nil, errors.New("wsx: fragmented message exceeds the message bound")
			}
			assembled = append(assembled, frame.payload...)
		default:
			c.failConnection(CloseProtocolError)
			return nil, fmt.Errorf("wsx: unknown opcode %d", frame.opcode)
		}
		if frame.fin {
			return assembled, nil
		}
	}
}

type frame struct {
	fin     bool
	opcode  byte
	payload []byte
}

func (c *Conn) readFrame() (frame, error) {
	var head [2]byte
	if _, err := io.ReadFull(c.reader, head[:]); err != nil {
		return frame{}, translateReadError(err)
	}
	fin := head[0]&0x80 != 0
	if head[0]&0x70 != 0 {
		// Reserved bits are only set by a negotiated extension, and none is.
		c.failConnection(CloseProtocolError)
		return frame{}, errors.New("wsx: reserved frame bits are set")
	}
	opcode := head[0] & 0x0f
	masked := head[1]&0x80 != 0
	length := int(head[1] & 0x7f)

	switch length {
	case 126:
		var extended [2]byte
		if _, err := io.ReadFull(c.reader, extended[:]); err != nil {
			return frame{}, translateReadError(err)
		}
		length = int(binary.BigEndian.Uint16(extended[:]))
	case 127:
		var extended [8]byte
		if _, err := io.ReadFull(c.reader, extended[:]); err != nil {
			return frame{}, translateReadError(err)
		}
		value := binary.BigEndian.Uint64(extended[:])
		// The bound is checked on the declared length, before any allocation,
		// which is the bounded-allocation rule of docs/DEVELOPMENT.md section 10
		// applied to the transport.
		if value > uint64(c.options.MaxMessageBytes) {
			c.failConnection(CloseTooLarge)
			return frame{}, errors.New("wsx: frame declares more bytes than the message bound")
		}
		length = int(value)
	}
	if length > c.options.MaxMessageBytes {
		c.failConnection(CloseTooLarge)
		return frame{}, errors.New("wsx: frame declares more bytes than the message bound")
	}
	isControl := opcode&0x08 != 0
	if isControl {
		if !fin {
			c.failConnection(CloseProtocolError)
			return frame{}, errors.New("wsx: control frames must not be fragmented")
		}
		if length > maxControlPayload {
			c.failConnection(CloseProtocolError)
			return frame{}, errors.New("wsx: control frame exceeds 125 bytes")
		}
	}
	// RFC 6455 section 5.1: a client must mask, a server must not. Enforcing
	// both directions stops a peer from claiming the other role.
	if c.client && masked {
		c.failConnection(CloseProtocolError)
		return frame{}, errors.New("wsx: server frames must not be masked")
	}
	if !c.client && !masked {
		c.failConnection(CloseProtocolError)
		return frame{}, errors.New("wsx: client frames must be masked")
	}
	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(c.reader, mask[:]); err != nil {
			return frame{}, translateReadError(err)
		}
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(c.reader, payload); err != nil {
		return frame{}, translateReadError(err)
	}
	if masked {
		for index := range payload {
			payload[index] ^= mask[index%4]
		}
	}
	return frame{fin: fin, opcode: opcode, payload: payload}, nil
}

func translateReadError(err error) error {
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, net.ErrClosed) {
		return ErrClosed
	}
	return err
}

// WriteMessage sends one binary application message.
func (c *Conn) WriteMessage(payload []byte) error {
	if len(payload) > c.options.MaxMessageBytes {
		return errors.New("wsx: message exceeds the message bound")
	}
	return c.writeFrame(opcodeBinary, payload)
}

// Ping sends a ping frame. The peer's pong is consumed by ReadMessage.
func (c *Conn) Ping(payload []byte) error {
	if len(payload) > maxControlPayload {
		return errors.New("wsx: ping payload exceeds 125 bytes")
	}
	return c.writeFrame(opcodePing, payload)
}

func (c *Conn) writeControl(opcode byte, payload []byte) {
	_ = c.writeFrame(opcode, payload)
}

func (c *Conn) writeFrame(opcode byte, payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.isClosed() {
		return ErrClosed
	}
	header := make([]byte, 0, 14)
	header = append(header, 0x80|opcode)
	maskBit := byte(0)
	if c.client {
		maskBit = 0x80
	}
	switch {
	case len(payload) < 126:
		header = append(header, maskBit|byte(len(payload)))
	case len(payload) <= 0xffff:
		header = append(header, maskBit|126)
		header = binary.BigEndian.AppendUint16(header, uint16(len(payload)))
	default:
		header = append(header, maskBit|127)
		header = binary.BigEndian.AppendUint64(header, uint64(len(payload)))
	}
	body := payload
	if c.client {
		var mask [4]byte
		if _, err := rand.Read(mask[:]); err != nil {
			return fmt.Errorf("wsx: generate mask: %w", err)
		}
		header = append(header, mask[:]...)
		body = make([]byte, len(payload))
		for index := range payload {
			body[index] = payload[index] ^ mask[index%4]
		}
	}
	if err := c.conn.SetWriteDeadline(time.Now().Add(c.options.WriteTimeout)); err != nil {
		return err
	}
	if _, err := c.conn.Write(append(header, body...)); err != nil {
		return translateReadError(err)
	}
	return nil
}

func closePayload(code int, reason string) []byte {
	payload := binary.BigEndian.AppendUint16(nil, uint16(code))
	if len(reason) > maxControlPayload-2 {
		reason = reason[:maxControlPayload-2]
	}
	return append(payload, reason...)
}

func (c *Conn) failConnection(code int) {
	c.writeControl(opcodeClose, closePayload(code, ""))
	_ = c.closeNow()
}

// Close sends a close frame and releases the connection.
func (c *Conn) Close(code int, reason string) error {
	if c.isClosed() {
		return nil
	}
	c.writeControl(opcodeClose, closePayload(code, reason))
	return c.closeNow()
}

func (c *Conn) closeNow() error {
	c.closeMu.Lock()
	if c.closed {
		c.closeMu.Unlock()
		return nil
	}
	c.closed = true
	c.closeMu.Unlock()
	return c.conn.Close()
}

func (c *Conn) isClosed() bool {
	c.closeMu.Lock()
	defer c.closeMu.Unlock()
	return c.closed
}
