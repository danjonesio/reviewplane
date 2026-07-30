package policy

import (
	"encoding/json"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"

	"github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
)

// The shared destination corpus.
//
// docs/CONNECTOR_PROTOCOL.md section 11 puts one policy in three places — the
// control plane, the gateway and the connector — and requires that they cannot
// drift apart. The corpus is how that is checked, so loading it is exported
// rather than duplicated in each service's test file: a second reader would be
// a second thing that could disagree about what a case means.

// CorpusPolicy is one named policy in the corpus.
type CorpusPolicy struct {
	Note             string   `json:"note"`
	AllowedHosts     []string `json:"allowed_hosts"`
	AllowedPorts     []string `json:"allowed_ports"`
	AllowedProtocols []string `json:"allowed_protocols"`
	AllowNonLoopback bool     `json:"allow_non_loopback"`
	AllowLinkLocal   bool     `json:"allow_link_local"`
}

// CorpusCase is one destination and the outcome the corpus requires.
//
// Expect is either "allowed" or the Reason the policy must refuse it with.
type CorpusCase struct {
	Name     string `json:"name"`
	Policy   string `json:"policy"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Protocol string `json:"protocol"`
	Expect   string `json:"expect"`
	Note     string `json:"note"`
}

// Corpus is the whole file.
type Corpus struct {
	Policies map[string]CorpusPolicy `json:"policies"`
	Cases    []CorpusCase            `json:"cases"`
}

// LoadCorpus reads and validates the corpus at path.
func LoadCorpus(path string) (Corpus, error) {
	raw, err := os.ReadFile(filepath.Clean(path))
	if err != nil {
		return Corpus{}, fmt.Errorf("policy: reading the destination corpus: %w", err)
	}
	var loaded Corpus
	if err := json.Unmarshal(raw, &loaded); err != nil {
		return Corpus{}, fmt.Errorf("policy: parsing the destination corpus: %w", err)
	}
	if len(loaded.Cases) == 0 {
		return Corpus{}, fmt.Errorf("policy: the destination corpus at %s is empty", path)
	}
	return loaded, nil
}

// Build turns a corpus policy into a Policy.
func (p CorpusPolicy) Build() (Policy, error) {
	hosts := make([]netip.Addr, 0, len(p.AllowedHosts))
	for _, host := range p.AllowedHosts {
		address, err := netip.ParseAddr(host)
		if err != nil {
			return Policy{}, fmt.Errorf("policy: corpus host %q is not an address: %w", host, err)
		}
		hosts = append(hosts, address.Unmap())
	}
	ports := make([]PortRange, 0, len(p.AllowedPorts))
	for _, text := range p.AllowedPorts {
		parsed, err := ParsePortRange(text)
		if err != nil {
			return Policy{}, fmt.Errorf("policy: corpus port range %q: %w", text, err)
		}
		ports = append(ports, parsed)
	}
	protocols := make([]connectorv1.DestinationProtocol, 0, len(p.AllowedProtocols))
	for _, protocol := range p.AllowedProtocols {
		protocols = append(protocols, connectorv1.DestinationProtocol(protocol))
	}
	return Policy{
		AllowedHosts:     hosts,
		AllowedPorts:     ports,
		AllowedProtocols: protocols,
		AllowNonLoopback: p.AllowNonLoopback,
		AllowLinkLocal:   p.AllowLinkLocal,
	}, nil
}

// Check evaluates one case and reports what disagreed, or an empty string.
func (c Corpus) Check(testCase CorpusCase) string {
	fixture, ok := c.Policies[testCase.Policy]
	if !ok {
		return fmt.Sprintf("the corpus names no policy %q", testCase.Policy)
	}
	built, err := fixture.Build()
	if err != nil {
		return err.Error()
	}
	rejection := built.Evaluate(Destination{
		Host:     testCase.Host,
		Port:     testCase.Port,
		Protocol: connectorv1.DestinationProtocol(testCase.Protocol),
	})
	if testCase.Expect == "allowed" {
		if rejection != nil {
			return fmt.Sprintf("the corpus allows this destination, the policy refused it as %q", rejection.Reason)
		}
		return ""
	}
	if rejection == nil {
		return fmt.Sprintf("the corpus refuses this destination as %q, the policy allowed it", testCase.Expect)
	}
	if string(rejection.Reason) != testCase.Expect {
		return fmt.Sprintf("refused as %q, the corpus requires %q", rejection.Reason, testCase.Expect)
	}
	if rejection.Class != connectorv1.ErrorClassDestinationNotAllowed {
		return fmt.Sprintf("wire error class %q, want DESTINATION_NOT_ALLOWED", rejection.Class)
	}
	return ""
}
