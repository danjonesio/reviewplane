// Package testca issues throwaway connector identities for tests.
//
// The real Stage 0 certificate authority belongs to the control plane's
// enrolment flow (docs/CONNECTOR_PROTOCOL.md section 4, docs/SECURITY.md
// section 6.2): the connector generates a key pair locally and exchanges its
// enrolment token and public key for a signed device identity. The gateway is
// only ever a verifier, so it can be tested against any authority whose root it
// is given.
//
// That is what this package supplies: an in-memory authority, a server
// certificate for the connector listener and client certificates carrying a
// connector identifier. It exists so that the gateway's identity tests do not
// wait on the issuing side, and so that they exercise the real verification
// path rather than a stub. It is a test package and is never linked into the
// binary.
package testca

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"net/url"
	"testing"
	"time"
)

// Authority is a throwaway certificate authority.
type Authority struct {
	certificate *x509.Certificate
	key         *ecdsa.PrivateKey
	name        string
}

// New builds an authority.
func New(t *testing.T, name string) *Authority {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate authority key: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber:          serial(t),
		Subject:               pkix.Name{CommonName: name},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create authority certificate: %v", err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse authority certificate: %v", err)
	}
	return &Authority{certificate: certificate, key: key, name: name}
}

// Pool is the root pool a verifier is configured with.
func (a *Authority) Pool() *x509.CertPool {
	pool := x509.NewCertPool()
	pool.AddCert(a.certificate)
	return pool
}

// ServerCertificate issues a certificate for the connector listener.
func (a *Authority) ServerCertificate(t *testing.T, hosts ...string) tls.Certificate {
	t.Helper()
	template := &x509.Certificate{
		SerialNumber: serial(t),
		Subject:      pkix.Name{CommonName: "tunnel-gateway"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	for _, host := range hosts {
		if address := net.ParseIP(host); address != nil {
			template.IPAddresses = append(template.IPAddresses, address)
			continue
		}
		template.DNSNames = append(template.DNSNames, host)
	}
	return a.issue(t, template)
}

// ConnectorCertificate issues a client certificate whose subject common name is
// the connector identifier, which is the gateway's default identity source.
func (a *Authority) ConnectorCertificate(t *testing.T, connectorID string) tls.Certificate {
	t.Helper()
	return a.issue(t, &x509.Certificate{
		SerialNumber: serial(t),
		Subject:      pkix.Name{CommonName: connectorID},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	})
}

// ConnectorCertificateWithURI issues a client certificate carrying the
// connector identifier in a URI subject alternative name, the gateway's
// alternative identity source.
func (a *Authority) ConnectorCertificateWithURI(t *testing.T, prefix, connectorID string) tls.Certificate {
	t.Helper()
	uri, err := url.Parse(prefix + connectorID)
	if err != nil {
		t.Fatalf("parse connector URI: %v", err)
	}
	return a.issue(t, &x509.Certificate{
		SerialNumber: serial(t),
		Subject:      pkix.Name{CommonName: "connector"},
		URIs:         []*url.URL{uri},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	})
}

func (a *Authority) issue(t *testing.T, template *x509.Certificate) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	der, err := x509.CreateCertificate(rand.Reader, template, a.certificate, &key.PublicKey, a.key)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	return tls.Certificate{Certificate: [][]byte{der, a.certificate.Raw}, PrivateKey: key}
}

func serial(t *testing.T) *big.Int {
	t.Helper()
	value, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 96))
	if err != nil {
		t.Fatalf("generate serial: %v", err)
	}
	return value
}
