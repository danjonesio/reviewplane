/**
 * Tests for the loopback development fixture.
 *
 * These assert the properties the tunnel proof depends on: the fixture binds
 * loopback and nothing else, every route answers with the status and type the
 * README claims, the home page names its sub-resources by root-relative URL,
 * `/absolute-url` really does emit the failure mode it documents, and the
 * request log preserves the `Host` header the hop in front supplied.
 */

import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { after, before, describe, test } from "node:test";
import { clampDelayMs, MAX_DELAY_MS, startStaticApp } from "../src/app.ts";
import type { StaticApp } from "../src/app.ts";
import { isLoopbackAddress } from "../src/loopback.ts";

interface FixtureResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  /** True when the connection closed before the announced body arrived. */
  readonly truncated: boolean;
}

/**
 * A raw `node:http` client rather than `fetch`, because `Host` is a forbidden
 * request header for `fetch` and the Host-header assertions are the point of
 * several of these tests. It settles on close rather than on end so that
 * `/truncated` is observable instead of an unhandled error.
 */
function get(
  app: StaticApp,
  path: string,
  headers: Record<string, string> = {},
): Promise<FixtureResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, app.origin);
    const chunks: Buffer[] = [];
    let settled = false;

    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers,
      },
      (response) => {
        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        const settle = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            truncated: !response.complete,
          });
        };
        response.on("close", settle);
        response.on("error", settle);
      },
    );

    request.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      // A socket destroyed mid-body surfaces here, and the partial body is the
      // evidence `/truncated` exists to produce.
      if (chunks.length > 0 || error.code === "ECONNRESET") {
        settled = true;
        resolve({ status: 200, headers: {}, body: Buffer.concat(chunks).toString("utf8"), truncated: true });
        return;
      }
      reject(error);
    });
    request.end();
  });
}

function headerText(value: IncomingHttpHeaders[string]): string {
  return Array.isArray(value) ? value.join(", ") : (value ?? "");
}

describe("static-app", () => {
  let app!: StaticApp;
  let logged: string[] = [];

  before(async () => {
    logged = [];
    app = await startStaticApp({
      // Ephemeral, so the suite never collides with a fixture an operator is
      // already running on 4321.
      port: 0,
      host: "127.0.0.1",
      logLine: (line) => logged.push(line),
    });
  });

  after(async () => {
    await app.stop();
  });

  test("binds a loopback address and refuses anything else", async () => {
    assert.equal(new URL(app.origin).hostname, "127.0.0.1");
    assert.ok(isLoopbackAddress("127.0.0.1"));
    assert.ok(isLoopbackAddress("::1"));
    assert.ok(!isLoopbackAddress("0.0.0.0"));
    assert.ok(!isLoopbackAddress("192.168.1.10"));
    // A name is refused rather than resolved: the address a resolver returns
    // need not be the one the check approved.
    assert.ok(!isLoopbackAddress("localhost"));

    await assert.rejects(
      () => startStaticApp({ port: 0, host: "0.0.0.0" }),
      /MUST bind a literal loopback address/u,
    );
  });

  test("every route answers with its documented status and content type", async () => {
    const expected: readonly (readonly [string, number, string])[] = [
      ["/", 200, "text/html; charset=utf-8"],
      ["/products", 200, "text/html; charset=utf-8"],
      ["/checkout", 200, "text/html; charset=utf-8"],
      ["/assets/site.css", 200, "text/css; charset=utf-8"],
      ["/assets/site.js", 200, "text/javascript; charset=utf-8"],
      ["/assets/logo.svg", 200, "image/svg+xml"],
      ["/absolute-url", 200, "text/html; charset=utf-8"],
      ["/cross-origin", 200, "text/html; charset=utf-8"],
      ["/healthz", 200, "application/json; charset=utf-8"],
      ["/no-such-page", 404, "text/html; charset=utf-8"],
    ];

    for (const [path, status, contentType] of expected) {
      const response = await get(app, path);
      assert.equal(response.status, status, path);
      assert.equal(headerText(response.headers["content-type"]), contentType, path);
      // Deterministic screenshots require that nothing is served from cache.
      assert.equal(headerText(response.headers["cache-control"]), "no-store", path);
      assert.ok(response.body.length > 0, path);
    }
  });

  test("the assets carry real content", async () => {
    const css = await get(app, "/assets/site.css");
    assert.match(css.body, /\.css-probe\s*\{/u);
    const js = await get(app, "/assets/site.js");
    assert.match(js.body, /data-testid="script-status"/u);
    const svg = await get(app, "/assets/logo.svg");
    assert.match(svg.body, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u);
  });

  test("healthz reports ok", async () => {
    const response = await get(app, "/healthz");
    assert.deepEqual(JSON.parse(response.body), { status: "ok" });
  });

  test("the home page names its sub-resources by root-relative URL", async () => {
    const home = await get(app, "/");
    for (const reference of ["/assets/site.css", "/assets/site.js", "/assets/logo.svg"]) {
      assert.ok(home.body.includes(`"${reference}"`), `home page does not name ${reference}`);
    }
    // No absolute reference anywhere on the home page: an absolute URL naming
    // the development machine is exactly what does not survive the route.
    assert.ok(!/(?:src|href)="https?:\/\//u.test(home.body));
    assert.match(home.body, /<h1 id="page-title" data-testid="home-heading">/u);
    // Relative to the current page, and root-relative, respectively.
    assert.match(home.body, /<a href="products" data-testid="relative-products-link">/u);
    assert.match(home.body, /<a href="\/checkout" data-testid="root-relative-checkout-link">/u);
    // Required for the 390x844 viewport in `AGENTS.md` "Browser-facing work".
    assert.match(home.body, /<meta name="viewport" content="width=device-width, initial-scale=1">/u);
  });

  test("the relative link resolves to the second page", async () => {
    const target = new URL("products", new URL("/", app.origin));
    assert.equal(target.pathname, "/products");
    const products = await get(app, target.pathname);
    assert.match(products.body, /data-testid="products-heading"/u);
    assert.match(products.body, /<a href="\/" data-testid="products-home-link">/u);
  });

  test("the absolute-url page emits an absolute URL to the development machine", async () => {
    const response = await get(app, "/absolute-url");
    const absolute = `http://127.0.0.1:${String(app.port)}/assets/site.css`;
    assert.ok(
      response.body.includes(`href="${absolute}"`),
      "the page must name the stylesheet absolutely, or it proves nothing",
    );
    // The comment is the documentation a reader hits first when the page fails
    // to render through a route.
    assert.match(response.body, /KNOWN FAILURE, ON PURPOSE/u);
  });

  test("the cross-origin page addresses a different host and port", async () => {
    const response = await get(app, "/cross-origin");
    assert.match(response.body, /<img src="http:\/\/127\.0\.0\.1:9\/blocked\.png"/u);
    assert.match(response.body, /<a href="http:\/\/example\.invalid\/"/u);
  });

  test("slow holds the response and bounds the requested delay", async () => {
    const started = process.hrtime.bigint();
    const response = await get(app, "/slow?ms=150");
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(response.status, 200);
    assert.ok(elapsedMs >= 140, `answered after ${String(elapsedMs)} ms`);
    assert.match(response.body, /data-testid="slow-delay">150</u);

    // The bound itself is asserted without waiting for it: a test that waited
    // out MAX_DELAY_MS would be the hang it is meant to rule out.
    assert.equal(clampDelayMs("999999999"), MAX_DELAY_MS);
    assert.equal(clampDelayMs("-5"), 0);
    assert.equal(clampDelayMs("not-a-number"), 0);
    assert.equal(clampDelayMs(null), 0);
    assert.equal(clampDelayMs("40"), 40);
  });

  test("truncated announces more bytes than it sends", async () => {
    const response = await get(app, "/truncated");
    assert.ok(response.truncated, "the connection must close before the body completes");
    assert.ok(response.body.length > 0, "some bytes must arrive, or it is not a truncation");
  });

  test("the request log records the Host header exactly as received", async () => {
    const beforeCount = logged.length;
    await get(app, "/products", {
      host: "route-alias.internal.invalid",
      "x-forwarded-host": "route-alias.internal.invalid",
      "x-forwarded-proto": "https",
      origin: "https://route-alias.internal.invalid",
    });

    const lines = logged.slice(beforeCount).map((line) => JSON.parse(line) as Record<string, unknown>);
    const entry = lines.find((line) => line["path"] === "/products");
    assert.ok(entry, "no log line for the request");
    assert.equal(entry["level"], "info");
    assert.equal(entry["service"], "static-app");
    assert.equal(entry["method"], "GET");
    assert.equal(entry["status"], 200);
    // Unmodified: this value is the evidence for the gateway's
    // `host_header_mode`, so a normalised copy would be worthless.
    assert.equal(entry["host_header"], "route-alias.internal.invalid");
    assert.equal(entry["x_forwarded_host"], "route-alias.internal.invalid");
    assert.equal(entry["x_forwarded_proto"], "https");

    const record = app.requests.find(
      (candidate) => candidate.path === "/products" && candidate.host === "route-alias.internal.invalid",
    );
    assert.ok(record, "no request record for the request");
    assert.equal(record.origin, "https://route-alias.internal.invalid");
    assert.equal(record.xForwardedProto, "https");
  });

  test("a request with no forwarded headers records their absence", async () => {
    const beforeCount = logged.length;
    await get(app, "/healthz");
    const entry = logged
      .slice(beforeCount)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line["path"] === "/healthz");
    assert.ok(entry);
    assert.equal(entry["x_forwarded_host"], null);
    assert.equal(entry["x_forwarded_proto"], null);
    assert.equal(entry["host_header"], `127.0.0.1:${String(app.port)}`);
  });
});
