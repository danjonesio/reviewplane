/**
 * Denial and failure cases for the review-domain event codec, in the shape
 * `frame.test.ts` and `browser-frame.test.ts` use.
 *
 * The corpus in `fixtures/review/v1/` already proves that every listed event
 * round-trips and that every listed refusal reports its reason. What is here
 * is what a fixture cannot express: bounds applied to raw bytes, and the order
 * the checks run in.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { REVIEW_CORPUS, readFixture } from "../src/fixtures.ts";
import { LIMITS } from "../src/generated/review/v1/types.ts";
import {
  ReviewEventEncodeError,
  decodeReviewEvent,
  encodeReviewEvent,
} from "../src/review-event.ts";

function reviewCreated(): string {
  return readFixture({ file: "valid/review-created.json" }, REVIEW_CORPUS);
}

test("a corpus event decodes and re-encodes to a canonical fixed point", () => {
  const first = decodeReviewEvent(reviewCreated());
  assert.ok(first.ok);
  const encoded = encodeReviewEvent(first.value);
  const second = decodeReviewEvent(encoded);
  assert.ok(second.ok);
  assert.equal(encodeReviewEvent(second.value), encoded);
});

test("an oversized event is refused before it is deserialised", () => {
  // Valid JSON, and far too large. The refusal must be about the byte bound
  // rather than about anything inside the body.
  const padding = "a".repeat(LIMITS.MAX_REVIEW_EVENT_BYTES + 1);
  const raw = `{"id":"evt_a","schema_version":1,"type":"review.named","padding":"${padding}"}`;
  const result = decodeReviewEvent(raw);
  assert.ok(!result.ok);
  assert.equal(result.error.reason, "frame_too_large");
  assert.equal(result.error.errorClass, null);
});

test("truncated and non-object input is refused as malformed rather than crashing", () => {
  for (const raw of ["", "{", '{"id":', "[]", "null", "12"]) {
    const result = decodeReviewEvent(raw);
    assert.ok(!result.ok, `input ${raw} was accepted`);
    assert.ok(["malformed_json", "schema_violation"].includes(result.error.reason));
  }
});

test("the schema version is checked before the event type", () => {
  // Both are wrong. The version has to be the reported reason, because a build
  // that does not understand the envelope cannot judge the type inside it.
  const raw = JSON.stringify({
    id: "evt_a",
    schema_version: 7,
    sequence: 1,
    type: "review.deleted",
    occurred_at: "2026-07-30T10:12:04.118Z",
    organisation_id: "org_a",
    project_id: "prj_a",
    actor: { type: "human_user" },
    payload: {},
  });
  const result = decodeReviewEvent(raw);
  assert.ok(!result.ok);
  assert.equal(result.error.reason, "unsupported_schema_version");
  assert.equal(result.error.errorClass, "UNSUPPORTED_CAPABILITY");
});

test("a non-integer schema version is refused as an unsupported version", () => {
  for (const version of ['"1"', "1.5", "null", "true", "[1]"]) {
    const raw = `{"id":"evt_a","schema_version":${version},"sequence":1,"type":"review.named","occurred_at":"2026-07-30T10:12:04.118Z","organisation_id":"org_a","project_id":"prj_a","actor":{"type":"human_user"},"payload":{}}`;
    const result = decodeReviewEvent(raw);
    assert.ok(!result.ok, `schema_version ${version} was accepted`);
    assert.equal(result.error.reason, "unsupported_schema_version");
  }
});

test("a payload belonging to another event type is refused", () => {
  const decoded = decodeReviewEvent(reviewCreated());
  assert.ok(decoded.ok);
  const source = JSON.parse(encodeReviewEvent(decoded.value)) as Record<string, unknown>;
  source["type"] = "finding.created";
  const result = decodeReviewEvent(JSON.stringify(source));
  assert.ok(!result.ok);
  assert.equal(result.error.reason, "schema_violation");
  assert.ok(result.error.violations.length > 0);
});

test("encoding refuses an envelope whose type contradicts its payload", () => {
  const decoded = decodeReviewEvent(reviewCreated());
  assert.ok(decoded.ok);
  const frame = decoded.value;
  assert.equal(frame.type, "review.created");
  assert.throws(
    () =>
      encodeReviewEvent({
        ...frame,
        envelope: { ...frame.envelope, type: "review.named" },
      } as typeof frame),
    ReviewEventEncodeError,
  );
});

test("a refusal never echoes an unbounded amount of the offending value", () => {
  const raw = JSON.stringify({
    id: "evt_a",
    schema_version: 1,
    sequence: 1,
    type: "x".repeat(4000),
    occurred_at: "2026-07-30T10:12:04.118Z",
    organisation_id: "org_a",
    project_id: "prj_a",
    actor: { type: "human_user" },
    payload: {},
  });
  const result = decodeReviewEvent(raw);
  assert.ok(!result.ok);
  assert.equal(result.error.reason, "unknown_message_type");
  assert.ok(result.error.message.length < 200, "the refusal echoed the whole value back");
});
