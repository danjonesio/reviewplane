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
	"path/filepath"
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
	"github.com/danjonesio/reviewplane/services/connector/internal/routes"
	"github.com/danjonesio/reviewplane/services/connector/internal/transport"
	"github.com/danjonesio/reviewplane/services/connector/internal/workspaces"
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
	case "mcp":
		return runMCPBridge(args[1:], stdout, stderr)
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
  reviewplane-connector mcp
  reviewplane-connector version

Commands:
  enrol    Exchange a one-time enrolment token for a device identity.
  run      Hold the outbound authenticated channel open, publish authorised
           routes and report workspace Git context.
  mcp      Local MCP bridge for an agent in this environment. It resolves the
           workspace and project for the working directory; the short-lived
           agent-session credential exchange is not available in this build.
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

	manager, err := routes.NewManager(routes.Options{
		Publication:        cfg.Publication,
		AuthorisedProjects: cfg.AuthorisedProjects(),
		KnownWorkspaces:    cfg.KnownWorkspaces(),
		Logger:             logger,
	})
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitUsage
	}

	store := identity.NewStore(cfg.Identity.DataDir)
	runner := &channel.Runner{
		Config: cfg,
		Store:  store,
		Logger: logger,
		Routes: manager,
		// Only the paths named in the workspaces block are ever looked at
		// (docs/CONNECTOR_PROTOCOL.md section 9). An empty block means the
		// connector reports no workspace context, not that it goes looking.
		Workspaces: workspaces.New(workspaces.Options{
			Workspaces: cfg.Workspaces,
			Interval:   cfg.GitContext.Interval,
			Logger:     logger,
		}),
	}

	// The data channel is a second outbound connection with its own life. It
	// is supervised beside the control channel rather than inside it: a
	// gateway restart must not take the control channel down with it, and a
	// control-plane restart must not drop streams that are still in flight.
	dataDone := make(chan struct{})
	go func() {
		defer close(dataDone)
		manager.SuperviseDataChannel(ctx, routes.SupervisorOptions{
			Store:  store,
			Config: cfg,
			Logger: logger,
			Reconnect: routes.ReconnectPolicy{
				Initial: cfg.Reconnect.InitialDelay,
				Max:     cfg.Reconnect.MaxDelay,
				Factor:  cfg.Reconnect.Factor,
				Jitter:  cfg.Reconnect.Jitter,
			},
		})
	}()

	runErr := runner.Run(ctx)
	stop()
	<-dataDone
	if runErr != nil {
		return reportFailure(stderr, logger, runErr)
	}
	logger.Info("connector stopped")
	return exitOK
}

// bridgeUnavailable is the stable message the local MCP bridge reports until
// the agent-session credential exchange lands. It is a constant so that an
// operator, a shell wrapper and a test all read the same sentence.
const bridgeUnavailable = "the local MCP bridge credential exchange is not available in this build (RVP-49)"

// runMCPBridge is the local MCP bridge command surface of
// docs/CONNECTOR_PROTOCOL.md section 14.
//
// Section 14 gives the bridge four responsibilities: resolve the local
// workspace and project, request short-lived agent-session credentials, proxy
// MCP traffic to the control plane, and avoid storing long-lived agent tokens.
// This build implements the first and refuses rather than inventing the rest.
//
// Refusing is the point. A bridge that invented a credential exchange would be
// inventing an authentication path, which docs/SECURITY.md section 6.3 fixes and
// AGENTS.md "Architecture changes" puts behind an ADR; and one that proxied
// without a credential would hand an agent whatever authority the connector
// holds, which section 14 forbids in terms ("It must not grant the agent
// connector-administrator privileges"). So the command validates everything it
// can validate locally, tells the operator exactly what it found, and exits with
// the refusal code rather than with success.
func runMCPBridge(args []string, stdout, stderr *os.File) int {
	flags := flag.NewFlagSet("mcp", flag.ContinueOnError)
	flags.SetOutput(stderr)
	var (
		configPath  = flags.String("config", "", "configuration file (default "+config.DefaultPath+")")
		dataDir     = flags.String("data-dir", "", "identity data directory (default "+config.DefaultDataDir+")")
		workspaceID = flags.String("workspace", "", "workspace to resolve (default: the one containing the working directory)")
		directory   = flags.String("directory", "", "working directory to resolve (default: the current one)")
		logLevel    = flags.String("log-level", "", "debug, info, warn or error")
	)
	if err := flags.Parse(args); err != nil {
		return exitUsage
	}

	cfg, err := loadConfig(*configPath, "", *dataDir, "", "", "", *logLevel)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitUsage
	}
	logger := logging.New(stderr, cfg.Logging.Level)

	// An environment with no identity has nothing to bridge to: the session the
	// agent would use is issued against this connector, and there is no
	// connector yet.
	store := identity.NewStore(cfg.Identity.DataDir)
	// Enrolment is checked before the key file, unlike the channel's own start:
	// an environment that was never enrolled has no key to have permissions on,
	// and "there is no device.key" is a worse answer to "why will the bridge not
	// start" than "this environment holds no connector identity".
	if !store.Enrolled() {
		fmt.Fprintln(stderr, channel.ErrNotEnrolled.Error())
		return exitRefused
	}
	if err := store.CheckKeyPermissions(); err != nil {
		return reportFailure(stderr, logger, err)
	}
	record, err := store.LoadRecord()
	if err != nil {
		return reportFailure(stderr, logger, err)
	}

	workspace, err := resolveWorkspace(cfg, *workspaceID, *directory)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitRefused
	}

	// What was resolved is printed before the refusal, so that an operator can
	// tell "the bridge does not exist yet" from "the bridge cannot see my
	// project", which are two quite different problems with the same exit code.
	fmt.Fprintf(stdout, "Connector:  %s\n", record.ConnectorID)
	fmt.Fprintf(stdout, "Workspace:  %s\n", workspace.ID)
	fmt.Fprintf(stdout, "Project:    %s\n", workspace.Project)
	fmt.Fprintf(stdout, "Checkout:   %s\n", workspace.Path)

	logger.Error("refusing to start the local MCP bridge",
		slog.String("reason", bridgeUnavailable),
		slog.String("connector_id", record.ConnectorID),
		slog.String("workspace_id", workspace.ID),
	)
	fmt.Fprintln(stderr, bridgeUnavailable)
	return exitRefused
}

// resolveWorkspace finds the configured workspace an agent in directory belongs
// to (docs/CONNECTOR_PROTOCOL.md section 14, "Resolve local workspace and
// project").
//
// The match is on the configured paths only. Nothing is discovered: a directory
// that is inside no configured workspace is reported as such rather than
// registered on the spot, because a publication names a workspace the operator
// authorised (section 11). The longest matching path wins, so a workspace nested
// inside another resolves to the nearer one.
func resolveWorkspace(cfg *config.Config, workspaceID, directory string) (config.Workspace, error) {
	usable := make([]config.Workspace, 0, len(cfg.Workspaces))
	for _, workspace := range cfg.Workspaces {
		if workspace.ID != "" && workspace.Project != "" {
			usable = append(usable, workspace)
		}
	}
	if len(usable) == 0 {
		return config.Workspace{}, errors.New(
			"no workspace is configured with both an id and a project; add one to the workspaces block")
	}

	if workspaceID != "" {
		for _, workspace := range usable {
			if workspace.ID == workspaceID {
				return workspace, nil
			}
		}
		return config.Workspace{}, fmt.Errorf(
			"no configured workspace is named %q; the workspaces block names %s",
			workspaceID, strings.Join(workspaceIDs(usable), ", "))
	}

	if directory == "" {
		working, err := os.Getwd()
		if err != nil {
			return config.Workspace{}, fmt.Errorf("resolving the working directory: %w", err)
		}
		directory = working
	}
	if !filepath.IsAbs(directory) {
		absolute, err := filepath.Abs(directory)
		if err != nil {
			return config.Workspace{}, fmt.Errorf("resolving %s: %w", directory, err)
		}
		directory = absolute
	}
	directory = filepath.Clean(directory)

	var resolved config.Workspace
	for _, workspace := range usable {
		if !withinWorkspace(directory, workspace.Path) {
			continue
		}
		if len(workspace.Path) > len(resolved.Path) {
			resolved = workspace
		}
	}
	if resolved.ID == "" {
		return config.Workspace{}, fmt.Errorf(
			"%s is inside no configured workspace; the workspaces block names %s, or pass --workspace",
			directory, strings.Join(workspaceIDs(usable), ", "))
	}
	return resolved, nil
}

// withinWorkspace reports whether directory is the workspace path or is beneath
// it. The separator check is what stops /home/dan/projects/api-old matching a
// workspace at /home/dan/projects/api.
func withinWorkspace(directory, workspacePath string) bool {
	if directory == workspacePath {
		return true
	}
	return strings.HasPrefix(directory, workspacePath+string(filepath.Separator))
}

func workspaceIDs(configured []config.Workspace) []string {
	identifiers := make([]string, 0, len(configured))
	for _, workspace := range configured {
		identifiers = append(identifiers, workspace.ID)
	}
	return identifiers
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
		// The full error is reported, not only the classified cause: a wrapper
		// such as "after 3 attempts" is what tells an operator whether the
		// retry budget was exhausted. The class is prefixed once, not twice.
		detail := err.Error()
		prefix := string(failure.Class) + ": "
		detail = strings.TrimPrefix(detail, prefix)
		logger.Error("connector failed",
			slog.String("error_class", string(failure.Class)),
			slog.String("error", detail),
		)
		fmt.Fprintf(stderr, "%s: %s\n", failure.Class, detail)
		if failure.Terminal {
			return exitRefused
		}
		return exitFailure
	}
	logger.Error("connector failed", slog.String("error", err.Error()))
	fmt.Fprintln(stderr, err.Error())
	return exitFailure
}
