/**
 * Access to the committed cross-language fixture corpus.
 *
 * The corpus is part of the package rather than of the test suite: the Go
 * package, and later `services/connector` and `services/tunnel-gateway`, run
 * the same manifest so that all implementations are held to one set of
 * accepted and refused frames.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  ErrorClass,
  MessageType,
  ProtocolViolationReason,
} from "./generated/connector/v1/types.ts";

export type FixtureKind = "control_frame" | "data_stream_header";

export interface ValidFixture {
  readonly name: string;
  readonly kind: FixtureKind;
  readonly file: string;
  readonly message_type?: MessageType;
  readonly note?: string;
}

export interface InvalidFixture {
  readonly name: string;
  readonly kind: FixtureKind;
  readonly file: string;
  readonly expect_reason: ProtocolViolationReason;
  readonly expect_error_class?: ErrorClass;
  readonly note?: string;
}

export interface FixtureManifest {
  readonly protocol: string;
  readonly version: number;
  readonly description: string;
  readonly valid: readonly ValidFixture[];
  readonly invalid: readonly InvalidFixture[];
}

/** Directory holding the version 1 connector corpus. */
export const FIXTURES_DIRECTORY = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "connector",
  "v1",
);

export const MANIFEST_PATH = join(FIXTURES_DIRECTORY, "manifest.json");
export const CANONICAL_PATH = join(FIXTURES_DIRECTORY, "canonical.json");

export function loadFixtureManifest(): FixtureManifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as FixtureManifest;
}

/** Raw fixture bytes, exactly as committed. */
export function readFixture(fixture: { readonly file: string }): string {
  return readFileSync(join(FIXTURES_DIRECTORY, fixture.file), "utf8");
}

/** Golden canonical encodings, keyed by fixture name. */
export function loadCanonicalEncodings(): Record<string, string> {
  return JSON.parse(readFileSync(CANONICAL_PATH, "utf8")) as Record<string, string>;
}

/**
 * A minting case of the capability corpus: claims in, exact token out.
 *
 * The token is a golden value. Both languages must produce it byte for byte,
 * which is what makes the control plane's minting and the tunnel gateway's
 * verification one implementation rather than two that happen to agree today.
 */
export interface CapabilityMintFixture {
  readonly name: string;
  readonly key_id: string;
  readonly capability_id: string;
  readonly route_id: string;
  readonly project_id: string;
  readonly browser_session_id: string;
  readonly issued_at: number;
  readonly expires_at: number;
  readonly token: string;
  readonly note?: string;
}

/** A verification case: a token, an instant and the outcome required of it. */
export interface CapabilityVerifyFixture {
  readonly name: string;
  readonly token: string;
  readonly now: number;
  readonly expect: string;
  readonly claims?: {
    readonly key_id: string;
    readonly capability_id: string;
    readonly route_id: string;
    readonly project_id: string;
    readonly browser_session_id: string;
    readonly issued_at: number;
    readonly expires_at: number;
  };
  readonly note?: string;
}

export interface CapabilityManifest {
  readonly protocol: string;
  readonly version: number;
  readonly description: string;
  /** Fixture signing keys, base64, keyed by key identifier. Never deployed. */
  readonly keys: Readonly<Record<string, string>>;
  /** The key identifiers the verification cases assume a verifier holds. */
  readonly verifier_keyring: readonly string[];
  readonly mint: readonly CapabilityMintFixture[];
  readonly verify: readonly CapabilityVerifyFixture[];
}

/** Directory holding the version 1 route-capability corpus. */
export const CAPABILITY_FIXTURES_DIRECTORY = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "capability",
  "v1",
);

export const CAPABILITY_MANIFEST_PATH = join(CAPABILITY_FIXTURES_DIRECTORY, "manifest.json");

export function loadCapabilityManifest(): CapabilityManifest {
  return JSON.parse(readFileSync(CAPABILITY_MANIFEST_PATH, "utf8")) as CapabilityManifest;
}
