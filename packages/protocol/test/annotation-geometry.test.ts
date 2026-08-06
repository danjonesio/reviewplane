/**
 * The annotation coordinate contract (`docs/TESTING.md` section 2 "Annotation
 * coordinate conversion", ADR-0006).
 *
 * The alignment failures this suite exists to catch are not exotic: a mark
 * drifts because a renderer forgot the letterbox offset, or because it
 * multiplied by a device pixel ratio somewhere in the middle, or because a
 * producer sent CSS pixels where normalised units were expected. Each of those
 * gets a test rather than a comment.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  FREEHAND_PATH_POINT_BOUNDS,
  GEOMETRY_VERSION_BY_ANNOTATION_TYPE,
  REQUIRED_GEOMETRY_MEMBERS,
  checkGeometryForType,
  containedContentRectangle,
  describeGeometry,
  geometryVersionForType,
  isNormalisedCoordinate,
  pathBounds,
  toNormalisedPoint,
  toRenderedArrow,
  toRenderedBox,
  toRenderedPath,
  toRenderedPoint,
} from "../src/annotation-geometry.ts";
import {
  ANNOTATION_TYPE_VALUES,
  type SchemaViolation,
} from "../src/generated/review/v1/types.ts";
import { validateAnnotationGeometry } from "../src/generated/review/v1/validate.ts";

/** The 390x844 preset at a device pixel ratio of 2 (`AGENTS.md`). */
const MOBILE_CONTENT = { width_px: 780, height_px: 1688 };
/** The same page at 1440x900 and a ratio of 1. */
const DESKTOP_CONTENT = { width_px: 1440, height_px: 900 };

test("every annotation type has its required geometry members declared by the schema", () => {
  for (const type of ANNOTATION_TYPE_VALUES) {
    const members = REQUIRED_GEOMETRY_MEMBERS[type];
    assert.ok(members !== undefined && members.length >= 2, `${type} has no geometry members`);
    assert.ok(members.includes("x") && members.includes("y"), `${type} lacks a position`);
  }
});

test("a normalised point converts to rendered coordinates and back unchanged", () => {
  const rectangle = { x: 12, y: 34, width: 640, height: 400 };
  for (const point of [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 0.54, y: 0.02 },
    { x: 0.125, y: 0.875 },
  ]) {
    const rendered = toRenderedPoint(point, rectangle);
    const back = toNormalisedPoint(rendered, rectangle);
    assert.ok(Math.abs(back.x - point.x) < 1e-12, `x drifted: ${String(back.x)}`);
    assert.ok(Math.abs(back.y - point.y) < 1e-12, `y drifted: ${String(back.y)}`);
  }
});

test("the same geometry lands on the same fraction of the image at any rendered size", () => {
  const geometry = { x: 0.54, y: 0.02, width: 0.38, height: 0.11 };
  // Two very different containers, one portrait and one landscape.
  const small = containedContentRectangle({ width: 358, height: 700 }, MOBILE_CONTENT);
  const large = containedContentRectangle({ width: 1104, height: 720 }, MOBILE_CONTENT);

  for (const rectangle of [small, large]) {
    const box = toRenderedBox(geometry, rectangle);
    // Expressed as a fraction of the rendered content rectangle, the box is
    // identical: that is the property the resize proof rests on.
    assert.ok(Math.abs((box.x - rectangle.x) / rectangle.width - geometry.x) < 1e-12);
    assert.ok(Math.abs((box.y - rectangle.y) / rectangle.height - geometry.y) < 1e-12);
    assert.ok(Math.abs(box.width / rectangle.width - geometry.width) < 1e-12);
    assert.ok(Math.abs(box.height / rectangle.height - geometry.height) < 1e-12);
  }
});

test("the device pixel ratio changes the raster and not the overlay", () => {
  // The same page captured at ratio 1 and ratio 2 produces content rectangles
  // that differ by a factor of two in device pixels.
  const atOne = { width_px: 390, height_px: 844 };
  const atTwo = { width_px: 780, height_px: 1688 };
  const box = { width: 360, height: 780 };
  const first = containedContentRectangle(box, atOne);
  const second = containedContentRectangle(box, atTwo);
  assert.deepEqual(first, second);

  const geometry = { x: 0.25, y: 0.5, width: 0.5, height: 0.25 };
  assert.deepEqual(toRenderedBox(geometry, first), toRenderedBox(geometry, second));
});

test("the content rectangle is letterboxed and centred inside its box", () => {
  // A landscape image in a square box: bars above and below, none at the side.
  const rectangle = containedContentRectangle({ width: 600, height: 600 }, DESKTOP_CONTENT);
  assert.equal(rectangle.width, 600);
  assert.equal(rectangle.height, 375);
  assert.equal(rectangle.x, 0);
  assert.equal(rectangle.y, 112.5);

  // Forgetting the offset is the classic drift: the top-left of the image is
  // not the top-left of the box.
  const origin = toRenderedPoint({ x: 0, y: 0 }, rectangle);
  assert.equal(origin.y, 112.5);
});

test("a degenerate box yields an empty content rectangle rather than a division by zero", () => {
  assert.deepEqual(containedContentRectangle({ width: 0, height: 400 }, DESKTOP_CONTENT), {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });
  assert.deepEqual(toNormalisedPoint({ x: 10, y: 10 }, { x: 0, y: 0, width: 0, height: 0 }), {
    x: 0,
    y: 0,
  });
});

test("an arrow keeps its direction when the container changes shape", () => {
  const geometry = { x: 0.12, y: 0.9, x2: 0.6, y2: 0.14 };
  const wide = containedContentRectangle({ width: 1200, height: 900 }, DESKTOP_CONTENT);
  const narrow = containedContentRectangle({ width: 300, height: 900 }, DESKTOP_CONTENT);
  for (const rectangle of [wide, narrow]) {
    const arrow = toRenderedArrow(geometry, rectangle);
    assert.ok(arrow.to.x > arrow.from.x, "the arrow no longer points to the right");
    assert.ok(arrow.to.y < arrow.from.y, "the arrow no longer points upwards");
  }
});

test("geometry outside 0 to 1 is reported, never clamped", () => {
  const violations = checkGeometryForType("rectangle", {
    x: 0.54,
    y: 0.02,
    width: 1.38,
    height: 0.11,
  });
  // Two separate facts: the member is out of range, and the box it describes
  // leaves the artefact. Both are reported so a caller sees the whole problem.
  assert.equal(violations.length, 2);
  assert.deepEqual(
    violations.map((violation) => violation.member),
    ["width", "width"],
  );
  assert.ok(violations.every((violation) => violation.code === "out_of_range"));

  assert.equal(
    checkGeometryForType("rectangle", { x: -0.01, y: 0.02, width: 0.3, height: 0.1 })[0]?.code,
    "out_of_range",
  );
  // CSS pixels where normalised units belong: the most likely real mistake.
  assert.ok(
    checkGeometryForType("rectangle", { x: 421, y: 17, width: 296, height: 93 }).length >= 4,
  );
});

test("a box that starts inside the artefact but leaves it is refused", () => {
  const violations = checkGeometryForType("rectangle", {
    x: 0.8,
    y: 0.1,
    width: 0.5,
    height: 0.1,
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.member, "width");
});

test("each annotation type requires exactly its own geometry members", () => {
  assert.deepEqual(checkGeometryForType("point", { x: 0.4, y: 0.6 }), []);
  assert.deepEqual(checkGeometryForType("numbered_marker", { x: 0, y: 1 }), []);
  assert.deepEqual(checkGeometryForType("arrow", { x: 0.1, y: 0.2, x2: 0.3, y2: 0.4 }), []);
  assert.deepEqual(checkGeometryForType("ellipse", { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }), []);

  // A rectangle without a size is not a rectangle.
  assert.equal(checkGeometryForType("rectangle", { x: 0.1, y: 0.2 }).length, 2);
  // A point with a size is a caller confusing two shapes.
  assert.equal(
    checkGeometryForType("point", { x: 0.1, y: 0.2, width: 0.3, height: 0.1 })[0]?.code,
    "forbidden",
  );
  // An arrow without a head has nowhere to point.
  assert.equal(checkGeometryForType("arrow", { x: 0.1, y: 0.2 }).length, 2);
});

test("a non-finite coordinate is refused", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, "0.5", null]) {
    const violations = checkGeometryForType("point", { x: value, y: 0.5 });
    assert.equal(violations.length, 1, `value ${String(value)} was accepted`);
    assert.equal(violations[0]?.code, "not_finite");
  }
  assert.equal(isNormalisedCoordinate(Number.NaN), false);
  assert.equal(isNormalisedCoordinate(0), true);
  assert.equal(isNormalisedCoordinate(1), true);
  assert.equal(isNormalisedCoordinate(1.0001), false);
});

test("every annotation type has a text alternative naming where it is", () => {
  const geometry = { x: 0.54, y: 0.02, width: 0.38, height: 0.11, x2: 0.9, y2: 0.5 };
  for (const type of ANNOTATION_TYPE_VALUES) {
    const description = describeGeometry(type, geometry);
    assert.ok(description.length > 0);
    assert.match(description, /%/u, `${type} description states no position`);
  }
});

// ---------------------------------------------------------------------------
// Freehand paths, rotation and per-type geometry versions (ADR-0032)
// ---------------------------------------------------------------------------

test("a freehand annotation carries its path and the box that path covers", () => {
  const path = [
    { x: 0.2, y: 0.44 },
    { x: 0.28, y: 0.4 },
    { x: 0.45, y: 0.5 },
  ];
  const bounds = pathBounds(path);
  assert.deepEqual(checkGeometryForType("freehand", { ...bounds, path }), []);

  // The box is derived from the path rather than declared beside it, so the
  // two cannot disagree.
  assert.equal(bounds.x, 0.2);
  assert.equal(bounds.y, 0.4);
  assert.ok(Math.abs(bounds.width - 0.25) < 1e-12);
  assert.ok(Math.abs(bounds.height - 0.1) < 1e-12);
});

test("a freehand path outside 0 to 1 is refused rather than clamped", () => {
  const violations = checkGeometryForType("freehand", {
    x: 0.2,
    y: 0.4,
    width: 0.3,
    height: 0.3,
    path: [
      { x: 0.2, y: 0.44 },
      // The rendered frame rather than the artefact content rectangle.
      { x: 296, y: 93 },
    ],
  });
  assert.ok(violations.length > 0, "a path point in CSS pixels was accepted");
  assert.equal(violations[0]?.member, "path");
  assert.equal(violations[0]?.code, "out_of_range");
});

test("a freehand path is bounded at both ends", () => {
  const box = { x: 0, y: 0, width: 1, height: 1 };
  const point = { x: 0.5, y: 0.5 };

  const single = checkGeometryForType("freehand", { ...box, path: [point] });
  assert.equal(single[0]?.code, "required", "a one-point stroke is a point annotation");

  const overlong = checkGeometryForType("freehand", {
    ...box,
    path: Array.from({ length: FREEHAND_PATH_POINT_BOUNDS.maximum + 1 }, () => point),
  });
  assert.equal(overlong.length, 1);
  assert.equal(overlong[0]?.code, "out_of_range");
  assert.match(
    overlong[0]?.message ?? "",
    new RegExp(String(FREEHAND_PATH_POINT_BOUNDS.maximum), "u"),
    "the refusal does not name the bound the caller exceeded",
  );

  // Exactly the bound is accepted: the limit is inclusive, like the coordinate
  // range it sits beside.
  assert.deepEqual(
    checkGeometryForType("freehand", {
      ...box,
      path: Array.from({ length: FREEHAND_PATH_POINT_BOUNDS.maximum }, () => point),
    }),
    [],
  );
});

test("a path point may not smuggle a third member past the bound check", () => {
  const violations = checkGeometryForType("freehand", {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    path: [
      { x: 0.1, y: 0.1 },
      { x: 0.2, y: 0.2, radius: 0.4 },
    ],
  });
  assert.equal(violations[0]?.code, "forbidden");
});

test("only a box may be rotated, and rotation obeys the same 0 to 1 bound", () => {
  const box = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
  for (const type of ["rectangle", "ellipse"] as const) {
    assert.deepEqual(checkGeometryForType(type, box), [], `${type} without rotation`);
    assert.deepEqual(checkGeometryForType(type, { ...box, rotation: 0.125 }), []);
    // A caller that sent degrees rather than turns is refused, which is the
    // point of keeping every member in one range.
    const degrees = checkGeometryForType(type, { ...box, rotation: 45 });
    assert.equal(degrees[0]?.member, "rotation");
    assert.equal(degrees[0]?.code, "out_of_range");
  }
  assert.equal(
    checkGeometryForType("point", { x: 0.1, y: 0.2, rotation: 0.5 })[0]?.code,
    "forbidden",
    "a point has no orientation to rotate",
  );
  assert.equal(
    checkGeometryForType("arrow", { x: 0.1, y: 0.2, x2: 0.3, y2: 0.4, rotation: 0.5 })[0]?.code,
    "forbidden",
    "an arrow's direction is its two points, not a rotation",
  );
});

test("a rotated box states its rotation in the text alternative, in degrees", () => {
  const description = describeGeometry("ellipse", {
    x: 0.1,
    y: 0.2,
    width: 0.3,
    height: 0.4,
    rotation: 0.125,
  });
  assert.match(description, /45 degrees clockwise/u);
  // An unrotated box says nothing about rotation rather than saying "0
  // degrees", which would read as a fact the annotator chose.
  assert.doesNotMatch(
    describeGeometry("ellipse", { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }),
    /degrees/u,
  );
});

test("a freehand text alternative names the region rather than reading out the path", () => {
  const description = describeGeometry("freehand", {
    x: 0.2,
    y: 0.4,
    width: 0.25,
    height: 0.1,
    path: [
      { x: 0.2, y: 0.44 },
      { x: 0.28, y: 0.4 },
      { x: 0.45, y: 0.5 },
    ],
  });
  assert.match(description, /3 points/u);
  assert.match(description, /20% across, 40% down/u);
  // Reading a hundred coordinates aloud is not an alternative anybody can use.
  assert.doesNotMatch(description, /0\.28/u);
});

test("a freehand path renders through the same conversion every other mark uses", () => {
  const geometry = {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    path: [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
    ],
  };
  const rectangle = containedContentRectangle({ width: 720, height: 1600 }, MOBILE_CONTENT);
  const rendered = toRenderedPath(geometry, rectangle);
  assert.equal(rendered.length, 3);
  assert.deepEqual(rendered[0], { x: rectangle.x, y: rectangle.y });
  assert.deepEqual(rendered[2], {
    x: rectangle.x + rectangle.width,
    y: rectangle.y + rectangle.height,
  });
  // The stroke scales with the rectangle and with nothing else, which is the
  // property the normalised frame exists to give.
  const half = toRenderedPath(
    geometry,
    containedContentRectangle({ width: 360, height: 800 }, MOBILE_CONTENT),
  );
  assert.ok(Math.abs((rendered[1]?.x ?? 0) / (half[1]?.x ?? 1) - 2) < 1e-9);
});

test("every annotation type declares a geometry version, held per type", () => {
  for (const type of ANNOTATION_TYPE_VALUES) {
    const version = geometryVersionForType(type);
    assert.ok(Number.isInteger(version) && version >= 1, `${type} has no geometry version`);
    assert.equal(version, GEOMETRY_VERSION_BY_ANNOTATION_TYPE[type]);
  }
});

test("the freehand path bound in code equals the one the generated validator enforces", () => {
  // The bound is stated twice — once in the schema, once in this module,
  // because `checkGeometryForType` also runs against rows already stored,
  // which never passed through the validator. The two must not drift.
  const point = { x: 0.5, y: 0.5 };
  const overlong: SchemaViolation[] = [];
  validateAnnotationGeometry(
    {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      path: Array.from({ length: FREEHAND_PATH_POINT_BOUNDS.maximum + 1 }, () => point),
    },
    "geometry",
    overlong,
  );
  assert.equal(overlong.length, 1, "the schema accepted a path this module refuses");

  const atBound: SchemaViolation[] = [];
  validateAnnotationGeometry(
    {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      path: Array.from({ length: FREEHAND_PATH_POINT_BOUNDS.maximum }, () => point),
    },
    "geometry",
    atBound,
  );
  assert.deepEqual(atBound, [], "the schema refuses a path this module accepts");
});
