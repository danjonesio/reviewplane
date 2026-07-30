/**
 * Local password verifiers (`docs/SECURITY.md` section 6.1: "strong password
 * hashing").
 *
 * scrypt, from Node's own `crypto`. It is memory-hard, which is the property
 * that matters: a GPU or an ASIC gains far less against it than against a fast
 * hash, and an attacker who obtains this database is doing an offline attack by
 * definition. Choosing it over Argon2id is a deliberate trade: Argon2id would
 * be marginally stronger and would add a native dependency to every image the
 * product ships, and `docs/SECURITY.md` section 19 asks for a supply chain that
 * can be reasoned about. A stored verifier records the parameters it was
 * written with, so raising them later is a configuration change and old rows
 * keep verifying.
 *
 * Three rules the rest of the server depends on:
 *
 *   * a verifier is self-describing — `scrypt$N=…,r=…,p=…$salt$digest` — so
 *     nothing has to remember which parameters produced which row;
 *   * comparison is constant time, over equal-length buffers;
 *   * neither a password nor a verifier is ever returned, logged or attached to
 *     an error (`docs/SECURITY.md` section 18). The failures here name the rule
 *     that was broken and never the value that broke it.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import type { ScryptOptions } from "node:crypto";

/**
 * `scrypt` as a promise. Written out rather than promisified so that the
 * options argument keeps its type: the work factors are the security property
 * here, and a signature that silently dropped them would be the kind of defect
 * nothing else would notice.
 */
async function scrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derived) => {
      if (error !== null) reject(error);
      else resolve(derived as Buffer);
    });
  });
}

/**
 * Work factors. `N` is the cost parameter; 32768 with `r = 8` needs 32 MiB per
 * hash, which is the widely published interactive-login setting and the point
 * where a commodity server still answers a login in about a tenth of a second.
 */
export const SCRYPT_PARAMETERS = { N: 32_768, r: 8, p: 1 } as const;

/** Derived key length in bytes. */
const KEY_LENGTH = 32;

/** Salt length in bytes. Per verifier, never reused. */
const SALT_LENGTH = 16;

/**
 * Node's default `maxmem` is 32 MiB, which the parameters above sit exactly on
 * top of; the allowance is doubled so the call cannot fail on an off-by-one in
 * Node's own accounting.
 */
const MAX_MEMORY_BYTES = 128 * SCRYPT_PARAMETERS.N * SCRYPT_PARAMETERS.r * 2;

/**
 * Shortest password accepted.
 *
 * Length is the only composition rule. Character-class rules push people to
 * predictable substitutions and are no longer recommended by any current
 * guidance; twelve characters with no other constraint is both stronger in
 * practice and possible to satisfy with a passphrase.
 */
export const MINIMUM_PASSWORD_LENGTH = 12;

/** Longest password accepted, so an enormous body cannot buy expensive work. */
export const MAXIMUM_PASSWORD_LENGTH = 256;

export type PasswordPolicyFailure = "too_short" | "too_long" | "not_a_string" | "contains_control_characters";

export type PasswordPolicyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: PasswordPolicyFailure; readonly message: string };

/** Checks a candidate password against the policy. It never returns the value. */
export function checkPasswordPolicy(candidate: unknown): PasswordPolicyResult {
  if (typeof candidate !== "string") {
    return { ok: false, reason: "not_a_string", message: "A password must be text." };
  }
  // eslint-disable-next-line no-control-regex -- refusing them is the point
  if (/[\u0000-\u001f\u007f]/u.test(candidate)) {
    return {
      ok: false,
      reason: "contains_control_characters",
      message: "A password must not contain control characters.",
    };
  }
  if (candidate.length < MINIMUM_PASSWORD_LENGTH) {
    return {
      ok: false,
      reason: "too_short",
      message: `A password must be at least ${String(MINIMUM_PASSWORD_LENGTH)} characters. Length is the only rule; a passphrase satisfies it.`,
    };
  }
  if (candidate.length > MAXIMUM_PASSWORD_LENGTH) {
    return {
      ok: false,
      reason: "too_long",
      message: `A password must be at most ${String(MAXIMUM_PASSWORD_LENGTH)} characters.`,
    };
  }
  return { ok: true };
}

/** Produces the stored verifier for a password. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await derive(password, salt, SCRYPT_PARAMETERS);
  return [
    "scrypt",
    `N=${String(SCRYPT_PARAMETERS.N)},r=${String(SCRYPT_PARAMETERS.r)},p=${String(SCRYPT_PARAMETERS.p)}`,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

/**
 * Verifies a password against a stored verifier.
 *
 * A malformed verifier answers false rather than throwing: a corrupt row must
 * refuse a login, not turn every login into a server error.
 */
export async function verifyPassword(password: string, verifier: string): Promise<boolean> {
  const parsed = parseVerifier(verifier);
  if (parsed === null) return false;
  let derived: Buffer;
  try {
    derived = await derive(password, parsed.salt, parsed.parameters);
  } catch {
    return false;
  }
  if (derived.length !== parsed.digest.length) return false;
  return timingSafeEqual(derived, parsed.digest);
}

/** The parameters a verifier was written with, for tests and diagnostics. */
export function verifierParameters(
  verifier: string,
): { readonly algorithm: string; readonly N: number; readonly r: number; readonly p: number } | null {
  const parsed = parseVerifier(verifier);
  if (parsed === null) return null;
  return { algorithm: "scrypt", ...parsed.parameters };
}

interface ParsedVerifier {
  readonly parameters: { readonly N: number; readonly r: number; readonly p: number };
  readonly salt: Buffer;
  readonly digest: Buffer;
}

function parseVerifier(verifier: string): ParsedVerifier | null {
  const parts = verifier.split("$");
  if (parts.length !== 4) return null;
  const [algorithm, parameterText, saltText, digestText] = parts as [string, string, string, string];
  if (algorithm !== "scrypt") return null;

  const match = /^N=(?<n>[0-9]{1,10}),r=(?<r>[0-9]{1,4}),p=(?<p>[0-9]{1,4})$/u.exec(parameterText);
  if (match === null) return null;
  const N = Number(match.groups?.["n"]);
  const r = Number(match.groups?.["r"]);
  const p = Number(match.groups?.["p"]);
  // A verifier is not a place to accept arbitrary work factors: a row rewritten
  // to N=2 would verify instantly, which turns a database write into a
  // credential bypass.
  if (!Number.isInteger(N) || N < 16_384 || N > 1_048_576) return null;
  if (!Number.isInteger(r) || r < 1 || r > 32) return null;
  if (!Number.isInteger(p) || p < 1 || p > 16) return null;

  const salt = Buffer.from(saltText, "base64url");
  const digest = Buffer.from(digestText, "base64url");
  if (salt.length < 8 || digest.length < 16) return null;
  return { parameters: { N, r, p }, salt, digest };
}

async function derive(
  password: string,
  salt: Buffer,
  parameters: { readonly N: number; readonly r: number; readonly p: number },
): Promise<Buffer> {
  return scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, {
    N: parameters.N,
    r: parameters.r,
    p: parameters.p,
    maxmem: Math.max(MAX_MEMORY_BYTES, 128 * parameters.N * parameters.r * 2),
  });
}
