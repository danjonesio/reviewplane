// Package logging builds the connector's structured logger.
//
// docs/ARCHITECTURE.md section 15 requires structured logs with trace
// correlation identifiers, of which the connector ID is one. docs/SECURITY.md
// section 18 forbids raw credentials in logs, which is why the enrolment token
// is carried as connectorv1.SensitiveString: its slog.LogValuer implementation
// redacts it even if a caller passes it by mistake.
package logging

import (
	"crypto/rand"
	"encoding/base64"
	"io"
	"log/slog"

	"github.com/danjonesio/reviewplane/services/connector/internal/buildinfo"
)

// New returns a JSON logger at the configured level. Logs go to standard error
// so that ordinary command output stays on standard output and journald
// captures both (docs/CONNECTOR_PROTOCOL.md section 3).
func New(out io.Writer, level string) *slog.Logger {
	handler := slog.NewJSONHandler(out, &slog.HandlerOptions{Level: parseLevel(level)})
	return slog.New(handler).With(
		slog.String("service", buildinfo.Name),
		slog.String("version", buildinfo.Version),
	)
}

func parseLevel(level string) slog.Level {
	switch level {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// NewCorrelationID returns an opaque identifier that ties every log record of
// one enrolment or one connection attempt together.
func NewCorrelationID(prefix string) string {
	buffer := make([]byte, 12)
	if _, err := rand.Read(buffer); err != nil {
		// A correlation ID is diagnostic, never an authorisation input, so a
		// degraded value is preferable to failing the operation it labels.
		return prefix + "unavailable"
	}
	return prefix + base64.RawURLEncoding.EncodeToString(buffer)
}
