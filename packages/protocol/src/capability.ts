/**
 * Session-scoped route capability codec.
 *
 * The capability is the bearer credential a browser session presents to the
 * tunnel gateway when it opens a stream on a published route
 * (`docs/SECURITY.md` section 9, `docs/ARCHITECTURE.md` section 7.3). The
 * schema already types the field: `session_capability`, `x-sensitive`, 16 to
 * 512 characters of `[A-Za-z0-9._~+/=-]`. What the schema cannot express is
 * the token's internal encoding, because the control plane mints it and the
 * tunnel gateway verifies it, in two different languages.
 *
 * This codec therefore lives beside the schema rather than in either service,
 * next to the other hand-written protocol runtime (frames, redaction,
 * canonical JSON). `fixtures/capability/v1/manifest.json` is the golden
 * corpus, and both language implementations assert against it, so a change
 * made in one language alone cannot land.
 *
 * Properties the product documents require, and where they are enforced:
 *
 * - Opaque to its bearer. The token is an authenticated blob; nothing but a
 *   holder of the signing key can read or forge its claims.
 * - Short-lived. `expiresAt` is inside the signed payload, so a verifier does
 *   not need a lookup to reject a stale capability.
 * - Bound to route, project and browser session. All three identifiers are
 *   signed, and the gateway compares each against the route it resolved from
 *   the request `Host`, which is what makes cross-project and route-confusion
 *   use a rejection rather than an audit note.
 * - Revocable immediately. `capabilityId` is signed so that the control plane
 *   can revoke one capability by identity without waiting for its expiry;
 *   revoking the route revokes every capability bound to it.
 *
 * The signing key is symmetric because Stage 0 runs one control plane and one
 * gateway inside a single trust zone (`docs/ARCHITECTURE.md` section 13, stage
 * 1). `keyId` is signed so that a deployment can rotate keys, and so a
 * multi-instance deployment can move to asymmetric signing by adding a scheme
 * without changing the token's shape.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { SensitiveString } from "./sensitive.ts";

/** Prefixes every route-capability token. */
export const CAPABILITY_SCHEME = "rp1";

/** Separates this MAC from any other use of the same key. */
export const CAPABILITY_MAC_DOMAIN = "reviewplane/route-capability/v1";

/** The only payload layout this build accepts. */
export const CAPABILITY_PAYLOAD_VERSION = 1;

/**
 * Bounds the key identifier so that the worst-case token stays inside the
 * schema's 512-character bound.
 */
export const MAX_CAPABILITY_KEY_ID_LENGTH = 32;

/** Mirrors the schema's identifier bound. */
export const MAX_CAPABILITY_IDENTIFIER_LENGTH = 64;

/**
 * The shortest key this codec will use. A shorter key is a configuration
 * error, not a weaker capability.
 */
export const MIN_CAPABILITY_SIGNING_KEY_BYTES = 32;

/** The schema bound on `session_capability`. */
export const MAX_CAPABILITY_TOKEN_LENGTH = 512;

/** The signed content of a route capability. */
export interface CapabilityClaims {
  /**
   * Selects the signing key. It is read before the MAC is checked, so it is
   * untrusted until verification succeeds; it selects a key and nothing else.
   */
  readonly keyId: string;
  /**
   * Identifies this capability so that it can be revoked individually and
   * referenced in audit events.
   */
  readonly capabilityId: string;
  /** The published service this capability authorises. */
  readonly routeId: string;
  /**
   * The owning project. A capability presented against a route in another
   * project is refused (`docs/SECURITY.md` section 9).
   */
  readonly projectId: string;
  /** The single browser session allowed to use it. */
  readonly browserSessionId: string;
  /** Unix seconds. */
  readonly issuedAt: number;
  /** Unix seconds. Capabilities always expire. */
  readonly expiresAt: number;
}

/**
 * Classifies a refused capability. The values are stable and appear in metrics
 * and audit payloads; they are never returned to the bearer, which receives
 * only the documented HTTP error code.
 */
export type CapabilityRejection =
  | "malformed"
  | "unsupported_version"
  | "unknown_key"
  | "bad_signature"
  | "expired";

/** Reports why a capability was refused. */
export class CapabilityError extends Error {
  readonly rejection: CapabilityRejection;

  constructor(rejection: CapabilityRejection, message: string) {
    super(`capability ${rejection}: ${message}`);
    this.name = "CapabilityError";
    this.rejection = rejection;
  }
}

/**
 * The symmetric signing keys a verifier accepts, keyed by key identifier. A
 * minting service holds exactly one active key; a verifier may hold several so
 * that a key can be rotated without invalidating capabilities already in
 * flight.
 */
export type CapabilityKeyring = ReadonlyMap<string, Uint8Array>;

function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function decodeBase64Url(text: string): Uint8Array | null {
  // Buffer.from is lenient: it ignores characters outside the alphabet rather
  // than failing. Re-encoding and comparing is what makes a malformed token a
  // rejection instead of a silently different payload.
  const bytes = new Uint8Array(Buffer.from(text, "base64url"));
  return encodeBase64Url(bytes) === text ? bytes : null;
}

function capabilityMac(key: Uint8Array, payload: Uint8Array): Uint8Array {
  const mac = createHmac("sha256", key);
  mac.update(CAPABILITY_MAC_DOMAIN, "utf8");
  mac.update(payload);
  return new Uint8Array(mac.digest());
}

function boundCapabilityField(name: string, value: string, maximum: number): void {
  if (value.length === 0) {
    throw new Error(`capability ${name} must not be empty`);
  }
  if (Buffer.byteLength(value, "utf8") > maximum) {
    throw new Error(`capability ${name} exceeds ${String(maximum)} bytes`);
  }
}

function appendField(parts: number[], value: string): void {
  const bytes = Buffer.from(value, "utf8");
  parts.push(bytes.length);
  for (const byte of bytes) parts.push(byte);
}

function appendUint64(parts: number[], value: number): void {
  const big = BigInt(value);
  for (let shift = 56n; shift >= 0n; shift -= 8n) {
    parts.push(Number((big >> shift) & 0xffn));
  }
}

function encodeCapabilityPayload(claims: CapabilityClaims): Uint8Array {
  boundCapabilityField("key_id", claims.keyId, MAX_CAPABILITY_KEY_ID_LENGTH);
  boundCapabilityField("capability_id", claims.capabilityId, MAX_CAPABILITY_IDENTIFIER_LENGTH);
  boundCapabilityField("route_id", claims.routeId, MAX_CAPABILITY_IDENTIFIER_LENGTH);
  boundCapabilityField("project_id", claims.projectId, MAX_CAPABILITY_IDENTIFIER_LENGTH);
  boundCapabilityField(
    "browser_session_id",
    claims.browserSessionId,
    MAX_CAPABILITY_IDENTIFIER_LENGTH,
  );
  if (!Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt)) {
    throw new Error("capability timestamps must be safe integers");
  }
  if (claims.issuedAt < 0 || claims.expiresAt < 0) {
    throw new Error("capability timestamps must not be negative");
  }
  if (claims.expiresAt <= claims.issuedAt) {
    throw new Error("capability must expire after it is issued");
  }
  const parts: number[] = [CAPABILITY_PAYLOAD_VERSION];
  appendField(parts, claims.keyId);
  appendUint64(parts, claims.issuedAt);
  appendUint64(parts, claims.expiresAt);
  appendField(parts, claims.capabilityId);
  appendField(parts, claims.routeId);
  appendField(parts, claims.projectId);
  appendField(parts, claims.browserSessionId);
  return Uint8Array.from(parts);
}

interface FieldRead {
  readonly value: string;
  readonly cursor: number;
}

function readField(payload: Uint8Array, cursor: number): FieldRead | null {
  if (cursor >= payload.length) return null;
  const length = payload[cursor] as number;
  const start = cursor + 1;
  if (start + length > payload.length) return null;
  return {
    value: Buffer.from(payload.subarray(start, start + length)).toString("utf8"),
    cursor: start + length,
  };
}

function readUint64(payload: Uint8Array, cursor: number): number {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value = (value << 8n) | BigInt(payload[cursor + index] as number);
  }
  return Number(value);
}

function decodeCapabilityPayload(payload: Uint8Array): CapabilityClaims {
  if (payload.length < 1) {
    throw new CapabilityError("malformed", "payload is empty");
  }
  if (payload[0] !== CAPABILITY_PAYLOAD_VERSION) {
    throw new CapabilityError(
      "unsupported_version",
      `payload version ${String(payload[0])} is not supported`,
    );
  }
  let cursor = 1;
  const keyId = readField(payload, cursor);
  if (keyId === null) throw new CapabilityError("malformed", "payload is truncated at key_id");
  cursor = keyId.cursor;
  if (cursor + 16 > payload.length) {
    throw new CapabilityError("malformed", "payload is truncated at the timestamps");
  }
  const issuedAt = readUint64(payload, cursor);
  const expiresAt = readUint64(payload, cursor + 8);
  cursor += 16;
  const capabilityId = readField(payload, cursor);
  if (capabilityId === null) {
    throw new CapabilityError("malformed", "payload is truncated at capability_id");
  }
  const routeId = readField(payload, capabilityId.cursor);
  if (routeId === null) throw new CapabilityError("malformed", "payload is truncated at route_id");
  const projectId = readField(payload, routeId.cursor);
  if (projectId === null) {
    throw new CapabilityError("malformed", "payload is truncated at project_id");
  }
  const browserSessionId = readField(payload, projectId.cursor);
  if (browserSessionId === null) {
    throw new CapabilityError("malformed", "payload is truncated at browser_session_id");
  }
  if (browserSessionId.cursor !== payload.length) {
    throw new CapabilityError("malformed", "payload carries trailing bytes");
  }
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) {
    throw new CapabilityError("malformed", "payload timestamps are out of range");
  }
  return {
    keyId: keyId.value,
    capabilityId: capabilityId.value,
    routeId: routeId.value,
    projectId: projectId.value,
    browserSessionId: browserSessionId.value,
    issuedAt,
    expiresAt,
  };
}

/**
 * Produces the wire token for a set of claims.
 *
 * The result is a {@link SensitiveString}: it is a bearer credential, so every
 * default representation of it is redacted (`docs/SECURITY.md` section 18).
 * Only the caller that puts it on the wire calls `reveal()`.
 */
export function mintCapability(key: Uint8Array, claims: CapabilityClaims): SensitiveString {
  if (key.length < MIN_CAPABILITY_SIGNING_KEY_BYTES) {
    throw new Error(
      `capability signing key must be at least ${String(MIN_CAPABILITY_SIGNING_KEY_BYTES)} bytes`,
    );
  }
  const payload = encodeCapabilityPayload(claims);
  const token = `${CAPABILITY_SCHEME}.${encodeBase64Url(payload)}.${encodeBase64Url(
    capabilityMac(key, payload),
  )}`;
  if (token.length > MAX_CAPABILITY_TOKEN_LENGTH) {
    throw new Error(
      `capability token of ${String(token.length)} characters exceeds the ` +
        `${String(MAX_CAPABILITY_TOKEN_LENGTH)} character schema bound`,
    );
  }
  return new SensitiveString(token);
}

/**
 * Authenticates a token and returns its claims.
 *
 * The order of the checks is a security property. Nothing in the payload is
 * returned to the caller until the MAC has been verified, so a forged token
 * cannot influence a routing or authorisation decision by being partially
 * parsed. Expiry is checked last, on claims that are already authentic.
 *
 * `nowUnix` is supplied by the caller rather than read from the clock so that
 * expiry arithmetic is testable and so a single request evaluates every
 * deadline against one instant.
 *
 * @throws CapabilityError when the token is not authentic or has expired.
 */
export function verifyCapability(
  keys: CapabilityKeyring,
  token: string,
  nowUnix: number,
): CapabilityClaims {
  if (token.length > MAX_CAPABILITY_TOKEN_LENGTH) {
    throw new CapabilityError(
      "malformed",
      `token of ${String(token.length)} characters exceeds the ` +
        `${String(MAX_CAPABILITY_TOKEN_LENGTH)} character bound`,
    );
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== CAPABILITY_SCHEME) {
    throw new CapabilityError("malformed", "token is not scheme.payload.signature");
  }
  const payload = decodeBase64Url(parts[1] as string);
  if (payload === null) throw new CapabilityError("malformed", "payload is not base64url");
  const mac = decodeBase64Url(parts[2] as string);
  if (mac === null) throw new CapabilityError("malformed", "signature is not base64url");
  const claims = decodeCapabilityPayload(payload);
  const key = keys.get(claims.keyId);
  if (key === undefined || key.length < MIN_CAPABILITY_SIGNING_KEY_BYTES) {
    // An unknown key identifier is refused without computing a MAC, so a caller
    // cannot use the timing of this path to probe for key material.
    throw new CapabilityError("unknown_key", "no signing key for the token's key identifier");
  }
  const expected = capabilityMac(key, payload);
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    throw new CapabilityError("bad_signature", "signature does not verify");
  }
  if (nowUnix >= claims.expiresAt) {
    throw new CapabilityError("expired", "capability expired");
  }
  return claims;
}
