// Command reviewplane-connector is the ReviewPlane development-environment
// connector.
//
// It enrols an environment with the control plane and then holds one outbound,
// mutually authenticated channel open. It opens no listening socket: that is
// the mechanism behind the Stage 0 exit criterion "No public inbound port is
// required on the development VM" (docs/ROADMAP.md section 2, ADR-0002), and it
// is verifiable with "ss -ltnp" on the development VM.
//
// The connector is not a remote shell, a VPN, a filesystem synchronisation
// service or a source-code uploader (docs/CONNECTOR_PROTOCOL.md section 2).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	connectorv1 "github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/connector/internal/buildinfo"
	"github.com/danjonesio/reviewplane/services/connector/internal/channel"
	"github.com/danjonesio/reviewplane/services/connector/internal/config"
	"github.com/danjonesio/reviewplane/services/connector/internal/enrol"
	"github.com/danjonesio/reviewplane/services/connector/internal/identity"
	"github.com/danjonesio/reviewplane/services/connector/internal/logging"
	"github.com/danjonesio/reviewplane/services/connector/internal/transport"
)

// Exit codes. They are stable so that a systemd unit or a test can distinguish
// "retry later" from "an operator must act".
const (
	exitOK = 0
	// exitFailure is a failure that may resolve on its own, such as an
	// unreachable control plane.
	exitFailure = 1
	// exitUsage is a malformed command line.
	exitUsage = 2
	// exitRefused is a refusal that will not resolve without operator action:
	// an invalid enrolment token, a revoked identity, an unsupported protocol
	// version or a required upgrade.
	exitRefused = 3
)

func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr)) }

func run(args []string, stdout, stderr *os.File) int {
	if len(args) == 0 {
		usage(stderr)
		return exitUsage
	}
	switch args[0] {
	case "enrol", "enroll":
		return runEnrol(args[1:], stdout, stderr)
	case "run":
		return runChannel(args[1:], stdout, stderr)
	case "version", "--version", "-version":
		fmt.Fprintf(stdout, "%s %s\n", buildinfo.Name, buildinfo.Version)
		return exitOK
	case "help", "--help", "-h":
		usage(stdout)
		return exitOK
	default:
		fmt.Fprintf(stderr, "unknown command %q\n\n", args[0])
		usage(stderr)
		return exitUsage
	}
}

func usage(out *os.File) {
	fmt.Fprintf(out, `%s %s

Usage:
  reviewplane-connector enrol --control-plane <url> --token <one-time-token>
  reviewplane-connector run
  reviewplane-connector version

Commands:
  enrol    Exchange a one-time enrolment token for a device identity.
  run      Hold the outbound authenticated channel open and send heartbeats.
  version  Print the connector version.

Configuration is read from %s unless --config names another file.
`, buildinfo.Name, buildinfo.Version, config.DefaultPath)
}

// loadConfig reads the configuration file and applies command-line overrides.
func loadConfig(path, controlPlane, dataDir, caFile, environmentName, labels, logLevel string) (*config.Config, error) {
	cfg, err := config.Load(path)
	if err != nil && !errors.Is(err, config.ErrNoConfigFile) {
		return nil, err
	}
	if controlPlane != "" {
		parsed, err := config.ParseControlPlaneURL(controlPlane)
		if err != nil {
			return nil, fmt.Errorf("--control-plane: %w", err)
		}
		cfg.ControlPlane.URL = parsed
	}
	if dataDir != "" {
		cfg.Identity.DataDir = dataDir
	}
	if caFile != "" {
		cfg.ControlPlane.TLS.CAFile = caFile
	}
	if environmentName != "" {
		cfg.Environment.Name = environmentName
	}
	if labels != "" {
		cfg.Environment.Labels = splitLabels(labels)
	}
	if logLevel != "" {
		cfg.Logging.Level = logLevel
	}
	if err := config.ValidateEnvironment(cfg.Environment); err != nil {
		return nil, err
	}
	return cfg, nil
}

func splitLabels(value string) []string {
	var labels []string
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			labels = append(labels, part)
		}
	}
	return labels
}

func runEnrol(args []string, stdout, stderr *os.File) int {
	flags := flag.NewFlagSet("enrol", flag.ContinueOnError)
	flags.SetOutput(stderr)
	var (
		configPath  = flags.String("config", "", "configuration file (default "+config.DefaultPath+")")
		controlURL  = flags.String("control-plane", "", "control-plane base URL, for example https://agents.example.internal")
		token       = flags.String("token", "", "one-time enrolment token")
		tokenFile   = flags.String("token-file", "", "file holding the one-time enrolment token")
		dataDir     = flags.String("data-dir", "", "identity data directory (default "+config.DefaultDataDir+")")
		caFile      = flags.String("ca-file", "", "additional trust anchor for the control-plane server certificate")
		envName     = flags.String("environment-name", "", "operator-visible environment name (default: host name)")
		labels      = flags.String("labels", "", "comma-separated environment labels")
		force       = flags.Bool("force", false, "re-enrol, replacing any existing identity with a new one")
		maxAttempts = flags.Int("max-attempts", 0, "bound on transport retries (default 3)")
		logLevel    = flags.String("log-level", "", "debug, info, warn or error")
	)
	if err := flags.Parse(args); err != nil {
		return exitUsage
	}

	secret, err := readToken(*token, *tokenFile)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitUsage
	}

	cfg, err := loadConfig(*configPath, *controlURL, *dataDir, *caFile, *envName, *labels, *logLevel)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitUsage
	}
	if err := cfg.RequireControlPlaneURL(); err != nil {
		fmt.Fprintln(stderr, err)
		return exitUsage
	}

	logger := logging.New(stderr, cfg.Logging.Level)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	result, err := enrol.Run(ctx, enrol.Options{
		Config:      cfg,
		Token:       connectorv1.EnrolmentToken(secret),
		Force:       *force,
		MaxAttempts: *maxAttempts,
		Logger:      logger,
	})
	if err != nil {
		return reportFailure(stderr, logger, err)
	}

	fmt.Fprintf(stdout, "Enrolled as %s\n", result.ConnectorID)
	fmt.Fprintf(stdout, "Identity fingerprint: %s\n", result.CertificateFingerprint)
	fmt.Fprintf(stdout, "Identity expires:     %s\n", result.ExpiresAt.UTC().Format(time.RFC3339))
	fmt.Fprintf(stdout, "Control channel:      %s\n", result.ControlURL)
	fmt.Fprintf(stdout, "\nStart the channel with: %s run\n", buildinfo.Name)
	return exitOK
}

// readToken accepts the token on the command line, from a file, or from the
// REVIEWPLANE_ENROLMENT_TOKEN environment variable. A file or environment
// variable keeps the credential out of the process table and shell history,
// which a command line cannot (docs/SECURITY.md section 18).
func readToken(inline, path string) (string, error) {
	provided := 0
	for _, value := range []string{inline, path, os.Getenv("REVIEWPLANE_ENROLMENT_TOKEN")} {
		if value != "" {
			provided++
		}
	}
	switch {
	case provided == 0:
		return "", errors.New("--token, --token-file or REVIEWPLANE_ENROLMENT_TOKEN is required")
	case provided > 1:
		return "", errors.New("supply the enrolment token exactly once: --token, --token-file or REVIEWPLANE_ENROLMENT_TOKEN")
	}
	if inline != "" {
		return inline, nil
	}
	if path != "" {
		data, err := os.ReadFile(path) // #nosec G304 -- operator-supplied token file
		if err != nil {
			return "", fmt.Errorf("--token-file: %w", err)
		}
		return strings.TrimSpace(string(data)), nil
	}
	return strings.TrimSpace(os.Getenv("REVIEWPLANE_ENROLMENT_TOKEN")), nil
}

func runChannel(args []string, _, stderr *os.File) int {
	flags := flag.NewFlagSet("run", flag.ContinueOnError)
	flags.SetOutput(stderr)
	var (
		configPath = flags.String("config", "", "configuration file (default "+config.DefaultPath+")")
		dataDir    = flags.String("data-dir", "", "identity data directory (default "+config.DefaultDataDir+")")
		caFile     = flags.String("ca-file", "", "additional trust anchor for the control-plane server certificate")
		heartbeat  = flags.Duration("heartbeat-interval", 0, "override the heartbeat interval")
		logLevel   = flags.String("log-level", "", "debug, info, warn or error")
	)
	if err := flags.Parse(args); err != nil {
		return exitUsage
	}

	cfg, err := loadConfig(*configPath, "", *dataDir, *caFile, "", "", *logLevel)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitUsage
	}
	if *heartbeat > 0 {
		if *heartbeat < config.MinHeartbeatInterval || *heartbeat > config.MaxHeartbeatInterval {
			fmt.Fprintf(stderr, "--heartbeat-interval must be between %s and %s\n",
				config.MinHeartbeatInterval, config.MaxHeartbeatInterval)
			return exitUsage
		}
		cfg.Heartbeat.Interval = *heartbeat
	}

	logger := logging.New(stderr, cfg.Logging.Level)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	runner := &channel.Runner{
		Config: cfg,
		Store:  identity.NewStore(cfg.Identity.DataDir),
		Logger: logger,
	}
	if err := runner.Run(ctx); err != nil {
		return reportFailure(stderr, logger, err)
	}
	logger.Info("connector stopped")
	return exitOK
}

// reportFailure prints a stable error class where one applies, so that an
// operator and a test see the same vocabulary
// (docs/CONNECTOR_PROTOCOL.md section 21).
func reportFailure(stderr *os.File, logger *slog.Logger, err error) int {
	var permission *identity.PermissionError
	if errors.As(err, &permission) {
		logger.Error("refusing to start", slog.String("error", permission.Error()))
		fmt.Fprintln(stderr, permission.Error())
		return exitRefused
	}

	failure := transport.Classify(err)
	if failure != nil && failure.Class != "" {
		logger.Error("connector failed",
			slog.String("error_class", string(failure.Class)),
			slog.String("error", failure.Err.Error()),
		)
		fmt.Fprintf(stderr, "%s: %s\n", failure.Class, failure.Err.Error())
		if failure.Terminal {
			return exitRefused
		}
		return exitFailure
	}
	logger.Error("connector failed", slog.String("error", err.Error()))
	fmt.Fprintln(stderr, err.Error())
	return exitFailure
}
