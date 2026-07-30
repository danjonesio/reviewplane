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

/**
 * UTF-8 byte length. Frame bounds are byte bounds, not character bounds.
 *
 * Counted rather than measured with `Buffer.byteLength`, because the web
 * application speaks the live-view protocol in a browser where `node:buffer`
 * does not exist, and because counting allocates nothing on a path that runs
 * once per frame. A lone surrogate counts as three bytes, which is what both
 * `Buffer.byteLength` and `TextEncoder` produce for the replacement character
 * they substitute.
 */
export function byteLength(value: string | Uint8Array): number {
  if (typeof value !== "string") return value.byteLength;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
