// Package policy decides which local destinations a route may be published
// for.
//
// This is the SSRF control of docs/SECURITY.md section 9 applied at
// publication time, before any route exists. It runs in the gateway, and an
// equivalent runs in the control plane and in the connector
// (docs/CONNECTOR_PROTOCOL.md section 11), because a single check would be a
// single thing to get wrong. testdata/destination-policy.json is the shared
// corpus all of them are held to.
//
// Stage 0 accepts literal addresses only. A host name would require the
// gateway to resolve it, and a resolver is a rebinding surface: the name that
// passes the check need not be the address the connector later opens. The
// issue that introduces a DNS policy can revisit this; until then a name is
// refused rather than resolved.
package policy

import (
	"errors"
	"net/netip"
	"strconv"
	"strings"

	"github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
)

// Reason is a stable classification of a refused destination. It appears in
// audit payloads and metrics; the bearer of a request never sees more than the
// error class.
type Reason string

const (
	ReasonHostNotAddress    Reason = "host_is_not_a_literal_address"
	ReasonHostNotAllowed    Reason = "host_not_in_allow_list"
	ReasonNotLoopback       Reason = "host_is_not_loopback"
	ReasonLinkLocal         Reason = "host_is_link_local"
	ReasonMetadataEndpoint  Reason = "host_is_a_cloud_metadata_endpoint"
	ReasonUnspecified       Reason = "host_is_the_unspecified_address"
	ReasonMulticast         Reason = "host_is_multicast_or_broadcast"
	ReasonPortOutOfRange    Reason = "port_is_outside_the_valid_range"
	ReasonPortNotAllowed    Reason = "port_not_in_allow_list"
	ReasonProtocolNotAllowd Reason = "protocol_not_allowed"
)

// Rejection reports a refused destination.
type Rejection struct {
	Reason Reason
	// Class is always DESTINATION_NOT_ALLOWED: docs/SECURITY.md section 18
	// requires a stable code, and a caller learning which of the checks it
	// tripped is a probing oracle.
	Class connectorv1.ErrorClass
}

func (r *Rejection) Error() string {
	if r == nil {
		return "<nil>"
	}
	return "policy: destination refused: " + string(r.Reason)
}

func refuse(reason Reason) *Rejection {
	return &Rejection{Reason: reason, Class: connectorv1.ErrorClassDestinationNotAllowed}
}

// Destination is a candidate local target for a published route.
type Destination struct {
	Host     string
	Port     int
	Protocol connectorv1.DestinationProtocol
}

// PortRange is an inclusive range of allowed ports.
type PortRange struct {
	Low  int
	High int
}

// ParsePortRange reads "4321" or "3000-3999".
func ParsePortRange(text string) (PortRange, error) {
	text = strings.TrimSpace(text)
	low, high, found := strings.Cut(text, "-")
	if !found {
		port, err := strconv.Atoi(text)
		if err != nil || port < 1 || port > 65535 {
			return PortRange{}, errors.New("policy: " + text + " is not a port")
		}
		return PortRange{Low: port, High: port}, nil
	}
	lowPort, lowErr := strconv.Atoi(strings.TrimSpace(low))
	highPort, highErr := strconv.Atoi(strings.TrimSpace(high))
	if lowErr != nil || highErr != nil {
		return PortRange{}, errors.New("policy: " + text + " is not a port range")
	}
	if lowPort < 1 || highPort > 65535 || lowPort > highPort {
		return PortRange{}, errors.New("policy: port range " + text + " is not ordered inside 1-65535")
	}
	return PortRange{Low: lowPort, High: highPort}, nil
}

// ParsePortRanges reads a comma-separated list such as "3000-3999,4321,5173".
func ParsePortRanges(text string) ([]PortRange, error) {
	ranges := make([]PortRange, 0, 4)
	for _, part := range strings.Split(text, ",") {
		if strings.TrimSpace(part) == "" {
			continue
		}
		parsed, err := ParsePortRange(part)
		if err != nil {
			return nil, err
		}
		ranges = append(ranges, parsed)
	}
	if len(ranges) == 0 {
		return nil, errors.New("policy: no port range was configured")
	}
	return ranges, nil
}

// Policy is the configured destination allow-list.
//
// The zero value allows nothing, which is the deny-by-default principle of
// docs/SECURITY.md section 5 expressed in the type.
type Policy struct {
	// AllowedHosts holds literal addresses. Default: 127.0.0.1 and ::1.
	AllowedHosts []netip.Addr
	// AllowedPorts holds the port ranges a route may target.
	AllowedPorts []PortRange
	// AllowedProtocols holds the destination protocols a route may declare.
	AllowedProtocols []connectorv1.DestinationProtocol
	// AllowNonLoopback lifts the loopback requirement. It is the "explicit
	// high-risk mode" docs/CONFIGURATION.md section 4 demands before anything
	// widens the tunnel, and it never lifts the link-local or metadata bar.
	AllowNonLoopback bool
	// AllowLinkLocal permits link-local addresses. docs/SECURITY.md section 9
	// allows them only when explicitly configured; the cloud metadata address
	// stays refused regardless, because no development service listens there.
	AllowLinkLocal bool
}

// DefaultPolicy is the Stage 0 allow-list: loopback only, on the development
// server ports of docs/CONNECTOR_PROTOCOL.md section 20.
func DefaultPolicy() Policy {
	return Policy{
		AllowedHosts:     []netip.Addr{netip.MustParseAddr("127.0.0.1"), netip.MustParseAddr("::1")},
		AllowedPorts:     []PortRange{{Low: 3000, High: 3999}, {Low: 4321, High: 4321}, {Low: 5173, High: 5173}},
		AllowedProtocols: []connectorv1.DestinationProtocol{connectorv1.DestinationProtocolHTTP},
	}
}

// metadataAddresses are the cloud instance-metadata endpoints. They are named
// explicitly because reaching one from inside a development network is the
// canonical SSRF payoff, and because the IPv6 form is easy to forget.
var metadataAddresses = []netip.Addr{
	netip.MustParseAddr("169.254.169.254"),
	netip.MustParseAddr("fd00:ec2::254"),
	netip.MustParseAddr("169.254.170.2"),
}

// Evaluate decides whether a destination may be published.
//
// The checks that refuse an address run before the allow-list, so an operator
// cannot re-enable a metadata endpoint by naming it in AllowedHosts.
func (p Policy) Evaluate(destination Destination) *Rejection {
	address, err := netip.ParseAddr(destination.Host)
	if err != nil {
		return refuse(ReasonHostNotAddress)
	}
	address = address.Unmap()

	if address.IsUnspecified() {
		return refuse(ReasonUnspecified)
	}
	if address.IsMulticast() || address.IsInterfaceLocalMulticast() || address.IsLinkLocalMulticast() {
		return refuse(ReasonMulticast)
	}
	for _, metadata := range metadataAddresses {
		if address == metadata {
			return refuse(ReasonMetadataEndpoint)
		}
	}
	// IsLinkLocalUnicast covers 169.254.0.0/16 and fe80::/10, and Unmap above
	// makes an IPv4-mapped IPv6 form take the IPv4 branch.
	if address.IsLinkLocalUnicast() && !p.AllowLinkLocal {
		return refuse(ReasonLinkLocal)
	}
	if !address.IsLoopback() && !p.AllowNonLoopback {
		return refuse(ReasonNotLoopback)
	}

	if destination.Port < 1 || destination.Port > 65535 {
		return refuse(ReasonPortOutOfRange)
	}

	allowedHost := false
	for _, candidate := range p.AllowedHosts {
		if candidate.Unmap() == address {
			allowedHost = true
			break
		}
	}
	if !allowedHost {
		return refuse(ReasonHostNotAllowed)
	}

	allowedPort := false
	for _, portRange := range p.AllowedPorts {
		if destination.Port >= portRange.Low && destination.Port <= portRange.High {
			allowedPort = true
			break
		}
	}
	if !allowedPort {
		return refuse(ReasonPortNotAllowed)
	}

	allowedProtocol := false
	for _, candidate := range p.AllowedProtocols {
		if candidate == destination.Protocol {
			allowedProtocol = true
			break
		}
	}
	if !allowedProtocol {
		return refuse(ReasonProtocolNotAllowd)
	}
	return nil
}

// ParseHosts reads a comma-separated list of literal addresses.
func ParseHosts(text string) ([]netip.Addr, error) {
	addresses := make([]netip.Addr, 0, 2)
	for _, part := range strings.Split(text, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		address, err := netip.ParseAddr(part)
		if err != nil {
			return nil, errors.New("policy: " + part + " is not a literal address; Stage 0 does not resolve names")
		}
		addresses = append(addresses, address.Unmap())
	}
	if len(addresses) == 0 {
		return nil, errors.New("policy: no allowed host was configured")
	}
	return addresses, nil
}
