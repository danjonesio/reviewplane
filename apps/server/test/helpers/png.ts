/**
 * A minimal PNG encoder for the tests.
 *
 * The artefact tests need real image bytes with a size the server can measure,
 * because the artefact content rectangle is what annotation geometry is
 * normalised against. A one-pixel constant would prove the upload path and
 * nothing about the measurement, and pulling in an image library to produce a
 * rectangle of one colour would be a dependency for the sake of thirty lines.
 */

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.byteLength);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
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

/** An opaque RGB PNG of the given size, filled with one colour. */
export function encodePng(
  width: number,
  height: number,
  colour: readonly [number, number, number] = [15, 23, 42],
): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const offset = row * (stride + 1);
    raw[offset] = 0; // filter: none
    for (let column = 0; column < width; column += 1) {
      raw[offset + 1 + column * 3] = colour[0];
      raw[offset + 2 + column * 3] = colour[1];
      raw[offset + 3 + column * 3] = colour[2];
    }
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
