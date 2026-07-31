/**
 * `pnpm protocol:check` — proves that every schema source, the generated
 * models in the languages it declares and the committed fixture corpora still
 * agree.
 *
 * It fails when:
 *
 * 1. a generated TypeScript or Go file differs from what its schema renders,
 *    which is how a change made in one language only is caught;
 * 2. a fixture a corpus says is valid is refused, or re-encodes to different
 *    bytes than the committed canonical form;
 * 3. a fixture a corpus says is invalid is accepted, or refused for a
 *    different reason;
 * 4. a manifest note quotes a `key: value` pair its own fixture contradicts,
 *    which is the one part of a corpus nothing else reads;
 * 5. the Go test suite, which runs the connector corpus, fails.
 *
 * The Go toolchain is required, as it is for any protocol work
 * (`docs/DEVELOPMENT.md` section 2).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { decodeBrowserFrame, encodeBrowserFrame } from "../src/browser-frame.ts";
import {
  BROWSER_CORPUS,
  CONNECTOR_CORPUS,
  LIVE_VIEW_CORPUS,
  MCP_CORPUS,
  PLATFORM_CORPUS,
  REVIEW_CORPUS,
  loadCanonicalEncodings,
  loadFixtureManifest,
  readFixture,
  type FixtureCorpus,
} from "../src/fixtures.ts";
import { decodeMcpToolResponse, encodeMcpToolResponse } from "../src/mcp-response.ts";
import {
  decodeApiErrorBody,
  decodePlatformEvent,
  decodeStreamMessage,
  encodeApiErrorBody,
  encodePlatformEvent,
  encodeStreamMessage,
} from "../src/platform-event.ts";
import { checkCursorCorpus } from "./check-cursors.ts";
import { decodeLiveViewFrame, encodeLiveViewFrame } from "../src/live-view-frame.ts";
import { decodeReviewEvent, encodeReviewEvent } from "../src/review-event.ts";
import {
  decodeControlFrame,
  decodeDataStreamHeaderFrame,
  encodeControlFrame,
  encodeDataStreamHeaderFrame,
} from "../src/frame.ts";
import { packageRoot, renderEverySource } from "./generate.ts";

const UPDATE = process.argv.includes("--update");

const failures: string[] = [];

function fail(message: string): void {
  failures.push(message);
  process.stdout.write(`FAIL ${message}\n`);
}

function pass(message: string): void {
  process.stdout.write(`ok   ${message}\n`);
}

function checkGeneratedFiles(): void {
  const rendered = renderEverySource();
  for (const [relativePath, expected] of rendered) {
    const absolutePath = join(packageRoot, relativePath);
    let actual: string;
    try {
      actual = readFileSync(absolutePath, "utf8");
    } catch {
      fail(`${relativePath} is missing; run pnpm protocol:generate`);
      continue;
    }
    if (actual !== expected) {
      const actualLines = actual.split("\n");
      const expectedLines = expected.split("\n");
      let line = 0;
      while (line < actualLines.length && actualLines[line] === expectedLines[line]) line += 1;
      fail(
        `${relativePath} does not match the schema source (first difference at line ${String(line + 1)}):\n` +
          `  committed: ${actualLines[line] ?? "<end of file>"}\n` +
          `  schema:    ${expectedLines[line] ?? "<end of file>"}\n` +
          "  run pnpm protocol:generate and commit the result",
      );
      continue;
    }
    pass(`${relativePath} matches the schema source`);
  }
}

/**
 * Decode-then-encode for one fixture kind. Keeping the codec beside the corpus
 * means adding a protocol adds one entry here rather than a branch everywhere.
 */
interface Codec {
  readonly roundTrip: (raw: string) => { ok: true; encoded: string } | { ok: false; message: string };
  readonly refusal: (raw: string) => { reason: string; errorClass: string | null } | null;
}

const CODECS: Readonly<Record<string, Codec>> = {
  control_frame: {
    roundTrip(raw) {
      const decoded = decodeControlFrame(raw);
      if (!decoded.ok) return { ok: false, message: `${decoded.error.reason}: ${decoded.error.message}` };
      return { ok: true, encoded: encodeControlFrame(decoded.value) };
    },
    refusal(raw) {
      const result = decodeControlFrame(raw);
      return result.ok ? null : { reason: result.error.reason, errorClass: result.error.errorClass };
    },
  },
  data_stream_header: {
    roundTrip(raw) {
      const decoded = decodeDataStreamHeaderFrame(raw);
      if (!decoded.ok) return { ok: false, message: `${decoded.error.reason}: ${decoded.error.message}` };
      return { ok: true, encoded: encodeDataStreamHeaderFrame(decoded.value) };
    },
    refusal(raw) {
      const result = decodeDataStreamHeaderFrame(raw);
      return result.ok ? null : { reason: result.error.reason, errorClass: result.error.errorClass };
    },
  },
  browser_frame: {
    roundTrip(raw) {
      const decoded = decodeBrowserFrame(raw);
      if (!decoded.ok) return { ok: false, message: `${decoded.error.reason}: ${decoded.error.message}` };
      return { ok: true, encoded: encodeBrowserFrame(decoded.value) };
    },
    refusal(raw) {
      const result = decodeBrowserFrame(raw);
      return result.ok ? null : { reason: result.error.reason, errorClass: result.error.errorClass };
    },
  },
  live_view_frame: {
    roundTrip(raw) {
      const decoded = decodeLiveViewFrame(raw);
      if (!decoded.ok) return { ok: false, message: `${decoded.error.reason}: ${decoded.error.message}` };
      return { ok: true, encoded: encodeLiveViewFrame(decoded.value) };
    },
    refusal(raw) {
      const result = decodeLiveViewFrame(raw);
      return result.ok ? null : { reason: result.error.reason, errorClass: result.error.errorClass };
    },
  },
  review_event: {
    roundTrip(raw) {
      const decoded = decodeReviewEvent(raw);
      if (!decoded.ok) return { ok: false, message: `${decoded.error.reason}: ${decoded.error.message}` };
      return { ok: true, encoded: encodeReviewEvent(decoded.value) };
    },
    refusal(raw) {
      const result = decodeReviewEvent(raw);
      return result.ok ? null : { reason: result.error.reason, errorClass: result.error.errorClass };
    },
  },
  mcp_tool_response: {
    roundTrip(raw) {
      const decoded = decodeMcpToolResponse(raw);
      if (!decoded.ok) return { ok: false, message: `${decoded.error.reason}: ${decoded.error.message}` };
      return { ok: true, encoded: encodeMcpToolResponse(decoded.value) };
    },
    refusal(raw) {
      const result = decodeMcpToolResponse(raw);
      return result.ok ? null : { reason: result.error.reason, errorClass: result.error.errorClass };
    },
  },
  platform_event: {
    roundTrip(raw) {
      const decoded = decodePlatformEvent(raw);
      if (!decoded.ok) return { ok: false, message: `${decoded.error.reason}: ${decoded.error.message}` };
      return { ok: true, encoded: encodePlatformEvent(decoded.value) };
    },
    refusal(raw) {
      const result = decodePlatformEvent(raw);
      return result.ok ? null : { reason: result.error.reason, errorClass: result.error.errorClass };
    },
  },
  stream_message: {
    roundTrip(raw) {
      const decoded = decodeStreamMessage(raw);
      if (!decoded.ok) return { ok: false, message: `${decoded.error.reason}: ${decoded.error.message}` };
      return { ok: true, encoded: encodeStreamMessage(decoded.value) };
    },
    refusal(raw) {
      const result = decodeStreamMessage(raw);
      return result.ok ? null : { reason: result.error.reason, errorClass: result.error.errorClass };
    },
  },
  api_error_response: {
    roundTrip(raw) {
      const decoded = decodeApiErrorBody(raw);
      if (!decoded.ok) return { ok: false, message: `${decoded.error.reason}: ${decoded.error.message}` };
      return { ok: true, encoded: encodeApiErrorBody(decoded.value) };
    },
    refusal(raw) {
      const result = decodeApiErrorBody(raw);
      return result.ok ? null : { reason: result.error.reason, errorClass: result.error.errorClass };
    },
  },
};

function codecFor(kind: string): Codec {
  const codec = CODECS[kind];
  if (codec === undefined) throw new Error(`no codec for fixture kind ${kind}`);
  return codec;
}

/**
 * A `key: value` pair quoted inside a manifest note.
 *
 * Deliberately narrow. The value must be a boolean or a number literal, because
 * that is the shape a note uses when it is **quoting the fixture** rather than
 * describing it: "the capability set including `review_inbox: false`". Ordinary
 * prose reaches for "is false" and names no key, so it does not match, and a
 * colon followed by a word — the common punctuation in these notes — cannot
 * match at all.
 */
const QUOTED_JSON_PAIR = /[`"']?\b([a-z_][a-z0-9_]*)[`"']?\s*:\s*(true|false|-?\d+(?:\.\d+)?)\b/gu;

/** Every scalar a key takes anywhere in one fixture, keyed by that name. */
function scalarsByKey(value: unknown, into = new Map<string, unknown[]>()): Map<string, unknown[]> {
  if (Array.isArray(value)) {
    for (const item of value) scalarsByKey(item, into);
    return into;
  }
  if (typeof value !== "object" || value === null) return into;
  for (const [key, member] of Object.entries(value)) {
    if (typeof member === "boolean" || typeof member === "number") {
      const seen = into.get(key) ?? [];
      seen.push(member);
      into.set(key, seen);
    }
    scalarsByKey(member, into);
  }
  return into;
}

/**
 * Fails when a manifest note quotes a value its own fixture contradicts.
 *
 * Notes are the only part of a corpus nothing validates: `agent-session-status`
 * carried a note reading `review_inbox: false` beside a fixture holding `true`,
 * and every gate passed. A note is the first thing a reader trusts about a
 * fixture, so a wrong one is worse than none.
 *
 * The check is deliberately partial, and the two rules that keep it quiet are
 * both about staying out of the way of prose:
 *
 * * a key the fixture does not carry as a boolean or a number is **skipped**,
 *   not failed, because a note may legitimately describe a member that is
 *   absent, that is an object, or that belongs to a different message entirely;
 * * a key that appears several times passes if **any** occurrence matches, since
 *   a note describing one element of an array is describing the fixture
 *   correctly.
 *
 * So this catches contradiction and never mere silence. A note that says nothing
 * checkable is not an error here; it is simply not checked.
 */
function checkFixtureNotes(corpus: FixtureCorpus, label: string): void {
  const manifest = loadFixtureManifest<string, string, string>(corpus);
  let checked = 0;
  let contradicted = 0;
  for (const fixture of [...manifest.valid, ...manifest.invalid]) {
    const note = fixture.note;
    if (note === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFixture(fixture, corpus));
    } catch {
      // An invalid fixture is often not JSON at all, which is the whole point
      // of it. There is nothing to contradict.
      continue;
    }
    const scalars = scalarsByKey(parsed);
    for (const [, key, literal] of note.matchAll(QUOTED_JSON_PAIR)) {
      if (key === undefined || literal === undefined) continue;
      const occurrences = scalars.get(key);
      if (occurrences === undefined) continue;
      const expected =
        literal === "true" ? true : literal === "false" ? false : Number.parseFloat(literal);
      checked += 1;
      if (occurrences.includes(expected)) continue;
      contradicted += 1;
      fail(
        `${label} fixture ${fixture.name}: the note says ${key}: ${literal}, ` +
          `but ${fixture.file} holds ${key}: ${occurrences.map((value) => String(value)).join(", ")}`,
      );
    }
  }
  if (contradicted > 0) return;
  pass(`${label} fixture notes agree with their fixtures (${String(checked)} quoted values)`);
}

function checkFixtures(corpus: FixtureCorpus, label: string): void {
  const manifest = loadFixtureManifest<string, string, string>(corpus);
  // Before the round trips, so that `--update` still checks it: regenerating
  // canonical bytes is exactly when a note falls out of step with its fixture.
  checkFixtureNotes(corpus, label);
  const canonical: Record<string, string> = {};

  for (const fixture of manifest.valid) {
    const codec = codecFor(fixture.kind);
    const raw = readFixture(fixture, corpus);
    const first = codec.roundTrip(raw);
    if (!first.ok) {
      fail(`valid ${label} fixture ${fixture.name} was refused: ${first.message}`);
      continue;
    }
    canonical[fixture.name] = first.encoded;

    // Re-decoding the canonical form must reproduce it exactly, so the
    // encoding is a fixed point rather than merely a first pass.
    const second = codec.roundTrip(first.encoded);
    if (!second.ok || second.encoded !== first.encoded) {
      fail(`valid ${label} fixture ${fixture.name} is not a canonical fixed point`);
      continue;
    }
    pass(`valid ${label} fixture ${fixture.name} round-trips`);
  }

  for (const fixture of manifest.invalid) {
    const codec = codecFor(fixture.kind);
    const refusal = codec.refusal(readFixture(fixture, corpus));
    if (refusal === null) {
      fail(`invalid ${label} fixture ${fixture.name} was accepted`);
      continue;
    }
    if (refusal.reason !== fixture.expect_reason) {
      fail(
        `invalid ${label} fixture ${fixture.name} was refused as ${refusal.reason}, expected ${fixture.expect_reason}`,
      );
      continue;
    }
    const expectedClass = fixture.expect_error_class ?? null;
    if (refusal.errorClass !== expectedClass) {
      fail(
        `invalid ${label} fixture ${fixture.name} reported error class ${String(refusal.errorClass)}, expected ${String(expectedClass)}`,
      );
      continue;
    }
    pass(`invalid ${label} fixture ${fixture.name} is refused as ${fixture.expect_reason}`);
  }

  const serialised = `${JSON.stringify(canonical, null, 2)}\n`;
  if (UPDATE) {
    writeFileSync(corpus.canonicalPath, serialised, "utf8");
    process.stdout.write(`updated ${relative(packageRoot, corpus.canonicalPath)}\n`);
    return;
  }
  let committed: Record<string, string>;
  try {
    committed = loadCanonicalEncodings(corpus);
  } catch {
    fail(
      `${relative(packageRoot, corpus.canonicalPath)} is missing; run pnpm protocol:check --update`,
    );
    return;
  }
  for (const [name, expected] of Object.entries(canonical)) {
    if (committed[name] !== expected) {
      fail(
        `canonical encoding for ${name} changed:\n  committed: ${String(committed[name])}\n  produced:  ${expected}`,
      );
      continue;
    }
    pass(`canonical encoding for ${name} is unchanged`);
  }
  for (const name of Object.keys(committed)) {
    if (canonical[name] === undefined) {
      fail(`${label} canonical.json holds ${name}, which the manifest no longer lists`);
    }
  }
}

function checkGo(): void {
  try {
    const output = execFileSync("go", ["test", "./..."], {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    process.stdout.write(output);
    pass("go test ./... agrees with the corpus");
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string };
    process.stdout.write(details.stdout ?? "");
    process.stderr.write(details.stderr ?? "");
    fail("go test ./... failed; the Go models no longer agree with the corpus");
  }
}

checkGeneratedFiles();
checkFixtures(CONNECTOR_CORPUS, "connector");
checkFixtures(BROWSER_CORPUS, "browser");
checkFixtures(LIVE_VIEW_CORPUS, "live view");
checkFixtures(REVIEW_CORPUS, "review");
checkFixtures(MCP_CORPUS, "mcp");
checkFixtures(PLATFORM_CORPUS, "platform");
checkCursorCorpus(UPDATE, pass, fail);
checkGo();

if (failures.length > 0) {
  process.stderr.write(`\nprotocol:check failed with ${String(failures.length)} problem(s)\n`);
  process.exit(1);
}
process.stdout.write("\nprotocol:check passed\n");
