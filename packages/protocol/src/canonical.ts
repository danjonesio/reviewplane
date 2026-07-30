/**
 * Canonical JSON primitives.
 *
 * The connector protocol is spoken by a TypeScript control plane and a Go
 * connector and gateway. Contract tests compare both implementations against
 * one committed corpus, so the two encoders must agree on every byte. These
 * helpers pin the parts where the two runtimes would otherwise differ:
 * U+2028 and U+2029 are escaped (Go's encoder always escapes them), and no
 * HTML escaping is applied (Go's encoder is configured the same way).
 */

import { Buffer } from "node:buffer";

export class CanonicalEncodeError extends Error {}

const LINE_SEPARATORS = /[\u2028\u2029]/gu;

/** Encodes a JSON string exactly as the Go canonical writer does. */
export function jsonString(value: string): string {
  return JSON.stringify(value).replace(LINE_SEPARATORS, (match) =>
    match === "\u2028" ? "\\u2028" : "\\u2029",
  );
}

/** Encodes a validated integer. */
export function jsonInteger(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new CanonicalEncodeError(`value ${String(value)} is not a safe integer`);
  }
  return String(value);
}

/** Encodes a validated finite number. */
export function jsonNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalEncodeError(`value ${String(value)} is not finite`);
  }
  return String(value);
}

/** Encodes a boolean. */
export function jsonBoolean(value: boolean): string {
  return value ? "true" : "false";
}

/** UTF-8 byte length. Frame bounds are byte bounds, not character bounds. */
export function byteLength(value: string | Uint8Array): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  return value.byteLength;
}
