package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/danjonesio/reviewplane/services/connector/internal/buildinfo"
	"github.com/danjonesio/reviewplane/services/connector/internal/identity"
)

// capture runs the command with temporary files standing in for the process's
// standard streams, so that exit codes and output are both observable.
func capture(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	directory := t.TempDir()
	stdout, err := os.Create(filepath.Join(directory, "stdout"))
	if err != nil {
		t.Fatalf("creating stdout: %v", err)
	}
	stderr, err := os.Create(filepath.Join(directory, "stderr"))
	if err != nil {
		t.Fatalf("creating stderr: %v", err)
	}
	code := run(args, stdout, stderr)
	_ = stdout.Close()
	_ = stderr.Close()
	outBytes, err := os.ReadFile(filepath.Join(directory, "stdout"))
	if err != nil {
		t.Fatalf("reading stdout: %v", err)
	}
	errBytes, err := os.ReadFile(filepath.Join(directory, "stderr"))
	if err != nil {
		t.Fatalf("reading stderr: %v", err)
	}
	return code, string(outBytes), string(errBytes)
}

func TestVersionCommand(t *testing.T) {
	code, stdout, _ := capture(t, "version")
	if code != exitOK {
		t.Fatalf("exit code = %d", code)
	}
	if !strings.Contains(stdout, buildinfo.Version) || !strings.Contains(stdout, buildinfo.Name) {
		t.Fatalf("stdout = %q", stdout)
	}
}

func TestUsageIsPrintedForNoArgumentsAndUnknownCommands(t *testing.T) {
	code, _, stderr := capture(t)
	if code != exitUsage {
		t.Fatalf("exit code = %d, want %d", code, exitUsage)
	}
	if !strings.Contains(stderr, "reviewplane-connector enrol") {
		t.Fatalf("stderr = %q", stderr)
	}

	code, _, stderr = capture(t, "sync-my-repository")
	if code != exitUsage {
		t.Fatalf("exit code = %d, want %d", code, exitUsage)
	}
	if !strings.Contains(stderr, "unknown command") {
		t.Fatalf("stderr = %q", stderr)
	}
}

// docs/UX_FLOWS.md section 5 shows the enrolment command with a control plane
// and a one-time token; both are required.
func TestEnrolRequiresATokenAndControlPlane(t *testing.T) {
	t.Setenv("REVIEWPLANE_ENROLMENT_TOKEN", "")
	code, _, stderr := capture(t, "enrol", "--control-plane", "https://agents.example.internal")
	if code != exitUsage {
		t.Fatalf("exit code = %d, want %d", code, exitUsage)
	}
	if !strings.Contains(stderr, "--token") {
		t.Fatalf("stderr = %q", stderr)
	}

	code, _, stderr = capture(t, "enrol", "--token", "a-token-value-that-is-long-enough")
	if code != exitUsage {
		t.Fatalf("exit code = %d, want %d", code, exitUsage)
	}
	if !strings.Contains(stderr, "control_plane.url is required") {
		t.Fatalf("stderr = %q", stderr)
	}
}

// docs/SECURITY.md section 15: the enrolment token must never travel over an
// unencrypted connection, so a plaintext control-plane URL is refused before
// the token is used.
func TestEnrolRefusesAPlaintextControlPlane(t *testing.T) {
	code, _, stderr := capture(t,
		"enrol", "--control-plane", "http://agents.example.internal",
		"--token", "a-token-value-that-is-long-enough")
	if code != exitUsage {
		t.Fatalf("exit code = %d, want %d", code, exitUsage)
	}
	if !strings.Contains(stderr, "must use https") {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestEnrolAcceptsTheTokenExactlyOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte("a-token-value-that-is-long-enough\n"), 0o600); err != nil {
		t.Fatalf("writing token file: %v", err)
	}
	code, _, stderr := capture(t,
		"enrol", "--control-plane", "https://agents.example.internal",
		"--token", "inline", "--token-file", path)
	if code != exitUsage {
		t.Fatalf("exit code = %d, want %d", code, exitUsage)
	}
	if !strings.Contains(stderr, "exactly once") {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestRunRefusesAnUnenrolledEnvironment(t *testing.T) {
	code, _, stderr := capture(t, "run", "--data-dir", t.TempDir())
	if code == exitOK {
		t.Fatal("run must fail without an identity")
	}
	if !strings.Contains(stderr, "enrol") {
		t.Fatalf("stderr = %q", stderr)
	}
}

// enrolledEnvironment writes the two files that make a data directory look
// enrolled, without standing up a control plane: the mcp command reads the
// identity and never uses it to connect.
func enrolledEnvironment(t *testing.T) string {
	t.Helper()
	dataDir := filepath.Join(t.TempDir(), "data")
	store := identity.NewStore(dataDir)
	if err := store.EnsureDir(); err != nil {
		t.Fatalf("EnsureDir: %v", err)
	}
	if _, err := store.GenerateKey(); err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	if err := store.SaveRecord(identity.Record{
		ConnectorID: "con_mcptest",
		ControlURL:  "wss://agents.example.internal/connector/v1/control",
	}); err != nil {
		t.Fatalf("SaveRecord: %v", err)
	}
	return dataDir
}

// writeConfig writes a configuration file naming one workspace at path.
func writeConfig(t *testing.T, workspacePath string) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "config.yaml")
	source := "control_plane:\n  url: https://agents.example.internal\n" +
		"workspaces:\n" +
		"  - id: wsp_refresh_surplus\n" +
		"    path: " + workspacePath + "\n" +
		"    project: refresh-surplus\n"
	if err := os.WriteFile(file, []byte(source), 0o600); err != nil {
		t.Fatalf("writing configuration: %v", err)
	}
	return file
}

// docs/CONNECTOR_PROTOCOL.md section 14: the local MCP bridge resolves the
// workspace and project for the environment it is run in. `--describe` prints
// what it resolved and stops there, which is the form an operator runs by hand:
// without it stdout is the agent's JSON-RPC channel and carries nothing else.
func TestMCPDescribesTheResolvedWorkspace(t *testing.T) {
	workspacePath := t.TempDir()
	code, stdout, stderr := capture(t, "mcp",
		"--describe",
		"--config", writeConfig(t, workspacePath),
		"--data-dir", enrolledEnvironment(t),
		"--directory", filepath.Join(workspacePath, "src", "components"),
	)
	if code != exitOK {
		t.Fatalf("exit code = %d, want %d\nstderr: %s", code, exitOK, stderr)
	}
	for _, expected := range []string{"con_mcptest", "wsp_refresh_surplus", "refresh-surplus"} {
		if !strings.Contains(stdout, expected) {
			t.Errorf("stdout = %q, want it to name %s", stdout, expected)
		}
	}
}

// Without a usable device identity the bridge does not proxy. Proxying without
// a credential would hand the agent whatever authority the connector holds,
// which section 14 forbids in terms, so the command fails before it reads a
// single byte from the agent — and it writes nothing to stdout, which in this
// mode is the agent's JSON-RPC channel rather than an operator's terminal.
func TestMCPDoesNotProxyWithoutACredential(t *testing.T) {
	workspacePath := t.TempDir()
	code, stdout, stderr := capture(t, "mcp",
		"--config", writeConfig(t, workspacePath),
		"--data-dir", enrolledEnvironment(t),
		"--directory", workspacePath,
	)
	if code == exitOK {
		t.Fatalf("exit code = %d; the bridge must not start without a credential\nstderr: %s", code, stderr)
	}
	if stdout != "" {
		t.Fatalf("stdout = %q; stdout is the agent's JSON-RPC channel and must carry nothing else", stdout)
	}
	if strings.Contains(stderr, "rpa_") {
		t.Fatalf("stderr = %q; a refusal must never carry a credential", stderr)
	}
}

// An environment with no identity has nothing to bridge to, and says which
// command establishes one.
func TestMCPRefusesAnUnenrolledEnvironment(t *testing.T) {
	code, _, stderr := capture(t, "mcp",
		"--config", writeConfig(t, t.TempDir()),
		"--data-dir", filepath.Join(t.TempDir(), "empty"),
	)
	if code != exitRefused {
		t.Fatalf("exit code = %d, want %d", code, exitRefused)
	}
	if !strings.Contains(stderr, "enrol") {
		t.Fatalf("stderr = %q", stderr)
	}
	if strings.Contains(stderr, "agent credential") {
		t.Fatal("an unenrolled environment must not be told about the credential exchange first")
	}
}

// Nothing is discovered. A directory inside no configured workspace is reported
// as such rather than registered on the spot, because a publication names a
// workspace the operator authorised (section 11).
func TestMCPRefusesADirectoryOutsideEveryWorkspace(t *testing.T) {
	code, _, stderr := capture(t, "mcp",
		"--config", writeConfig(t, filepath.Join(t.TempDir(), "projects", "api")),
		"--data-dir", enrolledEnvironment(t),
		"--directory", filepath.Join(t.TempDir(), "somewhere", "else"),
	)
	if code != exitRefused {
		t.Fatalf("exit code = %d, want %d", code, exitRefused)
	}
	if !strings.Contains(stderr, "inside no configured workspace") {
		t.Fatalf("stderr = %q", stderr)
	}
	if !strings.Contains(stderr, "wsp_refresh_surplus") {
		t.Fatal("the refusal must name the workspaces that are configured")
	}
}

// A sibling directory whose name merely starts with a workspace path is not
// inside it.
func TestMCPDoesNotMatchASiblingDirectoryByPrefix(t *testing.T) {
	root := t.TempDir()
	code, _, stderr := capture(t, "mcp",
		"--config", writeConfig(t, filepath.Join(root, "api")),
		"--data-dir", enrolledEnvironment(t),
		"--directory", filepath.Join(root, "api-old"),
	)
	if code != exitRefused || !strings.Contains(stderr, "inside no configured workspace") {
		t.Fatalf("exit code = %d, stderr = %q; api-old is not inside api", code, stderr)
	}
}

func TestMCPRefusesAnUnknownNamedWorkspace(t *testing.T) {
	code, _, stderr := capture(t, "mcp",
		"--config", writeConfig(t, t.TempDir()),
		"--data-dir", enrolledEnvironment(t),
		"--workspace", "wsp_not_configured",
	)
	if code != exitRefused {
		t.Fatalf("exit code = %d, want %d", code, exitRefused)
	}
	if !strings.Contains(stderr, "wsp_not_configured") || !strings.Contains(stderr, "wsp_refresh_surplus") {
		t.Fatalf("stderr = %q; the refusal must name both what was asked for and what exists", stderr)
	}
}

// A workspaces block with no usable entry is a configuration problem, not a
// missing feature, and the message says which.
func TestMCPRefusesWhenNoWorkspaceIsConfigured(t *testing.T) {
	file := filepath.Join(t.TempDir(), "config.yaml")
	source := "control_plane:\n  url: https://agents.example.internal\n" +
		"workspaces:\n  - path: " + t.TempDir() + "\n"
	if err := os.WriteFile(file, []byte(source), 0o600); err != nil {
		t.Fatalf("writing configuration: %v", err)
	}
	code, _, stderr := capture(t, "mcp", "--config", file, "--data-dir", enrolledEnvironment(t))
	if code != exitRefused {
		t.Fatalf("exit code = %d, want %d", code, exitRefused)
	}
	if !strings.Contains(stderr, "both an id and a project") {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestUsageDocumentsTheMCPCommand(t *testing.T) {
	code, stdout, _ := capture(t, "help")
	if code != exitOK {
		t.Fatalf("exit code = %d", code)
	}
	if !strings.Contains(stdout, "reviewplane-connector mcp") {
		t.Fatalf("stdout = %q", stdout)
	}
}

func TestRunRejectsAnOutOfRangeHeartbeatInterval(t *testing.T) {
	code, _, stderr := capture(t, "run", "--data-dir", t.TempDir(), "--heartbeat-interval", "10m")
	if code != exitUsage {
		t.Fatalf("exit code = %d, want %d", code, exitUsage)
	}
	if !strings.Contains(stderr, "--heartbeat-interval must be between") {
		t.Fatalf("stderr = %q", stderr)
	}
}
