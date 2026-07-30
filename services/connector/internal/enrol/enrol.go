// Package enrol implements the enrolment exchange of
// docs/CONNECTOR_PROTOCOL.md section 4 and docs/SECURITY.md section 6.2.
//
// The order of steps is a security property. The key pair is generated locally
// first, so that the private key exists only on the development VM. Only the
// public half is ever encoded: the protocol has no field capable of carrying a
// private key. The enrolment token is the single moment a bearer credential is
// used; every later connection presents the issued identity instead.
package enrol

import (
	"context"
	"crypto/ecdsa"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	connectorv1 "github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/connector/internal/backoff"
	"github.com/danjonesio/reviewplane/services/connector/internal/buildinfo"
	"github.com/danjonesio/reviewplane/services/connector/internal/config"
	"github.com/danjonesio/reviewplane/services/connector/internal/hostinfo"
	"github.com/danjonesio/reviewplane/services/connector/internal/identity"
	"github.com/danjonesio/reviewplane/services/connector/internal/logging"
	"github.com/danjonesio/reviewplane/services/connector/internal/protocolio"
	"github.com/danjonesio/reviewplane/services/connector/internal/transport"
	"github.com/danjonesio/reviewplane/services/connector/internal/ws"
)

// ExchangeTimeout bounds one enrolment attempt end to end.
const ExchangeTimeout = 30 * time.Second

// Options configures one enrolment run.
type Options struct {
	Config *config.Config
	// Token is the one-time enrolment token. It is held as the schema's
	// sensitive type so that no log, debug or JSON representation can print it.
	Token connectorv1.EnrolmentToken
	// Force re-enrols an environment that already holds an identity.
	// docs/CONNECTOR_PROTOCOL.md section 18: re-enrolment creates a new
	// connector identity, so a new key pair is generated.
	Force bool
	// MaxAttempts bounds transport retries. Zero uses the reconnect policy's
	// bound, or three attempts when that is unbounded.
	MaxAttempts int
	Logger      *slog.Logger
}

// Result reports a completed enrolment.
type Result struct {
	ConnectorID            string
	CertificateFingerprint string
	ExpiresAt              time.Time
	ControlURL             string
	DataURL                string
	// ReusedKey reports that an existing device key was reused because a
	// previous attempt was interrupted after key generation.
	ReusedKey bool
}

// ErrAlreadyEnrolled reports an environment that already holds an identity.
var ErrAlreadyEnrolled = errors.New("enrol: this environment already holds a connector identity; pass --force to re-enrol with a new identity")

// Run performs the enrolment exchange, retrying only transport failures.
func Run(ctx context.Context, options Options) (*Result, error) {
	cfg := options.Config
	logger := options.Logger
	correlationID := logging.NewCorrelationID("cor_")
	logger = logger.With(slog.String("correlation_id", correlationID))

	endpoint, err := cfg.EnrolmentURL()
	if err != nil {
		return nil, err
	}

	store := identity.NewStore(cfg.Identity.DataDir)
	if store.Enrolled() && !options.Force {
		return nil, ErrAlreadyEnrolled
	}
	if err := store.EnsureDir(); err != nil {
		return nil, err
	}

	var (
		key    *ecdsa.PrivateKey
		reused bool
	)
	if options.Force {
		if err := store.Remove(); err != nil {
			return nil, err
		}
		key, err = store.GenerateKey()
	} else {
		key, reused, err = store.LoadOrGenerateKey()
	}
	if err != nil {
		return nil, err
	}
	publicKey, err := identity.PublicKeyBase64(key)
	if err != nil {
		return nil, err
	}

	logger.Info("enrolment started",
		slog.String("control_plane", cfg.ControlPlane.URL.String()),
		slog.String("endpoint", endpoint),
		slog.String("environment_name", cfg.Environment.Name),
		slog.Bool("reused_existing_device_key", reused),
	)

	attempts := options.MaxAttempts
	if attempts <= 0 {
		attempts = cfg.Reconnect.MaxAttempts
	}
	if attempts <= 0 {
		attempts = 3
	}
	policy := backoff.Policy{
		Initial: cfg.Reconnect.InitialDelay,
		Max:     cfg.Reconnect.MaxDelay,
		Factor:  cfg.Reconnect.Factor,
		Jitter:  cfg.Reconnect.Jitter,
	}

	var lastFailure *transport.Failure
	for attempt := 1; attempt <= attempts; attempt++ {
		response, err := exchange(ctx, cfg, endpoint, options.Token, publicKey, logger)
		if err == nil {
			result, err := persist(store, key, cfg, response)
			if err != nil {
				return nil, err
			}
			result.ReusedKey = reused
			logger.Info("enrolment completed",
				slog.String("connector_id", result.ConnectorID),
				slog.String("certificate_fingerprint", result.CertificateFingerprint),
				slog.Time("identity_expires_at", result.ExpiresAt),
				slog.String("control_url", result.ControlURL),
			)
			return result, nil
		}
		failure := transport.Classify(err)
		lastFailure = failure
		if failure.Terminal || ctx.Err() != nil {
			return nil, failure
		}
		logger.Warn("enrolment attempt failed",
			slog.Int("attempt", attempt),
			slog.String("error_class", string(failure.Class)),
			slog.String("error", failure.Err.Error()),
		)
		if attempt == attempts {
			break
		}
		if _, err := policy.Sleep(ctx, attempt); err != nil {
			return nil, failure
		}
	}
	if lastFailure == nil {
		lastFailure = &transport.Failure{
			Class: connectorv1.ErrorClassControlPlaneUnavailable,
			Err:   errors.New("enrolment made no attempt"),
		}
	}
	return nil, fmt.Errorf("enrolment failed after %d attempts: %w", attempts, lastFailure)
}

// exchange performs one registration request and reads the response.
func exchange(
	ctx context.Context,
	cfg *config.Config,
	endpoint string,
	token connectorv1.EnrolmentToken,
	publicKey string,
	logger *slog.Logger,
) (*connectorv1.RegistrationResponse, error) {
	attemptCtx, cancel := context.WithTimeout(ctx, ExchangeTimeout)
	defer cancel()

	tlsConfig, err := transport.NewTLSConfig(transport.TLSOptions{CAFile: cfg.ControlPlane.TLS.CAFile})
	if err != nil {
		return nil, err
	}

	request := connectorv1.RegistrationRequest{
		EnrolmentToken: token,
		PublicKey:      publicKey,
		Environment: connectorv1.EnvironmentDescriptor{
			Name:         cfg.Environment.Name,
			Platform:     hostinfo.Platform(),
			Architecture: hostinfo.Architecture(),
			Labels:       cfg.Environment.Labels,
		},
		Connector: connectorv1.ConnectorDescriptor{
			Version:      buildinfo.Version,
			Capabilities: buildinfo.Capabilities,
		},
	}
	// The registration exchange precedes identity assignment, so the envelope
	// carries no connector_id. The generated validator enforces that.
	frame, err := protocolio.NewFrame(request, "", time.Now())
	if err != nil {
		return nil, err
	}
	encoded, err := protocolio.Encode(frame)
	if err != nil {
		return nil, err
	}

	conn, err := ws.Dial(attemptCtx, endpoint, ws.DialOptions{
		TLSConfig:       tlsConfig,
		MaxMessageBytes: connectorv1.MaxControlFrameBytes,
		Header:          http.Header{"User-Agent": []string{buildinfo.UserAgent}},
	})
	if err != nil {
		return nil, err
	}
	defer func() { _ = conn.CloseNow() }()

	if deadline, ok := attemptCtx.Deadline(); ok {
		_ = conn.SetWriteDeadline(deadline)
		_ = conn.SetReadDeadline(deadline)
	}
	if err := conn.WriteText(encoded); err != nil {
		return nil, err
	}

	_, payload, err := conn.ReadMessage(attemptCtx)
	if err != nil {
		return nil, err
	}
	// Bounds, version, type and schema are checked by the generated decoder,
	// in that order, before any field is read.
	decoded, protocolErr := connectorv1.DecodeControlFrame(payload)
	if protocolErr != nil {
		logger.Warn("control plane sent a frame that does not satisfy the protocol",
			slog.String("reason", string(protocolErr.Reason)),
		)
		return nil, protocolErr
	}
	response, ok := decoded.Payload.(connectorv1.RegistrationResponse)
	if !ok {
		return nil, fmt.Errorf("enrol: expected %s, received %s",
			connectorv1.MessageTypeConnectorRegistrationResponse, decoded.Envelope.Type)
	}
	_ = conn.Close(ws.CloseNormalClosure, "")
	return &response, nil
}

func persist(
	store *identity.Store,
	key *ecdsa.PrivateKey,
	cfg *config.Config,
	response *connectorv1.RegistrationResponse,
) (*Result, error) {
	certificate, err := store.SaveCertificate(response.SignedIdentity.Certificate, key)
	if err != nil {
		return nil, err
	}
	der, err := base64.StdEncoding.DecodeString(response.SignedIdentity.Certificate)
	if err != nil {
		return nil, fmt.Errorf("enrol: issued certificate is not valid base64: %w", err)
	}
	if computed := identity.Fingerprint(der); computed != response.SignedIdentity.CertificateFingerprint {
		return nil, fmt.Errorf(
			"enrol: issued certificate fingerprint %s does not match the fingerprint the control plane reported",
			computed)
	}
	expiresAt, err := time.Parse(time.RFC3339, response.SignedIdentity.ExpiresAt)
	if err != nil {
		return nil, fmt.Errorf("enrol: identity expiry %q is not an RFC 3339 timestamp: %w",
			response.SignedIdentity.ExpiresAt, err)
	}
	if !certificate.NotAfter.UTC().Equal(expiresAt.UTC()) {
		return nil, fmt.Errorf(
			"enrol: issued certificate expires at %s but the registration response reports %s",
			certificate.NotAfter.UTC().Format(time.RFC3339), expiresAt.UTC().Format(time.RFC3339))
	}

	record := identity.Record{
		ConnectorID:            response.ConnectorID,
		CertificateFingerprint: response.SignedIdentity.CertificateFingerprint,
		ExpiresAt:              expiresAt,
		ControlURL:             response.ControlPlaneEndpoints.ControlURL,
		DataURL:                response.ControlPlaneEndpoints.DataURL,
		PolicyDigest:           response.PolicyDigest,
		EnrolledAt:             time.Now().UTC(),
		ControlPlaneURL:        cfg.ControlPlane.URL.String(),
	}
	if err := store.SaveRecord(record); err != nil {
		return nil, err
	}
	return &Result{
		ConnectorID:            record.ConnectorID,
		CertificateFingerprint: record.CertificateFingerprint,
		ExpiresAt:              record.ExpiresAt,
		ControlURL:             record.ControlURL,
		DataURL:                record.DataURL,
	}, nil
}
