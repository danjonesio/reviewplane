package connectorv1

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Contract layer (docs/TESTING.md section 2): the Go models must accept and
// refuse exactly the same corpus as the TypeScript models, and must produce the
// same canonical bytes for every accepted frame.

const fixturesDir = "../fixtures/connector/v1"

type validFixture struct {
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	File        string `json:"file"`
	MessageType string `json:"message_type"`
	Note        string `json:"note"`
}

type invalidFixture struct {
	Name             string `json:"name"`
	Kind             string `json:"kind"`
	File             string `json:"file"`
	ExpectReason     string `json:"expect_reason"`
	ExpectErrorClass string `json:"expect_error_class"`
	Note             string `json:"note"`
}

type fixtureManifest struct {
	Protocol string           `json:"protocol"`
	Version  int              `json:"version"`
	Valid    []validFixture   `json:"valid"`
	Invalid  []invalidFixture `json:"invalid"`
}

func loadManifest(t *testing.T) fixtureManifest {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fixturesDir, "manifest.json"))
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	var manifest fixtureManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("parse manifest: %v", err)
	}
	return manifest
}

func loadCanonical(t *testing.T) map[string]string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fixturesDir, "canonical.json"))
	if err != nil {
		t.Fatalf("read canonical corpus: %v", err)
	}
	var canonical map[string]string
	if err := json.Unmarshal(raw, &canonical); err != nil {
		t.Fatalf("parse canonical corpus: %v", err)
	}
	return canonical
}

func readFixtureFile(name string) ([]byte, error) {
	return os.ReadFile(filepath.Join(fixturesDir, name))
}

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := readFixtureFile(name)
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return raw
}

func TestValidFixturesRoundTripToCanonicalBytes(t *testing.T) {
	manifest := loadManifest(t)
	canonical := loadCanonical(t)
	if len(manifest.Valid) == 0 {
		t.Fatal("corpus holds no valid fixtures")
	}

	for _, fixture := range manifest.Valid {
		t.Run(fixture.Name, func(t *testing.T) {
			raw := readFixture(t, fixture.File)
			expected, ok := canonical[fixture.Name]
			if !ok {
				t.Fatalf("canonical.json has no entry for %s", fixture.Name)
			}

			var encoded []byte
			switch fixture.Kind {
			case "data_stream_header":
				header, failure := DecodeDataStreamHeaderFrame(raw)
				if failure != nil {
					t.Fatalf("valid fixture refused: %v", failure)
				}
				bytes, err := EncodeDataStreamHeaderFrame(header)
				if err != nil {
					t.Fatalf("encode: %v", err)
				}
				encoded = bytes
			case "control_frame":
				frame, failure := DecodeControlFrame(raw)
				if failure != nil {
					t.Fatalf("valid fixture refused: %v", failure)
				}
				if string(frame.Envelope.Type) != fixture.MessageType {
					t.Fatalf("decoded type %q, manifest says %q", frame.Envelope.Type, fixture.MessageType)
				}
				if frame.Payload.MessageType() != frame.Envelope.Type {
					t.Fatalf("payload type %q does not match envelope type %q",
						frame.Payload.MessageType(), frame.Envelope.Type)
				}
				bytes, err := EncodeControlFrame(frame)
				if err != nil {
					t.Fatalf("encode: %v", err)
				}
				encoded = bytes
			default:
				t.Fatalf("unknown fixture kind %q", fixture.Kind)
			}

			if string(encoded) != expected {
				t.Fatalf("canonical encoding differs from the committed corpus\n  go: %s\n  corpus: %s",
					encoded, expected)
			}

			// The canonical form must itself decode to the same canonical form.
			if fixture.Kind == "control_frame" {
				frame, failure := DecodeControlFrame(encoded)
				if failure != nil {
					t.Fatalf("canonical form refused on re-decode: %v", failure)
				}
				again, err := EncodeControlFrame(frame)
				if err != nil {
					t.Fatalf("re-encode: %v", err)
				}
				if string(again) != expected {
					t.Fatal("canonical encoding is not a fixed point")
				}
			}
		})
	}
}

func TestInvalidFixturesAreRefusedWithTheRecordedReason(t *testing.T) {
	manifest := loadManifest(t)
	if len(manifest.Invalid) == 0 {
		t.Fatal("corpus holds no invalid fixtures")
	}

	for _, fixture := range manifest.Invalid {
		t.Run(fixture.Name, func(t *testing.T) {
			raw := readFixture(t, fixture.File)

			var failure *ProtocolError
			switch fixture.Kind {
			case "data_stream_header":
				_, failure = DecodeDataStreamHeaderFrame(raw)
			case "control_frame":
				_, failure = DecodeControlFrame(raw)
			default:
				t.Fatalf("unknown fixture kind %q", fixture.Kind)
			}

			if failure == nil {
				t.Fatal("invalid fixture was accepted")
			}
			if string(failure.Reason) != fixture.ExpectReason {
				t.Fatalf("refused as %q, corpus expects %q", failure.Reason, fixture.ExpectReason)
			}
			if string(failure.ErrorClass) != fixture.ExpectErrorClass {
				t.Fatalf("error class %q, corpus expects %q", failure.ErrorClass, fixture.ExpectErrorClass)
			}
		})
	}
}

// The corpus must exercise every version 1 message type, or a message could be
// added to the schema without ever being round-tripped.
func TestCorpusCoversEveryMessageType(t *testing.T) {
	manifest := loadManifest(t)
	covered := make(map[string]bool, len(manifest.Valid))
	for _, fixture := range manifest.Valid {
		if fixture.Kind == "control_frame" {
			covered[fixture.MessageType] = true
		}
	}
	for _, messageType := range MessageTypeValues {
		if !covered[string(messageType)] {
			t.Errorf("no valid fixture covers message type %s", messageType)
		}
	}
	dataStreamCovered := false
	for _, fixture := range manifest.Valid {
		if fixture.Kind == "data_stream_header" {
			dataStreamCovered = true
		}
	}
	if !dataStreamCovered {
		t.Error("no valid fixture covers the data-stream header")
	}
}
