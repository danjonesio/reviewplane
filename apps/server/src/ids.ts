/**
 * Opaque identifiers (`docs/DOMAIN_MODEL.md` section 3). The prefix is a
 * debugging convenience; nothing validates it, and no identifier encodes
 * tenant or security-sensitive data.
 */

import { randomBytes } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${randomBytes(10).toString("hex")}`;
}
