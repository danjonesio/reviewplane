/**
 * Opaque identifiers.
 *
 * `docs/DOMAIN_MODEL.md` section 3 requires identifiers that encode no tenant,
 * timestamp meaning or security-sensitive data and that consumers treat as
 * opaque. The prefix is a debugging convenience only: the protocol schema
 * bounds length and character class and never requires it.
 */

import { randomBytes } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${randomBytes(10).toString("hex")}`;
}
