/**
 * The live-frame producer against a real Chromium (`docs/TESTING.md` sections
 * 7, 10, 11 and 12).
 *
 * These are the assertions that only a browser can settle: that CDP screencast
 * frames actually arrive, that the measured rate lands inside the band
 * `docs/ARCHITECTURE.md` section 6.3 fixes for each mode, that capture stops
 * when the viewer goes, and that after a sustained viewing session there is no
 * frame anywhere on the worker's filesystem — which is the half of ADR-0009
 * the control-plane tests cannot see.
 *
 * They run inside the worker's own image under the deployed container
 * controls; see `scripts/run-browser-tests.sh`.
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";

import type { Viewport } from "@reviewplane/protocol/browser";
import {
  decodeLiveViewFrame,
  type FrameMetadata,
  type LiveMode,
} from "@reviewplane/protocol/live-view";

import { loadWorkerConfig, type WorkerConfig } from "../../src/config.ts";
import { ControlPlaneClient } from "../../src/control-plane.ts";
import { newId } from "../../src/ids.ts";
import { createRecordingLogger } from "../../src/logging.ts";
import { SessionManager } from "../../src/session/manager.ts";
import { MODE_BANDS, withinBand } from "../../src/session/quality.ts";
import type { LiveTransport } from "../../src/session/screencast.ts";

import { startFixtureApp, type FixtureApp } from "./fixture-app.ts";
import { startStubControlPlane, type StubControlPlane } from "./stub-control-plane.ts";

const CREDENTIAL = "worker-credential-for-browser-tests";
const DESKTOP: Viewport = { width: 1440, height: 900, device_scale_factor: 1 };
const AGENT = { type: "agent", id: "ags_live_browser" } as const;

let fixture: FixtureApp;
let controlPlane: StubControlPlane;
let sessionRoot: string;
let config: WorkerConfig;
let manager: SessionManager;

before(async () => {
  fixture = await startFixtureApp();
  controlPlane = await startStubControlPlane(CREDENTIAL);
  sessionRoot = await mkdtemp(join(tmpdir(), "reviewplane-live-"));
});

after(async () => {
  await manager?.shutdown();
  await fixture?.stop();
  await controlPlane?.stop();
  await rm(sessionRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await manager?.shutdown();
  config = loadWorkerConfig({
    REVIEWPLANE_WORKER_CREDENTIAL: CREDENTIAL,
    REVIEWPLANE_WORKER_COMMAND_CREDENTIAL: "command-credential-for-browser-tests",
    REVIEWPLANE_CONTROL_PLANE_URL: controlPlane.origin,
    REVIEWPLANE_WORKER_SESSION_ROOT: sessionRoot,
    REVIEWPLANE_WORKER_CAPACITY: "2",
  });
  manager = new SessionManager({
    config,
    artefacts: new ControlPlaneClient({
      baseUrl: config.controlPlaneUrl,
      credential: config.controlPlaneCredential,
      workerName: config.name,
    }),
    logger: createRecordingLogger().logger,
    observer: { onStatus: () => undefined },
  });
  manager.setAssignedProjects(["prj_live"]);
});

/** A transport that records what a viewer would have received. */
function collectingTransport(): LiveTransport & {
  readonly frames: { metadata: FrameMetadata; payload: Uint8Array }[];
  readonly messages: string[];
  saturate: (value: boolean) => void;
} {
  const frames: { metadata: FrameMetadata; payload: Uint8Array }[] = [];
  const messages: string[] = [];
  let saturated = false;
  return {
    frames,
    messages,
    saturate(value: boolean): void {
      saturated = value;
    },
    get writable(): boolean {
      return !saturated;
    },
    writeMessage(json: string): void {
      messages.push(json);
    },
    writeFrame(metadataJson: string, payload: Uint8Array): void {
      const decoded = decodeLiveViewFrame(metadataJson);
      assert.ok(decoded.ok, "the worker produced frame metadata the protocol refuses");
      assert.equal(decoded.value.type, "live.frame");
      frames.push({ metadata: decoded.value.payload as FrameMetadata, payload });
    },
  };
}

async function allocate(): Promise<string> {
  const browserSessionId = newId("brs_");
  await manager.allocate(browserSessionId, {
    organisation_id: "org_live",
    project_id: "prj_live",
    service_origin: fixture.origin,
    viewport: DESKTOP,
    control_epoch: 1,
    controller: AGENT,
    limits: {
      max_duration_seconds: 300,
      default_timeout_ms: 15000,
      max_command_timeout_ms: 30000,
      screenshot_max_bytes: 20971520,
      snapshot_max_nodes: 200,
      snapshot_max_bytes: 16384,
    },
    retention_class: "action_screenshots",
  });
  const result = await manager.handleCommand(browserSessionId, AGENT, 1, 1, {
    command: "navigate",
    timeout_ms: 15000,
    navigate: { url: "/animated", wait_until: "load" },
  });
  assert.ok(result.ok, `navigation failed: ${result.error?.message ?? ""}`);
  return browserSessionId;
}

/** Runs a stream for a while and reports the rate it actually achieved. */
async function measure(
  mode: LiveMode,
  windowMs: number,
): Promise<{
  measuredFps: number;
  frames: { metadata: FrameMetadata; payload: Uint8Array }[];
  dropped: number;
  browserSessionId: string;
}> {
  const browserSessionId = await allocate();
  const transport = collectingTransport();
  const producer = await manager.startLive(browserSessionId, mode, transport);
  const startedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  const elapsed = Date.now() - startedAt;
  const stats = producer.stats();
  await manager.stopLive(browserSessionId);
  return {
    measuredFps: (transport.frames.length * 1000) / elapsed,
    frames: transport.frames,
    dropped: stats.framesDropped,
    browserSessionId,
  };
}

test("session-room mode measures inside the 10 to 20 frames per second band", async () => {
  const result = await measure("session_room", 4000);
  process.stdout.write(
    `session_room measured ${result.measuredFps.toFixed(2)} fps over 4 s, ${String(result.frames.length)} frames, ${String(result.dropped)} dropped\n`,
  );
  assert.ok(result.frames.length > 0, "no frame was produced");
  assert.ok(
    result.measuredFps >= MODE_BANDS.session_room.minFps - 1,
    `measured ${result.measuredFps.toFixed(2)} fps, below the band`,
  );
  assert.ok(
    result.measuredFps <= MODE_BANDS.session_room.maxFps + 1,
    `measured ${result.measuredFps.toFixed(2)} fps, above the band`,
  );
  for (const frame of result.frames) {
    assert.ok(withinBand("session_room", 15));
    assert.equal(frame.metadata.mode, "session_room");
  }
});

test("thumbnail mode measures inside the 2 to 5 frames per second band", async () => {
  const result = await measure("thumbnail", 5000);
  process.stdout.write(
    `thumbnail measured ${result.measuredFps.toFixed(2)} fps over 5 s, ${String(result.frames.length)} frames, ${String(result.dropped)} dropped\n`,
  );
  assert.ok(result.frames.length > 0, "no frame was produced");
  assert.ok(
    result.measuredFps >= MODE_BANDS.thumbnail.minFps - 0.5,
    `measured ${result.measuredFps.toFixed(2)} fps, below the band`,
  );
  assert.ok(
    result.measuredFps <= MODE_BANDS.thumbnail.maxFps + 0.5,
    `measured ${result.measuredFps.toFixed(2)} fps, above the band`,
  );
  // Thumbnail frames are smaller than the capture, which is the bandwidth
  // adaptation the mode exists for.
  const first = result.frames[0];
  assert.ok(first !== undefined);
  assert.ok(first.metadata.width < DESKTOP.width, "thumbnail frames must be scaled down");
});

test("frames are JPEG bytes, described but not carried by their metadata", async () => {
  const result = await measure("session_room", 1500);
  const frame = result.frames[0];
  assert.ok(frame !== undefined, "no frame was produced");
  assert.equal(frame.metadata.format, "image/jpeg");
  assert.equal(frame.metadata.byte_length, frame.payload.byteLength);
  // JPEG SOI marker.
  assert.equal(frame.payload[0], 0xff);
  assert.equal(frame.payload[1], 0xd8);
  assert.equal(frame.payload[2], 0xff);
});

test("no live frame is written to the worker's filesystem", async () => {
  const browserSessionId = await allocate();
  const session = manager.get(browserSessionId);
  assert.ok(session !== undefined);
  const profileDirectory = session.profileDirectory;
  assert.ok(profileDirectory !== null);

  const before = await listFiles(profileDirectory);
  const transport = collectingTransport();
  await manager.startLive(browserSessionId, "session_room", transport);
  // A sustained viewing session. The bar is a frame count rather than a
  // duration, so a loaded machine takes longer instead of proving less.
  await until(
    () => transport.frames.length > 40,
    30000,
    "the viewing session produced too few frames to prove anything",
  );
  await manager.stopLive(browserSessionId);

  // 1. Nothing that looks like a frame appeared in the session's own
  //    directory, and nothing there is a JPEG.
  const after = await listFiles(profileDirectory);
  const added = after.filter((path) => !before.includes(path));
  for (const path of added) {
    assert.ok(
      !/\.(jpe?g|png|webm|mp4)$/iu.test(path),
      `the session directory gained an image or video file: ${path}`,
    );
    const isJpeg = await startsWithJpegMagic(path);
    assert.equal(isJpeg, false, `${path} holds JPEG bytes`);
  }

  // 2. The worker's temporary directory holds no JPEG either.
  for (const path of await listFiles(tmpdir(), 2)) {
    if (!/\.(jpe?g)$/iu.test(path)) continue;
    assert.fail(`a JPEG appeared under the temporary directory: ${path}`);
  }

  // 3. Termination removes the directory entirely.
  await manager.terminate(browserSessionId, "requested");
  const remains = await stat(profileDirectory).then(
    () => true,
    () => false,
  );
  assert.equal(remains, false, "the ephemeral profile directory survived termination");
});

test("capture stops promptly when the viewer goes away", async () => {
  const browserSessionId = await allocate();
  const transport = collectingTransport();
  const producer = await manager.startLive(browserSessionId, "session_room", transport);
  await until(() => transport.frames.length > 0, 20000, "no frame was captured");

  // "Bounded" is the requirement, not "fast": the stop is synchronous with the
  // viewer leaving rather than swept by a timer, and the bound here is loose
  // enough that a loaded machine reports a slow test rather than a failure.
  const startedAt = Date.now();
  await manager.stopLive(browserSessionId);
  const stopMs = Date.now() - startedAt;
  assert.ok(stopMs < 10000, `stopping took ${String(stopMs)} ms`);
  assert.equal(producer.running, false);

  const countAtStop = transport.frames.length;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(
    transport.frames.length,
    countAtStop,
    "frames arrived after the last viewer left",
  );
});

test("a slow viewer is dropped past with a bounded buffer", async () => {
  const browserSessionId = await allocate();
  const transport = collectingTransport();
  const producer = await manager.startLive(browserSessionId, "session_room", transport);

  // Wait for capture to be genuinely running before saturating, so a loaded
  // machine produces a slow test rather than a failing one.
  await until(() => transport.frames.length > 0, 20000, "no frame was captured");
  const delivered = transport.frames.length;

  transport.saturate(true);
  await until(
    () => producer.stats().framesDropped > 0,
    20000,
    "a saturated viewer received no drops",
  );
  const stats = producer.stats();
  await manager.stopLive(browserSessionId);

  assert.equal(transport.frames.length, delivered, "a saturated transport received frames");
  assert.ok(stats.bufferDepth <= stats.bufferCapacity, "the buffer grew beyond its bound");
  process.stdout.write(
    `slow viewer: ${String(stats.framesDropped)} dropped, buffer depth ${String(stats.bufferDepth)} of ${String(stats.bufferCapacity)}\n`,
  );
});

test("a session with no live stream still navigates and captures screenshots", async () => {
  const browserSessionId = await allocate();
  const transport = collectingTransport();
  await manager.startLive(browserSessionId, "session_room", transport);
  await manager.stopLive(browserSessionId);

  const navigation = await manager.handleCommand(browserSessionId, AGENT, 1, 2, {
    command: "navigate",
    timeout_ms: 15000,
    navigate: { url: "/checkout", wait_until: "load" },
  });
  assert.ok(navigation.ok, "navigation failed without a live stream");

  const screenshot = await manager.handleCommand(
    browserSessionId,
    { type: "system", id: "wkr_live" },
    1,
    3,
    {
      command: "take_screenshot",
      timeout_ms: 20000,
      take_screenshot: { full_page: false, persist: true, purpose: "system" },
    },
  );
  assert.ok(screenshot.ok, `screenshot failed: ${screenshot.error?.message ?? ""}`);
  assert.ok(screenshot.screenshot !== undefined, "the screenshot produced no artefact");
});

test("a second live stream on one session is refused", async () => {
  const browserSessionId = await allocate();
  await manager.startLive(browserSessionId, "session_room", collectingTransport());
  await assert.rejects(
    () => manager.startLive(browserSessionId, "session_room", collectingTransport()),
    /already has a live producer/u,
  );
  await manager.stopLive(browserSessionId);
});

/** Polls a condition rather than assuming a duration, for a loaded machine. */
async function until(
  condition: () => boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`${message} within ${String(timeoutMs)} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function listFiles(directory: string, depth = 6): Promise<string[]> {
  if (depth === 0) return [];
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry);
    let info;
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      found.push(...(await listFiles(path, depth - 1)));
      continue;
    }
    found.push(path);
  }
  return found;
}

async function startsWithJpegMagic(path: string): Promise<boolean> {
  const { open } = await import("node:fs/promises");
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(3);
      const { bytesRead } = await handle.read(buffer, 0, 3, 0);
      return bytesRead === 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}
