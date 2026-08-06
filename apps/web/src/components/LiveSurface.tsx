/**
 * The live browser surface.
 *
 * Frames are painted into a canvas. That is deliberate and not incidental:
 * ADR-0010 makes rendered page content untrusted, so a frame is decoded as an
 * image and drawn, and no page-derived markup is ever inserted into this
 * document. The canvas is also what the annotation overlay of a later issue
 * draws onto, and the metadata this component keeps — sequence and the frame's
 * own device-pixel dimensions — is what that overlay needs to place normalised
 * geometry correctly.
 *
 * A frame's bytes live for exactly as long as it takes to decode them
 * (ADR-0009). Nothing is cached, downloaded or written to storage, and the
 * object URL for a frame is revoked as soon as the bitmap exists.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import type { FrameMetadata, LiveMode } from "@reviewplane/protocol/live-view";

import type { BrowserSession } from "../api/client.ts";
import { liveUrl } from "../api/client.ts";
import {
  FAILURE_COPY,
  LiveClient,
  STATUS_COPY,
  type LiveFailure,
  type LiveStatus,
} from "../live/client.ts";
import { OverlayLayer, OverlayList, type BrowserOverlay } from "./BrowserOverlays.tsx";
import { StatusBadge, type Tone } from "./StatusBadge.tsx";

const TONE_FOR_STATUS: Readonly<Record<LiveStatus, Tone>> = {
  connecting: "waiting",
  live: "live",
  waiting_for_frames: "waiting",
  reconnecting: "warning",
  stalled: "warning",
  stopped: "neutral",
  failed: "failed",
};

export interface LiveStats {
  readonly framesPainted: number;
  readonly framesDropped: number;
  readonly measuredFps: number;
  readonly lastSequence: number;
  readonly width: number;
  readonly height: number;
}

const EMPTY_STATS: LiveStats = {
  framesPainted: 0,
  framesDropped: 0,
  measuredFps: 0,
  lastSequence: 0,
  width: 0,
  height: 0,
};

/** Whether the reader asked for less motion. Read once, honoured throughout. */
function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export function LiveSurface({
  session,
  onSessionStatus,
  overlays,
}: {
  readonly session: BrowserSession;
  readonly onSessionStatus?: (status: string, url: string | null) => void;
  /**
   * Marks drawn over the picture (`docs/UX_FLOWS.md` section 7). They are drawn
   * in a layer above the canvas and never painted into it: a frame is a live
   * rendering of another application, and nothing may modify it.
   */
  readonly overlays?: readonly BrowserOverlay[];
}): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const clientRef = useRef<LiveClient | null>(null);
  const paintingRef = useRef(false);
  const statsRef = useRef<LiveStats>(EMPTY_STATS);
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [failure, setFailure] = useState<LiveFailure | null>(null);
  const [stats, setStats] = useState<LiveStats>(EMPTY_STATS);
  const [reducedMotion] = useState<boolean>(() => prefersReducedMotion());
  const [attempt, setAttempt] = useState(0);

  // Reduced motion asks for less movement, and twenty frames a second is
  // movement. The low-rate mode is the honest answer, and the page says so.
  const mode: LiveMode = reducedMotion ? "thumbnail" : "session_room";

  const paint = useCallback(async (payload: Uint8Array, metadata: FrameMetadata) => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    if (paintingRef.current) {
      // A frame arriving while the previous one is still decoding is dropped
      // rather than queued, exactly as the worker and the relay do.
      statsRef.current = {
        ...statsRef.current,
        framesDropped: statsRef.current.framesDropped + 1,
      };
      return;
    }
    paintingRef.current = true;
    try {
      const blob = new Blob([payload as BlobPart], { type: metadata.format });
      const bitmap = await createImageBitmap(blob);
      canvas.width = metadata.width;
      canvas.height = metadata.height;
      const context = canvas.getContext("2d");
      context?.drawImage(bitmap, 0, 0);
      bitmap.close();
      statsRef.current = {
        framesPainted: statsRef.current.framesPainted + 1,
        framesDropped: statsRef.current.framesDropped + metadata.dropped_before,
        measuredFps: statsRef.current.measuredFps,
        lastSequence: metadata.sequence,
        width: metadata.width,
        height: metadata.height,
      };
      setStats(statsRef.current);
      clientRef.current?.markRendered(metadata.sequence);
    } catch {
      // A frame that will not decode is skipped. The next one is moments away.
    } finally {
      paintingRef.current = false;
    }
  }, []);

  useEffect(() => {
    statsRef.current = EMPTY_STATS;
    setStats(EMPTY_STATS);
    const client = new LiveClient({
      url: liveUrl(session.id, mode),
      mode,
      events: {
        onStatus: (next, nextFailure) => {
          setStatus(next);
          setFailure(nextFailure);
        },
        onFrame: (payload, metadata) => {
          void paint(payload, metadata);
        },
        onSessionState: (state) => {
          onSessionStatus?.(state.status, state.url ?? null);
        },
        onQuality: () => undefined,
        onHeartbeat: (heartbeat) => {
          statsRef.current = { ...statsRef.current, measuredFps: heartbeat.measured_fps };
          setStats(statsRef.current);
        },
      },
    });
    clientRef.current = client;
    client.connect();
    return () => {
      clientRef.current = null;
      client.close();
    };
  }, [session.id, mode, paint, onSessionStatus, attempt]);

  const copy = failure === null ? null : FAILURE_COPY[failure.state];

  return (
    <section aria-labelledby="live-surface-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="live-surface-heading" className="text-lg font-semibold">
          Live browser
        </h2>
        <StatusBadge
          tone={TONE_FOR_STATUS[status]}
          label={STATUS_COPY[status]}
          // The rate is what the worker reported, so it appears only once a
          // heartbeat has carried one rather than as a placeholder zero.
          detail={
            status === "live" && stats.measuredFps > 0
              ? `${stats.measuredFps.toFixed(1)} fps`
              : undefined
          }
        />
      </div>

      {/*
        The live region announces status changes for a screen reader without
        moving focus (docs/UX_FLOWS.md section 19).
      */}
      <p role="status" aria-live="polite" className="text-sm text-slate-700 dark:text-slate-300">
        {STATUS_COPY[status]}
        {failure === null ? "" : `. ${copy?.title ?? failure.message}`}
      </p>

      <div className="relative overflow-hidden rounded border border-slate-300 bg-slate-900 dark:border-slate-700">
        <canvas
          ref={canvasRef}
          // The canvas is a live rendering of another browser. Its text
          // alternative names what it shows rather than describing pixels.
          role="img"
          aria-label={`Live view of browser session ${session.id} at ${String(session.viewport.width)} by ${String(session.viewport.height)} pixels`}
          tabIndex={0}
          className="block h-auto w-full max-w-full bg-slate-900"
        />
        <OverlayLayer overlays={overlays ?? []} />
        {status === "live" ? null : (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-950/85 p-4">
            <div className="max-w-md text-center text-slate-100">
              <p className="text-base font-semibold">{copy?.title ?? STATUS_COPY[status]}</p>
              <p className="mt-2 text-sm">
                {copy?.action ??
                  (status === "waiting_for_frames"
                    ? "The stream is connected. The first frame arrives as soon as the page paints."
                    : "Reconnecting automatically.")}
              </p>
              {failure?.retryable === false ? null : (
                <button
                  type="button"
                  onClick={() => {
                    setAttempt((value) => value + 1);
                  }}
                  className="mt-4 rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-100 hover:bg-slate-800"
                >
                  Reconnect now
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-slate-600 dark:text-slate-400">Frames painted</dt>
          {/* Identified so the interface suite can read the figure it asserts
              on without depending on the order of this list. */}
          <dd id="live-frames-painted" className="font-mono">
            {stats.framesPainted}
          </dd>
        </div>
        <div>
          <dt className="text-slate-600 dark:text-slate-400">Frames dropped</dt>
          <dd id="live-frames-dropped" className="font-mono">
            {stats.framesDropped}
          </dd>
        </div>
        <div>
          <dt className="text-slate-600 dark:text-slate-400">Frame size</dt>
          <dd id="live-frame-size" className="font-mono">
            {stats.width === 0 ? "—" : `${String(stats.width)}x${String(stats.height)}`}
          </dd>
        </div>
        <div>
          <dt className="text-slate-600 dark:text-slate-400">Mode</dt>
          <dd id="live-mode" className="font-mono">
            {mode}
          </dd>
        </div>
      </dl>

      <OverlayList overlays={overlays ?? []} headingId="live-overlay-list-heading" />

      {reducedMotion ? (
        <p className="text-sm text-slate-700 dark:text-slate-300">
          Reduced motion is on, so this stream runs at the low frame rate. Screenshot capture and
          navigation are unaffected.
        </p>
      ) : null}

      <p className="text-xs text-slate-600 dark:text-slate-400">
        Live frames are never stored. Only an explicitly captured screenshot becomes evidence.
      </p>
    </section>
  );
}
