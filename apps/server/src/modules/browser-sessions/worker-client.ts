/**
 * The control plane's client for a browser worker.
 *
 * Commands travel over the mutually authenticated internal channel of
 * `docs/ARCHITECTURE.md` section 11: this side presents the worker command
 * credential, and the worker presents its own credential when it calls back.
 * Frames are the generated browser-protocol frames, so the envelope always
 * carries the section 6.4 fields and neither side can invent one.
 */

import {
  decodeBrowserFrame,
  encodeBrowserFrame,
  type BrowserCommand,
  type BrowserCommandResult,
  type BrowserFrame,
  type ControllerIdentity,
  type Envelope,
  type MessageType,
  type SessionAllocate,
  type SessionAllocated,
  type SessionStatusReport,
  type TerminationReason,
} from "@reviewplane/protocol/browser";

import { ApiError } from "../../errors.ts";
import { newId } from "../../ids.ts";

export interface WorkerClientOptions {
  readonly endpoint: string;
  readonly credential: string;
  readonly timeoutMs: number;
  readonly fetchImplementation?: typeof fetch;
}

export class BrowserWorkerClient {
  readonly #endpoint: string;
  readonly #credential: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: WorkerClientOptions) {
    this.#endpoint = options.endpoint.replace(/\/+$/u, "");
    this.#credential = options.credential;
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetchImplementation ?? globalThis.fetch;
  }

  #envelope(type: MessageType, workerId: string, extra: Partial<Envelope>): Envelope {
    return {
      protocol_version: 1,
      message_id: newId("msg_"),
      type,
      sent_at: new Date().toISOString(),
      worker_id: workerId,
      ...extra,
    };
  }

  async #exchange(path: string, frame: BrowserFrame): Promise<BrowserFrame> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#endpoint}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#credential}`,
          "content-type": "application/json",
        },
        body: encodeBrowserFrame(frame),
        signal: controller.signal,
      });
    } catch (error) {
      throw new ApiError(
        "BROWSER_SESSION_NOT_ACTIVE",
        `The browser worker did not answer: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    if (!response.ok) {
      let code = "INTERNAL_ERROR";
      let message = `The browser worker refused the request with status ${String(response.status)}.`;
      try {
        const body = JSON.parse(text) as { error?: { code?: string; message?: string } };
        code = body.error?.code ?? code;
        message = body.error?.message ?? message;
      } catch {
        // Body was not the expected envelope; the status carries the meaning.
      }
      throw new ApiError(mapWorkerCode(code), message);
    }

    const decoded = decodeBrowserFrame(text);
    if (!decoded.ok) {
      throw new ApiError(
        "INTERNAL_ERROR",
        `The browser worker returned a frame the control plane refused: ${decoded.error.reason}`,
      );
    }
    return decoded.value;
  }

  async allocate(
    workerId: string,
    browserSessionId: string,
    request: SessionAllocate,
  ): Promise<SessionAllocated> {
    const frame = await this.#exchange("/internal/v1/sessions", {
      envelope: this.#envelope("browser_session.allocate", workerId, {
        browser_session_id: browserSessionId,
      }),
      type: "browser_session.allocate",
      payload: request,
    });
    if (frame.type !== "browser_session.allocated") {
      throw new ApiError("INTERNAL_ERROR", "The browser worker answered an allocation with the wrong message.");
    }
    return frame.payload;
  }

  async command(
    workerId: string,
    browserSessionId: string,
    controller: ControllerIdentity,
    controlEpoch: number,
    sequence: number,
    command: BrowserCommand,
  ): Promise<BrowserCommandResult> {
    const frame = await this.#exchange("/internal/v1/commands", {
      envelope: this.#envelope("browser.command", workerId, {
        browser_session_id: browserSessionId,
        controller,
        control_epoch: controlEpoch,
        sequence,
      }),
      type: "browser.command",
      payload: command,
    });
    if (frame.type !== "browser.command.result") {
      throw new ApiError("INTERNAL_ERROR", "The browser worker answered a command with the wrong message.");
    }
    return frame.payload;
  }

  async terminate(
    workerId: string,
    browserSessionId: string,
    reason: TerminationReason,
    detail?: string,
  ): Promise<SessionStatusReport> {
    const frame = await this.#exchange("/internal/v1/terminate", {
      envelope: this.#envelope("browser_session.terminate", workerId, {
        browser_session_id: browserSessionId,
      }),
      type: "browser_session.terminate",
      payload: { reason, ...(detail === undefined ? {} : { detail }) },
    });
    if (frame.type !== "browser_session.status") {
      throw new ApiError("INTERNAL_ERROR", "The browser worker answered a termination with the wrong message.");
    }
    return frame.payload;
  }
}

/** Worker error classes are the MCP codes already; unknown ones fail closed. */
function mapWorkerCode(code: string): ApiError["code"] {
  const known: readonly string[] = [
    "AUTHENTICATION_REQUIRED",
    "AUTHORISATION_DENIED",
    "PROJECT_CONTEXT_MISMATCH",
    "RESOURCE_NOT_FOUND",
    "RESOURCE_STALE",
    "BROWSER_CAPACITY_EXHAUSTED",
    "BROWSER_SESSION_NOT_ACTIVE",
    "CONTROL_NOT_OWNED",
    "CONTROL_EPOCH_STALE",
    "BROWSER_COMMAND_TIMEOUT",
    "POLICY_DENIED",
    "ARTEFACT_UPLOAD_INCOMPLETE",
    "UNSUPPORTED_CAPABILITY",
    "INTERNAL_ERROR",
  ];
  return (known.includes(code) ? code : "INTERNAL_ERROR") as ApiError["code"];
}
