package gatewayhttp

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"strings"
)

// Connector identity for the data channel.
//
// docs/ARCHITECTURE.md section 11 fixes connector authentication as a device
// key pair, an issued client certificate and a mutually authenticated channel.
// The certificate is issued by the control plane's Stage 0 certificate
// authority; the gateway is only a verifier. So the gateway holds the
// authority's root, requires a client certificate that chains to it, and
// derives the connector identifier from the verified certificate.
//
// Where the identifier is read from is configuration rather than a constant,
// because the issuing side is being built separately: a deployment that puts
// the connector identifier in a URI subject alternative name and one that puts
// it in the subject common name are both served without changing this code.
// The default is the common name.

// IdentitySource names the certificate field carrying the connector identifier.
type IdentitySource string

const (
	// IdentityFromCommonName reads the subject common name. Default.
	IdentityFromCommonName IdentitySource = "subject_common_name"
	// IdentityFromURISAN reads a URI subject alternative name whose scheme
	// matches the configured prefix, and takes the remainder as the identifier.
	IdentityFromURISAN IdentitySource = "uri_san"
)

// IdentityPolicy configures how a verified certificate becomes a connector
// identifier.
type IdentityPolicy struct {
	Source IdentitySource
	// URIPrefix is the required prefix when Source is IdentityFromURISAN, for
	// example "reviewplane:connector:".
	URIPrefix string
}

func (p IdentityPolicy) withDefaults() IdentityPolicy {
	if p.Source == "" {
		p.Source = IdentityFromCommonName
	}
	if p.URIPrefix == "" {
		p.URIPrefix = "reviewplane:connector:"
	}
	return p
}

// ErrNoClientCertificate reports a channel that presented no verified client
// certificate. It is a distinct error because it is the difference between an
// unauthenticated caller and a caller with the wrong identity, and both must be
// refused but only one is worth alerting on.
var ErrNoClientCertificate = errors.New("gatewayhttp: no verified client certificate")

// ConnectorIdentity derives the connector identifier from a completed TLS
// handshake.
//
// It reads VerifiedChains rather than PeerCertificates: PeerCertificates is
// what the peer sent, VerifiedChains is what chained to the configured
// authority. Reading the former would authenticate anyone able to produce a
// certificate.
func ConnectorIdentity(state tls.ConnectionState, policy IdentityPolicy) (string, error) {
	policy = policy.withDefaults()
	if len(state.VerifiedChains) == 0 || len(state.VerifiedChains[0]) == 0 {
		return "", ErrNoClientCertificate
	}
	certificate := state.VerifiedChains[0][0]
	switch policy.Source {
	case IdentityFromURISAN:
		return identityFromURI(certificate, policy.URIPrefix)
	case IdentityFromCommonName:
		fallthrough
	default:
		name := strings.TrimSpace(certificate.Subject.CommonName)
		if name == "" {
			return "", errors.New("gatewayhttp: certificate subject carries no common name")
		}
		if !isOpaqueIdentifier(name) {
			return "", errors.New("gatewayhttp: certificate common name is not an identifier")
		}
		return name, nil
	}
}

func identityFromURI(certificate *x509.Certificate, prefix string) (string, error) {
	for _, uri := range certificate.URIs {
		text := uri.String()
		if !strings.HasPrefix(text, prefix) {
			continue
		}
		identifier := strings.TrimPrefix(text, prefix)
		if !isOpaqueIdentifier(identifier) {
			return "", errors.New("gatewayhttp: certificate URI does not carry an identifier")
		}
		return identifier, nil
	}
	return "", errors.New("gatewayhttp: certificate carries no connector URI")
}

// isOpaqueIdentifier applies the schema's identifier bound: length and
// character class only, never a prefix (docs/DOMAIN_MODEL.md section 3).
func isOpaqueIdentifier(candidate string) bool {
	if len(candidate) == 0 || len(candidate) > 64 {
		return false
	}
	for index := 0; index < len(candidate); index++ {
		character := candidate[index]
		switch {
		case character >= 'a' && character <= 'z':
		case character >= 'A' && character <= 'Z':
		case character >= '0' && character <= '9':
		case character == '_' || character == '-':
		default:
			return false
		}
	}
	return true
}
