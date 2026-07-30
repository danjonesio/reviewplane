package datachannel

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
)

// Contract layer (docs/TESTING.md section 2): "Contract tests for a protocol run
// one committed fixture corpus in every language that speaks it."
//
// The gateway speaks the connector protocol, so it runs the corpus too. The
// protocol package already runs it, but this build links its own copy of the
// generated models, and the point of the corpus is that every implementation is
// held to one definition of "compatible" rather than to the one nearest it.

const connectorCorpus = "../../../packages/protocol/fixtures/connector/v1"

type validFixture struct {
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	File        string `json:"file"`
	MessageType string `json:"message_type"`
}

type invalidFixture struct {
	Name         string `json:"name"`
	Kind         string `json:"kind"`
	File         string `json:"file"`
	ExpectReason string `json:"expect_reason"`
}

type corpusManifest struct {
	Protocol string           `json:"protocol"`
	Version  int              `json:"version"`
	Valid    []validFixture   `json:"valid"`
	Invalid  []invalidFixture `json:"invalid"`
}

func loadCorpus(t *testing.T) corpusManifest {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(connectorCorpus, "manifest.json"))
	if err != nil {
		t.Fatalf("read the connector corpus: %v", err)
	}
	var manifest corpusManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("parse the connector corpus: %v", err)
	}
	if len(manifest.Valid) == 0 || len(manifest.Invalid) == 0 {
		t.Fatal("the connector corpus is empty")
	}
	return manifest
}

func readCorpusFixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(connectorCorpus, name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return raw
}

func TestGatewayAcceptsTheConnectorCorpus(t *testing.T) {
	manifest := loadCorpus(t)
	for _, fixture := range manifest.Valid {
		t.Run(fixture.Name, func(t *testing.T) {
			raw := readCorpusFixture(t, fixture.File)
			if fixture.Kind == "data_stream_header" {
				header, failure := connectorv1.DecodeDataStreamHeaderFrame(raw)
				if failure != nil {
					t.Fatalf("the corpus accepts this header, this build refused it: %v", failure)
				}
				// A header the gateway accepts must also be one it can open a
				// stream with, which is the property the mux depends on.
				if header.RouteID == "" || header.StreamID == "" {
					t.Fatal("the decoded header carries no route or stream identifier")
				}
				return
			}
			frame, failure := connectorv1.DecodeControlFrame(raw)
			if failure != nil {
				t.Fatalf("the corpus accepts this frame, this build refused it: %v", failure)
			}
			if string(frame.Envelope.Type) != fixture.MessageType {
				t.Fatalf("decoded as %q, the corpus says %q", frame.Envelope.Type, fixture.MessageType)
			}
		})
	}
}

func TestGatewayRefusesTheConnectorCorpusRejections(t *testing.T) {
	manifest := loadCorpus(t)
	for _, fixture := range manifest.Invalid {
		t.Run(fixture.Name, func(t *testing.T) {
			raw := readCorpusFixture(t, fixture.File)
			var reason connectorv1.ViolationReason
			if fixture.Kind == "data_stream_header" {
				_, failure := connectorv1.DecodeDataStreamHeaderFrame(raw)
				if failure == nil {
					t.Fatal("the corpus refuses this header, this build accepted it")
				}
				reason = failure.Reason
			} else {
				_, failure := connectorv1.DecodeControlFrame(raw)
				if failure == nil {
					t.Fatal("the corpus refuses this frame, this build accepted it")
				}
				reason = failure.Reason
			}
			if string(reason) != fixture.ExpectReason {
				t.Fatalf("refused as %q, the corpus requires %q", reason, fixture.ExpectReason)
			}
		})
	}
}

func TestARoutePublishAckRoundTripsThroughTheProtocolPackage(t *testing.T) {
	// The connector answers a publication with this message, and the gateway's
	// route registry is what its contents become. Encoding it through the
	// protocol package rather than encoding/json is what applies the schema's
	// conditional requirements: a ready acknowledgement must carry a
	// destination and no error class.
	destination := "127.0.0.1:5173"
	ack := connectorv1.RoutePublishAck{
		RouteID:             "svc_a",
		Status:              connectorv1.RoutePublishAckStatusReady,
		ObservedDestination: &destination,
	}
	connectorID := "con_a"
	encoded, err := connectorv1.EncodeControlFrame(connectorv1.Frame{
		Envelope: connectorv1.Envelope{
			ProtocolVersion: connectorv1.ProtocolVersion,
			MessageID:       "msg_a",
			Type:            connectorv1.MessageTypeRoutePublishAck,
			SentAt:          "2026-07-30T12:00:00Z",
			ConnectorID:     &connectorID,
		},
		Payload: ack,
	})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	decoded, failure := connectorv1.DecodeControlFrame(encoded)
	if failure != nil {
		t.Fatalf("decode: %v", failure)
	}
	roundTripped, ok := decoded.Payload.(connectorv1.RoutePublishAck)
	if !ok {
		t.Fatalf("decoded payload is %T", decoded.Payload)
	}
	if roundTripped.RouteID != ack.RouteID || roundTripped.Status != ack.Status {
		t.Fatalf("round trip changed the acknowledgement: %+v", roundTripped)
	}
	if roundTripped.ObservedDestination == nil || *roundTripped.ObservedDestination != destination {
		t.Fatal("the observed destination did not survive the round trip")
	}

	// A ready acknowledgement carrying an error class is refused on receipt.
	// The schema's conditional requirement is enforced where it matters — by
	// the side that has to act on the message — so a connector that built one
	// cannot make the gateway register a route it also called a failure.
	class := connectorv1.ErrorClassPortNotListening
	contradictory := ack
	contradictory.ErrorClass = &class
	encodedContradiction, err := connectorv1.EncodeControlFrame(connectorv1.Frame{
		Envelope: connectorv1.Envelope{
			ProtocolVersion: connectorv1.ProtocolVersion,
			MessageID:       "msg_b",
			Type:            connectorv1.MessageTypeRoutePublishAck,
			SentAt:          "2026-07-30T12:00:00Z",
			ConnectorID:     &connectorID,
		},
		Payload: contradictory,
	})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if _, failure := connectorv1.DecodeControlFrame(encodedContradiction); failure == nil {
		t.Fatal("a ready acknowledgement carrying an error class was accepted")
	} else if failure.Reason != connectorv1.ReasonSchemaViolation {
		t.Fatalf("refused as %q, want schema_violation", failure.Reason)
	}
}
