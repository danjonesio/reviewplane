// Package controlplanetest is a control-plane double for connector tests.
//
// It is test support, not part of the connector binary: nothing under cmd/ or
// the packages the binary imports depends on it, which the no-listening-socket
// guard in cmd/reviewplane-connector asserts mechanically by walking the
// binary's own dependency graph.
//
// It speaks the real protocol through packages/protocol, terminates real TLS
// and requires a real client certificate on the control endpoint, so that the
// connector's mutual-authentication path is exercised rather than stubbed.
package controlplanetest

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	connectorv1 "github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/connector/internal/identity"
	"github.com/danjonesio/reviewplane/services/connector/internal/protocolio"
	"github.com/danjonesio/reviewplane/services/connector/internal/ws"
)

// Options configures the double.
type Options struct {
	// Token is the enrolment token the double accepts. An empty token accepts
	// any value.
	Token string
	// MaxUses bounds how many times Token may be exchanged. Zero means one,
	// matching the default of docs/CONNECTOR_PROTOCOL.md section 4.1.
	MaxUses int
	// RefuseEnrolmentWith closes the enrolment connection with this error class
	// instead of issuing an identity.
	RefuseEnrolmentWith connectorv1.ErrorClass
	// RefuseControlWith closes the control connection with this error class
	// instead of accepting the channel.
	RefuseControlWith connectorv1.ErrorClass
	// IdentityTTL bounds the issued identity. Zero means one year.
	IdentityTTL time.Duration
	// SendOnConnect is written to the connector as soon as the channel opens.
	// Raw bytes are used so that a test can send a deliberately malformed
	// frame.
	SendOnConnect []byte
	// DropFirstConnections closes this many control connections immediately
	// after accepting them, which simulates a control-plane restart.
	DropFirstConnections int
	// Reconcile answers the section 17 reconnect request. A nil function answers
	// with a compatible classification and no routes, which is the authoritative
	// "this control plane holds nothing for you" reply: the connector then serves
	// nothing, because it withdrew everything before asking.
	Reconcile func(connectorID string, request connectorv1.ReconnectRequest) connectorv1.ReconnectResponse
	// WithholdDesiredState accepts the reconnect request and never answers it,
	// which is the timeout case of section 17.
	WithholdDesiredState bool
}

// Server is a running control-plane double.
type Server struct {
	// URL is the https base URL to pass to --control-plane.
	URL string
	// CAFile holds the double's certificate authority in PEM form, for
	// --ca-file.
	CAFile string

	options Options

	caCertificate *x509.Certificate
	caKey         *ecdsa.PrivateKey
	http          *httptest.Server

	mutex          sync.Mutex
	tokenUses      int
	registrations  []connectorv1.RegistrationRequest
	heartbeats     []connectorv1.Heartbeat
	reconnects     []connectorv1.ReconnectRequest
	observations   []connectorv1.WorkspaceObservation
	acknowledged   []connectorv1.RoutePublishAck
	connections    int
	revoked        map[string]bool
	nextConnectorN int
	live           map[*ws.Conn]struct{}
	dataURL        string
	// LastPeerFingerprint records the client certificate the control endpoint
	// last authenticated.
	LastPeerFingerprint string
}

// Start launches the double and registers its shutdown with t.
func Start(t *testing.T, options Options) *Server {
	t.Helper()
	if options.MaxUses == 0 {
		options.MaxUses = 1
	}
	if options.IdentityTTL == 0 {
		options.IdentityTTL = 365 * 24 * time.Hour
	}

	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generating CA key: %v", err)
	}
	caTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "ReviewPlane test connector CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, caKey.Public(), caKey)
	if err != nil {
		t.Fatalf("creating CA certificate: %v", err)
	}
	caCertificate, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatalf("parsing CA certificate: %v", err)
	}

	serverKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generating server key: %v", err)
	}
	serverTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "localhost"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
	}
	serverDER, err := x509.CreateCertificate(rand.Reader, serverTemplate, caCertificate, serverKey.Public(), caKey)
	if err != nil {
		t.Fatalf("creating server certificate: %v", err)
	}

	pool := x509.NewCertPool()
	pool.AddCert(caCertificate)

	server := &Server{
		options:       options,
		caCertificate: caCertificate,
		caKey:         caKey,
		revoked:       map[string]bool{},
		live:          map[*ws.Conn]struct{}{},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/connector/v1/enrol", server.handleEnrol)
	mux.HandleFunc("/connector/v1/control", server.handleControl)

	server.http = httptest.NewUnstartedServer(mux)
	server.http.TLS = &tls.Config{
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{{Certificate: [][]byte{serverDER}, PrivateKey: serverKey}},
		// Enrolment presents no certificate and the control endpoint requires
		// one, so the listener asks for a certificate and each handler decides.
		ClientAuth: tls.VerifyClientCertIfGiven,
		ClientCAs:  pool,
	}
	server.http.StartTLS()
	t.Cleanup(server.http.Close)

	server.URL = server.http.URL
	directory := t.TempDir()
	server.CAFile = filepath.Join(directory, "control-plane-ca.pem")
	encoded := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})
	if err := os.WriteFile(server.CAFile, encoded, 0o600); err != nil {
		t.Fatalf("writing CA file: %v", err)
	}
	return server
}

// Close stops the double.
func (s *Server) Close() { s.http.Close() }

// SetDataURL overrides the data endpoint the registration response advertises.
//
// A real deployment terminates the data channel on the tunnel gateway rather
// than on the control plane (docs/ARCHITECTURE.md section 4.6), so a test that
// runs a real gateway points the connector at it here.
func (s *Server) SetDataURL(dataURL string) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	s.dataURL = dataURL
}

// CAPool is the double's certificate authority, for a verifier that must accept
// the client certificates it issues.
func (s *Server) CAPool() *x509.CertPool {
	pool := x509.NewCertPool()
	pool.AddCert(s.caCertificate)
	return pool
}

// IssueServerCertificate signs a server certificate for hosts with the double's
// authority, so that another listener in the same test is trusted by the
// connector's single --ca-file.
func (s *Server) IssueServerCertificate(hosts []string) (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, err
	}
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "reviewplane-test-listener"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	for _, host := range hosts {
		if ip := net.ParseIP(host); ip != nil {
			template.IPAddresses = append(template.IPAddresses, ip)
			continue
		}
		template.DNSNames = append(template.DNSNames, host)
	}
	der, err := x509.CreateCertificate(rand.Reader, template, s.caCertificate, key.Public(), s.caKey)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, nil
}

// Registrations returns the registration requests received so far.
func (s *Server) Registrations() []connectorv1.RegistrationRequest {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return append([]connectorv1.RegistrationRequest(nil), s.registrations...)
}

// Heartbeats returns the heartbeats received so far.
func (s *Server) Heartbeats() []connectorv1.Heartbeat {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return append([]connectorv1.Heartbeat(nil), s.heartbeats...)
}

// Connections counts accepted control channels.
func (s *Server) Connections() int {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return s.connections
}

// ReconnectRequests returns the section 17 reconnect payloads received so far.
func (s *Server) ReconnectRequests() []connectorv1.ReconnectRequest {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return append([]connectorv1.ReconnectRequest(nil), s.reconnects...)
}

// Observations returns the section 9 workspace observations received so far.
//
// The double records them rather than ignoring them so that a test can assert
// what actually crossed the wire: an observation the connector logged but never
// sent, or sent before its reconciliation claim, would otherwise look the same
// as one the control plane received.
func (s *Server) Observations() []connectorv1.WorkspaceObservation {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return append([]connectorv1.WorkspaceObservation(nil), s.observations...)
}

// Acknowledgements returns the route acknowledgements received so far.
func (s *Server) Acknowledgements() []connectorv1.RoutePublishAck {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return append([]connectorv1.RoutePublishAck(nil), s.acknowledged...)
}

// Sever drops every live control connection without a close frame, the way a
// network partition does: the process is still running and the socket simply
// stops. It reports how many connections it ended.
func (s *Server) Sever() int {
	s.mutex.Lock()
	connections := make([]*ws.Conn, 0, len(s.live))
	for conn := range s.live {
		connections = append(connections, conn)
	}
	s.live = map[*ws.Conn]struct{}{}
	s.mutex.Unlock()
	for _, conn := range connections {
		_ = conn.CloseNow()
	}
	return len(connections)
}

// Revoke marks a certificate fingerprint revoked, so that the next control
// connection is refused with IDENTITY_REVOKED.
func (s *Server) Revoke(fingerprint string) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	s.revoked[fingerprint] = true
}

func (s *Server) handleEnrol(w http.ResponseWriter, r *http.Request) {
	conn, err := ws.Accept(w, r, ws.AcceptOptions{MaxMessageBytes: connectorv1.MaxControlFrameBytes})
	if err != nil {
		http.Error(w, "upgrade required", http.StatusBadRequest)
		return
	}
	defer func() { _ = conn.CloseNow() }()
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))

	if class := s.options.RefuseEnrolmentWith; class != "" {
		_ = conn.Close(ws.ClosePolicyViolation, string(class))
		return
	}

	_, payload, err := conn.ReadMessage(r.Context())
	if err != nil {
		return
	}
	frame, protocolErr := connectorv1.DecodeControlFrame(payload)
	if protocolErr != nil {
		_ = conn.Close(ws.CloseInvalidPayload, string(protocolErr.ErrorClass))
		return
	}
	request, ok := frame.Payload.(connectorv1.RegistrationRequest)
	if !ok {
		_ = conn.Close(ws.ClosePolicyViolation, string(connectorv1.ErrorClassProtocolUnsupported))
		return
	}

	s.mutex.Lock()
	s.registrations = append(s.registrations, request)
	tokenMatches := s.options.Token == "" || request.EnrolmentToken.Reveal() == s.options.Token
	exhausted := s.tokenUses >= s.options.MaxUses
	if tokenMatches && !exhausted {
		s.tokenUses++
	}
	s.nextConnectorN++
	connectorID := "con_test" + strings.Repeat("0", 4) + itoa(s.nextConnectorN)
	s.mutex.Unlock()

	if !tokenMatches || exhausted {
		_ = conn.Close(ws.ClosePolicyViolation, string(connectorv1.ErrorClassEnrolmentTokenInvalid))
		return
	}

	certificateDER, expiresAt, err := s.issue(connectorID, request.PublicKey)
	if err != nil {
		_ = conn.Close(ws.CloseInternalError, "")
		return
	}
	host := s.http.Listener.Addr().String()
	s.mutex.Lock()
	dataURL := s.dataURL
	s.mutex.Unlock()
	if dataURL == "" {
		dataURL = "wss://" + host + "/connector/v1/data"
	}
	response := connectorv1.RegistrationResponse{
		ConnectorID: connectorID,
		SignedIdentity: connectorv1.SignedIdentity{
			Certificate:            base64.StdEncoding.EncodeToString(certificateDER),
			CertificateFingerprint: identity.Fingerprint(certificateDER),
			ExpiresAt:              protocolio.Timestamp(expiresAt),
		},
		ControlPlaneEndpoints: connectorv1.ControlPlaneEndpoints{
			ControlURL: "wss://" + host + "/connector/v1/control",
			DataURL:    dataURL,
		},
		PolicyDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
	}
	responseFrame, err := protocolio.NewFrame(response, "", time.Now())
	if err != nil {
		_ = conn.Close(ws.CloseInternalError, "")
		return
	}
	encoded, err := protocolio.Encode(responseFrame)
	if err != nil {
		_ = conn.Close(ws.CloseInternalError, "")
		return
	}
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if err := conn.WriteText(encoded); err != nil {
		return
	}
	_ = conn.Close(ws.CloseNormalClosure, "")
}

func (s *Server) issue(connectorID, publicKeyBase64 string) ([]byte, time.Time, error) {
	der, err := base64.StdEncoding.DecodeString(publicKeyBase64)
	if err != nil {
		return nil, time.Time{}, err
	}
	publicKey, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, time.Time{}, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, time.Time{}, err
	}
	expiresAt := time.Now().Add(s.options.IdentityTTL).UTC().Truncate(time.Second)
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: connectorID, Organization: []string{"ReviewPlane"}},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     expiresAt,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	certificateDER, err := x509.CreateCertificate(rand.Reader, template, s.caCertificate, publicKey, s.caKey)
	if err != nil {
		return nil, time.Time{}, err
	}
	return certificateDER, expiresAt, nil
}

func (s *Server) handleControl(w http.ResponseWriter, r *http.Request) {
	// Mutual authentication: a connection without a verified client
	// certificate is refused before the upgrade
	// (docs/CONNECTOR_PROTOCOL.md section 5).
	if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
		http.Error(w, string(connectorv1.ErrorClassIdentityRevoked), http.StatusUnauthorized)
		return
	}
	fingerprint := identity.Fingerprint(r.TLS.PeerCertificates[0].Raw)

	s.mutex.Lock()
	s.LastPeerFingerprint = fingerprint
	revoked := s.revoked[fingerprint]
	s.mutex.Unlock()

	conn, err := ws.Accept(w, r, ws.AcceptOptions{MaxMessageBytes: connectorv1.MaxControlFrameBytes})
	if err != nil {
		http.Error(w, "upgrade required", http.StatusBadRequest)
		return
	}
	defer func() { _ = conn.CloseNow() }()

	if revoked {
		_ = conn.Close(ws.ClosePolicyViolation, string(connectorv1.ErrorClassIdentityRevoked))
		return
	}
	if class := s.options.RefuseControlWith; class != "" {
		_ = conn.Close(ws.ClosePolicyViolation, string(class))
		return
	}

	s.mutex.Lock()
	s.connections++
	accepted := s.connections
	s.mutex.Unlock()

	if accepted <= s.options.DropFirstConnections {
		// Drop without a close frame, the way a restarted control plane does.
		_ = conn.CloseNow()
		return
	}

	s.mutex.Lock()
	s.live[conn] = struct{}{}
	s.mutex.Unlock()
	defer func() {
		s.mutex.Lock()
		delete(s.live, conn)
		s.mutex.Unlock()
	}()

	if len(s.options.SendOnConnect) > 0 {
		_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		_ = conn.WriteText(s.options.SendOnConnect)
	}

	for {
		_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		_, payload, err := conn.ReadMessage(r.Context())
		if err != nil {
			return
		}
		frame, protocolErr := connectorv1.DecodeControlFrame(payload)
		if protocolErr != nil {
			_ = conn.Close(ws.CloseInvalidPayload, string(protocolErr.ErrorClass))
			return
		}
		switch message := frame.Payload.(type) {
		case connectorv1.Heartbeat:
			s.mutex.Lock()
			s.heartbeats = append(s.heartbeats, message)
			s.mutex.Unlock()
		case connectorv1.RoutePublishAck:
			s.mutex.Lock()
			s.acknowledged = append(s.acknowledged, message)
			s.mutex.Unlock()
		case connectorv1.WorkspaceObservation:
			s.mutex.Lock()
			s.observations = append(s.observations, message)
			s.mutex.Unlock()
		case connectorv1.ReconnectRequest:
			s.mutex.Lock()
			s.reconnects = append(s.reconnects, message)
			s.mutex.Unlock()
			if s.options.WithholdDesiredState {
				continue
			}
			connectorID := ""
			if frame.Envelope.ConnectorID != nil {
				connectorID = *frame.Envelope.ConnectorID
			}
			response := connectorv1.ReconnectResponse{
				ReconciledAt: protocolio.Timestamp(time.Now()),
				Upgrade:      connectorv1.UpgradeClassificationCompatible,
				Routes:       []connectorv1.RouteDecision{},
				Sessions:     []connectorv1.SessionDecision{},
			}
			if s.options.Reconcile != nil {
				response = s.options.Reconcile(connectorID, message)
			}
			if err := s.answerReconnect(conn, connectorID, frame.Envelope.MessageID, response); err != nil {
				return
			}
		}
	}
}

// answerReconnect writes the desired state, correlated to the request.
func (s *Server) answerReconnect(
	conn *ws.Conn,
	connectorID, correlationID string,
	response connectorv1.ReconnectResponse,
) error {
	frame, err := protocolio.NewFrame(response, connectorID, time.Now())
	if err != nil {
		return err
	}
	frame.Envelope.CorrelationID = &correlationID
	encoded, err := protocolio.Encode(frame)
	if err != nil {
		return err
	}
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return conn.WriteText(encoded)
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	var digits []byte
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}
