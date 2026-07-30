/**
 * Tests for `/events` and `/chunked`: the two streaming HTTP routes RVP-14
 * added so a tunnel's buffering behaviour is observable from outside a
 * browser. The property under test is arrival timing, not just final
 * content — a hop that buffers the whole response until it closes would
 * still produce the right bytes, just all of them at once at the end.
 */

import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { after, before, describe, test } from "node:test";
import {
  clampStreamCount,
  clampStreamIntervalMs,
  MAX_STREAM_RUNTIME_MS,
  startStaticApp,
} from "../src/app.ts";
import type { StaticApp } from "../src/app.ts";

interface Arrival {
  readonly atMs: number;
  readonly chunk: string;
}

interface StreamedResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly arrivals: Arrival[];
  readonly body: string;
}

/**
 * Records the wall-clock time of every `data` event, rather than only the
 * final concatenated body: arrival timing, not just content, is what these
 * routes exist to make observable.
 */
function streamedGet(app: StaticApp, path: string): Promise<StreamedResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, app.origin);
    const started = process.hrtime.bigint();
    const arrivals: Arrival[] = [];

    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
      },
      (response: IncomingMessage) => {
        response.on("data", (chunk: Buffer) => {
          arrivals.push({
            atMs: Number(process.hrtime.bigint() - started) / 1e6,
            chunk: chunk.toString("utf8"),
          });
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            arrivals,
            body: arrivals.map((arrival) => arrival.chunk).join(""),
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

describe("streaming routes", () => {
  let app!: StaticApp;

  before(async () => {
    app = await startStaticApp({ port: 0, host: "127.0.0.1", logLine: () => undefined });
  });

  after(async () => {
    await app.stop();
  });

  test("/events is text/event-stream and delivers ticks incrementally", async () => {
    const count = 5;
    const intervalMs = 80;
    const response = await streamedGet(app, `/events?count=${String(count)}&interval_ms=${String(intervalMs)}`);

    assert.equal(response.status, 200);
    assert.equal(headerText(response.headers["content-type"]), "text/event-stream; charset=utf-8");
    assert.equal(headerText(response.headers["cache-control"]), "no-store");
    assert.equal(headerText(response.headers["x-accel-buffering"]), "no");

    // No single read may carry more than one tick: that is exactly what a
    // hop that buffers the whole stream would produce.
    for (const arrival of response.arrivals) {
      const ticks = arrival.chunk.match(/event: tick/gu) ?? [];
      assert.ok(ticks.length <= 1, `one read delivered ${String(ticks.length)} ticks at once`);
    }

    assert.ok(response.arrivals.length >= 2, "expected more than one read from the response");
    const first = response.arrivals[0]!;
    const last = response.arrivals[response.arrivals.length - 1]!;
    const spanMs = last.atMs - first.atMs;
    assert.ok(
      spanMs >= (count - 1) * intervalMs * 0.5,
      `arrivals spanned only ${String(spanMs)} ms for ${String(count)} events ${String(intervalMs)} ms apart`,
    );

    for (let seq = 1; seq <= count; seq += 1) {
      assert.match(response.body, new RegExp(`id: ${String(seq)}\\nevent: tick`, "u"));
    }
    assert.match(response.body, new RegExp(`event: done\\ndata: \\{"count":${String(count)}\\}`, "u"));
  });

  test("/events clamps count, interval and their product to the 60s bound", async () => {
    // Exercised live with a count above the max but a small interval, so the
    // count clamp is observable without the run taking the full clamped
    // duration: 200 events at 10 ms apart is ~2 s, not 60 s.
    const response = await streamedGet(app, "/events?count=1000&interval_ms=10");
    assert.equal(response.status, 200);
    assert.match(response.body, /event: done\ndata: \{"count":200\}/u);

    // The product bound itself — where a large count forces the interval
    // down rather than the run past MAX_STREAM_RUNTIME_MS — is exact enough
    // to assert on directly rather than by waiting out a live 60 s stream.
    assert.equal(clampStreamCount("1000", 5, 200), 200);
    assert.equal(clampStreamCount(null, 5, 200), 5);
    assert.equal(clampStreamCount("not-a-number", 5, 200), 5);
    assert.equal(clampStreamCount("-3", 5, 200), 5);

    assert.equal(clampStreamIntervalMs("1000", 300, 5000, 200), Math.floor(MAX_STREAM_RUNTIME_MS / 200));
    assert.equal(clampStreamIntervalMs(null, 300, 5000, 5), 300);
    assert.equal(clampStreamIntervalMs("50", 300, 5000, 5), 50);
  });

  test("/chunked has no content-length and delivers chunks incrementally", async () => {
    const chunks = 5;
    const intervalMs = 80;
    const response = await streamedGet(app, `/chunked?chunks=${String(chunks)}&interval_ms=${String(intervalMs)}`);

    assert.equal(response.status, 200);
    assert.equal(headerText(response.headers["content-type"]), "text/plain; charset=utf-8");
    assert.equal(headerText(response.headers["cache-control"]), "no-store");
    assert.equal(response.headers["content-length"], undefined);
    assert.equal(headerText(response.headers["transfer-encoding"]), "chunked");

    for (const arrival of response.arrivals) {
      const lines = arrival.chunk.match(/chunk \d+ \d+/gu) ?? [];
      assert.ok(lines.length <= 1, `one read delivered ${String(lines.length)} chunk lines at once`);
    }

    assert.ok(response.arrivals.length >= 2, "expected more than one read from the response");
    const first = response.arrivals[0]!;
    const last = response.arrivals[response.arrivals.length - 1]!;
    const spanMs = last.atMs - first.atMs;
    assert.ok(
      spanMs >= (chunks - 1) * intervalMs * 0.5,
      `arrivals spanned only ${String(spanMs)} ms for ${String(chunks)} chunks ${String(intervalMs)} ms apart`,
    );

    for (let index = 1; index <= chunks; index += 1) {
      assert.match(response.body, new RegExp(`chunk ${String(index)} \\d+`, "u"));
    }
    assert.match(response.body, new RegExp(`chunks done ${String(chunks)}`, "u"));
  });

  test("/events and /chunked accept a zero count without scheduling a timer", async () => {
    const events = await streamedGet(app, "/events?count=0");
    assert.equal(events.body, `event: done\ndata: {"count":0}\n\n`);

    const chunked = await streamedGet(app, "/chunked?chunks=0");
    assert.equal(chunked.body, "chunks done 0\n");
  });
});
