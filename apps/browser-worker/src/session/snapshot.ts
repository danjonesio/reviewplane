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

import type { ElementHandle, JSHandle, Page } from "playwright-core";

import type { ElementDescriptor, Viewport } from "@reviewplane/protocol/browser";

import { sanitisePageText } from "./untrusted.ts";

/** One element as the browser reported it, before sanitisation. */
interface RawElement {
  readonly index: number;
  readonly depth: number;
  readonly role: string;
  readonly name: string;
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
    raw.push({
      index: elements.length,
      depth: depthOf(candidate),
      role,
      name: nameOf(candidate),
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
    return {
      ref: referenceFor(element.index),
      role: sanitisePageText(element.role, 64) || "generic",
      ...(name === "" ? {} : { name }),
    };
  });

  const lines = descriptors.map((descriptor, index) =>
    renderLine(descriptor, raw.elements[index]?.depth ?? 0),
  );
  const bounded = boundLines(lines, bounds.maxBytes);

  return {
    id,
    viewport,
    text: bounded.text,
    elements: descriptors.slice(0, bounded.kept),
    truncated: raw.truncated || bounded.truncated,
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
