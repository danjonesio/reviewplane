package policy

import (
	"encoding/json"
	"net/netip"
	"os"
	"path/filepath"
	"testing"

	"github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
)

// Security layer (docs/TESTING.md sections 6 and 10): the destination policy is
// the SSRF control, and it is enforced in two languages. Both run this corpus.

const corpusPath = "../testdata/destination-policy.json"

type policyFixture struct {
	Note             string   `json:"note"`
	AllowedHosts     []string `json:"allowed_hosts"`
	AllowedPorts     []string `json:"allowed_ports"`
	AllowedProtocols []string `json:"allowed_protocols"`
	AllowNonLoopback bool     `json:"allow_non_loopback"`
	AllowLinkLocal   bool     `json:"allow_link_local"`
}

type caseFixture struct {
	Name     string `json:"name"`
	Policy   string `json:"policy"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Protocol string `json:"protocol"`
	Expect   string `json:"expect"`
	Note     string `json:"note"`
}

type corpus struct {
	Policies map[string]policyFixture `json:"policies"`
	Cases    []caseFixture            `json:"cases"`
}

func loadCorpus(t *testing.T) corpus {
	t.Helper()
	raw, err := os.ReadFile(filepath.Clean(corpusPath))
	if err != nil {
		t.Fatalf("read corpus: %v", err)
	}
	var loaded corpus
	if err := json.Unmarshal(raw, &loaded); err != nil {
		t.Fatalf("parse corpus: %v", err)
	}
	if len(loaded.Cases) == 0 {
		t.Fatal("the destination-policy corpus is empty")
	}
	return loaded
}

func buildPolicy(t *testing.T, fixture policyFixture) Policy {
	t.Helper()
	hosts := make([]netip.Addr, 0, len(fixture.AllowedHosts))
	for _, host := range fixture.AllowedHosts {
		address, err := netip.ParseAddr(host)
		if err != nil {
			t.Fatalf("corpus host %q is not an address: %v", host, err)
		}
		hosts = append(hosts, address.Unmap())
	}
	ports := make([]PortRange, 0, len(fixture.AllowedPorts))
	for _, text := range fixture.AllowedPorts {
		parsed, err := ParsePortRange(text)
		if err != nil {
			t.Fatalf("corpus port range %q: %v", text, err)
		}
		ports = append(ports, parsed)
	}
	protocols := make([]connectorv1.DestinationProtocol, 0, len(fixture.AllowedProtocols))
	for _, protocol := range fixture.AllowedProtocols {
		protocols = append(protocols, connectorv1.DestinationProtocol(protocol))
	}
	return Policy{
		AllowedHosts:     hosts,
		AllowedPorts:     ports,
		AllowedProtocols: protocols,
		AllowNonLoopback: fixture.AllowNonLoopback,
		AllowLinkLocal:   fixture.AllowLinkLocal,
	}
}

func TestDestinationPolicyCorpus(t *testing.T) {
	loaded := loadCorpus(t)
	for _, testCase := range loaded.Cases {
		t.Run(testCase.Name, func(t *testing.T) {
			fixture, ok := loaded.Policies[testCase.Policy]
			if !ok {
				t.Fatalf("corpus names no policy %q", testCase.Policy)
			}
			rejection := buildPolicy(t, fixture).Evaluate(Destination{
				Host:     testCase.Host,
				Port:     testCase.Port,
				Protocol: connectorv1.DestinationProtocol(testCase.Protocol),
			})
			if testCase.Expect == "allowed" {
				if rejection != nil {
					t.Fatalf("corpus allows this destination, policy refused it as %q", rejection.Reason)
				}
				return
			}
			if rejection == nil {
				t.Fatalf("corpus refuses this destination as %q, policy allowed it", testCase.Expect)
			}
			if string(rejection.Reason) != testCase.Expect {
				t.Fatalf("refused as %q, corpus requires %q", rejection.Reason, testCase.Expect)
			}
			if rejection.Class != connectorv1.ErrorClassDestinationNotAllowed {
				t.Fatalf("wire error class %q, want DESTINATION_NOT_ALLOWED", rejection.Class)
			}
		})
	}
}

func TestZeroPolicyAllowsNothing(t *testing.T) {
	// Deny by default (docs/SECURITY.md section 5) has to be a property of the
	// type, not of the configuration loader.
	rejection := Policy{}.Evaluate(Destination{
		Host: "127.0.0.1", Port: 5173, Protocol: connectorv1.DestinationProtocolHTTP,
	})
	if rejection == nil {
		t.Fatal("the zero policy allowed a destination")
	}
	if rejection.Reason != ReasonHostNotAllowed {
		t.Fatalf("refused as %q, want host_not_in_allow_list", rejection.Reason)
	}
}

func TestDefaultPolicyMatchesTheDocumentedConnectorAllowList(t *testing.T) {
	// docs/CONNECTOR_PROTOCOL.md section 20 is the reference configuration.
	allowed := []Destination{
		{Host: "127.0.0.1", Port: 3000, Protocol: connectorv1.DestinationProtocolHTTP},
		{Host: "127.0.0.1", Port: 4321, Protocol: connectorv1.DestinationProtocolHTTP},
		{Host: "127.0.0.1", Port: 5173, Protocol: connectorv1.DestinationProtocolHTTP},
		{Host: "::1", Port: 3500, Protocol: connectorv1.DestinationProtocolHTTP},
	}
	for _, destination := range allowed {
		if rejection := DefaultPolicy().Evaluate(destination); rejection != nil {
			t.Fatalf("%v was refused as %q", destination, rejection.Reason)
		}
	}
}

func TestPortRangeParsing(t *testing.T) {
	for _, valid := range []struct {
		text string
		want PortRange
	}{
		{"4321", PortRange{4321, 4321}},
		{"3000-3999", PortRange{3000, 3999}},
		{" 5173 ", PortRange{5173, 5173}},
		{"1-65535", PortRange{1, 65535}},
	} {
		got, err := ParsePortRange(valid.text)
		if err != nil {
			t.Fatalf("%q: %v", valid.text, err)
		}
		if got != valid.want {
			t.Fatalf("%q parsed to %+v, want %+v", valid.text, got, valid.want)
		}
	}
	for _, invalid := range []string{"", "0", "65536", "3999-3000", "http", "3000-", "-3999", "3000-3999-4000"} {
		if _, err := ParsePortRange(invalid); err == nil {
			t.Fatalf("%q was accepted as a port range", invalid)
		}
	}
}

func TestPortRangeListParsing(t *testing.T) {
	ranges, err := ParsePortRanges("3000-3999,4321,5173")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(ranges) != 3 {
		t.Fatalf("parsed %d ranges, want 3", len(ranges))
	}
	if _, err := ParsePortRanges(""); err == nil {
		t.Fatal("an empty port list was accepted")
	}
	if _, err := ParsePortRanges("3000,not-a-port"); err == nil {
		t.Fatal("a list with an invalid member was accepted")
	}
}

func TestHostParsingRefusesNames(t *testing.T) {
	if _, err := ParseHosts("localhost"); err == nil {
		t.Fatal("a host name was accepted as an allowed host")
	}
	hosts, err := ParseHosts("127.0.0.1, ::1")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(hosts) != 2 {
		t.Fatalf("parsed %d hosts, want 2", len(hosts))
	}
	if _, err := ParseHosts(""); err == nil {
		t.Fatal("an empty allow-list was accepted")
	}
}
