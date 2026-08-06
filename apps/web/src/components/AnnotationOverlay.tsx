/**
 * The annotation overlay (ADR-0006, ADR-0011, `docs/DOMAIN_MODEL.md`
 * section 16).
 *
 * One rule governs this file: **convert once, at the edge.**
 *
 * Stored geometry is normalised to the artefact content rectangle — the
 * intrinsic pixel extent of the stored image. The only conversion in the
 * component is `containedContentRectangle`, which turns the stage's measured
 * box into the rectangle the image actually occupies inside it, and
 * `toRenderedBox` / `toRenderedArrow`, which place a mark inside that
 * rectangle. Nothing else multiplies a coordinate by anything.
 *
 * That is why the overlay is correct under all four of the changes
 * `AGENTS.md` "Browser-facing work" requires it to survive:
 *
 *   * **container resize** — the stage is measured with a `ResizeObserver`, so
 *     a new box produces a new content rectangle and the same normalised
 *     geometry lands on the same part of the picture;
 *   * **zoom** — a zoom level changes the stage's CSS size and nothing else;
 *   * **scroll** — marks are children of the stage, so they scroll with the
 *     image rather than being positioned against the viewport;
 *   * **device pixel ratio** — the ratio changes how many device pixels the
 *     browser paints into a CSS pixel. It never enters this computation, and a
 *     screenshot captured at ratio 2 has a content rectangle twice as large in
 *     device pixels, which normalisation divides straight back out.
 *
 * The marks are also the reason `ArtefactViewer` can lose this component
 * entirely and still be usable: nothing here is required to read the evidence.
 */

import { useEffect, useMemo, useState, type ReactElement } from "react";

import {
  containedContentRectangle,
  describeGeometry,
  toRenderedArrow,
  toRenderedBox,
  toRenderedPath,
  type AnnotationGeometry,
  type AnnotationType,
  type RenderedRectangle,
} from "@reviewplane/protocol/review";

import type { ArtefactContentRectangle } from "../api/client.ts";

/**
 * The least an overlay needs in order to draw a mark.
 *
 * A stored `Annotation` satisfies it, and so does a mark a human has just
 * drawn and not yet saved. Drawing them with one renderer is not a
 * convenience: a draft that were drawn by a second, simpler renderer would be
 * a second place for the coordinate conversion to be wrong, and the mistake
 * would only show up after the finding was saved — which is exactly when it
 * stops being correctable.
 */
export interface DisplayAnnotation {
  readonly id: string;
  readonly type: AnnotationType;
  readonly geometry: AnnotationGeometry;
  readonly label?: string;
  readonly marker_number?: number;
  readonly style_hint?: "default" | "critical" | "informational";
}

export interface AnnotationOverlayProps {
  readonly annotations: readonly DisplayAnnotation[];
  readonly content: ArtefactContentRectangle;
  /** The element the image fills. Measured, never assumed. */
  readonly stage: HTMLElement | null;
  readonly selectedId: string | null;
  readonly onSelect: (annotationId: string) => void;
}

const TONE: Readonly<Record<string, string>> = {
  default: "#38bdf8",
  critical: "#f87171",
  informational: "#a78bfa",
};

/** Measures an element's content box, and keeps measuring while it changes. */
function useMeasuredBox(element: HTMLElement | null): { width: number; height: number } {
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (element === null) return;
    const read = (): void => {
      const rect = element.getBoundingClientRect();
      setBox((previous) =>
        previous.width === rect.width && previous.height === rect.height
          ? previous
          : { width: rect.width, height: rect.height },
      );
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    // A device-pixel-ratio change does not resize the element, so it does not
    // fire the observer. It cannot move the overlay either — the maths is in
    // CSS pixels — but re-reading keeps the displayed measurements honest.
    const media = globalThis.matchMedia(`(resolution: ${String(globalThis.devicePixelRatio)}dppx)`);
    media.addEventListener("change", read);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", read);
    };
  }, [element]);
  return box;
}

function Mark({
  annotation,
  rectangle,
  selected,
  onSelect,
}: {
  readonly annotation: DisplayAnnotation;
  readonly rectangle: RenderedRectangle;
  readonly selected: boolean;
  readonly onSelect: (annotationId: string) => void;
}): ReactElement | null {
  const colour = TONE[annotation.style_hint ?? "default"] ?? TONE["default"];
  const label = `${annotation.label ?? "Unlabelled mark"}. ${describeGeometry(
    annotation.type,
    annotation.geometry,
  )}.`;
  const common = {
    "data-annotation": annotation.id,
    "data-annotation-type": annotation.type,
    type: "button" as const,
    onClick: () => {
      onSelect(annotation.id);
    },
    "aria-pressed": selected,
    title: annotation.label,
  };

  if (annotation.type === "arrow") {
    const { from, to } = toRenderedArrow(annotation.geometry, rectangle);
    const left = Math.min(from.x, to.x);
    const top = Math.min(from.y, to.y);
    const width = Math.max(Math.abs(to.x - from.x), 1);
    const height = Math.max(Math.abs(to.y - from.y), 1);
    return (
      <button
        {...common}
        className="absolute cursor-pointer border-0 bg-transparent p-0"
        style={{ left, top, width, height }}
        aria-label={label}
      >
        <svg width={width} height={height} viewBox={`0 0 ${String(width)} ${String(height)}`} aria-hidden="true">
          <line
            x1={from.x - left}
            y1={from.y - top}
            x2={to.x - left}
            y2={to.y - top}
            stroke={colour}
            strokeWidth={selected ? 4 : 3}
          />
          <circle cx={to.x - left} cy={to.y - top} r={selected ? 7 : 5} fill={colour} />
        </svg>
      </button>
    );
  }

  const box = toRenderedBox(annotation.geometry, rectangle);

  if (annotation.type === "freehand") {
    // The stroke is drawn inside its own bounding box, which the geometry
    // carries beside the path. Both go through the same conversion: a path
    // placed by different arithmetic from the box around it would drift apart
    // from its own hit target at some sizes and not others.
    const points = toRenderedPath(annotation.geometry, rectangle);
    const width = Math.max(box.width, 1);
    const height = Math.max(box.height, 1);
    return (
      <button
        {...common}
        className="absolute cursor-pointer border-0 bg-transparent p-0"
        style={{ left: box.x, top: box.y, width, height }}
        aria-label={label}
      >
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${String(width)} ${String(height)}`}
          aria-hidden="true"
          style={{ overflow: "visible" }}
        >
          <polyline
            points={points.map((point) => `${String(point.x - box.x)},${String(point.y - box.y)}`).join(" ")}
            fill="none"
            stroke={colour}
            strokeWidth={selected ? 5 : 3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    );
  }

  if (annotation.type === "point" || annotation.type === "numbered_marker") {
    const size = 28;
    return (
      <button
        {...common}
        className="absolute flex cursor-pointer items-center justify-center rounded-full text-xs font-bold text-slate-950"
        style={{
          left: box.x - size / 2,
          top: box.y - size / 2,
          width: size,
          height: size,
          background: colour,
          outline: selected ? `3px solid ${colour}` : "none",
          outlineOffset: 2,
        }}
        aria-label={label}
      >
        {annotation.type === "numbered_marker" ? (annotation.marker_number ?? "•") : "•"}
      </button>
    );
  }

  return (
    <button
      {...common}
      className="absolute cursor-pointer bg-transparent"
      style={{
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
        border: `${selected ? 4 : 3}px solid ${colour}`,
        borderRadius: annotation.type === "ellipse" ? "50%" : 4,
        // Turns rather than degrees, because the stored member is bounded to 0
        // to 1 like every other one. The box rotates about its own centre, so
        // the mark stays over the same part of the picture at any size.
        ...(annotation.geometry.rotation === undefined || annotation.geometry.rotation === 0
          ? {}
          : { transform: `rotate(${String(annotation.geometry.rotation)}turn)` }),
      }}
      aria-label={label}
    />
  );
}

export function AnnotationOverlay({
  annotations,
  content,
  stage,
  selectedId,
  onSelect,
}: AnnotationOverlayProps): ReactElement {
  const box = useMeasuredBox(stage);
  const rectangle = useMemo(
    () => containedContentRectangle(box, content),
    [box, content],
  );

  return (
    <div
      // The layer itself is decorative: every mark inside it is a labelled
      // control, and the annotation list carries the same information as text
      // (`docs/UX_FLOWS.md` section 19).
      data-testid="annotation-overlay"
      data-content-rectangle={`${String(Math.round(rectangle.width))}x${String(
        Math.round(rectangle.height),
      )}`}
      className="pointer-events-none absolute inset-0"
    >
      <div className="pointer-events-auto absolute inset-0">
        {annotations.map((annotation) => (
          <Mark
            key={annotation.id}
            annotation={annotation}
            rectangle={rectangle}
            selected={annotation.id === selectedId}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

/** Kept beside the renderer so a caller measures the same rectangle it draws. */
export function overlayContentRectangle(
  box: { readonly width: number; readonly height: number },
  content: ArtefactContentRectangle,
): RenderedRectangle {
  return containedContentRectangle(box, content);
}
