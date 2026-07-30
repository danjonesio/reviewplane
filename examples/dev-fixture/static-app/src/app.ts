/**
 * The loopback development fixture, composition and request handling.
 *
 * This stands in for "an agent's local application on the development VM" in
 * the loop `CLAUDE.md` locks: the agent starts it, the connector publishes it
 * privately, and a central browser opens it through a session-scoped route. It
 * depends on nothing in the workspace — not `@reviewplane/protocol`, not the
 * server — because a fixture that shared the product's code could not falsify
 * a claim about the product.
 *
 * `src/main.ts` is the entry point; everything here is startable in-process so
 * that tests drive it without a subprocess.
 */

import { createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { assertLoopbackBindAddress } from "./loopback.ts";
import { SITE_CSS, SITE_JS, SITE_LOGO } from "./assets.ts";
import {
  absoluteUrlPage,
  CHECKOUT,
  CROSS_ORIGIN,
  HOME,
  NOT_FOUND,
  PRODUCTS,
  slowPage,
  SSE,
  THROUGHPUT,
  WEBSOCKET,
} from "./pages.ts";
import { handleWebSocketUpgrade } from "./websocket.ts";

/** Matches the Stage 0 destination allow-list in `docs/CONFIGURATION.md` §4. */
const DEFAULT_PORT = 4321;
const DEFAULT_HOST = "127.0.0.1";

/**
 * An upper bound on `/slow`, so that fault injection cannot leave a request
 * outstanding for longer than any timeout under test and turn a bounded-timeout
 * case into a hung suite.
 */
export const MAX_DELAY_MS = 120_000;

const HTML = "text/html; charset=utf-8";
const JSON_TYPE = "application/json; charset=utf-8";

/**
 * What one request told the fixture about the hop in front of it.
 *
 * `docs/CONNECTOR_PROTOCOL.md` §13 fixes header handling in configuration
 * rather than per request, so these four values are the evidence for which
 * `host_header_mode` and `forwarded_header_mode` a deployment is actually
 * running — a development server's own behaviour depends on them.
 */
export interface RequestRecord {
  readonly method: string;
  readonly path: string;
  readonly host: string | undefined;
  readonly origin: string | undefined;
  readonly xForwardedHost: string | undefined;
  readonly xForwardedProto: string | undefined;
}

export interface StaticAppOptions {
  /** Defaults to `PORT`, then 4321. Zero binds an ephemeral port. */
  readonly port?: number;
  /** Defaults to `HOST`, then 127.0.0.1. MUST be a loopback address. */
  readonly host?: string;
  /** Defaults to one line on stdout. Tests supply a collector instead. */
  readonly logLine?: (line: string) => void;
}

export interface StaticApp {
  readonly origin: string;
  readonly port: number;
  readonly requests: RequestRecord[];
  stop(): Promise<void>;
}

/** Collapses Node's repeated-header representation to one string. */
function headerValue(value: IncomingHttpHeaders[string]): string | undefined {
  return Array.isArray(value) ? value.join(", ") : value;
}

function resolvePort(explicit: number | undefined): number {
  const raw = explicit ?? Number(process.env["PORT"] ?? DEFAULT_PORT);
  if (!Number.isInteger(raw) || raw < 0 || raw > 65535) {
    throw new Error(`invalid port ${JSON.stringify(String(raw))}: expected an integer 0-65535`);
  }
  return raw;
}

/**
 * Clamps rather than rejects: the fault-injection cases want a bound, not a
 * 4xx. Exported so the bound is testable without a test that waits for it.
 */
export function clampDelayMs(raw: string | null): number {
  const parsed = Number(raw ?? "0");
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.min(Math.floor(parsed), MAX_DELAY_MS);
}

/**
 * An upper bound on the total run time of `/events` and `/chunked`, so a
 * request combining a large count with a large interval cannot hold a
 * connection — and the timer that feeds it — open indefinitely.
 */
export const MAX_STREAM_RUNTIME_MS = 60_000;

/** Same clamp shape as `clampDelayMs`, but falls back to `defaultValue` rather than 0: absence of the parameter means "use the default count", not "send nothing". */
export function clampStreamCount(raw: string | null, defaultValue: number, max: number): number {
  const parsed = Number(raw ?? defaultValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return defaultValue;
  }
  return Math.min(Math.floor(parsed), max);
}

/**
 * Clamps the requested interval, then tightens it further so that
 * `count * intervalMs` never exceeds `MAX_STREAM_RUNTIME_MS` — the "clamp
 * count * interval_ms" bound applied as a shrink of the interval, since the
 * count is what the response body's shape (event or chunk numbering) depends
 * on.
 */
export function clampStreamIntervalMs(
  raw: string | null,
  defaultValue: number,
  max: number,
  count: number,
): number {
  const parsed = Number(raw ?? defaultValue);
  const requested = !Number.isFinite(parsed) || parsed < 0 ? defaultValue : Math.min(Math.floor(parsed), max);
  if (count <= 0) {
    return requested;
  }
  return Math.min(requested, Math.floor(MAX_STREAM_RUNTIME_MS / count));
}

const DEFAULT_BULK_BYTES = 4 * 1024 * 1024;
const MAX_BULK_BYTES = 32 * 1024 * 1024;
const BULK_CHUNK_BYTES = 64 * 1024;

/** Same shape as `clampStreamCount`: a non-numeric or out-of-range request falls back to the default rather than erroring. */
export function clampBulkBytes(raw: string | null): number {
  const parsed = Number(raw ?? DEFAULT_BULK_BYTES);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_BULK_BYTES;
  }
  return Math.min(Math.floor(parsed), MAX_BULK_BYTES);
}

/**
 * One `length`-byte tile of the `/bulk` body, starting at absolute offset
 * `offset`. A multiplicative hash of the byte's own offset rather than
 * `crypto.randomBytes`: deterministic (the same request produces the same
 * bytes every time, which is what makes a `content-length` mismatch a bug
 * rather than a flake) while still looking nothing like a repeating pattern,
 * which is what a hop that transparently compressed the response would
 * otherwise get away with unnoticed.
 */
function bulkChunkAt(offset: number, length: number): Buffer {
  const chunk = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) {
    const hash = Math.imul((offset + i) ^ 0x9e3779b9, 2654435761);
    chunk[i] = (hash >>> 24) & 0xff;
  }
  return chunk;
}

export async function startStaticApp(options: StaticAppOptions = {}): Promise<StaticApp> {
  const host = options.host ?? process.env["HOST"] ?? DEFAULT_HOST;
  const port = resolvePort(options.port);
  const logLine =
    options.logLine ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });

  assertLoopbackBindAddress(host);

  const requests: RequestRecord[] = [];
  // Cleared on stop, so a pending `/slow` cannot hold the process open.
  const timers = new Set<ReturnType<typeof setTimeout>>();
  // Tracked separately from the server's own connection bookkeeping:
  // `server.closeAllConnections()` is not reliable for a socket handed off
  // through the `"upgrade"` event, so a WebSocket connection left open by a
  // test or an aborted client would otherwise make `stop()` wait forever for
  // a `server.close()` callback that never fires.
  const upgradedSockets = new Set<Socket>();
  // Known only after listen; `/absolute-url` needs the address it actually got.
  let origin = "";

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? "/", "http://dev-fixture.invalid");

    const send = (status: number, contentType: string, body: string): void => {
      response.writeHead(status, {
        "content-type": contentType,
        // Every response, so that a screenshot taken after a change shows the
        // change rather than a cached page.
        "cache-control": "no-store",
      });
      response.end(body);
    };

    switch (url.pathname) {
      case "/":
        send(200, HTML, HOME);
        return;
      case "/products":
        send(200, HTML, PRODUCTS);
        return;
      case "/checkout":
        send(200, HTML, CHECKOUT);
        return;
      case "/assets/site.css":
        send(200, SITE_CSS.contentType, SITE_CSS.body);
        return;
      case "/assets/site.js":
        send(200, SITE_JS.contentType, SITE_JS.body);
        return;
      case "/assets/logo.svg":
        send(200, SITE_LOGO.contentType, SITE_LOGO.body);
        return;
      case "/absolute-url":
        send(200, HTML, absoluteUrlPage(origin));
        return;
      case "/cross-origin":
        send(200, HTML, CROSS_ORIGIN);
        return;
      case "/slow": {
        const delayMs = clampDelayMs(url.searchParams.get("ms"));
        const timer = setTimeout(() => {
          timers.delete(timer);
          send(200, HTML, slowPage(delayMs));
        }, delayMs);
        timers.add(timer);
        return;
      }
      case "/truncated": {
        // Announces more bytes than it writes and then destroys the socket, so
        // a reader that trusts Content-Length sees a short read rather than a
        // clean end. The fixture never sends the missing bytes.
        const body = "This response body is shorter than its Content-Length.";
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "content-length": String(body.length * 4),
        });
        response.write(body, () => {
          request.socket.destroy();
        });
        return;
      }
      case "/healthz":
        send(200, JSON_TYPE, `{"status":"ok"}`);
        return;
      case "/websocket":
        send(200, HTML, WEBSOCKET);
        return;
      case "/sse":
        send(200, HTML, SSE);
        return;
      case "/throughput":
        send(200, HTML, THROUGHPUT);
        return;
      case "/bulk": {
        const bytes = clampBulkBytes(url.searchParams.get("bytes"));
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "cache-control": "no-store",
          // Set explicitly rather than left to Node: the throughput figure
          // this route exists to produce depends on the receiver knowing the
          // expected length up front, not on discovering it from the stream.
          "content-length": String(bytes),
        });

        let aborted = false;
        request.on("close", () => {
          aborted = true;
        });

        let written = 0;
        // 64 KiB tiles rather than one `Buffer.alloc(bytes)`, so a 32 MiB
        // request costs the fixture one tile of memory, not the whole body.
        const writeNext = (): void => {
          while (!aborted && written < bytes) {
            const size = Math.min(BULK_CHUNK_BYTES, bytes - written);
            const tile = bulkChunkAt(written, size);
            written += size;
            if (!response.write(tile)) {
              response.once("drain", writeNext);
              return;
            }
          }
          if (!aborted) {
            response.end();
          }
        };
        writeNext();
        return;
      }
      case "/events": {
        const count = clampStreamCount(url.searchParams.get("count"), 5, 200);
        const intervalMs = clampStreamIntervalMs(url.searchParams.get("interval_ms"), 300, 5000, count);
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          "x-accel-buffering": "no",
        });

        if (count <= 0) {
          response.end(`event: done\ndata: ${JSON.stringify({ count })}\n\n`);
          return;
        }

        let seq = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const clearPending = (): void => {
          if (timer !== undefined) {
            clearTimeout(timer);
            timers.delete(timer);
            timer = undefined;
          }
        };
        // A client that disconnects mid-stream must not leave a timer firing
        // into a response nobody reads from.
        request.on("close", clearPending);

        const tick = (): void => {
          seq += 1;
          response.write(
            `id: ${String(seq)}\nevent: tick\ndata: ${JSON.stringify({ seq, sent_at_ms: Date.now() })}\n\n`,
          );
          if (seq >= count) {
            response.write(`event: done\ndata: ${JSON.stringify({ count })}\n\n`);
            clearPending();
            response.end();
            return;
          }
          timer = setTimeout(tick, intervalMs);
          timers.add(timer);
        };

        timer = setTimeout(tick, intervalMs);
        timers.add(timer);
        return;
      }
      case "/chunked": {
        const chunks = clampStreamCount(url.searchParams.get("chunks"), 5, 200);
        const intervalMs = clampStreamIntervalMs(url.searchParams.get("interval_ms"), 200, 5000, chunks);
        // No content-length: the point of this route is that Node falls back
        // to chunked transfer encoding and the body arrives incrementally.
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        });

        if (chunks <= 0) {
          response.end(`chunks done 0\n`);
          return;
        }

        let index = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const clearPending = (): void => {
          if (timer !== undefined) {
            clearTimeout(timer);
            timers.delete(timer);
            timer = undefined;
          }
        };
        request.on("close", clearPending);

        const tick = (): void => {
          index += 1;
          response.write(`chunk ${String(index)} ${String(Date.now())}\n`);
          if (index >= chunks) {
            response.write(`chunks done ${String(chunks)}\n`);
            clearPending();
            response.end();
            return;
          }
          timer = setTimeout(tick, intervalMs);
          timers.add(timer);
        };

        timer = setTimeout(tick, intervalMs);
        timers.add(timer);
        return;
      }
      default:
        send(404, HTML, NOT_FOUND);
    }
  };

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://dev-fixture.invalid");
    const record: RequestRecord = {
      method: request.method ?? "GET",
      path: url.pathname,
      host: headerValue(request.headers.host),
      origin: headerValue(request.headers.origin),
      xForwardedHost: headerValue(request.headers["x-forwarded-host"]),
      xForwardedProto: headerValue(request.headers["x-forwarded-proto"]),
    };
    requests.push(record);

    // Logged on close rather than on entry, so the line carries the status and
    // so a destroyed response is still accounted for.
    response.on("close", () => {
      logLine(
        JSON.stringify({
          level: "info",
          service: "static-app",
          method: record.method,
          path: record.path,
          status: response.statusCode,
          // Exactly as received. Which value appears here is the evidence for
          // the gateway's `host_header_mode`, so it is never normalised.
          host_header: record.host ?? null,
          x_forwarded_host: record.xForwardedHost ?? null,
          x_forwarded_proto: record.xForwardedProto ?? null,
        }),
      );
    });

    handle(request, response);
  });

  // `/ws-echo` never reaches `handle`: an HTTP upgrade bypasses the request
  // event entirely, so it is wired in here instead.
  server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
    upgradedSockets.add(socket);
    socket.once("close", () => {
      upgradedSockets.delete(socket);
    });
    try {
      handleWebSocketUpgrade(request, socket, head);
    } catch {
      // The handshake handler is documented never to throw; this is the last
      // line of defence so a bug there closes the connection instead of
      // taking the process down.
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const displayHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  origin = `http://${displayHost}:${String(address.port)}`;

  return {
    origin,
    port: address.port,
    requests,
    async stop() {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      // Destroyed explicitly rather than left to `closeAllConnections()`,
      // which does not reliably reach a socket handed off through
      // `"upgrade"` — see the comment on `upgradedSockets` above.
      for (const socket of upgradedSockets) {
        if (!socket.destroyed) {
          socket.destroy();
        }
      }
      upgradedSockets.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
