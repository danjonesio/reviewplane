/**
 * The live-view client, tested without a browser.
 *
 * Reconnect, stall detection and the metadata/payload pairing are the parts a
 * user notices when they break and the parts a rendering test would hide, so
 * they are exercised here against a fake socket and a controlled clock.
 * `docs/TESTING.md` section 11 requires the API-restart case specifically.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FAILURE_STATE_VALUES,
  encodeLiveViewFrame,
  type FrameMetadata,
} from "@reviewplane/protocol/live-view";

import {
  FAILURE_COPY,
  LiveClient,
  RECONNECT_MAX_MS,
  STALL_AFTER_MS,
  STATUS_COPY,
  VIEWER_HEARTBEAT_MS,
  type LiveFailure,
  type LiveStatus,
  type SocketLike,
} from "../src/live/client.ts";

const SESSION = "brs_web_test";

interface FakeSocket extends SocketLike {
  readonly sent: string[];
  openIt(): void;
  text(payload: string): void;
  binary(payload: Uint8Array): void;
  closeIt(code?: number): void;
  readonly closedByClient: boolean;
}

function fakeSocket(): FakeSocket {
  const sent: string[] = [];
  const state = { closed: false };
  const socket: FakeSocket = {
    binaryType: "blob",
    sent,
    get closedByClient(): boolean {
      return state.closed;
    },
    close(): void {
      state.closed = true;
    },
    send(data: string): void {
      sent.push(data);
    },
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    openIt(): void {
      socket.onopen?.();
    },
    text(payload: string): void {
      socket.onmessage?.({ data: payload });
    },
    binary(payload: Uint8Array): void {
      socket.onmessage?.({
        data: payload.buffer.slice(
          payload.byteOffset,
          payload.byteOffset + payload.byteLength,
        ) as ArrayBuffer,
      });
    },
    closeIt(code = 1006): void {
      socket.onclose?.({ code, reason: "" });
    },
  };
  return socket;
}

/** A manual clock, so a backoff is asserted rather than waited for. */
function harness(): {
  readonly sockets: FakeSocket[];
  readonly statuses: { status: LiveStatus; failure: LiveFailure | null }[];
  readonly frames: { metadata: FrameMetadata; bytes: number }[];
  client: LiveClient;
  run(ms: number): void;
  now(): number;
} {
  const sockets: FakeSocket[] = [];
  const statuses: { status: LiveStatus; failure: LiveFailure | null }[] = [];
  const frames: { metadata: FrameMetadata; bytes: number }[] = [];
  const timers: { at: number; callback: () => void; id: number }[] = [];
  let clock = 0;
  let nextId = 1;

  const client = new LiveClient({
    url: "wss://reviewplane.test/ws/v1/browser-sessions/brs_web_test/live",
    now: () => clock,
    jitter: () => 1,
    setTimer: (callback, ms) => {
      const id = nextId;
      nextId += 1;
      timers.push({ at: clock + ms, callback, id });
      return id;
    },
    clearTimer: (handle) => {
      const index = timers.findIndex((timer) => timer.id === handle);
      if (index !== -1) timers.splice(index, 1);
    },
    openSocket: () => {
      const socket = fakeSocket();
      sockets.push(socket);
      return socket;
    },
    events: {
      onStatus: (status, failure) => {
        statuses.push({ status, failure });
      },
      onFrame: (payload, metadata) => {
        frames.push({ metadata, bytes: payload.byteLength });
      },
      onSessionState: () => undefined,
      onQuality: () => undefined,
      onHeartbeat: () => undefined,
    },
  });

  return {
    sockets,
    statuses,
    frames,
    client,
    now: () => clock,
    run(ms: number): void {
      const target = clock + ms;
      for (;;) {
        const due = timers
          .filter((timer) => timer.at <= target)
          .sort((left, right) => left.at - right.at)[0];
        if (due === undefined) break;
        timers.splice(timers.indexOf(due), 1);
        clock = due.at;
        due.callback();
      }
      clock = target;
    },
  };
}

function frameMetadata(sequence: number, byteLength: number): FrameMetadata {
  return {
    sequence,
    captured_at: "2026-07-30T10:04:12.137Z",
    mode: "session_room",
    format: "image/jpeg",
    width: 1440,
    height: 900,
    quality: 65,
    byte_length: byteLength,
    dropped_before: 0,
  };
}

function metadataMessage(sequence: number, byteLength: number): string {
  return encodeLiveViewFrame({
    envelope: {
      protocol_version: 1,
      message_id: `msg_${String(sequence)}`,
      type: "live.frame",
      sent_at: "2026-07-30T10:04:12.140Z",
      browser_session_id: SESSION,
      stream_id: "lvs_web",
    },
    type: "live.frame",
    payload: frameMetadata(sequence, byteLength),
  });
}

function errorMessage(retryable: boolean): string {
  return encodeLiveViewFrame({
    envelope: {
      protocol_version: 1,
      message_id: "msg_error",
      type: "live.error",
      sent_at: "2026-07-30T10:04:12.140Z",
      browser_session_id: SESSION,
    },
    type: "live.error",
    payload: {
      code: retryable ? "BROWSER_SESSION_NOT_ACTIVE" : "PROJECT_CONTEXT_MISMATCH",
      state: retryable ? "browser_worker_failed" : "not_authorised_for_project",
      message: retryable ? "The worker stopped." : "Not your project.",
      retryable,
    },
  });
}

test("a frame is painted only when its payload follows its metadata", () => {
  const context = harness();
  context.client.connect();
  context.sockets[0]?.openIt();

  const payload = new Uint8Array([1, 2, 3, 4]);
  context.sockets[0]?.text(metadataMessage(1, payload.byteLength));
  context.sockets[0]?.binary(payload);

  assert.equal(context.frames.length, 1);
  assert.equal(context.frames[0]?.metadata.sequence, 1);
  assert.equal(context.frames[0]?.bytes, 4);
  assert.equal(context.client.status, "live");
});

test("a payload with no metadata before it is not painted", () => {
  const context = harness();
  context.client.connect();
  context.sockets[0]?.openIt();
  context.sockets[0]?.binary(new Uint8Array([9, 9]));
  assert.equal(context.frames.length, 0);
});

test("a payload whose length disagrees with its metadata is not painted", () => {
  const context = harness();
  context.client.connect();
  context.sockets[0]?.openIt();
  context.sockets[0]?.text(metadataMessage(1, 100));
  context.sockets[0]?.binary(new Uint8Array([1, 2]));
  assert.equal(context.frames.length, 0);
});

test("an API restart is followed by a reconnect that resumes the stream", () => {
  const context = harness();
  context.client.connect();
  context.sockets[0]?.openIt();
  context.sockets[0]?.text(metadataMessage(1, 2));
  context.sockets[0]?.binary(new Uint8Array([1, 2]));
  assert.equal(context.client.status, "live");

  // The control plane goes away mid-stream.
  context.sockets[0]?.closeIt(1006);
  assert.equal(context.client.status, "reconnecting");

  // A reconnect is scheduled rather than attempted immediately.
  assert.equal(context.sockets.length, 1);
  context.run(1000);
  assert.equal(context.sockets.length, 2, "the client must reopen the stream");

  context.sockets[1]?.openIt();
  context.sockets[1]?.text(metadataMessage(2, 2));
  context.sockets[1]?.binary(new Uint8Array([3, 4]));
  assert.equal(context.frames.length, 2);
  assert.equal(context.client.status, "live");
});

test("the reconnect backoff grows and is bounded", () => {
  const context = harness();
  context.client.connect();
  const delays: number[] = [];
  let previous = context.now();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const socket = context.sockets.at(-1);
    socket?.openIt();
    socket?.closeIt(1006);
    const before = context.sockets.length;
    // Advance generously; the timer fires at its own scheduled instant.
    context.run(RECONNECT_MAX_MS * 2);
    assert.equal(context.sockets.length, before + 1);
    delays.push(context.now() - previous);
    previous = context.now();
  }
  // Bounded: no wait exceeds the ceiling, so a long outage does not turn into
  // an ever-growing silence.
  for (const delay of delays) assert.ok(delay <= RECONNECT_MAX_MS * 2);
});

test("a non-retryable refusal stops the client reconnecting", () => {
  const context = harness();
  context.client.connect();
  context.sockets[0]?.openIt();
  context.sockets[0]?.text(errorMessage(false));
  context.sockets[0]?.closeIt(1000);
  context.run(RECONNECT_MAX_MS * 4);
  assert.equal(context.sockets.length, 1, "a refused viewer must not reconnect in a loop");
  assert.equal(context.client.status, "failed");
  assert.equal(context.client.failure?.state, "not_authorised_for_project");
});

test("a retryable stream failure keeps reconnecting", () => {
  const context = harness();
  context.client.connect();
  context.sockets[0]?.openIt();
  context.sockets[0]?.text(errorMessage(true));
  assert.equal(context.client.failure?.state, "browser_worker_failed");
  context.sockets[0]?.closeIt(1006);
  context.run(RECONNECT_MAX_MS * 2);
  assert.equal(context.sockets.length, 2);
});

test("a connected stream that stops painting reports a stall", () => {
  const context = harness();
  context.client.connect();
  context.sockets[0]?.openIt();
  context.sockets[0]?.text(metadataMessage(1, 1));
  context.sockets[0]?.binary(new Uint8Array([1]));
  assert.equal(context.client.status, "live");
  context.run(STALL_AFTER_MS + 100);
  assert.equal(context.client.status, "stalled");
  assert.equal(context.client.failure?.state, "live_capture_unavailable");
});

test("the viewer heartbeat reports the sequence actually painted", () => {
  const context = harness();
  context.client.connect();
  context.sockets[0]?.openIt();
  context.sockets[0]?.text(metadataMessage(41, 1));
  context.sockets[0]?.binary(new Uint8Array([1]));
  context.client.markRendered(41);
  context.run(VIEWER_HEARTBEAT_MS + 10);

  const beat = context.sockets[0]?.sent.at(-1);
  assert.ok(beat !== undefined);
  const parsed = JSON.parse(beat) as {
    type: string;
    payload: { last_sequence_rendered: number };
  };
  assert.equal(parsed.type, "live.viewer_heartbeat");
  assert.equal(parsed.payload.last_sequence_rendered, 41);
});

test("a quality request is a valid protocol message", () => {
  const context = harness();
  context.client.connect();
  context.sockets[0]?.openIt();
  // The session identity comes from the stream, so a request before any
  // message is not sent at all rather than sent with a guessed identity.
  context.client.requestQuality({ mode: "thumbnail" });
  assert.equal(context.sockets[0]?.sent.length, 0);

  context.sockets[0]?.text(metadataMessage(1, 1));
  context.client.requestQuality({ mode: "thumbnail", maxFps: 5 });
  const sent = context.sockets[0]?.sent.at(-1);
  assert.ok(sent !== undefined);
  const parsed = JSON.parse(sent) as { type: string; payload: { mode: string; max_fps: number } };
  assert.equal(parsed.type, "live.quality_request");
  assert.equal(parsed.payload.mode, "thumbnail");
  assert.equal(parsed.payload.max_fps, 5);
});

test("closing deliberately does not reconnect", () => {
  const context = harness();
  context.client.connect();
  context.sockets[0]?.openIt();
  context.client.close();
  context.sockets[0]?.closeIt(1000);
  context.run(RECONNECT_MAX_MS * 4);
  assert.equal(context.sockets.length, 1);
  assert.equal(context.client.status, "stopped");
});

test("every status and every failure state has human copy", () => {
  const statuses: LiveStatus[] = [
    "connecting",
    "live",
    "waiting_for_frames",
    "reconnecting",
    "stalled",
    "stopped",
    "failed",
  ];
  for (const status of statuses) {
    assert.ok(STATUS_COPY[status].length > 0, `${status} has no text`);
  }
  for (const state of FAILURE_STATE_VALUES) {
    const copy = FAILURE_COPY[state];
    assert.ok(copy.title.length > 0, `${state} has no title`);
    // docs/UX_FLOWS.md section 18: the reader must be told what to do, not
    // merely that something failed.
    assert.ok(copy.action.length > 0, `${state} has no action`);
    assert.ok(
      !/something went wrong/iu.test(`${copy.title} ${copy.action}`),
      `${state} uses a generic message`,
    );
  }
});
