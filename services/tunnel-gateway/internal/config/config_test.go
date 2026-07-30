package config

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// docs/CONFIGURATION.md section 1: validate at startup, fail clearly on an
// invalid setting, publish defaults.

func env(pairs map[string]string) func(string) (string, bool) {
	return func(name string) (string, bool) {
		value, ok := pairs[name]
		return value, ok
	}
}

func minimal() map[string]string {
	return map[string]string{
		Prefix + "ADMIN_TOKEN":     strings.Repeat("t", 40),
		Prefix + "CAPABILITY_KEYS": "stage0-a:" + base64.StdEncoding.EncodeToString(make([]byte, 32)),
	}
}

func TestDefaultsAreLoopbackOnly(t *testing.T) {
	config, err := LoadFrom(env(minimal()))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if config.DestinationPolicy.AllowNonLoopback || config.DestinationPolicy.AllowLinkLocal {
		t.Fatal("the default policy is not loopback only")
	}
	if len(config.WidenedDestinationScope) != 0 {
		t.Fatal("the default configuration reports a widened scope")
	}
	if config.AdminListenAddress != "127.0.0.1:8445" {
		t.Fatalf("the control API defaults to %q, want loopback", config.AdminListenAddress)
	}
	if config.InternalSuffix != "internal.invalid" {
		t.Fatalf("internal suffix %q", config.InternalSuffix)
	}
	if config.RouteTTLMax != 8*time.Hour {
		t.Fatalf("route TTL maximum %v", config.RouteTTLMax)
	}
	if config.MaxStreamsPerConnector != 256 || config.MaxRoutesPerConnector != 10 {
		t.Fatal("the documented Stage 0 limits are not the defaults")
	}
}

func TestWideningTheDestinationPolicyIsReported(t *testing.T) {
	// docs/CONFIGURATION.md section 4 forbids a setting that widens the tunnel
	// without an explicit high-risk mode; the loader names what was widened so
	// that the process can warn about it.
	settings := minimal()
	settings[Prefix+"ALLOW_NON_LOOPBACK_DESTINATIONS"] = "true"
	settings[Prefix+"ALLOW_LINK_LOCAL_DESTINATIONS"] = "true"
	settings[Prefix+"ALLOWED_HOSTS"] = "127.0.0.1,10.0.0.5"
	config, err := LoadFrom(env(settings))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(config.WidenedDestinationScope) != 2 {
		t.Fatalf("widened scope %v", config.WidenedDestinationScope)
	}
}

func TestInvalidSettingsAreReportedTogether(t *testing.T) {
	settings := minimal()
	settings[Prefix+"ALLOWED_HOSTS"] = "localhost"
	settings[Prefix+"ALLOWED_PORTS"] = "not-a-port"
	settings[Prefix+"ROUTE_TTL_MAX"] = "forever"
	settings[Prefix+"HOST_HEADER_MODE"] = "whatever"
	_, err := LoadFrom(env(settings))
	if err == nil {
		t.Fatal("an invalid configuration was accepted")
	}
	for _, expected := range []string{"ALLOWED_HOSTS", "ALLOWED_PORTS", "ROUTE_TTL_MAX", "HOST_HEADER_MODE"} {
		if !strings.Contains(err.Error(), expected) {
			t.Fatalf("the error does not name %s: %v", expected, err)
		}
	}
}

func TestSecretsCanComeFromAFile(t *testing.T) {
	// docs/CONFIGURATION.md section 7: secret material is mounted, not put in an
	// environment variable.
	directory := t.TempDir()
	tokenPath := filepath.Join(directory, "admin_token")
	if err := os.WriteFile(tokenPath, []byte(strings.Repeat("f", 48)+"\n"), 0o600); err != nil {
		t.Fatalf("write token: %v", err)
	}
	keysPath := filepath.Join(directory, "capability_keys")
	key := base64.StdEncoding.EncodeToString(make([]byte, 32))
	if err := os.WriteFile(keysPath, []byte("stage0-a:"+key+"\n"), 0o600); err != nil {
		t.Fatalf("write keys: %v", err)
	}
	config, err := LoadFrom(env(map[string]string{
		Prefix + "ADMIN_TOKEN_FILE":     tokenPath,
		Prefix + "CAPABILITY_KEYS_FILE": keysPath,
	}))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if config.AdminToken != strings.Repeat("f", 48) {
		t.Fatal("the token was not read from the file, or was not trimmed")
	}
	if len(config.CapabilityKeys) != 1 {
		t.Fatalf("loaded %d capability keys", len(config.CapabilityKeys))
	}
}

func TestAShortAdminTokenOrSigningKeyIsRefused(t *testing.T) {
	settings := minimal()
	settings[Prefix+"ADMIN_TOKEN"] = "short"
	if _, err := LoadFrom(env(settings)); err == nil {
		t.Fatal("a short control-plane token was accepted")
	}

	settings = minimal()
	settings[Prefix+"CAPABILITY_KEYS"] = "stage0-a:" + base64.StdEncoding.EncodeToString(make([]byte, 16))
	if _, err := LoadFrom(env(settings)); err == nil {
		t.Fatal("a short capability signing key was accepted")
	}
}

func TestSeveralCapabilityKeysAreLoadedForRotation(t *testing.T) {
	settings := minimal()
	first := base64.StdEncoding.EncodeToString(make([]byte, 32))
	second := base64.StdEncoding.EncodeToString(make([]byte, 48))
	settings[Prefix+"CAPABILITY_KEYS"] = "stage0-a:" + first + ",stage0-b:" + second
	config, err := LoadFrom(env(settings))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(config.CapabilityKeys) != 2 {
		t.Fatalf("loaded %d keys, want 2", len(config.CapabilityKeys))
	}
}

func TestMissingRequiredSecretsAreReported(t *testing.T) {
	_, err := LoadFrom(env(map[string]string{}))
	if err == nil {
		t.Fatal("a configuration with no credentials was accepted")
	}
	for _, expected := range []string{"ADMIN_TOKEN", "CAPABILITY_KEYS"} {
		if !strings.Contains(err.Error(), expected) {
			t.Fatalf("the error does not name %s: %v", expected, err)
		}
	}
}
