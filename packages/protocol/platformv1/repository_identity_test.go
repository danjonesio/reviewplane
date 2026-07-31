package platformv1

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The golden repository-identity corpus (docs/DOMAIN_MODEL.md section 6). The
// TypeScript implementation is the one an operator's typing reaches and this
// one is the one a connector's remote reaches; they must agree, so both run the
// same file. A rule changed in one language alone fails the other here.

type repositoryIdentityCase struct {
	Name            string `json:"name"`
	Input           string `json:"input"`
	ExpectCanonical string `json:"expect_canonical"`
	ExpectReason    string `json:"expect_reason"`
	ExpectSanitised string `json:"expect_sanitised"`
	Note            string `json:"note"`
}

type repositoryIdentityCorpus struct {
	Description string                   `json:"description"`
	Cases       []repositoryIdentityCase `json:"cases"`
}

func loadRepositoryIdentityCorpus(t *testing.T) repositoryIdentityCorpus {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fixturesDir, "repository-identity.json"))
	if err != nil {
		t.Fatalf("read repository-identity corpus: %v", err)
	}
	var corpus repositoryIdentityCorpus
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatalf("parse repository-identity corpus: %v", err)
	}
	if len(corpus.Cases) == 0 {
		t.Fatal("the repository-identity corpus is empty")
	}
	return corpus
}

func TestCanonicalisationMatchesTheCorpus(t *testing.T) {
	corpus := loadRepositoryIdentityCorpus(t)
	for _, testCase := range corpus.Cases {
		t.Run(testCase.Name, func(t *testing.T) {
			canonical, err := CanonicaliseCloneURL(testCase.Input)
			if testCase.ExpectCanonical != "" {
				if err != nil {
					t.Fatalf("the corpus requires %q, and the value was refused: %v",
						testCase.ExpectCanonical, err)
				}
				if canonical != testCase.ExpectCanonical {
					t.Fatalf("canonical form differs from the TypeScript implementation\n  go: %s\n  ts: %s",
						canonical, testCase.ExpectCanonical)
				}
				return
			}
			if err == nil {
				t.Fatalf("the value was accepted as %q; the corpus requires %s",
					canonical, testCase.ExpectReason)
			}
			var failure *RepositoryIdentityError
			if !errors.As(err, &failure) {
				t.Fatalf("refusal %v is not a RepositoryIdentityError, so a caller cannot branch on it", err)
			}
			if string(failure.Reason) != testCase.ExpectReason {
				t.Fatalf("refused as %s, the corpus requires %s", failure.Reason, testCase.ExpectReason)
			}
		})
	}
}

func TestSanitisationMatchesTheCorpus(t *testing.T) {
	corpus := loadRepositoryIdentityCorpus(t)
	for _, testCase := range corpus.Cases {
		t.Run(testCase.Name, func(t *testing.T) {
			if got := SanitiseCloneURL(testCase.Input); got != testCase.ExpectSanitised {
				t.Fatalf("sanitised form differs from the TypeScript implementation\n  go: %q\n  ts: %q",
					got, testCase.ExpectSanitised)
			}
		})
	}
}

// docs/SECURITY.md section 18: a credential pasted into a remote must not reach
// a stored, API-returned field. The corpus carries values shaped like personal
// access tokens and passwords precisely so that this can be asserted rather
// than assumed.
func TestNoCorpusCaseLeaksACredential(t *testing.T) {
	corpus := loadRepositoryIdentityCorpus(t)
	for _, testCase := range corpus.Cases {
		for _, secret := range []string{"SUPERSECRETTOKEN", "hunter2"} {
			if !strings.Contains(testCase.Input, secret) {
				continue
			}
			if sanitised := SanitiseCloneURL(testCase.Input); strings.Contains(sanitised, secret) {
				t.Errorf("%s kept %s in the sanitised URL: %s", testCase.Name, secret, sanitised)
			}
			canonical, err := CanonicaliseCloneURL(testCase.Input)
			if err == nil && strings.Contains(canonical, secret) {
				t.Errorf("%s kept %s in the canonical identity: %s", testCase.Name, secret, canonical)
			}
		}
	}
}

// The canonical form is the value that travels in workspace_observation, so it
// must satisfy the schema definition the connector protocol shares. Asserting
// it here means a normalisation change that produced an unsendable value fails
// in the normaliser's own suite rather than at the far end of a wire.
func TestEveryCanonicalFormSatisfiesTheSchemaPattern(t *testing.T) {
	corpus := loadRepositoryIdentityCorpus(t)
	accepted := 0
	for _, testCase := range corpus.Cases {
		if testCase.ExpectCanonical == "" {
			continue
		}
		accepted++
		if !canonicalRepositoryPattern.MatchString(testCase.ExpectCanonical) {
			t.Errorf("%s produces %q, which is outside the repository_identity character class",
				testCase.Name, testCase.ExpectCanonical)
		}
		if length := len(testCase.ExpectCanonical); length < 3 || length > MaxCanonicalLength {
			t.Errorf("%s produces a %d-character identity, outside the schema bounds", testCase.Name, length)
		}
	}
	if accepted == 0 {
		t.Fatal("the corpus records no accepted value")
	}
}
