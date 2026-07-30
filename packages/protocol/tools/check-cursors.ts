/**
 * The golden pagination-cursor corpus.
 *
 * A cursor is not a frame, so it does not fit the accept-or-refuse manifest the
 * other corpora use: the interesting property is that a set of claims produces
 * one exact string of text in both languages, and that the same set of malformed
 * inputs is refused for the same stable reason. That is the shape the route
 * capability corpus already uses (`fixtures/capability/v1/manifest.json`), and
 * this file is the same idea for `docs/API.md` section 6.
 *
 * `pnpm protocol:check --update` records the encodings; the Go suite reads the
 * same file, so a change made in one language alone fails the other.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { decodeCursor, encodeCursor, type CursorRejection } from "../src/cursor.ts";
import type { CursorClaims } from "../src/generated/platform/v1/types.ts";
import { packageRoot } from "./generate.ts";

export interface CursorEncodeCase {
  readonly name: string;
  readonly claims: CursorClaims;
  /** Recorded by `--update`; both languages must produce it byte for byte. */
  cursor?: string;
  readonly note?: string;
}

export interface CursorDecodeCase {
  readonly name: string;
  readonly cursor: string;
  readonly expect: CursorRejection;
  readonly note?: string;
}

export interface CursorManifest {
  readonly description: string;
  readonly encode: readonly CursorEncodeCase[];
  readonly reject: readonly CursorDecodeCase[];
}

export const CURSOR_MANIFEST_PATH = join(packageRoot, "fixtures", "platform", "v1", "cursors.json");

export function loadCursorManifest(): CursorManifest {
  return JSON.parse(readFileSync(CURSOR_MANIFEST_PATH, "utf8")) as CursorManifest;
}

export function checkCursorCorpus(
  update: boolean,
  pass: (message: string) => void,
  fail: (message: string) => void,
): void {
  const manifest = loadCursorManifest();
  const encoded = manifest.encode.map((testCase) => ({
    ...testCase,
    cursor: encodeCursor(testCase.claims),
  }));

  if (update) {
    writeFileSync(
      CURSOR_MANIFEST_PATH,
      `${JSON.stringify({ ...manifest, encode: encoded }, null, 2)}\n`,
      "utf8",
    );
    pass("recorded the cursor corpus");
    return;
  }

  for (const [index, testCase] of encoded.entries()) {
    const expected = manifest.encode[index]?.cursor;
    if (expected !== testCase.cursor) {
      fail(
        `cursor ${testCase.name} encoded to ${testCase.cursor}, corpus records ${String(expected)}`,
      );
      continue;
    }
    const round = decodeCursor(testCase.cursor);
    if (!round.ok) {
      fail(`cursor ${testCase.name} did not decode: ${round.reason}`);
      continue;
    }
    if (JSON.stringify(round.value) !== JSON.stringify(testCase.claims)) {
      fail(`cursor ${testCase.name} did not round-trip to the same claims`);
      continue;
    }
    pass(`cursor ${testCase.name} encodes and round-trips`);
  }

  for (const testCase of manifest.reject) {
    const result = decodeCursor(testCase.cursor);
    if (result.ok) {
      fail(`cursor ${testCase.name} was accepted; the corpus requires ${testCase.expect}`);
      continue;
    }
    if (result.reason !== testCase.expect) {
      fail(`cursor ${testCase.name} was refused as ${result.reason}, expected ${testCase.expect}`);
      continue;
    }
    pass(`cursor ${testCase.name} is refused as ${testCase.expect}`);
  }
}
