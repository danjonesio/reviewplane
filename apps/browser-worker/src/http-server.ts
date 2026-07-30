/**
 * The worker's internal listener.
 *
 * It is deliberately built on `node:http` rather than on a framework: the
 * worker is the component that executes untrusted page content, and
 * `docs/SECURITY.md` sections 10 and 19 argue for the smallest image and
 * dependency set that will do the job. The surface is four routes, all of them
 * called only by the control-plane server over an internal network that
 * `deploy/compose` does not publish.
 *
 * Every route except the liveness probe requires the command credential the
 * control plane presents. `docs/SECURITY.md` section 6.4 gives the worker its
 * own identity; this is the other half of that mutual authentication.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

import {
  decodeBrowserFrame,
  encodeBrowserFrame,
  type BrowserFrame,
  type Envelope,
  type MessageType,
} from "@reviewplane/protocol/browser";
import {
  LIVE_MODE_VALUES,
  LIVE_RECORD_FRAME_PAYLOAD,
  decodeLiveViewFrame,
  encodeLiveMessageRecord,
  encodeLiveRecord,
  encodeLiveViewFrame,
  type LiveMode,
} from "@reviewplane/protocol/live-view";

import type { WorkerConfig } from "./config.ts";
import { newId } from "./ids.ts";
import type { Logger } from "./logging.ts";
import { SessionRefusal, type SessionManager } from "./session/manager.ts";
import type { LiveTransport } from "./session/screencast.ts";

/** Bound on a request body, applied before anything is parsed. */
const MAX_REQUEST_BYTES = 262144;

export interface WorkerServerOptions {
  readonly config: WorkerConfig;
  readonly manager: SessionManager;
  readonly logger: Logger;
  /** Worker identity assigned by the control plane, once registration ran. */
  readonly workerId: () => string | null;
}

/** Constant-time bearer comparison (`docs/SECURITY.md` section 18: never logged). */
export function credentialMatches(presented: string, expected: string): boolean {
  const left = Buffer.from(presented, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) {
    // Compare anyway so the rejection path costs the same either way.
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer +([!-~]+)$/u.exec(header);
  return match === null ? null : (match[1] as string);
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      throw new RequestTooLarge(`request body exceeds ${String(MAX_REQUEST_BYTES)} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

class RequestTooLarge extends Error {}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(encoded)),
    "cache-control": "no-store",
  });
  response.end(encoded);
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { error: { code, message } });
}

/** `/internal/v1/browser-sessions/{id}/live` and its `/quality` sub-route. */
const LIVE_PATH = /^\/internal\/v1\/browser-sessions\/([A-Za-z0-9_-]{1,64})\/live(\/quality)?$/u;

/**
 * The producer's transport over an HTTP response body.
 *
 * `writable` is the socket's own backpressure signal rather than a counter of
 * our own: `response.write` returns false when the kernel buffer is full, and
 * that is exactly the moment `docs/ARCHITECTURE.md` section 6.3 wants frames
 * dropped instead of queued. Nothing is buffered here — the producer holds the
 * only backlog there is, and it is two frames deep.
 */
function responseTransport(response: ServerResponse, onDrain: () => void): LiveTransport {
  let saturated = false;
  response.on("drain", () => {
    saturated = false;
    onDrain();
  });
  return {
    get writable(): boolean {
      return !saturated && response.writable;
    },
    writeMessage(json: string): void {
      if (!response.writable) return;
      if (!response.write(encodeLiveMessageRecord(json))) saturated = true;
    },
    writeFrame(metadataJson: string, payload: Uint8Array): void {
      if (!response.writable) return;
      // Metadata then payload, always adjacent: the payload's only description
      // is the metadata immediately before it (`docs/API.md` section 18.2).
      response.write(encodeLiveMessageRecord(metadataJson));
      if (!response.write(encodeLiveRecord(LIVE_RECORD_FRAME_PAYLOAD, payload))) saturated = true;
    },
  };
}

export function createWorkerServer(options: WorkerServerOptions): Server {
  const { config, manager, logger } = options;

  const envelopeFor = (type: MessageType, extra: Partial<Envelope>): Envelope => ({
    protocol_version: 1,
    message_id: newId("msg_"),
    type,
    sent_at: new Date().toISOString(),
    ...(options.workerId() === null ? {} : { worker_id: options.workerId() as string }),
    ...extra,
  });

  /**
   * The live-frame routes.
   *
   * `GET .../live` opens the producer and streams length-prefixed records
   * until the caller disconnects; `POST .../live/quality` relays one viewer
   * request to the scheduler. The stream is one-way by design, so a request
   * arrives on its own connection and cannot interleave with a frame payload.
   */
  const handleLive = async (
    request: IncomingMessage,
    response: ServerResponse,
    browserSessionId: string,
    isQualityRoute: boolean,
    url: URL,
  ): Promise<void> => {
    if (isQualityRoute) {
      if (request.method !== "POST") {
        sendError(response, 405, "UNSUPPORTED_CAPABILITY", "Only POST is supported on this route.");
        return;
      }
      const raw = await readBody(request);
      const decoded = decodeLiveViewFrame(raw);
      if (!decoded.ok || decoded.value.type !== "live.quality_request") {
        sendError(
          response,
          400,
          decoded.ok ? "UNSUPPORTED_CAPABILITY" : (decoded.error.errorClass ?? "POLICY_DENIED"),
          decoded.ok ? "A live.quality_request message is required." : decoded.error.message,
        );
        return;
      }
      const requested = decoded.value.payload;
      const applied = await manager.requestLiveQuality(browserSessionId, {
        ...(requested.mode === undefined ? {} : { mode: requested.mode }),
        ...(requested.max_fps === undefined ? {} : { maxFps: requested.max_fps }),
        ...(requested.max_width === undefined ? {} : { maxWidth: requested.max_width }),
        ...(requested.max_height === undefined ? {} : { maxHeight: requested.max_height }),
      });
      const producer = manager.liveProducer(browserSessionId);
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(
        encodeLiveViewFrame({
          envelope: {
            protocol_version: 1,
            message_id: newId("msg_"),
            type: "live.quality",
            sent_at: new Date().toISOString(),
            browser_session_id: browserSessionId,
            stream_id: producer?.streamId ?? browserSessionId,
          },
          type: "live.quality",
          payload: applied,
        }),
      );
      return;
    }

    if (request.method !== "GET") {
      sendError(response, 405, "UNSUPPORTED_CAPABILITY", "Only GET is supported on this route.");
      return;
    }

    const requestedMode = url.searchParams.get("mode") ?? "session_room";
    if (!(LIVE_MODE_VALUES as readonly string[]).includes(requestedMode)) {
      sendError(response, 400, "UNSUPPORTED_CAPABILITY", "mode must be a live-view mode.");
      return;
    }

    // Headers go out before the producer starts, so the control plane can tell
    // a refused stream from an accepted one that has not painted yet.
    response.writeHead(200, {
      "content-type": "application/vnd.reviewplane.live-view.v1",
      "cache-control": "no-store",
      connection: "close",
    });

    let stopped = false;
    const producerRef: { current: { stop: () => Promise<void>; flush: () => void } | null } = {
      current: null,
    };
    const stop = (why: string): void => {
      if (stopped) return;
      stopped = true;
      logger.info("live stream closed", { browser_session_id: browserSessionId, reason: why });
      void manager.stopLive(browserSessionId).catch(() => undefined);
      if (!response.writableEnded) response.end();
    };
    // A viewer that goes away is the signal to stop capturing. Streaming to
    // nobody is the failure `docs/ARCHITECTURE.md` section 6.3 is written
    // against, so every way the connection can end is wired to the same stop.
    request.on("close", () => {
      stop("request closed");
    });
    response.on("close", () => {
      stop("response closed");
    });
    response.on("error", () => {
      stop("response error");
    });

    const transport = responseTransport(response, () => {
      producerRef.current?.flush();
    });

    try {
      const producer = await manager.startLive(
        browserSessionId,
        requestedMode as LiveMode,
        transport,
      );
      producerRef.current = producer;
      if (stopped) {
        // The caller disconnected while Chromium was attaching.
        await manager.stopLive(browserSessionId);
      }
    } catch (error) {
      if (error instanceof SessionRefusal) {
        stopped = true;
        // The status line is already sent, so the refusal travels as a
        // live.error record rather than as an HTTP status.
        transport.writeMessage(
          encodeLiveViewFrame({
            envelope: {
              protocol_version: 1,
              message_id: newId("msg_"),
              type: "live.error",
              sent_at: new Date().toISOString(),
              browser_session_id: browserSessionId,
            },
            type: "live.error",
            payload: {
              code: error.error.code === "UNSUPPORTED_CAPABILITY"
                ? "UNSUPPORTED_CAPABILITY"
                : error.error.code === "RESOURCE_NOT_FOUND"
                  ? "RESOURCE_NOT_FOUND"
                  : error.error.code === "POLICY_DENIED"
                    ? "POLICY_DENIED"
                    : "BROWSER_SESSION_NOT_ACTIVE",
              state:
                error.error.code === "UNSUPPORTED_CAPABILITY"
                  ? "live_capture_unavailable"
                  : error.error.code === "RESOURCE_NOT_FOUND"
                    ? "browser_session_not_found"
                    : "browser_session_ended",
              message: error.error.message,
              retryable: error.error.retryable,
            },
          }),
        );
        response.end();
        return;
      }
      logger.error("live stream could not start", {
        browser_session_id: browserSessionId,
        detail: error instanceof Error ? error.message : String(error),
      });
      stop("start failed");
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://worker.invalid");
    const path = url.pathname;

    if (request.method === "GET" && path === "/internal/v1/health") {
      // Liveness only: no session identifiers, no page content.
      sendJson(response, 200, {
        status: "ok",
        worker: config.name,
        active_sessions: manager.activeSessions,
        capacity: config.capacity,
      });
      return;
    }

    const presented = bearerToken(request.headers.authorization);
    if (presented === null || !credentialMatches(presented, config.commandCredential)) {
      logger.warn("worker command credential rejected", { path, method: request.method ?? "" });
      sendError(response, 401, "AUTHENTICATION_REQUIRED", "A worker command credential is required.");
      return;
    }

    const live = LIVE_PATH.exec(path);
    if (live !== null) {
      await handleLive(request, response, live[1] as string, live[2] !== undefined, url);
      return;
    }

    if (request.method !== "POST") {
      sendError(response, 405, "UNSUPPORTED_CAPABILITY", "Only POST is supported on this route.");
      return;
    }

    let raw: Buffer;
    try {
      raw = await readBody(request);
    } catch (error) {
      if (error instanceof RequestTooLarge) {
        sendError(response, 413, "POLICY_DENIED", error.message);
        return;
      }
      throw error;
    }

    const decoded = decodeBrowserFrame(raw);
    if (!decoded.ok) {
      logger.warn("worker refused a frame", { reason: decoded.error.reason, path });
      sendError(
        response,
        400,
        decoded.error.errorClass ?? "POLICY_DENIED",
        decoded.error.message,
      );
      return;
    }
    const frame = decoded.value;

    try {
      if (path === "/internal/v1/sessions" && frame.type === "browser_session.allocate") {
        const browserSessionId = frame.envelope.browser_session_id;
        if (browserSessionId === undefined) {
          sendError(response, 400, "POLICY_DENIED", "The allocation names no browser session.");
          return;
        }
        const session = await manager.allocate(browserSessionId, frame.payload);
        const reply: BrowserFrame = {
          envelope: envelopeFor("browser_session.allocated", {
            browser_session_id: browserSessionId,
            correlation_id: frame.envelope.message_id,
          }),
          type: "browser_session.allocated",
          payload: {
            status: session.status,
            browser_type: "chromium",
            browser_version: session.browserVersion,
            viewport: session.viewport,
            allocated_at: new Date().toISOString(),
          },
        };
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(encodeBrowserFrame(reply));
        return;
      }

      if (path === "/internal/v1/commands" && frame.type === "browser.command") {
        const browserSessionId = frame.envelope.browser_session_id as string;
        const controller = frame.envelope.controller;
        const epoch = frame.envelope.control_epoch;
        const sequence = frame.envelope.sequence;
        if (controller === undefined || epoch === undefined || sequence === undefined) {
          // The schema already requires these; this keeps the type narrowing
          // honest rather than asserting it away.
          sendError(response, 400, "POLICY_DENIED", "The command envelope is incomplete.");
          return;
        }
        const result = await manager.handleCommand(
          browserSessionId,
          controller,
          epoch,
          sequence,
          frame.payload,
        );
        if (!result.ok) {
          logger.warn("browser command refused", {
            browser_session_id: browserSessionId,
            command: result.command,
            code: result.error?.code ?? "INTERNAL_ERROR",
            sequence: String(sequence),
            presented_epoch: String(epoch),
            current_epoch: String(result.control_epoch),
          });
        }
        const reply: BrowserFrame = {
          envelope: envelopeFor("browser.command.result", {
            browser_session_id: browserSessionId,
            controller,
            control_epoch: result.control_epoch,
            sequence,
            correlation_id: frame.envelope.message_id,
          }),
          type: "browser.command.result",
          payload: result,
        };
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(encodeBrowserFrame(reply));
        return;
      }

      if (path === "/internal/v1/terminate" && frame.type === "browser_session.terminate") {
        const browserSessionId = frame.envelope.browser_session_id as string;
        const report = await manager.terminate(
          browserSessionId,
          frame.payload.reason,
          frame.payload.detail,
        );
        const reply: BrowserFrame = {
          envelope: envelopeFor("browser_session.status", {
            browser_session_id: browserSessionId,
            correlation_id: frame.envelope.message_id,
          }),
          type: "browser_session.status",
          payload: report,
        };
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(encodeBrowserFrame(reply));
        return;
      }

      sendError(response, 404, "RESOURCE_NOT_FOUND", "No such worker route for this message type.");
    } catch (error) {
      if (error instanceof SessionRefusal) {
        const status = error.error.code === "BROWSER_CAPACITY_EXHAUSTED" ? 503 : 409;
        logger.warn("worker refused a request", { code: error.error.code, path });
        sendError(response, status, error.error.code, error.error.message);
        return;
      }
      logger.error("worker request failed", {
        path,
        detail: error instanceof Error ? error.message : String(error),
      });
      sendError(response, 500, "INTERNAL_ERROR", "The worker could not complete the request.");
    }
  };

  return createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) {
        sendError(response, 500, "INTERNAL_ERROR", "The worker could not complete the request.");
      } else {
        response.end();
      }
    });
  });
}
