/**
 * Element-context resolution (`docs/TESTING.md` section 2, ADR-0033).
 *
 * The failure this suite exists to catch is the confident wrong answer. A
 * page is a stack of nested boxes, and a resolver that takes the first or the
 * largest containing element answers `main` for every mark ever drawn — true,
 * useless, and indistinguishable from a working implementation unless a test
 * puts a small element inside a large one and insists on the small one.
 *
 * The second failure is a coordinate-frame mistake. Geometry is normalised to
 * the artefact content rectangle and element boxes are in the document's CSS
 * pixels, so a resolver that forgot the scroll position, or that divided by the
 * device pixel ratio somewhere, resolves a mark near the top of a scrolled page
 * to whatever sits near the top of the document. Both are asserted directly.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  annotationDocumentBox,
  carriesPageDerivedText,
  resolveElementCandidate,
  resolveElementContext,
  type ElementCandidate,
} from "../src/element-context.ts";

/** The 390x844 preset of `AGENTS.md`, at a device pixel ratio of 2. */
const MOBILE = { width: 390, height: 844 };
const UNSCROLLED = { x: 0, y: 0 };

/**
 * A page whose navigation sits inside its banner, which sits inside the
 * document. Every resolution below has three correct-looking answers and one
 * useful one.
 */
const PAGE: readonly ElementCandidate[] = [
  { ref: "e1", role: "main", name: "Homepage", box: { x: 0, y: 0, width: 390, height: 2400 } },
  { ref: "e2", role: "banner", name: "Header", box: { x: 0, y: 0, width: 390, height: 120 } },
  {
    ref: "e3",
    role: "navigation",
    name: "Main navigation",
    box: { x: 8, y: 16, width: 300, height: 60 },
    selector: "[data-testid=main-navigation]",
    selector_strategy: "testid",
    text_excerpt: "Shop Sell About",
    dom_fingerprint: "a".repeat(64),
  },
  {
    ref: "e4",
    role: "button",
    name: "Basket",
    box: { x: 320, y: 24, width: 56, height: 40 },
    selector: "[data-testid=basket]",
    selector_strategy: "testid",
  },
];

test("the smallest element under the mark wins, not the first or the largest", () => {
  // A rectangle over the navigation. `main` and `banner` both contain it.
  const resolved = resolveElementCandidate(
    "rectangle",
    { x: 0.03, y: 0.03, width: 0.7, height: 0.05 },
    MOBILE,
    UNSCROLLED,
    PAGE,
  );
  assert.equal(resolved?.ref, "e3", "the resolver named an ancestor rather than the element");
});

test("a mark over a sibling resolves to that sibling and not to its neighbour", () => {
  const resolved = resolveElementCandidate(
    "point",
    { x: 0.89, y: 0.05 },
    MOBILE,
    UNSCROLLED,
    PAGE,
  );
  assert.equal(resolved?.ref, "e4");
});

test("nothing under the mark resolves to nothing rather than to the page", () => {
  // Far down the document, where only `main` reaches — and `main` has no
  // selector, so naming it would be a worse answer than naming none.
  const resolved = resolveElementCandidate(
    "point",
    { x: 0.5, y: 0.99 },
    MOBILE,
    { x: 0, y: 1400 },
    PAGE.filter((element) => element.ref !== "e1"),
  );
  assert.equal(resolved, null);
  assert.equal(
    resolveElementContext("point", { x: 0.5, y: 0.99 }, MOBILE, { x: 0, y: 1400 }, []),
    null,
  );
});

test("the scroll position is part of the frame, not an afterthought", () => {
  const geometry = { x: 0.05, y: 0.05 };
  // Unscrolled, the mark is over the navigation.
  assert.equal(
    resolveElementCandidate("point", geometry, MOBILE, UNSCROLLED, PAGE)?.ref,
    "e3",
  );
  // The same mark on a page scrolled past the header is over `main` alone. A
  // resolver that ignored the scroll would still answer "navigation" here.
  assert.equal(
    resolveElementCandidate("point", geometry, MOBILE, { x: 0, y: 900 }, PAGE)?.ref,
    "e1",
  );
});

test("a normalised mark converts to document pixels without a device pixel ratio", () => {
  // The same page captured at a ratio of 1 and of 2 has content rectangles of
  // 390x844 and 780x1688 device pixels. Geometry is normalised against each,
  // so the document box is identical — the ratio cancels rather than being
  // divided out somewhere.
  const box = annotationDocumentBox(
    "rectangle",
    { x: 0.5, y: 0.25, width: 0.25, height: 0.1 },
    MOBILE,
    { x: 0, y: 200 },
  );
  assert.deepEqual(box, { x: 195, y: 411, width: 97.5, height: 84.4 });
});

test("an arrow resolves to what its head points at, never to its tail", () => {
  // Tail in open space at the bottom left, head on the basket button.
  const resolved = resolveElementCandidate(
    "arrow",
    { x: 0.1, y: 0.9, x2: 0.89, y2: 0.05 },
    MOBILE,
    UNSCROLLED,
    PAGE,
  );
  assert.equal(resolved?.ref, "e4", "the arrow resolved to the region it was drawn away from");
});

test("resolution is deterministic when two candidates are the same size", () => {
  const tied: readonly ElementCandidate[] = [
    { ref: "e1", role: "button", box: { x: 0, y: 0, width: 100, height: 100 } },
    { ref: "e2", role: "link", box: { x: 0, y: 0, width: 100, height: 100 } },
  ];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    assert.equal(
      resolveElementCandidate("point", { x: 0.1, y: 0.05 }, MOBILE, UNSCROLLED, tied)?.ref,
      "e1",
      "a tie resolved differently between two identical calls",
    );
  }
});

test("only the members the page actually reported are stored", () => {
  const context = resolveElementContext(
    "rectangle",
    { x: 0.03, y: 0.03, width: 0.7, height: 0.05 },
    MOBILE,
    UNSCROLLED,
    PAGE,
  );
  assert.deepEqual(context, {
    selector: "[data-testid=main-navigation]",
    selector_strategy: "testid",
    role: "navigation",
    accessible_name: "Main navigation",
    text_excerpt: "Shop Sell About",
    bounding_box_css_pixels: { x: 8, y: 16, width: 300, height: 60 },
    dom_fingerprint: "a".repeat(64),
  });

  // An element the snapshot described less fully stores less, rather than
  // storing empty strings that a reader could not tell from real blanks.
  const sparse = resolveElementContext("point", { x: 0.89, y: 0.05 }, MOBILE, UNSCROLLED, PAGE);
  assert.equal(sparse?.text_excerpt, undefined);
  assert.equal(sparse?.dom_fingerprint, undefined);
  assert.equal(sparse?.role, "button");
});

test("an element context carrying page-derived text says so", () => {
  const context = resolveElementContext(
    "rectangle",
    { x: 0.03, y: 0.03, width: 0.7, height: 0.05 },
    MOBILE,
    UNSCROLLED,
    PAGE,
  );
  assert.equal(carriesPageDerivedText(context), true);
  assert.equal(carriesPageDerivedText(null), false);
  assert.equal(carriesPageDerivedText({}), false);
  // The strategy is the control plane's own classification of how it picked a
  // selector, so it alone does not make a context page-derived.
  assert.equal(carriesPageDerivedText({ selector_strategy: "css" }), false);
});

test("a candidate with no measured box is never resolved to", () => {
  const unmeasured: readonly ElementCandidate[] = [
    { ref: "e1", role: "button", name: "Somewhere" },
  ];
  assert.equal(
    resolveElementCandidate("point", { x: 0.5, y: 0.5 }, MOBILE, UNSCROLLED, unmeasured),
    null,
    "an element whose position is unknown was placed under the mark anyway",
  );
});
