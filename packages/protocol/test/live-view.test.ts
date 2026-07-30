/**
 * Denial and failure cases for the live-view entry points, and the bounded
 * behaviour of the internal record framing.
 *
 * The corpus in `fixtures/live_view/v1/` already proves that the committed
 * examples round-trip and that the committed refusals are refused. What is
 * left for a test is the input a fixture cannot express: a byte bound reached
 * with megabytes of data, a truncated transport record, and a length field
 * that claims more than the protocol allows.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { LIVE_VIEW_CORPUS, readFixture } from "../src/fixtures.ts";
import {
  LIMITS,
  MESSAGE_CHANNELS,
  MESSAGE_DIRECTIONS,
  PAYLOAD_MAX_BYTES,
  type LiveViewFrame,
} from "../src/generated/live_view/v1/types.ts";
import {
  LiveViewFrameEncodeError,
  decodeLiveViewFrame,
  encodeLiveViewFrame,
} from "../src/live-view-frame.ts";
import {
  LIVE_RECORD_FRAME_PAYLOAD,
  LIVE_RECORD_HEADER_BYTES,
  LIVE_RECORD_MESSAGE,
  LiveRecordDecoder,
  LiveStreamFramingError,
  encodeLiveMessageRecord,
  encodeLiveRecord,
} from "../src/live-view-stream.ts";

function decodeFixture(file: string): LiveViewFrame {
  const decoded = decodeLiveViewFrame(readFixture({ file }, LIVE_VIEW_CORPUS));
  assert.ok(decoded.ok, `fixture ${file} was refused`);
  return decoded.value;
}

test("a message beyond the byte bound is refused before it is parsed", () => {
  const padded = `${" ".repeat(LIMITS.MAX_LIVE_MESSAGE_BYTES + 1)}{}`;
  const result = decodeLiveViewFrame(padded);
  assert.ok(!result.ok);
  assert.equal(result.error.reason, "frame_too_large");
  assert.equal(result.error.errorClass, null);
});

test("an unknown protocol version yields PROTOCOL_UNSUPPORTED", () => {
  const raw = JSON.stringify({
    protocol_version: 7,
    message_id: "msg_a",
    type: "live.frame",
    sent_at: "2026-07-30T11:00:00Z",
    payload: {},
  });
  const result = decodeLiveViewFrame(raw);
  assert.ok(!result.ok);
  assert.equal(result.error.reason, "unsupported_protocol_version");
  assert.equal(result.error.errorClass, "PROTOCOL_UNSUPPORTED");
});

test("the version is checked before the message type", () => {
  // Both are wrong. A build that reported the type first would leak which
  // types it knows to a sender speaking a version it does not support.
  const raw = JSON.stringify({
    protocol_version: 7,
    message_id: "msg_a",
    type: "live.not_a_message",
    sent_at: "2026-07-30T11:00:00Z",
    payload: {},
  });
  const result = decodeLiveViewFrame(raw);
  assert.ok(!result.ok);
  assert.equal(result.error.reason, "unsupported_protocol_version");
});

test("frame metadata carries no image bytes", () => {
  const frame = decodeFixture("valid/frame-metadata-session-room.json");
  assert.equal(frame.type, "live.frame");
  const properties = Object.keys(frame.payload);
  for (const property of properties) {
    assert.ok(
      !/base64|data|bytes|payload/iu.test(property),
      `frame metadata must not carry the image itself, found ${property}`,
    );
  }
  // The metadata describes the separate binary message rather than holding it.
  assert.equal(typeof (frame.payload as { byte_length: number }).byte_length, "number");
});

test("every payload bound fits inside the message bound", () => {
  for (const [type, bound] of Object.entries(PAYLOAD_MAX_BYTES)) {
    assert.ok(
      bound <= LIMITS.MAX_LIVE_MESSAGE_BYTES,
      `${type} declares a payload bound above the message bound`,
    );
  }
});

test("frames are produced by the worker and requests come from the viewer", () => {
  // The direction table is what records that the scheduler is authoritative:
  // quality is decided worker-side and only requested viewer-side.
  assert.equal(MESSAGE_DIRECTIONS["live.frame"], "worker_to_viewer");
  assert.equal(MESSAGE_DIRECTIONS["live.quality"], "worker_to_viewer");
  assert.equal(MESSAGE_DIRECTIONS["live.quality_request"], "viewer_to_control_plane");
  assert.equal(MESSAGE_CHANNELS["live.frame"], "stream");
});

test("encoding refuses a message whose envelope and payload types disagree", () => {
  const frame = decodeFixture("valid/stream-heartbeat.json");
  const mismatched = {
    ...frame,
    type: "live.frame",
  } as unknown as LiveViewFrame;
  assert.throws(() => encodeLiveViewFrame(mismatched), LiveViewFrameEncodeError);
});

test("a decoded message re-encodes to a fixed point", () => {
  const frame = decodeFixture("valid/session-state-capture-unavailable.json");
  const once = encodeLiveViewFrame(frame);
  const again = decodeLiveViewFrame(once);
  assert.ok(again.ok);
  assert.equal(encodeLiveViewFrame(again.value), once);
});

test("the record decoder returns nothing until a record is complete", () => {
  const record = encodeLiveMessageRecord('{"hello":"world"}');
  const decoder = new LiveRecordDecoder();
  const head = decoder.push(record.slice(0, LIVE_RECORD_HEADER_BYTES + 2));
  assert.equal(head.length, 0);
  assert.ok(decoder.pending > 0);
  const tail = decoder.push(record.slice(LIVE_RECORD_HEADER_BYTES + 2));
  assert.equal(tail.length, 1);
  assert.equal(tail[0]?.kind, LIVE_RECORD_MESSAGE);
  assert.equal(new TextDecoder().decode(tail[0]?.bytes), '{"hello":"world"}');
  assert.equal(decoder.pending, 0);
});

test("two records arriving in one chunk are both returned, in order", () => {
  const first = encodeLiveMessageRecord('{"n":1}');
  const second = encodeLiveRecord(LIVE_RECORD_FRAME_PAYLOAD, new Uint8Array([1, 2, 3]));
  const combined = new Uint8Array(first.byteLength + second.byteLength);
  combined.set(first, 0);
  combined.set(second, first.byteLength);
  const records = new LiveRecordDecoder().push(combined);
  assert.equal(records.length, 2);
  assert.equal(records[0]?.kind, LIVE_RECORD_MESSAGE);
  assert.equal(records[1]?.kind, LIVE_RECORD_FRAME_PAYLOAD);
  assert.deepEqual([...(records[1]?.bytes ?? [])], [1, 2, 3]);
});

test("an oversized declared length is refused before the bytes are waited for", () => {
  const header = new Uint8Array(LIVE_RECORD_HEADER_BYTES);
  header[0] = LIVE_RECORD_MESSAGE;
  new DataView(header.buffer).setUint32(1, LIMITS.MAX_LIVE_MESSAGE_BYTES + 1, false);
  const decoder = new LiveRecordDecoder();
  assert.throws(() => decoder.push(header), LiveStreamFramingError);
});

test("an unknown record kind ends the stream rather than being skipped", () => {
  const header = new Uint8Array(LIVE_RECORD_HEADER_BYTES);
  header[0] = 9;
  assert.throws(() => new LiveRecordDecoder().push(header), LiveStreamFramingError);
});

test("encoding refuses a frame payload beyond its bound", () => {
  assert.throws(
    () =>
      encodeLiveRecord(
        LIVE_RECORD_FRAME_PAYLOAD,
        new Uint8Array(LIMITS.MAX_FRAME_PAYLOAD_BYTES + 1),
      ),
    LiveStreamFramingError,
  );
});
