/**
 * The live-frame producer: CDP screencast in, bounded stream out.
 *
 * `docs/ARCHITECTURE.md` sections 4.5 and 6.3 make this the worker's job, and
 * fix the three properties that matter:
 *
 *   * the worker's scheduler is authoritative over rate, quality and size
 *     (`docs/API.md` section 18.2). `quality.ts` holds those decisions; this
 *     file applies them to Chromium and measures the result;
 *   * frames are dropped rather than queued when a viewer falls behind. The
 *     buffer is a fixed two frames deep, and the frame it discards is the
 *     oldest, so a slow viewer sees fewer, newer frames;
 *   * frames are ephemeral (ADR-0009, `docs/SECURITY.md` section 14
 *     `live_frames: never`). Nothing here writes a frame to disk, hands one to
 *     the artefact uploader, or logs one. The bytes exist as a buffer between
 *     the CDP callback and the socket write and are referenced nowhere else.
 *
 * Rate control and backpressure are deliberately counted apart. Chromium
 * paints when it likes; the frames this producer declines because the target
 * interval has not elapsed are not stream frames at all and are never given a
 * sequence number. Only a frame that entered the buffer and was then discarded
 * to make room counts as dropped, so the drop rate the scheduler adapts on is
 * a statement about the viewer rather than about the page's paint rate.
 */

import type { CDPSession, Page } from "playwright-core";

import {
  encodeLiveViewFrame,
  type FrameMetadata,
  type LiveMode,
  type LiveViewFrame,
  type QualityState,
} from "@reviewplane/protocol/live-view";

import { newId } from "../ids.ts";
import type { Logger } from "../logging.ts";
import { LiveScheduler, type CaptureBounds, type ViewerPreference } from "./quality.ts";

/** Frames held between capture and write. Two is the whole backlog allowed. */
export const FRAME_BUFFER_CAPACITY = 2;

/** How often the scheduler reconsiders, and a heartbeat is emitted. */
export const ADAPTATION_INTERVAL_MS = 1000;

/**
 * The transport a producer writes to. It is an interface so the drop policy
 * can be tested against a transport that never drains, with no browser and no
 * socket involved.
 */
export interface LiveTransport {
  /** False while the transport is saturated; the producer then buffers. */
  readonly writable: boolean;
  writeMessage(json: string): void;
  writeFrame(metadataJson: string, payload: Uint8Array): void;
}

export interface ProducerStats {
  readonly framesSent: number;
  readonly framesDropped: number;
  readonly bufferDepth: number;
  readonly bufferCapacity: number;
  readonly measuredFps: number;
  readonly running: boolean;
}

export interface ScreencastOptions {
  readonly browserSessionId: string;
  readonly page: Page;
  readonly capture: CaptureBounds;
  readonly mode: LiveMode;
  readonly logger: Logger;
  /** Injected by the unit tests; production passes nothing. */
  readonly now?: () => Date;
  readonly attach?: (page: Page) => Promise<CDPSession>;
}

interface BufferedFrame {
  readonly sequence: number;
  readonly capturedAt: Date;
  readonly width: number;
  readonly height: number;
  readonly quality: number;
  readonly payload: Uint8Array;
}

export class ScreencastUnavailableError extends Error {}

export class ScreencastProducer {
  readonly streamId = newId("lvs_");
  readonly #browserSessionId: string;
  readonly #page: Page;
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #attach: (page: Page) => Promise<CDPSession>;
  readonly #scheduler: LiveScheduler;
  readonly #buffer: BufferedFrame[] = [];

  #transport: LiveTransport | null = null;
  #cdp: CDPSession | null = null;
  #running = false;
  #sequence = 0;
  #framesSent = 0;
  #framesDropped = 0;
  #droppedBefore = 0;
  #windowDelivered = 0;
  #windowDropped = 0;
  #windowStartedAt = 0;
  #measuredFps = 0;
  #lastEmittedAt = 0;
  #timer: NodeJS.Timeout | null = null;
  #appliedQuality: string | null = null;
  /**
   * Set while a quality change is being applied to Chromium. Applying two at
   * once would interleave a `stopScreencast` from the second with the
   * `startScreencast` of the first and leave the capture stopped, which looks
   * exactly like a stalled page.
   */
  #applying = false;

  constructor(options: ScreencastOptions) {
    this.#browserSessionId = options.browserSessionId;
    this.#page = options.page;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
    this.#attach =
      options.attach ??
      ((page) => page.context().newCDPSession(page));
    this.#scheduler = new LiveScheduler(options.mode, options.capture);
  }

  get running(): boolean {
    return this.#running;
  }

  get mode(): LiveMode {
    return this.#scheduler.mode;
  }

  stats(): ProducerStats {
    return {
      framesSent: this.#framesSent,
      framesDropped: this.#framesDropped,
      bufferDepth: this.#buffer.length,
      bufferCapacity: FRAME_BUFFER_CAPACITY,
      measuredFps: this.#measuredFps,
      running: this.#running,
    };
  }

  /**
   * Starts capture and streaming.
   *
   * A failure here is reported as `ScreencastUnavailableError` and leaves the
   * page untouched: `docs/DEVELOPMENT.md` section 11 requires a live stream to
   * degrade without breaking the review workflow, so a session whose
   * screencast will not start must still navigate and capture screenshots.
   */
  async start(transport: LiveTransport): Promise<void> {
    if (this.#running) {
      throw new ScreencastUnavailableError(
        `browser session ${this.#browserSessionId} already has a live producer`,
      );
    }
    this.#transport = transport;
    let cdp: CDPSession;
    try {
      cdp = await this.#attach(this.#page);
    } catch (error) {
      this.#transport = null;
      throw new ScreencastUnavailableError(
        `could not attach a CDP session: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.#cdp = cdp;
    cdp.on("Page.screencastFrame", (event: unknown) => {
      this.#onScreencastFrame(event as { data: string; sessionId: number });
    });
    try {
      await this.#applyQuality("initial");
    } catch (error) {
      await this.#detach();
      this.#transport = null;
      throw new ScreencastUnavailableError(
        `could not start the screencast: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.#running = true;
    this.#windowStartedAt = this.#now().getTime();
    this.#timer = setInterval(() => {
      this.#onWindow();
    }, ADAPTATION_INTERVAL_MS);
    // A live stream must not by itself keep the worker process alive.
    this.#timer.unref();
  }

  /**
   * Stops capture and releases the CDP session.
   *
   * The route calls this as soon as the last viewer's stream closes, which is
   * what makes "the producer stops when no viewer remains" a property of the
   * code rather than of a timeout.
   */
  async stop(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#running = false;
    this.#transport = null;
    this.#buffer.length = 0;
    await this.#detach();
  }

  /** Applies a viewer's advisory request; the scheduler decides what happens. */
  async requestQuality(preference: ViewerPreference): Promise<QualityState> {
    const changed = this.#scheduler.request(preference);
    if (changed && this.#running) await this.#applyQuality("viewer_requested");
    return this.#scheduler.state(this.#now());
  }

  /** Re-reads the capture size, for example after a resize command. */
  setCaptureBounds(capture: CaptureBounds): void {
    this.#scheduler.setCaptureBounds(capture);
  }

  async #detach(): Promise<void> {
    const cdp = this.#cdp;
    this.#cdp = null;
    if (cdp === null) return;
    await cdp.send("Page.stopScreencast").catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  }

  /** Restarts the screencast with the scheduler's current decision. */
  async #applyQuality(reason: string): Promise<void> {
    const cdp = this.#cdp;
    if (cdp === null || this.#applying) return;
    const decision = this.#scheduler.decision();
    const signature = JSON.stringify(decision);
    if (signature === this.#appliedQuality) return;
    this.#applying = true;
    try {
      if (this.#appliedQuality !== null) {
        await cdp.send("Page.stopScreencast").catch(() => undefined);
      }
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: decision.quality,
        maxWidth: decision.maxWidth,
        maxHeight: decision.maxHeight,
        everyNthFrame: 1,
      });
      this.#appliedQuality = signature;
    } finally {
      this.#applying = false;
    }
    this.#emit({
      envelope: this.#envelope("live.quality"),
      type: "live.quality",
      payload: this.#scheduler.state(this.#now()),
    });
    this.#logger.debug("live quality applied", {
      browser_session_id: this.#browserSessionId,
      stream_id: this.streamId,
      mode: decision.mode,
      target_fps: String(decision.targetFps),
      quality: String(decision.quality),
      reason,
    });
  }

  #envelope(type: LiveViewFrame["type"]): LiveViewFrame["envelope"] {
    return {
      protocol_version: 1,
      message_id: newId("msg_"),
      type,
      sent_at: this.#now().toISOString(),
      browser_session_id: this.#browserSessionId,
      stream_id: this.streamId,
    };
  }

  #emit(frame: LiveViewFrame): void {
    const transport = this.#transport;
    if (transport === null) return;
    try {
      transport.writeMessage(encodeLiveViewFrame(frame));
    } catch (error) {
      this.#logger.warn("could not write a live message", {
        browser_session_id: this.#browserSessionId,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * One captured frame.
   *
   * The acknowledgement goes first and unconditionally: Chromium stops sending
   * until the previous frame is acknowledged, so a frame this producer intends
   * to discard must still be acknowledged or the stream stalls instead of
   * thinning.
   */
  #onScreencastFrame(event: { data: string; sessionId: number }): void {
    const cdp = this.#cdp;
    if (cdp !== null) {
      void cdp
        .send("Page.screencastFrameAck", { sessionId: event.sessionId })
        .catch(() => undefined);
    }
    if (!this.#running) return;

    const now = this.#now().getTime();
    const interval = this.#scheduler.frameIntervalMs;
    if (this.#lastEmittedAt !== 0 && now - this.#lastEmittedAt < interval) {
      // Deliberate sampling, not a drop: this frame never becomes part of the
      // stream and never takes a sequence number.
      return;
    }
    this.#lastEmittedAt = now;

    const decision = this.#scheduler.decision();
    const payload = Buffer.from(event.data, "base64");
    this.#sequence += 1;
    this.#enqueue({
      sequence: this.#sequence,
      capturedAt: this.#now(),
      width: decision.maxWidth,
      height: decision.maxHeight,
      quality: decision.quality,
      payload,
    });
    this.#flush();
  }

  /** Bounded buffer. The oldest frame is the one that goes. */
  #enqueue(frame: BufferedFrame): void {
    while (this.#buffer.length >= FRAME_BUFFER_CAPACITY) {
      this.#buffer.shift();
      this.#framesDropped += 1;
      this.#windowDropped += 1;
      this.#droppedBefore += 1;
    }
    this.#buffer.push(frame);
  }

  /** Writes what the transport will take. Called on capture and on drain. */
  flush(): void {
    this.#flush();
  }

  #flush(): void {
    const transport = this.#transport;
    if (transport === null) return;
    while (this.#buffer.length > 0 && transport.writable) {
      const frame = this.#buffer.shift() as BufferedFrame;
      const metadata: FrameMetadata = {
        sequence: frame.sequence,
        captured_at: frame.capturedAt.toISOString(),
        mode: this.#scheduler.mode,
        format: "image/jpeg",
        width: frame.width,
        height: frame.height,
        quality: frame.quality,
        byte_length: frame.payload.byteLength,
        dropped_before: this.#droppedBefore,
      };
      this.#droppedBefore = 0;
      const metadataJson = encodeLiveViewFrame({
        envelope: this.#envelope("live.frame"),
        type: "live.frame",
        payload: metadata,
      });
      transport.writeFrame(metadataJson, frame.payload);
      this.#framesSent += 1;
      this.#windowDelivered += 1;
    }
  }

  /** One adaptation window: measure, adapt, heartbeat. */
  #onWindow(): void {
    if (!this.#running) return;
    const now = this.#now().getTime();
    const elapsed = Math.max(1, now - this.#windowStartedAt);
    this.#measuredFps = Number(((this.#windowDelivered * 1000) / elapsed).toFixed(2));
    const observation = {
      delivered: this.#windowDelivered,
      dropped: this.#windowDropped,
      bufferDepth: this.#buffer.length,
    };
    this.#windowDelivered = 0;
    this.#windowDropped = 0;
    this.#windowStartedAt = now;

    this.#emit({
      envelope: this.#envelope("live.heartbeat"),
      type: "live.heartbeat",
      payload: {
        observed_at: this.#now().toISOString(),
        frames_sent: this.#framesSent,
        frames_dropped: this.#framesDropped,
        buffer_depth: observation.bufferDepth,
        buffer_capacity: FRAME_BUFFER_CAPACITY,
        measured_fps: this.#measuredFps,
      },
    });

    if (this.#scheduler.adapt(observation)) {
      void this.#applyQuality("adaptation").catch((error: unknown) => {
        this.#logger.warn("could not apply an adapted live quality", {
          browser_session_id: this.#browserSessionId,
          detail: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }
}
