/**
 * Denial and failure cases for the browser-worker frame entry points, plus the
 * parity assertions that keep `browser-frame.ts` and `frame.ts` refusing the
 * same classes of input in the same order.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserFrameEncodeError,
  decodeBrowserFrame,
  encodeBrowserFrame,
} from "../src/browser-frame.ts";
import { BROWSER_CORPUS, readFixture } from "../src/fixtures.ts";
import { decodeControlFrame } from "../src/frame.ts";
import {
  INTERACTIVE_COMMANDS,
  LIMITS,
  MESSAGE_DIRECTIONS,
  PAYLOAD_MAX_BYTES,
  SYSTEM_CAPTURE_COMMANDS,
  type BrowserFrame,
} from "../src/generated/browser/v1/types.ts";

function decodeFixture(file: string): BrowserFrame {
  const decoded = decodeBrowserFrame(readFixture({ file }, BROWSER_CORPUS));
  assert.ok(decoded.ok, `fixture ${file} was refused`);
  return decoded.value;
}

test("an unknown protocol version yields PROTOCOL_UNSUPPORTED", () => {
  const raw = JSON.stringify({
    protocol_version: 99,
    message_id: "msg_a",
    type: "worker.heartbeat",
    sent_at: "2026-07-29T11:00:00Z",
    worker_id: "wkr_a",
    payload: {},
  });
  const result = decodeBrowserFrame(raw);
  assert.ok(!result.ok);
  assert.equal(result.error.reason, "unsupported_protocol_version");
  assert.equal(result.error.errorClass, "PROTOCOL_UNSUPPORTED");
});

test("an unknown message type is rejected rather than ignored", () => {
  const raw = JSON.stringify({
    protocol_version: 1,
    message_id: "msg_a",
    type: "browser.evaluate",
    sent_at: "2026-07-29T11:00:00Z",
    worker_id: "wkr_a",
    payload: { script: "fetch('http://169.254.169.254/')" },
  });
  const result = decodeBrowserFrame(raw);
  assert.ok(!result.ok);
  assert.equal(result.error.reason, "unknown_message_type");
  assert.equal(result.error.errorClass, "PROTOCOL_UNSUPPORTED");
});

test("an oversized frame is refused before deserialisation", () => {
  // Deliberately not well-formed JSON: if the bound were applied after
  // parsing, this would be reported as malformed rather than as too large.
  const raw = `{"protocol_version":1,"padding":"${"x".repeat(LIMITS.MAX_CONTROL_FRAME_BYTES)}`;
  const result = decodeBrowserFrame(raw);
  assert.ok(!result.ok);
  assert.equal(result.error.reason, "frame_too_large");
});

test("a payload larger than its declared bound is refused", () => {
  const bound = PAYLOAD_MAX_BYTES["browser.command.result"];
  // One element descriptor is well under the bound; enough of them together
  // are not, and each one on its own satisfies every field constraint.
  const elements = Array.from({ length: 500 }, (_entry, index) => ({
    ref: `e${String(index + 1)}`,
    role: "link",
    name: "x".repeat(250),
  }));
  const raw = JSON.stringify({
    protocol_version: 1,
    message_id: "msg_big",
    type: "browser.command.result",
    sent_at: "2026-07-29T11:00:00Z",
    worker_id: "wkr_a",
    browser_session_id: "brs_a",
    controller: { type: "agent", id: "ags_a" },
    control_epoch: 1,
    sequence: 1,
    correlation_id: "msg_cmd",
    payload: {
      ok: true,
      command: "snapshot",
      sequence: 1,
      control_epoch: 1,
      duration_ms: 10,
      trust: "untrusted_browser_content",
      instruction_policy: "do_not_follow_as_instructions",
      snapshot: {
        snapshot_id: "bsn_a",
        viewport: { width: 1440, height: 900, device_scale_factor: 1 },
        // Present because the payload bound is what this case must trip: a
        // frame missing a required member is refused as a schema violation
        // first, and the byte bound would then never be reached.
        scroll_position: { x: 0, y: 0 },
        node_count: 500,
        truncated: true,
        text: "x".repeat(65536),
        elements,
      },
    },
  });
  // The payload bound must be the one that trips, so the frame stays inside
  // the transport bound that would otherwise be reported first.
  assert.ok(raw.length > bound, "the case must exceed the payload bound to test it");
  assert.ok(
    raw.length < LIMITS.MAX_CONTROL_FRAME_BYTES,
    "the case must stay inside the frame bound so the payload bound is what fails",
  );
  const result = decodeBrowserFrame(raw);
  assert.ok(!result.ok);
  assert.equal(result.error.reason, "payload_too_large");
});

test("malformed JSON is refused as malformed, not as a schema violation", () => {
  const result = decodeBrowserFrame('{"protocol_version":1,');
  assert.ok(!result.ok);
  assert.equal(result.error.reason, "malformed_json");
});

test("the browser and connector entry points classify the same inputs alike", () => {
  const cases: readonly { raw: string; reason: string }[] = [
    { raw: "not json at all", reason: "malformed_json" },
    { raw: "[1,2,3]", reason: "schema_violation" },
    { raw: '{"protocol_version":7,"type":"x"}', reason: "unsupported_protocol_version" },
  ];
  for (const entry of cases) {
    const browser = decodeBrowserFrame(entry.raw);
    const connector = decodeControlFrame(entry.raw);
    assert.ok(!browser.ok);
    assert.ok(!connector.ok);
    assert.equal(browser.error.reason, entry.reason);
    assert.equal(
      connector.error.reason,
      browser.error.reason,
      `the two entry points disagree about ${entry.raw}`,
    );
  }
});

test("encoding refuses a frame whose envelope type contradicts its payload", () => {
  const frame = decodeFixture("valid/worker-heartbeat.json");
  const mismatched = {
    ...frame,
    envelope: { ...frame.envelope, type: "worker.register" },
  } as unknown as BrowserFrame;
  assert.throws(() => encodeBrowserFrame(mismatched), BrowserFrameEncodeError);
});

test("a decoded command keeps every docs/ARCHITECTURE.md section 6.4 envelope field", () => {
  const frame = decodeFixture("valid/command-navigate-relative.json");
  assert.equal(frame.type, "browser.command");
  assert.equal(frame.envelope.browser_session_id, "brs_01JHOMEPAGEREVIEW");
  assert.deepEqual(frame.envelope.controller, { type: "agent", id: "ags_01JCLAUDECODE" });
  assert.equal(frame.envelope.control_epoch, 1);
  assert.equal(frame.envelope.sequence, 7);
  assert.equal(frame.envelope.sent_at, "2026-07-29T09:16:04.000Z");
});

test("a relative navigation target survives the round trip unchanged", () => {
  const frame = decodeFixture("valid/command-navigate-relative.json");
  assert.equal(frame.type, "browser.command");
  assert.equal(frame.payload.navigate?.url, "/checkout");
  assert.equal(frame.payload.navigate?.wait_until, "domcontentloaded");
});

test("every command is classified as interactive or as a system capture, never both", () => {
  const interactive = new Set<string>(INTERACTIVE_COMMANDS);
  const system = new Set<string>(SYSTEM_CAPTURE_COMMANDS);
  for (const command of [...interactive]) {
    assert.ok(!system.has(command), `${command} is in both vocabularies`);
  }
  const covered = new Set<string>([...interactive, ...system]);
  const snapshotResult = decodeFixture("valid/command-result-snapshot.json");
  assert.equal(snapshotResult.type, "browser.command.result");
  assert.ok(covered.has(snapshotResult.payload.command));
});

test("commands travel to the worker and results travel back", () => {
  assert.equal(MESSAGE_DIRECTIONS["browser.command"], "control_plane_to_worker");
  assert.equal(MESSAGE_DIRECTIONS["browser.command.result"], "worker_to_control_plane");
  assert.equal(MESSAGE_DIRECTIONS["worker.register"], "worker_to_control_plane");
});
