/**
 * Validation primitives used by the generated validators.
 *
 * Every bound applied here is supplied by the generated caller as a literal
 * taken from the schema, so the schema remains the only place a bound is
 * declared. The Go package mirrors this file function for function; contract
 * tests assert that both reject the same corpus for the same reasons.
 */

import type { SchemaViolation } from "./generated/connector/v1/types.ts";

const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/**
 * String bounds are counted in Unicode code points, matching JSON Schema's
 * definition of string length and Go's `utf8.RuneCountInString`. Counting
 * UTF-16 code units instead would make the two languages disagree about
 * astral-plane characters.
 */
function codePointLength(value: string): number {
  let count = 0;
  for (const _codePoint of value) count += 1;
  return count;
}

function report(
  out: SchemaViolation[],
  path: string,
  code: SchemaViolation["code"],
  message: string,
): void {
  out.push({ path, code, message });
}

export interface StringOptions {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: RegExp;
  readonly values?: readonly string[];
}

export function checkString(
  value: unknown,
  path: string,
  out: SchemaViolation[],
  options: StringOptions,
): value is string {
  if (typeof value !== "string") {
    report(out, path, "type", "expected a string");
    return false;
  }
  if (options.values !== undefined) {
    if (!options.values.includes(value)) {
      report(out, path, "enum", `expected one of ${options.values.join(", ")}`);
      return false;
    }
    return true;
  }
  if (LONE_SURROGATE.test(value)) {
    report(out, path, "pattern", "string contains an unpaired surrogate");
    return false;
  }
  const length = codePointLength(value);
  if (options.maxLength !== undefined && length > options.maxLength) {
    report(out, path, "too_long", `longer than ${String(options.maxLength)} characters`);
    return false;
  }
  if (options.minLength !== undefined && length < options.minLength) {
    report(out, path, "too_short", `shorter than ${String(options.minLength)} characters`);
    return false;
  }
  if (options.pattern !== undefined && !options.pattern.test(value)) {
    report(out, path, "pattern", "does not match the permitted character class");
    return false;
  }
  return true;
}

export function checkInteger(
  value: unknown,
  path: string,
  out: SchemaViolation[],
  bounds: { readonly minimum: number; readonly maximum: number },
): value is number {
  if (typeof value !== "number") {
    report(out, path, "type", "expected an integer");
    return false;
  }
  if (!Number.isInteger(value)) {
    report(out, path, "not_integer", "expected an integer, not a fractional number");
    return false;
  }
  if (value < bounds.minimum) {
    report(out, path, "too_small", `below the minimum of ${String(bounds.minimum)}`);
    return false;
  }
  if (value > bounds.maximum) {
    report(out, path, "too_large", `above the maximum of ${String(bounds.maximum)}`);
    return false;
  }
  return true;
}

export function checkNumber(
  value: unknown,
  path: string,
  out: SchemaViolation[],
  bounds: { readonly minimum: number; readonly maximum: number },
): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    report(out, path, "type", "expected a finite number");
    return false;
  }
  if (value < bounds.minimum) {
    report(out, path, "too_small", `below the minimum of ${String(bounds.minimum)}`);
    return false;
  }
  if (value > bounds.maximum) {
    report(out, path, "too_large", `above the maximum of ${String(bounds.maximum)}`);
    return false;
  }
  return true;
}

export function checkBoolean(
  value: unknown,
  path: string,
  out: SchemaViolation[],
): value is boolean {
  if (typeof value !== "boolean") {
    report(out, path, "type", "expected a boolean");
    return false;
  }
  return true;
}

export function checkArray(
  value: unknown,
  path: string,
  out: SchemaViolation[],
  bounds: {
    readonly minItems: number;
    readonly maxItems: number;
    readonly uniqueItems: boolean;
  },
): value is unknown[] {
  if (!Array.isArray(value)) {
    report(out, path, "type", "expected an array");
    return false;
  }
  if (value.length > bounds.maxItems) {
    report(out, path, "too_many_items", `more than ${String(bounds.maxItems)} items`);
    return false;
  }
  if (value.length < bounds.minItems) {
    report(out, path, "too_few_items", `fewer than ${String(bounds.minItems)} items`);
    return false;
  }
  if (bounds.uniqueItems) {
    const seen = new Set<string>();
    for (const item of value) {
      const key = typeof item === "string" ? item : JSON.stringify(item);
      if (seen.has(key)) {
        report(out, path, "duplicate_items", "items must be unique");
        return false;
      }
      seen.add(key);
    }
  }
  return true;
}

export function checkPlainObject(
  value: unknown,
  path: string,
  out: SchemaViolation[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    report(out, path, "type", "expected an object");
    return false;
  }
  return true;
}

/**
 * Checks object shape: rejects unknown properties, because every schema object
 * declares `additionalProperties: false`, and reports missing required ones.
 */
export function checkObject(
  value: unknown,
  path: string,
  out: SchemaViolation[],
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> | null {
  if (!checkPlainObject(value, path, out)) return null;
  const source = value;
  // Sorted so that the two languages report the same violations in the same
  // order for the same input.
  for (const key of Object.keys(source).sort()) {
    if (!allowed.includes(key)) {
      report(out, `${path}.${key}`, "unknown_property", "unknown property");
    }
  }
  for (const key of required) {
    if (source[key] === undefined) {
      report(out, `${path}.${key}`, "required", "required property is missing");
    }
  }
  return source;
}

export function matchesCondition(value: unknown, values: readonly string[]): boolean {
  return typeof value === "string" && values.includes(value);
}

export function requireProperty(
  source: Record<string, unknown>,
  path: string,
  name: string,
  detail: string,
  out: SchemaViolation[],
): void {
  if (source[name] === undefined) {
    report(out, `${path}.${name}`, "required", `required here because ${detail}`);
  }
}

export function forbidProperty(
  source: Record<string, unknown>,
  path: string,
  name: string,
  detail: string,
  out: SchemaViolation[],
): void {
  if (source[name] !== undefined) {
    report(out, `${path}.${name}`, "forbidden", `not permitted here because ${detail}`);
  }
}
