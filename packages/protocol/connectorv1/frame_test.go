package connectorv1

import (
	"bytes"
	"strings"
	"testing"
)

// Denial and failure cases required by the AGENTS.md completion standard.

// canonicalHeartbeat returns the canonical encoding of the heartbeat fixture,
// which carries no trailing whitespace, so that every strict prefix of it is a
// genuinely truncated frame.
func canonicalHeartbeat(t *testing.T) []byte {
	t.Helper()
	frame, failure := DecodeControlFrame(readFixture(t, "valid/heartbeat.json"))
	if failure != nil {
		t.Fatalf("heartbeat fixture refused: %v", failure)
	}
	encoded, err := EncodeControlFrame(frame)
	if err != nil {
		t.Fatalf("encode heartbeat fixture: %v", err)
	}
	return encoded
}

func TestUnknownProtocolVersionYieldsProtocolUnsupported(t *testing.T) {
	raw := []byte(`{"protocol_version":99,"message_id":"msg_a","type":"heartbeat",` +
		`"sent_at":"2026-07-28T11:00:00Z","connector_id":"con_a","payload":{}}`)
	_, failure := DecodeControlFrame(raw)
	if failure == nil {
		t.Fatal("expected refusal")
	}
	if failure.Reason != ReasonUnsupportedProtocolVersion {
		t.Fatalf("reason %q", failure.Reason)
	}
	if failure.ErrorClass != ErrorClassProtocolUnsupported {
		t.Fatalf("error class %q, want %q", failure.ErrorClass, ErrorClassProtocolUnsupported)
	}
}

func TestProtocolVersionMustBeAnInteger(t *testing.T) {
	for _, version := range []string{`"1"`, `1.5`, `null`, `true`, `[1]`} {
		raw := []byte(`{"protocol_version":` + version + `,"message_id":"msg_a","type":"heartbeat",` +
			`"sent_at":"2026-07-28T11:00:00Z","connector_id":"con_a","payload":{}}`)
		_, failure := DecodeControlFrame(raw)
		if failure == nil || failure.Reason != ReasonUnsupportedProtocolVersion {
			t.Fatalf("protocol_version %s was not refused as an unsupported version: %v", version, failure)
		}
	}
}

func TestUnknownMessageTypeIsRejectedRatherThanIgnored(t *testing.T) {
	raw := []byte(`{"protocol_version":1,"message_id":"msg_a","type":"connector.shell.exec",` +
		`"sent_at":"2026-07-28T11:00:00Z","connector_id":"con_a","payload":{"command":"id"}}`)
	_, failure := DecodeControlFrame(raw)
	if failure == nil {
		t.Fatal("expected refusal")
	}
	if failure.Reason != ReasonUnknownMessageType {
		t.Fatalf("reason %q", failure.Reason)
	}
	if failure.ErrorClass != ErrorClassProtocolUnsupported {
		t.Fatalf("error class %q", failure.ErrorClass)
	}
}

// A frame that is both oversized and malformed must be refused for its size.
// That ordering is the proof that the byte bound is applied before the parser
// ever sees the body.
func TestOversizedFrameIsRefusedBeforeDeserialisation(t *testing.T) {
	raw := append([]byte(`{"protocol_version":1,"type":"heartbeat","payload":{"padding":"`),
		bytes.Repeat([]byte("a"), MaxControlFrameBytes)...)
	_, failure := DecodeControlFrame(raw)
	if failure == nil {
		t.Fatal("expected refusal")
	}
	if failure.Reason != ReasonFrameTooLarge {
		t.Fatalf("reason %q, want %q; the size bound must win over the parse error",
			failure.Reason, ReasonFrameTooLarge)
	}
}

func TestOversizedDataStreamHeaderIsRefused(t *testing.T) {
	raw := append([]byte(`{"route_id":"svc_a","padding":"`),
		bytes.Repeat([]byte("a"), MaxDataStreamHeaderBytes)...)
	_, failure := DecodeDataStreamHeaderFrame(raw)
	if failure == nil || failure.Reason != ReasonFrameTooLarge {
		t.Fatalf("oversized header was not refused for its size: %v", failure)
	}
}

// Every truncation of a valid frame must be refused without panicking.
func TestTruncatedFramesAreRefusedWithoutPanic(t *testing.T) {
	full := canonicalHeartbeat(t)
	for cut := 0; cut < len(full); cut++ {
		prefix := full[:cut]
		func() {
			defer func() {
				if recovered := recover(); recovered != nil {
					t.Fatalf("panic on %d byte prefix: %v", cut, recovered)
				}
			}()
			if _, failure := DecodeControlFrame(prefix); failure == nil {
				t.Fatalf("%d byte prefix of a valid frame was accepted", cut)
			}
		}()
	}
}

// Every single-byte corruption of a valid frame must either be refused or
// decode cleanly; neither may panic.
func TestCorruptedFramesNeverPanic(t *testing.T) {
	full := canonicalHeartbeat(t)
	for index := range full {
		for _, replacement := range []byte{0x00, '"', '{', '}', 0xff, 'Z'} {
			corrupted := bytes.Clone(full)
			corrupted[index] = replacement
			func() {
				defer func() {
					if recovered := recover(); recovered != nil {
						t.Fatalf("panic at byte %d replaced with %q: %v", index, replacement, recovered)
					}
				}()
				_, _ = DecodeControlFrame(corrupted)
			}()
		}
	}
}

func TestPayloadExceedingItsBoundIsRefused(t *testing.T) {
	raw := readFixture(t, "invalid/registration-request-oversized-payload.json")
	_, failure := DecodeControlFrame(raw)
	if failure == nil {
		t.Fatal("expected refusal")
	}
	if failure.Reason != ReasonPayloadTooLarge {
		t.Fatalf("reason %q, want %q", failure.Reason, ReasonPayloadTooLarge)
	}
	if failure.ErrorClass != "" {
		t.Fatalf("payload_too_large has no wire error class, got %q", failure.ErrorClass)
	}
}

func TestEncodeRefusesAFrameWhosePayloadTypeDisagreesWithTheEnvelope(t *testing.T) {
	frame := Frame{
		Envelope: Envelope{
			ProtocolVersion: ProtocolVersion,
			MessageID:       "msg_a",
			Type:            MessageTypeRoutePublishAck,
			SentAt:          "2026-07-28T11:00:00Z",
		},
		Payload: Heartbeat{Status: HeartbeatStatusHealthy, Version: "0.1.0"},
	}
	if _, err := EncodeControlFrame(frame); err == nil {
		t.Fatal("expected a mismatched frame to be refused")
	}
}

func TestUnknownPropertiesAreRefusedEverywhere(t *testing.T) {
	raw := readFixture(t, "valid/heartbeat.json")
	injected := strings.Replace(string(raw), `"status": "healthy"`,
		`"status": "healthy", "process_command_line": "/usr/bin/node"`, 1)
	if injected == string(raw) {
		t.Fatal("fixture shape changed; the injection point no longer exists")
	}
	_, failure := DecodeControlFrame([]byte(injected))
	if failure == nil || failure.Reason != ReasonSchemaViolation {
		t.Fatalf("unknown property was not refused: %v", failure)
	}
	found := false
	for _, violation := range failure.Violations {
		if violation.Code == SchemaViolationUnknownProperty {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected an unknown_property violation, got %+v", failure.Violations)
	}
}

// Identifiers are opaque (docs/DOMAIN_MODEL.md section 3): the schema bounds
// length and character class only, and must not require a prefix.
func TestIdentifiersAreTreatedAsOpaque(t *testing.T) {
	raw := readFixture(t, "valid/route-publish-opaque-identifiers.json")
	frame, failure := DecodeControlFrame(raw)
	if failure != nil {
		t.Fatalf("unprefixed identifiers were refused: %v", failure)
	}
	publish, ok := frame.Payload.(RoutePublish)
	if !ok {
		t.Fatalf("unexpected payload %T", frame.Payload)
	}
	if strings.HasPrefix(publish.RouteID, "svc_") {
		t.Fatal("fixture no longer exercises an unprefixed identifier")
	}
}

func TestProtocolErrorMessageDoesNotEchoAnUnboundedValue(t *testing.T) {
	long := strings.Repeat("x", 4096)
	raw := []byte(`{"protocol_version":1,"message_id":"msg_a","type":"` + long + `",` +
		`"sent_at":"2026-07-28T11:00:00Z","payload":{}}`)
	_, failure := DecodeControlFrame(raw)
	if failure == nil {
		t.Fatal("expected refusal")
	}
	if len(failure.Msg) > 256 {
		t.Fatalf("error message echoed %d bytes of untrusted input", len(failure.Msg))
	}
}

func FuzzDecodeControlFrame(f *testing.F) {
	seed, err := readFixtureFile("valid/heartbeat.json")
	if err != nil {
		f.Fatalf("read seed fixture: %v", err)
	}
	f.Add(string(seed))
	f.Add(`{"protocol_version":1}`)
	f.Add(`{}`)
	f.Add(``)
	f.Add(`[`)
	f.Add(`{"protocol_version":1,"type":"heartbeat","payload":{"status":"healthy"}}`)
	f.Fuzz(func(t *testing.T, raw string) {
		frame, failure := DecodeControlFrame([]byte(raw))
		if failure != nil {
			return
		}
		// Anything accepted must re-encode, and the re-encoding must be
		// accepted again with the same result.
		encoded, err := EncodeControlFrame(frame)
		if err != nil {
			t.Fatalf("accepted frame failed to encode: %v", err)
		}
		again, failure := DecodeControlFrame(encoded)
		if failure != nil {
			t.Fatalf("canonical form of an accepted frame was refused: %v", failure)
		}
		second, err := EncodeControlFrame(again)
		if err != nil {
			t.Fatalf("re-encode failed: %v", err)
		}
		if !bytes.Equal(encoded, second) {
			t.Fatalf("canonical encoding is not stable:\n  %s\n  %s", encoded, second)
		}
	})
}
