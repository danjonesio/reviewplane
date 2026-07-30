// Package transport builds the connector's outbound TLS configuration and
// classifies connection failures into the stable error classes of
// docs/CONNECTOR_PROTOCOL.md section 21.
//
// Every connection this package configures is outbound and TLS-protected. The
// connector never opens a listening socket for control or data purposes, which
// is the mechanism behind the Stage 0 exit criterion "No public inbound port is
// required on the development VM" (docs/ROADMAP.md section 2, ADR-0002).
package transport

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"slices"

	connectorv1 "github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/connector/internal/ws"
)

// TLSOptions configures an outbound connection.
type TLSOptions struct {
	// CAFile is an additional trust anchor for the control-plane server
	// certificate. Empty uses the system trust store.
	CAFile string
	// ClientCertificate is the signed device identity. It is absent during
	// enrolment, because the identity is what enrolment establishes, and
	// present on every connection afterwards
	// (docs/SECURITY.md section 6.2 step 5).
	ClientCertificate *tls.Certificate
}

// NewTLSConfig builds the outbound TLS configuration. Certificate verification
// is never disabled: there is no configuration setting that turns it off,
// because docs/SECURITY.md section 5 requires safe failure when identity is
// uncertain.
func NewTLSConfig(options TLSOptions) (*tls.Config, error) {
	config := &tls.Config{MinVersion: tls.VersionTLS12}
	if options.CAFile != "" {
		pemBytes, err := os.ReadFile(options.CAFile) // #nosec G304 -- operator-supplied trust anchor
		if err != nil {
			return nil, fmt.Errorf("transport: reading control-plane trust anchor %s: %w", options.CAFile, err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pemBytes) {
			return nil, fmt.Errorf("transport: %s contains no PEM certificate", options.CAFile)
		}
		config.RootCAs = pool
	}
	if options.ClientCertificate != nil {
		config.Certificates = []tls.Certificate{*options.ClientCertificate}
	}
	return config, nil
}

// Failure is a classified connector failure.
type Failure struct {
	// Class is the stable error class reported to the operator. It is empty
	// when the failure has no section 21 class.
	Class connectorv1.ErrorClass
	// Terminal reports that retrying with the current credential cannot
	// succeed. docs/CONNECTOR_PROTOCOL.md section 18 forbids reusing a revoked
	// credential, so a terminal failure stops the reconnect loop rather than
	// retrying quietly.
	Terminal bool
	Err      error
}

func (f *Failure) Error() string {
	if f.Class == "" {
		return f.Err.Error()
	}
	return string(f.Class) + ": " + f.Err.Error()
}

func (f *Failure) Unwrap() error { return f.Err }

// terminalClasses are the refusals no retry can resolve.
var terminalClasses = []connectorv1.ErrorClass{
	connectorv1.ErrorClassEnrolmentTokenInvalid,
	connectorv1.ErrorClassIdentityRevoked,
	connectorv1.ErrorClassProtocolUnsupported,
	connectorv1.ErrorClassUpgradeRequired,
}

// IsKnownErrorClass reports whether text is one of the section 21 classes. The
// list is generated from packages/protocol, so a class added to the schema is
// recognised here without a code change.
func IsKnownErrorClass(text string) bool {
	return slices.Contains(connectorv1.ErrorClassValues, connectorv1.ErrorClass(text))
}

// Classify turns a connection failure into a Failure.
//
// The control plane refuses a connector by closing the WebSocket with a
// policy-violation code and a reason equal to a section 21 error class. That
// keeps the refusal vocabulary identical to the one the schema already defines
// for both languages, without inventing a message type the protocol does not
// have.
func Classify(err error) *Failure {
	if err == nil {
		return nil
	}
	var failure *Failure
	if errors.As(err, &failure) {
		return failure
	}

	var closeErr *ws.CloseError
	if errors.As(err, &closeErr) {
		if IsKnownErrorClass(closeErr.Reason) {
			class := connectorv1.ErrorClass(closeErr.Reason)
			return &Failure{
				Class:    class,
				Terminal: slices.Contains(terminalClasses, class),
				Err:      err,
			}
		}
		// A close without a recognised class is a transport event, not a
		// refusal: the channel is simply unavailable and reconnect applies.
		return &Failure{Class: connectorv1.ErrorClassControlPlaneUnavailable, Err: err}
	}

	var handshake *ws.HandshakeError
	if errors.As(err, &handshake) {
		if IsKnownErrorClass(handshake.Body) {
			class := connectorv1.ErrorClass(handshake.Body)
			return &Failure{
				Class:    class,
				Terminal: slices.Contains(terminalClasses, class),
				Err:      err,
			}
		}
		return &Failure{Class: connectorv1.ErrorClassControlPlaneUnavailable, Err: err}
	}

	var protocolErr *connectorv1.ProtocolError
	if errors.As(err, &protocolErr) {
		return &Failure{Class: protocolErr.ErrorClass, Err: err}
	}

	return &Failure{Class: connectorv1.ErrorClassControlPlaneUnavailable, Err: err}
}
