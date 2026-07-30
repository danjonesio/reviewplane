package ws

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// echoServer upgrades and echoes text messages back.
func echoServer(t *testing.T, handler func(*Conn, *http.Request)) (string, *tls.Config) {
	t.Helper()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := Accept(w, r, AcceptOptions{MaxMessageBytes: 4096})
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		defer func() { _ = conn.CloseNow() }()
		handler(conn, r)
	}))
	t.Cleanup(server.Close)

	pool := x509.NewCertPool()
	pool.AddCert(server.Certificate())
	return "wss://" + strings.TrimPrefix(server.URL, "https://"), &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
}

func TestRoundTrip(t *testing.T) {
	url, tlsConfig := echoServer(t, func(conn *Conn, r *http.Request) {
		for {
			_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
			opcode, payload, err := conn.ReadMessage(r.Context())
			if err != nil {
				return
			}
			if opcode == OpText {
				_ = conn.WriteText(payload)
			}
		}
	})
	conn, err := Dial(context.Background(), url, DialOptions{TLSConfig: tlsConfig, MaxMessageBytes: 4096})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer func() { _ = conn.CloseNow() }()

	for _, message := range []string{"a", strings.Repeat("x", 200), strings.Repeat("y", 3000)} {
		if err := conn.WriteText([]byte(message)); err != nil {
			t.Fatalf("WriteText: %v", err)
		}
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		opcode, payload, err := conn.ReadMessage(context.Background())
		if err != nil {
			t.Fatalf("ReadMessage: %v", err)
		}
		if opcode != OpText || string(payload) != message {
			t.Fatalf("echo returned opcode %d and %d bytes", opcode, len(payload))
		}
	}
}

func TestDialRefusesPlaintextSchemes(t *testing.T) {
	for _, url := range []string{"ws://example.internal/x", "https://example.internal/x", "http://example.internal"} {
		if _, err := Dial(context.Background(), url, DialOptions{}); err == nil {
			t.Fatalf("Dial accepted %q", url)
		} else if !strings.Contains(err.Error(), "wss") {
			t.Fatalf("Dial(%q) error %q does not mention the required scheme", url, err)
		}
	}
}

func TestDialReportsHandshakeRefusal(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "IDENTITY_REVOKED", http.StatusUnauthorized)
	}))
	defer server.Close()
	pool := x509.NewCertPool()
	pool.AddCert(server.Certificate())

	_, err := Dial(context.Background(), "wss://"+strings.TrimPrefix(server.URL, "https://"), DialOptions{
		TLSConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
	})
	var handshake *HandshakeError
	if !errors.As(err, &handshake) {
		t.Fatalf("Dial error = %v, want a HandshakeError", err)
	}
	if handshake.StatusCode != http.StatusUnauthorized || handshake.Body != "IDENTITY_REVOKED" {
		t.Fatalf("handshake error = %+v", handshake)
	}
}

// docs/CONNECTOR_PROTOCOL.md section 22 requires bounded allocation: an
// oversized message is refused rather than assembled.
func TestOversizedMessageIsRefusedWithoutPanic(t *testing.T) {
	url, tlsConfig := echoServer(t, func(conn *Conn, _ *http.Request) {
		_ = conn.WriteText([]byte(strings.Repeat("z", 9000)))
		time.Sleep(200 * time.Millisecond)
	})
	conn, err := Dial(context.Background(), url, DialOptions{TLSConfig: tlsConfig, MaxMessageBytes: 1024})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer func() { _ = conn.CloseNow() }()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, _, err = conn.ReadMessage(context.Background())
	if err == nil {
		t.Fatal("an oversized message must be refused")
	}
	if !strings.Contains(err.Error(), "1024 byte bound") {
		t.Fatalf("error %q does not name the bound", err)
	}
}

func TestFragmentedMessageIsAssembled(t *testing.T) {
	url, tlsConfig := echoServer(t, func(conn *Conn, _ *http.Request) {
		// Two fragments: an unfinished text frame then a final continuation.
		writeRawFrame(conn, OpText, false, []byte("first "))
		writeRawFrame(conn, OpContinuation, true, []byte("second"))
		time.Sleep(200 * time.Millisecond)
	})
	conn, err := Dial(context.Background(), url, DialOptions{TLSConfig: tlsConfig, MaxMessageBytes: 4096})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer func() { _ = conn.CloseNow() }()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, payload, err := conn.ReadMessage(context.Background())
	if err != nil {
		t.Fatalf("ReadMessage: %v", err)
	}
	if string(payload) != "first second" {
		t.Fatalf("assembled message = %q", payload)
	}
}

// writeRawFrame writes a frame with an explicit FIN bit, for fragmentation
// tests. It exists only in the test build.
func writeRawFrame(conn *Conn, opcode byte, final bool, payload []byte) {
	header := []byte{opcode, byte(len(payload))}
	if final {
		header[0] |= 0x80
	}
	conn.writeMutex.Lock()
	defer conn.writeMutex.Unlock()
	_, _ = conn.conn.Write(append(header, payload...))
}

func TestPingIsAnsweredAndPongObserved(t *testing.T) {
	url, tlsConfig := echoServer(t, func(conn *Conn, r *http.Request) {
		for {
			_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
			if _, _, err := conn.ReadMessage(r.Context()); err != nil {
				return
			}
		}
	})
	conn, err := Dial(context.Background(), url, DialOptions{TLSConfig: tlsConfig, MaxMessageBytes: 4096})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer func() { _ = conn.CloseNow() }()

	pongs := make(chan struct{}, 1)
	conn.SetPongHandler(func() {
		select {
		case pongs <- struct{}{}:
		default:
		}
	})
	if err := conn.Ping(); err != nil {
		t.Fatalf("Ping: %v", err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, _, _ = conn.ReadMessage(context.Background())
	}()
	select {
	case <-pongs:
	case <-time.After(3 * time.Second):
		t.Fatal("no pong observed")
	}
	_ = conn.CloseNow()
	<-done
}

func TestCloseCarriesCodeAndReason(t *testing.T) {
	url, tlsConfig := echoServer(t, func(conn *Conn, _ *http.Request) {
		_ = conn.Close(ClosePolicyViolation, "IDENTITY_REVOKED")
	})
	conn, err := Dial(context.Background(), url, DialOptions{TLSConfig: tlsConfig, MaxMessageBytes: 4096})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer func() { _ = conn.CloseNow() }()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, _, err = conn.ReadMessage(context.Background())
	var closeErr *CloseError
	if !errors.As(err, &closeErr) {
		t.Fatalf("ReadMessage error = %v, want a CloseError", err)
	}
	if closeErr.Code != ClosePolicyViolation || closeErr.Reason != "IDENTITY_REVOKED" {
		t.Fatalf("close = %+v", closeErr)
	}
}

func TestAbnormalCloseIsReported(t *testing.T) {
	url, tlsConfig := echoServer(t, func(conn *Conn, _ *http.Request) {
		_ = conn.CloseNow()
	})
	conn, err := Dial(context.Background(), url, DialOptions{TLSConfig: tlsConfig, MaxMessageBytes: 4096})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer func() { _ = conn.CloseNow() }()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, _, err = conn.ReadMessage(context.Background())
	var closeErr *CloseError
	if !errors.As(err, &closeErr) || closeErr.Code != CloseAbnormal {
		t.Fatalf("error = %v, want an abnormal close", err)
	}
}

func TestReadMessageHonoursContextCancellation(t *testing.T) {
	url, tlsConfig := echoServer(t, func(conn *Conn, r *http.Request) {
		<-r.Context().Done()
	})
	conn, err := Dial(context.Background(), url, DialOptions{TLSConfig: tlsConfig, MaxMessageBytes: 4096})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer func() { _ = conn.CloseNow() }()

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	started := time.Now()
	_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	if _, _, err := conn.ReadMessage(ctx); err == nil {
		t.Fatal("ReadMessage must fail when the context is cancelled")
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("ReadMessage returned after %s", elapsed)
	}
}

func TestAcceptRefusesNonUpgradeRequests(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := Accept(w, r, AcceptOptions{}); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
		}
	}))
	defer server.Close()

	response, err := http.Get(server.URL)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", response.StatusCode)
	}
}
