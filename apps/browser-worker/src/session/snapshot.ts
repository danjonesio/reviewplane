/**
 * Bounded accessibility-oriented snapshots.
 *
 * `docs/MCP_SPEC.md` section 7.4 fixes the rendered shape and states that
 * element references are stable for the current snapshot only; section 13 and
 * `docs/DEVELOPMENT.md` section 9 require the output to be bounded, a summary
 * rather than a whole-page dump.
 *
 * References resolve through Playwright handles held in this process, never
 * through a marker written into the page and never through a global the page
 * can reach. A hostile page therefore cannot re-point a reference between the
 * snapshot and the click: it can detach the node, which makes the interaction
 * fail, and that is the required outcome — "acting on a stale reference MUST
 * fail rather than click whatever now occupies that index".
 */

import { createHash } from "node:crypto";

import type { ElementHandle, JSHandle, Page } from "playwright-core";

import type { ElementDescriptor, Viewport } from "@reviewplane/protocol/browser";

import { sanitisePageText, sanitiseSelector } from "./untrusted.ts";

/** The bound `element_box` places on a CSS-pixel measurement. */
const MAX_ELEMENT_OFFSET = 100_000;

/**
 * An element box the protocol will accept, or `null`.
 *
 * A page controls its own layout, so it controls these numbers. One outside
 * the schema's range is dropped rather than clamped, for the same reason an
 * out-of-range annotation coordinate is refused rather than clamped: a clamped
 * box would place an element somewhere plausible and wrong, and a resolver
 * would then confidently name it as the element under a mark.
 */
export function boundedBox(
  box: { x: number; y: number; width: number; height: number } | null,
): { x: number; y: number; width: number; height: number } | null {
  if (box === null) return null;
  const rounded = {
    x: Math.round(box.x * 10) / 10,
    y: Math.round(box.y * 10) / 10,
    width: Math.round(box.width * 10) / 10,
    height: Math.round(box.height * 10) / 10,
  };
  for (const value of Object.values(rounded)) {
    if (!Number.isFinite(value) || Math.abs(value) > MAX_ELEMENT_OFFSET) return null;
  }
  if (rounded.width < 0 || rounded.height < 0) return null;
  return rounded;
}

/** One element as the browser reported it, before sanitisation. */
interface RawElement {
  readonly index: number;
  readonly depth: number;
  readonly role: string;
  readonly name: string;
  /**
   * Where the element was laid out, in the document's own CSS pixels rather
   * than the viewport's, so that an annotation drawn over a scrolled page
   * resolves against a frame that does not move when the page does.
   */
  readonly box: { x: number; y: number; width: number; height: number } | null;
  readonly selector: string;
  readonly selectorStrategy: "testid" | "role" | "text" | "css" | "xpath" | null;
  readonly textExcerpt: string;
  /**
   * The element's structural position — tags and ordinals, never its text — as
   * a string the worker digests. It is computed here because only the page has
   * the ancestry, and digested outside because `crypto.subtle` is asynchronous
   * and this function must stay a single synchronous walk.
   */
  readonly structure: string;
}

interface RawSnapshot {
  readonly elements: readonly RawElement[];
  /** True when the page held more elements than `maxNodes` allowed. */
  readonly truncated: boolean;
  readonly considered: number;
}

/** A snapshot and the handles its references resolve through. */
export interface Snapshot {
  readonly id: string;
  readonly viewport: Viewport;
  readonly text: string;
  readonly elements: readonly ElementDescriptor[];
  readonly truncated: boolean;
  /** Page-world array of the elements, in reference order. */
  readonly handle: JSHandle<Element[]>;
}

export interface SnapshotBounds {
  readonly maxNodes: number;
  readonly maxBytes: number;
}

/**
 * Collects candidate elements in document order with an approximate ARIA role
 * and accessible name.
 *
 * This runs in the page and must therefore assume nothing about the page: it
 * touches no page state, defines no global and returns a plain array plus one
 * handle array. It is deliberately an approximation of the accessibility tree
 * rather than a reimplementation of name computation — `docs/MCP_SPEC.md`
 * section 7.4 calls the result "accessibility-oriented", and a snapshot is a
 * navigation aid whose references are resolved against real nodes.
 */
/* c8 ignore start -- executed inside the browser, covered by the browser suite */
function collectElements(maxNodes: number): { elements: Element[]; raw: RawSnapshot } {
  const ROLE_BY_TAG: Record<string, string> = {
    A: "link",
    BUTTON: "button",
    NAV: "navigation",
    HEADER: "banner",
    FOOTER: "contentinfo",
    MAIN: "main",
    ASIDE: "complementary",
    FORM: "form",
    SEARCH: "search",
    SECTION: "region",
    ARTICLE: "article",
    H1: "heading",
    H2: "heading",
    H3: "heading",
    H4: "heading",
    H5: "heading",
    H6: "heading",
    IMG: "img",
    UL: "list",
    OL: "list",
    LI: "listitem",
    TABLE: "table",
    SELECT: "combobox",
    TEXTAREA: "textbox",
    LABEL: "label",
    DIALOG: "dialog",
    SUMMARY: "button",
  };
  const INPUT_ROLES: Record<string, string> = {
    button: "button",
    submit: "button",
    reset: "button",
    checkbox: "checkbox",
    radio: "radio",
    range: "slider",
    file: "button",
    image: "button",
  };

  const roleOf = (element: Element): string | null => {
    const explicit = element.getAttribute("role");
    if (explicit !== null && /^[A-Za-z][A-Za-z0-9 _-]*$/.test(explicit)) return explicit;
    if (element.tagName === "INPUT") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      return INPUT_ROLES[type] ?? "textbox";
    }
    return ROLE_BY_TAG[element.tagName] ?? null;
  };

  const nameOf = (element: Element): string => {
    const labelled = element.getAttribute("aria-label");
    if (labelled !== null && labelled.trim() !== "") return labelled;
    const alt = element.getAttribute("alt");
    if (alt !== null && alt.trim() !== "") return alt;
    const title = element.getAttribute("title");
    if (title !== null && title.trim() !== "") return title;
    const placeholder = element.getAttribute("placeholder");
    if (placeholder !== null && placeholder.trim() !== "") return placeholder;
    const value = (element as HTMLInputElement).value;
    if (typeof value === "string" && value.trim() !== "" && element.tagName === "INPUT") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (type === "button" || type === "submit" || type === "reset") return value;
    }
    // Only leaf-ish text is used, so a container does not inherit the whole
    // page as its name and a nested landmark is not described three times.
    const NAMED_BY_CONTENT = new Set([
      "A",
      "BUTTON",
      "SUMMARY",
      "LABEL",
      "H1",
      "H2",
      "H3",
      "H4",
      "H5",
      "H6",
      "LI",
    ]);
    if (!NAMED_BY_CONTENT.has(element.tagName) && element.childElementCount > 0) return "";
    const text = element.textContent ?? "";
    return text.length > 2048 ? text.slice(0, 2048) : text;
  };

  // `checkVisibility` is one call into the engine rather than a computed-style
  // read plus a layout read for every candidate, which matters on a page with
  // thousands of elements: the walk is the worker's time, not the page's.
  const visible = (element: Element): boolean => {
    if (element.getAttribute("aria-hidden") === "true") return false;
    const check = (element as Element & { checkVisibility?: (options?: unknown) => boolean })
      .checkVisibility;
    if (typeof check === "function") {
      return check.call(element, { contentVisibilityAuto: true, visibilityProperty: true });
    }
    const rectangle = element.getBoundingClientRect();
    return rectangle.width > 0 || rectangle.height > 0;
  };

  // Only a value that can be written unquoted is offered as a selector. A
  // page that names a test identifier with a bracket or a quotation mark is
  // not given a selector at all rather than one that would need escaping
  // rules a reader has to know before pasting it.
  const PLAIN_TOKEN = /^[A-Za-z][A-Za-z0-9_.:-]*$/;
  const TESTID_ATTRIBUTES = ["data-testid", "data-test-id", "data-test", "data-qa"];

  /**
   * A selector for the element, strongest strategy first.
   *
   * The order is the order in which a selector survives a redesign. A test
   * identifier is put there for this purpose and outlives layout changes; an
   * element identifier usually does; a role and an accessible name survive a
   * restructure that keeps the semantics; a positional CSS path survives
   * almost nothing, which is exactly why the strategy travels beside the
   * selector rather than being left for a reader to infer.
   */
  const selectorOf = (
    element: Element,
    role: string,
    name: string,
  ): { selector: string; strategy: "testid" | "role" | "text" | "css" | null } => {
    for (const attribute of TESTID_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value !== null && PLAIN_TOKEN.test(value)) {
        return { selector: `[${attribute}=${value}]`, strategy: "testid" };
      }
    }
    const id = element.getAttribute("id");
    if (id !== null && PLAIN_TOKEN.test(id)) return { selector: `#${id}`, strategy: "css" };
    if (name !== "" && name.length <= 128 && !/[<>"[\]]/.test(name)) {
      return { selector: `role=${role}[name=${name}]`, strategy: "role" };
    }
    // A positional path. `>` is deliberately not used: the protocol's selector
    // bound excludes angle brackets, and a descendant combinator names the
    // same element for a reader pasting it into a console.
    const parts: string[] = [];
    let cursor: Element | null = element;
    while (cursor !== null && cursor !== document.body && parts.length < 8) {
      const parent: Element | null = cursor.parentElement;
      if (parent === null) break;
      const tag = cursor.tagName.toLowerCase();
      const siblings = Array.from(parent.children).filter((child) => child.tagName === cursor?.tagName);
      const ordinal = siblings.indexOf(cursor) + 1;
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${String(ordinal)})` : tag);
      cursor = parent;
    }
    if (parts.length === 0) return { selector: "", strategy: null };
    return { selector: `body ${parts.join(" ")}`, strategy: "css" };
  };

  /**
   * The element's structural position, excluding every value the page can
   * change without restructuring itself.
   *
   * Text is deliberately absent: editing a label is not a structural change,
   * and a fingerprint that moved when a heading was reworded would report a
   * changed DOM on every copy edit, which is the fastest way to make the
   * signal ignored.
   */
  const structureOf = (element: Element): string => {
    const parts: string[] = [];
    let cursor: Element | null = element;
    while (cursor !== null && parts.length < 16) {
      const parent: Element | null = cursor.parentElement;
      const ordinal =
        parent === null ? 0 : Array.from(parent.children).indexOf(cursor) + 1;
      const id = cursor.getAttribute("id") ?? "";
      parts.unshift(`${cursor.tagName}[${String(ordinal)}]${id === "" ? "" : `#${id}`}`);
      cursor = parent;
    }
    return parts.join("/");
  };

  /** The element's own text, excluding the text of nested elements. */
  const ownTextOf = (element: Element): string => {
    let text = "";
    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType === 3) text += node.nodeValue ?? "";
      if (text.length > 1024) break;
    }
    return text;
  };

  // Depth is memoised per element, so an ancestor chain is walked once for a
  // subtree rather than once for every element in it.
  const depths = new Map<Element, number>();
  const depthOf = (element: Element): number => {
    const parent = element.parentElement;
    if (parent === null) return 0;
    const cached = depths.get(parent);
    if (cached !== undefined) return cached;
    const parentDepth = depthOf(parent) + (roleOf(parent) === null ? 0 : 1);
    depths.set(parent, parentDepth);
    return parentDepth;
  };

  const elements: Element[] = [];
  const raw: RawElement[] = [];
  let considered = 0;
  let truncated = false;

  // A page controls how many elements it has, so the walk itself is bounded
  // rather than only its output: a page with a million nodes must not be able
  // to hold the worker in one command.
  const MAX_CANDIDATES = 20000;
  const candidates = document.body === null ? [] : Array.from(document.body.querySelectorAll("*"));
  for (const candidate of candidates) {
    if (considered >= MAX_CANDIDATES) {
      truncated = true;
      break;
    }
    const role = roleOf(candidate);
    if (role === null) continue;
    if (!visible(candidate)) continue;
    considered += 1;
    if (elements.length >= maxNodes) {
      truncated = true;
      continue;
    }
    const name = nameOf(candidate);
    const rectangle = candidate.getBoundingClientRect();
    const chosen = selectorOf(candidate, role, name);
    raw.push({
      index: elements.length,
      depth: depthOf(candidate),
      role,
      name,
      // Viewport coordinates plus the scroll offset are document coordinates.
      // The conversion happens here because only the page knows how far it is
      // scrolled at the moment the snapshot is taken.
      box: {
        x: rectangle.left + globalThis.scrollX,
        y: rectangle.top + globalThis.scrollY,
        width: rectangle.width,
        height: rectangle.height,
      },
      selector: chosen.selector,
      selectorStrategy: chosen.strategy,
      textExcerpt: ownTextOf(candidate),
      structure: structureOf(candidate),
    });
    elements.push(candidate);
  }

  return { elements, raw: { elements: raw, truncated, considered } };
}
/* c8 ignore stop */

/** Renders one snapshot line in the `docs/MCP_SPEC.md` section 7.4 shape. */
export function renderLine(descriptor: ElementDescriptor, depth: number): string {
  const indent = "  ".repeat(Math.min(depth, 12));
  const name = descriptor.name ?? "";
  const label = name === "" ? "" : ` ${JSON.stringify(name)}`;
  return `${indent}- ${descriptor.role}${label} [ref=${descriptor.ref}]`;
}

/**
 * Applies the byte bound to rendered lines. Truncation drops whole lines from
 * the end and records that it happened, so the caller never returns a partial
 * line that reads as complete.
 */
export function boundLines(
  lines: readonly string[],
  maxBytes: number,
): { text: string; kept: number; truncated: boolean } {
  const encoder = new TextEncoder();
  const notice = "\n- … snapshot truncated";
  const noticeBytes = encoder.encode(notice).length;
  let total = 0;
  const kept: string[] = [];
  for (const line of lines) {
    const size = encoder.encode(kept.length === 0 ? line : `\n${line}`).length;
    if (total + size + noticeBytes > maxBytes) {
      return { text: `${kept.join("\n")}${notice}`, kept: kept.length, truncated: true };
    }
    total += size;
    kept.push(line);
  }
  return { text: kept.join("\n"), kept: kept.length, truncated: false };
}

/**
 * Byte budget for the machine-readable element array.
 *
 * The rendered text has its own bound and the node count has another, but
 * neither bounds this array: a page chooses its own selectors, accessible
 * names and text, so four hundred elements each carrying the maximum of every
 * page-derived member would be about half a megabyte — twice the protocol's
 * whole control frame. The budget sits well inside `max_control_frame_bytes`
 * (262144) with the rendered snapshot's 32768 and the rest of the result
 * beside it.
 */
export const MAX_ELEMENT_ARRAY_BYTES = 131072;

/**
 * Applies that budget, dropping whole descriptors from the end.
 *
 * Truncating from the end keeps the array a prefix of the handle array, which
 * is what makes a reference still resolve to the element it named: dropping
 * from the middle would renumber every reference after the gap and silently
 * repoint them at other elements.
 */
export function boundDescriptors(
  descriptors: readonly ElementDescriptor[],
  maxBytes: number = MAX_ELEMENT_ARRAY_BYTES,
): { kept: readonly ElementDescriptor[]; truncated: boolean } {
  const encoder = new TextEncoder();
  let total = 2;
  for (const [index, descriptor] of descriptors.entries()) {
    total += encoder.encode(JSON.stringify(descriptor)).length + 1;
    if (total > maxBytes) return { kept: descriptors.slice(0, index), truncated: true };
  }
  return { kept: descriptors, truncated: false };
}

/** Reference issued for the element at `index` of a snapshot. */
export function referenceFor(index: number): string {
  return `e${String(index + 1)}`;
}

/** Index a reference addresses, or `null` when it is not a reference at all. */
export function indexOfReference(reference: string): number | null {
  const match = /^e([0-9]{1,6})$/u.exec(reference);
  if (match === null) return null;
  const ordinal = Number(match[1]);
  if (ordinal < 1) return null;
  return ordinal - 1;
}

/**
 * Captures one snapshot. The returned handle is owned by the caller and must
 * be disposed when the snapshot is superseded, which is what invalidates its
 * references.
 */
export async function captureSnapshot(
  page: Page,
  id: string,
  viewport: Viewport,
  bounds: SnapshotBounds,
): Promise<Snapshot> {
  const collected = await page.evaluateHandle(collectElements, bounds.maxNodes);
  let raw: RawSnapshot;
  let handle: JSHandle<Element[]>;
  try {
    raw = (await collected.evaluate((value) => value.raw)) as RawSnapshot;
    handle = (await collected.getProperty("elements")) as JSHandle<Element[]>;
  } finally {
    // The wrapper object has served its purpose; only the element array is
    // retained, and leaving the wrapper alive would pin a page-world object
    // for every snapshot ever taken in this session.
    await collected.dispose().catch(() => undefined);
  }

  const descriptors: ElementDescriptor[] = raw.elements.map((element) => {
    const name = sanitisePageText(element.name, 256);
    const selector = sanitiseSelector(element.selector);
    const excerpt = sanitisePageText(element.textExcerpt, 256);
    const box = boundedBox(element.box);
    return {
      ref: referenceFor(element.index),
      role: sanitisePageText(element.role, 64) || "generic",
      ...(name === "" ? {} : { name }),
      ...(box === null ? {} : { box }),
      ...(selector === "" || element.selectorStrategy === null
        ? {}
        : { selector, selector_strategy: element.selectorStrategy }),
      ...(excerpt === "" ? {} : { text_excerpt: excerpt }),
      ...(element.structure === ""
        ? {}
        : { dom_fingerprint: createHash("sha256").update(element.structure).digest("hex") }),
    } as ElementDescriptor;
  });

  const lines = descriptors.map((descriptor, index) =>
    renderLine(descriptor, raw.elements[index]?.depth ?? 0),
  );
  const bounded = boundLines(lines, bounds.maxBytes);
  const kept = boundDescriptors(descriptors.slice(0, bounded.kept));

  return {
    id,
    viewport,
    text: bounded.text,
    elements: kept.kept,
    truncated: raw.truncated || bounded.truncated || kept.truncated,
    handle,
  };
}

/** Resolves a reference to a live element handle, or `null` if it cannot. */
export async function resolveReference(
  snapshot: Snapshot,
  reference: string,
): Promise<ElementHandle<Element> | null> {
  const index = indexOfReference(reference);
  if (index === null || index >= snapshot.elements.length) return null;
  const property = await snapshot.handle.getProperty(String(index));
  const element = property.asElement();
  return element as ElementHandle<Element> | null;
}
