// Package config loads and validates the tunnel gateway's settings.
//
// docs/CONFIGURATION.md section 1 requires validation at startup, a clear
// failure on an unknown or invalid setting and documented defaults, and section
// 7 requires a *_FILE form for secret material so that Compose can mount it
// rather than putting it in an environment variable. Section 4 additionally
// forbids a setting that trivially enables unrestricted proxying without an
// explicit high-risk mode: the two settings that widen the destination policy
// are named for what they do and emit a startup warning.
package config

import (
	"encoding/base64"
	"errors"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/policy"
)

// Prefix namespaces every setting.
const Prefix = "REVIEWPLANE_TUNNEL_"

// Config is the validated configuration.
type Config struct {
	// ProxyListenAddress serves browser requests for internal origins. It is
	// the only listener a deployment publishes.
	ProxyListenAddress string
	// ConnectorListenAddress terminates connector data channels over mutual TLS.
	ConnectorListenAddress string
	// AdminListenAddress serves the control API and metrics. It defaults to
	// loopback: docs/SECURITY.md section 4 lists administrator misconfiguration
	// exposing internal services as a primary threat.
	AdminListenAddress string

	InternalSuffix      string
	HostHeaderMode      string
	ForwardedHeaderMode string
	StreamMaxLifetime   time.Duration
	MaxRequestBodyBytes int64
	RelayBufferBytes    int

	RouteTTLMax             time.Duration
	MaxRoutesPerConnector   int
	MaxStreamsPerConnector  int
	MaxStreamsPerRoute      int
	MaxStreamBytes          int64
	StreamIdleTimeout       time.Duration
	UpgradeIdleTimeout      time.Duration
	SweepInterval           time.Duration
	MaxDataChannelMessage   int
	DestinationPolicy       policy.Policy
	WidenedDestinationScope []string

	AdminToken      string
	CapabilityKeys  connectorv1.CapabilityKeyring
	ConnectorCAFile string
	TLSCertFile     string
	TLSKeyFile      string

	IdentitySource    string
	IdentityURIPrefix string

	LogLevel  string
	LogFormat string
}

type loader struct {
	problems []string
	lookup   func(string) (string, bool)
}

// Load reads the configuration from the process environment.
func Load() (Config, error) { return LoadFrom(os.LookupEnv) }

// LoadFrom reads the configuration from an arbitrary source, so that a test
// does not have to mutate the process environment.
func LoadFrom(lookup func(string) (string, bool)) (Config, error) {
	l := &loader{lookup: lookup}
	config := Config{
		ProxyListenAddress:     l.text("LISTEN_ADDRESS", "0.0.0.0:8443"),
		ConnectorListenAddress: l.text("CONNECTOR_LISTEN_ADDRESS", "0.0.0.0:8444"),
		AdminListenAddress:     l.text("ADMIN_LISTEN_ADDRESS", "127.0.0.1:8445"),

		InternalSuffix:      l.text("INTERNAL_SUFFIX", "internal.invalid"),
		HostHeaderMode:      l.enum("HOST_HEADER_MODE", "upstream", "upstream", "original"),
		ForwardedHeaderMode: l.enum("FORWARDED_HEADER_MODE", "standard", "standard", "none"),
		StreamMaxLifetime:   l.duration("STREAM_MAX_LIFETIME", 8*time.Hour),
		MaxRequestBodyBytes: l.bytes("MAX_REQUEST_BODY_BYTES", 8<<20),
		RelayBufferBytes:    l.number("RELAY_BUFFER_BYTES", 32<<10),

		RouteTTLMax:            l.duration("ROUTE_TTL_MAX", 8*time.Hour),
		MaxRoutesPerConnector:  l.number("MAX_ROUTES_PER_CONNECTOR", 10),
		MaxStreamsPerConnector: l.number("MAX_STREAMS_PER_CONNECTOR", 256),
		MaxStreamsPerRoute:     l.number("MAX_STREAMS_PER_ROUTE", 64),
		MaxStreamBytes:         l.bytes("MAX_STREAM_BYTES", 64<<20),
		StreamIdleTimeout:      l.duration("STREAM_IDLE_TIMEOUT", 60*time.Second),
		UpgradeIdleTimeout:     l.duration("UPGRADE_IDLE_TIMEOUT", 15*time.Minute),
		SweepInterval:          l.duration("SWEEP_INTERVAL", 5*time.Second),
		MaxDataChannelMessage:  l.number("MAX_DATA_CHANNEL_MESSAGE_BYTES", 64<<10),

		ConnectorCAFile: l.text("CONNECTOR_CA_FILE", ""),
		TLSCertFile:     l.text("TLS_CERT_FILE", ""),
		TLSKeyFile:      l.text("TLS_KEY_FILE", ""),

		IdentitySource:    l.enum("IDENTITY_SOURCE", "subject_common_name", "subject_common_name", "uri_san"),
		IdentityURIPrefix: l.text("IDENTITY_URI_PREFIX", "reviewplane:connector:"),

		LogLevel:  l.enum("LOG_LEVEL", "info", "debug", "info", "warn", "error"),
		LogFormat: l.enum("LOG_FORMAT", "json", "json", "text"),
	}

	config.DestinationPolicy = l.destinationPolicy()
	if config.DestinationPolicy.AllowNonLoopback {
		config.WidenedDestinationScope = append(config.WidenedDestinationScope, "non_loopback_destinations")
	}
	if config.DestinationPolicy.AllowLinkLocal {
		config.WidenedDestinationScope = append(config.WidenedDestinationScope, "link_local_destinations")
	}

	config.AdminToken = l.secret("ADMIN_TOKEN")
	if len(config.AdminToken) < 32 {
		l.problems = append(l.problems, Prefix+"ADMIN_TOKEN must be at least 32 characters")
	}
	config.CapabilityKeys = l.capabilityKeys()

	if len(l.problems) > 0 {
		return Config{}, errors.New("config: " + strings.Join(l.problems, "; "))
	}
	return config, nil
}

func (l *loader) raw(name string) (string, bool) { return l.lookup(Prefix + name) }

func (l *loader) text(name, fallback string) string {
	if value, ok := l.raw(name); ok && strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return fallback
}

func (l *loader) enum(name, fallback string, allowed ...string) string {
	value := l.text(name, fallback)
	for _, candidate := range allowed {
		if value == candidate {
			return value
		}
	}
	l.problems = append(l.problems, Prefix+name+" must be one of "+strings.Join(allowed, ", "))
	return fallback
}

func (l *loader) number(name string, fallback int) int {
	value, ok := l.raw(name)
	if !ok || strings.TrimSpace(value) == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed <= 0 {
		l.problems = append(l.problems, Prefix+name+" must be a positive integer")
		return fallback
	}
	return parsed
}

func (l *loader) bytes(name string, fallback int64) int64 {
	value, ok := l.raw(name)
	if !ok || strings.TrimSpace(value) == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil || parsed <= 0 {
		l.problems = append(l.problems, Prefix+name+" must be a positive number of bytes")
		return fallback
	}
	return parsed
}

func (l *loader) duration(name string, fallback time.Duration) time.Duration {
	value, ok := l.raw(name)
	if !ok || strings.TrimSpace(value) == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(strings.TrimSpace(value))
	if err != nil || parsed <= 0 {
		l.problems = append(l.problems, Prefix+name+" must be a positive duration such as 30s or 8h")
		return fallback
	}
	return parsed
}

func (l *loader) boolean(name string, fallback bool) bool {
	value, ok := l.raw(name)
	if !ok || strings.TrimSpace(value) == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(strings.TrimSpace(value))
	if err != nil {
		l.problems = append(l.problems, Prefix+name+" must be true or false")
		return fallback
	}
	return parsed
}

// secret reads a value, preferring the *_FILE form of docs/CONFIGURATION.md
// section 7 so that the material never has to sit in an environment variable.
func (l *loader) secret(name string) string {
	if path, ok := l.raw(name + "_FILE"); ok && strings.TrimSpace(path) != "" {
		contents, err := os.ReadFile(strings.TrimSpace(path))
		if err != nil {
			l.problems = append(l.problems, Prefix+name+"_FILE cannot be read")
			return ""
		}
		return strings.TrimSpace(string(contents))
	}
	if value, ok := l.raw(name); ok {
		return strings.TrimSpace(value)
	}
	l.problems = append(l.problems, Prefix+name+" or "+Prefix+name+"_FILE must be set")
	return ""
}

func (l *loader) destinationPolicy() policy.Policy {
	built := policy.Policy{
		AllowNonLoopback: l.boolean("ALLOW_NON_LOOPBACK_DESTINATIONS", false),
		AllowLinkLocal:   l.boolean("ALLOW_LINK_LOCAL_DESTINATIONS", false),
	}
	hosts, err := policy.ParseHosts(l.text("ALLOWED_HOSTS", "127.0.0.1,::1"))
	if err != nil {
		l.problems = append(l.problems, Prefix+"ALLOWED_HOSTS: "+err.Error())
	} else {
		built.AllowedHosts = hosts
	}
	ports, err := policy.ParsePortRanges(l.text("ALLOWED_PORTS", "3000-3999,4321,5173"))
	if err != nil {
		l.problems = append(l.problems, Prefix+"ALLOWED_PORTS: "+err.Error())
	} else {
		built.AllowedPorts = ports
	}
	for _, name := range strings.Split(l.text("ALLOWED_PROTOCOLS", "http"), ",") {
		name = strings.TrimSpace(name)
		switch connectorv1.DestinationProtocol(name) {
		case connectorv1.DestinationProtocolHTTP, connectorv1.DestinationProtocolHTTPS:
			built.AllowedProtocols = append(built.AllowedProtocols, connectorv1.DestinationProtocol(name))
		case "":
		default:
			l.problems = append(l.problems, Prefix+"ALLOWED_PROTOCOLS names an unknown protocol "+name)
		}
	}
	if len(built.AllowedProtocols) == 0 {
		l.problems = append(l.problems, Prefix+"ALLOWED_PROTOCOLS must name at least one protocol")
	}
	return built
}

// capabilityKeys reads "key-id:base64,key-id:base64". Several keys are accepted
// so that the control plane can rotate its signing key without invalidating
// capabilities already in a browser's hands.
func (l *loader) capabilityKeys() connectorv1.CapabilityKeyring {
	raw := l.secret("CAPABILITY_KEYS")
	keyring := connectorv1.CapabilityKeyring{}
	for _, entry := range strings.Split(raw, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		keyID, encoded, found := strings.Cut(entry, ":")
		if !found {
			l.problems = append(l.problems, Prefix+"CAPABILITY_KEYS entries must be key-id:base64")
			continue
		}
		key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
		if err != nil {
			l.problems = append(l.problems, Prefix+"CAPABILITY_KEYS holds a value that is not base64")
			continue
		}
		if len(key) < connectorv1.MinCapabilitySigningKeyBytes {
			l.problems = append(l.problems, Prefix+"CAPABILITY_KEYS holds a key shorter than "+
				strconv.Itoa(connectorv1.MinCapabilitySigningKeyBytes)+" bytes")
			continue
		}
		keyring[strings.TrimSpace(keyID)] = key
	}
	if len(keyring) == 0 {
		l.problems = append(l.problems, Prefix+"CAPABILITY_KEYS must hold at least one signing key")
	}
	return keyring
}
