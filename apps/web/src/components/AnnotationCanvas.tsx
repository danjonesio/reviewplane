/**
 * The annotation canvas (`docs/UX_FLOWS.md` sections 9 and 19, ADR-0006,
 * ADR-0011, ADR-0032).
 *
 * This is where a human turns "the navigation looks wrong" into a rectangle
 * over a specific element at a specific URL, viewport, device-pixel ratio and
 * scroll position. Three rules govern it.
 *
 * **Convert once, at the edge.** The pointer reports CSS pixels relative to
 * the drawing surface; the stored geometry is normalised to the artefact
 * content rectangle. `toNormalisedPoint` is the only place that conversion
 * happens, against the rectangle `containedContentRectangle` measured. Nothing
 * else multiplies by anything, and in particular nothing here reads
 * `devicePixelRatio`. That is what makes a mark drawn at a ratio of 1 land in
 * the same place when the same capture is viewed at 2.
 *
 * **Nothing drawn here reaches the page.** The surface sits above a picture,
 * and a picture is all it is — a still capture, or a frame of a live view that
 * this application renders and never drives. A pointer event consumed here is
 * consumed here; the session room's statement that watching is not driving
 * stays true.
 *
 * **The keyboard is not a lesser route.** Every shape can be placed without a
 * pointer, by moving a cursor across the surface with the arrow keys and
 * fixing two corners with Enter. It is not a simulation of dragging: a person
 * who cannot drag gets the same six shapes and the same coordinates, and the
 * cursor's position is announced as a percentage so the position is knowable
 * rather than only visible.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import {
  FREEHAND_PATH_POINT_BOUNDS,
  checkGeometryForType,
  containedContentRectangle,
  describeGeometry,
  pathBounds,
  toNormalisedPoint,
  type AnnotationGeometry,
  type AnnotationType,
  type RenderedRectangle,
} from "@reviewplane/protocol/review";

import type { ArtefactContentRectangle } from "../api/client.ts";
import { AnnotationOverlay, type DisplayAnnotation } from "./AnnotationOverlay.tsx";

/** A mark a human has drawn and not yet saved. */
export interface DraftAnnotation extends DisplayAnnotation {
  readonly label: string;
}

export interface AnnotationCanvasProps {
  /** Intrinsic pixel extent of the picture being drawn on. */
  readonly content: ArtefactContentRectangle;
  readonly annotations: readonly DraftAnnotation[];
  readonly onAdd: (annotation: { type: AnnotationType; geometry: AnnotationGeometry }) => void;
  readonly selectedId: string | null;
  readonly onSelect: (annotationId: string) => void;
  /** The picture. Rendered underneath the drawing surface, never into it. */
  readonly children: ReactElement;
  /** Announced when a mark is placed, so the outcome is not only visual. */
  readonly onAnnounce?: (message: string) => void;
}

/** The six shapes of `docs/DOMAIN_MODEL.md` section 16, in the order offered. */
const TOOLS: readonly { readonly type: AnnotationType; readonly label: string; readonly mark: string }[] =
  [
    { type: "rectangle", label: "Rectangle", mark: "▭" },
    { type: "ellipse", label: "Ellipse", mark: "◯" },
    { type: "arrow", label: "Arrow", mark: "↗" },
    { type: "point", label: "Point", mark: "•" },
    { type: "numbered_marker", label: "Numbered marker", mark: "①" },
    { type: "freehand", label: "Freehand", mark: "✎" },
  ];

/** Shapes fixed by two positions rather than one. */
const TWO_STEP: ReadonlySet<AnnotationType> = new Set(["rectangle", "ellipse", "arrow"]);

const TOOL_BUTTON =
  "rounded border border-slate-400 px-3 py-2 text-sm font-medium dark:border-slate-600";

/**
 * How far one arrow-key press moves the keyboard cursor, as a fraction of the
 * picture. Shift moves by a tenth of that.
 *
 * A step of a whole per cent is coarse on purpose: a keyboard user placing a
 * mark over a navigation bar should need a handful of presses rather than
 * ninety, and the fine step is there for the cases where precision matters.
 */
const COARSE_STEP = 0.02;
const FINE_STEP = 0.002;

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Rounds to the precision a content rectangle can actually resolve. */
function round(value: number): number {
  return Number(clamp(value).toFixed(4));
}

/**
 * Reduces a raw stroke to the points that carry its shape.
 *
 * The protocol bounds a path at 128 points and refuses a longer one rather
 * than truncating it, so the decimation has to happen before the request is
 * built. Dropping samples closer together than a threshold keeps the corners —
 * which is what a stroke is recognisable by — and discards the dozens of
 * near-identical samples a slow hand produces on a fast pointer.
 */
export function decimateStroke(
  points: readonly { readonly x: number; readonly y: number }[],
  maximum: number = FREEHAND_PATH_POINT_BOUNDS.maximum,
): { readonly x: number; readonly y: number }[] {
  if (points.length <= 2) return points.map((point) => ({ x: round(point.x), y: round(point.y) }));
  let threshold = 0.004;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const kept: { x: number; y: number }[] = [{ x: round(points[0]?.x ?? 0), y: round(points[0]?.y ?? 0) }];
    for (const point of points.slice(1, -1)) {
      const last = kept[kept.length - 1];
      if (last === undefined) continue;
      if (Math.hypot(point.x - last.x, point.y - last.y) >= threshold) {
        kept.push({ x: round(point.x), y: round(point.y) });
      }
    }
    const final = points[points.length - 1];
    if (final !== undefined) kept.push({ x: round(final.x), y: round(final.y) });
    if (kept.length <= maximum) return kept;
    threshold *= 1.8;
  }
  // A stroke that resists thinning is sampled evenly instead, so the result is
  // always within the bound rather than refused at the boundary.
  const stride = Math.ceil(points.length / maximum);
  return points
    .filter((_unused, index) => index % stride === 0 || index === points.length - 1)
    .slice(0, maximum)
    .map((point) => ({ x: round(point.x), y: round(point.y) }));
}

/** The geometry a pair of normalised positions makes, for the given shape. */
export function geometryFor(
  type: AnnotationType,
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
): AnnotationGeometry {
  if (type === "arrow") {
    return { x: round(from.x), y: round(from.y), x2: round(to.x), y2: round(to.y) };
  }
  if (type === "point" || type === "numbered_marker") {
    return { x: round(to.x), y: round(to.y) };
  }
  const x = round(Math.min(from.x, to.x));
  const y = round(Math.min(from.y, to.y));
  return {
    x,
    y,
    // Clamped against the far edge rather than against 1, because
    // `x + width` must not leave the content rectangle: the shared validator
    // refuses that, and it is the one place where rounding could otherwise
    // push a mark drawn exactly on the edge outside it.
    width: round(Math.min(Math.abs(to.x - from.x), 1 - x)),
    height: round(Math.min(Math.abs(to.y - from.y), 1 - y)),
  };
}

export function AnnotationCanvas({
  content,
  annotations,
  onAdd,
  selectedId,
  onSelect,
  children,
  onAnnounce,
}: AnnotationCanvasProps): ReactElement {
  const [tool, setTool] = useState<AnnotationType>("rectangle");
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  /** The first corner of a two-step shape, in normalised units. */
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  /** Where the keyboard cursor is. Independent of the pointer. */
  const [cursor, setCursor] = useState({ x: 0.5, y: 0.5 });
  const stroke = useRef<{ x: number; y: number }[]>([]);
  const [drawing, setDrawing] = useState(false);

  useEffect(() => {
    if (stage === null) return;
    const read = (): void => {
      const rect = stage.getBoundingClientRect();
      setBox((previous) =>
        previous.width === rect.width && previous.height === rect.height
          ? previous
          : { width: rect.width, height: rect.height },
      );
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(stage);
    return () => {
      observer.disconnect();
    };
  }, [stage]);

  const rectangle: RenderedRectangle = useMemo(
    () => containedContentRectangle(box, content),
    [box, content],
  );

  /** A pointer event's position, normalised. The only conversion here. */
  const positionOf = useCallback(
    (event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
      if (stage === null || rectangle.width <= 0) return null;
      const surface = stage.getBoundingClientRect();
      const point = toNormalisedPoint(
        { x: event.clientX - surface.left, y: event.clientY - surface.top },
        rectangle,
      );
      return { x: clamp(point.x), y: clamp(point.y) };
    },
    [stage, rectangle],
  );

  const place = useCallback(
    (type: AnnotationType, geometry: AnnotationGeometry) => {
      // The shared validator, before anything is added. A mark the server
      // would refuse must not sit in a draft list looking saved: the refusal
      // has to arrive while the human still has their hand on the tool.
      const violations = checkGeometryForType(type, geometry as unknown as Record<string, unknown>);
      if (violations.length > 0) {
        onAnnounce?.(`That mark was not recorded: ${violations[0]?.message ?? "invalid geometry"}.`);
        return;
      }
      onAdd({ type, geometry });
      onAnnounce?.(`Placed a ${describeGeometry(type, geometry)}.`);
    },
    [onAdd, onAnnounce],
  );

  const commit = useCallback(
    (from: { x: number; y: number }, to: { x: number; y: number }) => {
      place(tool, geometryFor(tool, from, to));
      setAnchor(null);
    },
    [place, tool],
  );

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const point = positionOf(event);
    if (point === null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "freehand") {
      stroke.current = [point];
      setDrawing(true);
      return;
    }
    if (TWO_STEP.has(tool)) {
      setAnchor(point);
      setDrawing(true);
      return;
    }
    place(tool, geometryFor(tool, point, point));
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!drawing || tool !== "freehand") return;
    const point = positionOf(event);
    if (point === null) return;
    stroke.current.push(point);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!drawing) return;
    setDrawing(false);
    const point = positionOf(event);
    if (tool === "freehand") {
      const raw = stroke.current;
      stroke.current = [];
      if (raw.length < 2) {
        onAnnounce?.("That stroke was too short to record. A single point is a point annotation.");
        return;
      }
      const path = decimateStroke(raw);
      place("freehand", { ...pathBounds(path), path });
      return;
    }
    if (anchor === null || point === null) return;
    commit(anchor, point);
  };

  /**
   * The keyboard route. Arrow keys move the cursor, Enter fixes a corner and
   * then the shape, Escape abandons a half-placed one.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? FINE_STEP : COARSE_STEP;
    const move = (dx: number, dy: number): void => {
      event.preventDefault();
      setCursor((previous) => ({ x: clamp(previous.x + dx), y: clamp(previous.y + dy) }));
    };
    if (event.key === "ArrowLeft") return move(-step, 0);
    if (event.key === "ArrowRight") return move(step, 0);
    if (event.key === "ArrowUp") return move(0, -step);
    if (event.key === "ArrowDown") return move(0, step);
    if (event.key === "Escape" && anchor !== null) {
      event.preventDefault();
      setAnchor(null);
      onAnnounce?.("Abandoned the mark in progress.");
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (!TWO_STEP.has(tool) && tool !== "freehand") {
      place(tool, geometryFor(tool, cursor, cursor));
      return;
    }
    if (tool === "freehand") {
      // A freehand stroke is a gesture, and pretending a keyboard can make one
      // would be a worse answer than saying which shape does the same job. The
      // list of six is not reduced for keyboard users; the honest route to
      // "this region" without a pointer is the box.
      onAnnounce?.(
        "Freehand needs a pointer. Use the rectangle or the ellipse to mark the same region by keyboard.",
      );
      return;
    }
    if (anchor === null) {
      setAnchor({ ...cursor });
      onAnnounce?.(
        `First corner at ${String(Math.round(cursor.x * 100))}% across, ${String(
          Math.round(cursor.y * 100),
        )}% down. Move to the second corner and press Enter.`,
      );
      return;
    }
    commit(anchor, cursor);
  };

  const cursorPoint = { x: rectangle.x + cursor.x * rectangle.width, y: rectangle.y + cursor.y * rectangle.height };
  const anchorPoint =
    anchor === null
      ? null
      : { x: rectangle.x + anchor.x * rectangle.width, y: rectangle.y + anchor.y * rectangle.height };

  return (
    <div className="flex flex-col gap-3">
      <div
        role="toolbar"
        aria-label="Annotation tools"
        aria-orientation="horizontal"
        data-testid="annotation-toolbar"
        className="flex flex-wrap gap-2"
      >
        {TOOLS.map((entry) => (
          <button
            key={entry.type}
            type="button"
            data-annotation-tool={entry.type}
            aria-pressed={tool === entry.type}
            onClick={() => {
              setTool(entry.type);
              setAnchor(null);
            }}
            className={`${TOOL_BUTTON} ${
              tool === entry.type ? "bg-sky-100 dark:bg-sky-950" : ""
            }`}
          >
            {/* Shape first, colour never: the glyph carries the meaning and the
                word carries it again. */}
            <span aria-hidden="true" className="mr-1">
              {entry.mark}
            </span>
            {entry.label}
          </button>
        ))}
      </div>

      <div className="relative overflow-hidden rounded border border-slate-300 bg-slate-950 dark:border-slate-700">
        {children}
        <div
          ref={setStage}
          data-testid="annotation-canvas"
          data-annotation-tool-active={tool}
          role="application"
          tabIndex={0}
          aria-label={`Annotation canvas. Tool: ${
            TOOLS.find((entry) => entry.type === tool)?.label ?? tool
          }. Move the cursor with the arrow keys and press Enter to place a mark. ${String(
            annotations.length,
          )} marks placed.`}
          aria-describedby="annotation-canvas-help"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
          className="absolute inset-0 touch-none"
          style={{ cursor: "crosshair" }}
        >
          <AnnotationOverlay
            annotations={annotations}
            content={content}
            stage={stage}
            selectedId={selectedId}
            onSelect={onSelect}
          />
          {/* The keyboard cursor, and the corner it has fixed. Decorative:
              the position is also stated as text below. */}
          {rectangle.width > 0 ? (
            <span
              aria-hidden="true"
              data-testid="annotation-cursor"
              className="pointer-events-none absolute block h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-sky-500"
              style={{ left: cursorPoint.x, top: cursorPoint.y }}
            />
          ) : null}
          {anchorPoint === null ? null : (
            <span
              aria-hidden="true"
              data-testid="annotation-anchor"
              className="pointer-events-none absolute block h-3 w-3 -translate-x-1/2 -translate-y-1/2 border-2 border-amber-400"
              style={{ left: anchorPoint.x, top: anchorPoint.y }}
            />
          )}
        </div>
      </div>

      <p id="annotation-canvas-help" className="text-xs text-slate-600 dark:text-slate-400">
        Drag to draw, or focus the canvas and use the arrow keys and Enter. Hold Shift for a finer
        step, and press Escape to abandon a mark in progress. Nothing drawn here is sent to the page:
        this is a picture of the application, not the application.
      </p>
      <p
        data-testid="annotation-cursor-position"
        className="text-xs text-slate-600 dark:text-slate-400"
      >
        Cursor at {Math.round(cursor.x * 100)}% across, {Math.round(cursor.y * 100)}% down
        {anchor === null
          ? ""
          : `; first corner fixed at ${String(Math.round(anchor.x * 100))}% across, ${String(
              Math.round(anchor.y * 100),
            )}% down`}
        .
      </p>
    </div>
  );
}
