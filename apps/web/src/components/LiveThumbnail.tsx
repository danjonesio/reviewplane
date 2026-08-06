/**
 * The live browser thumbnail on a fleet card (`docs/UX_FLOWS.md` section 3).
 *
 * Section 3 states two rules and this component exists to keep them:
 *
 *   > Do not autoplay high-frame-rate streams for every card. Thumbnails use a
 *   > low frame rate and stop when off screen.
 *
 * **Low rate** is `mode=thumbnail`, which the worker's scheduler reads as 2 to 5
 * frames per second and which a viewer cannot raise (`docs/ARCHITECTURE.md`
 * section 6.3.1). The mode is in the URL, so a card cannot accidentally open a
 * session-room stream by forgetting an argument.
 *
 * **Stop when off screen** is an `IntersectionObserver`, and it closes the
 * socket rather than merely ceasing to paint. That distinction is the whole
 * point: the control plane closes the worker's stream when its last viewer
 * detaches, so a card scrolled out of view stops costing a Chromium anything. A
 * component that kept the socket open and dropped the frames would look
 * identical on screen and would leave twenty screencasts running.
 *
 * A reader who asked for reduced motion gets no stream at all until they ask
 * for one. A grid of moving thumbnails is motion, and honouring the preference
 * by lowering a rate that is already low would be honouring it in name only.
 *
 * Frames are painted and discarded (ADR-0009). Nothing is cached, downloaded or
 * written to storage.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import type { FrameMetadata } from "@reviewplane/protocol/live-view";

import { liveUrl } from "../api/client.ts";
import { FAILURE_COPY, LiveClient, type LiveFailure, type LiveStatus } from "../live/client.ts";

/** Whether the reader asked for less motion. Read once, honoured throughout. */
function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export interface ThumbnailStats {
  readonly painted: number;
  readonly dropped: number;
}

export function LiveThumbnail({
  sessionId,
  label,
  onStats,
}: {
  readonly sessionId: string;
  /** What this thumbnail shows, for its text alternative. */
  readonly label: string;
  /** Frame counts, for the suite that proves the drop policy. */
  readonly onStats?: (stats: ThumbnailStats) => void;
}): ReactElement {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const paintingRef = useRef(false);
  const statsRef = useRef<ThumbnailStats>({ painted: 0, dropped: 0 });
  const [onScreen, setOnScreen] = useState(false);
  const [status, setStatus] = useState<LiveStatus>("stopped");
  const [failure, setFailure] = useState<LiveFailure | null>(null);
  const [reducedMotion] = useState<boolean>(() => prefersReducedMotion());
  const [allowedByReader, setAllowedByReader] = useState(false);
  const [stats, setStats] = useState<ThumbnailStats>({ painted: 0, dropped: 0 });

  const streaming = onScreen && (!reducedMotion || allowedByReader);

  // Visibility drives the socket, so this observer is attached whether or not a
  // stream is wanted: a card that scrolls into view while reduced motion is on
  // still has to know it is on screen, or enabling the stream would do nothing
  // until the next scroll.
  useEffect(() => {
    const holder = holderRef.current;
    if (holder === null) return;
    if (typeof globalThis.IntersectionObserver !== "function") {
      // Without the observer the honest fallback is not to stream: showing
      // every card at once is the behaviour section 3 forbids.
      setOnScreen(false);
      return;
    }
    const observer = new globalThis.IntersectionObserver(
      (records) => {
        const record = records[records.length - 1];
        if (record !== undefined) setOnScreen(record.isIntersecting);
      },
      { rootMargin: "64px" },
    );
    observer.observe(holder);
    return () => {
      observer.disconnect();
    };
  }, []);

  const paint = useCallback(
    async (payload: Uint8Array, metadata: FrameMetadata) => {
      const canvas = canvasRef.current;
      if (canvas === null) return;
      if (paintingRef.current) {
        // Dropped rather than queued, the same rule the worker and the relay
        // apply. A card that fell behind shows the newest frame it can, never a
        // backlog of old ones.
        statsRef.current = { ...statsRef.current, dropped: statsRef.current.dropped + 1 };
        setStats(statsRef.current);
        onStats?.(statsRef.current);
        return;
      }
      paintingRef.current = true;
      try {
        const blob = new Blob([payload as BlobPart], { type: metadata.format });
        const bitmap = await createImageBitmap(blob);
        canvas.width = metadata.width;
        canvas.height = metadata.height;
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        bitmap.close();
        statsRef.current = {
          painted: statsRef.current.painted + 1,
          dropped: statsRef.current.dropped + metadata.dropped_before,
        };
        setStats(statsRef.current);
        onStats?.(statsRef.current);
      } catch {
        // A frame that will not decode is skipped; the next is moments away.
      } finally {
        paintingRef.current = false;
      }
    },
    [onStats],
  );

  useEffect(() => {
    if (!streaming) {
      setStatus("stopped");
      return;
    }
    const client = new LiveClient({
      url: liveUrl(sessionId, "thumbnail"),
      mode: "thumbnail",
      events: {
        onStatus: (next, nextFailure) => {
          setStatus(next);
          setFailure(nextFailure);
        },
        onFrame: (payload, metadata) => {
          void paint(payload, metadata);
        },
        onSessionState: () => undefined,
        onQuality: () => undefined,
        onHeartbeat: () => undefined,
      },
    });
    client.connect();
    return () => {
      client.close();
    };
  }, [sessionId, streaming, paint]);

  const copy = failure === null ? null : FAILURE_COPY[failure.state];

  return (
    <div
      ref={holderRef}
      data-thumbnail={sessionId}
      data-thumbnail-streaming={streaming ? "true" : "false"}
      data-thumbnail-painted={stats.painted}
      data-thumbnail-dropped={stats.dropped}
      className="relative aspect-video w-full overflow-hidden rounded border border-slate-300 bg-slate-900 dark:border-slate-700"
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Live thumbnail of ${label}, at the low frame rate`}
        className="block h-full w-full object-contain"
      />
      {status === "live" ? null : (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950/80 p-3 text-center">
          <div className="text-slate-100">
            <p className="text-xs font-medium">
              {reducedMotion && !allowedByReader
                ? "Reduced motion is on, so this thumbnail does not stream"
                : !onScreen
                  ? "Off screen — the stream is stopped"
                  : (copy?.title ?? "Connecting")}
            </p>
            {reducedMotion && !allowedByReader ? (
              <button
                type="button"
                onClick={() => {
                  setAllowedByReader(true);
                }}
                className="mt-2 rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-100 hover:bg-slate-800"
              >
                Show this thumbnail
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
