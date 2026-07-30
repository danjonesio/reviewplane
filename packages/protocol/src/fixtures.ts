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
