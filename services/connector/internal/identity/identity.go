// Package identity owns the connector's device key pair and the signed identity
// issued in exchange for the enrolment token.
//
// docs/SECURITY.md section 6.2 requires that the private key is stored with
// operating-system permissions and never sent to the control plane, and
// docs/DEVELOPMENT.md section 10 requires that those permissions are validated.
// The connector refuses to start when the key file is readable by anyone but
// its owner: a key that another local account can read is not a device identity.
package identity

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// File names inside the identity data directory
// (docs/CONNECTOR_PROTOCOL.md section 20, identity.data_dir).
const (
	KeyFileName      = "device.key"
	CertFileName     = "device.crt"
	IdentityFileName = "identity.json"
)

// File modes. The key is owner-read/write only; the directory is owner-only.
const (
	KeyFileMode  os.FileMode = 0o600
	DataDirMode  os.FileMode = 0o700
	CertFileMode os.FileMode = 0o644
)

// Record is the persisted result of enrolment. It holds no private key
// material: the private key lives only in the key file.
type Record struct {
	ConnectorID            string    `json:"connector_id"`
	CertificateFingerprint string    `json:"certificate_fingerprint"`
	ExpiresAt              time.Time `json:"expires_at"`
	ControlURL             string    `json:"control_url"`
	DataURL                string    `json:"data_url"`
	PolicyDigest           string    `json:"policy_digest"`
	EnrolledAt             time.Time `json:"enrolled_at"`
	ControlPlaneURL        string    `json:"control_plane_url"`
}

// Store is the identity data directory.
type Store struct {
	dir string
}

// NewStore returns a store rooted at dir.
func NewStore(dir string) *Store { return &Store{dir: dir} }

// Dir reports the data directory.
func (s *Store) Dir() string { return s.dir }

// KeyPath is the private-key file.
func (s *Store) KeyPath() string { return filepath.Join(s.dir, KeyFileName) }

// CertPath is the issued certificate file.
func (s *Store) CertPath() string { return filepath.Join(s.dir, CertFileName) }

// RecordPath is the identity metadata file.
func (s *Store) RecordPath() string { return filepath.Join(s.dir, IdentityFileName) }

// EnsureDir creates the data directory with owner-only permissions.
func (s *Store) EnsureDir() error {
	if err := os.MkdirAll(s.dir, DataDirMode); err != nil {
		return fmt.Errorf("identity: creating %s: %w", s.dir, err)
	}
	info, err := os.Stat(s.dir)
	if err != nil {
		return fmt.Errorf("identity: reading %s: %w", s.dir, err)
	}
	// A pre-existing directory keeps whatever mode it had, so tighten it.
	if info.Mode().Perm()&0o077 != 0 {
		if err := os.Chmod(s.dir, DataDirMode); err != nil {
			return fmt.Errorf("identity: tightening permissions on %s: %w", s.dir, err)
		}
	}
	return nil
}

// PermissionError reports a key file that is readable or writable by anyone but
// its owner. It is deliberately a distinct type so that the startup path can
// report it as a refusal rather than as an unexpected error.
type PermissionError struct {
	Path   string
	Detail string
}

func (e *PermissionError) Error() string {
	return fmt.Sprintf("identity: refusing to use %s: %s", e.Path, e.Detail)
}

// CheckKeyPermissions validates the private-key file before it is used. It is
// called on every start, not only at enrolment.
func (s *Store) CheckKeyPermissions() error {
	path := s.KeyPath()
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return &PermissionError{Path: path, Detail: "the private key must be a regular file"}
	}
	if extra := info.Mode().Perm() & 0o077; extra != 0 {
		return &PermissionError{
			Path: path,
			Detail: fmt.Sprintf(
				"the private key has mode %#o and must be %#o: group and other permissions must be removed (docs/SECURITY.md section 6.2)",
				info.Mode().Perm(), KeyFileMode),
		}
	}
	return checkOwnership(path, info)
}

// GenerateKey creates a new device key pair and writes it with owner-only
// permissions. Re-enrolment creates a new identity
// (docs/CONNECTOR_PROTOCOL.md section 18), so it always replaces any existing
// key.
func (s *Store) GenerateKey() (*ecdsa.PrivateKey, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("identity: generating device key: %w", err)
	}
	if err := s.writeKey(key); err != nil {
		return nil, err
	}
	return key, nil
}

// LoadOrGenerateKey reuses an existing device key when one is present.
//
// Enrolment can be interrupted after the key is generated and before the
// identity is issued (docs/TESTING.md section 11). Reusing the key on retry
// makes that retry safe: the control plane never saw the earlier public key, so
// no identity is orphaned, and the environment does not accumulate abandoned
// keys.
func (s *Store) LoadOrGenerateKey() (*ecdsa.PrivateKey, bool, error) {
	key, err := s.LoadKey()
	switch {
	case err == nil:
		return key, true, nil
	case errors.Is(err, os.ErrNotExist):
		generated, err := s.GenerateKey()
		return generated, false, err
	default:
		return nil, false, err
	}
}

// LoadKey reads the device key after validating its permissions.
func (s *Store) LoadKey() (*ecdsa.PrivateKey, error) {
	if err := s.CheckKeyPermissions(); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(s.KeyPath()) // #nosec G304 -- path is derived from configuration
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "PRIVATE KEY" {
		return nil, fmt.Errorf("identity: %s is not a PEM-encoded private key", s.KeyPath())
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("identity: parsing %s: %w", s.KeyPath(), err)
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("identity: %s does not hold an ECDSA device key", s.KeyPath())
	}
	return key, nil
}

func (s *Store) writeKey(key *ecdsa.PrivateKey) error {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return fmt.Errorf("identity: encoding device key: %w", err)
	}
	encoded := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	if err := writeFileExclusive(s.KeyPath(), encoded, KeyFileMode); err != nil {
		return fmt.Errorf("identity: writing %s: %w", s.KeyPath(), err)
	}
	// The umask cannot widen a file created with 0600, but an existing file
	// replaced in place could have carried a wider mode, so assert the result.
	return s.CheckKeyPermissions()
}

// PublicKeyBase64 returns the base64-encoded SubjectPublicKeyInfo sent in the
// registration request. Only the public half is ever encoded: the protocol has
// no field capable of carrying a private key
// (docs/CONNECTOR_PROTOCOL.md section 4.2).
func PublicKeyBase64(key *ecdsa.PrivateKey) (string, error) {
	der, err := x509.MarshalPKIXPublicKey(key.Public())
	if err != nil {
		return "", fmt.Errorf("identity: encoding device public key: %w", err)
	}
	return base64.StdEncoding.EncodeToString(der), nil
}

// SaveCertificate writes the issued certificate and verifies that it matches
// the device key. A certificate that does not match the local key would fail
// every later handshake with an opaque error.
func (s *Store) SaveCertificate(certificateBase64 string, key *ecdsa.PrivateKey) (*x509.Certificate, error) {
	der, err := base64.StdEncoding.DecodeString(certificateBase64)
	if err != nil {
		return nil, fmt.Errorf("identity: issued certificate is not valid base64: %w", err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, fmt.Errorf("identity: issued certificate is not a valid X.509 certificate: %w", err)
	}
	issued, ok := certificate.PublicKey.(*ecdsa.PublicKey)
	if !ok || !issued.Equal(key.Public()) {
		return nil, errors.New("identity: issued certificate does not carry this environment's device public key")
	}
	encoded := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if err := writeFileExclusive(s.CertPath(), encoded, CertFileMode); err != nil {
		return nil, fmt.Errorf("identity: writing %s: %w", s.CertPath(), err)
	}
	return certificate, nil
}

// Fingerprint is the sha256 fingerprint recorded on the connector record
// (docs/DOMAIN_MODEL.md section 8).
func Fingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// SaveRecord writes the identity metadata file.
func (s *Store) SaveRecord(record Record) error {
	encoded, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return fmt.Errorf("identity: encoding identity record: %w", err)
	}
	encoded = append(encoded, '\n')
	if err := writeFileExclusive(s.RecordPath(), encoded, KeyFileMode); err != nil {
		return fmt.Errorf("identity: writing %s: %w", s.RecordPath(), err)
	}
	return nil
}

// LoadRecord reads the identity metadata file.
func (s *Store) LoadRecord() (*Record, error) {
	data, err := os.ReadFile(s.RecordPath()) // #nosec G304 -- path is derived from configuration
	if err != nil {
		return nil, err
	}
	var record Record
	if err := json.Unmarshal(data, &record); err != nil {
		return nil, fmt.Errorf("identity: parsing %s: %w", s.RecordPath(), err)
	}
	switch {
	case record.ConnectorID == "":
		return nil, fmt.Errorf("identity: %s has no connector_id", s.RecordPath())
	case record.ControlURL == "":
		return nil, fmt.Errorf("identity: %s has no control_url", s.RecordPath())
	}
	return &record, nil
}

// Enrolled reports whether an identity record is present.
func (s *Store) Enrolled() bool {
	_, err := os.Stat(s.RecordPath())
	return err == nil
}

// Remove deletes the certificate and identity record, leaving the key file for
// the caller to replace. Re-enrolment always generates a fresh key.
func (s *Store) Remove() error {
	for _, path := range []string{s.RecordPath(), s.CertPath()} {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("identity: removing %s: %w", path, err)
		}
	}
	return nil
}

// ClientCertificate assembles the TLS client certificate used for the mutually
// authenticated channel of docs/CONNECTOR_PROTOCOL.md section 5.
func (s *Store) ClientCertificate() (tls.Certificate, *x509.Certificate, error) {
	key, err := s.LoadKey()
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	data, err := os.ReadFile(s.CertPath()) // #nosec G304 -- path is derived from configuration
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "CERTIFICATE" {
		return tls.Certificate{}, nil, fmt.Errorf("identity: %s is not a PEM-encoded certificate", s.CertPath())
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return tls.Certificate{}, nil, fmt.Errorf("identity: parsing %s: %w", s.CertPath(), err)
	}
	return tls.Certificate{
		Certificate: [][]byte{block.Bytes},
		PrivateKey:  key,
		Leaf:        certificate,
	}, certificate, nil
}

// writeFileExclusive replaces path atomically with owner-only intermediate
// permissions, so that the file is never briefly world-readable.
func writeFileExclusive(path string, data []byte, mode os.FileMode) error {
	temporary := path + ".tmp"
	if err := os.Remove(temporary); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode) // #nosec G304
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return err
	}
	if err := file.Chmod(mode); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return os.Rename(temporary, path)
}
