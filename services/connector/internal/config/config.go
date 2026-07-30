// Package config loads and validates the connector configuration file of
// docs/CONNECTOR_PROTOCOL.md section 20.
//
// Every setting is validated at startup and every failure names the setting and
// the line it was read from, per docs/DEVELOPMENT.md section 6 and
// docs/CONFIGURATION.md section 1. An unknown setting is an error rather than a
// value that is silently ignored.
package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/danjonesio/reviewplane/services/connector/internal/hostinfo"
	"github.com/danjonesio/reviewplane/services/connector/internal/yamlmin"
)

// Default paths from docs/CONNECTOR_PROTOCOL.md section 3.
const (
	DefaultPath    = "/etc/reviewplane-connector/config.yaml"
	DefaultDataDir = "/var/lib/reviewplane-connector"
)

// Default channel paths. The registration response supplies the authoritative
// post-enrolment endpoints (docs/CONNECTOR_PROTOCOL.md section 4.3); only the
// enrolment path has to be known before an identity exists.
const DefaultEnrolmentPath = "/connector/v1/enrol"

// Stage 0 heartbeat and reconnect defaults. docs/CONNECTOR_PROTOCOL.md section
// 8 fixes the heartbeat interval at "configurable, approximately 15 seconds".
const (
	DefaultHeartbeatInterval = 15 * time.Second
	MinHeartbeatInterval     = time.Second
	MaxHeartbeatInterval     = 5 * time.Minute

	DefaultReconnectInitialDelay = time.Second
	DefaultReconnectMaxDelay     = 60 * time.Second
	DefaultReconnectFactor       = 2.0
	DefaultReconnectJitter       = 0.3
)

// ControlPlane is the control_plane block.
type ControlPlane struct {
	URL           *url.URL
	EnrolmentPath string
	TLS           TLS
}

// TLS carries the connector's certificate-trust settings. docs/CONFIGURATION.md
// section 5 lists certificate trust as a connector configuration area.
type TLS struct {
	// CAFile is an additional trust anchor for the control-plane server
	// certificate. Empty means the system trust store is used.
	CAFile string
}

// Identity is the identity block.
type Identity struct {
	DataDir string
}

// HeartbeatSettings is the heartbeat block. The name avoids colliding with the
// protocol's own Heartbeat payload type, which only packages/protocol defines.
type HeartbeatSettings struct {
	Interval time.Duration
}

// Reconnect is the reconnect block.
type Reconnect struct {
	InitialDelay time.Duration
	MaxDelay     time.Duration
	Factor       float64
	Jitter       float64
	// MaxAttempts bounds enrolment retries and reconnect attempts. Zero means
	// unbounded, which is the default for the long-running channel.
	MaxAttempts int
}

// Environment is the environment block. It supplies the environment descriptor
// of docs/CONNECTOR_PROTOCOL.md section 4.3.
type Environment struct {
	Name   string
	Labels []string
}

// Privacy is the privacy block of docs/CONNECTOR_PROTOCOL.md section 20.
type Privacy struct {
	ReportChangedPaths  bool
	ReportProcessDetail bool
	DiscoverWorkspaces  bool
}

// Logging is the logging block.
type Logging struct {
	Level  string
	Format string
}

// Workspace is one entry of the workspaces block.
//
// Workspace discovery is Stage 1 (docs/CONNECTOR_PROTOCOL.md section 9), so the
// identifier the control plane names in a publication cannot be discovered yet.
// It is configured instead: a publication whose workspace_id is not one of
// these is refused with WORKSPACE_NOT_FOUND, which is the section 11 check the
// connector owes independently of the control plane. Discovery replaces the
// source of this list; it does not remove the check.
type Workspace struct {
	ID      string
	Path    string
	Project string
}

// Publication is the publication block: this connector's own say over what it
// will carry (docs/CONNECTOR_PROTOCOL.md section 11).
type Publication struct {
	AllowedHosts []string
	AllowedPorts []string
	MaxRoutes    int
	// AllowedProjects lists the projects this connector serves. Empty means
	// the projects named in the workspaces block, so an operator who has
	// declared their workspaces does not have to declare the same projects
	// twice.
	AllowedProjects []string
}

// AuthorisedProjects reports the projects a publication may name.
func (c *Config) AuthorisedProjects() []string {
	if len(c.Publication.AllowedProjects) > 0 {
		return append([]string(nil), c.Publication.AllowedProjects...)
	}
	seen := map[string]bool{}
	projects := make([]string, 0, len(c.Workspaces))
	for _, workspace := range c.Workspaces {
		if workspace.Project == "" || seen[workspace.Project] {
			continue
		}
		seen[workspace.Project] = true
		projects = append(projects, workspace.Project)
	}
	return projects
}

// KnownWorkspaces reports the workspace identifiers a publication may name.
func (c *Config) KnownWorkspaces() []string {
	seen := map[string]bool{}
	workspaces := make([]string, 0, len(c.Workspaces))
	for _, workspace := range c.Workspaces {
		if workspace.ID == "" || seen[workspace.ID] {
			continue
		}
		seen[workspace.ID] = true
		workspaces = append(workspaces, workspace.ID)
	}
	return workspaces
}

// Config is the validated connector configuration.
type Config struct {
	// Path records where the configuration was read from, or is empty when
	// built-in defaults were used.
	Path         string
	ControlPlane ControlPlane
	Identity     Identity
	Heartbeat    HeartbeatSettings
	Reconnect    Reconnect
	Environment  Environment
	Privacy      Privacy
	Logging      Logging
	Workspaces   []Workspace
	Publication  Publication
}

// ErrNoConfigFile reports that the default configuration path does not exist.
// Callers that can supply every required setting from flags treat it as
// non-fatal; callers that cannot report it.
var ErrNoConfigFile = errors.New("config: no configuration file")

// Defaults returns the configuration the connector uses when no file is
// present. It is not yet valid: control_plane.url has no default.
func Defaults() *Config {
	return &Config{
		ControlPlane: ControlPlane{EnrolmentPath: DefaultEnrolmentPath},
		Identity:     Identity{DataDir: DefaultDataDir},
		Heartbeat:    HeartbeatSettings{Interval: DefaultHeartbeatInterval},
		Reconnect: Reconnect{
			InitialDelay: DefaultReconnectInitialDelay,
			MaxDelay:     DefaultReconnectMaxDelay,
			Factor:       DefaultReconnectFactor,
			Jitter:       DefaultReconnectJitter,
		},
		Environment: Environment{Name: hostinfo.EnvironmentName()},
		Logging:     Logging{Level: "info", Format: "json"},
		Publication: Publication{MaxRoutes: 10},
	}
}

// Load reads path. When path is empty the default location is read and a
// missing file yields Defaults with ErrNoConfigFile, so that the enrolment
// command documented in docs/UX_FLOWS.md section 5 works before a configuration
// file exists.
func Load(path string) (*Config, error) {
	explicit := path != ""
	if !explicit {
		path = DefaultPath
	}
	data, err := os.ReadFile(path) // #nosec G304 -- operator-supplied configuration path
	if err != nil {
		if !explicit && errors.Is(err, os.ErrNotExist) {
			return Defaults(), ErrNoConfigFile
		}
		return nil, fmt.Errorf("config: reading %s: %w", path, err)
	}
	cfg, err := Parse(data)
	if err != nil {
		return nil, fmt.Errorf("config: %s: %w", path, err)
	}
	cfg.Path = path
	return cfg, nil
}

// Parse decodes and validates configuration bytes.
func Parse(data []byte) (*Config, error) {
	root, err := yamlmin.Parse(data)
	if err != nil {
		return nil, err
	}
	root, err = root.Mapping("configuration")
	if err != nil {
		return nil, err
	}
	if err := root.RejectUnknownKeys("configuration",
		"control_plane", "identity", "heartbeat", "reconnect",
		"environment", "workspaces", "publication", "privacy", "logging"); err != nil {
		return nil, err
	}

	cfg := Defaults()
	for _, section := range []func(*Config, *yamlmin.Node) error{
		loadControlPlane, loadIdentity, loadHeartbeat, loadReconnect,
		loadEnvironment, loadWorkspaces, loadPublication, loadPrivacy, loadLogging,
	} {
		if err := section(cfg, root); err != nil {
			return nil, err
		}
	}
	return cfg, nil
}

func loadControlPlane(cfg *Config, root *yamlmin.Node) error {
	node, err := root.Child("control_plane").Mapping("control_plane")
	if err != nil {
		return err
	}
	if err := node.RejectUnknownKeys("control_plane", "url", "enrolment_path", "tls"); err != nil {
		return err
	}
	if raw, err := node.Child("url").String("control_plane.url"); err == nil {
		parsed, err := ParseControlPlaneURL(raw)
		if err != nil {
			return err
		}
		cfg.ControlPlane.URL = parsed
	} else if !errors.Is(err, yamlmin.ErrNotFound) {
		return err
	}
	if raw, err := node.Child("enrolment_path").String("control_plane.enrolment_path"); err == nil {
		if !strings.HasPrefix(raw, "/") {
			return fmt.Errorf("control_plane.enrolment_path must start with \"/\", found %q", raw)
		}
		cfg.ControlPlane.EnrolmentPath = raw
	} else if !errors.Is(err, yamlmin.ErrNotFound) {
		return err
	}

	tls, err := node.Child("tls").Mapping("control_plane.tls")
	if err != nil {
		return err
	}
	if err := tls.RejectUnknownKeys("control_plane.tls", "ca_file"); err != nil {
		return err
	}
	if raw, err := tls.Child("ca_file").String("control_plane.tls.ca_file"); err == nil {
		if !filepath.IsAbs(raw) {
			return fmt.Errorf("control_plane.tls.ca_file must be an absolute path, found %q", raw)
		}
		cfg.ControlPlane.TLS.CAFile = raw
	} else if !errors.Is(err, yamlmin.ErrNotFound) {
		return err
	}
	return nil
}

// ParseControlPlaneURL validates the control-plane base URL. TLS is mandatory
// (docs/SECURITY.md section 15), so a plaintext URL is refused rather than
// downgraded.
func ParseControlPlaneURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("control_plane.url is not a URL: %w", err)
	}
	switch parsed.Scheme {
	case "https", "wss":
	case "http", "ws":
		return nil, fmt.Errorf(
			"control_plane.url must use https; %q would send the enrolment token over an unencrypted connection", raw)
	default:
		return nil, fmt.Errorf("control_plane.url must use https, found scheme %q", parsed.Scheme)
	}
	if parsed.Host == "" {
		return nil, fmt.Errorf("control_plane.url has no host: %q", raw)
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("control_plane.url must not carry a query or fragment: %q", raw)
	}
	parsed.Path = strings.TrimSuffix(parsed.Path, "/")
	return parsed, nil
}

func loadIdentity(cfg *Config, root *yamlmin.Node) error {
	node, err := root.Child("identity").Mapping("identity")
	if err != nil {
		return err
	}
	if err := node.RejectUnknownKeys("identity", "data_dir"); err != nil {
		return err
	}
	raw, err := node.Child("data_dir").String("identity.data_dir")
	if errors.Is(err, yamlmin.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if !filepath.IsAbs(raw) {
		return fmt.Errorf("identity.data_dir must be an absolute path, found %q", raw)
	}
	cfg.Identity.DataDir = filepath.Clean(raw)
	return nil
}

func loadHeartbeat(cfg *Config, root *yamlmin.Node) error {
	node, err := root.Child("heartbeat").Mapping("heartbeat")
	if err != nil {
		return err
	}
	if err := node.RejectUnknownKeys("heartbeat", "interval"); err != nil {
		return err
	}
	interval, err := node.Child("interval").Duration("heartbeat.interval")
	if errors.Is(err, yamlmin.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if interval < MinHeartbeatInterval || interval > MaxHeartbeatInterval {
		return fmt.Errorf("heartbeat.interval must be between %s and %s, found %s",
			MinHeartbeatInterval, MaxHeartbeatInterval, interval)
	}
	cfg.Heartbeat.Interval = interval
	return nil
}

func loadReconnect(cfg *Config, root *yamlmin.Node) error {
	node, err := root.Child("reconnect").Mapping("reconnect")
	if err != nil {
		return err
	}
	if err := node.RejectUnknownKeys("reconnect",
		"initial_delay", "max_delay", "factor", "jitter", "max_attempts"); err != nil {
		return err
	}
	if value, err := node.Child("initial_delay").Duration("reconnect.initial_delay"); err == nil {
		cfg.Reconnect.InitialDelay = value
	} else if !errors.Is(err, yamlmin.ErrNotFound) {
		return err
	}
	if value, err := node.Child("max_delay").Duration("reconnect.max_delay"); err == nil {
		cfg.Reconnect.MaxDelay = value
	} else if !errors.Is(err, yamlmin.ErrNotFound) {
		return err
	}
	if value, err := node.Child("factor").Float("reconnect.factor"); err == nil {
		cfg.Reconnect.Factor = value
	} else if !errors.Is(err, yamlmin.ErrNotFound) {
		return err
	}
	if value, err := node.Child("jitter").Float("reconnect.jitter"); err == nil {
		cfg.Reconnect.Jitter = value
	} else if !errors.Is(err, yamlmin.ErrNotFound) {
		return err
	}
	if value, err := node.Child("max_attempts").Int("reconnect.max_attempts"); err == nil {
		cfg.Reconnect.MaxAttempts = value
	} else if !errors.Is(err, yamlmin.ErrNotFound) {
		return err
	}

	switch {
	case cfg.Reconnect.InitialDelay < 10*time.Millisecond:
		return fmt.Errorf("reconnect.initial_delay must be at least 10ms, found %s", cfg.Reconnect.InitialDelay)
	case cfg.Reconnect.MaxDelay < cfg.Reconnect.InitialDelay:
		return fmt.Errorf("reconnect.max_delay (%s) must not be shorter than reconnect.initial_delay (%s)",
			cfg.Reconnect.MaxDelay, cfg.Reconnect.InitialDelay)
	case cfg.Reconnect.MaxDelay > time.Hour:
		return fmt.Errorf("reconnect.max_delay must be at most 1h, found %s", cfg.Reconnect.MaxDelay)
	case cfg.Reconnect.Factor < 1 || cfg.Reconnect.Factor > 10:
		return fmt.Errorf("reconnect.factor must be between 1 and 10, found %v", cfg.Reconnect.Factor)
	case cfg.Reconnect.Jitter < 0 || cfg.Reconnect.Jitter > 1:
		return fmt.Errorf("reconnect.jitter must be between 0 and 1, found %v", cfg.Reconnect.Jitter)
	case cfg.Reconnect.MaxAttempts < 0:
		return fmt.Errorf("reconnect.max_attempts must not be negative, found %d", cfg.Reconnect.MaxAttempts)
	}
	return nil
}

var (
	environmentNamePattern  = regexp.MustCompile(`^[^\x00-\x1f\x7f]+$`)
	environmentLabelPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)
)

// Bounds copied from the environment_descriptor definition in
// packages/protocol/schemas/connector/v1.schema.json. The schema is the
// authority; validating locally turns a server-side schema refusal into a
// startup error the operator can act on.
const (
	MaxEnvironmentNameLength  = 128
	MaxEnvironmentLabels      = 16
	MaxEnvironmentLabelLength = 64
)

func loadEnvironment(cfg *Config, root *yamlmin.Node) error {
	node, err := root.Child("environment").Mapping("environment")
	if err != nil {
		return err
	}
	if err := node.RejectUnknownKeys("environment", "name", "labels"); err != nil {
		return err
	}
	if value, err := node.Child("name").String("environment.name"); err == nil {
		cfg.Environment.Name = value
	} else if !errors.Is(err, yamlmin.ErrNotFound) {
		return err
	}
	if value, err := node.Child("labels").StringSlice("environment.labels"); err == nil {
		cfg.Environment.Labels = value
	} else if !errors.Is(err, yamlmin.ErrNotFound) {
		return err
	}
	return ValidateEnvironment(cfg.Environment)
}

// ValidateEnvironment enforces the schema bounds on the environment descriptor.
func ValidateEnvironment(env Environment) error {
	switch {
	case env.Name == "":
		return errors.New("environment.name must not be empty")
	case len(env.Name) > MaxEnvironmentNameLength:
		return fmt.Errorf("environment.name must be at most %d characters, found %d",
			MaxEnvironmentNameLength, len(env.Name))
	case !environmentNamePattern.MatchString(env.Name):
		return fmt.Errorf("environment.name must not contain control characters: %q", env.Name)
	case len(env.Labels) > MaxEnvironmentLabels:
		return fmt.Errorf("environment.labels must list at most %d labels, found %d",
			MaxEnvironmentLabels, len(env.Labels))
	}
	seen := make(map[string]bool, len(env.Labels))
	for _, label := range env.Labels {
		switch {
		case len(label) > MaxEnvironmentLabelLength:
			return fmt.Errorf("environment label %q must be at most %d characters",
				label, MaxEnvironmentLabelLength)
		case !environmentLabelPattern.MatchString(label):
			return fmt.Errorf(
				"environment label %q must start with a lowercase letter or digit and use only lowercase letters, digits, \".\", \"_\" and \"-\"",
				label)
		case seen[label]:
			return fmt.Errorf("environment label %q is listed twice", label)
		}
		seen[label] = true
	}
	return nil
}

func loadWorkspaces(cfg *Config, root *yamlmin.Node) error {
	items, err := root.Child("workspaces").Sequence("workspaces")
	if errors.Is(err, yamlmin.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	for index, item := range items {
		name := fmt.Sprintf("workspaces[%d]", index)
		mapping, err := item.Mapping(name)
		if err != nil {
			return err
		}
		if err := mapping.RejectUnknownKeys(name, "id", "path", "project"); err != nil {
			return err
		}
		identifier, err := mapping.Child("id").String(name + ".id")
		if err != nil && !errors.Is(err, yamlmin.ErrNotFound) {
			return err
		}
		path, err := mapping.Child("path").String(name + ".path")
		if err != nil {
			return fmt.Errorf("%s.path is required: %w", name, err)
		}
		if !filepath.IsAbs(path) {
			return fmt.Errorf("%s.path must be an absolute path, found %q", name, path)
		}
		project, err := mapping.Child("project").String(name + ".project")
		if err != nil && !errors.Is(err, yamlmin.ErrNotFound) {
			return err
		}
		cfg.Workspaces = append(cfg.Workspaces, Workspace{
			ID:      identifier,
			Path:    filepath.Clean(path),
			Project: project,
		})
	}
	return nil
}

func loadPublication(cfg *Config, root *yamlmin.Node) error {
	node, err := root.Child("publication").Mapping("publication")
	if err != nil {
		return err
	}
	if err := node.RejectUnknownKeys(
		"publication", "allowed_hosts", "allowed_ports", "max_routes", "allowed_projects",
	); err != nil {
		return err
	}
	if value, err := node.Child("allowed_projects").StringSlice("publication.allowed_projects"); err == nil {
		cfg.Publication.AllowedProjects = value
	} else if !errors.Is(err, yamlmin.ErrNotFound) {
		return err
	}
	if value, err := node.Child("allowed_hosts").StringSlice("publication.allowed_hosts"); err == nil {
		cfg.Publication.AllowedHosts = value
	} else if !errors.Is(err, yamlmin.ErrNotFound) {
		return err
	}
	if value, err := node.Child("allowed_ports").StringSlice("publication.allowed_ports"); err == nil {
		cfg.Publication.AllowedPorts = value
	} else if !errors.Is(err, yamlmin.ErrNotFound) {
		return err
	}
	if value, err := node.Child("max_routes").Int("publication.max_routes"); err == nil {
		if value < 1 || value > 1024 {
			return fmt.Errorf("publication.max_routes must be between 1 and 1024, found %d", value)
		}
		cfg.Publication.MaxRoutes = value
	} else if !errors.Is(err, yamlmin.ErrNotFound) {
		return err
	}
	return nil
}

func loadPrivacy(cfg *Config, root *yamlmin.Node) error {
	node, err := root.Child("privacy").Mapping("privacy")
	if err != nil {
		return err
	}
	if err := node.RejectUnknownKeys("privacy",
		"report_changed_paths", "report_process_details", "discover_workspaces"); err != nil {
		return err
	}
	if value, err := node.Child("report_changed_paths").Bool("privacy.report_changed_paths"); err == nil {
		cfg.Privacy.ReportChangedPaths = value
	} else if !errors.Is(err, yamlmin.ErrNotFound) {
		return err
	}
	if value, err := node.Child("report_process_details").Bool("privacy.report_process_details"); err == nil {
		cfg.Privacy.ReportProcessDetail = value
	} else if !errors.Is(err, yamlmin.ErrNotFound) {
		return err
	}
	if value, err := node.Child("discover_workspaces").Bool("privacy.discover_workspaces"); err == nil {
		cfg.Privacy.DiscoverWorkspaces = value
	} else if !errors.Is(err, yamlmin.ErrNotFound) {
		return err
	}

	// docs/CONNECTOR_PROTOCOL.md section 8 keeps process detail out of the
	// heartbeat, and the resource_summary schema refuses any property other
	// than load and memory_available_bytes. There is therefore no configuration
	// under which this build can honour report_process_details: true, and
	// accepting the setting silently would misrepresent what is reported.
	if cfg.Privacy.ReportProcessDetail {
		return errors.New(
			"privacy.report_process_details must be false: the heartbeat resource summary reports only load and memory_available_bytes (docs/CONNECTOR_PROTOCOL.md section 8)")
	}
	if cfg.Privacy.DiscoverWorkspaces {
		return errors.New(
			"privacy.discover_workspaces must be false: workspace discovery is not implemented by this connector build (docs/CONNECTOR_PROTOCOL.md section 9)")
	}
	return nil
}

func loadLogging(cfg *Config, root *yamlmin.Node) error {
	node, err := root.Child("logging").Mapping("logging")
	if err != nil {
		return err
	}
	if err := node.RejectUnknownKeys("logging", "level", "format"); err != nil {
		return err
	}
	if value, err := node.Child("level").String("logging.level"); err == nil {
		cfg.Logging.Level = value
	} else if !errors.Is(err, yamlmin.ErrNotFound) {
		return err
	}
	if value, err := node.Child("format").String("logging.format"); err == nil {
		cfg.Logging.Format = value
	} else if !errors.Is(err, yamlmin.ErrNotFound) {
		return err
	}
	switch cfg.Logging.Level {
	case "debug", "info", "warn", "error":
	default:
		return fmt.Errorf("logging.level must be one of debug, info, warn, error, found %q", cfg.Logging.Level)
	}
	if cfg.Logging.Format != "json" {
		return fmt.Errorf(
			"logging.format must be \"json\": structured JSON logging is the only supported format (docs/ARCHITECTURE.md section 15), found %q",
			cfg.Logging.Format)
	}
	return nil
}

// RequireControlPlaneURL reports the specific error used when no control-plane
// URL was supplied by either the configuration file or a flag.
func (c *Config) RequireControlPlaneURL() error {
	if c.ControlPlane.URL == nil {
		return errors.New("control_plane.url is required: set it in the configuration file or pass --control-plane")
	}
	return nil
}

// EnrolmentURL is the wss URL the registration exchange of
// docs/CONNECTOR_PROTOCOL.md section 4.3 is carried over.
func (c *Config) EnrolmentURL() (string, error) {
	if err := c.RequireControlPlaneURL(); err != nil {
		return "", err
	}
	endpoint := *c.ControlPlane.URL
	endpoint.Scheme = "wss"
	endpoint.Path = endpoint.Path + c.ControlPlane.EnrolmentPath
	return endpoint.String(), nil
}
