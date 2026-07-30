/**
 * Access to the committed cross-language fixture corpora.
 *
 * A corpus is part of the package rather than of the test suite: the Go
 * package, and later `services/connector`, `services/tunnel-gateway`,
 * `apps/server` and `apps/browser-worker`, run the same manifest so that all
 * implementations are held to one set of accepted and refused frames.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  ErrorClass,
  MessageType,
  ProtocolViolationReason,
} from "./generated/connector/v1/types.ts";

export type FixtureKind =
  | "control_frame"
  | "data_stream_header"
  | "browser_frame"
  | "live_view_frame";

export interface ValidFixture<Type extends string = MessageType> {
  readonly name: string;
  readonly kind: FixtureKind;
  readonly file: string;
  readonly message_type?: Type;
  readonly note?: string;
}

export interface InvalidFixture<
  Reason extends string = ProtocolViolationReason,
  Class extends string = ErrorClass,
> {
  readonly name: string;
  readonly kind: FixtureKind;
  readonly file: string;
  readonly expect_reason: Reason;
  readonly expect_error_class?: Class;
  readonly note?: string;
}

export interface FixtureManifest<
  Type extends string = MessageType,
  Reason extends string = ProtocolViolationReason,
  Class extends string = ErrorClass,
> {
  readonly protocol: string;
  readonly version: number;
  readonly description: string;
  readonly valid: readonly ValidFixture<Type>[];
  readonly invalid: readonly InvalidFixture<Reason, Class>[];
}

/** One committed corpus: its directory, manifest and golden canonical bytes. */
export interface FixtureCorpus {
  readonly directory: string;
  readonly manifestPath: string;
  readonly canonicalPath: string;
}

function corpus(protocol: string, version: number): FixtureCorpus {
  const directory = join(import.meta.dirname, "..", "fixtures", protocol, `v${String(version)}`);
  return {
    directory,
    manifestPath: join(directory, "manifest.json"),
    canonicalPath: join(directory, "canonical.json"),
  };
}

/** Version 1 connector corpus. */
export const CONNECTOR_CORPUS = corpus("connector", 1);

/** Version 1 browser-worker corpus. */
export const BROWSER_CORPUS = corpus("browser", 1);

/** Version 1 live-view corpus. */
export const LIVE_VIEW_CORPUS = corpus("live_view", 1);

/** Directory holding the version 1 connector corpus. */
export const FIXTURES_DIRECTORY = CONNECTOR_CORPUS.directory;

export const MANIFEST_PATH = CONNECTOR_CORPUS.manifestPath;
export const CANONICAL_PATH = CONNECTOR_CORPUS.canonicalPath;

export function loadFixtureManifest<
  Type extends string = MessageType,
  Reason extends string = ProtocolViolationReason,
  Class extends string = ErrorClass,
>(from: FixtureCorpus = CONNECTOR_CORPUS): FixtureManifest<Type, Reason, Class> {
  return JSON.parse(readFileSync(from.manifestPath, "utf8")) as FixtureManifest<
    Type,
    Reason,
    Class
  >;
}

/** Raw fixture bytes, exactly as committed. */
export function readFixture(
  fixture: { readonly file: string },
  from: FixtureCorpus = CONNECTOR_CORPUS,
): string {
  return readFileSync(join(from.directory, fixture.file), "utf8");
}

/** Golden canonical encodings, keyed by fixture name. */
export function loadCanonicalEncodings(
  from: FixtureCorpus = CONNECTOR_CORPUS,
): Record<string, string> {
  return JSON.parse(readFileSync(from.canonicalPath, "utf8")) as Record<string, string>;
}
