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

import type { WorkerConfig } from "./config.ts";
import { newId } from "./ids.ts";
import type { Logger } from "./logging.ts";
import { SessionRefusal, type SessionManager } from "./session/manager.ts";

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
