package protocolio

import (
	"regexp"
	"testing"
	"time"

	connectorv1 "github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
)

// The schema bounds identifiers to this character class and length; the
// conventional prefix is documentation only.
var identifierPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func TestNewMessageIDSatisfiesTheIdentifierBounds(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 64; i++ {
		id, err := NewMessageID()
		if err != nil {
			t.Fatalf("NewMessageID: %v", err)
		}
		if !identifierPattern.MatchString(id) {
			t.Fatalf("message id %q is outside the schema's identifier bounds", id)
		}
		if seen[id] {
			t.Fatalf("message id %q was produced twice", id)
		}
		seen[id] = true
	}
}

// The schema's timestamp definition demands RFC 3339 in UTC with a trailing Z.
var timestampPattern = regexp.MustCompile(
	`^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,9})?Z$`)

func TestTimestampIsUTCWithATrailingZ(t *testing.T) {
	cases := []time.Time{
		time.Date(2026, 7, 28, 11, 0, 0, 0, time.UTC),
		time.Date(2026, 1, 2, 3, 4, 5, 123456789, time.UTC),
		time.Date(2026, 12, 31, 23, 59, 59, 0, time.FixedZone("east", 5*3600)),
	}
	for _, at := range cases {
		formatted := Timestamp(at)
		if !timestampPattern.MatchString(formatted) {
			t.Fatalf("Timestamp(%s) = %q, which the schema refuses", at, formatted)
		}
	}
	if got := Timestamp(time.Date(2026, 7, 28, 11, 0, 0, 0, time.UTC)); got != "2026-07-28T11:00:00Z" {
		t.Fatalf("Timestamp = %q", got)
	}
}

func TestNewFrameOmitsConnectorIDOnTheRegistrationExchange(t *testing.T) {
	request := connectorv1.RegistrationRequest{
		EnrolmentToken: connectorv1.EnrolmentToken("an-enrolment-token-value"),
		PublicKey:      "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
		Environment: connectorv1.EnvironmentDescriptor{
			Name: "dev-ai-03", Platform: "linux", Architecture: "amd64",
		},
		Connector: connectorv1.ConnectorDescriptor{Version: "0.1.0", Capabilities: []string{"http-tunnel"}},
	}
	// A caller passing an identifier does not matter: the schema forbids it on
	// this message type.
	frame, err := NewFrame(request, "con_ignored", time.Now())
	if err != nil {
		t.Fatalf("NewFrame: %v", err)
	}
	if frame.Envelope.ConnectorID != nil {
		t.Fatal("the registration exchange must carry no connector_id")
	}
	encoded, err := Encode(frame)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	if _, protocolErr := connectorv1.DecodeControlFrame(encoded); protocolErr != nil {
		t.Fatalf("the encoded registration frame was refused: %v", protocolErr)
	}

	// The reverse rule: a post-enrolment message without an identity is
	// refused before it reaches the wire.
	heartbeat := connectorv1.Heartbeat{
		Status: connectorv1.HeartbeatStatusHealthy, UptimeSeconds: 1,
		Version: "0.1.0", ActiveRoutes: 0, ActiveStreams: 0,
	}
	if _, err := NewFrame(heartbeat, "", time.Now()); err == nil {
		t.Fatal("a heartbeat without a connector_id must be refused")
	}
}

func TestNewFrameSetsTheEnvelope(t *testing.T) {
	heartbeat := connectorv1.Heartbeat{
		Status: connectorv1.HeartbeatStatusHealthy, UptimeSeconds: 1,
		Version: "0.1.0", ActiveRoutes: 0, ActiveStreams: 0,
	}
	at := time.Date(2026, 7, 28, 11, 0, 0, 0, time.UTC)
	frame, err := NewFrame(heartbeat, "con_example", at)
	if err != nil {
		t.Fatalf("NewFrame: %v", err)
	}
	if frame.Envelope.ProtocolVersion != connectorv1.ProtocolVersion {
		t.Fatalf("protocol version = %d", frame.Envelope.ProtocolVersion)
	}
	if frame.Envelope.Type != connectorv1.MessageTypeHeartbeat {
		t.Fatalf("type = %q", frame.Envelope.Type)
	}
	if frame.Envelope.SentAt != "2026-07-28T11:00:00Z" {
		t.Fatalf("sent_at = %q", frame.Envelope.SentAt)
	}
	if frame.Envelope.ConnectorID == nil || *frame.Envelope.ConnectorID != "con_example" {
		t.Fatal("the envelope lost its connector_id")
	}
	encoded, err := Encode(frame)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	if _, protocolErr := connectorv1.DecodeControlFrame(encoded); protocolErr != nil {
		t.Fatalf("the encoded frame was refused by the decoder: %v", protocolErr)
	}
}
