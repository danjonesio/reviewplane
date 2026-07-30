/**
 * The bind-address guard.
 *
 * `docs/SECURITY.md` and `docs/CONNECTOR_PROTOCOL.md` section 11 both rest on
 * the development service being reachable only from the development machine
 * itself: the connector dials loopback outbound, and nothing inbound is opened.
 * A fixture that quietly bound `0.0.0.0` would still pass every tunnel test
 * while destroying the property the tunnel exists to preserve, so the mistake
 * is made impossible here rather than caught by review.
 */

import { BlockList, isIPv4, isIPv6 } from "node:net";

/**
 * `127.0.0.0/8`, `::1` and the IPv4-mapped loopback range. Using `BlockList`
 * rather than string comparison means every textual spelling of an address
 * normalises the same way, so `0:0:0:0:0:0:0:1` cannot slip past a check that
 * only knew about `::1`.
 */
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");
LOOPBACK.addSubnet("::ffff:127.0.0.0", 104, "ipv6");

/** True when `host` is a literal loopback address. Names are never literal. */
export function isLoopbackAddress(host: string): boolean {
  const address = host.trim().replace(/^\[|\]$/gu, "");
  if (isIPv4(address)) {
    return LOOPBACK.check(address, "ipv4");
  }
  if (isIPv6(address)) {
    return LOOPBACK.check(address, "ipv6");
  }
  return false;
}

/**
 * Throws unless `host` is a literal loopback address.
 *
 * A name such as `localhost` is refused rather than resolved, matching the
 * destination policy in `apps/server/src/modules/published-services`: the name
 * that passes a check need not be the address that is later opened, so the
 * fixture accepts only what it can verify without a resolver.
 */
export function assertLoopbackBindAddress(host: string): void {
  if (isLoopbackAddress(host)) {
    return;
  }
  throw new Error(
    `refusing to bind the dev fixture to ${JSON.stringify(host)}: the fixture MUST bind a ` +
      `literal loopback address (127.0.0.0/8 or ::1). The connector reaches this service ` +
      `outbound over loopback and the development machine opens no inbound port; binding ` +
      `anything else — including 0.0.0.0 or a name such as "localhost" — would publish the ` +
      `application to the network. Set HOST to 127.0.0.1 or ::1.`,
  );
}
