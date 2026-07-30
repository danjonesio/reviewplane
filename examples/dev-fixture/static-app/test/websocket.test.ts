/**
 * Tests for `/ws-echo`: the hand-rolled RFC 6455 server in `src/websocket.ts`.
 *
 * The frame encoder/reader below is written independently of
 * `src/websocket.ts` rather than importing its internals, so a bug shared
 * between the fixture and the test would not cancel itself out — the only
 * things imported from the source are `startStaticApp` (to run the real
 * server) and `computeAcceptKey` (asserted against a value this file also
 * computes by hand from `node:crypto`, so the accept-key check does not
 * merely restate the implementation).
 */

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { after, before, describe, test } from "node:test";
import { startStaticApp } from "../src/app.ts";
import type { StaticApp } from "../src/app.ts";
import { computeAcceptKey } from "../src/websocket.ts";

const OPCODE_TEXT = 0x1;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

function expectedAcceptKey(key: string): string {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "utf8")
    .digest("base64");
}

/** Client frames MUST be masked; this is the only framing an RFC 6455 server accepts from a client. */
function encodeMaskedFrame(opcode: number, payload: Buffer): Buffer {
  const maskKey = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    masked[i] = payload[i]! ^ maskKey[i % 4]!;
  }
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    throw new Error("test helper does not support frames >= 64 KiB");
  }
  return Buffer.concat([header, maskKey, masked]);
}

/** Deliberately protocol-violating: no mask bit, no mask key. Used to trigger the 1002 path. */
function encodeUnmaskedFrame(opcode: number, payload: Buffer): Buffer {
  if (payload.length >= 126) {
    throw new Error("test helper does not support extended lengths here");
  }
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

interface ReadFrame {
  readonly opcode: number;
  readonly payload: Buffer;
}

/**
 * A minimal server-frame reader: server frames are always unmasked and this
 * fixture never sends one fragmented, so only the length forms need
 * handling.
 */
function createFrameReader(socket: Socket): { next(): Promise<ReadFrame | null> } {
  let buffer = Buffer.alloc(0);
  let ended = false;
  const queue: (ReadFrame | null)[] = [];
  const waiters: ((frame: ReadFrame | null) => void)[] = [];

  const deliver = (frame: ReadFrame | null): void => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(frame);
    } else {
      queue.push(frame);
    }
  };

  const tryParse = (): void => {
    for (;;) {
      if (buffer.length < 2) {
        return;
      }
      const opcode = buffer[0]! & 0x0f;
      let length = buffer[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < offset + 2) {
          return;
        }
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) {
          return;
        }
        length = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
      }
      if (buffer.length < offset + length) {
        return;
      }
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      buffer = buffer.subarray(offset + length);
      deliver({ opcode, payload });
    }
  };

  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    tryParse();
  });
  socket.on("close", () => {
    ended = true;
    for (const waiter of waiters.splice(0)) {
      waiter(null);
    }
  });

  return {
    next(): Promise<ReadFrame | null> {
      const queued = queue.shift();
      if (queued !== undefined) {
        return Promise.resolve(queued);
      }
      if (ended) {
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

interface Handshake {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly socket: Socket;
}

/** Drives the handshake through `http.request`, which emits `"upgrade"` for a 101 response and carries the raw socket after it. */
function handshake(app: StaticApp, headers: Record<string, string>): Promise<Handshake> {
  return new Promise((resolve, reject) => {
    const url = new URL(app.origin);
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: "/ws-echo",
      method: "GET",
      headers: { Connection: "Upgrade", Upgrade: "websocket", ...headers },
    });
    req.on("upgrade", (response: IncomingMessage, socket: Socket) => {
      resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, socket });
    });
    req.on("error", reject);
    req.end();
  });
}

interface PlainResponse {
  readonly statusCode: number;
  readonly body: string;
}

/** For handshakes expected to be refused: no upgrade occurs, so the client gets an ordinary response. */
function requestWithoutUpgrade(app: StaticApp, headers: Record<string, string>): Promise<PlainResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(app.origin);
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: "/ws-echo",
      method: "GET",
      headers,
    });
    req.on("upgrade", (response: IncomingMessage) => {
      reject(new Error(`expected a rejected handshake but the server upgraded with ${String(response.statusCode)}`));
    });
    req.on("response", (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

const SAMPLE_KEY = "dGhlIHNhbXBsZSBub25jZQ==";

describe("/ws-echo", () => {
  let app!: StaticApp;

  before(async () => {
    app = await startStaticApp({ port: 0, host: "127.0.0.1", logLine: () => undefined });
  });

  after(async () => {
    await app.stop();
  });

  test("computeAcceptKey matches the RFC 6455 example", () => {
    // The exact key/accept pair from RFC 6455 §1.3, so this checks the
    // fixture's implementation against the specification, not just against
    // itself.
    assert.equal(computeAcceptKey(SAMPLE_KEY), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    assert.equal(computeAcceptKey(SAMPLE_KEY), expectedAcceptKey(SAMPLE_KEY));
  });

  test("completes the handshake, echoes text, answers a ping and mirrors a close code", async () => {
    const { statusCode, headers, socket } = await handshake(app, {
      "Sec-WebSocket-Key": SAMPLE_KEY,
      "Sec-WebSocket-Version": "13",
    });

    assert.equal(statusCode, 101);
    assert.equal(headers["sec-websocket-accept"], expectedAcceptKey(SAMPLE_KEY));
    assert.equal((headers.upgrade ?? "").toLowerCase(), "websocket");
    assert.equal((headers.connection ?? "").toLowerCase(), "upgrade");

    const frames = createFrameReader(socket);

    socket.write(encodeMaskedFrame(OPCODE_TEXT, Buffer.from("hello", "utf8")));
    const echoed = await withTimeout(frames.next(), 2000, "no echo frame arrived");
    assert.ok(echoed);
    assert.equal(echoed.opcode, OPCODE_TEXT);
    assert.equal(echoed.payload.toString("utf8"), "echo:hello");

    socket.write(encodeMaskedFrame(OPCODE_PING, Buffer.from("ping-body", "utf8")));
    const pong = await withTimeout(frames.next(), 2000, "no pong arrived");
    assert.ok(pong);
    assert.equal(pong.opcode, OPCODE_PONG);
    assert.equal(pong.payload.toString("utf8"), "ping-body");

    const closePayload = Buffer.alloc(2);
    closePayload.writeUInt16BE(1000, 0);
    socket.write(encodeMaskedFrame(OPCODE_CLOSE, closePayload));
    const close = await withTimeout(frames.next(), 2000, "no close frame arrived");
    assert.ok(close);
    assert.equal(close.opcode, OPCODE_CLOSE);
    assert.equal(close.payload.readUInt16BE(0), 1000);

    socket.end();
  });

  test("close-me makes the server initiate the close with code 1000", async () => {
    const { socket } = await handshake(app, {
      "Sec-WebSocket-Key": SAMPLE_KEY,
      "Sec-WebSocket-Version": "13",
    });
    const frames = createFrameReader(socket);

    socket.write(encodeMaskedFrame(OPCODE_TEXT, Buffer.from("close-me", "utf8")));
    const close = await withTimeout(frames.next(), 2000, "server did not initiate a close");
    assert.ok(close);
    assert.equal(close.opcode, OPCODE_CLOSE);
    assert.equal(close.payload.readUInt16BE(0), 1000);
    assert.equal(close.payload.subarray(2).toString("utf8"), "server-initiated");

    // Acknowledge it, as a real client would, and confirm the server ends
    // the socket rather than waiting indefinitely.
    socket.write(encodeMaskedFrame(OPCODE_CLOSE, close.payload));
    await new Promise<void>((resolve) => socket.on("close", resolve));
  });

  test("refuses a handshake missing Sec-WebSocket-Key with 400, and keeps serving", async () => {
    const result = await requestWithoutUpgrade(app, {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
    });
    assert.equal(result.statusCode, 400);

    const health = await fetch(new URL("/healthz", app.origin));
    assert.equal(health.status, 200);
  });

  test("refuses Sec-WebSocket-Version: 8 with 400, and keeps serving", async () => {
    const result = await requestWithoutUpgrade(app, {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Key": SAMPLE_KEY,
      "Sec-WebSocket-Version": "8",
    });
    assert.equal(result.statusCode, 400);

    const health = await fetch(new URL("/healthz", app.origin));
    assert.equal(health.status, 200);
  });

  test("an unmasked client frame closes the connection with 1002, and the server keeps serving", async () => {
    const { socket } = await handshake(app, {
      "Sec-WebSocket-Key": SAMPLE_KEY,
      "Sec-WebSocket-Version": "13",
    });
    const frames = createFrameReader(socket);

    socket.write(encodeUnmaskedFrame(OPCODE_TEXT, Buffer.from("hi", "utf8")));
    const close = await withTimeout(frames.next(), 2000, "no close frame arrived after an unmasked frame");
    assert.ok(close);
    assert.equal(close.opcode, OPCODE_CLOSE);
    assert.equal(close.payload.readUInt16BE(0), 1002);

    socket.end();

    const health = await fetch(new URL("/healthz", app.origin));
    assert.equal(health.status, 200);
  });

  test("a truncated frame does not crash the server", async () => {
    const { socket } = await handshake(app, {
      "Sec-WebSocket-Key": SAMPLE_KEY,
      "Sec-WebSocket-Version": "13",
    });

    // A masked text-frame header announcing 100 bytes of payload, followed by
    // only part of the mask key and no payload at all, then an abrupt reset —
    // proving the parser's incomplete-frame path never assumes more data
    // than it has actually been given.
    socket.write(Buffer.from([0x81, 0x80 | 100]));
    socket.write(Buffer.from([0x01, 0x02, 0x03]));
    socket.destroy();

    // Give the server a moment to process (or fail to process) the partial
    // frame before checking it is still alive.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const health = await fetch(new URL("/healthz", app.origin));
    assert.equal(health.status, 200);
  });

  test("a fragmented control frame closes the connection with 1002", async () => {
    const { socket } = await handshake(app, {
      "Sec-WebSocket-Key": SAMPLE_KEY,
      "Sec-WebSocket-Version": "13",
    });
    const frames = createFrameReader(socket);

    // A ping frame with FIN unset: control frames MUST NOT be fragmented.
    const maskKey = randomBytes(4);
    const payload = Buffer.from("x", "utf8");
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1) {
      masked[i] = payload[i]! ^ maskKey[i % 4]!;
    }
    const header = Buffer.from([0x00 | OPCODE_PING, 0x80 | payload.length]);
    socket.write(Buffer.concat([header, maskKey, masked]));

    const close = await withTimeout(frames.next(), 2000, "no close frame arrived after a fragmented ping");
    assert.ok(close);
    assert.equal(close.opcode, OPCODE_CLOSE);
    assert.equal(close.payload.readUInt16BE(0), 1002);

    socket.end();
  });

  test("an oversized payload closes the connection with 1009", async () => {
    const { socket } = await handshake(app, {
      "Sec-WebSocket-Key": SAMPLE_KEY,
      "Sec-WebSocket-Version": "13",
    });
    const frames = createFrameReader(socket);

    // A 64-bit extended length announcing 2 MiB, well past the 1 MiB bound —
    // sent as a header only, so the fixture must reject it from the length
    // field alone rather than by buffering the (never sent) payload.
    const header = Buffer.alloc(10);
    header[0] = 0x80 | OPCODE_TEXT;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(2 * 1024 * 1024), 2);
    socket.write(Buffer.concat([header, randomBytes(4)]));

    const close = await withTimeout(frames.next(), 2000, "no close frame arrived after an oversized length");
    assert.ok(close);
    assert.equal(close.opcode, OPCODE_CLOSE);
    assert.equal(close.payload.readUInt16BE(0), 1009);

    socket.end();
  });
});
