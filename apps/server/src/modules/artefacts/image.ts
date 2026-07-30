/**
 * What the bytes actually are, and how large the picture in them is.
 *
 * Two separate jobs, both of which the server must do itself.
 *
 * **Sniffing.** `docs/SECURITY.md` section 13 requires content-type
 * validation, and `docs/TESTING.md` section 10 requires a MIME mismatch and a
 * malicious SVG to be rejected. A declared content type is a claim by the
 * uploader; the magic bytes are evidence. An SVG or an HTML document uploaded
 * as `image/png` is refused here, before anything stores it, so no artefact
 * exists that a viewer could later be persuaded to render as active content.
 *
 * **Measuring.** Annotation geometry is normalised against the artefact
 * content rectangle (`docs/DOMAIN_MODEL.md` section 16), so the intrinsic
 * pixel extent has to be recorded with the artefact. Reading it from the
 * header is a few lines; taking it from the uploader would make the reference
 * frame something an uploader controls.
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
export type SniffedType = "image/png" | "image/jpeg" | "image/svg+xml" | "text/html" | "unknown";

/**
 * Identifies bytes from their leading bytes.
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
  // Markup detection looks at a bounded prefix, skipping whitespace and a
  // byte-order mark, which is exactly what a browser's own sniffing would do
  // with a file it was told is an image.
  const prefix = bytes
    .subarray(0, 1024)
    .toString("utf8")
    .replace(/^\uFEFF/u, "")
    .trimStart()
    .toLowerCase();
  if (prefix.startsWith("<?xml") || prefix.startsWith("<svg")) {
    return prefix.includes("<svg") ? "image/svg+xml" : "text/html";
  }
  if (prefix.startsWith("<!doctype html") || prefix.startsWith("<html") || prefix.startsWith("<")) {
    return "text/html";
  }
  return "unknown";
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
 * refused anyway: `docs/TESTING.md` section 10 asks for the case, and a stored
 * `../../etc/passwd` is a value some later exporter might join to a directory.
 */
export function isSafeFilenameLabel(label: string): boolean {
  if (label.length === 0 || label.length > 128) return false;
  if (!/^[A-Za-z0-9._-]+$/u.test(label)) return false;
  if (label.includes("..")) return false;
  if (label.startsWith(".")) return false;
  return true;
}
