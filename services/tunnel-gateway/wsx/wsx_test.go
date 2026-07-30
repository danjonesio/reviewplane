package wsx

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// Unit and hostile-input layers (docs/TESTING.md sections 2 and 10). The
// transport is the first thing an attacker reaches, so its refusals are tested
// as carefully as its happy path.

func echoServer(t *testing.T, options Options) (*httptest.Server, *sync.WaitGroup) {
	t.Helper()
	var wait sync.WaitGroup
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The count is taken before the connection is hijacked, so that the
		// server's own Close cannot return before this echo goroutine is
		// registered for the cleanup to wait on.
		wait.Add(1)
		conn, err := Accept(w, r, options)
		if err != nil {
			wait.Done()
			return
		}
		go func() {
			defer wait.Done()
			defer func() { _ = conn.Close(CloseNormal, "") }()
			for {
				message, readErr := conn.ReadMessage()
				if readErr != nil {
					return
				}
				if writeErr := conn.WriteMessage(message); writeErr != nil {
					return
				}
			}
		}()
	}))
	t.Cleanup(func() {
		server.Close()
		wait.Wait()
	})
	return server, &wait
}

func endpoint(server *httptest.Server) string {
	return "ws://" + strings.TrimPrefix(server.URL, "http://") + "/connector/data"
}

func TestBinaryMessagesRoundTrip(t *testing.T) {
	server, _ := echoServer(t, Options{MaxMessageBytes: 1 << 20})
	conn, err := Dial(endpoint(server), nil, nil, Options{MaxMessageBytes: 1 << 20})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.Close(CloseNormal, "") }()

	for _, payload := range [][]byte{
		[]byte("short"),
		bytes.Repeat([]byte("m"), 200),    // two-byte length
		bytes.Repeat([]byte("l"), 70_000), // eight-byte length
		{},                                // empty
		{0x00, 0xff, 0x7f, 0x80},          // binary, not text
	} {
		if err := conn.WriteMessage(payload); err != nil {
			t.Fatalf("write %d bytes: %v", len(payload), err)
		}
		echoed, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if !bytes.Equal(echoed, payload) {
			t.Fatalf("echoed %d bytes, sent %d", len(echoed), len(payload))
		}
	}
}

func TestAMessageBeyondTheBoundIsRefusedBeforeItIsAllocated(t *testing.T) {
	server, _ := echoServer(t, Options{MaxMessageBytes: 1024})
	conn, err := Dial(endpoint(server), nil, nil, Options{MaxMessageBytes: 1 << 20})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.Close(CloseNormal, "") }()

	if err := conn.WriteMessage(bytes.Repeat([]byte("x"), 4096)); err != nil {
		t.Fatalf("write: %v", err)
	}
	// The server refuses it and closes; the client sees the connection end
	// rather than an echo.
	_ = conn.conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := conn.ReadMessage(); err == nil {
		t.Fatal("an oversized message was echoed back")
	}
}

func TestALocalMessageBeyondTheBoundIsRefused(t *testing.T) {
	server, _ := echoServer(t, Options{MaxMessageBytes: 1024})
	conn, err := Dial(endpoint(server), nil, nil, Options{MaxMessageBytes: 1024})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.Close(CloseNormal, "") }()
	if err := conn.WriteMessage(make([]byte, 2048)); err == nil {
		t.Fatal("a message beyond the local bound was written")
	}
}

func TestTheHandshakeRequiresTheSubprotocol(t *testing.T) {
	// A browser or a generic WebSocket client must not be able to open a data
	// channel by accident.
	server, _ := echoServer(t, Options{})
	request, err := http.NewRequest(http.MethodGet, server.URL+"/connector/data", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	request.Header.Set("Sec-WebSocket-Version", "13")
	request.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode == http.StatusSwitchingProtocols {
		t.Fatal("an upgrade without the subprotocol was accepted")
	}
}

func TestTheHandshakeRequiresVersionThirteen(t *testing.T) {
	server, _ := echoServer(t, Options{})
	request, err := http.NewRequest(http.MethodGet, server.URL+"/connector/data", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	request.Header.Set("Sec-WebSocket-Version", "8")
	request.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	request.Header.Set("Sec-WebSocket-Protocol", Subprotocol)
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode == http.StatusSwitchingProtocols {
		t.Fatal("an upgrade at another version was accepted")
	}
	if response.Header.Get("Sec-WebSocket-Version") != "13" {
		t.Fatal("the refusal did not name the supported version")
	}
}

func TestAnOrdinaryRequestIsNotUpgraded(t *testing.T) {
	server, _ := echoServer(t, Options{})
	response, err := server.Client().Get(server.URL + "/connector/data")
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", response.StatusCode)
	}
}

func TestUnmaskedClientFramesAreRefused(t *testing.T) {
	// RFC 6455 section 5.1. A peer that does not mask is claiming the server
	// role on a client connection.
	server, _ := echoServer(t, Options{})
	conn, err := Dial(endpoint(server), nil, nil, Options{})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.Close(CloseNormal, "") }()

	// Write a server-shaped (unmasked) binary frame from the client side.
	if _, err := conn.conn.Write([]byte{0x82, 0x03, 'a', 'b', 'c'}); err != nil {
		t.Fatalf("write raw frame: %v", err)
	}
	_ = conn.conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := conn.ReadMessage(); err == nil {
		t.Fatal("an unmasked client frame was accepted")
	}
}

func TestReservedBitsAreRefused(t *testing.T) {
	server, _ := echoServer(t, Options{})
	conn, err := Dial(endpoint(server), nil, nil, Options{})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.Close(CloseNormal, "") }()
	// RSV1 set, masked, empty payload. No extension was negotiated, so the bit
	// would change how the frame is read.
	if _, err := conn.conn.Write([]byte{0xc2, 0x80, 0, 0, 0, 0}); err != nil {
		t.Fatalf("write raw frame: %v", err)
	}
	_ = conn.conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := conn.ReadMessage(); err == nil {
		t.Fatal("a frame with a reserved bit set was accepted")
	}
}

func TestTextMessagesAreRefused(t *testing.T) {
	server, _ := echoServer(t, Options{})
	conn, err := Dial(endpoint(server), nil, nil, Options{})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.Close(CloseNormal, "") }()
	// A masked text frame carrying "hi".
	if _, err := conn.conn.Write([]byte{0x81, 0x82, 0, 0, 0, 0, 'h', 'i'}); err != nil {
		t.Fatalf("write raw frame: %v", err)
	}
	_ = conn.conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := conn.ReadMessage(); err == nil {
		t.Fatal("a text message was accepted")
	}
}

func TestPingIsAnswered(t *testing.T) {
	server, _ := echoServer(t, Options{})
	conn, err := Dial(endpoint(server), nil, nil, Options{})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.Close(CloseNormal, "") }()
	if err := conn.Ping([]byte("alive")); err != nil {
		t.Fatalf("ping: %v", err)
	}
	// The pong is consumed by ReadMessage, so a following message still
	// arrives.
	if err := conn.WriteMessage([]byte("after the ping")); err != nil {
		t.Fatalf("write: %v", err)
	}
	echoed, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(echoed) != "after the ping" {
		t.Fatalf("echoed %q", echoed)
	}
}

func TestClosingIsReportedAsErrClosed(t *testing.T) {
	server, _ := echoServer(t, Options{})
	conn, err := Dial(endpoint(server), nil, nil, Options{})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if err := conn.Close(CloseGoingAway, "done"); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := conn.WriteMessage([]byte("x")); err != ErrClosed {
		t.Fatalf("writing to a closed connection returned %v", err)
	}
}

func TestDialRefusesAPlaintextEndpointWhenTLSIsConfigured(t *testing.T) {
	if _, err := Dial("wss://127.0.0.1:1/x", nil, nil, Options{}); err == nil {
		t.Fatal("wss without a TLS configuration was accepted")
	}
	if _, err := Dial("http://127.0.0.1:1/x", nil, nil, Options{}); err == nil {
		t.Fatal("a non-WebSocket scheme was accepted")
	}
}
