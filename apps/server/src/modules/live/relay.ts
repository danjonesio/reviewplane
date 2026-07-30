/**
 * The live-frame relay: one worker stream per browser session, fanned out to
 * however many viewers are attached.
 *
 * Two drop policies operate here, and they are deliberately separate.
 * `docs/ARCHITECTURE.md` section 6.3 requires frames to be dropped rather than
 * queued when *a viewer* falls behind, and a viewer is an individual socket:
 * one slow viewer must not thin the stream for the others, and must not grow
 * the control plane's memory either. So the worker's producer bounds its own
 * buffer, and this relay bounds each viewer independently by refusing to write
 * a frame to a socket that already has one outstanding.
 *
 * Nothing here writes a frame anywhere. ADR-0009 and `docs/SECURITY.md`
 * section 14 (`live_frames: never`) mean a frame is a value that exists
 * between a socket read and a socket write; it is never handed to the artefact
 * service, never logged, and never persisted, and the absence of any such call
 * in this file is the enforcement.
 */

import {
  LIVE_RECORD_FRAME_PAYLOAD,
  LIVE_RECORD_MESSAGE,
  decodeLiveViewFrame,
  encodeLiveViewFrame,
  type FrameMetadata,
  type LiveMode,
  type LiveViewFrame,
} from "@reviewplane/protocol/live-view";

import { newId } from "../../ids.ts";
import type { BrowserSessionRecord } from "../browser-sessions/service.ts";
import type { WorkerLiveClient, WorkerLiveStream } from "./worker-live-client.ts";

/**
 * Bytes a viewer's socket may already hold before the relay starts dropping
 * frames for it. One typical frame is a few tens of kilobytes; this bound is
 * a small multiple of that, so a viewer is given the benefit of one frame in
 * flight and no more.
 */
export const VIEWER_BUFFER_BYTES = 262144;

export interface LiveViewerSocket {
  /** Bytes queued on the socket and not yet written to the network. */
  readonly bufferedAmount: number;
  readonly open: boolean;
  sendText(payload: string): void;
  sendBinary(payload: Uint8Array): void;
  close(code: number, reason: string): void;
}

export interface LiveViewer {
  readonly id: string;
  readonly socket: LiveViewerSocket;
  readonly viewerSessionId: string;
  framesSent: number;
  framesDropped: number;
  droppedBefore: number;
}

export interface LiveRelayLogger {
  info(message: string, fields?: Readonly<Record<string, string>>): void;
  warn(message: string, fields?: Readonly<Record<string, string>>): void;
}

export interface LiveRelayOptions {
  readonly client: WorkerLiveClient;
  readonly logger: LiveRelayLogger;
  /** Called when a stream ends, so the caller can record an audit event. */
  readonly onStreamClosed?: (browserSessionId: string, reason: string) => void;
}

interface SessionStream {
  readonly browserSessionId: string;
  readonly viewers: Map<string, LiveViewer>;
  stream: WorkerLiveStream | null;
  mode: LiveMode;
  closing: boolean;
  /** Last quality message seen, replayed to a viewer that attaches later. */
  lastQuality: string | null;
}

export class LiveRelay {
  readonly #client: WorkerLiveClient;
  readonly #logger: LiveRelayLogger;
  readonly #onClosed: ((browserSessionId: string, reason: string) => void) | undefined;
  readonly #streams = new Map<string, SessionStream>();

  constructor(options: LiveRelayOptions) {
    this.#client = options.client;
    this.#logger = options.logger;
    this.#onClosed = options.onStreamClosed;
  }

  /** Viewers currently attached to a session, for the limit checks. */
  viewerCount(browserSessionId: string): number {
    return this.#streams.get(browserSessionId)?.viewers.size ?? 0;
  }

  get activeStreams(): number {
    return this.#streams.size;
  }

  /**
   * Attaches a viewer, starting the worker stream if this is the first one.
   *
   * The caller has already authenticated and authorised the viewer; this
   * method is reached only after both succeeded, which is what makes
   * "no frame before authorisation" a property of the call graph rather than
   * of a check inside the pump.
   */
  async attach(
    session: BrowserSessionRecord,
    viewer: LiveViewer,
    mode: LiveMode,
  ): Promise<void> {
    let entry = this.#streams.get(session.id);
    if (entry === undefined) {
      entry = {
        browserSessionId: session.id,
        viewers: new Map(),
        stream: null,
        mode,
        closing: false,
        lastQuality: null,
      };
      this.#streams.set(session.id, entry);
      try {
        entry.stream = await this.#client.open(session.id, mode);
      } catch (error) {
        this.#streams.delete(session.id);
        throw error;
      }
      void this.#pump(entry);
    }
    entry.viewers.set(viewer.id, viewer);
    if (entry.lastQuality !== null) viewer.socket.sendText(entry.lastQuality);
    this.#logger.info("live viewer attached", {
      browser_session_id: session.id,
      project_id: session.project_id,
      viewers: String(entry.viewers.size),
    });
  }

  /**
   * Detaches a viewer and, when it was the last one, closes the worker stream.
   *
   * This is what bounds the "producer stops when no viewer remains" time: the
   * close is immediate rather than swept by a timer.
   */
  detach(browserSessionId: string, viewerId: string): void {
    const entry = this.#streams.get(browserSessionId);
    if (entry === undefined) return;
    entry.viewers.delete(viewerId);
    if (entry.viewers.size > 0) return;
    this.#closeStream(entry, "no viewers remain");
  }

  /** Relays a viewer's advisory quality request to the worker's scheduler. */
  async requestQuality(
    browserSessionId: string,
    request: Parameters<WorkerLiveClient["requestQuality"]>[1],
  ): Promise<void> {
    const entry = this.#streams.get(browserSessionId);
    if (entry === undefined) return;
    const applied = await this.#client.requestQuality(browserSessionId, request);
    const message = encodeLiveViewFrame({
      envelope: {
        protocol_version: 1,
        message_id: newId("msg_"),
        type: "live.quality",
        sent_at: new Date().toISOString(),
        browser_session_id: browserSessionId,
        stream_id: browserSessionId,
      },
      type: "live.quality",
      payload: applied,
    });
    entry.lastQuality = message;
    for (const viewer of entry.viewers.values()) viewer.socket.sendText(message);
  }

  /** Closes every stream, for server shutdown. */
  closeAll(reason: string): void {
    for (const entry of [...this.#streams.values()]) this.#closeStream(entry, reason);
  }

  #closeStream(entry: SessionStream, reason: string): void {
    if (entry.closing) return;
    entry.closing = true;
    this.#streams.delete(entry.browserSessionId);
    entry.stream?.close();
    entry.stream = null;
    this.#logger.info("live stream closed", {
      browser_session_id: entry.browserSessionId,
      reason,
    });
    this.#onClosed?.(entry.browserSessionId, reason);
  }

  /**
   * Reads the worker stream and fans it out.
   *
   * A `live.frame` message is held until its payload record arrives, because
   * the payload's only description is that metadata. A payload with no
   * preceding metadata is discarded: it cannot be rendered safely and it
   * cannot be described to a viewer.
   */
  async #pump(entry: SessionStream): Promise<void> {
    const stream = entry.stream;
    if (stream === null) return;
    let pendingMetadata: { json: string; metadata: FrameMetadata } | null = null;
    try {
      for await (const record of stream.records) {
        if (entry.closing) break;
        if (record.kind === LIVE_RECORD_MESSAGE) {
          const text = new TextDecoder().decode(record.bytes);
          const decoded = decodeLiveViewFrame(text);
          if (!decoded.ok) {
            this.#logger.warn("live message from the worker was refused", {
              browser_session_id: entry.browserSessionId,
              reason: decoded.error.reason,
            });
            continue;
          }
          if (decoded.value.type === "live.frame") {
            pendingMetadata = { json: text, metadata: decoded.value.payload };
            continue;
          }
          if (decoded.value.type === "live.quality") entry.lastQuality = text;
          this.#broadcast(entry, text, decoded.value);
          continue;
        }

        if (record.kind === LIVE_RECORD_FRAME_PAYLOAD) {
          const pending = pendingMetadata;
          pendingMetadata = null;
          if (pending === null) continue;
          if (pending.metadata.byte_length !== record.bytes.byteLength) {
            // A payload that is not the length its metadata declared cannot be
            // rendered as the frame it claims to be.
            this.#logger.warn("live frame payload length disagreed with its metadata", {
              browser_session_id: entry.browserSessionId,
            });
            continue;
          }
          this.#deliverFrame(entry, pending.json, record.bytes);
        }
      }
    } catch (error) {
      this.#logger.warn("live stream from the worker ended", {
        browser_session_id: entry.browserSessionId,
        detail: error instanceof Error ? error.message : String(error),
      });
      this.#failViewers(entry);
    }
    if (!entry.closing) {
      this.#failViewers(entry);
      this.#closeStream(entry, "worker stream ended");
    }
  }

  #broadcast(entry: SessionStream, text: string, _frame: LiveViewFrame): void {
    for (const viewer of entry.viewers.values()) {
      if (!viewer.socket.open) continue;
      viewer.socket.sendText(text);
    }
  }

  /**
   * Writes one frame to every viewer that can take it.
   *
   * A viewer with bytes still outstanding does not receive this frame, and its
   * drop counter advances. That is the whole slow-viewer policy: it costs a
   * constant amount of memory per viewer and it always favours the newest
   * frame, because the next frame is offered to the same viewer moments later.
   */
  #deliverFrame(entry: SessionStream, metadataJson: string, payload: Uint8Array): void {
    for (const viewer of entry.viewers.values()) {
      if (!viewer.socket.open) continue;
      if (viewer.socket.bufferedAmount > VIEWER_BUFFER_BYTES) {
        viewer.framesDropped += 1;
        viewer.droppedBefore += 1;
        continue;
      }
      viewer.socket.sendText(this.#withViewerDrops(metadataJson, viewer));
      viewer.socket.sendBinary(payload);
      viewer.framesSent += 1;
    }
  }

  /**
   * Rewrites `dropped_before` so it counts what *this* viewer missed, which is
   * the number the viewer can act on. The producer's own count is folded in,
   * so the figure remains end to end.
   */
  #withViewerDrops(metadataJson: string, viewer: LiveViewer): string {
    if (viewer.droppedBefore === 0) return metadataJson;
    const decoded = decodeLiveViewFrame(metadataJson);
    if (!decoded.ok || decoded.value.type !== "live.frame") return metadataJson;
    const rewritten = encodeLiveViewFrame({
      envelope: decoded.value.envelope,
      type: "live.frame",
      payload: {
        ...decoded.value.payload,
        dropped_before: decoded.value.payload.dropped_before + viewer.droppedBefore,
      },
    });
    viewer.droppedBefore = 0;
    return rewritten;
  }

  /** Tells every viewer that the stream failed, in the shape UX §18 needs. */
  #failViewers(entry: SessionStream): void {
    const message = encodeLiveViewFrame({
      envelope: {
        protocol_version: 1,
        message_id: newId("msg_"),
        type: "live.error",
        sent_at: new Date().toISOString(),
        browser_session_id: entry.browserSessionId,
      },
      type: "live.error",
      payload: {
        code: "BROWSER_SESSION_NOT_ACTIVE",
        state: "browser_worker_failed",
        message:
          "The live stream from the browser worker ended. Navigation and screenshot capture are unaffected.",
        retryable: true,
      },
    });
    for (const viewer of entry.viewers.values()) {
      if (viewer.socket.open) viewer.socket.sendText(message);
    }
  }
}
