package config

import (
	"strings"
	"testing"
)

// The agent endpoint can be named separately from the connector origin, and it
// cannot be named in plaintext (ADR-0039).
//
// The default matters as much as the override: a deployment where one origin
// serves both keeps working without configuring anything, so the absent case is
// asserted to leave the field nil rather than filled in with a guess.
func TestParseReadsTheMCPEndpoint(t *testing.T) {
	cfg, err := Parse([]byte("control_plane:\n" +
		"  url: https://api.example.internal:8443\n" +
		"  mcp_url: https://agents.example.internal\n"))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.ControlPlane.MCPURL == nil {
		t.Fatal("control_plane.mcp_url was not read")
	}
	if got := cfg.ControlPlane.MCPURL.String(); got != "https://agents.example.internal" {
		t.Fatalf("control_plane.mcp_url = %q", got)
	}
	if got := cfg.ControlPlane.URL.String(); got != "https://api.example.internal:8443" {
		t.Fatalf("naming the agent endpoint changed control_plane.url to %q", got)
	}
}

func TestParseWithoutAnMCPEndpointLeavesItUnset(t *testing.T) {
	cfg, err := Parse([]byte("control_plane:\n  url: https://api.example.internal:8443\n"))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.ControlPlane.MCPURL != nil {
		t.Fatalf("control_plane.mcp_url defaulted to %s; it must be derived from control_plane.url instead",
			cfg.ControlPlane.MCPURL)
	}
}

// The bridge sends a short-lived agent credential in an Authorization header on
// every message, so a plaintext endpoint would put it on the wire
// (docs/SECURITY.md §15). `wss` is refused too: this endpoint is HTTP POST and
// never a WebSocket, so accepting the scheme control_plane.url uses would only
// accept a value that could not work.
func TestParseRefusesAPlaintextMCPEndpoint(t *testing.T) {
	for _, raw := range []string{"http://agents.example.internal", "wss://agents.example.internal"} {
		_, err := Parse([]byte("control_plane:\n" +
			"  url: https://api.example.internal:8443\n" +
			"  mcp_url: " + raw + "\n"))
		if err == nil {
			t.Fatalf("%s was accepted as an agent endpoint", raw)
		}
		if !strings.Contains(err.Error(), "control_plane.mcp_url") {
			t.Fatalf("the refusal of %s does not name the setting: %v", raw, err)
		}
	}
}
