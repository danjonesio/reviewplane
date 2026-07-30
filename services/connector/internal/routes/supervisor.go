package routes

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/danjonesio/reviewplane/services/connector/internal/backoff"
	"github.com/danjonesio/reviewplane/services/connector/internal/config"
	"github.com/danjonesio/reviewplane/services/connector/internal/identity"
	"github.com/danjonesio/reviewplane/services/connector/internal/transport"
)

// ReconnectPolicy bounds data-channel retries.
type ReconnectPolicy struct {
	Initial time.Duration
	Max     time.Duration
	Factor  float64
	Jitter  float64
}

// SupervisorOptions configures the data-channel supervisor.
type SupervisorOptions struct {
	Store     *identity.Store
	Config    *config.Config
	Logger    *slog.Logger
	Reconnect ReconnectPolicy
	// DialTimeout bounds one loopback dial to the development service.
	DialTimeout time.Duration
	// HandshakeTimeout bounds the outbound dial to the gateway.
	HandshakeTimeout time.Duration
}

// SuperviseDataChannel keeps the outbound data channel open until ctx ends.
//
// It is a separate supervisor from the control channel because the two
// connections have different lifetimes and different peers: the control channel
// reaches the control plane, the data channel reaches the tunnel gateway, and
// one restarting is not a reason to drop the other. Both are outbound; neither
// listens (ADR-0002).
//
// A refusal that names a terminal error class stops the loop, for the same
// reason the control channel stops: docs/CONNECTOR_PROTOCOL.md section 18
// forbids retrying with a credential the far side has just refused.
func (m *Manager) SuperviseDataChannel(ctx context.Context, options SupervisorOptions) {
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	policy := backoff.Policy{
		Initial: options.Reconnect.Initial,
		Max:     options.Reconnect.Max,
		Factor:  options.Reconnect.Factor,
		Jitter:  options.Reconnect.Jitter,
	}

	// The attempt counter bounds consecutive failures rather than the connector's
	// lifetime: a channel that stayed up longer than the longest backoff delay
	// ends the incident, and the next failure starts a new one. The window is the
	// maximum delay rather than "it connected at all", so a gateway that accepts
	// a channel and drops it immediately is still backed off from.
	attempt := 0
	for ctx.Err() == nil {
		attempt++
		uptime, err := m.serveOnce(ctx, options, logger)
		if err == nil || ctx.Err() != nil {
			return
		}
		failure := transport.Classify(err)
		if failure.Terminal {
			logger.Error("data channel refused; not retrying with this identity",
				slog.String("error_class", string(failure.Class)),
				slog.String("error", failure.Err.Error()),
			)
			return
		}
		if policy.Max > 0 && uptime >= policy.Max {
			attempt = 1
		}
		delay, sleepErr := policy.Sleep(ctx, attempt)
		logger.Warn("data channel lost; reconnecting",
			slog.Int("attempt", attempt),
			slog.String("error_class", string(failure.Class)),
			slog.String("error", failure.Err.Error()),
			slog.Duration("retry_in", delay),
		)
		if sleepErr != nil {
			return
		}
	}
}

// serveOnce runs one data channel and reports how long it was up, so that the
// supervisor can tell a failed dial from a channel that worked for a while and
// then dropped.
func (m *Manager) serveOnce(
	ctx context.Context,
	options SupervisorOptions,
	_ *slog.Logger,
) (time.Duration, error) {
	if !options.Store.Enrolled() {
		return 0, errors.New("routes: this environment holds no connector identity")
	}
	record, err := options.Store.LoadRecord()
	if err != nil {
		return 0, err
	}
	clientCertificate, _, err := options.Store.ClientCertificate()
	if err != nil {
		return 0, err
	}
	tlsConfig, err := transport.NewTLSConfig(transport.TLSOptions{
		CAFile:            options.Config.ControlPlane.TLS.CAFile,
		ClientCertificate: &clientCertificate,
	})
	if err != nil {
		return 0, err
	}
	var establishedAt time.Time
	err = m.ServeDataChannel(ctx, DataChannelOptions{
		Endpoint:         record.DataURL,
		ConnectorID:      record.ConnectorID,
		TLSConfig:        tlsConfig,
		HandshakeTimeout: options.HandshakeTimeout,
		DialTimeout:      options.DialTimeout,
		OnEstablished:    func() { establishedAt = time.Now() },
	})
	if establishedAt.IsZero() {
		return 0, err
	}
	return time.Since(establishedAt), err
}
