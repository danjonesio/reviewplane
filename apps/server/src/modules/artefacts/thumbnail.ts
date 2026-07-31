/**
 * Thumbnail generation, in pure TypeScript on Node's own zlib.
 *
 * The alternative was a native image library. `AGENTS.md` — "avoid adding
 * infrastructure systems unless a measured requirement justifies them" — and
 * the self-hosting guarantee both argue against it: a native codec brings
 * per-platform binaries, an air-gapped installation has to carry them, and the
 * whole requirement here is "make a small PNG out of a screenshot". PNG is a
 * documented format over DEFLATE, which Node already has, so this is a decoder
 * and an encoder rather than a dependency.
 *
 * **What it handles.** Non-interlaced PNG at bit depth 8, colour types 0
 * (greyscale), 2 (truecolour), 4 (greyscale with alpha) and 6 (truecolour with
 * alpha) — which is what Chromium's screenshot encoder produces, and therefore
 * what this product's own captures are.
 *
 * **What it does not.** Interlaced PNG, bit depths other than 8, and palette
 * images are reported as unsupported rather than guessed at; JPEG is not
 * decoded at all. `unsupported` is a terminal job outcome recorded on the
 * artefact, not a failure that retries forever — `docs/UX_FLOWS.md` §18
 * requires a viewer to be able to say which of not-yet, not-possible and failed
 * applies, and a job that keeps retrying something impossible can say neither.
 *
 * The decoder is written defensively because its input is untrusted
 * (ADR-0010): every length is checked against the buffer before it is read, the
 * pixel count is bounded before anything is allocated, and a malformed chunk
 * ends the decode rather than being skipped.
 */

import { deflateSync, inflateSync } from "node:zlib";

/** Longest edge of a generated thumbnail, in pixels. */
export const THUMBNAIL_MAX_EDGE = 320;

/**
 * Largest source image the thumbnailer will decode, in pixels.
 *
 * A PNG header can claim 2^32 pixels per side in twenty-four bytes. The bound
 * is what stops a small upload asking for an enormous allocation; a screenshot
 * of a 4K page at device pixel ratio 3 is comfortably inside it.
 */
const MAX_SOURCE_PIXELS = 80_000_000;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class UnsupportedImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedImageError";
  }
}

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** Row-major RGBA, four bytes per pixel. */
  readonly pixels: Buffer;
}

/** Decodes a PNG into RGBA. Throws {@link UnsupportedImageError} otherwise. */
export function decodePng(bytes: Buffer): RgbaImage {
  if (bytes.byteLength < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new UnsupportedImageError("the bytes are not a PNG");
  }

  let offset = 8;
  let header: {
    width: number;
    height: number;
    bitDepth: number;
    colourType: number;
    interlace: number;
  } | null = null;
  const idat: Buffer[] = [];

  while (offset + 8 <= bytes.byteLength) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("latin1");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    // The four trailing bytes are the CRC. A chunk that claims more than the
    // buffer holds is malformed, and reading it would read past the end.
    if (length > bytes.byteLength || dataEnd + 4 > bytes.byteLength) {
      throw new UnsupportedImageError("the PNG is truncated or malformed");
    }
    const data = bytes.subarray(dataStart, dataEnd);

    if (type === "IHDR") {
      if (length !== 13) throw new UnsupportedImageError("the PNG header is malformed");
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8] as number,
        colourType: data[9] as number,
        interlace: data[12] as number,
      };
      if (header.width === 0 || header.height === 0) {
        throw new UnsupportedImageError("the PNG has no pixels");
      }
      if (header.width * header.height > MAX_SOURCE_PIXELS) {
        throw new UnsupportedImageError("the PNG is larger than this build will decode");
      }
      if (header.bitDepth !== 8) {
        throw new UnsupportedImageError(`bit depth ${String(header.bitDepth)} is not supported`);
      }
      if (header.interlace !== 0) throw new UnsupportedImageError("interlaced PNG is not supported");
      if (![0, 2, 4, 6].includes(header.colourType)) {
        throw new UnsupportedImageError(
          `PNG colour type ${String(header.colourType)} is not supported`,
        );
      }
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  if (header === null) throw new UnsupportedImageError("the PNG has no header chunk");
  if (idat.length === 0) throw new UnsupportedImageError("the PNG has no image data");

  const channels = header.colourType === 0 ? 1 : header.colourType === 2 ? 3 : header.colourType === 4 ? 2 : 4;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    throw new UnsupportedImageError("the PNG image data could not be decompressed");
  }

  const stride = header.width * channels;
  if (raw.byteLength < (stride + 1) * header.height) {
    throw new UnsupportedImageError("the PNG image data is shorter than its header declares");
  }

  const pixels = Buffer.allocUnsafe(header.width * header.height * 4);
  const current = Buffer.allocUnsafe(stride);
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < header.height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart] as number;
    raw.copy(current, 0, rowStart + 1, rowStart + 1 + stride);
    unfilterRow(filter, current, previous, channels);
    writeRgbaRow(pixels, y, header.width, current, header.colourType);
    previous = Buffer.from(current);
  }

  return { width: header.width, height: header.height, pixels };
}

/** PNG row filters, from the specification. */
function unfilterRow(filter: number, row: Buffer, previous: Buffer, channels: number): void {
  const length = row.byteLength;
  switch (filter) {
    case 0:
      return;
    case 1:
      for (let index = channels; index < length; index += 1) {
        row[index] = ((row[index] as number) + (row[index - channels] as number)) & 0xff;
      }
      return;
    case 2:
      for (let index = 0; index < length; index += 1) {
        row[index] = ((row[index] as number) + (previous[index] as number)) & 0xff;
      }
      return;
    case 3:
      for (let index = 0; index < length; index += 1) {
        const left = index >= channels ? (row[index - channels] as number) : 0;
        row[index] = ((row[index] as number) + ((left + (previous[index] as number)) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let index = 0; index < length; index += 1) {
        const left = index >= channels ? (row[index - channels] as number) : 0;
        const above = previous[index] as number;
        const upperLeft = index >= channels ? (previous[index - channels] as number) : 0;
        row[index] = ((row[index] as number) + paeth(left, above, upperLeft)) & 0xff;
      }
      return;
    default:
      throw new UnsupportedImageError(`PNG row filter ${String(filter)} is not defined`);
  }
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceAbove = Math.abs(estimate - above);
  const distanceUpperLeft = Math.abs(estimate - upperLeft);
  if (distanceLeft <= distanceAbove && distanceLeft <= distanceUpperLeft) return left;
  return distanceAbove <= distanceUpperLeft ? above : upperLeft;
}

function writeRgbaRow(
  pixels: Buffer,
  y: number,
  width: number,
  row: Buffer,
  colourType: number,
): void {
  let out = y * width * 4;
  for (let x = 0; x < width; x += 1) {
    switch (colourType) {
      case 0: {
        const grey = row[x] as number;
        pixels[out] = grey;
        pixels[out + 1] = grey;
        pixels[out + 2] = grey;
        pixels[out + 3] = 255;
        break;
      }
      case 2: {
        const source = x * 3;
        pixels[out] = row[source] as number;
        pixels[out + 1] = row[source + 1] as number;
        pixels[out + 2] = row[source + 2] as number;
        pixels[out + 3] = 255;
        break;
      }
      case 4: {
        const source = x * 2;
        const grey = row[source] as number;
        pixels[out] = grey;
        pixels[out + 1] = grey;
        pixels[out + 2] = grey;
        pixels[out + 3] = row[source + 1] as number;
        break;
      }
      default: {
        const source = x * 4;
        pixels[out] = row[source] as number;
        pixels[out + 1] = row[source + 1] as number;
        pixels[out + 2] = row[source + 2] as number;
        pixels[out + 3] = row[source + 3] as number;
      }
    }
    out += 4;
  }
}

/**
 * Box-filter downsample.
 *
 * Averaging every source pixel that falls into a destination pixel, rather than
 * sampling one of them, is what stops a thumbnail of a page of text turning
 * into aliasing noise. It is the cheapest filter that produces something a
 * human can recognise the page from, which is the whole job of a thumbnail.
 */
export function downsample(image: RgbaImage, maxEdge: number): RgbaImage {
  const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  if (width === image.width && height === image.height) return image;

  const pixels = Buffer.allocUnsafe(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceTop = Math.floor((y * image.height) / height);
    const sourceBottom = Math.max(sourceTop + 1, Math.floor(((y + 1) * image.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sourceLeft = Math.floor((x * image.width) / width);
      const sourceRight = Math.max(sourceLeft + 1, Math.floor(((x + 1) * image.width) / width));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = sourceTop; sy < sourceBottom && sy < image.height; sy += 1) {
        for (let sx = sourceLeft; sx < sourceRight && sx < image.width; sx += 1) {
          const index = (sy * image.width + sx) * 4;
          r += image.pixels[index] as number;
          g += image.pixels[index + 1] as number;
          b += image.pixels[index + 2] as number;
          a += image.pixels[index + 3] as number;
          count += 1;
        }
      }
      const out = (y * width + x) * 4;
      pixels[out] = Math.round(r / count);
      pixels[out + 1] = Math.round(g / count);
      pixels[out + 2] = Math.round(b / count);
      pixels[out + 3] = Math.round(a / count);
    }
  }
  return { width, height, pixels };
}

/** Encodes RGBA as a non-interlaced, colour-type-6, bit-depth-8 PNG. */
export function encodePng(image: RgbaImage): Buffer {
  const stride = image.width * 4;
  const raw = Buffer.allocUnsafe((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    // Filter 0. The encoder's job is a correct small PNG, not the smallest
    // possible one, and DEFLATE does the compression that matters.
    raw[y * (stride + 1)] = 0;
    image.pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const header = Buffer.allocUnsafe(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.allocUnsafe(data.byteLength + 12);
  out.writeUInt32BE(data.byteLength, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.byteLength)), 8 + data.byteLength);
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = ((CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * The thumbnail for one source image, or an explanation of why there is none.
 *
 * A `null` result is an honest terminal outcome, not an error: a JPEG source is
 * something this build does not decode, and retrying will not change that.
 */
export function renderThumbnail(
  contentType: string,
  bytes: Buffer,
): { readonly bytes: Buffer; readonly width: number; readonly height: number } | null {
  if (contentType !== "image/png") return null;
  const decoded = decodePng(bytes);
  const small = downsample(decoded, THUMBNAIL_MAX_EDGE);
  return { bytes: encodePng(small), width: small.width, height: small.height };
}
