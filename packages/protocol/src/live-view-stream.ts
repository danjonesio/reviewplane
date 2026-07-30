/**
 * The internal leg of the live-view channel: worker to control plane.
 *
 * `docs/API.md` section 18.2 fixes the separation of frame metadata from the
 * binary frame payload on the viewer's WebSocket, where a text message and a
 * binary message carry the two halves. The internal leg is an HTTP response
 * body rather than a WebSocket, so the same separation needs framing of its
 * own: a one-byte record kind, a four-byte big-endian length, then the bytes.
 *
 * It lives in this package rather than in either service for the reason
 * `docs/DEVELOPMENT.md` section 3 gives: the producer and the relay would
 * otherwise hold two hand-maintained descriptions of the same wire format, and
 * a length that meant something slightly different on each side is the kind of
 * disagreement that only shows up under load.
 *
 * The reader is written for a hostile sender even though this leg is
 * internal. Both bounds are checked before any allocation, a length is never
 * trusted to be reachable, and a record that exceeds its bound ends the stream
 * rather than being resynchronised — there is no way to resynchronise a
 * length-prefixed stream whose length was wrong.
 */

import { LIMITS } from "./generated/live_view/v1/types.ts";

/** Record kinds, mirroring `x-protocol.vocabularies.transport_records`. */
export const LIVE_RECORD_MESSAGE = 1;
export const LIVE_RECORD_FRAME_PAYLOAD = 2;

export type LiveRecordKind = typeof LIVE_RECORD_MESSAGE | typeof LIVE_RECORD_FRAME_PAYLOAD;

/** Bytes of the fixed header: one kind byte plus a 32-bit big-endian length. */
export const LIVE_RECORD_HEADER_BYTES = 5;

export interface LiveRecord {
  readonly kind: LiveRecordKind;
  readonly bytes: Uint8Array;
}

export class LiveStreamFramingError extends Error {}

function boundFor(kind: LiveRecordKind): number {
  return kind === LIVE_RECORD_MESSAGE
    ? LIMITS.MAX_LIVE_MESSAGE_BYTES
    : LIMITS.MAX_FRAME_PAYLOAD_BYTES;
}

/** Encodes one record. The bound for its kind is applied before allocation. */
export function encodeLiveRecord(kind: LiveRecordKind, bytes: Uint8Array): Uint8Array {
  const bound = boundFor(kind);
  if (bytes.byteLength > bound) {
    throw new LiveStreamFramingError(
      `record of ${String(bytes.byteLength)} bytes exceeds the ${String(bound)} byte bound for kind ${String(kind)}`,
    );
  }
  const out = new Uint8Array(LIVE_RECORD_HEADER_BYTES + bytes.byteLength);
  out[0] = kind;
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(1, bytes.byteLength, false);
  out.set(bytes, LIVE_RECORD_HEADER_BYTES);
  return out;
}

/** Encodes a JSON live-view message as a record. */
export function encodeLiveMessageRecord(json: string): Uint8Array {
  return encodeLiveRecord(LIVE_RECORD_MESSAGE, new TextEncoder().encode(json));
}

/**
 * Incremental reader over the byte stream.
 *
 * `push` returns the records that became complete; it never returns a partial
 * one, and it never holds more than one record's worth of bytes beyond what
 * the caller handed it.
 */
export class LiveRecordDecoder {
  #buffer: Uint8Array = new Uint8Array(0);

  /** Bytes currently held awaiting completion of a record. */
  get pending(): number {
    return this.#buffer.byteLength;
  }

  push(chunk: Uint8Array): LiveRecord[] {
    const combined = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    combined.set(this.#buffer, 0);
    combined.set(chunk, this.#buffer.byteLength);
    this.#buffer = combined;

    const records: LiveRecord[] = [];
    for (;;) {
      if (this.#buffer.byteLength < LIVE_RECORD_HEADER_BYTES) break;
      const kind = this.#buffer[0];
      if (kind !== LIVE_RECORD_MESSAGE && kind !== LIVE_RECORD_FRAME_PAYLOAD) {
        throw new LiveStreamFramingError(`unknown live record kind ${String(kind)}`);
      }
      const view = new DataView(
        this.#buffer.buffer,
        this.#buffer.byteOffset,
        this.#buffer.byteLength,
      );
      const length = view.getUint32(1, false);
      const bound = boundFor(kind);
      if (length > bound) {
        // Checked before waiting for the bytes, so a hostile length cannot make
        // the reader accumulate them.
        throw new LiveStreamFramingError(
          `live record of ${String(length)} bytes exceeds the ${String(bound)} byte bound for kind ${String(kind)}`,
        );
      }
      const total = LIVE_RECORD_HEADER_BYTES + length;
      if (this.#buffer.byteLength < total) break;
      records.push({
        kind,
        bytes: this.#buffer.slice(LIVE_RECORD_HEADER_BYTES, total),
      });
      this.#buffer = this.#buffer.slice(total);
    }
    return records;
  }
}
