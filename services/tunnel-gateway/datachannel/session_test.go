package datachannel

import (
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
)

// Unit and security layers (docs/TESTING.md sections 2 and 6): framing, flow
// control, deadlines and limits, exercised over an in-memory transport so that
// they are tested without a TLS handshake they do not depend on.

// pipeConn is an in-memory MessageConn pair.
type pipeConn struct {
	inbound  chan []byte
	outbound chan []byte

	closeOnce sync.Once
	closed    chan struct{}
	peer      *pipeConn

	mu      sync.Mutex
	written int
}

func newPipe() (*pipeConn, *pipeConn) {
	left := &pipeConn{inbound: make(chan []byte, 64), outbound: make(chan []byte, 64), closed: make(chan struct{})}
	right := &pipeConn{inbound: left.outbound, outbound: left.inbound, closed: make(chan struct{})}
	left.peer, right.peer = right, left
	return left, right
}

func (p *pipeConn) ReadMessage() ([]byte, error) {
	select {
	case message, ok := <-p.inbound:
		if !ok {
			return nil, io.EOF
		}
		return message, nil
	case <-p.closed:
		return nil, io.EOF
	}
}

func (p *pipeConn) WriteMessage(payload []byte) error {
	copied := append([]byte(nil), payload...)
	p.mu.Lock()
	p.written += len(copied)
	p.mu.Unlock()
	select {
	case p.outbound <- copied:
		return nil
	case <-p.closed:
		return io.ErrClosedPipe
	case <-p.peer.closed:
		return io.ErrClosedPipe
	}
}

func (p *pipeConn) Close(int, string) error {
	p.closeOnce.Do(func() { close(p.closed) })
	return nil
}

func header(routeID, sessionID, streamID string) connectorv1.DataStreamHeader {
	return connectorv1.DataStreamHeader{
		RouteID:             routeID,
		BrowserSessionID:    sessionID,
		SessionCapability:   connectorv1.SensitiveString("rp1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBB"),
		StreamID:            streamID,
		DestinationProtocol: connectorv1.DestinationProtocolHTTP,
		Deadline:            "2026-07-30T13:00:00Z",
	}
}

func pair(t *testing.T, config SessionConfig) (*Session, *Session) {
	t.Helper()
	left, right := newPipe()
	gateway := NewSession(left, RoleGateway, config)
	connector := NewSession(right, RoleConnector, config)
	t.Cleanup(func() {
		gateway.Close(nil)
		connector.Close(nil)
	})
	return gateway, connector
}

func TestAStreamCarriesBytesInBothDirections(t *testing.T) {
	gateway, connector := pair(t, SessionConfig{})
	stream, err := gateway.Open(header("svc_a", "brs_a", "req_a"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	accepted, err := connector.Accept()
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	if accepted.Header().RouteID != "svc_a" {
		t.Fatalf("the accepted stream carries route %q", accepted.Header().RouteID)
	}
	if accepted.Header().SessionCapability.Reveal() != stream.Header().SessionCapability.Reveal() {
		t.Fatal("the capability did not survive the canonical encoding")
	}

	go func() {
		_, _ = stream.Write([]byte("request bytes"))
		_ = stream.CloseWrite()
	}()
	received, err := io.ReadAll(accepted)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(received) != "request bytes" {
		t.Fatalf("received %q", received)
	}

	go func() {
		_, _ = accepted.Write([]byte("response bytes"))
		_ = accepted.CloseWrite()
	}()
	answer, err := io.ReadAll(stream)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	if string(answer) != "response bytes" {
		t.Fatalf("answer %q", answer)
	}
}

func TestOnlyTheGatewayOpensStreams(t *testing.T) {
	// A connector that could open a stream would be initiating traffic into the
	// control-plane zone, which the trust boundary does not allow.
	gateway, connector := pair(t, SessionConfig{})
	if _, err := connector.Open(header("svc_a", "brs_a", "req_a")); err == nil {
		t.Fatal("the connector opened a stream")
	}
	if _, err := gateway.Accept(); err == nil {
		t.Fatal("the gateway accepted a stream")
	}
}

func TestASlowConsumerProducesBackpressureNotBuffering(t *testing.T) {
	// docs/TESTING.md section 6 and docs/CONNECTOR_PROTOCOL.md section 12: one
	// stream must not exhaust memory. The sender is given far more to send than
	// the window allows, and the receiver reads nothing; what is buffered must
	// stay inside the window, and the sender must block rather than queue.
	const window = 8 * 1024
	gateway, connector := pair(t, SessionConfig{StreamWindow: window})
	stream, err := gateway.Open(header("svc_a", "brs_a", "req_a"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	accepted, err := connector.Accept()
	if err != nil {
		t.Fatalf("accept: %v", err)
	}

	payload := make([]byte, 1<<20)
	written := make(chan int, 1)
	go func() {
		count, _ := stream.Write(payload)
		written <- count
	}()

	// Give the sender every chance to overrun the window.
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if buffered := accepted.Buffered(); buffered > window {
			t.Fatalf("the receiver buffered %d bytes, more than the %d byte window", buffered, window)
		}
		select {
		case count := <-written:
			t.Fatalf("the sender wrote %d bytes without the receiver consuming any", count)
		default:
		}
		time.Sleep(10 * time.Millisecond)
	}
	if accepted.Buffered() != window {
		t.Fatalf("the receiver buffered %d bytes, want a full window of %d", accepted.Buffered(), window)
	}

	// Once the receiver consumes, the sender resumes.
	go func() { _, _ = io.CopyN(io.Discard, accepted, int64(len(payload))) }()
	select {
	case count := <-written:
		if count != len(payload) {
			t.Fatalf("the sender wrote %d of %d bytes", count, len(payload))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the sender never resumed after the receiver consumed")
	}
}

func TestPerStreamByteLimitsAreEnforced(t *testing.T) {
	gateway, connector := pair(t, SessionConfig{MaxStreamBytes: 4096, StreamWindow: 64 * 1024})
	stream, err := gateway.Open(header("svc_a", "brs_a", "req_a"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	accepted, err := connector.Accept()
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	go func() { _, _ = io.Copy(io.Discard, accepted) }()

	_, err = stream.Write(make([]byte, 8192))
	var streamErr *StreamError
	if !errors.As(err, &streamErr) {
		t.Fatalf("write failed with %v, want a StreamError", err)
	}
	if streamErr.Class != connectorv1.ErrorClassStreamLimitExceeded {
		t.Fatalf("class %q, want STREAM_LIMIT_EXCEEDED", streamErr.Class)
	}
}

func TestTheStreamLimitIsEnforcedOnOpen(t *testing.T) {
	gateway, _ := pair(t, SessionConfig{MaxStreams: 2})
	for index := 0; index < 2; index++ {
		if _, err := gateway.Open(header("svc_a", "brs_a", "req_"+string(rune('a'+index)))); err != nil {
			t.Fatalf("open %d: %v", index, err)
		}
	}
	_, err := gateway.Open(header("svc_a", "brs_a", "req_c"))
	var streamErr *StreamError
	if !errors.As(err, &streamErr) || streamErr.Class != connectorv1.ErrorClassStreamLimitExceeded {
		t.Fatalf("open beyond the limit failed with %v, want STREAM_LIMIT_EXCEEDED", err)
	}
}

func TestADeadlineClosesAStreamThatMakesNoProgress(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	gateway, connector := pair(t, SessionConfig{Now: clock, IdleTimeout: time.Hour})
	stream, err := gateway.Open(header("svc_a", "brs_a", "req_a"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := connector.Accept(); err != nil {
		t.Fatalf("accept: %v", err)
	}
	stream.SetPolicyDeadline(now.Add(time.Minute))

	if closed := gateway.EnforceDeadlines(now); closed.Total() != 0 {
		t.Fatalf("%d streams were closed before their deadline", closed.Total())
	}
	closed := gateway.EnforceDeadlines(now.Add(2 * time.Minute))
	if closed.Deadline != 1 || closed.Idle != 0 {
		t.Fatalf("the sweep closed %+v at the deadline, want one deadline closure", closed)
	}
	if _, err := stream.Write([]byte("x")); err == nil {
		t.Fatal("a stream past its deadline still accepted a write")
	}
}

func TestAnIdleStreamIsClosedAndRecorded(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	current := now
	gateway, connector := pair(t, SessionConfig{
		Now:         func() time.Time { return current },
		IdleTimeout: 30 * time.Second,
	})
	if _, err := gateway.Open(header("svc_a", "brs_a", "req_a")); err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := connector.Accept(); err != nil {
		t.Fatalf("accept: %v", err)
	}
	current = now.Add(time.Minute)
	closed := gateway.EnforceDeadlines(current)
	if closed.Idle != 1 || closed.Deadline != 0 {
		t.Fatalf("the sweep closed %+v, want one idle closure", closed)
	}
}

func TestAMalformedFrameEndsTheSessionRatherThanBeingSkipped(t *testing.T) {
	left, right := newPipe()
	gateway := NewSession(left, RoleGateway, SessionConfig{})
	defer gateway.Close(nil)

	if err := right.WriteMessage([]byte{99, 0, 0, 0, 1}); err != nil {
		t.Fatalf("write: %v", err)
	}
	select {
	case <-gateway.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("a malformed frame did not end the session")
	}
	if !errors.Is(gateway.Err(), ErrMalformedFrame) {
		t.Fatalf("the session ended with %v, want a malformed-frame error", gateway.Err())
	}
}

func TestAHeaderThatFailsTheSchemaResetsOnlyItsStream(t *testing.T) {
	left, right := newPipe()
	connector := NewSession(left, RoleConnector, SessionConfig{})
	defer connector.Close(nil)

	// Well-formed framing, a header the schema refuses.
	if err := right.WriteMessage(EncodeFrame(FrameOpen, 1, []byte(`{"route_id":""}`))); err != nil {
		t.Fatalf("write: %v", err)
	}
	select {
	case message := <-right.inbound:
		frame, err := DecodeFrame(message)
		if err != nil {
			t.Fatalf("decode reply: %v", err)
		}
		if frame.Type != FrameReset {
			t.Fatalf("reply was %s, want a reset", frame.Type)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no reset was sent for a header that failed the schema")
	}
	select {
	case <-connector.Done():
		t.Fatal("a refused header ended the whole session")
	default:
	}
}

func TestClosingASessionTerminatesEveryStreamOnIt(t *testing.T) {
	gateway, connector := pair(t, SessionConfig{})
	first, err := gateway.Open(header("svc_a", "brs_a", "req_a"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	second, err := gateway.Open(header("svc_a", "brs_a", "req_b"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := connector.Accept(); err != nil {
		t.Fatalf("accept: %v", err)
	}

	gateway.Close(errors.New("revoked"))
	for index, stream := range []*Stream{first, second} {
		if _, err := stream.Read(make([]byte, 1)); err == nil {
			t.Fatalf("stream %d survived the session closing", index)
		}
	}
}

func TestTheCapabilityIsNotRevealedByLoggingAStream(t *testing.T) {
	gateway, _ := pair(t, SessionConfig{})
	secret := "rp1.SSSSSSSSSSSSSSSS.TTTTTTTTTTTTTTTT"
	streamHeader := header("svc_a", "brs_a", "req_a")
	streamHeader.SessionCapability = connectorv1.SensitiveString(secret)
	stream, err := gateway.Open(streamHeader)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	rendered := strings.Join([]string{
		fmt.Sprintf("%v", stream.Header()),
		fmt.Sprintf("%+v", stream.Header()),
		fmt.Sprintf("%#v", stream.Header().SessionCapability),
	}, " ")
	if strings.Contains(rendered, secret) {
		t.Fatalf("logging a stream header revealed the capability: %s", rendered)
	}
}
