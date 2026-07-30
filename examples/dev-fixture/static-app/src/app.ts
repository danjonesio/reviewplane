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
import type { AddressInfo } from "node:net";
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
} from "./pages.ts";

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
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
