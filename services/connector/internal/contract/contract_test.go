// Package contract holds the connector's contract-layer tests
// (docs/TESTING.md section 2).
//
// The corpus in packages/protocol/fixtures/connector/v1 is the single
// definition of "compatible". Running it here proves that the connector's frame
// handling agrees with the control plane's, rather than that the connector
// agrees with itself.
package contract_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	connectorv1 "github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/connector/internal/buildinfo"
	"github.com/danjonesio/reviewplane/services/connector/internal/hostinfo"
	"github.com/danjonesio/reviewplane/services/connector/internal/protocolio"
)

type validFixture struct {
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	File        string `json:"file"`
	MessageType string `json:"message_type"`
}

type invalidFixture struct {
	Name             string `json:"name"`
	Kind             string `json:"kind"`
	File             string `json:"file"`
	ExpectReason     string `json:"expect_reason"`
	ExpectErrorClass string `json:"expect_error_class"`
}

type manifest struct {
	Protocol string           `json:"protocol"`
	Version  int              `json:"version"`
	Valid    []validFixture   `json:"valid"`
	Invalid  []invalidFixture `json:"invalid"`
}

// fixturesDir walks up from the test's working directory to the corpus, so the
// test does not encode this package's depth in the tree.
func fixturesDir(t *testing.T) string {
	t.Helper()
	directory, err := os.Getwd()
	if err != nil {
		t.Fatalf("working directory: %v", err)
	}
	for i := 0; i < 8; i++ {
		candidate := filepath.Join(directory, "packages", "protocol", "fixtures", "connector", "v1")
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			break
		}
		directory = parent
	}
	t.Fatal("packages/protocol/fixtures/connector/v1 was not found above the working directory")
	return ""
}

func loadManifest(t *testing.T) (string, manifest) {
	t.Helper()
	directory := fixturesDir(t)
	raw, err := os.ReadFile(filepath.Join(directory, "manifest.json"))
	if err != nil {
		t.Fatalf("reading the fixture manifest: %v", err)
	}
	var loaded manifest
	if err := json.Unmarshal(raw, &loaded); err != nil {
		t.Fatalf("parsing the fixture manifest: %v", err)
	}
	if loaded.Protocol != connectorv1.ProtocolName || int64(loaded.Version) != connectorv1.ProtocolVersion {
		t.Fatalf("the corpus describes %s v%d, but this build speaks %s v%d",
			loaded.Protocol, loaded.Version, connectorv1.ProtocolName, connectorv1.ProtocolVersion)
	}
	return directory, loaded
}

// Every frame the corpus marks valid must be accepted, and re-encoding it must
// reproduce the recorded canonical bytes.
func TestConnectorAcceptsTheValidCorpus(t *testing.T) {
	directory, loaded := loadManifest(t)
	canonicalRaw, err := os.ReadFile(filepath.Join(directory, "canonical.json"))
	if err != nil {
		t.Fatalf("reading the canonical corpus: %v", err)
	}
	var canonical map[string]string
	if err := json.Unmarshal(canonicalRaw, &canonical); err != nil {
		t.Fatalf("parsing the canonical corpus: %v", err)
	}
	if len(loaded.Valid) == 0 {
		t.Fatal("the corpus lists no valid fixtures")
	}

	for _, fixture := range loaded.Valid {
		t.Run(fixture.Name, func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join(directory, fixture.File))
			if err != nil {
				t.Fatalf("reading %s: %v", fixture.File, err)
			}
			expected, recorded := canonical[fixture.Name]
			if !recorded {
				t.Fatalf("%s has no recorded canonical encoding", fixture.Name)
			}

			if fixture.Kind == "data_stream_header" {
				header, protocolErr := connectorv1.DecodeDataStreamHeaderFrame(raw)
				if protocolErr != nil {
					t.Fatalf("the corpus fixture was refused: %v", protocolErr)
				}
				encoded, err := connectorv1.EncodeDataStreamHeaderFrame(header)
				if err != nil {
					t.Fatalf("re-encoding: %v", err)
				}
				if string(encoded) != expected {
					t.Fatalf("canonical encoding differs from the corpus")
				}
				return
			}

			frame, protocolErr := connectorv1.DecodeControlFrame(raw)
			if protocolErr != nil {
				t.Fatalf("the corpus fixture was refused: %v", protocolErr)
			}
			if string(frame.Envelope.Type) != fixture.MessageType {
				t.Fatalf("decoded type %q, corpus says %q", frame.Envelope.Type, fixture.MessageType)
			}
			encoded, err := connectorv1.EncodeControlFrame(frame)
			if err != nil {
				t.Fatalf("re-encoding: %v", err)
			}
			if string(encoded) != expected {
				t.Fatalf("canonical encoding differs from the corpus")
			}
		})
	}
}

// Every frame the corpus marks invalid must be refused with the recorded reason
// and, where the protocol defines one, the recorded wire error class.
func TestConnectorRefusesTheInvalidCorpus(t *testing.T) {
	directory, loaded := loadManifest(t)
	if len(loaded.Invalid) == 0 {
		t.Fatal("the corpus lists no invalid fixtures")
	}
	for _, fixture := range loaded.Invalid {
		t.Run(fixture.Name, func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join(directory, fixture.File))
			if err != nil {
				t.Fatalf("reading %s: %v", fixture.File, err)
			}
			var protocolErr *connectorv1.ProtocolError
			if fixture.Kind == "data_stream_header" {
				_, protocolErr = connectorv1.DecodeDataStreamHeaderFrame(raw)
			} else {
				_, protocolErr = connectorv1.DecodeControlFrame(raw)
			}
			if protocolErr == nil {
				t.Fatal("the fixture was accepted; the corpus requires a refusal")
			}
			if string(protocolErr.Reason) != fixture.ExpectReason {
				t.Fatalf("reason = %q, corpus says %q", protocolErr.Reason, fixture.ExpectReason)
			}
			if string(protocolErr.ErrorClass) != fixture.ExpectErrorClass {
				t.Fatalf("error class = %q, corpus says %q", protocolErr.ErrorClass, fixture.ExpectErrorClass)
			}
		})
	}
}

// The connector's own outbound frames must satisfy the same decoder the control
// plane runs.
func TestConnectorOutboundFramesRoundTrip(t *testing.T) {
	load := 0.42
	memory := int64(8200000000)
	cases := []struct {
		name        string
		payload     connectorv1.Payload
		connectorID string
	}{
		{
			name: "registration request",
			payload: connectorv1.RegistrationRequest{
				EnrolmentToken: connectorv1.EnrolmentToken("an-enrolment-token-value"),
				PublicKey:      "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE" + strings.Repeat("A", 44) + "==",
				Environment: connectorv1.EnvironmentDescriptor{
					Name:         "dev-ai-03",
					Platform:     hostinfo.Platform(),
					Architecture: hostinfo.Architecture(),
					Labels:       []string{"proxmox", "development"},
				},
				Connector: connectorv1.ConnectorDescriptor{
					Version:      buildinfo.Version,
					Capabilities: buildinfo.Capabilities,
				},
			},
		},
		{
			name:        "heartbeat",
			connectorID: "con_example",
			payload: connectorv1.Heartbeat{
				Status:          connectorv1.HeartbeatStatusHealthy,
				UptimeSeconds:   8132,
				Version:         buildinfo.Version,
				ActiveRoutes:    0,
				ActiveStreams:   0,
				ResourceSummary: &connectorv1.ResourceSummary{Load: &load, MemoryAvailableBytes: &memory},
			},
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			frame, err := protocolio.NewFrame(test.payload, test.connectorID, time.Now())
			if err != nil {
				t.Fatalf("NewFrame: %v", err)
			}
			encoded, err := protocolio.Encode(frame)
			if err != nil {
				t.Fatalf("Encode: %v", err)
			}
			if len(encoded) > connectorv1.MaxControlFrameBytes {
				t.Fatalf("the frame is %d bytes, over the control-channel bound", len(encoded))
			}
			decoded, protocolErr := connectorv1.DecodeControlFrame(encoded)
			if protocolErr != nil {
				t.Fatalf("the connector produced a frame its own decoder refuses: %v", protocolErr)
			}
			if decoded.Envelope.Type != test.payload.MessageType() {
				t.Fatalf("decoded type %q", decoded.Envelope.Type)
			}
			// docs/CONNECTOR_PROTOCOL.md section 7: connector_id is absent on
			// the registration exchange and present on everything else.
			if test.connectorID == "" && decoded.Envelope.ConnectorID != nil {
				t.Fatal("the registration exchange must carry no connector_id")
			}
			if test.connectorID != "" && (decoded.Envelope.ConnectorID == nil || *decoded.Envelope.ConnectorID != test.connectorID) {
				t.Fatal("the envelope lost its connector_id")
			}
		})
	}
}

// The enrolment token is sensitive: the canonical encoder reveals it and every
// other representation redacts it. Encoding a registration request with
// encoding/json instead of the generated encoder would ship a redacted token.
func TestEnrolmentTokenIsRevealedOnlyByTheCanonicalEncoder(t *testing.T) {
	const secret = "an-enrolment-token-value"
	request := connectorv1.RegistrationRequest{
		EnrolmentToken: connectorv1.EnrolmentToken(secret),
		PublicKey:      "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE" + strings.Repeat("A", 44) + "==",
		Environment: connectorv1.EnvironmentDescriptor{
			Name: "dev-ai-03", Platform: "linux", Architecture: "amd64",
		},
		Connector: connectorv1.ConnectorDescriptor{Version: buildinfo.Version, Capabilities: buildinfo.Capabilities},
	}
	frame, err := protocolio.NewFrame(request, "", time.Now())
	if err != nil {
		t.Fatalf("NewFrame: %v", err)
	}
	wire, err := protocolio.Encode(frame)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	if !strings.Contains(string(wire), secret) {
		t.Fatal("the canonical encoder must reveal the token on the wire")
	}
	redacted, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	if strings.Contains(string(redacted), secret) {
		t.Fatal("encoding/json must redact the token")
	}
}

// The capabilities this build advertises must be values the protocol version
// knows, so that the control plane classifies rather than guesses.
func TestAdvertisedCapabilitiesAreKnownToTheProtocol(t *testing.T) {
	if len(buildinfo.Capabilities) == 0 {
		t.Fatal("the connector advertises no capabilities")
	}
	for _, capability := range buildinfo.Capabilities {
		if !slices.Contains(connectorv1.KnownCapabilities, capability) {
			t.Fatalf("capability %q is not in x-protocol.known_capabilities", capability)
		}
	}
	if !slices.Contains(connectorv1.KnownPlatforms, hostinfo.Platform()) {
		t.Skipf("this platform (%s) is outside x-protocol.known_platforms", hostinfo.Platform())
	}
}

// FuzzDecodeControlFrame runs the corpus as seeds. The decoder must refuse
// hostile input rather than panic (docs/CONNECTOR_PROTOCOL.md section 22).
func FuzzDecodeControlFrame(f *testing.F) {
	directory, loaded := loadManifestFuzz(f)
	for _, fixture := range append(validFiles(loaded), invalidFiles(loaded)...) {
		raw, err := os.ReadFile(filepath.Join(directory, fixture))
		if err != nil {
			continue
		}
		f.Add(raw)
	}
	f.Add([]byte(""))
	f.Add([]byte("{"))
	f.Add([]byte(strings.Repeat("[", 512)))
	f.Fuzz(func(t *testing.T, raw []byte) {
		frame, protocolErr := connectorv1.DecodeControlFrame(raw)
		if protocolErr != nil {
			return
		}
		// Anything accepted must re-encode within its bounds.
		encoded, err := connectorv1.EncodeControlFrame(frame)
		if err != nil {
			t.Fatalf("an accepted frame failed to re-encode: %v", err)
		}
		if len(encoded) > connectorv1.MaxControlFrameBytes {
			t.Fatalf("an accepted frame re-encodes to %d bytes", len(encoded))
		}
	})
}

func loadManifestFuzz(f *testing.F) (string, manifest) {
	f.Helper()
	directory, err := os.Getwd()
	if err != nil {
		f.Fatalf("working directory: %v", err)
	}
	for i := 0; i < 8; i++ {
		candidate := filepath.Join(directory, "packages", "protocol", "fixtures", "connector", "v1")
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			raw, err := os.ReadFile(filepath.Join(candidate, "manifest.json"))
			if err != nil {
				f.Fatalf("reading the fixture manifest: %v", err)
			}
			var loaded manifest
			if err := json.Unmarshal(raw, &loaded); err != nil {
				f.Fatalf("parsing the fixture manifest: %v", err)
			}
			return candidate, loaded
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			break
		}
		directory = parent
	}
	f.Fatal("the fixture corpus was not found")
	return "", manifest{}
}

func validFiles(loaded manifest) []string {
	files := make([]string, 0, len(loaded.Valid))
	for _, fixture := range loaded.Valid {
		files = append(files, fixture.File)
	}
	return files
}

func invalidFiles(loaded manifest) []string {
	files := make([]string, 0, len(loaded.Invalid))
	for _, fixture := range loaded.Invalid {
		files = append(files, fixture.File)
	}
	return files
}
