package datachannel

import (
	"context"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
)

// testClock is a settable clock that is safe to advance while a session's read
// loop and a connector sweep are reading it. A plain variable would be a data
// race the moment a test advanced time under a running sweep.
type testClock struct {
	mu  sync.Mutex
	now time.Time
}

func newTestClock() *testClock {
	return &testClock{now: time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)}
}

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *testClock) set(instant time.Time) {
	c.mu.Lock()
	c.now = instant
	c.mu.Unlock()
}

// The stream-lifetime half of docs/CONNECTOR_PROTOCOL.md section 13.3.
//
// The unit under test is the derivation: both ends of one stream take the idle
// window from the same declared mode, so neither can close a stream the other
// still believes in. A connector that guessed the mode from the bytes flowing
// through it would be parsing relayed content, which section 12 forbids.

func upgradeHeader(routeID, sessionID, streamID string) connectorv1.DataStreamHeader {
	built := header(routeID, sessionID, streamID)
	mode := connectorv1.StreamModeUpgrade
	built.StreamMode = &mode
	return built
}

func TestAStreamsIdleWindowFollowsItsDeclaredMode(t *testing.T) {
	config := SessionConfig{
		IdleTimeout:        30 * time.Second,
		UpgradeIdleTimeout: 20 * time.Minute,
	}
	gateway, connector := pair(t, config)

	ordinary, err := gateway.Open(header("svc_a", "brs_a", "req_a"))
	if err != nil {
		t.Fatalf("open ordinary: %v", err)
	}
	upgraded, err := gateway.Open(upgradeHeader("svc_a", "brs_a", "req_b"))
	if err != nil {
		t.Fatalf("open upgraded: %v", err)
	}
	if ordinary.Mode() != connectorv1.StreamModeRequestResponse {
		t.Fatalf("a header naming no mode reported %q", ordinary.Mode())
	}
	if upgraded.Mode() != connectorv1.StreamModeUpgrade {
		t.Fatalf("an upgraded header reported %q", upgraded.Mode())
	}
	if ordinary.IdleTimeout() != 30*time.Second {
		t.Fatalf("the request/response window is %s", ordinary.IdleTimeout())
	}
	if upgraded.IdleTimeout() != 20*time.Minute {
		t.Fatalf("the upgrade window is %s", upgraded.IdleTimeout())
	}

	// The connector derives the same two windows from the same two headers,
	// which is the property that stops one end closing what the other holds.
	for _, want := range []time.Duration{30 * time.Second, 20 * time.Minute} {
		accepted, err := connector.Accept()
		if err != nil {
			t.Fatalf("accept: %v", err)
		}
		if accepted.IdleTimeout() != want {
			t.Fatalf("the connector gave the stream a %s window, want %s",
				accepted.IdleTimeout(), want)
		}
	}
}

func TestAnUpgradedStreamOutlivesTheRequestResponseIdleWindow(t *testing.T) {
	clock := newTestClock()
	now := clock.Now()
	config := SessionConfig{
		Now:                clock.Now,
		IdleTimeout:        time.Second,
		UpgradeIdleTimeout: 15 * time.Minute,
	}
	gateway, connector := pair(t, config)

	if _, err := gateway.Open(upgradeHeader("svc_a", "brs_a", "req_a")); err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := connector.Accept(); err != nil {
		t.Fatalf("accept: %v", err)
	}

	// Ten minutes of silence: an editing pause, far beyond the request/response
	// window and inside the upgrade one.
	clock.set(now.Add(10 * time.Minute))
	if closed := gateway.EnforceDeadlines(clock.Now()); closed.Total() != 0 {
		t.Fatalf("the sweep closed %+v during an editing pause", closed)
	}

	clock.set(now.Add(16 * time.Minute))
	closed := gateway.EnforceDeadlines(clock.Now())
	if closed.Idle != 1 {
		t.Fatalf("the sweep closed %+v past the upgrade window, want one idle closure", closed)
	}
}

func TestAnUpgradedStreamIsClosedAtItsDeadlineEvenWhileBusy(t *testing.T) {
	// The deadline is the route's expiry. A connection carrying traffic every
	// second must still end there: docs/CONNECTOR_PROTOCOL.md section 13.3
	// forbids an upgraded connection from extending the access its route
	// authorised.
	clock := newTestClock()
	now := clock.Now()
	gateway, connector := pair(t, SessionConfig{
		Now:                clock.Now,
		UpgradeIdleTimeout: 24 * time.Hour,
	})
	stream, err := gateway.Open(upgradeHeader("svc_a", "brs_a", "req_a"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := connector.Accept(); err != nil {
		t.Fatalf("accept: %v", err)
	}
	stream.SetPolicyDeadline(now.Add(time.Hour))

	clock.set(now.Add(2 * time.Hour))
	closed := gateway.EnforceDeadlines(clock.Now())
	if closed.Deadline != 1 {
		t.Fatalf("the sweep closed %+v at the deadline, want one deadline closure", closed)
	}
	if _, err := stream.Write([]byte("x")); err == nil {
		t.Fatal("an upgraded stream past its deadline still accepted a write")
	}
}

func TestATerminatedStreamReleasesARelayParkedOnTheLocalSocket(t *testing.T) {
	// Without this the connector would hold a socket to the development service
	// open until the stream's absolute deadline, which on an upgraded stream is
	// hours away. Done is what lets a relay parked in a read learn that the
	// stream has gone.
	gateway, connector := pair(t, SessionConfig{})
	stream, err := gateway.Open(upgradeHeader("svc_a", "brs_a", "req_a"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	accepted, err := connector.Accept()
	if err != nil {
		t.Fatalf("accept: %v", err)
	}

	left, right := net.Pipe()
	defer func() { _ = right.Close() }()
	released := make(chan struct{})
	go func() {
		<-accepted.Done()
		_ = left.Close()
		close(released)
	}()
	parked := make(chan error, 1)
	go func() {
		_, err := io.Copy(io.Discard, left)
		parked <- err
	}()

	select {
	case <-released:
		t.Fatal("the stream reported Done before anything had ended it")
	case <-time.After(50 * time.Millisecond):
	}

	_ = stream.Reset(connectorv1.ErrorClassRouteExpired)
	select {
	case <-released:
	case <-time.After(5 * time.Second):
		t.Fatal("a reset stream never reported Done")
	}
	select {
	case <-parked:
	case <-time.After(5 * time.Second):
		t.Fatal("the relay stayed parked on the local socket after the stream ended")
	}
}

func TestTheConnectorSweepsItsOwnStreams(t *testing.T) {
	// The gateway sweeps its end, and the connector sweeps its own. A channel
	// that died mid-stream would otherwise leave the developer's machine
	// holding sockets nothing is going to end.
	clock := newTestClock()
	now := clock.Now()
	gateway, connector := pair(t, SessionConfig{Now: clock.Now, IdleTimeout: time.Minute})

	table := NewRouteTable()
	table.Put(LocalRoute{
		RouteID:                  "svc_a",
		Host:                     "127.0.0.1",
		Port:                     1,
		ExpiresAt:                now.Add(time.Hour),
		AllowedBrowserSessionIDs: []string{"brs_a"},
	})
	dialled := make(chan net.Conn, 1)
	go func() {
		_ = ServeConnector(connector, ConnectorConfig{
			Routes:        table,
			SweepInterval: 5 * time.Millisecond,
			Now:           clock.Now,
			Dial: func(context.Context, string) (net.Conn, error) {
				local, remote := net.Pipe()
				dialled <- remote
				return local, nil
			},
		})
	}()

	stream, err := gateway.Open(header("svc_a", "brs_a", "req_a"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	select {
	case remote := <-dialled:
		defer func() { _ = remote.Close() }()
	case <-time.After(5 * time.Second):
		t.Fatal("the connector never dialled the local destination")
	}

	// Nothing is written after this point: a write would update the stream's
	// progress on both ends and reset the very window under test.
	clock.set(now.Add(2 * time.Minute))
	select {
	case <-stream.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("the connector's own sweep never closed a stream past its idle window")
	}
}
