/**
 * The annotation coordinate contract (`docs/DOMAIN_MODEL.md` section 16,
 * ADR-0006).
 *
 * Annotation geometry is normalised to the **artefact content rectangle**: the
 * full intrinsic pixel extent of the stored image, origin at its top-left. Not
 * the viewport, not the element, not the rendered `img` box. Those three all
 * change when the window is resized, the page is zoomed or the device pixel
 * ratio changes; the content rectangle does not, which is the whole reason a
 * mark made in one session still lands on the same page region in another.
 *
 * Conversion therefore happens exactly once, at the edge of a renderer:
 *
 *     normalised (0..1)  --toRenderedBox-->  rendered CSS pixels
 *     rendered CSS pixels --toNormalisedPoint--> normalised (0..1)
 *
 * Between those two calls nothing multiplies by a device pixel ratio, and
 * nothing reads an intrinsic pixel size. A device pixel ratio of 2 doubles the
 * raster the browser downloads and leaves the CSS layout — and therefore the
 * overlay — unchanged. That is not an accident of this implementation: it is
 * what picking the content rectangle as the reference frame buys.
 *
 * This module holds no Node built-in, because `apps/web` renders overlays with
 * it in a browser and `apps/server` validates with it on the server.
 */

import {
  ANNOTATION_TYPE_VALUES,
  GEOMETRY_BY_ANNOTATION_TYPE,
  type AnnotationGeometry,
  type AnnotationType,
  type ContentRectangle,
} from "./generated/review/v1/types.ts";

/** A rectangle in whatever units the caller is drawing in, usually CSS pixels. */
export interface RenderedRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A point in whatever units the caller is drawing in. */
export interface RenderedPoint {
  readonly x: number;
  readonly y: number;
}

/** Every geometry member the schema declares. */
export type GeometryMember = "x" | "y" | "width" | "height" | "x2" | "y2";

const ALL_MEMBERS: readonly GeometryMember[] = ["x", "y", "width", "height", "x2", "y2"];

/**
 * Which members each annotation type requires, read from the schema's own
 * `geometry_by_annotation_type` vocabulary rather than restated here. JSON
 * Schema cannot condition a nested object on a sibling property, so this rule
 * lives in code — but its content still has exactly one source.
 */
export const REQUIRED_GEOMETRY_MEMBERS: Readonly<
  Record<AnnotationType, readonly GeometryMember[]>
> = readGeometryVocabulary();

function readGeometryVocabulary(): Readonly<Record<AnnotationType, readonly GeometryMember[]>> {
  const table: Partial<Record<AnnotationType, readonly GeometryMember[]>> = {};
  for (const entry of GEOMETRY_BY_ANNOTATION_TYPE) {
    const separator = entry.indexOf(":");
    const type = entry.slice(0, separator) as AnnotationType;
    table[type] = entry.slice(separator + 1).split(",") as GeometryMember[];
  }
  for (const type of ANNOTATION_TYPE_VALUES) {
    if (table[type] === undefined) {
      // A type added to the schema without its geometry members would
      // otherwise validate against an empty rule, which is worse than a crash
      // at load time.
      throw new Error(`schemas/review/v1.schema.json declares no geometry members for ${type}`);
    }
  }
  return table as Readonly<Record<AnnotationType, readonly GeometryMember[]>>;
}

/** A geometry that does not match its annotation type. */
export interface GeometryViolation {
  readonly member: GeometryMember;
  readonly code: "required" | "forbidden" | "out_of_range" | "not_finite";
  readonly message: string;
}

/** Whether a value is a coordinate normalised to 0 to 1 inclusive. */
export function isNormalisedCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function isAnnotationType(value: unknown): value is AnnotationType {
  return typeof value === "string" && (ANNOTATION_TYPE_VALUES as readonly string[]).includes(value);
}

/**
 * Checks a geometry against its annotation type.
 *
 * Out-of-range values are reported, never clamped: a coordinate outside 0 to 1
 * means the producer used a different reference frame, and clamping would turn
 * that mistake into a plausible-looking overlay in the wrong place — the exact
 * failure ADR-0006 exists to prevent.
 */
export function checkGeometryForType(
  type: AnnotationType,
  geometry: Readonly<Record<string, unknown>>,
): readonly GeometryViolation[] {
  const required = REQUIRED_GEOMETRY_MEMBERS[type];
  const violations: GeometryViolation[] = [];
  for (const member of ALL_MEMBERS) {
    const present = geometry[member] !== undefined;
    const wanted = required.includes(member);
    if (wanted && !present) {
      violations.push({
        member,
        code: "required",
        message: `a ${type} annotation requires geometry.${member}`,
      });
      continue;
    }
    if (!wanted && present) {
      violations.push({
        member,
        code: "forbidden",
        message: `a ${type} annotation must not carry geometry.${member}`,
      });
      continue;
    }
    if (!present) continue;
    const value = geometry[member];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      violations.push({
        member,
        code: "not_finite",
        message: `geometry.${member} must be a finite number`,
      });
      continue;
    }
    if (value < 0 || value > 1) {
      violations.push({
        member,
        code: "out_of_range",
        message: `geometry.${member} is ${String(value)}, outside the 0 to 1 range of the artefact content rectangle`,
      });
    }
  }
  if (required.includes("width") && required.includes("height")) {
    const x = geometry["x"];
    const y = geometry["y"];
    const width = geometry["width"];
    const height = geometry["height"];
    if (
      typeof x === "number" &&
      typeof width === "number" &&
      Number.isFinite(x + width) &&
      x + width > 1
    ) {
      violations.push({
        member: "width",
        code: "out_of_range",
        message: "geometry.x plus geometry.width leaves the artefact content rectangle",
      });
    }
    if (
      typeof y === "number" &&
      typeof height === "number" &&
      Number.isFinite(y + height) &&
      y + height > 1
    ) {
      violations.push({
        member: "height",
        code: "out_of_range",
        message: "geometry.y plus geometry.height leaves the artefact content rectangle",
      });
    }
  }
  return violations;
}

/**
 * The rendered content rectangle of an image displayed inside a box under
 * `object-fit: contain`.
 *
 * The letterbox offset is the part that is easy to forget: an image narrower
 * than its box is centred, and an overlay that ignores the offset drifts by
 * exactly half the unused width. Returning the rectangle rather than a scale
 * factor means a caller cannot forget it.
 */
export function containedContentRectangle(
  box: { readonly width: number; readonly height: number },
  content: ContentRectangle,
): RenderedRectangle {
  if (
    !(box.width > 0) ||
    !(box.height > 0) ||
    !(content.width_px > 0) ||
    !(content.height_px > 0)
  ) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const scale = Math.min(box.width / content.width_px, box.height / content.height_px);
  const width = content.width_px * scale;
  const height = content.height_px * scale;
  return {
    x: (box.width - width) / 2,
    y: (box.height - height) / 2,
    width,
    height,
  };
}

/** Normalised point to rendered coordinates inside a content rectangle. */
export function toRenderedPoint(
  point: { readonly x: number; readonly y: number },
  rectangle: RenderedRectangle,
): RenderedPoint {
  return {
    x: rectangle.x + point.x * rectangle.width,
    y: rectangle.y + point.y * rectangle.height,
  };
}

/**
 * Rendered coordinates back to normalised, the inverse of `toRenderedPoint`.
 *
 * Used when a human draws a new mark: the pointer position is in the same
 * units as the rendered rectangle, and the value stored is normalised. The
 * round trip is exact to floating-point precision, which the unit tests assert
 * in both directions.
 */
export function toNormalisedPoint(
  point: RenderedPoint,
  rectangle: RenderedRectangle,
): { readonly x: number; readonly y: number } {
  if (!(rectangle.width > 0) || !(rectangle.height > 0)) return { x: 0, y: 0 };
  return {
    x: (point.x - rectangle.x) / rectangle.width,
    y: (point.y - rectangle.y) / rectangle.height,
  };
}

/**
 * A normalised box to a rendered box. Point and arrow geometries have no box;
 * for those the result is the degenerate rectangle at their position, which is
 * what a marker is drawn around.
 */
export function toRenderedBox(
  geometry: AnnotationGeometry,
  rectangle: RenderedRectangle,
): RenderedRectangle {
  const origin = toRenderedPoint(geometry, rectangle);
  return {
    x: origin.x,
    y: origin.y,
    width: (geometry.width ?? 0) * rectangle.width,
    height: (geometry.height ?? 0) * rectangle.height,
  };
}

/** Tail and head of an arrow in rendered coordinates. */
export function toRenderedArrow(
  geometry: AnnotationGeometry,
  rectangle: RenderedRectangle,
): { readonly from: RenderedPoint; readonly to: RenderedPoint } {
  return {
    from: toRenderedPoint(geometry, rectangle),
    to: toRenderedPoint({ x: geometry.x2 ?? geometry.x, y: geometry.y2 ?? geometry.y }, rectangle),
  };
}

/**
 * A one-line text alternative for a mark, so the annotation list conveys the
 * same information as the canvas (`docs/UX_FLOWS.md` section 19). Percentages
 * are the honest unit here: the reader is being told where on the image the
 * mark is, and the image has no other agreed size.
 */
export function describeGeometry(type: AnnotationType, geometry: AnnotationGeometry): string {
  const percent = (value: number): string => `${String(Math.round(value * 100))}%`;
  const at = `at ${percent(geometry.x)} across, ${percent(geometry.y)} down`;
  switch (type) {
    case "rectangle":
    case "ellipse":
      return `${type} ${at}, ${percent(geometry.width ?? 0)} wide and ${percent(
        geometry.height ?? 0,
      )} tall`;
    case "arrow":
      return `arrow from ${percent(geometry.x)} across, ${percent(geometry.y)} down to ${percent(
        geometry.x2 ?? geometry.x,
      )} across, ${percent(geometry.y2 ?? geometry.y)} down`;
    case "point":
    case "numbered_marker":
      return `${type.replace("_", " ")} ${at}`;
  }
}
