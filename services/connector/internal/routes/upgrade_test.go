package routes_test

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	connectorv1 "github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/datachannel"
)

// The connector's half of an upgraded stream (docs/CONNECTOR_PROTOCOL.md
// section 13.3).
//
// The connector never learns that a connection has been switched by looking at
// what is flowing through it: section 12 forbids parsing the relayed bytes, so
// the mode is declared in the stream header instead. What is asserted here is
// that the declaration changes the stream's lifetime and nothing else — in
// particular, that the destination is still the one fixed at publication.

const upgradeGUID = "258EAFA5-E914-47DA-95CA-5AB0DC85B11F"

// startUpgradeFixture is a loopback development service that answers a
// WebSocket handshake and then echoes whatever bytes it is sent. The framing is
// irrelevant to the connector, which is the point: a byte echo proves the relay
// without asserting anything about WebSocket frames.
func startUpgradeFixture(t *testing.T, seen chan<- http.Header) int {
	t.Helper()
	return startFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("Sec-WebSocket-Key")
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || key == "" {
			http.Error(w, "not a handshake", http.StatusBadRequest)
			return
		}
		select {
		case seen <- r.Header.Clone():
		default:
		}
		conn, buffered, err := http.NewResponseController(w).Hijack()
		if err != nil {
			t.Errorf("fixture could not hijack: %v", err)
			return
		}
		defer func() { _ = conn.Close() }()
		sum := sha1.Sum([]byte(key + upgradeGUID))
		if _, err := io.WriteString(conn, "HTTP/1.1 101 Switching Protocols\r\n"+
			"Upgrade: websocket\r\nConnection: Upgrade\r\n"+
			"Sec-WebSocket-Accept: "+base64.StdEncoding.EncodeToString(sum[:])+"\r\n\r\n"); err != nil {
			return
		}
		_, _ = io.Copy(conn, buffered.Reader)
	}))
}

func upgradeStreamHeader(streamID string) connectorv1.DataStreamHeader {
	mode := connectorv1.StreamModeUpgrade
	return connectorv1.DataStreamHeader{
		RouteID:             "svc_test_route",
		BrowserSessionID:    "brs_test",
		SessionCapability:   connectorv1.SessionCapability("rp1.test-capability"),
		StreamID:            streamID,
		DestinationProtocol: connectorv1.DestinationProtocolHTTP,
		Deadline:            time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
		StreamMode:          &mode,
	}
}

func TestTheDataPlaneRelaysAnUpgradedStreamToTheAuthorisedDestination(t *testing.T) {
	seen := make(chan http.Header, 1)
	port := startUpgradeFixture(t, seen)

	manager := newManager(t, widePolicy(port))
	ack := manager.Publish(publication("127.0.0.1", port, time.Now().Add(time.Hour)))
	if ack.Status != connectorv1.RoutePublishAckStatusReady {
		t.Fatalf("publication was refused: %v", ack.ErrorClass)
	}

	left, right := newPipe()
	gateway := datachannel.NewSession(left, datachannel.RoleGateway, datachannel.SessionConfig{})
	connector := datachannel.NewSession(right, datachannel.RoleConnector, datachannel.SessionConfig{})
	defer gateway.Close(nil)
	defer connector.Close(nil)
	go func() {
		_ = datachannel.ServeConnector(connector, datachannel.ConnectorConfig{Routes: manager.Table()})
	}()

	stream, err := gateway.Open(upgradeStreamHeader("str_upgrade"))
	if err != nil {
		t.Fatalf("opening an upgraded stream: %v", err)
	}
	handshake := "GET / HTTP/1.1\r\n" +
		"Host: 127.0.0.1\r\n" +
		"Connection: Upgrade\r\n" +
		"Upgrade: websocket\r\n" +
		"Sec-WebSocket-Version: 13\r\n" +
		"Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n\r\n"
	if _, err := io.WriteString(stream, handshake); err != nil {
		t.Fatalf("writing the handshake: %v", err)
	}

	reader := bufio.NewReader(stream)
	response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatalf("reading the handshake response: %v", err)
	}
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("the development service answered %d", response.StatusCode)
	}

	// After the switch the connector is moving bytes in both directions with no
	// HTTP left to parse, which is what an echo proves.
	for _, payload := range []string{"first", "second"} {
		if _, err := io.WriteString(stream, payload); err != nil {
			t.Fatalf("writing after the switch: %v", err)
		}
		echoed := make([]byte, len(payload))
		if _, err := io.ReadFull(reader, echoed); err != nil {
			t.Fatalf("reading after the switch: %v", err)
		}
		if string(echoed) != payload {
			t.Fatalf("the relay returned %q, want %q", echoed, payload)
		}
	}

	header := <-seen
	if header.Get("Host") != "" && header.Get("Host") != "127.0.0.1" {
		t.Fatalf("the development service saw Host %q", header.Get("Host"))
	}

	// The stream's own lifetime is the upgraded one, taken from the declared
	// mode rather than from anything in the bytes.
	if stream.Mode() != connectorv1.StreamModeUpgrade {
		t.Fatalf("the stream reported mode %q", stream.Mode())
	}
	if stream.IdleTimeout() != datachannel.DefaultUpgradeIdleTimeout {
		t.Fatalf("the upgraded stream took a %s idle window", stream.IdleTimeout())
	}
}

func TestAnUpgradedStreamForAnUnpublishedRouteOpensNothing(t *testing.T) {
	// The declared mode does not soften any check. A route this connector does
	// not carry reaches nothing, upgraded or otherwise.
	seen := make(chan http.Header, 1)
	port := startUpgradeFixture(t, seen)
	manager := newManager(t, widePolicy(port))

	left, right := newPipe()
	gateway := datachannel.NewSession(left, datachannel.RoleGateway, datachannel.SessionConfig{})
	connector := datachannel.NewSession(right, datachannel.RoleConnector, datachannel.SessionConfig{})
	defer gateway.Close(nil)
	defer connector.Close(nil)
	go func() {
		_ = datachannel.ServeConnector(connector, datachannel.ConnectorConfig{Routes: manager.Table()})
	}()

	stream, err := gateway.Open(upgradeStreamHeader("str_unknown"))
	if err != nil {
		t.Fatalf("opening a stream: %v", err)
	}
	if _, err := io.ReadAll(stream); err == nil {
		t.Fatal("an upgraded stream for an unpublished route was served")
	}
	select {
	case <-seen:
		t.Fatal("the development service was reached for an unpublished route")
	default:
	}
}

func TestAnUpgradedStreamForAnUnauthorisedSessionOpensNothing(t *testing.T) {
	seen := make(chan http.Header, 1)
	port := startUpgradeFixture(t, seen)
	manager := newManager(t, widePolicy(port))
	if ack := manager.Publish(publication("127.0.0.1", port, time.Now().Add(time.Hour))); ack.Status !=
		connectorv1.RoutePublishAckStatusReady {
		t.Fatalf("publication was refused: %v", ack.ErrorClass)
	}

	left, right := newPipe()
	gateway := datachannel.NewSession(left, datachannel.RoleGateway, datachannel.SessionConfig{})
	connector := datachannel.NewSession(right, datachannel.RoleConnector, datachannel.SessionConfig{})
	defer gateway.Close(nil)
	defer connector.Close(nil)
	go func() {
		_ = datachannel.ServeConnector(connector, datachannel.ConnectorConfig{Routes: manager.Table()})
	}()

	header := upgradeStreamHeader("str_wrong_session")
	header.BrowserSessionID = "brs_not_authorised"
	stream, err := gateway.Open(header)
	if err != nil {
		t.Fatalf("opening a stream: %v", err)
	}
	if _, err := io.ReadAll(stream); err == nil {
		t.Fatal("an upgraded stream for an unauthorised browser session was served")
	}
	select {
	case <-seen:
		t.Fatal("the development service was reached for an unauthorised browser session")
	default:
	}
}
