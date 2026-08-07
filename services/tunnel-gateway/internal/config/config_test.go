package config

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/danjonesio/reviewplane/services/tunnel-gateway/internal/gatewayhttp"
)

// docs/CONFIGURATION.md section 1: validate at startup, fail clearly on an
// invalid setting, publish defaults.

func env(pairs map[string]string) func(string) (string, bool) {
	return func(name string) (string, bool) {
		value, ok := pairs[name]
		return value, ok
	}
}

// credentialDocumentJSON is the configured shape of the control-credential set.
const credentialDocumentJSON = `[
  {"id":"api","secret":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
   "operations":["route:register","route:read","route:revoke","connector:revoke","capability:revoke","metrics:read"],
   "organisations":["*"]},
  {"id":"mcp","secret":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
   "operations":["route:revoke","capability:revoke"]}
]`

func minimal() map[string]string {
	return map[string]string{
		Prefix + "CONTROL_CREDENTIALS": credentialDocumentJSON,
		Prefix + "CAPABILITY_KEYS":     "stage0-a:" + base64.StdEncoding.EncodeToString(make([]byte, 32)),
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
	// The withdrawal set has a default location rather than being optional: a
	// gateway whose revocations live only in memory is the defect of RVP-76,
	// not a configuration a deployment may choose.
	if config.RevocationJournalPath != "/var/lib/reviewplane/tunnel/revocations.jsonl" {
		t.Fatalf("revocation journal path %q", config.RevocationJournalPath)
	}
}

func TestTheControlCredentialSetCarriesOperationsAndTenancy(t *testing.T) {
	config, err := LoadFrom(env(minimal()))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(config.ControlCredentials) != 2 {
		t.Fatalf("loaded %d control credentials, want 2", len(config.ControlCredentials))
	}
	api, mcp := config.ControlCredentials[0], config.ControlCredentials[1]
	if api.ID != "api" || mcp.ID != "mcp" {
		t.Fatalf("credential identifiers %q and %q", api.ID, mcp.ID)
	}
	if !api.Permits(gatewayhttp.OperationRouteRegister) {
		t.Fatal("the control plane's credential cannot register a route")
	}
	// The point of the whole exercise: the agent-facing process withdraws and
	// registers nothing, and that is now the credential rather than restraint
	// in the code (ADR-0021, ADR-0038).
	if mcp.Permits(gatewayhttp.OperationRouteRegister) {
		t.Fatal("the MCP credential may register a route")
	}
	if mcp.Permits(gatewayhttp.OperationRouteRead) {
		t.Fatal("the MCP credential may enumerate routes")
	}
	if !mcp.Permits(gatewayhttp.OperationRouteRevoke) || !mcp.Permits(gatewayhttp.OperationCapabilityRevoke) {
		t.Fatal("the MCP credential cannot withdraw what ADR-0021 says it withdraws")
	}
	if !api.Scope().Unbounded() {
		t.Fatal(`"organisations": ["*"] did not produce an unbounded scope`)
	}
}

func TestControlCredentialSetsThatMustBeRefused(t *testing.T) {
	cases := map[string]string{
		"not an array":       `{"id":"api","secret":"` + strings.Repeat("a", 40) + `"}`,
		"no credential":      `[]`,
		"unknown operation":  `[{"id":"api","secret":"` + strings.Repeat("a", 40) + `","operations":["route:everything"]}]`,
		"no operation":       `[{"id":"api","secret":"` + strings.Repeat("a", 40) + `","operations":[]}]`,
		"short secret":       `[{"id":"api","secret":"short","operations":["route:read"]}]`,
		"no identifier":      `[{"id":"","secret":"` + strings.Repeat("a", 40) + `","operations":["route:read"]}]`,
		"duplicate name":     `[{"id":"api","secret":"` + strings.Repeat("a", 40) + `","operations":["route:read"]},{"id":"api","secret":"` + strings.Repeat("b", 40) + `","operations":["route:read"]}]`,
		"a shared secret":    `[{"id":"api","secret":"` + strings.Repeat("a", 40) + `","operations":["route:read"]},{"id":"mcp","secret":"` + strings.Repeat("a", 40) + `","operations":["route:read"]}]`,
		"empty organisation": `[{"id":"api","secret":"` + strings.Repeat("a", 40) + `","operations":["route:read"],"organisations":[" "]}]`,
	}
	for name, document := range cases {
		t.Run(name, func(t *testing.T) {
			settings := minimal()
			settings[Prefix+"CONTROL_CREDENTIALS"] = document
			if _, err := LoadFrom(env(settings)); err == nil {
				t.Fatal("the credential set was accepted")
			}
		})
	}
}

func TestAMissingControlCredentialSetIsRefused(t *testing.T) {
	settings := minimal()
	delete(settings, Prefix+"CONTROL_CREDENTIALS")
	if _, err := LoadFrom(env(settings)); err == nil {
		t.Fatal("a gateway with no control credential was accepted")
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
	credentialsPath := filepath.Join(directory, "control_credentials")
	if err := os.WriteFile(credentialsPath, []byte(credentialDocumentJSON+"\n"), 0o600); err != nil {
		t.Fatalf("write credentials: %v", err)
	}
	keysPath := filepath.Join(directory, "capability_keys")
	key := base64.StdEncoding.EncodeToString(make([]byte, 32))
	if err := os.WriteFile(keysPath, []byte("stage0-a:"+key+"\n"), 0o600); err != nil {
		t.Fatalf("write keys: %v", err)
	}
	config, err := LoadFrom(env(map[string]string{
		Prefix + "CONTROL_CREDENTIALS_FILE": credentialsPath,
		Prefix + "CAPABILITY_KEYS_FILE":     keysPath,
	}))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(config.ControlCredentials) != 2 {
		t.Fatal("the credential set was not read from the file")
	}
	if len(config.CapabilityKeys) != 1 {
		t.Fatalf("loaded %d capability keys", len(config.CapabilityKeys))
	}
}

func TestAShortSigningKeyIsRefused(t *testing.T) {
	settings := minimal()
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
	for _, expected := range []string{"CONTROL_CREDENTIALS", "CAPABILITY_KEYS"} {
		if !strings.Contains(err.Error(), expected) {
			t.Fatalf("the error does not name %s: %v", expected, err)
		}
	}
}

func TestStreamLifetimeDefaultsMatchTheDocumentedValues(t *testing.T) {
	// docs/CONNECTOR_PROTOCOL.md section 13.3 records these values, and an
	// operator reading them there must find them here. The two idle windows in
	// particular are the difference between a hot-reload WebSocket surviving an
	// editing pause and the page going quietly stale.
	config, err := LoadFrom(env(minimal()))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if config.StreamIdleTimeout != 60*time.Second {
		t.Fatalf("the request/response idle window defaults to %v, want 60s", config.StreamIdleTimeout)
	}
	if config.UpgradeIdleTimeout != 15*time.Minute {
		t.Fatalf("the upgrade idle window defaults to %v, want 15m", config.UpgradeIdleTimeout)
	}
	if config.StreamMaxLifetime != 8*time.Hour {
		t.Fatalf("the maximum stream lifetime defaults to %v, want 8h", config.StreamMaxLifetime)
	}
	if config.StreamMaxLifetime != config.RouteTTLMax {
		t.Fatal("the maximum stream lifetime and the maximum route lifetime have drifted apart; " +
			"a stream is bounded by its route, so a shorter default here would cut a working stream")
	}
	if config.RelayBufferBytes != 32<<10 {
		t.Fatalf("the relay buffer defaults to %d bytes, want 32768", config.RelayBufferBytes)
	}
}

func TestStreamLifetimeSettingsAreConfigurableAndValidated(t *testing.T) {
	settings := minimal()
	settings[Prefix+"STREAM_IDLE_TIMEOUT"] = "90s"
	settings[Prefix+"UPGRADE_IDLE_TIMEOUT"] = "30m"
	settings[Prefix+"STREAM_MAX_LIFETIME"] = "2h"
	settings[Prefix+"RELAY_BUFFER_BYTES"] = "65536"
	config, err := LoadFrom(env(settings))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if config.StreamIdleTimeout != 90*time.Second ||
		config.UpgradeIdleTimeout != 30*time.Minute ||
		config.StreamMaxLifetime != 2*time.Hour ||
		config.RelayBufferBytes != 65536 {
		t.Fatalf("configured stream lifetimes were not read back: %+v", config)
	}

	settings[Prefix+"UPGRADE_IDLE_TIMEOUT"] = "never"
	if _, err := LoadFrom(env(settings)); err == nil ||
		!strings.Contains(err.Error(), "UPGRADE_IDLE_TIMEOUT") {
		t.Fatalf("an invalid upgrade idle window was accepted: %v", err)
	}
}

// The shipped deployment's credential set is loadable, and it is the narrow one.
//
// `deploy/compose/configure` writes the file the gateway reads. A set that
// drifted out of the shape this parser accepts would be found by an operator
// running the installation rather than by a build, so the template is read from
// the script itself.
func TestTheComposeDeploymentsCredentialSetLoads(t *testing.T) {
	script, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "deploy", "compose", "configure"))
	if err != nil {
		t.Fatalf("read the configure script: %v", err)
	}
	_, rest, found := strings.Cut(string(script), "<<CREDENTIALS\n")
	if !found {
		t.Fatal("the configure script no longer writes a CREDENTIALS heredoc")
	}
	document, _, found := strings.Cut(rest, "\nCREDENTIALS\n")
	if !found {
		t.Fatal("the CREDENTIALS heredoc is unterminated")
	}
	// The script interpolates two shell variables; a stand-in of the right
	// length replaces each of them here.
	document = strings.ReplaceAll(document, "${TUNNEL_API_SECRET}", strings.Repeat("a", 40))
	document = strings.ReplaceAll(document, "${TUNNEL_MCP_SECRET}", strings.Repeat("b", 40))
	if strings.Contains(document, "${") {
		t.Fatalf("the heredoc interpolates something this test does not know about:\n%s", document)
	}

	settings := minimal()
	settings[Prefix+"CONTROL_CREDENTIALS"] = document
	config, err := LoadFrom(env(settings))
	if err != nil {
		t.Fatalf("the shipped credential set does not load: %v", err)
	}
	byName := map[string]gatewayhttp.ControlCredential{}
	for _, credential := range config.ControlCredentials {
		byName[credential.ID] = credential
	}
	api, hasAPI := byName["api"]
	mcp, hasMCP := byName["mcp"]
	if !hasAPI || !hasMCP {
		t.Fatalf("the shipped set names %v", config.ControlCredentials)
	}
	if !api.Permits(gatewayhttp.OperationRouteRegister) {
		t.Fatal("the control plane's shipped credential cannot register a route")
	}
	// ADR-0021, as amended by ADR-0038: the agent-facing process withdraws and
	// does nothing else, and this is where that is true of the deployment rather
	// than only of the code.
	for _, forbidden := range []gatewayhttp.ControlOperation{
		gatewayhttp.OperationRouteRegister,
		gatewayhttp.OperationRouteRead,
		gatewayhttp.OperationConnectorRevoke,
		gatewayhttp.OperationMetricsRead,
	} {
		if mcp.Permits(forbidden) {
			t.Fatalf("the shipped MCP credential carries %s", forbidden)
		}
	}
	if !mcp.Permits(gatewayhttp.OperationRouteRevoke) ||
		!mcp.Permits(gatewayhttp.OperationCapabilityRevoke) {
		t.Fatal("the shipped MCP credential cannot withdraw")
	}
}
