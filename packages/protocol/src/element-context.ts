/**
 * Resolving the element under an annotation (`docs/DOMAIN_MODEL.md` section
 * 17, ADR-0033).
 *
 * A human draws a mark over a picture. What makes that mark reproducible by an
 * agent is not the rectangle but the element the rectangle covers: "the
 * navigation looks wrong" becomes a specific `[data-testid=main-navigation]`
 * at a specific URL, viewport and scroll position.
 *
 * The resolution is **arithmetic over a snapshot already taken**, never a
 * second query into the page. Two reasons, and the second is the important
 * one:
 *
 *   - A page that has moved between the capture and the question would answer
 *     about a layout the human never saw.
 *   - Asking the page to identify an element is asking untrusted content to
 *     describe itself at the moment it is being reported. Reading a bounded
 *     snapshot that was captured with the screenshot keeps the page out of the
 *     loop entirely (ADR-0010).
 *
 * Everything this module returns except the strategy is page-derived, and the
 * caller MUST carry it onward with that label. `selector`, `role`,
 * `accessible_name` and `text_excerpt` are all things a page said about
 * itself; a hostile page can make any of them read like an instruction, and
 * the product's answer is that they are displayed as text and labelled, never
 * obeyed.
 *
 * Selectors are hints, not identity. A finding stays actionable when its
 * selector no longer resolves, which is why the geometry, the URL, the
 * viewport, the scroll position and the screenshot are all recorded beside it
 * rather than instead of it.
 *
 * This module holds no Node built-in and no DOM type: `apps/web` resolves
 * context in a browser and the unit tests run it under `node --test`.
 */

import { toRenderedBox } from "./annotation-geometry.ts";
import type {
  AnnotationGeometry,
  AnnotationType,
  ElementContext,
  ScrollPosition,
  Viewport,
} from "./generated/review/v1/types.ts";

/**
 * One candidate element, in the shape a browser snapshot reports
 * (`packages/protocol/schemas/browser/v1.schema.json` `$defs.element_descriptor`).
 *
 * It is structurally typed rather than imported from the browser protocol so
 * that the review entry point does not pull the browser one in, and so that
 * this rule can be exercised against a handful of literals in a unit test
 * rather than against a captured snapshot.
 */
export interface ElementCandidate {
  readonly ref: string;
  readonly role: string;
  readonly name?: string;
  readonly box?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly selector?: string;
  readonly selector_strategy?: ElementContext["selector_strategy"];
  readonly text_excerpt?: string;
  readonly dom_fingerprint?: string;
}

/** A box in the CSS pixels of the captured document. */
export interface DocumentBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where an annotation sits in the document's own CSS pixels.
 *
 * The conversion is the whole reason element resolution is possible without a
 * device pixel ratio anywhere in it. Geometry is normalised to the artefact
 * content rectangle; a viewport capture's content rectangle *is* the viewport
 * scaled by the device pixel ratio, so a normalised fraction multiplied by the
 * viewport's CSS width is the CSS offset inside the viewport, and adding the
 * scroll position makes it a document offset. The ratio cancels rather than
 * being divided out, which is what `docs/DOMAIN_MODEL.md` section 16 means by
 * converting once at the edge.
 */
export function annotationDocumentBox(
  type: AnnotationType,
  geometry: AnnotationGeometry,
  viewport: Pick<Viewport, "width" | "height">,
  scroll: ScrollPosition,
): DocumentBox {
  const inViewport = toRenderedBox(geometry, {
    x: 0,
    y: 0,
    width: viewport.width,
    height: viewport.height,
  });
  if (type === "arrow") {
    // An arrow points at its head. Its tail is where the reader's hand
    // started, which is deliberately somewhere else: resolving the element
    // under the tail would name whatever the annotator was avoiding.
    const head = {
      x: (geometry.x2 ?? geometry.x) * viewport.width,
      y: (geometry.y2 ?? geometry.y) * viewport.height,
    };
    return { x: head.x + scroll.x, y: head.y + scroll.y, width: 0, height: 0 };
  }
  return {
    x: inViewport.x + scroll.x,
    y: inViewport.y + scroll.y,
    width: inViewport.width,
    height: inViewport.height,
  };
}

/** The point a resolution is anchored on: the centre of the mark. */
function centreOf(box: DocumentBox): { readonly x: number; readonly y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function area(box: NonNullable<ElementCandidate["box"]>): number {
  return Math.max(box.width, 0) * Math.max(box.height, 0);
}

function contains(
  box: NonNullable<ElementCandidate["box"]>,
  point: { readonly x: number; readonly y: number },
): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}

/**
 * The best element under an annotation, or `null` when the snapshot names
 * none.
 *
 * "Best" is the **smallest** element whose box contains the centre of the
 * mark. A page is a stack of nested boxes, and the largest containing element
 * is nearly always `main` or `body` — true, useless, and confidently wrong as
 * a description of what the human circled. Ties are broken by snapshot order,
 * so the same snapshot and the same geometry always resolve to the same
 * element; a resolution that varied between two callers would be a worse
 * answer than no resolution at all.
 *
 * `null` is a normal outcome, not a failure. `docs/UX_FLOWS.md` section 9
 * calls element context best effort, and a finding whose geometry covers
 * whitespace has no element under it. The caller records the finding without
 * it rather than inventing one.
 */
export function resolveElementCandidate(
  type: AnnotationType,
  geometry: AnnotationGeometry,
  viewport: Pick<Viewport, "width" | "height">,
  scroll: ScrollPosition,
  candidates: readonly ElementCandidate[],
): ElementCandidate | null {
  const centre = centreOf(annotationDocumentBox(type, geometry, viewport, scroll));
  let best: ElementCandidate | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const box = candidate.box;
    if (box === undefined) continue;
    if (!contains(box, centre)) continue;
    const size = area(box);
    if (size < bestArea) {
      best = candidate;
      bestArea = size;
    }
  }
  return best;
}

/**
 * The element context to store for an annotation, or `null` when nothing was
 * resolved.
 *
 * Only members the snapshot actually carried are emitted. An absent member is
 * recorded as absent rather than as an empty string, because "the page had no
 * accessible name here" and "the page's accessible name was blank" are
 * different facts and a reader deciding whether an element is reachable needs
 * to be able to tell them apart.
 */
export function resolveElementContext(
  type: AnnotationType,
  geometry: AnnotationGeometry,
  viewport: Pick<Viewport, "width" | "height">,
  scroll: ScrollPosition,
  candidates: readonly ElementCandidate[],
): ElementContext | null {
  const element = resolveElementCandidate(type, geometry, viewport, scroll, candidates);
  if (element === null) return null;
  return {
    ...(element.selector === undefined ? {} : { selector: element.selector }),
    ...(element.selector_strategy === undefined
      ? {}
      : { selector_strategy: element.selector_strategy }),
    role: element.role,
    ...(element.name === undefined || element.name === ""
      ? {}
      : { accessible_name: element.name }),
    ...(element.text_excerpt === undefined || element.text_excerpt === ""
      ? {}
      : { text_excerpt: element.text_excerpt }),
    ...(element.box === undefined
      ? {}
      : {
          bounding_box_css_pixels: {
            x: element.box.x,
            y: element.box.y,
            width: element.box.width,
            height: element.box.height,
          },
        }),
    ...(element.dom_fingerprint === undefined
      ? {}
      : { dom_fingerprint: element.dom_fingerprint }),
  };
}

/**
 * The members of an element context that came from the page.
 *
 * Named here rather than at each display site so that a surface showing
 * element context has one list to consult, and so that a member added to the
 * schema without a decision about its provenance shows up as an omission from
 * this list rather than as an unlabelled value on a screen.
 *
 * `selector_strategy` is absent from the list on purpose: it is the control
 * plane's own classification of how the selector was picked, not something the
 * page said.
 */
export const PAGE_DERIVED_ELEMENT_CONTEXT_MEMBERS = [
  "selector",
  "role",
  "accessible_name",
  "text_excerpt",
  "bounding_box_css_pixels",
] as const;

/**
 * Whether an element context carries anything the page authored, and therefore
 * whether a surface presenting it MUST carry the untrusted label of ADR-0010.
 */
export function carriesPageDerivedText(context: ElementContext | null | undefined): boolean {
  if (context === null || context === undefined) return false;
  return PAGE_DERIVED_ELEMENT_CONTEXT_MEMBERS.some(
    (member) => (context as Record<string, unknown>)[member] !== undefined,
  );
}
