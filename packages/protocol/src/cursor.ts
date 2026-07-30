/**
 * Opaque pagination cursors (`docs/API.md` section 6).
 *
 * A cursor is base64url text carrying the canonical encoding of
 * `cursor_claims`: the sort key and the identifier of the last row of the
 * previous page. Encoding it through the generated canonical encoder is what
 * makes the TypeScript and Go implementations produce the same bytes for the
 * same page, which is the property the contract corpus asserts.
 *
 * "Opaque" is a contract on the client, not an encryption claim: the value is
 * readable by anyone who base64-decodes it and carries nothing a caller could
 * not already see in the page it came from. What the opacity buys is freedom to
 * change the pagination key without breaking a client, and the right to refuse a
 * cursor this server did not produce rather than to interpret it charitably.
 */

import { byteLength } from "./canonical.ts";
import { decodeCursorClaims } from "./generated/platform/v1/decode.ts";
import { encodeCursorClaims } from "./generated/platform/v1/encode.ts";
import { LIMITS, type CursorClaims, type SchemaViolation } from "./generated/platform/v1/types.ts";
import { validateCursorClaims } from "./generated/platform/v1/validate.ts";

/** The only cursor format this build produces or accepts. */
export const CURSOR_VERSION = 1;

/** Bound on the encoded cursor, from `$defs.cursor` in the schema source. */
const MAX_CURSOR_LENGTH = 512;

export class CursorError extends Error {}

export type CursorResult =
  | { readonly ok: true; readonly value: CursorClaims }
  | { readonly ok: false; readonly reason: CursorRejection };

/** Why a cursor was refused. Stable, so a caller can act on it. */
export type CursorRejection =
  | "malformed_encoding"
  | "malformed_json"
  | "schema_violation"
  | "unsupported_version"
  | "too_long";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(text: string): Uint8Array | null {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

/** Encodes the position after the last row of a page. */
export function encodeCursor(claims: CursorClaims): string {
  if (claims.version !== CURSOR_VERSION) {
    throw new CursorError(`cursor version ${String(claims.version)} is not ${String(CURSOR_VERSION)}`);
  }
  const violations: SchemaViolation[] = [];
  validateCursorClaims(claims, "$", violations);
  if (violations.length > 0) {
    throw new CursorError(
      `cursor claims do not satisfy the schema: ${violations.map((violation) => `${violation.path} ${violation.message}`).join("; ")}`,
    );
  }
  const canonical = encodeCursorClaims(claims);
  if (byteLength(canonical) > LIMITS.MAX_STREAM_MESSAGE_BYTES) {
    throw new CursorError("cursor claims exceed the message bound");
  }
  const encoded = toBase64Url(new TextEncoder().encode(canonical));
  if (encoded.length > MAX_CURSOR_LENGTH) {
    throw new CursorError(`cursor of ${String(encoded.length)} characters exceeds the bound`);
  }
  return encoded;
}

/**
 * Decodes a cursor a caller presented.
 *
 * Every failure is a refusal rather than a fallback to the first page: a caller
 * that sends a cursor this server did not produce is asking for a page nobody
 * can define, and silently answering with a different one would make pagination
 * lose rows without saying so.
 */
export function decodeCursor(text: string): CursorResult {
  if (text.length > MAX_CURSOR_LENGTH) return { ok: false, reason: "too_long" };
  const bytes = fromBase64Url(text);
  if (bytes === null) return { ok: false, reason: "malformed_encoding" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return { ok: false, reason: "malformed_json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "schema_violation" };
  }
  const source = parsed as Record<string, unknown>;
  if (source["version"] !== CURSOR_VERSION) return { ok: false, reason: "unsupported_version" };
  const violations: SchemaViolation[] = [];
  validateCursorClaims(source, "$", violations);
  if (violations.length > 0) return { ok: false, reason: "schema_violation" };
  return { ok: true, value: decodeCursorClaims(source) };
}
