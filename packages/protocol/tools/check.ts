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
 * 4. the Go test suite, which runs the connector corpus, fails.
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
  REVIEW_CORPUS,
  loadCanonicalEncodings,
  loadFixtureManifest,
  readFixture,
  type FixtureCorpus,
} from "../src/fixtures.ts";
import { decodeMcpToolResponse, encodeMcpToolResponse } from "../src/mcp-response.ts";
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
};

function codecFor(kind: string): Codec {
  const codec = CODECS[kind];
  if (codec === undefined) throw new Error(`no codec for fixture kind ${kind}`);
  return codec;
}

function checkFixtures(corpus: FixtureCorpus, label: string): void {
  const manifest = loadFixtureManifest<string, string, string>(corpus);
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
checkGo();

if (failures.length > 0) {
  process.stderr.write(`\nprotocol:check failed with ${String(failures.length)} problem(s)\n`);
  process.exit(1);
}
process.stdout.write("\nprotocol:check passed\n");
