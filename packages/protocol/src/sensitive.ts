/**
 * Wrapper for protocol fields the schema marks `x-sensitive`.
 *
 * `docs/SECURITY.md` section 18 forbids raw credentials in logs. Every default
 * representation of this type is redacted: `String()`, template interpolation,
 * `JSON.stringify` and Node's `util.inspect` all yield the redaction marker.
 * The real value is reachable only through the explicit `reveal()` call, which
 * the generated canonical encoders use when they build a wire frame.
 */

export const REDACTED = "[redacted]";

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

export class SensitiveString {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** Returns the underlying secret. Only wire encoding may call this. */
  reveal(): string {
    return this.#value;
  }

  /** Length of the underlying secret, safe to log. */
  get length(): number {
    return this.#value.length;
  }

  /** Redacted. Covers `String(value)` and template interpolation. */
  toString(): string {
    return REDACTED;
  }

  /** Redacted. Covers `JSON.stringify`, including logger serialisation. */
  toJSON(): string {
    return REDACTED;
  }

  /** Redacted. Covers `console.log` and `util.inspect`. */
  [INSPECT](): string {
    return REDACTED;
  }
}

/** Type guard used by hand-written code that accepts either form. */
export function isSensitiveString(value: unknown): value is SensitiveString {
  return value instanceof SensitiveString;
}
