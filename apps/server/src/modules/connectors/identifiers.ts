/**
 * Opaque identifiers and the enrolment-token secret.
 *
 * `docs/DOMAIN_MODEL.md` §3: identifiers are opaque, must not encode tenant,
 * timestamp or database sequence, and their prefixes are a debugging
 * convenience only. Every value produced here also satisfies the protocol
 * schema's `identifier` bounds, so it can travel on the wire unchanged.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Random identifier body: 128 bits, base64url, no padding. */
function randomBody(): string {
  return randomBytes(16).toString("base64url");
}

export function newConnectorId(): string {
  return `con_${randomBody()}`;
}

export function newEnvironmentId(): string {
  return `env_${randomBody()}`;
}

export function newEnrolmentTokenId(): string {
  return `ent_${randomBody()}`;
}

export function newMessageId(): string {
  return `msg_${randomBody()}`;
}

export function newRequestId(): string {
  return `req_${randomBody()}`;
}

/**
 * A one-time enrolment token.
 *
 * 256 bits, base64url, which satisfies the schema's `enrolment_token` pattern
 * and length bounds. The value is returned to the administrator once and is
 * never stored: only `hashEnrolmentToken` output reaches the database.
 */
export function newEnrolmentToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashEnrolmentToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time string comparison for credentials. A length-dependent early
 * return would leak the credential length, so both sides are hashed first.
 */
export function secretsMatch(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
