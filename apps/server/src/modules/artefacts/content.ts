/**
 * What the bytes actually are, and how large the picture in them is.
 *
 * Two separate jobs, both of which the server must do itself.
 *
 * **Sniffing.** `docs/SECURITY.md` §13 requires content-type validation, and
 * `docs/TESTING.md` §10 requires a MIME mismatch and a malicious SVG to be
 * rejected. A declared content type is a claim by the uploader; the bytes are
 * the evidence. An SVG or an HTML document uploaded as `image/png` is refused
 * here, before anything stores it, so no artefact exists that a viewer could
 * later be persuaded to render as active content — and the reverse direction is
 * refused too, so a PNG cannot be filed as a DOM snapshot and reach the
 * attachment path with an image inside it.
 *
 * Sniffing is not the same operation for every type. An image has a signature;
 * JSON does not. So the check is "do these bytes satisfy the declared type",
 * per type, rather than "which single type are these bytes" — the second
 * question has no answer for a text format, and pretending it does is how a
 * validator ends up accepting anything that is not a PNG.
 *
 * **Measuring.** Annotation geometry is normalised against the artefact content
 * rectangle (`docs/DOMAIN_MODEL.md` §16), so the intrinsic pixel extent has to
 * be recorded with the artefact. Reading it from the header is a few lines;
 * taking it from the uploader would make the reference frame something an
 * uploader controls.
 *
 * The parsers read headers only and never decode pixels: a decoder is a large
 * attack surface for an untrusted input, and nothing here needs one.
 */

export interface ImageDimensions {
  readonly widthPx: number;
  readonly heightPx: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Media types whose bytes this module can recognise. */
export type SniffedType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "image/svg+xml"
  | "text/html"
  | "unknown";

/**
 * Identifies bytes from their leading bytes, where they have a signature.
 *
 * SVG and HTML are recognised explicitly rather than falling into `unknown`,
 * because the refusal they produce should say what was actually uploaded. An
 * operator reading "an SVG document was uploaded as image/png" learns
 * something; "unsupported content" does not.
 */
export function sniffContentType(bytes: Buffer): SniffedType {
  if (bytes.byteLength >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.byteLength >= 6 && bytes.subarray(0, 6).toString("latin1").startsWith("GIF8")) {
    return "image/gif";
  }
  if (
    bytes.byteLength >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  // Markup detection looks at a bounded prefix, skipping whitespace and a
  // byte-order mark, which is exactly what a browser's own sniffing would do
  // with a file it was told is an image.
  const prefix = markupPrefix(bytes);
  if (prefix.startsWith("<?xml") || prefix.startsWith("<svg")) {
    return prefix.includes("<svg") ? "image/svg+xml" : "text/html";
  }
  if (prefix.startsWith("<!doctype html") || prefix.startsWith("<html") || prefix.startsWith("<")) {
    return "text/html";
  }
  return "unknown";
}

/** A bounded, normalised prefix, as a sniffing browser would read one. */
function markupPrefix(bytes: Buffer): string {
  return bytes
    .subarray(0, 1024)
    .toString("utf8")
    .replace(/^\uFEFF/u, "")
    .trimStart()
    .toLowerCase();
}

/**
 * Whether the bytes satisfy the declared media type, and why not when they do
 * not.
 *
 * The message names what was actually uploaded wherever the bytes say so,
 * because a refusal an operator can act on is the difference between a
 * mislabelled capture that gets fixed and one that gets retried unchanged.
 */
export function contentTypeMismatch(declared: string, bytes: Buffer): string | null {
  const sniffed = sniffContentType(bytes);
  switch (declared) {
    case "image/png":
    case "image/jpeg":
      return sniffed === declared
        ? null
        : `The uploaded bytes are ${sniffed}, not the declared ${declared}.`;
    case "text/html":
      // A DOM snapshot is markup. An image filed as one would reach the
      // attachment path carrying something a browser renders on sight.
      if (sniffed !== "text/html" && sniffed !== "unknown") {
        return `The uploaded bytes are ${sniffed}, not the declared text/html.`;
      }
      if (!markupPrefix(bytes).startsWith("<")) {
        return "The uploaded bytes are not an HTML document: a DOM snapshot must begin with markup.";
      }
      return validUtf8(bytes) ? null : "The uploaded HTML is not valid UTF-8.";
    case "application/json":
      if (sniffed !== "unknown") {
        return `The uploaded bytes are ${sniffed}, not the declared application/json.`;
      }
      if (!validUtf8(bytes)) return "The uploaded JSON is not valid UTF-8.";
      try {
        JSON.parse(bytes.toString("utf8"));
        return null;
      } catch {
        return "The uploaded bytes are not valid JSON.";
      }
    case "text/plain":
      if (sniffed !== "unknown") {
        return `The uploaded bytes are ${sniffed}, not the declared text/plain.`;
      }
      if (!validUtf8(bytes)) return "The uploaded text is not valid UTF-8.";
      // A plain-text artefact that begins with markup is a document a sniffing
      // browser would treat as HTML, whatever the declared type says.
      return markupPrefix(bytes).startsWith("<")
        ? "The uploaded text begins with markup and would be sniffed as a document, not as text."
        : null;
    default:
      return `${declared} is not a media type this artefact store accepts.`;
  }
}

/**
 * Whether a byte string is valid UTF-8.
 *
 * `Buffer.toString("utf8")` substitutes U+FFFD for an invalid sequence rather
 * than failing, so the round trip is the check: bytes that survive it are the
 * bytes that were sent.
 */
function validUtf8(bytes: Buffer): boolean {
  return Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes);
}

/**
 * Intrinsic size of a PNG, from its IHDR chunk.
 *
 * The IHDR is required by the format to be the first chunk, so a file whose
 * first chunk is something else is malformed rather than merely unusual.
 */
function pngDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.byteLength < 24) return null;
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (bytes.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  const widthPx = bytes.readUInt32BE(16);
  const heightPx = bytes.readUInt32BE(20);
  if (widthPx === 0 || heightPx === 0) return null;
  return { widthPx, heightPx };
}

/** Intrinsic size of a JPEG, from the first start-of-frame marker. */
function jpegDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] as number;
    // Padding and standalone markers carry no length.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      const heightPx = bytes.readUInt16BE(offset + 5);
      const widthPx = bytes.readUInt16BE(offset + 7);
      if (widthPx === 0 || heightPx === 0) return null;
      return { widthPx, heightPx };
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/**
 * The artefact content rectangle for image bytes, or null when the bytes are
 * not an image this build measures. A null result on an image content type is
 * a verification failure, not a missing optional value.
 */
export function measureImage(contentType: string, bytes: Buffer): ImageDimensions | null {
  if (contentType === "image/png") return pngDimensions(bytes);
  if (contentType === "image/jpeg") return jpegDimensions(bytes);
  return null;
}

/**
 * Whether a display filename is a name rather than a path.
 *
 * The storage key is content-addressed and never contains this value
 * (ADR-0012), so traversal through it is structurally impossible. It is
 * refused anyway: `docs/TESTING.md` §10 asks for the case, and a stored
 * `../../etc/passwd` is a value some later exporter might join to a directory.
 *
 * The rules are the `filename_label` schema's, plus the doubled-dot rule the
 * schema's pattern deliberately leaves to code because a negative lookahead is
 * not portable to every language `packages/protocol` generates.
 */
export function isSafeFilenameLabel(label: string): boolean {
  if (label.length === 0 || label.length > 128) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(label)) return false;
  return !label.includes("..");
}
