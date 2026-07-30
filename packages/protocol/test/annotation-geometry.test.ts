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
  REQUIRED_GEOMETRY_MEMBERS,
  checkGeometryForType,
  containedContentRectangle,
  describeGeometry,
  isNormalisedCoordinate,
  toNormalisedPoint,
  toRenderedArrow,
  toRenderedBox,
  toRenderedPoint,
} from "../src/annotation-geometry.ts";
import { ANNOTATION_TYPE_VALUES } from "../src/generated/review/v1/types.ts";

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
