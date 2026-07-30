package datachannel

import (
	"errors"
	"fmt"
	"io"
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
			stream.terminate(cause)
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
