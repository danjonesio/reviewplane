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
  type AnnotationPathPoint,
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
export type GeometryMember =
  | "x"
  | "y"
  | "width"
  | "height"
  | "x2"
  | "y2"
  | "rotation"
  | "path";

const ALL_MEMBERS: readonly GeometryMember[] = [
  "x",
  "y",
  "width",
  "height",
  "x2",
  "y2",
  "rotation",
  "path",
];

/**
 * The one member that is not a scalar coordinate. It is listed rather than
 * inferred so that a member added to the schema without a decision about its
 * shape fails the exhaustiveness below instead of being silently range-checked
 * as a number.
 */
const ARRAY_MEMBERS: readonly GeometryMember[] = ["path"];

/**
 * Points a freehand path must carry, at least and at most
 * (`schemas/review/v1.schema.json` `$defs.annotation_geometry.path`).
 *
 * The upper bound is repeated here rather than read from the generated
 * validator because this function is also run against rows already in the
 * database, where nothing has passed through the validator, and because the
 * server needs to refuse an oversized path with a message naming the bound.
 * The two are asserted equal by the unit tests.
 */
export const FREEHAND_PATH_POINT_BOUNDS = { minimum: 2, maximum: 128 } as const;

interface GeometryRule {
  readonly version: number;
  readonly required: readonly GeometryMember[];
  readonly optional: readonly GeometryMember[];
}

const GEOMETRY_RULES: Readonly<Record<AnnotationType, GeometryRule>> = readGeometryVocabulary();

/**
 * Which members each annotation type requires, read from the schema's own
 * `geometry_by_annotation_type` vocabulary rather than restated here. JSON
 * Schema cannot condition a nested object on a sibling property, so this rule
 * lives in code — but its content still has exactly one source.
 */
export const REQUIRED_GEOMETRY_MEMBERS: Readonly<
  Record<AnnotationType, readonly GeometryMember[]>
> = Object.fromEntries(
  ANNOTATION_TYPE_VALUES.map((type) => [type, GEOMETRY_RULES[type].required]),
) as Readonly<Record<AnnotationType, readonly GeometryMember[]>>;

/**
 * Members a type may carry but does not require. Absent means the shape's
 * default: an unrotated box.
 */
export const OPTIONAL_GEOMETRY_MEMBERS: Readonly<
  Record<AnnotationType, readonly GeometryMember[]>
> = Object.fromEntries(
  ANNOTATION_TYPE_VALUES.map((type) => [type, GEOMETRY_RULES[type].optional]),
) as Readonly<Record<AnnotationType, readonly GeometryMember[]>>;

/**
 * The geometry version of each annotation type (`docs/DOMAIN_MODEL.md` section
 * 16, ADR-0032).
 *
 * It is per type rather than per document so that adding a member to one shape
 * does not renumber the geometry of every other one, and it is stored on each
 * annotation so a reader can tell which member list a stored geometry was
 * written against without guessing from the members that happen to be present.
 */
export const GEOMETRY_VERSION_BY_ANNOTATION_TYPE: Readonly<Record<AnnotationType, number>> =
  Object.fromEntries(
    ANNOTATION_TYPE_VALUES.map((type) => [type, GEOMETRY_RULES[type].version]),
  ) as Readonly<Record<AnnotationType, number>>;

function readGeometryVocabulary(): Readonly<Record<AnnotationType, GeometryRule>> {
  const table: Partial<Record<AnnotationType, GeometryRule>> = {};
  for (const entry of GEOMETRY_BY_ANNOTATION_TYPE) {
    // `type:version:required[:optional]`.
    const [type, version, required, optional] = entry.split(":");
    if (type === undefined || version === undefined || required === undefined) {
      throw new Error(`schemas/review/v1.schema.json has a malformed geometry rule: ${entry}`);
    }
    const parsed = Number(version);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`schemas/review/v1.schema.json has a malformed geometry version: ${entry}`);
    }
    table[type as AnnotationType] = {
      version: parsed,
      required: required.split(",") as GeometryMember[],
      optional:
        optional === undefined || optional === ""
          ? []
          : (optional.split(",") as GeometryMember[]),
    };
  }
  for (const type of ANNOTATION_TYPE_VALUES) {
    if (table[type] === undefined) {
      // A type added to the schema without its geometry members would
      // otherwise validate against an empty rule, which is worse than a crash
      // at load time.
      throw new Error(`schemas/review/v1.schema.json declares no geometry members for ${type}`);
    }
  }
  return table as Readonly<Record<AnnotationType, GeometryRule>>;
}

/**
 * The geometry version a new annotation of this type is recorded with. The
 * control plane calls this rather than accepting a version from a caller: a
 * client able to name it could claim a member list its geometry does not
 * satisfy.
 */
export function geometryVersionForType(type: AnnotationType): number {
  return GEOMETRY_VERSION_BY_ANNOTATION_TYPE[type];
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
  const optional = OPTIONAL_GEOMETRY_MEMBERS[type];
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
    if (!wanted && !optional.includes(member) && present) {
      violations.push({
        member,
        code: "forbidden",
        message: `a ${type} annotation must not carry geometry.${member}`,
      });
      continue;
    }
    if (!present) continue;
    if (ARRAY_MEMBERS.includes(member)) {
      violations.push(...checkPath(member, geometry[member]));
      continue;
    }
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
 * Checks a freehand path: an array, within its point bounds, of points whose
 * coordinates are normalised like every other member.
 *
 * The bound matters as much as the range. A path is the only geometry member
 * whose size a caller chooses, so an unbounded one is a way to make a single
 * annotation cost more than the finding that owns it, and the schema's byte
 * limit would refuse it with a message about bytes rather than about the mark
 * that was drawn.
 */
function checkPath(member: GeometryMember, value: unknown): readonly GeometryViolation[] {
  if (!Array.isArray(value)) {
    return [
      {
        member,
        code: "not_finite",
        message: `geometry.${member} must be an array of normalised points`,
      },
    ];
  }
  if (value.length < FREEHAND_PATH_POINT_BOUNDS.minimum) {
    return [
      {
        member,
        code: "required",
        message: `geometry.${member} must carry at least ${String(
          FREEHAND_PATH_POINT_BOUNDS.minimum,
        )} points; a stroke of one point is a point annotation`,
      },
    ];
  }
  if (value.length > FREEHAND_PATH_POINT_BOUNDS.maximum) {
    return [
      {
        member,
        code: "out_of_range",
        message: `geometry.${member} carries ${String(value.length)} points, more than the ${String(
          FREEHAND_PATH_POINT_BOUNDS.maximum,
        )} a freehand stroke may hold; decimate the stroke before recording it`,
      },
    ];
  }
  const violations: GeometryViolation[] = [];
  for (const [index, point] of value.entries()) {
    if (typeof point !== "object" || point === null) {
      violations.push({
        member,
        code: "not_finite",
        message: `geometry.${member}[${String(index)}] must be an object with x and y`,
      });
      continue;
    }
    const record = point as Record<string, unknown>;
    for (const key of ["x", "y"] as const) {
      const coordinate = record[key];
      if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) {
        violations.push({
          member,
          code: "not_finite",
          message: `geometry.${member}[${String(index)}].${key} must be a finite number`,
        });
        continue;
      }
      if (coordinate < 0 || coordinate > 1) {
        violations.push({
          member,
          code: "out_of_range",
          message: `geometry.${member}[${String(index)}].${key} is ${String(
            coordinate,
          )}, outside the 0 to 1 range of the artefact content rectangle`,
        });
      }
    }
    for (const key of Object.keys(record)) {
      if (key === "x" || key === "y") continue;
      violations.push({
        member,
        code: "forbidden",
        message: `geometry.${member}[${String(index)}] must not carry ${key}`,
      });
    }
    // One bad point is enough to know the producer used another frame; the
    // rest would repeat the same message up to 128 times.
    if (violations.length > 0) break;
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

/** Clamps to the 0-to-1 range and rounds to the precision a capture resolves. */
function roundNormalised(value: number): number {
  return Number(Math.min(1, Math.max(0, value)).toFixed(4));
}

/**
 * The geometry a pair of normalised positions makes, for a given shape.
 *
 * It lives beside the validator rather than in the drawing surface, for the
 * same reason `checkGeometryForType` does: a producer and its validator that
 * disagree is exactly the failure the shared package exists to prevent, and a
 * second client drawing marks must build them the same way.
 *
 * The box is clamped against the far edge rather than against 1, because
 * `x + width` must not leave the content rectangle — the one place where
 * rounding could otherwise push a mark drawn exactly on the edge outside it and
 * earn a refusal the person drawing could do nothing about.
 */
export function geometryForDrag(
  type: AnnotationType,
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
): AnnotationGeometry {
  if (type === "arrow") {
    return {
      x: roundNormalised(from.x),
      y: roundNormalised(from.y),
      x2: roundNormalised(to.x),
      y2: roundNormalised(to.y),
    };
  }
  if (type === "point" || type === "numbered_marker") {
    return { x: roundNormalised(to.x), y: roundNormalised(to.y) };
  }
  const x = roundNormalised(Math.min(from.x, to.x));
  const y = roundNormalised(Math.min(from.y, to.y));
  return {
    x,
    y,
    width: roundNormalised(Math.min(Math.abs(to.x - from.x), 1 - x)),
    height: roundNormalised(Math.min(Math.abs(to.y - from.y), 1 - y)),
  };
}

/**
 * Reduces a raw stroke to the points that carry its shape, within the bound.
 *
 * The protocol refuses a path longer than
 * `FREEHAND_PATH_POINT_BOUNDS.maximum` rather than truncating it (ADR-0032),
 * so the thinning has to happen before the request is built — and it has to
 * *succeed*, because a producer that returned 129 points would earn a refusal
 * the person who drew the stroke could do nothing about.
 *
 * Dropping samples closer together than a threshold keeps the corners, which is
 * what a stroke is recognisable by, and discards the dozens of near-identical
 * samples a slow hand produces on a fast pointer.
 *
 * The even-sampling tail is a **guard rather than an expected path**: the
 * threshold grows past the diagonal of the whole content rectangle within the
 * attempt limit, so no stroke inside 0 to 1 can survive every round. It is kept
 * because the alternative if that reasoning is ever wrong — a producer
 * returning more points than the protocol accepts — is a refusal the person who
 * drew the stroke can do nothing about.
 */
export function decimateStroke(
  points: readonly { readonly x: number; readonly y: number }[],
  maximum: number = FREEHAND_PATH_POINT_BOUNDS.maximum,
): { readonly x: number; readonly y: number }[] {
  const rounded = (point: { readonly x: number; readonly y: number }): { x: number; y: number } => ({
    x: roundNormalised(point.x),
    y: roundNormalised(point.y),
  });
  if (points.length <= 2) return points.map(rounded);
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return [];

  let threshold = 0.004;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const kept: { x: number; y: number }[] = [rounded(first)];
    for (const point of points.slice(1, -1)) {
      const previous = kept[kept.length - 1];
      if (previous === undefined) continue;
      if (Math.hypot(point.x - previous.x, point.y - previous.y) >= threshold) {
        kept.push(rounded(point));
      }
    }
    kept.push(rounded(last));
    if (kept.length <= maximum) return kept;
    threshold *= 1.8;
  }

  const stride = Math.ceil(points.length / (maximum - 1));
  const sampled = points.filter((_unused, index) => index % stride === 0).map(rounded);
  const tail = rounded(last);
  const end = sampled[sampled.length - 1];
  if (end === undefined || end.x !== tail.x || end.y !== tail.y) sampled.push(tail);
  return sampled.slice(0, maximum);
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
  const box = `${percent(geometry.width ?? 0)} wide and ${percent(geometry.height ?? 0)} tall`;
  switch (type) {
    case "rectangle":
    case "ellipse": {
      const turned =
        geometry.rotation === undefined || geometry.rotation === 0
          ? ""
          : `, turned ${String(Math.round(geometry.rotation * 360))} degrees clockwise`;
      return `${type} ${at}, ${box}${turned}`;
    }
    case "arrow":
      return `arrow from ${percent(geometry.x)} across, ${percent(geometry.y)} down to ${percent(
        geometry.x2 ?? geometry.x,
      )} across, ${percent(geometry.y2 ?? geometry.y)} down`;
    case "point":
    case "numbered_marker":
      return `${type.replace("_", " ")} ${at}`;
    case "freehand":
      // The path itself is not read out: a hundred coordinates is not a text
      // alternative anybody can use. The bounding box and the stroke length
      // are what a reader needs in order to know which part of the picture the
      // mark covers, which is what section 19 asks the alternative to convey.
      return `freehand stroke of ${String(
        geometry.path?.length ?? 0,
      )} points ${at}, covering ${box}`;
  }
}

/**
 * A freehand path in rendered coordinates, ready for an SVG `polyline`.
 *
 * It converts through `toRenderedPoint` like every other mark, so a path obeys
 * the same "convert once, at the edge" rule the rest of this module states: the
 * caller measures its box, contains the content rectangle inside it and passes
 * that rectangle here.
 */
export function toRenderedPath(
  geometry: AnnotationGeometry,
  rectangle: RenderedRectangle,
): readonly RenderedPoint[] {
  const path: readonly AnnotationPathPoint[] = geometry.path ?? [];
  return path.map((point) => toRenderedPoint(point, rectangle));
}

/**
 * The bounding box of a sampled path, normalised, as `freehand` geometry
 * records it beside the path itself.
 *
 * Recording the box as well as the path is what lets the annotation list, the
 * artefact viewer's hit target and a future renderer that cannot draw a stroke
 * still say which region the mark covers (ADR-0032). It is derived here rather
 * than by each caller so that the box and the path cannot disagree.
 */
export function pathBounds(path: readonly { readonly x: number; readonly y: number }[]): {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
} {
  const first = path[0];
  if (first === undefined) return { x: 0, y: 0, width: 0, height: 0 };
  let left = first.x;
  let top = first.y;
  let right = first.x;
  let bottom = first.y;
  for (const point of path) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}
