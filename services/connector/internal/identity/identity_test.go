package identity

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	store := NewStore(filepath.Join(t.TempDir(), "reviewplane-connector"))
	if err := store.EnsureDir(); err != nil {
		t.Fatalf("EnsureDir: %v", err)
	}
	return store
}

func TestGenerateKeyIsOwnerOnly(t *testing.T) {
	store := newStore(t)
	if _, err := store.GenerateKey(); err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	info, err := os.Stat(store.KeyPath())
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if got := info.Mode().Perm(); got != KeyFileMode {
		t.Fatalf("key mode = %#o, want %#o", got, KeyFileMode)
	}
	directory, err := os.Stat(store.Dir())
	if err != nil {
		t.Fatalf("stat directory: %v", err)
	}
	if directory.Mode().Perm()&0o077 != 0 {
		t.Fatalf("data directory mode = %#o, want owner-only", directory.Mode().Perm())
	}
}

// docs/DEVELOPMENT.md section 10 and docs/SECURITY.md section 6.2: the
// connector refuses to start on an over-permissive key file.
func TestCheckKeyPermissionsRefusesWiderModes(t *testing.T) {
	for _, mode := range []os.FileMode{0o640, 0o644, 0o604, 0o660, 0o666, 0o700 | 0o007} {
		t.Run(mode.String(), func(t *testing.T) {
			store := newStore(t)
			if _, err := store.GenerateKey(); err != nil {
				t.Fatalf("GenerateKey: %v", err)
			}
			if err := os.Chmod(store.KeyPath(), mode); err != nil {
				t.Fatalf("chmod: %v", err)
			}
			err := store.CheckKeyPermissions()
			var permission *PermissionError
			if !errors.As(err, &permission) {
				t.Fatalf("CheckKeyPermissions with mode %#o returned %v, want a PermissionError", mode, err)
			}
			if !strings.Contains(permission.Error(), "group and other permissions") {
				t.Fatalf("refusal %q does not explain the required change", permission)
			}
			if _, err := store.LoadKey(); !errors.As(err, &permission) {
				t.Fatalf("LoadKey with mode %#o returned %v, want a PermissionError", mode, err)
			}
		})
	}
}

func TestCheckKeyPermissionsAcceptsOwnerOnly(t *testing.T) {
	store := newStore(t)
	if _, err := store.GenerateKey(); err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	for _, mode := range []os.FileMode{0o600, 0o400} {
		if err := os.Chmod(store.KeyPath(), mode); err != nil {
			t.Fatalf("chmod: %v", err)
		}
		if err := store.CheckKeyPermissions(); err != nil {
			t.Fatalf("mode %#o was refused: %v", mode, err)
		}
	}
}

func TestLoadOrGenerateKeyReusesAnInterruptedEnrolment(t *testing.T) {
	// docs/TESTING.md section 11: enrolment interrupted after key generation
	// and before identity issuance must be safe to retry.
	store := newStore(t)
	first, reused, err := store.LoadOrGenerateKey()
	if err != nil {
		t.Fatalf("LoadOrGenerateKey: %v", err)
	}
	if reused {
		t.Fatal("the first call must generate a key")
	}
	second, reused, err := store.LoadOrGenerateKey()
	if err != nil {
		t.Fatalf("LoadOrGenerateKey: %v", err)
	}
	if !reused {
		t.Fatal("the second call must reuse the existing key")
	}
	if !first.PublicKey.Equal(&second.PublicKey) {
		t.Fatal("the reused key differs from the generated one")
	}
	if store.Enrolled() {
		t.Fatal("a key without an identity record must not count as enrolled")
	}
}

func TestPublicKeyBase64CarriesOnlyThePublicHalf(t *testing.T) {
	store := newStore(t)
	key, err := store.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	encoded, err := PublicKeyBase64(key)
	if err != nil {
		t.Fatalf("PublicKeyBase64: %v", err)
	}
	der, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("the encoded public key is not base64: %v", err)
	}
	parsed, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		t.Fatalf("the encoded value is not a SubjectPublicKeyInfo: %v", err)
	}
	public, ok := parsed.(*ecdsa.PublicKey)
	if !ok || !public.Equal(key.Public()) {
		t.Fatal("the encoded public key does not match the device key")
	}
	// The private scalar must not appear anywhere in the encoding.
	secret := key.D.Bytes()
	if len(secret) > 8 && strings.Contains(string(der), string(secret)) {
		t.Fatal("the encoded public key contains private key material")
	}
}

func issueCertificate(t *testing.T, key *ecdsa.PrivateKey, notAfter time.Time) []byte {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generating CA key: %v", err)
	}
	caTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "test CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              notAfter,
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, caKey.Public(), caKey)
	if err != nil {
		t.Fatalf("creating CA certificate: %v", err)
	}
	ca, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatalf("parsing CA certificate: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "con_test"},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     notAfter,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca, key.Public(), caKey)
	if err != nil {
		t.Fatalf("creating certificate: %v", err)
	}
	return der
}

func TestSaveCertificateRejectsAForeignKey(t *testing.T) {
	store := newStore(t)
	key, err := store.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	other, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generating a second key: %v", err)
	}
	der := issueCertificate(t, other, time.Now().Add(time.Hour))
	_, err = store.SaveCertificate(base64.StdEncoding.EncodeToString(der), key)
	if err == nil || !strings.Contains(err.Error(), "device public key") {
		t.Fatalf("SaveCertificate accepted a certificate for another key: %v", err)
	}
}

func TestClientCertificateRoundTrip(t *testing.T) {
	store := newStore(t)
	key, err := store.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	der := issueCertificate(t, key, time.Now().Add(time.Hour))
	certificate, err := store.SaveCertificate(base64.StdEncoding.EncodeToString(der), key)
	if err != nil {
		t.Fatalf("SaveCertificate: %v", err)
	}
	fingerprint := Fingerprint(der)
	if !strings.HasPrefix(fingerprint, "sha256:") || len(fingerprint) != len("sha256:")+64 {
		t.Fatalf("fingerprint %q is not a sha256 digest", fingerprint)
	}
	record := Record{
		ConnectorID:            "con_example",
		CertificateFingerprint: fingerprint,
		ExpiresAt:              certificate.NotAfter,
		ControlURL:             "wss://control.example.internal/connector/v1/control",
		DataURL:                "wss://control.example.internal/connector/v1/data",
		EnrolledAt:             time.Now().UTC(),
	}
	if err := store.SaveRecord(record); err != nil {
		t.Fatalf("SaveRecord: %v", err)
	}
	if !store.Enrolled() {
		t.Fatal("Enrolled must report true once a record exists")
	}
	loaded, err := store.LoadRecord()
	if err != nil {
		t.Fatalf("LoadRecord: %v", err)
	}
	if loaded.ConnectorID != record.ConnectorID || loaded.ControlURL != record.ControlURL {
		t.Fatalf("record round trip lost data: %+v", loaded)
	}
	tlsCertificate, leaf, err := store.ClientCertificate()
	if err != nil {
		t.Fatalf("ClientCertificate: %v", err)
	}
	if leaf.Subject.CommonName != "con_test" {
		t.Fatalf("leaf subject = %q", leaf.Subject.CommonName)
	}
	if len(tlsCertificate.Certificate) != 1 {
		t.Fatalf("client certificate carries %d entries", len(tlsCertificate.Certificate))
	}

	// The identity record must never hold private key material.
	contents, err := os.ReadFile(store.RecordPath())
	if err != nil {
		t.Fatalf("reading identity record: %v", err)
	}
	if strings.Contains(string(contents), "PRIVATE") {
		t.Fatal("the identity record contains private key material")
	}
}

func TestRemoveClearsTheIdentityButNotTheKey(t *testing.T) {
	store := newStore(t)
	key, err := store.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	der := issueCertificate(t, key, time.Now().Add(time.Hour))
	if _, err := store.SaveCertificate(base64.StdEncoding.EncodeToString(der), key); err != nil {
		t.Fatalf("SaveCertificate: %v", err)
	}
	if err := store.SaveRecord(Record{ConnectorID: "con_x", ControlURL: "wss://x/y"}); err != nil {
		t.Fatalf("SaveRecord: %v", err)
	}
	if err := store.Remove(); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if store.Enrolled() {
		t.Fatal("Remove must clear the identity record")
	}
	if _, err := os.Stat(store.KeyPath()); err != nil {
		t.Fatalf("Remove must leave the key file for the caller to replace: %v", err)
	}
	if err := store.Remove(); err != nil {
		t.Fatalf("Remove must be idempotent: %v", err)
	}
}

func TestLoadKeyReportsAMissingKeyAsNotExist(t *testing.T) {
	store := newStore(t)
	_, err := store.LoadKey()
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("LoadKey on an empty directory returned %v", err)
	}
}

func TestEnsureDirTightensAnExistingWideDirectory(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "wide")
	if err := os.MkdirAll(directory, 0o777); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.Chmod(directory, 0o777); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	if err := NewStore(directory).EnsureDir(); err != nil {
		t.Fatalf("EnsureDir: %v", err)
	}
	info, err := os.Stat(directory)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("EnsureDir left mode %#o", info.Mode().Perm())
	}
}
