package datachannel

import (
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
)

// MessageConn is the transport a session multiplexes over: one connection that
// carries whole messages. internal/wsx supplies the WebSocket implementation;
// tests supply an in-memory pipe, which is how the mux is exercised without a
// TLS handshake it is not testing.
type MessageConn interface {
	ReadMessage() ([]byte, error)
	WriteMessage(payload []byte) error
	Close(code int, reason string) error
}

// Flow-control and limit defaults. They are constants of the protocol rather
// than of a deployment: both ends must agree on the initial window, because a
// sender may not exceed it before the first credit arrives.
const (
	// InitialStreamWindow is the credit each direction of a new stream starts
	// with. docs/CONNECTOR_PROTOCOL.md section 12 requires that one stream
	// cannot exhaust connector memory; the window is that bound, and it is what
	// turns a slow consumer into backpressure rather than into buffering.
	InitialStreamWindow = 256 * 1024

	// MaxDataFrameBytes bounds one data frame's payload, so a peer cannot force
	// a large allocation with a single frame.
	MaxDataFrameBytes = 32 * 1024

	// DefaultMaxStreams bounds concurrently open streams on one session.
	DefaultMaxStreams = 256

	// DefaultMaxStreamBytes bounds one stream's transfer in one direction.
	DefaultMaxStreamBytes = 64 << 20

	// DefaultIdleTimeout is the no-progress window of a request/response
	// stream. A development server that has neither read the request nor
	// started an answer for this long has stalled.
	DefaultIdleTimeout = 60 * time.Second

	// DefaultUpgradeIdleTimeout is the no-progress window of an upgraded
	// stream. It is far longer than DefaultIdleTimeout because silence on an
	// upgraded connection is normal: a hot-reload WebSocket carries nothing at
	// all while the developer is reading code, and closing it would make the
	// page stale while it still looked live
	// (docs/CONNECTOR_PROTOCOL.md section 13.3).
	DefaultUpgradeIdleTimeout = 15 * time.Minute
)

// SessionConfig bounds one multiplexed session.
type SessionConfig struct {
	// MaxStreams bounds concurrently open streams. Exceeding it is reported as
	// STREAM_LIMIT_EXCEEDED.
	MaxStreams int
	// MaxStreamBytes bounds one stream's transfer in one direction.
	MaxStreamBytes int64
	// StreamWindow is the initial per-direction flow-control window.
	StreamWindow int
	// IdleTimeout closes a request/response stream that makes no progress. A
	// stream also has an absolute deadline from its header; whichever fires
	// first ends it.
	IdleTimeout time.Duration
	// UpgradeIdleTimeout is the same window for a stream whose header declares
	// stream_mode upgrade. Two windows rather than one because the two kinds of
	// stream mean different things by silence.
	UpgradeIdleTimeout time.Duration
	// Now supplies the clock, so deadline arithmetic is testable.
	Now func() time.Time
}

func (c SessionConfig) withDefaults() SessionConfig {
	if c.MaxStreams <= 0 {
		c.MaxStreams = DefaultMaxStreams
	}
	if c.MaxStreamBytes <= 0 {
		c.MaxStreamBytes = DefaultMaxStreamBytes
	}
	if c.StreamWindow <= 0 {
		c.StreamWindow = InitialStreamWindow
	}
	if c.IdleTimeout <= 0 {
		c.IdleTimeout = DefaultIdleTimeout
	}
	if c.UpgradeIdleTimeout <= 0 {
		c.UpgradeIdleTimeout = DefaultUpgradeIdleTimeout
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	return c
}

// Role states which end of the channel a session is.
type Role int

const (
	// RoleGateway opens streams. Only the gateway may.
	RoleGateway Role = iota
	// RoleConnector accepts streams and opens the pre-authorised local
	// destination for each one.
	RoleConnector
)

// StreamError carries the stable error class a stream ended with.
type StreamError struct {
	Class connectorv1.ErrorClass
	Msg   string
}

func (e *StreamError) Error() string {
	if e == nil {
		return "<nil>"
	}
	if e.Class == "" {
		return "datachannel: stream reset: " + e.Msg
	}
	return "datachannel: stream reset " + string(e.Class) + ": " + e.Msg
}

// SessionClosedError reports a stream that ended because its session did — the
// connector's data channel dropped, was replaced by a reconnect, or was closed
// on revocation.
//
// It is distinct from StreamError because the two mean different things to a
// caller: a StreamError carries a docs/CONNECTOR_PROTOCOL.md section 21 class
// the far end chose, whereas this one means there is no far end. The request
// path turns it into CONNECTOR_OFFLINE (docs/MCP_SPEC.md section 12) rather than
// into a generic upstream failure, which docs/ARCHITECTURE.md section 14
// requires: a disconnect must fail clearly and must never hang.
type SessionClosedError struct {
	Cause error
}

func (e *SessionClosedError) Error() string {
	if e == nil {
		return "<nil>"
	}
	if e.Cause == nil {
		return "datachannel: the connector data channel closed"
	}
	return "datachannel: the connector data channel closed: " + e.Cause.Error()
}

func (e *SessionClosedError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

// Session multiplexes streams over one connection.
type Session struct {
	conn   MessageConn
	config SessionConfig
	role   Role

	mu       sync.Mutex
	streams  map[uint32]*Stream
	nextID   uint32
	accepted chan *Stream
	closed   bool
	closeErr error

	done      chan struct{}
	closeOnce sync.Once

	openedStreams atomic.Int64
}

// NewSession starts demultiplexing on conn. The caller owns conn until this
// returns and must not read from it afterwards.
func NewSession(conn MessageConn, role Role, config SessionConfig) *Session {
	session := &Session{
		conn:     conn,
		config:   config.withDefaults(),
		role:     role,
		streams:  map[uint32]*Stream{},
		accepted: make(chan *Stream, 16),
		done:     make(chan struct{}),
	}
	go session.readLoop()
	return session
}

// Done is closed when the session ends.
func (s *Session) Done() <-chan struct{} { return s.done }

// Err reports why the session ended, or nil while it is running.
func (s *Session) Err() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closeErr
}

// OpenedStreams counts streams opened over the session's life.
func (s *Session) OpenedStreams() int64 { return s.openedStreams.Load() }

// ActiveStreams counts streams open now.
func (s *Session) ActiveStreams() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.streams)
}

// StreamHeaders lists the header of every stream open now, ordered by stream
// number so that two reads of an unchanged session agree.
//
// It is what fills the active_streams field of the reconnect payload
// (docs/CONNECTOR_PROTOCOL.md section 17). The header carries a session
// capability, which is a bearer credential; callers copy the identifiers out and
// never the credential, and the generated models redact it in every default
// representation regardless.
func (s *Session) StreamHeaders() []connectorv1.DataStreamHeader {
	s.mu.Lock()
	numbers := make([]uint32, 0, len(s.streams))
	for id := range s.streams {
		numbers = append(numbers, id)
	}
	headers := make([]connectorv1.DataStreamHeader, 0, len(s.streams))
	sort.Slice(numbers, func(i, j int) bool { return numbers[i] < numbers[j] })
	for _, id := range numbers {
		headers = append(headers, s.streams[id].header)
	}
	s.mu.Unlock()
	return headers
}

// ResetRoute ends every stream belonging to routeID with a stable error class
// and reports how many it ended.
//
// Reconciliation uses it: a route the control plane has just revoked must stop
// carrying the transfer that is already moving, not only the next one
// (docs/CONNECTOR_PROTOCOL.md section 12.3, docs/SECURITY.md section 9).
func (s *Session) ResetRoute(routeID string, class connectorv1.ErrorClass) int {
	s.mu.Lock()
	doomed := make([]*Stream, 0)
	for id, stream := range s.streams {
		if stream.header.RouteID == routeID {
			doomed = append(doomed, stream)
			delete(s.streams, id)
		}
	}
	s.mu.Unlock()
	for _, stream := range doomed {
		_ = stream.Reset(class)
	}
	return len(doomed)
}

// ResetSession ends every stream opened for browserSessionID and reports how
// many it ended. It is the session half of reconciliation
// (docs/CONNECTOR_PROTOCOL.md section 17, "re-establish session").
func (s *Session) ResetSession(browserSessionID string, class connectorv1.ErrorClass) int {
	s.mu.Lock()
	doomed := make([]*Stream, 0)
	for id, stream := range s.streams {
		if stream.header.BrowserSessionID == browserSessionID {
			doomed = append(doomed, stream)
			delete(s.streams, id)
		}
	}
	s.mu.Unlock()
	for _, stream := range doomed {
		_ = stream.Reset(class)
	}
	return len(doomed)
}

// Open starts a stream. Only the gateway role may call it: a connector that
// opened streams would be initiating traffic into the control-plane zone, which
// the trust boundary of docs/SECURITY.md section 3 does not allow.
func (s *Session) Open(header connectorv1.DataStreamHeader) (*Stream, error) {
	if s.role != RoleGateway {
		return nil, errors.New("datachannel: only the gateway opens streams")
	}
	// The header is encoded by packages/protocol, never by encoding/json: the
	// canonical encoder is the only thing that reveals the session capability,
	// and the schema bound is checked as it does so.
	encoded, err := connectorv1.EncodeDataStreamHeaderFrame(header)
	if err != nil {
		return nil, fmt.Errorf("datachannel: encode stream header: %w", err)
	}

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, s.closeErr
	}
	if len(s.streams) >= s.config.MaxStreams {
		s.mu.Unlock()
		return nil, &StreamError{
			Class: connectorv1.ErrorClassStreamLimitExceeded,
			Msg:   "session already carries " + strconv.Itoa(s.config.MaxStreams) + " streams",
		}
	}
	s.nextID++
	id := s.nextID
	stream := s.newStreamLocked(id, header)
	s.mu.Unlock()

	if err := s.write(EncodeFrame(FrameOpen, id, encoded)); err != nil {
		s.removeStream(id)
		return nil, err
	}
	s.openedStreams.Add(1)
	return stream, nil
}

// Accept returns the next stream the peer opened. Only the connector role
// receives streams.
func (s *Session) Accept() (*Stream, error) {
	if s.role != RoleConnector {
		return nil, errors.New("datachannel: only the connector accepts streams")
	}
	select {
	case stream := <-s.accepted:
		return stream, nil
	case <-s.done:
		// A stream that was handed over just before the session ended is still
		// returned, so a connector does not lose one to a shutdown race.
		select {
		case stream := <-s.accepted:
			return stream, nil
		default:
		}
		return nil, s.Err()
	}
}

// Close ends the session and every stream on it. It is how immediate
// revocation reaches streams that are mid-transfer.
func (s *Session) Close(cause error) {
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closed = true
		if cause == nil {
			cause = io.EOF
		}
		s.closeErr = cause
		// Streams die of the channel dying, and the request path must be able to
		// say so: docs/MCP_SPEC.md section 12 requires CONNECTOR_OFFLINE rather
		// than a generic failure when a connector goes away mid-request.
		streamCause := error(&SessionClosedError{Cause: cause})
		streams := make([]*Stream, 0, len(s.streams))
		for _, stream := range s.streams {
			streams = append(streams, stream)
		}
		s.streams = map[uint32]*Stream{}
		// The accepted queue is deliberately not closed. Closing it would race
		// with a hand-over already in flight in the read loop, and a send on a
		// closed channel is a panic rather than a lost stream. Termination is
		// signalled by done alone.
		s.mu.Unlock()

		for _, stream := range streams {
			stream.terminate(streamCause)
		}
		_ = s.conn.Close(1000, "")
		close(s.done)
	})
}

func (s *Session) newStreamLocked(id uint32, header connectorv1.DataStreamHeader) *Stream {
	// The idle window follows the declared mode. Both ends derive it from the
	// same header field rather than from a local guess, so neither can close a
	// stream the other still believes in.
	idleTimeout := s.config.IdleTimeout
	if header.StreamMode != nil && *header.StreamMode == connectorv1.StreamModeUpgrade {
		idleTimeout = s.config.UpgradeIdleTimeout
	}
	stream := &Stream{
		session:     s,
		id:          id,
		header:      header,
		window:      int64(s.config.StreamWindow),
		capacity:    s.config.StreamWindow,
		maxBytes:    s.config.MaxStreamBytes,
		idleTimeout: idleTimeout,
		done:        make(chan struct{}),
	}
	stream.readable = sync.NewCond(&stream.mu)
	stream.writable = sync.NewCond(&stream.mu)
	stream.lastProgress = s.config.Now()
	s.streams[id] = stream
	return stream
}

func (s *Session) removeStream(id uint32) {
	s.mu.Lock()
	delete(s.streams, id)
	s.mu.Unlock()
}

func (s *Session) lookup(id uint32) *Stream {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.streams[id]
}

func (s *Session) write(frame []byte) error {
	if err := s.conn.WriteMessage(frame); err != nil {
		s.Close(err)
		return err
	}
	return nil
}

func (s *Session) readLoop() {
	for {
		message, err := s.conn.ReadMessage()
		if err != nil {
			s.Close(err)
			return
		}
		frame, err := DecodeFrame(message)
		if err != nil {
			// A malformed frame ends the session rather than being skipped: the
			// stream numbering after it can no longer be trusted.
			s.Close(err)
			return
		}
		if err := s.dispatch(frame); err != nil {
			s.Close(err)
			return
		}
	}
}

func (s *Session) dispatch(frame Frame) error {
	switch frame.Type {
	case FrameOpen:
		return s.handleOpen(frame)
	case FrameAccept:
		if stream := s.lookup(frame.Stream); stream != nil {
			stream.markAccepted()
		}
		return nil
	case FrameData:
		stream := s.lookup(frame.Stream)
		if stream == nil {
			// A frame for a stream that has gone is dropped; resetting would
			// let a peer probe which stream numbers exist.
			return nil
		}
		return stream.receive(frame.Payload)
	case FrameEnd:
		if stream := s.lookup(frame.Stream); stream != nil {
			stream.receiveEnd()
		}
		return nil
	case FrameReset:
		if stream := s.lookup(frame.Stream); stream != nil {
			class := connectorv1.ErrorClass(frame.Payload)
			stream.terminate(&StreamError{Class: class, Msg: "peer reset the stream"})
			s.removeStream(frame.Stream)
		}
		return nil
	case FrameWindow:
		if stream := s.lookup(frame.Stream); stream != nil {
			stream.addCredit(int64(WindowCredit(frame)))
		}
		return nil
	default:
		return ErrMalformedFrame
	}
}

func (s *Session) handleOpen(frame Frame) error {
	if s.role != RoleConnector {
		return errors.New("datachannel: peer attempted to open a stream into the gateway")
	}
	header, protocolErr := connectorv1.DecodeDataStreamHeaderFrame(frame.Payload)
	if protocolErr != nil {
		// The header is refused by the schema, so nothing in it has been
		// trusted. Reset that stream and keep the session, because the framing
		// itself was well formed.
		_ = s.write(EncodeFrame(FrameReset, frame.Stream, []byte(connectorv1.ErrorClassProtocolUnsupported)))
		return nil
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	if _, exists := s.streams[frame.Stream]; exists {
		s.mu.Unlock()
		return errors.New("datachannel: peer reused an open stream number")
	}
	if len(s.streams) >= s.config.MaxStreams {
		s.mu.Unlock()
		_ = s.write(EncodeFrame(FrameReset, frame.Stream, []byte(connectorv1.ErrorClassStreamLimitExceeded)))
		return nil
	}
	stream := s.newStreamLocked(frame.Stream, header)
	s.mu.Unlock()
	s.openedStreams.Add(1)

	select {
	case s.accepted <- stream:
	case <-s.done:
	}
	return nil
}
