/**
 * Sanitisers for page-derived values.
 *
 * ADR-0010 makes every browser-derived string untrusted. Two separate things
 * follow, and this module is responsible for the second:
 *
 * 1. the value is labelled, so an agent never treats it as an instruction —
 *    the protocol schema enforces that;
 * 2. the value is made safe to put on the wire and into a log at all. A page
 *    controls the length and the byte content of its own title, link text and
 *    accessible names, so it controls what a naive worker would emit. Control
 *    characters are removed, whitespace is collapsed and the result is
 *    truncated, before any protocol validator sees it.
 *
 * Truncation is visible: a shortened value ends in a single ellipsis rather
 * than silently losing its tail.
 */

/** Longest page-derived label the protocol accepts (`page_text`). */
export const MAX_PAGE_TEXT = 512;

// The control characters are the point of this module: matching them is how
// they are removed from page-derived text.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/gu;
const WHITESPACE_RUN = /\s+/gu;

/**
 * Renders one page-derived label: no control characters, no newlines, no runs
 * of whitespace, bounded length.
 */
export function sanitisePageText(value: unknown, maximum = MAX_PAGE_TEXT): string {
  if (typeof value !== "string") return "";
  const flattened = value.replace(CONTROL_CHARACTERS, " ").replace(WHITESPACE_RUN, " ").trim();
  if (flattened.length <= maximum) return flattened;
  return `${flattened.slice(0, Math.max(0, maximum - 1))}…`;
}

/**
 * Renders multi-line page-derived text such as a rendered snapshot: newlines
 * survive, every other control character does not.
 */
export function sanitiseMultilineText(value: string): string {
  return value
    .split("\n")
    .map((line) => line.replace(CONTROL_CHARACTERS, " ").replace(/[^\S\n]+/gu, " ").trimEnd())
    .join("\n");
}

/**
 * Renders a page-derived URL. A URL is bounded and printable-ASCII on the
 * wire, so a non-ASCII or oversized location is percent-encoded and truncated
 * rather than rejected, which would lose the navigation result entirely.
 */
export function sanitiseUrl(value: string, maximum = 2048): string {
  let encoded: string;
  try {
    encoded = encodeURI(value);
  } catch {
    encoded = encodeURIComponent(value);
  }
  const printable = encoded.replace(/[^!-~]/gu, "");
  if (printable === "") return "about:blank";
  return printable.length <= maximum ? printable : printable.slice(0, maximum);
}
