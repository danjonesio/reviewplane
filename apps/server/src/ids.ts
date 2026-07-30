/**
 * Opaque identifiers (`docs/DOMAIN_MODEL.md` section 3).
 *
 * The generator lives in `@reviewplane/protocol/platform`, so the control
 * plane, the MCP server and any Go component mint the same shape from one
 * definition rather than from three that happen to agree.
 *
 * Stage 0 built the suffix from `Date.now().toString(36)` plus randomness, which
 * made every identifier carry its creation time in its leading characters — the
 * one thing section 3 says an identifier must not encode, and something a
 * consumer sorting by identifier would have come to rely on. The suffix is now
 * 128 bits of randomness and nothing else.
 */

import { newPrefixedId } from "@reviewplane/protocol/platform";

export { entityPrefix, isEntityId, newEntityId } from "@reviewplane/protocol/platform";

/**
 * Mints an identifier with a literal prefix, including its underscore.
 *
 * `newEntityId` is preferred where the entity kind is one the schema names,
 * because it reads the prefix from the schema instead of repeating it.
 */
export function newId(prefix: string): string {
  return newPrefixedId(prefix);
}
