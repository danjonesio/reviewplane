package config

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseAppliesDefaults(t *testing.T) {
	cfg, err := Parse([]byte("control_plane:\n  url: https://agents.example.internal\n"))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.Identity.DataDir != DefaultDataDir {
		t.Fatalf("identity.data_dir = %q", cfg.Identity.DataDir)
	}
	if cfg.Heartbeat.Interval != DefaultHeartbeatInterval {
		t.Fatalf("heartbeat.interval = %s", cfg.Heartbeat.Interval)
	}
	if cfg.Logging.Level != "info" || cfg.Logging.Format != "json" {
		t.Fatalf("logging = %+v", cfg.Logging)
	}
	if cfg.Environment.Name == "" {
		t.Fatal("environment.name should default to the host name")
	}
	endpoint, err := cfg.EnrolmentURL()
	if err != nil {
		t.Fatalf("EnrolmentURL: %v", err)
	}
	if endpoint != "wss://agents.example.internal"+DefaultEnrolmentPath {
		t.Fatalf("EnrolmentURL = %q", endpoint)
	}
}

func TestParseDocumentedExample(t *testing.T) {
	// docs/CONNECTOR_PROTOCOL.md section 20 must load unchanged.
	source := `control_plane:
  url: https://agents.example.internal

identity:
  data_dir: /var/lib/reviewplane-connector

workspaces:
  - path: /home/dan/projects/refresh-surplus
    project: refresh-surplus

publication:
  allowed_hosts:
    - 127.0.0.1
    - ::1
  allowed_ports:
    - 3000-3999
    - 4321
    - 5173
  max_routes: 10

privacy:
  report_changed_paths: false
  report_process_details: false
  discover_workspaces: false

logging:
  level: info
  format: json
`
	cfg, err := Parse([]byte(source))
	if err != nil {
		t.Fatalf("the documented configuration example must load: %v", err)
	}
	if len(cfg.Workspaces) != 1 || cfg.Workspaces[0].Project != "refresh-surplus" {
		t.Fatalf("workspaces = %+v", cfg.Workspaces)
	}
	if cfg.Publication.MaxRoutes != 10 || len(cfg.Publication.AllowedHosts) != 2 {
		t.Fatalf("publication = %+v", cfg.Publication)
	}
	if cfg.GitContext.Interval != DefaultGitContextInterval {
		t.Fatalf("git_context.interval = %s; an omitted block takes the default", cfg.GitContext.Interval)
	}
}

// The example shipped in packaging/ is what an administrator installs, so it is
// parsed by the parser rather than reviewed by eye: a setting renamed in the
// code and not in the example would otherwise ship as a configuration file the
// connector refuses to start on.
func TestShippedExampleConfigurationParses(t *testing.T) {
	path := filepath.Join("..", "..", "packaging", "config.example.yaml")
	source, err := os.ReadFile(path) // #nosec G304 -- repository source
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	cfg, err := Parse(source)
	if err != nil {
		t.Fatalf("the shipped example must load: %v", err)
	}
	if cfg.ControlPlane.URL == nil || cfg.ControlPlane.URL.Scheme != "https" {
		t.Fatalf("control_plane.url = %v", cfg.ControlPlane.URL)
	}
	if cfg.Identity.DataDir != DefaultDataDir {
		t.Fatalf("identity.data_dir = %q; it must match StateDirectory in the systemd unit", cfg.Identity.DataDir)
	}
	if cfg.GitContext.Interval != 30*time.Second {
		t.Fatalf("git_context.interval = %s", cfg.GitContext.Interval)
	}
	if len(cfg.Workspaces) != 1 || cfg.Workspaces[0].ID == "" || cfg.Workspaces[0].Project == "" {
		t.Fatalf("workspaces = %+v; the example must show an entry a publication can name", cfg.Workspaces)
	}
	if cfg.Privacy.ReportChangedPaths || cfg.Privacy.ReportProcessDetail || cfg.Privacy.DiscoverWorkspaces {
		t.Fatalf("privacy = %+v; all three are refused by this build", cfg.Privacy)
	}
}

// The systemd unit and the configuration example describe one installation, so
// the two paths they name must be the same path.
func TestShippedUnitAgreesWithTheDefaultPaths(t *testing.T) {
	path := filepath.Join("..", "..", "packaging", "systemd", "reviewplane-connector.service")
	unit, err := os.ReadFile(path) // #nosec G304 -- repository source
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	text := string(unit)
	for _, required := range []string{
		"ExecStart=/usr/local/bin/reviewplane-connector run",
		"StateDirectory=reviewplane-connector",
		"ConfigurationDirectory=reviewplane-connector",
		"NoNewPrivileges=yes",
	} {
		if !strings.Contains(text, required) {
			t.Errorf("the unit does not carry %q", required)
		}
	}
	// StateDirectory=<name> is /var/lib/<name>, which must be where the
	// connector looks for its identity.
	if DefaultDataDir != "/var/lib/reviewplane-connector" {
		t.Fatalf("DefaultDataDir = %q no longer matches StateDirectory in the unit", DefaultDataDir)
	}
	// The connector opens no listening socket, so no socket unit may accompany
	// it (ADR-0002).
	if strings.Contains(text, "ListenStream") || strings.Contains(text, "[Socket]") {
		t.Fatal("the unit describes a listening socket; the connector opens none")
	}
}

func TestParseReadsStage0Blocks(t *testing.T) {
	cfg, err := Parse([]byte(`control_plane:
  url: https://agents.example.internal:8443
  enrolment_path: /connector/v1/enrol
  tls:
    ca_file: /etc/reviewplane-connector/ca.pem

heartbeat:
  interval: 5s

reconnect:
  initial_delay: 250ms
  max_delay: 30s
  factor: 1.5
  jitter: 0.5
  max_attempts: 4

environment:
  name: dev-ai-03
  labels: [proxmox, development]

git_context:
  interval: 45s
`))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.GitContext.Interval != 45*time.Second {
		t.Fatalf("git_context.interval = %s", cfg.GitContext.Interval)
	}
	if cfg.ControlPlane.TLS.CAFile != "/etc/reviewplane-connector/ca.pem" {
		t.Fatalf("control_plane.tls.ca_file = %q", cfg.ControlPlane.TLS.CAFile)
	}
	if cfg.Heartbeat.Interval != 5*time.Second {
		t.Fatalf("heartbeat.interval = %s", cfg.Heartbeat.Interval)
	}
	if cfg.Reconnect.InitialDelay != 250*time.Millisecond || cfg.Reconnect.MaxAttempts != 4 {
		t.Fatalf("reconnect = %+v", cfg.Reconnect)
	}
	if cfg.Environment.Name != "dev-ai-03" || len(cfg.Environment.Labels) != 2 {
		t.Fatalf("environment = %+v", cfg.Environment)
	}
	endpoint, err := cfg.EnrolmentURL()
	if err != nil {
		t.Fatalf("EnrolmentURL: %v", err)
	}
	if endpoint != "wss://agents.example.internal:8443/connector/v1/enrol" {
		t.Fatalf("EnrolmentURL = %q", endpoint)
	}
}

// Every case names the setting that failed: docs/DEVELOPMENT.md section 6
// requires configuration to fail with specific errors.
func TestParseValidationErrors(t *testing.T) {
	cases := []struct {
		name    string
		source  string
		wantsub string
	}{
		{
			name:    "plaintext control plane",
			source:  "control_plane:\n  url: http://agents.example.internal\n",
			wantsub: "must use https",
		},
		{
			name:    "control plane without a host",
			source:  "control_plane:\n  url: https:///path\n",
			wantsub: "has no host",
		},
		{
			name:    "unknown top-level setting",
			source:  "telemetry:\n  enabled: true\n",
			wantsub: "unknown setting configuration.telemetry",
		},
		{
			name:    "unknown nested setting",
			source:  "logging:\n  colour: true\n",
			wantsub: "unknown setting logging.colour",
		},
		{
			name:    "relative data dir",
			source:  "identity:\n  data_dir: var/lib\n",
			wantsub: "identity.data_dir must be an absolute path",
		},
		{
			name:    "heartbeat interval out of range",
			source:  "heartbeat:\n  interval: 10m\n",
			wantsub: "heartbeat.interval must be between",
		},
		{
			name:    "heartbeat interval not a duration",
			source:  "heartbeat:\n  interval: soon\n",
			wantsub: "heartbeat.interval must be a duration",
		},
		{
			name:    "max delay below initial delay",
			source:  "reconnect:\n  initial_delay: 10s\n  max_delay: 1s\n",
			wantsub: "reconnect.max_delay",
		},
		{
			name:    "jitter out of range",
			source:  "reconnect:\n  jitter: 2\n",
			wantsub: "reconnect.jitter must be between 0 and 1",
		},
		{
			name:    "unsupported log level",
			source:  "logging:\n  level: verbose\n",
			wantsub: "logging.level must be one of",
		},
		{
			name:    "unsupported log format",
			source:  "logging:\n  format: text\n",
			wantsub: "logging.format must be \"json\"",
		},
		{
			name:    "process detail reporting",
			source:  "privacy:\n  report_process_details: true\n",
			wantsub: "privacy.report_process_details must be false",
		},
		{
			// The message must distinguish what exists from what does not: the
			// checkouts named in the workspaces block are observed either way,
			// and it is bounded root scanning that is missing.
			name:    "workspace discovery",
			source:  "privacy:\n  discover_workspaces: true\n",
			wantsub: "bounded root scanning for unlisted checkouts is not implemented",
		},
		{
			// Section 9 permits reporting changed paths where policy allows, and
			// the version 1 payload has no member that can carry them, so
			// accepting the setting would misrepresent what is reported.
			name:    "changed-path reporting",
			source:  "privacy:\n  report_changed_paths: true\n",
			wantsub: "has no member that can carry a changed-path list",
		},
		{
			name:    "git context interval below the minimum",
			source:  "git_context:\n  interval: 1s\n",
			wantsub: "git_context.interval must be between",
		},
		{
			name:    "git context interval above the maximum",
			source:  "git_context:\n  interval: 24h\n",
			wantsub: "git_context.interval must be between",
		},
		{
			name:    "git context interval is not a duration",
			source:  "git_context:\n  interval: often\n",
			wantsub: "git_context.interval must be a duration",
		},
		{
			name:    "unknown git context setting",
			source:  "git_context:\n  depth: 3\n",
			wantsub: "unknown setting git_context.depth",
		},
		{
			name:    "environment label character class",
			source:  "environment:\n  labels: [Production]\n",
			wantsub: "environment label \"Production\"",
		},
		{
			name:    "duplicate environment label",
			source:  "environment:\n  labels: [dev, dev]\n",
			wantsub: "listed twice",
		},
		{
			name:    "relative workspace path",
			source:  "workspaces:\n  - path: projects/app\n",
			wantsub: "workspaces[0].path must be an absolute path",
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			_, err := Parse([]byte(test.source))
			if err == nil {
				t.Fatal("expected a validation error")
			}
			if !strings.Contains(err.Error(), test.wantsub) {
				t.Fatalf("error %q does not mention %q", err, test.wantsub)
			}
		})
	}
}

func TestParseRejectsTooManyEnvironmentLabels(t *testing.T) {
	labels := make([]string, MaxEnvironmentLabels+1)
	for i := range labels {
		labels[i] = "label" + string(rune('a'+i))
	}
	source := "environment:\n  labels: [" + strings.Join(labels, ", ") + "]\n"
	_, err := Parse([]byte(source))
	if err == nil || !strings.Contains(err.Error(), "at most 16 labels") {
		t.Fatalf("error = %v", err)
	}
}

func TestLoadMissingDefaultFileIsNotFatal(t *testing.T) {
	// The enrolment command of docs/UX_FLOWS.md section 5 runs before any
	// configuration file exists.
	cfg, err := Load("")
	if !errors.Is(err, ErrNoConfigFile) && err != nil {
		// A machine that happens to have /etc/reviewplane-connector/config.yaml
		// would load it; that is also correct.
		t.Skipf("this machine has a connector configuration file: %v", err)
	}
	if cfg == nil {
		t.Fatal("Load must return defaults when the default file is absent")
	}
	if err := cfg.RequireControlPlaneURL(); err == nil && cfg.ControlPlane.URL == nil {
		t.Fatal("RequireControlPlaneURL must report the missing setting")
	}
}

func TestLoadExplicitMissingFileIsFatal(t *testing.T) {
	_, err := Load(filepath.Join(t.TempDir(), "absent.yaml"))
	if err == nil {
		t.Fatal("an explicitly named missing configuration file must fail")
	}
	if errors.Is(err, ErrNoConfigFile) {
		t.Fatal("an explicitly named file must not fall back to defaults")
	}
}

func TestLoadNamesTheFileInErrors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("logging:\n  level: verbose\n"), 0o600); err != nil {
		t.Fatalf("writing configuration: %v", err)
	}
	_, err := Load(path)
	if err == nil || !strings.Contains(err.Error(), path) {
		t.Fatalf("error %v does not name %s", err, path)
	}
}
