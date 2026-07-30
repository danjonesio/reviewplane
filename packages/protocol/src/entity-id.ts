/**
 * Entity identifiers (`docs/DOMAIN_MODEL.md` section 3).
 *
 * Two rules make this a shared module rather than a one-line helper in each
 * service.
 *
 * **An identifier encodes nothing.** The document forbids encoding tenant,
 * timestamp, database sequence or security-sensitive data in an identifier, and
 * a consumer that could read a creation time out of one would come to depend on
 * it. The suffix here is 128 bits from the platform's cryptographic random
 * source and nothing else: two identifiers minted a second apart sort no
 * differently from two minted a year apart.
 *
 * **A prefix is a debugging convenience, never a check.** `IDENTIFIER_PREFIXES`
 * in the generated models records the conventional prefix for each entity kind,
 * and {@link isEntityId} validates length and character class alone. Nothing in
 * this package, and nothing that reads it, may require a particular prefix — the
 * schema bounds the shape and the database owns the meaning.
 */

import { IDENTIFIER_PREFIXES } from "./generated/platform/v1/types.ts";

/** Bytes of randomness behind every identifier. */
const RANDOM_BYTES = 16;

/** Bounds from `$defs.identifier` in `schemas/platform/v1.schema.json`. */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

export class EntityIdError extends Error {}

/**
 * The entity kinds this package names a conventional prefix for.
 *
 * It is derived from the schema rather than restated, so a kind added to
 * `x-protocol.identifier_prefixes` is immediately callable here and a kind
 * removed from it stops compiling.
 */
export type EntityKind = keyof typeof IDENTIFIER_PREFIXES & string;

/** The conventional prefix for an entity kind, including its underscore. */
export function entityPrefix(kind: EntityKind): string {
  const prefix = IDENTIFIER_PREFIXES[kind];
  if (prefix === undefined) {
    throw new EntityIdError(`no identifier prefix is declared for the entity kind ${kind}`);
  }
  return prefix;
}

function randomSuffix(): string {
  const bytes = new Uint8Array(RANDOM_BYTES);
  // `globalThis.crypto` rather than `node:crypto`: this module is imported by
  // `apps/web` as well as by the server, and nothing on that path may depend on
  // a Node built-in.
  globalThis.crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Mints an identifier with the conventional prefix for an entity kind.
 *
 * ```ts
 * newEntityId("review"); // "rev_7f3c…"
 * ```
 */
export function newEntityId(kind: EntityKind): string {
  return `${entityPrefix(kind)}${randomSuffix()}`;
}

/**
 * Mints an identifier with a literal prefix.
 *
 * It exists for the identifiers a schema source names but this package does not
 * — a connector message identifier, for example. The prefix is not validated
 * against the vocabulary, because validating a prefix is exactly what
 * `docs/DOMAIN_MODEL.md` section 3 forbids a consumer from doing.
 */
export function newPrefixedId(prefix: string): string {
  const candidate = `${prefix}${randomSuffix()}`;
  if (!IDENTIFIER_PATTERN.test(candidate)) {
    throw new EntityIdError(
      `prefix ${JSON.stringify(prefix)} produces an identifier outside the schema's character class`,
    );
  }
  return candidate;
}

/**
 * Whether a value satisfies the identifier bounds of the schema.
 *
 * Length and character class only. A caller that wants to know what an
 * identifier refers to must ask the database, not the string.
 */
export function isEntityId(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}
