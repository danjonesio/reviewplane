package gatewayhttp

import (
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

// The upgraded path is the one place a policy instant meets a real socket: after
// the hijack, net/http enforces nothing, so the gateway sets the deadline
// itself. docs/CONNECTOR_PROTOCOL.md section 12.3 requires that deadline —
// a persistent WebSocket must not be a way to hold access open past the route
// that authorised it — and RVP-61 was what happened when the instant crossed
// that boundary untranslated.
//
// The two properties below are opposite failure directions of the same line, so
// neither test is sufficient alone: one proves a live route is not killed, the
// other proves an expiring route is not spared.

// TestAnUpgradedConnectionDoesNotDependOnWhereThePolicyClockSits is the
// regression for RVP-61 itself.
//
// The gateway's clock is injected so that route expiry can be tested without
// sleeping, which means it can sit anywhere relative to the wall clock. Whether
// an upgraded connection works must not depend on where.
func TestAnUpgradedConnectionDoesNotDependOnWhereThePolicyClockSits(t *testing.T) {
	origins := []struct {
		name string
		at   time.Time
	}{
		{"a decade behind the wall clock", time.Date(2016, 3, 1, 9, 0, 0, 0, time.UTC)},
		{"years ahead of the wall clock", time.Date(2031, 6, 1, 9, 0, 0, 0, time.UTC)},
	}
	for _, origin := range origins {
		t.Run(origin.name, func(t *testing.T) {
			h := newHarness(t, harnessOptions{
				devHandler:  echoWebSocketHandler(t, nil),
				clockOrigin: origin.at,
			})
			h.publish(RegisterRequest{})

			socket := h.mustOpenUpgrade(upgradeAttempt{capability: h.defaultCapability()})
			for _, message := range []string{"hello", strings.Repeat("x", 4096)} {
				if err := socket.writeText(message); err != nil {
					t.Fatalf("write: %v", err)
				}
				frame, err := socket.read()
				if err != nil {
					t.Fatalf("read echo: %v", err)
				}
				if frame.opcode != wsOpcodeText || string(frame.payload) != "echo:"+message {
					t.Fatalf("echo returned opcode %d and %d bytes", frame.opcode, len(frame.payload))
				}
			}

			// A control frame as well, because the relay must survive in both
			// directions rather than merely accept the first write.
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
		})
	}
}

// TestAnUpgradedConnectionIsClosedByItsRouteDeadlineWithoutTheSweep proves the
// deadline is still doing its job after the translation.
//
// Nothing here advances the injected clock and nothing runs EnforceDeadlines,
// so the deadline sweep — the other mechanism that closes an expired stream —
// cannot act. The socket deadline set at the switch is the only thing left that
// can end this connection, which is what makes this test fail if that line is
// deleted, and fail if it is translated into a lifetime longer than the route's.
func TestAnUpgradedConnectionIsClosedByItsRouteDeadlineWithoutTheSweep(t *testing.T) {
	const lifetime = 2 * time.Second

	h := newHarness(t, harnessOptions{devHandler: echoWebSocketHandler(t, nil)})
	registration := h.defaultRegistration()
	registration.ExpiresAt = h.clock.Now().Add(lifetime).Format(time.RFC3339)
	h.publish(registration)

	opened := time.Now()
	socket := h.mustOpenUpgrade(upgradeAttempt{capability: h.defaultCapability()})

	// Alive first. An untranslated policy instant is years in the past, so the
	// kernel would fire the deadline on this very exchange.
	if err := socket.writeText("before"); err != nil {
		t.Fatalf("write: %v", err)
	}
	frame, err := socket.read()
	if err != nil {
		t.Fatalf("the connection was closed before its route expired: %v", err)
	}
	if string(frame.payload) != "echo:before" {
		t.Fatalf("echo returned %q", frame.payload)
	}

	// The read bound is far longer than the route's lifetime, so that a gateway
	// which never sets the deadline is caught by this test rather than hidden
	// by it: it would sit here until this deadline instead, and both the error
	// and the elapsed time say which happened.
	_ = socket.conn.SetReadDeadline(time.Now().Add(20 * time.Second))
	_, err = socket.read()
	elapsed := time.Since(opened)

	if err == nil {
		t.Fatal("the upgraded connection outlived the route deadline that authorised it")
	}
	if errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("after %v the gateway had still not closed the connection; "+
			"this test's own read deadline expired instead, so the route's "+
			"deadline is not reaching the socket", elapsed)
	}
	if elapsed < lifetime {
		t.Fatalf("the connection closed after %v, inside its route's %v lifetime", elapsed, lifetime)
	}
}
