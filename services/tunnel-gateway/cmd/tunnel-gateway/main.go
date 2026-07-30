// Command tunnel-gateway runs the ReviewPlane tunnel gateway.
//
// It serves three listeners, and the separation between them is the point:
//
//   - the proxy listener answers browser requests for internal origins, and is
//     the only one a deployment publishes;
//   - the connector listener terminates connector data channels over mutually
//     authenticated TLS;
//   - the admin listener serves the control API and metrics, and defaults to
//     loopback.
//
// Responsibilities are docs/ARCHITECTURE.md section 4.6. What it deliberately
// cannot do is act as a proxy for anything but a registered route: there is no
// CONNECT handler, no SOCKS listener and no code path that takes a destination
// from a request (docs/SECURITY.md section 9).
package main

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/danjonesio/reviewplane/services/tunnel-gateway/datachannel"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/internal/config"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/internal/gatewayhttp"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/internal/registry"
)

func main() {
	if err := run(); err != nil {
		slog.Error("tunnel gateway failed to start", slog.String("error", err.Error()))
		os.Exit(1)
	}
}

func run() error {
	settings, err := config.Load()
	if err != nil {
		return err
	}
	logger := newLogger(settings)

	if len(settings.WidenedDestinationScope) > 0 {
		// docs/CONFIGURATION.md section 4: nothing widens the tunnel without an
		// explicit high-risk mode and a warning.
		logger.Warn("the destination policy has been widened beyond loopback",
			slog.Any("widened", settings.WidenedDestinationScope))
	}

	gateway, err := gatewayhttp.New(gatewayhttp.Config{
		Proxy: gatewayhttp.ProxyConfig{
			InternalSuffix:      settings.InternalSuffix,
			HostHeader:          gatewayhttp.HostHeaderMode(settings.HostHeaderMode),
			Forwarded:           gatewayhttp.ForwardedHeaderMode(settings.ForwardedHeaderMode),
			StreamMaxLifetime:   settings.StreamMaxLifetime,
			MaxRequestBodyBytes: settings.MaxRequestBodyBytes,
			MaxStreamsPerRoute:  settings.MaxStreamsPerRoute,
			RelayBufferBytes:    settings.RelayBufferBytes,
		},
		Admin: gatewayhttp.AdminConfig{
			Token:          settings.AdminToken,
			InternalSuffix: settings.InternalSuffix,
		},
		Registry: registry.Config{
			Policy:                settings.DestinationPolicy,
			MaxRoutesPerConnector: settings.MaxRoutesPerConnector,
			MaxRouteTTL:           settings.RouteTTLMax,
		},
		Session: datachannel.SessionConfig{
			MaxStreams:         settings.MaxStreamsPerConnector,
			MaxStreamBytes:     settings.MaxStreamBytes,
			IdleTimeout:        settings.StreamIdleTimeout,
			UpgradeIdleTimeout: settings.UpgradeIdleTimeout,
		},
		Identity: gatewayhttp.IdentityPolicy{
			Source:    gatewayhttp.IdentitySource(settings.IdentitySource),
			URIPrefix: settings.IdentityURIPrefix,
		},
		Keyring:                    settings.CapabilityKeys,
		SweepInterval:              settings.SweepInterval,
		MaxDataChannelMessageBytes: settings.MaxDataChannelMessage,
	}, logger)
	if err != nil {
		return err
	}

	connectorTLS, err := connectorTLSConfig(settings)
	if err != nil {
		return err
	}

	// docs/ARCHITECTURE.md section 7.3 gives the browser an https origin, so the
	// browser-facing listener terminates TLS with the same certificate the
	// connector listener uses. A deployment that terminates TLS in front of the
	// gateway leaves the certificate settings unset and gets a plain listener;
	// the connector listener still requires them, because mutual TLS there is
	// not something a front end can stand in for.
	proxyTLS, err := proxyTLSConfig(settings)
	if err != nil {
		return err
	}
	proxy := &http.Server{
		Addr:              settings.ProxyListenAddress,
		Handler:           gateway.ProxyHandler(),
		TLSConfig:         proxyTLS,
		ReadHeaderTimeout: 10 * time.Second,
	}
	connector := &http.Server{
		Addr:              settings.ConnectorListenAddress,
		Handler:           gateway.ConnectorHandler(),
		TLSConfig:         connectorTLS,
		ReadHeaderTimeout: 10 * time.Second,
	}
	admin := &http.Server{
		Addr:              settings.AdminListenAddress,
		Handler:           gateway.AdminHandler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go gateway.Run()
	failures := make(chan error, 3)
	if proxyTLS == nil {
		go serve(failures, proxy.ListenAndServe)
	} else {
		go serve(failures, func() error { return proxy.ListenAndServeTLS("", "") })
	}
	go serve(failures, func() error { return connector.ListenAndServeTLS("", "") })
	go serve(failures, admin.ListenAndServe)

	logger.Info("tunnel gateway listening",
		slog.String("proxy", settings.ProxyListenAddress),
		slog.String("connector", settings.ConnectorListenAddress),
		slog.String("admin", settings.AdminListenAddress),
		slog.String("internal_suffix", settings.InternalSuffix),
		slog.Bool("proxy_tls", proxyTLS != nil),
	)

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	select {
	case err := <-failures:
		gateway.Shutdown()
		return err
	case <-signals:
		logger.Info("tunnel gateway shutting down")
		gateway.Shutdown()
		_ = proxy.Close()
		_ = connector.Close()
		_ = admin.Close()
		return nil
	}
}

func serve(failures chan<- error, listen func() error) {
	if err := listen(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		failures <- err
	}
}

// proxyTLSConfig builds the browser-facing listener's TLS configuration, or
// returns nil when no certificate is configured and TLS is terminated in front.
func proxyTLSConfig(settings config.Config) (*tls.Config, error) {
	if settings.TLSCertFile == "" || settings.TLSKeyFile == "" {
		return nil, nil
	}
	certificate, err := tls.LoadX509KeyPair(settings.TLSCertFile, settings.TLSKeyFile)
	if err != nil {
		return nil, err
	}
	// No client certificate is requested here: the browser worker authenticates
	// with a route capability, not with an identity, and asking for one would
	// be a second authentication scheme with nothing behind it.
	return &tls.Config{
		Certificates: []tls.Certificate{certificate},
		MinVersion:   tls.VersionTLS12,
	}, nil
}

func connectorTLSConfig(settings config.Config) (*tls.Config, error) {
	if settings.TLSCertFile == "" || settings.TLSKeyFile == "" || settings.ConnectorCAFile == "" {
		return nil, errors.New("config: the connector listener needs " + config.Prefix + "TLS_CERT_FILE, " +
			config.Prefix + "TLS_KEY_FILE and " + config.Prefix + "CONNECTOR_CA_FILE")
	}
	certificate, err := tls.LoadX509KeyPair(settings.TLSCertFile, settings.TLSKeyFile)
	if err != nil {
		return nil, err
	}
	authority, err := os.ReadFile(settings.ConnectorCAFile)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(authority) {
		return nil, errors.New("config: " + config.Prefix + "CONNECTOR_CA_FILE holds no certificate")
	}
	return gatewayhttp.TLSConfig(certificate, pool), nil
}

func newLogger(settings config.Config) *slog.Logger {
	level := slog.LevelInfo
	switch settings.LogLevel {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}
	options := &slog.HandlerOptions{Level: level}
	if settings.LogFormat == "text" {
		return slog.New(slog.NewTextHandler(os.Stdout, options))
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, options))
}
