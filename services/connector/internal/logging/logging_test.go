package logging

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	connectorv1 "github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/connector/internal/buildinfo"
)

func TestNewProducesStructuredJSON(t *testing.T) {
	var buffer bytes.Buffer
	logger := New(&buffer, "info")
	logger.Info("channel established", slog.String("connector_id", "con_example"))

	var record map[string]any
	if err := json.Unmarshal(buffer.Bytes(), &record); err != nil {
		t.Fatalf("log output is not JSON: %v (%q)", err, buffer.String())
	}
	for key, want := range map[string]string{
		"msg":          "channel established",
		"service":      buildinfo.Name,
		"version":      buildinfo.Version,
		"connector_id": "con_example",
	} {
		if got, _ := record[key].(string); got != want {
			t.Fatalf("%s = %q, want %q", key, got, want)
		}
	}
}

func TestLevelFiltering(t *testing.T) {
	var buffer bytes.Buffer
	logger := New(&buffer, "warn")
	logger.Debug("debug")
	logger.Info("info")
	if buffer.Len() != 0 {
		t.Fatalf("records below the level were emitted: %q", buffer.String())
	}
	logger.Warn("warn")
	if !strings.Contains(buffer.String(), "\"msg\":\"warn\"") {
		t.Fatalf("the warning was not emitted: %q", buffer.String())
	}
}

// docs/SECURITY.md section 18: a credential must not reach the log even when a
// caller passes it by mistake. The generated sensitive type is what makes that
// true by construction.
func TestSensitiveValuesAreRedacted(t *testing.T) {
	const secret = "an-enrolment-token-value"
	var buffer bytes.Buffer
	logger := New(&buffer, "info")
	token := connectorv1.EnrolmentToken(secret)
	logger.Info("enrolling",
		slog.Any("token", token),
		slog.String("interpolated", "token="+token.String()),
	)
	if strings.Contains(buffer.String(), secret) {
		t.Fatalf("the token reached the log: %q", buffer.String())
	}
	if !strings.Contains(buffer.String(), connectorv1.Redacted) {
		t.Fatalf("the redaction marker is missing: %q", buffer.String())
	}
}

func TestNewCorrelationIDIsPrefixedAndUnique(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 32; i++ {
		id := NewCorrelationID("cor_")
		if !strings.HasPrefix(id, "cor_") {
			t.Fatalf("correlation id %q lacks the prefix", id)
		}
		if seen[id] {
			t.Fatalf("correlation id %q was produced twice", id)
		}
		seen[id] = true
	}
}
