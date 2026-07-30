/**
 * Unit tests for the live-frame scheduler and the drop policy
 * (`docs/TESTING.md` section 2: frame-drop policy under a bounded buffer,
 * quality-adaptation decisions, metadata sequencing).
 *
 * None of these needs a browser. The CDP session is a stub that emits frames
 * on demand, which is the only way to assert what happens when a viewer never
 * drains: a real socket would eventually accept the backlog and the property
 * under test would disappear.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decodeLiveViewFrame,
  type FrameMetadata,
  type LiveViewFrame,
} from "@reviewplane/protocol/live-view";

import { createRecordingLogger } from "../src/logging.ts";
import { LiveScheduler, MODE_BANDS, withinBand } from "../src/session/quality.ts";
import {
  FRAME_BUFFER_CAPACITY,
  ScreencastProducer,
  type LiveTransport,
} from "../src/session/screencast.ts";

const CAPTURE = { width: 1440, height: 900 };

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

test("each mode starts inside the band docs/ARCHITECTURE.md section 6.3 fixes", () => {
  for (const mode of ["session_room", "thumbnail"] as const) {
    const scheduler = new LiveScheduler(mode, CAPTURE);
    assert.ok(withinBand(mode, scheduler.decision().targetFps));
  }
  assert.deepEqual(
    [MODE_BANDS.session_room.minFps, MODE_BANDS.session_room.maxFps],
    [10, 20],
  );
  assert.deepEqual([MODE_BANDS.thumbnail.minFps, MODE_BANDS.thumbnail.maxFps], [2, 5]);
});

test("stepping down repeatedly never leaves the band", () => {
  const scheduler = new LiveScheduler("session_room", CAPTURE);
  for (let round = 0; round < 40; round += 1) {
    scheduler.adapt({ delivered: 1, dropped: 9, bufferDepth: 2 });
  }
  const decision = scheduler.decision();
  assert.ok(withinBand("session_room", decision.targetFps), "rate left the band");
  assert.ok(decision.quality >= MODE_BANDS.session_room.minQuality);
  assert.equal(decision.reason, "viewer_falling_behind");
  // Dimensions fall only once rate and quality are already at their floor.
  assert.ok(decision.maxWidth < CAPTURE.width, "dimensions did not adapt to bandwidth");
});

test("stepping up repeatedly never leaves the band either", () => {
  const scheduler = new LiveScheduler("thumbnail", CAPTURE);
  for (let round = 0; round < 40; round += 1) {
    scheduler.adapt({ delivered: 3, dropped: 0, bufferDepth: 0 });
  }
  const decision = scheduler.decision();
  assert.ok(withinBand("thumbnail", decision.targetFps));
  assert.equal(decision.targetFps, MODE_BANDS.thumbnail.maxFps);
  assert.ok(decision.quality <= MODE_BANDS.thumbnail.maxQuality);
});

test("a clean window with no traffic changes nothing", () => {
  const scheduler = new LiveScheduler("session_room", CAPTURE);
  const before = scheduler.decision();
  assert.equal(scheduler.adapt({ delivered: 0, dropped: 0, bufferDepth: 0 }), false);
  assert.deepEqual(scheduler.decision(), before);
});

test("a viewer cannot request a rate above its mode's band", () => {
  const scheduler = new LiveScheduler("thumbnail", CAPTURE);
  scheduler.request({ maxFps: 30 });
  assert.ok(withinBand("thumbnail", scheduler.decision().targetFps));
  assert.ok(scheduler.decision().targetFps <= MODE_BANDS.thumbnail.maxFps);
});

test("a viewer can lower its own ceiling below the band", () => {
  const scheduler = new LiveScheduler("session_room", CAPTURE);
  scheduler.request({ maxFps: 4 });
  assert.equal(scheduler.decision().targetFps, 4);
});

test("a mode change resets the scheduler into the new band", () => {
  const scheduler = new LiveScheduler("session_room", CAPTURE);
  scheduler.request({ mode: "thumbnail" });
  const decision = scheduler.decision();
  assert.equal(decision.mode, "thumbnail");
  assert.equal(decision.reason, "mode_changed");
  assert.ok(withinBand("thumbnail", decision.targetFps));
  assert.ok(decision.maxWidth <= CAPTURE.width * MODE_BANDS.thumbnail.maxScale);
});

test("a viewer asking for a smaller canvas is honoured", () => {
  const scheduler = new LiveScheduler("session_room", CAPTURE);
  scheduler.request({ maxWidth: 720 });
  const decision = scheduler.decision();
  assert.equal(decision.maxWidth, 720);
  // The aspect ratio of the capture is preserved rather than squashed.
  assert.equal(decision.maxHeight, Math.round(900 * (720 / 1440)));
});

// ---------------------------------------------------------------------------
// Producer: drop policy, sequencing and lifetime
// ---------------------------------------------------------------------------

/** A CDP session that emits screencast frames when a test tells it to. */
function stubCdp(): {
  session: {
    on: (event: string, handler: (payload: unknown) => void) => void;
    send: (method: string, params?: unknown) => Promise<unknown>;
    detach: () => Promise<void>;
  };
  emit: (bytes: number) => void;
  calls: string[];
  acks: number;
} {
  const handlers = new Map<string, (payload: unknown) => void>();
  const calls: string[] = [];
  const state = { acks: 0 };
  const session = {
    on(event: string, handler: (payload: unknown) => void): void {
      handlers.set(event, handler);
    },
    async send(method: string): Promise<unknown> {
      calls.push(method);
      if (method === "Page.screencastFrameAck") state.acks += 1;
      return Promise.resolve({});
    },
    async detach(): Promise<void> {
      calls.push("detach");
      return Promise.resolve();
    },
  };
  return {
    session,
    calls,
    get acks(): number {
      return state.acks;
    },
    emit(bytes: number): void {
      const handler = handlers.get("Page.screencastFrame");
      assert.ok(handler !== undefined, "no screencast handler registered");
      handler({
        data: Buffer.alloc(bytes, 0x41).toString("base64"),
        sessionId: 1,
      });
    },
  };
}

/** A transport that records everything and can refuse to drain. */
function recordingTransport(): LiveTransport & {
  readonly messages: LiveViewFrame[];
  readonly frames: { metadata: FrameMetadata; bytes: number }[];
  saturate: (value: boolean) => void;
} {
  const messages: LiveViewFrame[] = [];
  const frames: { metadata: FrameMetadata; bytes: number }[] = [];
  let saturated = false;
  return {
    messages,
    frames,
    saturate(value: boolean): void {
      saturated = value;
    },
    get writable(): boolean {
      return !saturated;
    },
    writeMessage(json: string): void {
      const decoded = decodeLiveViewFrame(json);
      assert.ok(decoded.ok, `producer wrote a message the protocol refuses: ${json}`);
      messages.push(decoded.value);
    },
    writeFrame(metadataJson: string, payload: Uint8Array): void {
      const decoded = decodeLiveViewFrame(metadataJson);
      assert.ok(decoded.ok, "producer wrote frame metadata the protocol refuses");
      assert.equal(decoded.value.type, "live.frame");
      const metadata = decoded.value.payload as FrameMetadata;
      assert.equal(
        metadata.byte_length,
        payload.byteLength,
        "declared byte_length must match the payload that follows",
      );
      frames.push({ metadata, bytes: payload.byteLength });
    },
  };
}

interface Clock {
  now: () => Date;
  advance: (ms: number) => void;
}

function clock(): Clock {
  let millis = Date.parse("2026-07-30T10:00:00.000Z");
  return {
    now: () => new Date(millis),
    advance(ms: number): void {
      millis += ms;
    },
  };
}

async function startProducer(
  transport: LiveTransport,
  time: Clock,
  mode: "session_room" | "thumbnail" = "session_room",
): Promise<{ producer: ScreencastProducer; cdp: ReturnType<typeof stubCdp> }> {
  const cdp = stubCdp();
  const producer = new ScreencastProducer({
    browserSessionId: "brs_livetest",
    page: {} as never,
    capture: CAPTURE,
    mode,
    logger: createRecordingLogger().logger,
    now: time.now,
    attach: async () => Promise.resolve(cdp.session as never),
  });
  await producer.start(transport);
  return { producer, cdp };
}

test("a slow viewer sees frames dropped, not queued", async () => {
  const time = clock();
  const transport = recordingTransport();
  const { producer, cdp } = await startProducer(transport, time);

  transport.saturate(true);
  for (let index = 0; index < 20; index += 1) {
    time.advance(200);
    cdp.emit(1024);
  }

  const stats = producer.stats();
  assert.equal(transport.frames.length, 0, "nothing should reach a saturated viewer");
  assert.ok(
    stats.bufferDepth <= FRAME_BUFFER_CAPACITY,
    `buffer grew to ${String(stats.bufferDepth)}`,
  );
  assert.equal(stats.framesDropped, 20 - FRAME_BUFFER_CAPACITY);
  await producer.stop();
});

test("when the viewer drains it receives the newest frames and a drop count", async () => {
  const time = clock();
  const transport = recordingTransport();
  const { producer, cdp } = await startProducer(transport, time);

  transport.saturate(true);
  for (let index = 0; index < 6; index += 1) {
    time.advance(200);
    cdp.emit(512);
  }
  transport.saturate(false);
  producer.flush();

  assert.equal(transport.frames.length, FRAME_BUFFER_CAPACITY);
  const sequences = transport.frames.map((frame) => frame.metadata.sequence);
  // The newest frames survive; the sequence gap is the evidence of the drop.
  assert.deepEqual(sequences, [5, 6]);
  assert.equal(transport.frames[0]?.metadata.dropped_before, 4);
  assert.equal(transport.frames[1]?.metadata.dropped_before, 0);
  await producer.stop();
});

test("frames arriving faster than the target rate are sampled, not counted as drops", async () => {
  const time = clock();
  const transport = recordingTransport();
  const { producer, cdp } = await startProducer(transport, time);

  // 100 paints one millisecond apart. At the session-room start rate the
  // producer wants one every 66 ms, so almost all of these are declined
  // before they ever become stream frames.
  for (let index = 0; index < 100; index += 1) {
    time.advance(1);
    cdp.emit(256);
  }

  assert.equal(producer.stats().framesDropped, 0, "sampling must not read as backpressure");
  assert.ok(transport.frames.length <= 3, "the target rate was not honoured");
  // Every paint is acknowledged even when its frame is declined, or Chromium
  // stops sending.
  assert.equal(cdp.acks, 100);
  await producer.stop();
});

test("sequence numbers are monotonic and metadata precedes each payload", async () => {
  const time = clock();
  const transport = recordingTransport();
  const { producer, cdp } = await startProducer(transport, time);

  for (let index = 0; index < 5; index += 1) {
    time.advance(200);
    cdp.emit(700 + index);
  }

  const sequences = transport.frames.map((frame) => frame.metadata.sequence);
  assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right));
  assert.equal(new Set(sequences).size, sequences.length);
  for (const frame of transport.frames) {
    assert.equal(frame.metadata.format, "image/jpeg");
    assert.equal(frame.metadata.mode, "session_room");
  }
  await producer.stop();
});

test("stopping detaches the CDP session and stops the screencast", async () => {
  const time = clock();
  const transport = recordingTransport();
  const { producer, cdp } = await startProducer(transport, time);
  await producer.stop();
  assert.ok(cdp.calls.includes("Page.stopScreencast"));
  assert.ok(cdp.calls.includes("detach"));
  assert.equal(producer.running, false);

  // A frame arriving after the stop is ignored rather than streamed to nobody.
  const before = transport.frames.length;
  time.advance(500);
  cdp.emit(256);
  assert.equal(transport.frames.length, before);
});

test("a quality request is answered with the scheduler's decision", async () => {
  const time = clock();
  const transport = recordingTransport();
  const { producer } = await startProducer(transport, time);
  const applied = await producer.requestQuality({ mode: "thumbnail" });
  assert.equal(applied.mode, "thumbnail");
  assert.ok(withinBand("thumbnail", applied.target_fps));
  const published = transport.messages.filter((message) => message.type === "live.quality");
  assert.ok(published.length >= 2, "the applied decision must be published to the viewer");
  await producer.stop();
});

test("a screencast that will not start is reported without touching the page", async () => {
  const producer = new ScreencastProducer({
    browserSessionId: "brs_livetest",
    page: {} as never,
    capture: CAPTURE,
    mode: "session_room",
    logger: createRecordingLogger().logger,
    attach: async () => Promise.reject(new Error("Target closed")),
  });
  await assert.rejects(
    () => producer.start(recordingTransport()),
    /could not attach a CDP session/u,
  );
  assert.equal(producer.running, false);
});
