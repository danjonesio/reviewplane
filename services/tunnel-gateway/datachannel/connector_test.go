package datachannel

import (
	"net/netip"
	"testing"
	"time"

	"github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/policy"
)

// Component layer (docs/TESTING.md section 2): connector route handling. Every
// check docs/CONNECTOR_PROTOCOL.md section 11 requires of the connector is
// asserted, with the stable error class the acknowledgement must carry.

func publicationConfig(now time.Time, listening bool) PublicationConfig {
	return PublicationConfig{
		AuthorisedProjects: []string{"prj_a"},
		KnownWorkspaces:    []string{"wsp_a"},
		Policy: policy.Policy{
			AllowedHosts:     []netip.Addr{netip.MustParseAddr("127.0.0.1")},
			AllowedPorts:     []policy.PortRange{{Low: 3000, High: 3999}, {Low: 4321, High: 4321}, {Low: 5173, High: 5173}},
			AllowedProtocols: []connectorv1.DestinationProtocol{connectorv1.DestinationProtocolHTTP},
		},
		MaxRoutes: 10,
		MaxTTL:    8 * time.Hour,
		Now:       func() time.Time { return now },
		Probe:     func(string, time.Duration) bool { return listening },
	}
}

func publication() connectorv1.RoutePublish {
	return connectorv1.RoutePublish{
		RouteID:                  "svc_a",
		ProjectID:                "prj_a",
		WorkspaceID:              "wsp_a",
		LocalHost:                "127.0.0.1",
		LocalPort:                5173,
		Protocol:                 connectorv1.DestinationProtocolHTTP,
		ExpiresAt:                "2026-07-30T13:00:00Z",
		AllowedBrowserSessionIDs: []string{"brs_a"},
	}
}

func TestAnAuthorisedPublicationIsAcknowledgedReady(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	table := NewRouteTable()
	ack := ValidatePublication(table, publication(), publicationConfig(now, true))
	if ack.Status != connectorv1.RoutePublishAckStatusReady {
		t.Fatalf("status %q", ack.Status)
	}
	if ack.ObservedDestination == nil || *ack.ObservedDestination != "127.0.0.1:5173" {
		t.Fatalf("observed destination %v", ack.ObservedDestination)
	}
	if ack.ErrorClass != nil {
		t.Fatalf("a ready acknowledgement carries error class %v", *ack.ErrorClass)
	}
	// The acknowledgement must satisfy the schema it travels in.
	if _, err := connectorv1.EncodeControlFrame(connectorv1.Frame{
		Envelope: connectorv1.Envelope{
			ProtocolVersion: connectorv1.ProtocolVersion,
			MessageID:       "msg_a",
			Type:            connectorv1.MessageTypeRoutePublishAck,
			SentAt:          "2026-07-30T12:00:00Z",
			ConnectorID:     stringPointer("con_a"),
		},
		Payload: ack,
	}); err != nil {
		t.Fatalf("the acknowledgement does not satisfy the schema: %v", err)
	}
	if table.Len() != 1 {
		t.Fatal("the route was not admitted")
	}
}

func TestConnectorValidationRefusalsCarryStableErrorClasses(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name      string
		mutate    func(*connectorv1.RoutePublish)
		config    func(PublicationConfig) PublicationConfig
		wantClass connectorv1.ErrorClass
	}{
		{
			name:      "another project",
			mutate:    func(p *connectorv1.RoutePublish) { p.ProjectID = "prj_b" },
			wantClass: connectorv1.ErrorClassProjectNotAuthorised,
		},
		{
			name:      "unknown workspace",
			mutate:    func(p *connectorv1.RoutePublish) { p.WorkspaceID = "wsp_b" },
			wantClass: connectorv1.ErrorClassWorkspaceNotFound,
		},
		{
			name:      "destination outside the local policy",
			mutate:    func(p *connectorv1.RoutePublish) { p.LocalHost = "169.254.169.254"; p.LocalPort = 3000 },
			wantClass: connectorv1.ErrorClassDestinationNotAllowed,
		},
		{
			name:      "port outside the local policy",
			mutate:    func(p *connectorv1.RoutePublish) { p.LocalPort = 8080 },
			wantClass: connectorv1.ErrorClassDestinationNotAllowed,
		},
		{
			name:      "expiry in the past",
			mutate:    func(p *connectorv1.RoutePublish) { p.ExpiresAt = "2026-07-30T11:00:00Z" },
			wantClass: connectorv1.ErrorClassRouteExpired,
		},
		{
			name:      "expiry beyond the local maximum",
			mutate:    func(p *connectorv1.RoutePublish) { p.ExpiresAt = "2026-07-31T13:00:00Z" },
			wantClass: connectorv1.ErrorClassRouteExpired,
		},
		{
			name:      "no authorised browser session",
			mutate:    func(p *connectorv1.RoutePublish) { p.AllowedBrowserSessionIDs = nil },
			wantClass: connectorv1.ErrorClassProjectNotAuthorised,
		},
		{
			name: "destination not listening",
			config: func(c PublicationConfig) PublicationConfig {
				c.Probe = func(string, time.Duration) bool { return false }
				return c
			},
			wantClass: connectorv1.ErrorClassPortNotListening,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			publish := publication()
			if testCase.mutate != nil {
				testCase.mutate(&publish)
			}
			config := publicationConfig(now, true)
			if testCase.config != nil {
				config = testCase.config(config)
			}
			table := NewRouteTable()
			ack := ValidatePublication(table, publish, config)
			if ack.Status != connectorv1.RoutePublishAckStatusRejected {
				t.Fatalf("status %q, want rejected", ack.Status)
			}
			if ack.ErrorClass == nil || *ack.ErrorClass != testCase.wantClass {
				t.Fatalf("error class %v, want %q", ack.ErrorClass, testCase.wantClass)
			}
			if ack.ObservedDestination != nil {
				t.Fatal("a rejected route reported a destination it opened")
			}
			if table.Len() != 0 {
				t.Fatal("a refused route was admitted anyway")
			}
		})
	}
}

func TestTheConcurrentRouteLimitIsEnforcedByTheConnector(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	config := publicationConfig(now, true)
	config.MaxRoutes = 2
	table := NewRouteTable()
	for index := 0; index < 2; index++ {
		publish := publication()
		publish.RouteID = "svc_" + string(rune('a'+index))
		if ack := ValidatePublication(table, publish, config); ack.Status != connectorv1.RoutePublishAckStatusReady {
			t.Fatalf("publication %d was refused", index)
		}
	}
	publish := publication()
	publish.RouteID = "svc_c"
	ack := ValidatePublication(table, publish, config)
	if ack.ErrorClass == nil || *ack.ErrorClass != connectorv1.ErrorClassRouteLimitExceeded {
		t.Fatalf("error class %v, want ROUTE_LIMIT_EXCEEDED", ack.ErrorClass)
	}
}

func TestRepublishingAKnownRouteDoesNotConsumeAnotherSlot(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	config := publicationConfig(now, true)
	config.MaxRoutes = 1
	table := NewRouteTable()
	if ack := ValidatePublication(table, publication(), config); ack.Status != connectorv1.RoutePublishAckStatusReady {
		t.Fatal("the first publication was refused")
	}
	if ack := ValidatePublication(table, publication(), config); ack.Status != connectorv1.RoutePublishAckStatusReady {
		t.Fatalf("republishing the same route was refused: %v", ack.ErrorClass)
	}
}

func stringPointer(value string) *string { return &value }
