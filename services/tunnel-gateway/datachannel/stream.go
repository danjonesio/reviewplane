package datachannel

import (
	"errors"
	"io"
	"strconv"
	"sync"
	"time"

	"github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
)

// Stream is one tunnelled connection multiplexed over a data channel.
//
// It is an io.ReadWriteCloser so that the gateway can hand it to net/http's
// request writer and response reader unchanged. The flow control is the reason
// it is not simply a channel of byte slices: a receiver returns credit only
// after the bytes have actually been consumed, so a slow HTTP client on the
// gateway stops the connector's writer instead of filling a queue
// (docs/CONNECTOR_PROTOCOL.md section 12, docs/TESTING.md section 6).
type Stream struct {
	session *Session
	id      uint32
	header  connectorv1.DataStreamHeader

	mu       sync.Mutex
	readable *sync.Cond
	writable *sync.Cond

	buffer   []byte
	capacity int
	// window is the credit this side may still spend on FrameData.
	window int64
	// pendingCredit is consumed-but-unreturned credit, batched so that a
	// trickling reader does not emit a window frame per byte.
	pendingCredit int

	readClosed  bool
	writeClosed bool
	accepted    bool
	terminated  error

	sentBytes     int64
	receivedBytes int64
	maxBytes      int64

	lastProgress time.Time
	deadline     time.Time
	deadlineSet  bool
}

// ID is the transport's stream number, unique for the connection.
func (s *Stream) ID() uint32 { return s.id }

// Header is the schema-validated header that opened the stream. Its session
// capability stays a SensitiveString, so logging the header does not leak it.
func (s *Stream) Header() connectorv1.DataStreamHeader { return s.header }

// Counters reports bytes written to and read from the peer, for the metrics
// docs/ARCHITECTURE.md section 4.6 requires.
func (s *Stream) Counters() (sent int64, received int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sentBytes, s.receivedBytes
}

// SetDeadline records the absolute instant after which the stream must be
// closed. docs/CONNECTOR_PROTOCOL.md section 12 puts a deadline on every
// stream; enforcing it here means a stalled transfer is closed and counted
// rather than left open.
func (s *Stream) SetDeadline(deadline time.Time) {
	s.mu.Lock()
	s.deadline = deadline
	s.deadlineSet = true
	s.mu.Unlock()
}

// Deadline reports the absolute deadline and whether one is set.
func (s *Stream) Deadline() (time.Time, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.deadline, s.deadlineSet
}

// Accepted reports whether the connector has confirmed it opened the local
// destination.
func (s *Stream) Accepted() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.accepted
}

// ConfirmAccepted is sent by the connector once it has opened the
// pre-authorised local destination for this stream.
func (s *Stream) ConfirmAccepted() error {
	s.mu.Lock()
	s.accepted = true
	s.mu.Unlock()
	return s.session.write(EncodeFrame(FrameAccept, s.id, nil))
}

func (s *Stream) markAccepted() {
	s.mu.Lock()
	s.accepted = true
	s.readable.Broadcast()
	s.mu.Unlock()
}

// Buffered reports bytes received but not yet consumed. A test asserts that it
// never exceeds the flow-control window, which is the difference between
// backpressure and unbounded buffering.
func (s *Stream) Buffered() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.buffer)
}

// Read consumes received bytes and returns flow-control credit as it does.
func (s *Stream) Read(p []byte) (int, error) {
	s.mu.Lock()
	for len(s.buffer) == 0 {
		if s.terminated != nil {
			err := s.terminated
			s.mu.Unlock()
			return 0, err
		}
		if s.readClosed {
			s.mu.Unlock()
			return 0, io.EOF
		}
		s.readable.Wait()
	}
	count := copy(p, s.buffer)
	s.buffer = s.buffer[count:]
	s.pendingCredit += count
	credit := 0
	// Return credit once half the window has been consumed. Half is a
	// deliberate compromise: returning per read would emit a frame per byte for
	// a trickling reader, and returning only when the window is exhausted would
	// stall the sender for a round trip.
	if s.pendingCredit >= s.capacity/2 || (len(s.buffer) == 0 && s.pendingCredit > 0) {
		credit = s.pendingCredit
		s.pendingCredit = 0
	}
	s.lastProgress = s.session.config.Now()
	s.mu.Unlock()

	if credit > 0 {
		if err := s.session.write(EncodeWindowFrame(s.id, uint32(credit))); err != nil {
			return count, err
		}
	}
	return count, nil
}

// Write sends bytes to the peer, blocking while the peer's window is exhausted.
func (s *Stream) Write(p []byte) (int, error) {
	written := 0
	for written < len(p) {
		s.mu.Lock()
		for {
			if s.terminated != nil {
				err := s.terminated
				s.mu.Unlock()
				return written, err
			}
			if s.writeClosed {
				s.mu.Unlock()
				return written, errors.New("datachannel: stream write side is closed")
			}
			if s.window > 0 {
				break
			}
			s.writable.Wait()
		}
		chunk := len(p) - written
		if chunk > MaxDataFrameBytes {
			chunk = MaxDataFrameBytes
		}
		if int64(chunk) > s.window {
			chunk = int(s.window)
		}
		if s.sentBytes+int64(chunk) > s.maxBytes {
			s.mu.Unlock()
			failure := &StreamError{
				Class: connectorv1.ErrorClassStreamLimitExceeded,
				Msg:   "stream exceeded its " + strconv.FormatInt(s.maxBytes, 10) + " byte transfer bound",
			}
			_ = s.Reset(failure.Class)
			return written, failure
		}
		s.window -= int64(chunk)
		s.sentBytes += int64(chunk)
		s.lastProgress = s.session.config.Now()
		s.mu.Unlock()

		if err := s.session.write(EncodeFrame(FrameData, s.id, p[written:written+chunk])); err != nil {
			return written, err
		}
		written += chunk
	}
	return written, nil
}

// CloseWrite half-closes this side: the peer sees EOF, and this side may still
// read the response.
func (s *Stream) CloseWrite() error {
	s.mu.Lock()
	if s.writeClosed || s.terminated != nil {
		s.mu.Unlock()
		return nil
	}
	s.writeClosed = true
	s.mu.Unlock()
	return s.session.write(EncodeFrame(FrameEnd, s.id, nil))
}

// Reset terminates the stream with a stable error class.
func (s *Stream) Reset(class connectorv1.ErrorClass) error {
	s.mu.Lock()
	if s.terminated != nil {
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()
	err := s.session.write(EncodeFrame(FrameReset, s.id, []byte(class)))
	s.terminate(&StreamError{Class: class, Msg: "stream reset locally"})
	s.session.removeStream(s.id)
	return err
}

// Close ends the stream normally.
func (s *Stream) Close() error {
	err := s.CloseWrite()
	s.terminate(io.EOF)
	s.session.removeStream(s.id)
	return err
}

func (s *Stream) receive(payload []byte) error {
	if len(payload) == 0 {
		return nil
	}
	s.mu.Lock()
	if s.terminated != nil {
		s.mu.Unlock()
		return nil
	}
	if len(s.buffer)+len(payload) > s.capacity {
		// The peer spent credit it did not have. That is a protocol violation,
		// and honouring it is exactly the unbounded buffering the window exists
		// to prevent.
		s.mu.Unlock()
		return errors.New("datachannel: peer exceeded the flow-control window")
	}
	if s.receivedBytes+int64(len(payload)) > s.maxBytes {
		s.mu.Unlock()
		return s.Reset(connectorv1.ErrorClassStreamLimitExceeded)
	}
	s.buffer = append(s.buffer, payload...)
	s.receivedBytes += int64(len(payload))
	s.lastProgress = s.session.config.Now()
	s.readable.Broadcast()
	s.mu.Unlock()
	return nil
}

func (s *Stream) receiveEnd() {
	s.mu.Lock()
	s.readClosed = true
	s.readable.Broadcast()
	s.mu.Unlock()
}

func (s *Stream) addCredit(credit int64) {
	s.mu.Lock()
	s.window += credit
	s.lastProgress = s.session.config.Now()
	s.writable.Broadcast()
	s.mu.Unlock()
}

func (s *Stream) terminate(cause error) {
	s.mu.Lock()
	if s.terminated == nil {
		if cause == nil {
			cause = io.EOF
		}
		s.terminated = cause
	}
	s.readable.Broadcast()
	s.writable.Broadcast()
	s.mu.Unlock()
}

// ExpiredAt reports whether the stream must be closed at the given instant,
// either because its absolute deadline has passed or because it has made no
// progress for the session's idle timeout.
func (s *Stream) ExpiredAt(now time.Time) (bool, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.deadlineSet && !now.Before(s.deadline) {
		return true, "deadline"
	}
	if now.Sub(s.lastProgress) >= s.session.config.IdleTimeout {
		return true, "idle"
	}
	return false, ""
}

// EnforceDeadlines closes every stream whose deadline or idle timeout has
// passed, and reports how many it closed. The caller runs it on a ticker; it is
// a method rather than a goroutine so that a test can drive it with its own
// clock.
func (s *Session) EnforceDeadlines(now time.Time) int {
	s.mu.Lock()
	streams := make([]*Stream, 0, len(s.streams))
	for _, stream := range s.streams {
		streams = append(streams, stream)
	}
	s.mu.Unlock()

	closed := 0
	for _, stream := range streams {
		if expired, _ := stream.ExpiredAt(now); expired {
			_ = stream.Reset(connectorv1.ErrorClassRouteExpired)
			closed++
		}
	}
	return closed
}
