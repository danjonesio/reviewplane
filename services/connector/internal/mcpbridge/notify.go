package mcpbridge

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

// NotificationPrefix is the product marker of docs/CONNECTOR_PROTOCOL.md
// section 16. It is a constant so an operator, a log filter and a test all read
// the same string.
const NotificationPrefix = "[ReviewPlane]"

// MaxNotifications bounds one delivery report.
//
// An inbox with a hundred items is a queue, not a notification. Reporting the
// first few and saying how many remain is what keeps a notification a
// notification.
const MaxNotifications = 5

// Work is one delivered inbox item, reduced to what a notification says.
type Work struct {
	Type         string
	ReviewSlug   string
	FindingCount int
	Priority     string
}

// Notification renders one item in the documented form:
//
//	[ReviewPlane] New review assigned: bugs-on-homepage (3 findings, high priority)
//
// The review's slug is the name a human gave it and is the one thing an
// operator needs in order to prompt an agent. The title is deliberately absent:
// it is free text a human wrote, and a notification is a line in a log.
func Notification(item Work) string {
	what := "New review assigned"
	if item.Type == "finding_reopened" {
		what = "Finding reopened"
	}
	details := make([]string, 0, 2)
	switch {
	case item.FindingCount == 1:
		details = append(details, "1 finding")
	case item.FindingCount > 1:
		details = append(details, fmt.Sprintf("%d findings", item.FindingCount))
	}
	if item.Priority != "" {
		details = append(details, item.Priority+" priority")
	}
	line := fmt.Sprintf("%s %s: %s", NotificationPrefix, what, sanitise(item.ReviewSlug))
	if len(details) > 0 {
		line += " (" + strings.Join(details, ", ") + ")"
	}
	return line
}

// sanitise removes anything that would let a value written by somebody else
// forge a second line or move a terminal cursor.
//
// The slug comes from the control plane and is already constrained, but this
// text is written to a log an operator reads and, optionally, to a file a shell
// prompt may render. A control character in it would be the closest thing this
// command has to injecting text into a terminal, which section 16 forbids
// outright.
func sanitise(value string) string {
	var out strings.Builder
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			continue
		}
		out.WriteRune(r)
	}
	// The product marker is removed from the value as well as the control
	// characters. A slug the control plane issues cannot contain it, but a line
	// carrying two markers would be ambiguous to the log filter an operator
	// writes, and removing it costs nothing.
	trimmed := strings.ReplaceAll(out.String(), NotificationPrefix, "")
	if len(trimmed) > 128 {
		return trimmed[:128]
	}
	if trimmed == "" {
		return "(unnamed)"
	}
	return trimmed
}

// NotifyOptions is where a delivery report goes.
type NotifyOptions struct {
	Logger *slog.Logger
	// Stderr is the operator-facing stream. It is never stdout: stdout is the
	// agent's JSON-RPC channel and a notification on it would corrupt the
	// stream a client is parsing.
	Stderr io.Writer
	// StatusFile is the optional file of section 16. Empty means none.
	StatusFile string
}

// Notify reports newly delivered work.
//
// Delivery is through the connector's log — journald under the shipped systemd
// unit — the operator-facing stream, and an optional status file. It never
// writes to a terminal or a pseudo-terminal it did not own: section 16 forbids
// injecting text into an active terminal, and this command's stderr is its own.
func Notify(items []Work, options NotifyOptions) error {
	if len(items) == 0 {
		return nil
	}
	shown := items
	if len(shown) > MaxNotifications {
		shown = shown[:MaxNotifications]
	}
	lines := make([]string, 0, len(shown)+1)
	for _, item := range shown {
		lines = append(lines, Notification(item))
	}
	if len(items) > len(shown) {
		lines = append(lines, fmt.Sprintf("%s and %d more waiting", NotificationPrefix, len(items)-len(shown)))
	}

	for index, line := range lines {
		if options.Logger != nil && index < len(shown) {
			options.Logger.Info("work assigned",
				slog.String("review", shown[index].ReviewSlug),
				slog.String("inbox_item_type", shown[index].Type),
				slog.Int("finding_count", shown[index].FindingCount),
			)
		}
		if options.Stderr != nil {
			if _, err := fmt.Fprintln(options.Stderr, line); err != nil {
				return fmt.Errorf("mcpbridge: writing a notification: %w", err)
			}
		}
	}

	if options.StatusFile == "" {
		return nil
	}
	return writeStatusFile(options.StatusFile, lines)
}

// writeStatusFile replaces the status file atomically.
//
// A shell prompt may read it at any moment, and a half-written file is a prompt
// showing a truncated line. It is written 0600: it names the work a developer
// has been given, which is nobody else's business on a shared machine.
func writeStatusFile(path string, lines []string) error {
	directory := filepath.Dir(path)
	temporary, err := os.CreateTemp(directory, ".reviewplane-status-*")
	if err != nil {
		return fmt.Errorf("mcpbridge: creating the status file: %w", err)
	}
	name := temporary.Name()
	defer func() {
		if _, statErr := os.Stat(name); statErr == nil {
			_ = os.Remove(name)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("mcpbridge: setting the status file's permissions: %w", err)
	}
	if _, err := temporary.WriteString(strings.Join(lines, "\n") + "\n"); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("mcpbridge: writing the status file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("mcpbridge: closing the status file: %w", err)
	}
	if err := os.Rename(name, path); err != nil {
		return fmt.Errorf("mcpbridge: replacing the status file: %w", err)
	}
	return nil
}

// ErrNoInbox reports a control plane that answered the inbox with something
// this build cannot read.
var ErrNoInbox = errors.New("mcpbridge: the inbox could not be read")
