/**
 * The relay's fan-out and drop policy, with no database and no socket.
 *
 * The property under test is the one a live system hides: a viewer that never
 * drains must cost a constant amount of memory and must not slow the others
 * down. A real socket eventually accepts what is written to it, so the only
 * way to assert the policy is against a socket that never does.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LIVE_RECORD_FRAME_PAYLOAD,
  LIVE_RECORD_MESSAGE,
  encodeLiveViewFrame,
  type FrameMetadata,
  type LiveRecord,
} from "@reviewplane/protocol/live-view";

import type { BrowserSessionRecord } from "../src/modules/browser-sessions/service.ts";
import { LiveRelay, VIEWER_BUFFER_BYTES, type LiveViewer } from "../src/modules/live/relay.ts";
import type { WorkerLiveClient } from "../src/modules/live/worker-live-client.ts";

const SESSION = {
  id: "brs_relay_test",
  organisation_id: "org_relay",
  project_id: "prj_relay",
  worker_id: "wkr_relay",
  agent_session_id: null,
  published_service_id: null,
  service_origin: "https://route-relay.internal.invalid",
  browser_type: "chromium",
  browser_version: "143.0.0.0",
  status: "ACTIVE",
  current_controller: null,
  control_epoch: 1,
  last_sequence: 0,
  viewport: { width: 1440, height: 900, device_scale_factor: 1 },
  limits: {
    max_duration_seconds: 7200,
    default_timeout_ms: 30000,
    max_command_timeout_ms: 120000,
    screenshot_max_bytes: 20971520,
    snapshot_max_nodes: 400,
    snapshot_max_bytes: 32768,
  },
  retention_policy: "verification_evidence",
  created_at: "2026-07-30T10:00:00.000Z",
  ended_at: null,
} as unknown as BrowserSessionRecord;

const SILENT = { info: () => undefined, warn: () => undefined };

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

/** A worker stream the test feeds by hand. */
function scriptedClient(): {
  client: WorkerLiveClient;
  push: (record: LiveRecord) => void;
  end: () => void;
  closes: number;
} {
  const queue: LiveRecord[] = [];
  const waiters: (() => void)[] = [];
  const state = { done: false, closes: 0 };

  const records = (async function* iterate(): AsyncGenerator<LiveRecord> {
    for (;;) {
      while (queue.length > 0) yield queue.shift() as LiveRecord;
      if (state.done) return;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  })();

  const client = {
    open: async () =>
      Promise.resolve({
        records,
        close(): void {
          state.closes += 1;
          state.done = true;
          for (const waiter of waiters.splice(0)) waiter();
        },
      }),
    requestQuality: async () => Promise.reject(new Error("not used")),
  } as unknown as WorkerLiveClient;

  return {
    client,
    push(record: LiveRecord): void {
      queue.push(record);
      for (const waiter of waiters.splice(0)) waiter();
    },
    end(): void {
      state.done = true;
      for (const waiter of waiters.splice(0)) waiter();
    },
    get closes(): number {
      return state.closes;
    },
  };
}

function messageRecord(json: string): LiveRecord {
  return { kind: LIVE_RECORD_MESSAGE, bytes: new TextEncoder().encode(json) };
}

function payloadRecord(bytes: Uint8Array): LiveRecord {
  return { kind: LIVE_RECORD_FRAME_PAYLOAD, bytes };
}

function frameRecords(sequence: number, payload: Uint8Array): LiveRecord[] {
  return [
    messageRecord(
      encodeLiveViewFrame({
        envelope: {
          protocol_version: 1,
          message_id: `msg_${String(sequence)}`,
          type: "live.frame",
          sent_at: "2026-07-30T10:04:12.140Z",
          browser_session_id: SESSION.id,
          stream_id: "lvs_relay",
        },
        type: "live.frame",
        payload: frameMetadata(sequence, payload.byteLength),
      }),
    ),
    payloadRecord(payload),
  ];
}

interface FakeViewer extends LiveViewer {
  readonly texts: string[];
  readonly binaries: number[];
  stall(bytes: number): void;
}

function fakeViewer(id: string): FakeViewer {
  const texts: string[] = [];
  const binaries: number[] = [];
  const state = { buffered: 0, open: true };
  const viewer: FakeViewer = {
    id,
    viewerSessionId: "vwr_test",
    framesSent: 0,
    framesDropped: 0,
    droppedBefore: 0,
    texts,
    binaries,
    stall(bytes: number): void {
      state.buffered = bytes;
    },
    socket: {
      get bufferedAmount(): number {
        return state.buffered;
      },
      get open(): boolean {
        return state.open;
      },
      sendText(payload: string): void {
        texts.push(payload);
      },
      sendBinary(payload: Uint8Array): void {
        binaries.push(payload.byteLength);
      },
      close(): void {
        state.open = false;
      },
    },
  };
  return viewer;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("a stalled viewer is dropped past while the others keep up", async () => {
  const scripted = scriptedClient();
  const relay = new LiveRelay({ client: scripted.client, logger: SILENT });
  const fast = fakeViewer("lvw_fast");
  const slow = fakeViewer("lvw_slow");
  await relay.attach(SESSION, fast, "session_room");
  await relay.attach(SESSION, slow, "session_room");

  slow.stall(VIEWER_BUFFER_BYTES + 1);
  for (let sequence = 1; sequence <= 30; sequence += 1) {
    for (const record of frameRecords(sequence, new Uint8Array(1024))) scripted.push(record);
  }
  await settle();

  assert.equal(fast.framesSent, 30, "the fast viewer must be unaffected");
  assert.equal(slow.framesSent, 0);
  assert.equal(slow.framesDropped, 30);
  assert.equal(slow.binaries.length, 0, "no bytes may be queued for a stalled viewer");
  scripted.end();
});

test("a viewer that recovers is told how many frames it missed", async () => {
  const scripted = scriptedClient();
  const relay = new LiveRelay({ client: scripted.client, logger: SILENT });
  const viewer = fakeViewer("lvw_recovering");
  await relay.attach(SESSION, viewer, "session_room");

  viewer.stall(VIEWER_BUFFER_BYTES + 1);
  for (let sequence = 1; sequence <= 5; sequence += 1) {
    for (const record of frameRecords(sequence, new Uint8Array(64))) scripted.push(record);
  }
  await settle();
  viewer.stall(0);
  for (const record of frameRecords(6, new Uint8Array(64))) scripted.push(record);
  await settle();

  assert.equal(viewer.framesSent, 1);
  const delivered = viewer.texts.at(-1) as string;
  const metadata = JSON.parse(delivered) as { payload: FrameMetadata };
  assert.equal(metadata.payload.sequence, 6, "the newest frame is the one delivered");
  assert.equal(metadata.payload.dropped_before, 5);
  scripted.end();
});

test("a payload with no preceding metadata is discarded", async () => {
  const scripted = scriptedClient();
  const relay = new LiveRelay({ client: scripted.client, logger: SILENT });
  const viewer = fakeViewer("lvw_orphan");
  await relay.attach(SESSION, viewer, "session_room");

  scripted.push(payloadRecord(new Uint8Array(32)));
  await settle();
  assert.equal(viewer.binaries.length, 0);
  assert.equal(viewer.framesSent, 0);
  scripted.end();
});

test("a payload whose length disagrees with its metadata is discarded", async () => {
  const scripted = scriptedClient();
  const relay = new LiveRelay({ client: scripted.client, logger: SILENT });
  const viewer = fakeViewer("lvw_mismatch");
  await relay.attach(SESSION, viewer, "session_room");

  const [metadata] = frameRecords(1, new Uint8Array(1024));
  scripted.push(metadata as LiveRecord);
  scripted.push(payloadRecord(new Uint8Array(16)));
  await settle();
  assert.equal(viewer.framesSent, 0);
  scripted.end();
});

test("the worker stream is closed exactly once, when the last viewer leaves", async () => {
  const scripted = scriptedClient();
  const relay = new LiveRelay({ client: scripted.client, logger: SILENT });
  const first = fakeViewer("lvw_1");
  const second = fakeViewer("lvw_2");
  await relay.attach(SESSION, first, "session_room");
  await relay.attach(SESSION, second, "session_room");
  assert.equal(relay.activeStreams, 1);

  relay.detach(SESSION.id, first.id);
  assert.equal(scripted.closes, 0);
  relay.detach(SESSION.id, second.id);
  assert.equal(scripted.closes, 1);
  relay.detach(SESSION.id, second.id);
  assert.equal(scripted.closes, 1);
  assert.equal(relay.activeStreams, 0);
});

test("a viewer that attaches later is given the current quality immediately", async () => {
  const scripted = scriptedClient();
  const relay = new LiveRelay({ client: scripted.client, logger: SILENT });
  const first = fakeViewer("lvw_early");
  await relay.attach(SESSION, first, "session_room");

  scripted.push(
    messageRecord(
      encodeLiveViewFrame({
        envelope: {
          protocol_version: 1,
          message_id: "msg_quality",
          type: "live.quality",
          sent_at: "2026-07-30T10:04:12.140Z",
          browser_session_id: SESSION.id,
          stream_id: "lvs_relay",
        },
        type: "live.quality",
        payload: {
          mode: "session_room",
          target_fps: 12,
          quality: 55,
          max_width: 1152,
          max_height: 720,
          reason: "viewer_falling_behind",
          decided_at: "2026-07-30T10:04:12.100Z",
        },
      }),
    ),
  );
  await settle();

  const late = fakeViewer("lvw_late");
  await relay.attach(SESSION, late, "session_room");
  assert.equal(late.texts.length, 1);
  assert.match(late.texts[0] as string, /live\.quality/u);
  scripted.end();
});
