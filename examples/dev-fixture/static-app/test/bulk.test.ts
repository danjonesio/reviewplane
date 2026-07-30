/**
 * Tests for `/bulk`: the fixed-size payload route RVP-14 added for the
 * tunnel-throughput baseline in `docs/TESTING.md` §12. The properties under
 * test are the ones a throughput measurement depends on being honest: the
 * announced length matches the delivered length exactly, an out-of-range or
 * malformed request degrades to a documented default rather than erroring,
 * and the body is not compressed by this fixture itself.
 */

import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { after, before, describe, test } from "node:test";
import { clampBulkBytes, startStaticApp } from "../src/app.ts";
import type { StaticApp } from "../src/app.ts";

interface BinaryResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

function getBinary(app: StaticApp, path: string): Promise<BinaryResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, app.origin);
    const chunks: Buffer[] = [];
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
      },
      (response: IncomingMessage) => {
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function headerText(value: IncomingHttpHeaders[string]): string {
  return Array.isArray(value) ? value.join(", ") : (value ?? "");
}

describe("/bulk", () => {
  let app!: StaticApp;

  before(async () => {
    app = await startStaticApp({ port: 0, host: "127.0.0.1", logLine: () => undefined });
  });

  after(async () => {
    await app.stop();
  });

  test("delivers exactly the requested number of bytes, matching content-length", async () => {
    const response = await getBinary(app, "/bulk?bytes=12345");
    assert.equal(response.status, 200);
    assert.equal(headerText(response.headers["content-type"]), "application/octet-stream");
    assert.equal(headerText(response.headers["cache-control"]), "no-store");
    assert.equal(headerText(response.headers["content-length"]), "12345");
    assert.equal(response.body.length, 12345);
    // No content-encoding: this fixture must not let a proxy's compression
    // (or its own) stand in for what the tunnel actually moved.
    assert.equal(response.headers["content-encoding"], undefined);
  });

  test("defaults to 4 MiB when bytes is omitted", async () => {
    const response = await getBinary(app, "/bulk");
    assert.equal(response.body.length, 4 * 1024 * 1024);
    assert.equal(headerText(response.headers["content-length"]), String(4 * 1024 * 1024));
  });

  test("clamps a request above the 32 MiB maximum", async () => {
    const response = await getBinary(app, "/bulk?bytes=999999999");
    assert.equal(response.body.length, 32 * 1024 * 1024);
    assert.equal(headerText(response.headers["content-length"]), String(32 * 1024 * 1024));
  });

  test("falls back to the default for a non-numeric bytes value, rather than erroring", async () => {
    const response = await getBinary(app, "/bulk?bytes=not-a-number");
    assert.equal(response.status, 200);
    assert.equal(response.body.length, 4 * 1024 * 1024);

    assert.equal(clampBulkBytes("not-a-number"), 4 * 1024 * 1024);
    assert.equal(clampBulkBytes(null), 4 * 1024 * 1024);
    assert.equal(clampBulkBytes("-10"), 4 * 1024 * 1024);
    assert.equal(clampBulkBytes("999999999"), 32 * 1024 * 1024);
    assert.equal(clampBulkBytes("2048"), 2048);
  });

  test("the body is deterministic and does not look like a repeating pattern", async () => {
    const first = await getBinary(app, "/bulk?bytes=2048");
    const second = await getBinary(app, "/bulk?bytes=2048");
    assert.deepEqual(first.body, second.body, "the same request must produce the same bytes");

    // A crude compressibility smoke test: a body built from a short repeating
    // pattern would have very few distinct byte values in a short window. The
    // deterministic hash this route uses should not.
    const distinctValues = new Set(first.body.subarray(0, 256)).size;
    assert.ok(distinctValues > 64, `expected a spread of byte values, saw ${String(distinctValues)} distinct`);
  });

  test("bytes=0 answers a well-formed, empty response", async () => {
    const response = await getBinary(app, "/bulk?bytes=0");
    assert.equal(response.status, 200);
    assert.equal(headerText(response.headers["content-length"]), "0");
    assert.equal(response.body.length, 0);
  });
});
