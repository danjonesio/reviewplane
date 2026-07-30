package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/danjonesio/reviewplane/services/connector/internal/buildinfo"
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

func TestRunRejectsAnOutOfRangeHeartbeatInterval(t *testing.T) {
	code, _, stderr := capture(t, "run", "--data-dir", t.TempDir(), "--heartbeat-interval", "10m")
	if code != exitUsage {
		t.Fatalf("exit code = %d, want %d", code, exitUsage)
	}
	if !strings.Contains(stderr, "--heartbeat-interval must be between") {
		t.Fatalf("stderr = %q", stderr)
	}
}
