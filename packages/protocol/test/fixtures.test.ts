/**
 * Contract layer (`docs/TESTING.md` section 2): the TypeScript models must
 * accept and refuse exactly the corpus the Go models do, and must produce the
 * same canonical bytes for every accepted frame.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
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
import { MESSAGE_TYPE_VALUES } from "../src/generated/connector/v1/types.ts";

const manifest = loadFixtureManifest();
const canonical = loadCanonicalEncodings();

test("the corpus holds fixtures", () => {
  assert.ok(manifest.valid.length > 0, "no valid fixtures");
  assert.ok(manifest.invalid.length > 0, "no invalid fixtures");
});

for (const fixture of manifest.valid) {
  test(`valid fixture ${fixture.name} round-trips to the committed canonical bytes`, () => {
    const raw = readFixture(fixture);
    const expected = canonical[fixture.name];
    assert.ok(expected !== undefined, `canonical.json has no entry for ${fixture.name}`);

    if (fixture.kind === "data_stream_header") {
      const decoded = decodeDataStreamHeaderFrame(raw);
      assert.ok(decoded.ok, `refused: ${decoded.ok ? "" : decoded.error.message}`);
      const encoded = encodeDataStreamHeaderFrame(decoded.value);
      assert.equal(encoded, expected);
      const again = decodeDataStreamHeaderFrame(encoded);
      assert.ok(again.ok);
      assert.equal(encodeDataStreamHeaderFrame(again.value), expected);
      return;
    }

    const decoded = decodeControlFrame(raw);
    assert.ok(decoded.ok, `refused: ${decoded.ok ? "" : decoded.error.message}`);
    assert.equal(decoded.value.type, fixture.message_type);
    assert.equal(decoded.value.envelope.type, fixture.message_type);
    const encoded = encodeControlFrame(decoded.value);
    assert.equal(encoded, expected);

    const again = decodeControlFrame(encoded);
    assert.ok(again.ok);
    assert.equal(encodeControlFrame(again.value), expected);
  });
}

for (const fixture of manifest.invalid) {
  test(`invalid fixture ${fixture.name} is refused as ${fixture.expect_reason}`, () => {
    const raw = readFixture(fixture);
    const result =
      fixture.kind === "data_stream_header"
        ? decodeDataStreamHeaderFrame(raw)
        : decodeControlFrame(raw);
    assert.ok(!result.ok, "invalid fixture was accepted");
    assert.equal(result.error.reason, fixture.expect_reason);
    assert.equal(result.error.errorClass, fixture.expect_error_class ?? null);
  });
}

test("the corpus covers every version 1 message type", () => {
  const covered = new Set(
    manifest.valid
      .filter((fixture) => fixture.kind === "control_frame")
      .map((fixture) => fixture.message_type),
  );
  for (const messageType of MESSAGE_TYPE_VALUES) {
    assert.ok(covered.has(messageType), `no valid fixture covers ${messageType}`);
  }
  assert.ok(
    manifest.valid.some((fixture) => fixture.kind === "data_stream_header"),
    "no valid fixture covers the data-stream header",
  );
});
