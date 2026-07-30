package platformv1

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The golden pagination-cursor corpus (docs/API.md section 6). The TypeScript
// implementation records the encodings; this suite reproduces them, so a change
// made in one language alone fails the other.

type cursorEncodeCase struct {
	Name   string      `json:"name"`
	Claims cursorInput `json:"claims"`
	Cursor string      `json:"cursor"`
	Note   string      `json:"note"`
}

type cursorInput struct {
	Version int64  `json:"version"`
	SortKey string `json:"sort_key"`
	ID      string `json:"id"`
}

type cursorRejectCase struct {
	Name   string `json:"name"`
	Cursor string `json:"cursor"`
	Expect string `json:"expect"`
	Note   string `json:"note"`
}

type cursorManifest struct {
	Encode []cursorEncodeCase `json:"encode"`
	Reject []cursorRejectCase `json:"reject"`
}

func loadCursorManifest(t *testing.T) cursorManifest {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fixturesDir, "cursors.json"))
	if err != nil {
		t.Fatalf("read cursor corpus: %v", err)
	}
	var manifest cursorManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("parse cursor corpus: %v", err)
	}
	return manifest
}

func TestCursorEncodingMatchesTheCorpus(t *testing.T) {
	manifest := loadCursorManifest(t)
	if len(manifest.Encode) == 0 {
		t.Fatal("the cursor corpus records no encodings")
	}
	for _, testCase := range manifest.Encode {
		t.Run(testCase.Name, func(t *testing.T) {
			claims := CursorClaims{
				Version: testCase.Claims.Version,
				SortKey: testCase.Claims.SortKey,
				ID:      testCase.Claims.ID,
			}
			encoded, err := EncodeCursor(claims)
			if err != nil {
				t.Fatalf("encode: %v", err)
			}
			if encoded != testCase.Cursor {
				t.Fatalf("cursor differs from the TypeScript encoder\n  go: %s\n  ts: %s", encoded, testCase.Cursor)
			}
			decoded, failure := DecodeCursor(encoded)
			if failure != nil {
				t.Fatalf("decode: %v", failure)
			}
			if decoded != claims {
				t.Fatalf("round trip changed the claims: %+v", decoded)
			}
		})
	}
}

func TestCursorRejectionsMatchTheCorpus(t *testing.T) {
	manifest := loadCursorManifest(t)
	for _, testCase := range manifest.Reject {
		t.Run(testCase.Name, func(t *testing.T) {
			_, failure := DecodeCursor(testCase.Cursor)
			if failure == nil {
				t.Fatalf("cursor was accepted; the corpus requires %s", testCase.Expect)
			}
			if string(failure.Rejection) != testCase.Expect {
				t.Fatalf("refused as %s, the corpus requires %s", failure.Rejection, testCase.Expect)
			}
		})
	}
}

// An identifier encodes nothing (docs/DOMAIN_MODEL.md section 3), so two minted
// in the same instant must differ in every position that carries information,
// and none of them may carry a time.
func TestEntityIdentifiersAreOpaque(t *testing.T) {
	seen := make(map[string]struct{}, 512)
	for range 512 {
		id, err := NewEntityID("review")
		if err != nil {
			t.Fatalf("mint: %v", err)
		}
		if got := id[:4]; got != "rev_" {
			t.Fatalf("prefix %q is not the documented one", got)
		}
		if len(id) != 4+2*EntityIDRandomBytes {
			t.Fatalf("identifier %q is not prefix plus %d random bytes", id, EntityIDRandomBytes)
		}
		if !IsEntityID(id) {
			t.Fatalf("identifier %q is outside the schema's character class", id)
		}
		if _, duplicate := seen[id]; duplicate {
			t.Fatalf("identifier %q was minted twice", id)
		}
		seen[id] = struct{}{}
	}

	if _, err := EntityPrefix("not-an-entity"); err == nil {
		t.Fatal("an unknown entity kind must not silently produce a prefix")
	}
	if IsEntityID("rev_has a space") {
		t.Fatal("a space is outside the identifier character class")
	}
	if IsEntityID("") {
		t.Fatal("an empty identifier is not valid")
	}
}
