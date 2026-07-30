/**
 * A hand-rolled RFC 6455 WebSocket server: handshake, frame parsing and the
 * echo behaviour `/ws-echo` exposes.
 *
 * No `ws` dependency, because this fixture has none — see
 * `examples/dev-fixture/README.md` "Why this is outside the pnpm workspace".
 * `docs/CONNECTOR_PROTOCOL.md` §13.3 requires the route layer to preserve the
 * HTTP upgrade, bidirectional frames and closure semantics in both
 * directions; this module is what a test through the tunnel has to actually
 * reach in order to prove that.
 */

import { createHash } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { Socket } from "node:net";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** "Reject a payload larger than 1 MiB by closing with 1009." */
const MAX_PAYLOAD_BYTES = 1024 * 1024;

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;
const KNOWN_OPCODES = new Set<number>([
  OPCODE_CONTINUATION,
  OPCODE_TEXT,
  OPCODE_BINARY,
  OPCODE_CLOSE,
  OPCODE_PING,
  OPCODE_PONG,
]);

/** Collapses Node's repeated-header representation to one string. */
function headerValue(value: IncomingHttpHeaders[string]): string | undefined {
  return Array.isArray(value) ? value.join(", ") : value;
}

export function computeAcceptKey(key: string): string {
  return createHash("sha1")
    .update(key + WEBSOCKET_GUID, "utf8")
    .digest("base64");
}

/**
 * Answers a rejected upgrade as a plain HTTP response on the raw socket, then
 * ends it. `socket.end(data)` rather than `socket.write` followed by
 * `destroy`, so the response bytes are actually flushed before the
 * connection closes — a destroyed-before-flushed socket would leave a test
 * unable to observe the status this function exists to report.
 */
function rejectHandshake(socket: Socket, status: number, statusText: string): void {
  if (socket.destroyed) {
    return;
  }
  const body = `${String(status)} ${statusText}`;
  socket.end(
    `HTTP/1.1 ${String(status)} ${statusText}\r\n` +
      "Connection: close\r\n" +
      `Content-Length: ${String(Buffer.byteLength(body))}\r\n` +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      "\r\n" +
      body,
  );
}

/**
 * A close-code failure produced while decoding a frame. Thrown rather than
 * returned, so a single `try`/`catch` around the parse loop is the one place
 * that decides how a malformed frame ends the connection.
 */
class FrameError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

interface ParsedFrame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
}

/**
 * Reads one frame from the front of `buffer`, or `null` if `buffer` does not
 * yet hold a complete frame. The size bound is checked as soon as the length
 * field is decoded, before any payload bytes are copied, so a length field
 * claiming more than the fixture will ever accept cannot be used to make it
 * buffer that much data first.
 */
function parseFrame(buffer: Buffer): { readonly frame: ParsedFrame; readonly bytesConsumed: number } | null {
  if (buffer.length < 2) {
    return null;
  }
  const byte0 = buffer[0]!;
  const byte1 = buffer[1]!;
  const fin = (byte0 & 0x80) !== 0;
  const reserved = byte0 & 0x70;
  const opcode = byte0 & 0x0f;
  if (reserved !== 0) {
    throw new FrameError(1002, "reserved bits set");
  }
  if (!KNOWN_OPCODES.has(opcode)) {
    throw new FrameError(1002, "unknown opcode");
  }

  const masked = (byte1 & 0x80) !== 0;
  let payloadLen = byte1 & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buffer.length < offset + 2) {
      return null;
    }
    payloadLen = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLen === 127) {
    if (buffer.length < offset + 8) {
      return null;
    }
    const extended = buffer.readBigUInt64BE(offset);
    if (extended > BigInt(MAX_PAYLOAD_BYTES)) {
      throw new FrameError(1009, "payload too large");
    }
    payloadLen = Number(extended);
    offset += 8;
  }

  if (payloadLen > MAX_PAYLOAD_BYTES) {
    throw new FrameError(1009, "payload too large");
  }

  // Control frames (close/ping/pong) MUST NOT be fragmented and MUST fit in
  // one frame's 7-bit-or-less length, per RFC 6455 §5.5.
  const isControl = opcode >= OPCODE_CLOSE;
  if (isControl && (!fin || payloadLen > 125)) {
    throw new FrameError(1002, "fragmented or oversized control frame");
  }

  if (!masked) {
    throw new FrameError(1002, "client frame not masked");
  }
  if (buffer.length < offset + 4) {
    return null;
  }
  const maskKey = buffer.subarray(offset, offset + 4);
  offset += 4;

  if (buffer.length < offset + payloadLen) {
    return null;
  }
  const maskedPayload = buffer.subarray(offset, offset + payloadLen);
  const payload = Buffer.alloc(payloadLen);
  for (let i = 0; i < payloadLen; i += 1) {
    payload[i] = maskedPayload[i]! ^ maskKey[i % 4]!;
  }
  offset += payloadLen;

  return { frame: { fin, opcode, payload }, bytesConsumed: offset };
}

/** Server-to-client frames are always unmasked and always the whole message. */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function closePayload(code: number, reason: string): Buffer {
  const reasonBytes = Buffer.byteLength(reason);
  const payload = Buffer.alloc(2 + reasonBytes);
  payload.writeUInt16BE(code, 0);
  if (reasonBytes > 0) {
    payload.write(reason, 2, "utf8");
  }
  return payload;
}

/**
 * Wires frame parsing and the echo behaviour onto an already-upgraded
 * socket. Every path that ends the connection sends a close frame first and
 * only then ends the socket (`socket.end`, never a bare `destroy` after a
 * close frame), so a test reading the response observes the close code
 * rather than a bare TCP reset.
 */
function attachConnection(socket: Socket): void {
  let buffer = Buffer.alloc(0);
  let assembling: { readonly opcode: number; readonly chunks: Buffer[] } | null = null;
  // `closeSent` doubles as "the connection is over": once set, no further
  // frame is written and incoming data is ignored.
  // `closeSent` is "no further frame may be written" — true as soon as this
  // fixture has sent its own close frame, including while it is still
  // waiting for the peer's acknowledgement (the `close-me` path). `finished`
  // is "no further frame may be read": it is set only once the socket is
  // actually being ended, which for a self-initiated close is *after* that
  // acknowledgement arrives. Conflating the two would make the "data"
  // listener stop reading the moment this fixture sends its own close frame,
  // so the peer's reply — the thing a self-initiated close exists to prove
  // arrives — would never be seen.
  let closeSent = false;
  let closeReceived = false;
  let finished = false;

  const sendFrame = (opcode: number, payload: Buffer): void => {
    if (closeSent || socket.destroyed) {
      return;
    }
    socket.write(encodeFrame(opcode, payload));
  };

  const sendCloseFrame = (payload: Buffer): void => {
    if (closeSent || socket.destroyed) {
      return;
    }
    closeSent = true;
    socket.write(encodeFrame(OPCODE_CLOSE, payload));
  };

  /** A protocol violation: answer with a close frame carrying `code`, then end. */
  const fail = (code: number, reason: string): void => {
    if (finished) {
      return;
    }
    finished = true;
    closeSent = true;
    if (!socket.destroyed) {
      socket.end(encodeFrame(OPCODE_CLOSE, closePayload(code, reason)));
    }
  };

  const onCloseFrame = (payload: Buffer): void => {
    if (closeReceived) {
      return;
    }
    closeReceived = true;
    finished = true;
    if (closeSent) {
      // The peer's acknowledgement of a close this fixture initiated (the
      // `close-me` path): our half is already sent, so just end.
      socket.end();
      return;
    }
    // The peer initiated the close: answer with the same code and reason,
    // then end — this is what proves closure semantics travel both ways.
    closeSent = true;
    socket.end(encodeFrame(OPCODE_CLOSE, payload));
  };

  const initiateClose = (code: number, reason: string): void => {
    sendCloseFrame(closePayload(code, reason));
  };

  const deliverMessage = (opcode: number, payload: Buffer): void => {
    if (opcode !== OPCODE_TEXT) {
      // Binary messages are accepted and echoed for framing symmetry; the
      // fixture's documented behaviour concerns text messages only.
      sendFrame(OPCODE_BINARY, payload);
      return;
    }
    const text = payload.toString("utf8");
    if (text === "close-me") {
      initiateClose(1000, "server-initiated");
      return;
    }
    sendFrame(OPCODE_TEXT, Buffer.from(`echo:${text}`, "utf8"));
  };

  /** Returns `false` once the connection is ending, so the read loop stops. */
  const handleFrame = (frame: ParsedFrame): boolean => {
    const { fin, opcode, payload } = frame;

    if (opcode === OPCODE_CLOSE) {
      onCloseFrame(payload);
      return false;
    }
    if (opcode === OPCODE_PING) {
      sendFrame(OPCODE_PONG, payload);
      return true;
    }
    if (opcode === OPCODE_PONG) {
      return true;
    }
    if (opcode === OPCODE_CONTINUATION) {
      if (assembling === null) {
        fail(1002, "continuation without a start frame");
        return false;
      }
      assembling.chunks.push(payload);
      if (fin) {
        const message = Buffer.concat(assembling.chunks);
        const finishedOpcode = assembling.opcode;
        assembling = null;
        deliverMessage(finishedOpcode, message);
      }
      return true;
    }
    // OPCODE_TEXT or OPCODE_BINARY (parseFrame already rejected anything else).
    if (assembling !== null) {
      fail(1002, "new message started before the previous one finished");
      return false;
    }
    if (fin) {
      deliverMessage(opcode, payload);
    } else {
      assembling = { opcode, chunks: [payload] };
    }
    return true;
  };

  socket.on("data", (chunk: Buffer) => {
    if (finished) {
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    try {
      for (;;) {
        const result = parseFrame(buffer);
        if (result === null) {
          break;
        }
        buffer = buffer.subarray(result.bytesConsumed);
        if (!handleFrame(result.frame)) {
          return;
        }
      }
    } catch (error) {
      const code = error instanceof FrameError ? error.code : 1002;
      const reason = error instanceof Error ? error.message : "malformed frame";
      fail(code, reason);
    }
  });

  // Required so a reset connection surfaces here rather than as an uncaught
  // 'error' event, which would take the whole fixture process down — the one
  // outcome a malformed frame or an abrupt disconnect MUST NOT cause.
  socket.on("error", () => {
    closeSent = true;
    finished = true;
  });
}

/**
 * Handles one `"upgrade"` event. Never throws: every failure path answers on
 * the socket and returns, because an exception here would propagate out of
 * the server's event emitter and crash the process.
 */
export function handleWebSocketUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
  const url = new URL(request.url ?? "/", "http://dev-fixture.invalid");
  if (url.pathname !== "/ws-echo") {
    rejectHandshake(socket, 404, "Not Found");
    return;
  }

  const upgrade = (headerValue(request.headers.upgrade) ?? "").toLowerCase();
  const connection = (headerValue(request.headers.connection) ?? "").toLowerCase();
  const version = headerValue(request.headers["sec-websocket-version"]) ?? "";
  const key = headerValue(request.headers["sec-websocket-key"]) ?? "";

  const validHandshake =
    request.method === "GET" &&
    upgrade === "websocket" &&
    connection
      .split(",")
      .map((token) => token.trim())
      .includes("upgrade") &&
    version === "13" &&
    key.length > 0;

  if (!validHandshake) {
    rejectHandshake(socket, 400, "Bad Request");
    return;
  }

  // "Echo back exactly one offered sub-protocol" — the first, since this
  // fixture has no protocol-specific behaviour to choose between them.
  const requestedProtocol = headerValue(request.headers["sec-websocket-protocol"])
    ?.split(",")
    .map((token) => token.trim())
    .find((token) => token.length > 0);

  const responseLines = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${computeAcceptKey(key)}`,
  ];
  if (requestedProtocol !== undefined) {
    responseLines.push(`Sec-WebSocket-Protocol: ${requestedProtocol}`);
  }
  socket.write(`${responseLines.join("\r\n")}\r\n\r\n`);

  attachConnection(socket);

  // Bytes the client sent in the same TCP segment as the handshake, read by
  // Node before this handler attached its own listener, are pushed back onto
  // the socket's internal queue so the listener above still sees them.
  if (head.length > 0) {
    socket.unshift(head);
  }
}
