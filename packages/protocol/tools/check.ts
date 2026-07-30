/**
 * `pnpm protocol:check` — proves that the schema, the generated models in both
 * languages and the committed fixture corpus still agree.
 *
 * It fails when:
 *
 * 1. a generated TypeScript or Go file differs from what the schema renders,
 *    which is how a change made in one language only is caught;
 * 2. a fixture the corpus says is valid is refused, or re-encodes to different
 *    bytes than the committed canonical form;
 * 3. a fixture the corpus says is invalid is accepted, or refused for a
 *    different reason;
 * 4. the Go test suite, which runs the same corpus, fails.
 *
 * The Go toolchain is required, as it is for any protocol work
 * (`docs/DEVELOPMENT.md` section 2).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  CANONICAL_PATH,
  loadCanonicalEncodings,
  loadFixtureManifest,
  readFixture,
} from "../src/fixtures.ts";
import {
  decodeControlFrame,
  decodeDataStreamHeaderFrame,
  encodeControlFrame,
  encodeDataStreamHeaderFrame,
} from "../src/frame.ts";
import { packageRoot, renderAll, schemaPath } from "./generate.ts";
import { loadProtocolModel } from "./schema-model.ts";

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
  const model = loadProtocolModel(schemaPath);
  const rendered = renderAll(model);
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

function encodeFixture(fixture: { kind: string; file: string; name: string }): string | null {
  const raw = readFixture(fixture);
  if (fixture.kind === "data_stream_header") {
    const decoded = decodeDataStreamHeaderFrame(raw);
    if (!decoded.ok) {
      fail(`valid fixture ${fixture.name} was refused: ${decoded.error.message}`);
      return null;
    }
    return encodeDataStreamHeaderFrame(decoded.value);
  }
  const decoded = decodeControlFrame(raw);
  if (!decoded.ok) {
    fail(
      `valid fixture ${fixture.name} was refused: ${decoded.error.reason}: ${decoded.error.message}`,
    );
    return null;
  }
  return encodeControlFrame(decoded.value);
}

function checkFixtures(): void {
  const manifest = loadFixtureManifest();
  const canonical: Record<string, string> = {};

  for (const fixture of manifest.valid) {
    const encoded = encodeFixture(fixture);
    if (encoded === null) continue;
    canonical[fixture.name] = encoded;

    // Re-decoding the canonical form must reproduce it exactly, so the
    // encoding is a fixed point rather than merely a first pass.
    const second = fixture.kind === "data_stream_header"
      ? (() => {
          const again = decodeDataStreamHeaderFrame(encoded);
          return again.ok ? encodeDataStreamHeaderFrame(again.value) : null;
        })()
      : (() => {
          const again = decodeControlFrame(encoded);
          return again.ok ? encodeControlFrame(again.value) : null;
        })();
    if (second !== encoded) {
      fail(`valid fixture ${fixture.name} is not a canonical fixed point`);
      continue;
    }
    pass(`valid fixture ${fixture.name} round-trips`);
  }

  for (const fixture of manifest.invalid) {
    const raw = readFixture(fixture);
    const result =
      fixture.kind === "data_stream_header"
        ? decodeDataStreamHeaderFrame(raw)
        : decodeControlFrame(raw);
    if (result.ok) {
      fail(`invalid fixture ${fixture.name} was accepted`);
      continue;
    }
    if (result.error.reason !== fixture.expect_reason) {
      fail(
        `invalid fixture ${fixture.name} was refused as ${result.error.reason}, expected ${fixture.expect_reason}`,
      );
      continue;
    }
    const expectedClass = fixture.expect_error_class ?? null;
    if (result.error.errorClass !== expectedClass) {
      fail(
        `invalid fixture ${fixture.name} reported error class ${String(result.error.errorClass)}, expected ${String(expectedClass)}`,
      );
      continue;
    }
    pass(`invalid fixture ${fixture.name} is refused as ${fixture.expect_reason}`);
  }

  const serialised = `${JSON.stringify(canonical, null, 2)}\n`;
  if (UPDATE) {
    writeFileSync(CANONICAL_PATH, serialised, "utf8");
    process.stdout.write(`updated ${relative(packageRoot, CANONICAL_PATH)}\n`);
    return;
  }
  let committed: Record<string, string>;
  try {
    committed = loadCanonicalEncodings();
  } catch {
    fail("fixtures/connector/v1/canonical.json is missing; run pnpm protocol:check --update");
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
      fail(`canonical.json holds ${name}, which the manifest no longer lists`);
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
checkFixtures();
checkGo();

if (failures.length > 0) {
  process.stderr.write(`\nprotocol:check failed with ${String(failures.length)} problem(s)\n`);
  process.exit(1);
}
process.stdout.write("\nprotocol:check passed\n");
