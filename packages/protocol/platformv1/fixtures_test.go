package platformv1

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Contract layer (docs/TESTING.md section 2): the Go models must accept and
// refuse exactly the same corpus as the TypeScript models, and must produce the
// same canonical bytes for every accepted message. `pnpm protocol:check` runs
// the corpus in TypeScript and then runs this suite, so a change made in one
// language alone fails in the other.

const fixturesDir = "../fixtures/platform/v1"

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

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fixturesDir, name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return raw
}

// roundTrip decodes a fixture of the given kind and re-encodes it canonically.
func roundTrip(kind string, raw []byte) ([]byte, *ProtocolError) {
	switch kind {
	case "platform_event":
		frame, failure := DecodePlatformEvent(raw)
		if failure != nil {
			return nil, failure
		}
		encoded, err := EncodePlatformEvent(frame)
		if err != nil {
			return nil, &ProtocolError{Reason: ReasonSchemaViolation, Msg: err.Error()}
		}
		return encoded, nil
	case "stream_message":
		message, failure := DecodeStreamMessage(raw)
		if failure != nil {
			return nil, failure
		}
		encoded, err := EncodeStreamMessage(message)
		if err != nil {
			return nil, &ProtocolError{Reason: ReasonSchemaViolation, Msg: err.Error()}
		}
		return encoded, nil
	case "api_error_response":
		body, failure := DecodeAPIErrorBody(raw)
		if failure != nil {
			return nil, failure
		}
		encoded, err := EncodeAPIErrorBody(body)
		if err != nil {
			return nil, &ProtocolError{Reason: ReasonSchemaViolation, Msg: err.Error()}
		}
		return encoded, nil
	}
	return nil, &ProtocolError{Reason: ReasonSchemaViolation, Msg: "no codec for fixture kind " + kind}
}

func TestValidFixturesRoundTrip(t *testing.T) {
	manifest := loadManifest(t)
	canonical := loadCanonical(t)
	if len(manifest.Valid) == 0 {
		t.Fatal("the corpus lists no valid fixtures")
	}

	for _, fixture := range manifest.Valid {
		t.Run(fixture.Name, func(t *testing.T) {
			encoded, failure := roundTrip(fixture.Kind, readFixture(t, fixture.File))
			if failure != nil {
				t.Fatalf("valid fixture was refused: %v", failure)
			}
			expected, ok := canonical[fixture.Name]
			if !ok {
				t.Fatalf("canonical.json holds no encoding for %s", fixture.Name)
			}
			if string(encoded) != expected {
				t.Fatalf("canonical encoding differs from the TypeScript encoder\n  go: %s\n  ts: %s", encoded, expected)
			}

			// Re-decoding the canonical form must reproduce it exactly, so the
			// encoding is a fixed point rather than merely a first pass.
			again, failure := roundTrip(fixture.Kind, encoded)
			if failure != nil || string(again) != expected {
				t.Fatalf("canonical encoding is not a fixed point")
			}
		})
	}
}

func TestInvalidFixturesAreRefused(t *testing.T) {
	manifest := loadManifest(t)
	if len(manifest.Invalid) == 0 {
		t.Fatal("the corpus lists no invalid fixtures")
	}

	for _, fixture := range manifest.Invalid {
		t.Run(fixture.Name, func(t *testing.T) {
			_, failure := roundTrip(fixture.Kind, readFixture(t, fixture.File))
			if failure == nil {
				t.Fatal("invalid fixture was accepted")
			}
			if string(failure.Reason) != fixture.ExpectReason {
				t.Fatalf("refused as %s, the corpus requires %s", failure.Reason, fixture.ExpectReason)
			}
			if string(failure.ErrorClass) != fixture.ExpectErrorClass {
				t.Fatalf("reported error class %q, the corpus requires %q", failure.ErrorClass, fixture.ExpectErrorClass)
			}
		})
	}
}

// TestEventTypeOwnership records the boundary between this source and the
// review source. docs/EVENTS.md section 8 makes schemas/review/v1.schema.json
// the only source for review-domain payloads, so this codec must refuse those
// types outright rather than decode them into a shape it does not define.
func TestEventTypeOwnership(t *testing.T) {
	if IsPlatformEventType("review.created") {
		t.Fatal("review.created is owned by the review schema source, not this one")
	}
	if !IsKnownEventType("review.created") {
		t.Fatal("review.created is in the Stage 1 catalogue and must be recognised as a known name")
	}
	if !IsPlatformEventType("project.created") {
		t.Fatal("project.created is owned by this source")
	}
	for _, owned := range MessageTypeValues {
		if !IsKnownEventType(string(owned)) {
			t.Fatalf("%s is owned by this source but is absent from the Stage 1 catalogue", owned)
		}
	}
}
