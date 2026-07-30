/**
 * The publication-time destination policy, control-plane side.
 *
 * This is the same decision the tunnel gateway makes in
 * `services/tunnel-gateway/policy` and the connector makes in
 * `docs/CONNECTOR_PROTOCOL.md` section 11. Three implementations sounds like
 * duplication; it is the defence in depth `docs/SECURITY.md` section 9 asks
 * for, because a control plane that had been persuaded to publish a metadata
 * endpoint must still be refused by the gateway, and a gateway that had been
 * misconfigured must still be refused by the connector.
 *
 * What stops the three drifting is that they share one corpus:
 * `services/tunnel-gateway/testdata/destination-policy.json`. Both this
 * implementation and the Go one run it, so a case only one of them refuses
 * fails the build.
 *
 * Stage 0 accepts literal addresses only. A host name would have to be
 * resolved, and a resolver is a rebinding surface: the name that passes the
 * check need not be the address the connector later opens.
 */

import { isIPv4, isIPv6 } from "node:net";

/** Stable classification of a refused destination. */
export type DestinationRejection =
  | "host_is_not_a_literal_address"
  | "host_not_in_allow_list"
  | "host_is_not_loopback"
  | "host_is_link_local"
  | "host_is_a_cloud_metadata_endpoint"
  | "host_is_the_unspecified_address"
  | "host_is_multicast_or_broadcast"
  | "port_is_outside_the_valid_range"
  | "port_not_in_allow_list"
  | "protocol_not_allowed";

export interface PortRange {
  readonly low: number;
  readonly high: number;
}

export interface DestinationPolicy {
  /** Literal addresses, already normalised by {@link normaliseAddress}. */
  readonly allowedHosts: readonly string[];
  readonly allowedPorts: readonly PortRange[];
  readonly allowedProtocols: readonly string[];
  /** The explicit high-risk mode of `docs/CONFIGURATION.md` section 4. */
  readonly allowNonLoopback: boolean;
  /** Permits link-local targets. Never permits a metadata endpoint. */
  readonly allowLinkLocal: boolean;
}

export interface Destination {
  readonly host: string;
  readonly port: number;
  readonly protocol: string;
}

/** The Stage 0 allow-list, matching `docs/CONNECTOR_PROTOCOL.md` section 20. */
export const STAGE_0_DESTINATION_POLICY: DestinationPolicy = {
  allowedHosts: ["127.0.0.1", "::1"],
  allowedPorts: [
    { low: 3000, high: 3999 },
    { low: 4321, high: 4321 },
    { low: 5173, high: 5173 },
  ],
  allowedProtocols: ["http"],
  allowNonLoopback: false,
  allowLinkLocal: false,
};

/**
 * The cloud instance-metadata endpoints, named explicitly because reaching one
 * from inside a development network is the canonical SSRF payoff, and because
 * the IPv6 form is easy to forget.
 */
const METADATA_ADDRESSES = new Set(["169.254.169.254", "169.254.170.2", "fd00:ec2::254"]);

/**
 * Normalises a literal address so that two spellings of one address compare
 * equal. Returns null for anything that is not a literal address.
 *
 * The IPv4-mapped IPv6 form is unmapped, because otherwise `::ffff:127.0.0.1`
 * would be a different string from `127.0.0.1` and an allow-list check on the
 * text would be a bypass.
 */
export function normaliseAddress(host: string): string | null {
  const trimmed = host.trim();
  if (isIPv4(trimmed)) {
    return trimmed.split(".").map((part) => String(Number(part))).join(".");
  }
  if (!isIPv6(trimmed)) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(trimmed);
  if (mapped !== null && isIPv4(mapped[1] as string)) {
    return normaliseAddress(mapped[1] as string);
  }
  return expandIPv6(trimmed);
}

/** Renders an IPv6 address as eight lowercase hextets, so text compares. */
function expandIPv6(address: string): string | null {
  const [head, tail] = address.toLowerCase().split("::") as [string, string | undefined];
  const headParts = head === "" ? [] : head.split(":");
  const tailParts = tail === undefined || tail === "" ? [] : tail.split(":");
  if (tail === undefined) {
    if (headParts.length !== 8) return null;
    return headParts.map(padHextet).join(":");
  }
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0) return null;
  return [...headParts, ...Array<string>(missing).fill("0"), ...tailParts].map(padHextet).join(":");
}

function padHextet(part: string): string {
  return part.replace(/^0+(?=.)/u, "").padStart(4, "0");
}

function isLoopback(address: string): boolean {
  return address.startsWith("127.") || address === "0000:0000:0000:0000:0000:0000:0000:0001";
}

function isUnspecified(address: string): boolean {
  return address === "0.0.0.0" || address === "0000:0000:0000:0000:0000:0000:0000:0000";
}

function isLinkLocal(address: string): boolean {
  if (address.startsWith("169.254.")) return true;
  const firstHextet = Number.parseInt(address.slice(0, 4), 16);
  return address.includes(":") && firstHextet >= 0xfe80 && firstHextet <= 0xfebf;
}

function isMulticast(address: string): boolean {
  if (isIPv4(address)) {
    const first = Number(address.split(".")[0]);
    return first >= 224 && first <= 239;
  }
  return address.startsWith("ff");
}

/** Parses "4321" or "3000-3999". */
export function parsePortRange(text: string): PortRange {
  const trimmed = text.trim();
  const parts = trimmed.split("-");
  if (parts.length === 1) {
    const port = Number(parts[0]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`${trimmed} is not a port`);
    }
    return { low: port, high: port };
  }
  if (parts.length !== 2) throw new Error(`${trimmed} is not a port range`);
  const low = Number((parts[0] as string).trim());
  const high = Number((parts[1] as string).trim());
  if (!Number.isInteger(low) || !Number.isInteger(high) || low < 1 || high > 65535 || low > high) {
    throw new Error(`${trimmed} is not an ordered port range inside 1-65535`);
  }
  return { low, high };
}

/**
 * Decides whether a destination may be published.
 *
 * The checks that refuse an address run before the allow-list, so an operator
 * cannot re-enable a metadata endpoint by naming it in `allowedHosts`.
 */
export function evaluateDestination(
  policy: DestinationPolicy,
  destination: Destination,
): DestinationRejection | null {
  const address = normaliseAddress(destination.host);
  if (address === null) return "host_is_not_a_literal_address";

  if (isUnspecified(address)) return "host_is_the_unspecified_address";
  if (isMulticast(address)) return "host_is_multicast_or_broadcast";
  if (METADATA_ADDRESSES.has(destination.host.trim().toLowerCase())) {
    return "host_is_a_cloud_metadata_endpoint";
  }
  for (const metadata of METADATA_ADDRESSES) {
    if (normaliseAddress(metadata) === address) return "host_is_a_cloud_metadata_endpoint";
  }
  if (isLinkLocal(address) && !policy.allowLinkLocal) return "host_is_link_local";
  if (!isLoopback(address) && !policy.allowNonLoopback) return "host_is_not_loopback";

  if (!Number.isInteger(destination.port) || destination.port < 1 || destination.port > 65535) {
    return "port_is_outside_the_valid_range";
  }
  if (!policy.allowedHosts.some((allowed) => normaliseAddress(allowed) === address)) {
    return "host_not_in_allow_list";
  }
  if (!policy.allowedPorts.some((range) => destination.port >= range.low && destination.port <= range.high)) {
    return "port_not_in_allow_list";
  }
  if (!policy.allowedProtocols.includes(destination.protocol)) return "protocol_not_allowed";
  return null;
}
