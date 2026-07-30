package connectorv1

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Contract layer (docs/TESTING.md section 2): the tunnel gateway verifies in Go
// the capabilities the control plane mints in TypeScript, so both languages run
// this corpus. A token that only one language produces is a broken deployment,
// not a style difference.

const capabilityFixturesDir = "../fixtures/capability/v1"

type capabilityMintFixture struct {
	Name             string `json:"name"`
	KeyID            string `json:"key_id"`
	CapabilityID     string `json:"capability_id"`
	RouteID          string `json:"route_id"`
	ProjectID        string `json:"project_id"`
	BrowserSessionID string `json:"browser_session_id"`
	IssuedAt         int64  `json:"issued_at"`
	ExpiresAt        int64  `json:"expires_at"`
	Token            string `json:"token"`
	Note             string `json:"note"`
}

type capabilityClaimsFixture struct {
	KeyID            string `json:"key_id"`
	CapabilityID     string `json:"capability_id"`
	RouteID          string `json:"route_id"`
	ProjectID        string `json:"project_id"`
	BrowserSessionID string `json:"browser_session_id"`
	IssuedAt         int64  `json:"issued_at"`
	ExpiresAt        int64  `json:"expires_at"`
}

type capabilityVerifyFixture struct {
	Name   string                   `json:"name"`
	Token  string                   `json:"token"`
	Now    int64                    `json:"now"`
	Expect string                   `json:"expect"`
	Claims *capabilityClaimsFixture `json:"claims"`
	Note   string                   `json:"note"`
}

type capabilityManifest struct {
	Protocol        string                    `json:"protocol"`
	Version         int                       `json:"version"`
	Keys            map[string]string         `json:"keys"`
	VerifierKeyring []string                  `json:"verifier_keyring"`
	Mint            []capabilityMintFixture   `json:"mint"`
	Verify          []capabilityVerifyFixture `json:"verify"`
}

func loadCapabilityManifest(t *testing.T) capabilityManifest {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(capabilityFixturesDir, "manifest.json"))
	if err != nil {
		t.Fatalf("read capability manifest: %v", err)
	}
	var manifest capabilityManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("parse capability manifest: %v", err)
	}
	if len(manifest.Mint) == 0 || len(manifest.Verify) == 0 {
		t.Fatal("capability corpus is empty")
	}
	return manifest
}

func capabilityKey(t *testing.T, manifest capabilityManifest, keyID string) []byte {
	t.Helper()
	encoded, ok := manifest.Keys[keyID]
	if !ok {
		t.Fatalf("corpus has no key %q", keyID)
	}
	key, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("decode key %q: %v", keyID, err)
	}
	return key
}

func capabilityKeyring(t *testing.T, manifest capabilityManifest) CapabilityKeyring {
	t.Helper()
	keyring := CapabilityKeyring{}
	for _, keyID := range manifest.VerifierKeyring {
		keyring[keyID] = capabilityKey(t, manifest, keyID)
	}
	return keyring
}

func TestCapabilityCorpusMintsGoldenTokens(t *testing.T) {
	manifest := loadCapabilityManifest(t)
	for _, fixture := range manifest.Mint {
		t.Run(fixture.Name, func(t *testing.T) {
			token, err := MintCapability(capabilityKey(t, manifest, fixture.KeyID), CapabilityClaims{
				KeyID:            fixture.KeyID,
				CapabilityID:     fixture.CapabilityID,
				RouteID:          fixture.RouteID,
				ProjectID:        fixture.ProjectID,
				BrowserSessionID: fixture.BrowserSessionID,
				IssuedAt:         fixture.IssuedAt,
				ExpiresAt:        fixture.ExpiresAt,
			})
			if err != nil {
				t.Fatalf("mint: %v", err)
			}
			if token.Reveal() != fixture.Token {
				t.Fatalf("token does not match the corpus:\n  got:  %s\n  want: %s", token.Reveal(), fixture.Token)
			}
			if len(fixture.Token) > MaxCapabilityTokenLength {
				t.Fatalf("token of %d characters exceeds the schema bound", len(fixture.Token))
			}
			// The token must satisfy the schema's session_capability pattern,
			// because that is the field it travels in.
			var violations []SchemaViolation
			validateSessionCapability(fixture.Token, "$", &violations)
			if len(violations) > 0 {
				t.Fatalf("token does not satisfy the session_capability schema: %+v", violations)
			}
		})
	}
}

func TestCapabilityCorpusVerification(t *testing.T) {
	manifest := loadCapabilityManifest(t)
	keyring := capabilityKeyring(t, manifest)
	for _, fixture := range manifest.Verify {
		t.Run(fixture.Name, func(t *testing.T) {
			claims, failure := VerifyCapability(keyring, fixture.Token, fixture.Now)
			if fixture.Expect == "valid" {
				if failure != nil {
					t.Fatalf("corpus requires acceptance, got %v", failure)
				}
				if fixture.Claims == nil {
					t.Fatal("corpus accepts the token but records no claims")
				}
				want := *fixture.Claims
				got := capabilityClaimsFixture{
					KeyID:            claims.KeyID,
					CapabilityID:     claims.CapabilityID,
					RouteID:          claims.RouteID,
					ProjectID:        claims.ProjectID,
					BrowserSessionID: claims.BrowserSessionID,
					IssuedAt:         claims.IssuedAt,
					ExpiresAt:        claims.ExpiresAt,
				}
				if got != want {
					t.Fatalf("claims do not match the corpus:\n  got:  %+v\n  want: %+v", got, want)
				}
				return
			}
			if failure == nil {
				t.Fatalf("corpus requires rejection %q, but the token was accepted", fixture.Expect)
			}
			if string(failure.Rejection) != fixture.Expect {
				t.Fatalf("rejection %q, corpus requires %q", failure.Rejection, fixture.Expect)
			}
		})
	}
}

func TestCapabilityRejectsTokensSignedWithAnotherKey(t *testing.T) {
	manifest := loadCapabilityManifest(t)
	claims := CapabilityClaims{
		KeyID:            "stage0-a",
		CapabilityID:     "cap_x",
		RouteID:          "svc_x",
		ProjectID:        "prj_x",
		BrowserSessionID: "brs_x",
		IssuedAt:         1000,
		ExpiresAt:        2000,
	}
	// The attacker owns a key, and names a key identifier the verifier trusts.
	// Only the MAC decides.
	token, err := MintCapability(capabilityKey(t, manifest, "k"), claims)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	keyring := CapabilityKeyring{"stage0-a": capabilityKey(t, manifest, "stage0-a")}
	if _, failure := VerifyCapability(keyring, token.Reveal(), 1500); failure == nil {
		t.Fatal("a capability signed with another key was accepted")
	} else if failure.Rejection != CapabilityRejectionBadSignature {
		t.Fatalf("rejection %q, want bad_signature", failure.Rejection)
	}
}

func TestCapabilityIsRedactedInEveryDefaultRepresentation(t *testing.T) {
	manifest := loadCapabilityManifest(t)
	fixture := manifest.Mint[0]
	token, err := MintCapability(capabilityKey(t, manifest, fixture.KeyID), CapabilityClaims{
		KeyID:            fixture.KeyID,
		CapabilityID:     fixture.CapabilityID,
		RouteID:          fixture.RouteID,
		ProjectID:        fixture.ProjectID,
		BrowserSessionID: fixture.BrowserSessionID,
		IssuedAt:         fixture.IssuedAt,
		ExpiresAt:        fixture.ExpiresAt,
	})
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	encoded, err := json.Marshal(token)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for name, representation := range map[string]string{
		"String":     token.String(),
		"json":       string(encoded),
		"%v":         fmt.Sprintf("%v", token),
		"%s":         fmt.Sprintf("%s", token),
		"%q":         fmt.Sprintf("%q", token),
		"%#v":        fmt.Sprintf("%#v", token),
		"containing": fmt.Sprintf("%+v", struct{ Capability SensitiveString }{token}),
	} {
		if strings.Contains(representation, fixture.Token) {
			t.Fatalf("%s leaked the capability: %s", name, representation)
		}
		if !strings.Contains(representation, Redacted) {
			t.Fatalf("%s is not redacted: %s", name, representation)
		}
	}
}

func TestCapabilityRefusesShortSigningKeys(t *testing.T) {
	claims := CapabilityClaims{
		KeyID: "k", CapabilityID: "c", RouteID: "r", ProjectID: "p",
		BrowserSessionID: "b", IssuedAt: 1, ExpiresAt: 2,
	}
	if _, err := MintCapability(make([]byte, MinCapabilitySigningKeyBytes-1), claims); err == nil {
		t.Fatal("a short signing key was accepted")
	}
	// A verifier configured with a short key refuses rather than downgrading.
	short := CapabilityKeyring{"k": make([]byte, MinCapabilitySigningKeyBytes-1)}
	full, err := MintCapability(make([]byte, MinCapabilitySigningKeyBytes), claims)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	if _, failure := VerifyCapability(short, full.Reveal(), 1); failure == nil ||
		failure.Rejection != CapabilityRejectionUnknownKey {
		t.Fatalf("a short verifier key must refuse as unknown_key, got %v", failure)
	}
}

func TestCapabilityRefusesUnorderedOrOversizedClaims(t *testing.T) {
	key := make([]byte, MinCapabilitySigningKeyBytes)
	base := CapabilityClaims{
		KeyID: "k", CapabilityID: "c", RouteID: "r", ProjectID: "p",
		BrowserSessionID: "b", IssuedAt: 100, ExpiresAt: 200,
	}

	expired := base
	expired.ExpiresAt = base.IssuedAt
	if _, err := MintCapability(key, expired); err == nil {
		t.Fatal("a capability that expires when it is issued was minted")
	}

	oversized := base
	oversized.RouteID = strings.Repeat("r", MaxCapabilityIdentifierLength+1)
	if _, err := MintCapability(key, oversized); err == nil {
		t.Fatal("an over-long route identifier was minted")
	}

	empty := base
	empty.ProjectID = ""
	if _, err := MintCapability(key, empty); err == nil {
		t.Fatal("an empty project identifier was minted")
	}
}
