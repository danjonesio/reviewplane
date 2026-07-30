/**
 * The control plane's client for a worker's live-frame stream.
 *
 * It is a separate client from `BrowserWorkerClient` because the shape is
 * different in the way that matters: a command is one request and one
 * response, while this is one request whose response body never ends until one
 * side closes it. The credential and the direction are the same — the control
 * plane presents the worker command credential of `docs/ARCHITECTURE.md`
 * section 11 — so the trust boundary does not move.
 *
 * Closing the stream is the only mechanism that stops the producer. There is
 * no "stop" message: the worker stops capturing when this response body is
 * abandoned, which means a control plane that crashes cannot leave a worker
 * streaming to nobody.
 */

import {
  LiveRecordDecoder,
  decodeLiveViewFrame,
  encodeLiveViewFrame,
  type LiveMode,
  type LiveRecord,
  type QualityRequest,
  type QualityState,
} from "@reviewplane/protocol/live-view";

import { ApiError } from "../../errors.ts";
import { newId } from "../../ids.ts";

export interface WorkerLiveClientOptions {
  readonly endpoint: string;
  readonly credential: string;
  readonly fetchImplementation?: typeof fetch;
}

export interface WorkerLiveStream {
  /** Records in arrival order, message and payload interleaved as sent. */
  readonly records: AsyncIterable<LiveRecord>;
  /** Abandons the stream, which is what stops the producer. */
  close(): void;
}

export class WorkerLiveClient {
  readonly #endpoint: string;
  readonly #credential: string;
  readonly #fetch: typeof fetch;

  constructor(options: WorkerLiveClientOptions) {
    this.#endpoint = options.endpoint.replace(/\/+$/u, "");
    this.#credential = options.credential;
    this.#fetch = options.fetchImplementation ?? globalThis.fetch;
  }

  async open(browserSessionId: string, mode: LiveMode): Promise<WorkerLiveStream> {
    const controller = new AbortController();
    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#endpoint}/internal/v1/browser-sessions/${encodeURIComponent(browserSessionId)}/live?mode=${mode}`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${this.#credential}` },
          signal: controller.signal,
        },
      );
    } catch (error) {
      throw new ApiError(
        "BROWSER_SESSION_NOT_ACTIVE",
        `The browser worker did not accept a live stream: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok || response.body === null) {
      controller.abort();
      throw new ApiError(
        "BROWSER_SESSION_NOT_ACTIVE",
        `The browser worker refused a live stream with status ${String(response.status)}.`,
      );
    }

    // The reader is taken now rather than when iteration starts, so `close`
    // can cancel it whether or not anything has read a byte yet. Aborting the
    // request alone is not enough: a body already handed over keeps producing
    // until its reader is cancelled.
    const reader = response.body.getReader();
    const records = (async function* iterate(): AsyncGenerator<LiveRecord> {
      const decoder = new LiveRecordDecoder();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return;
          if (chunk.value === undefined) continue;
          for (const record of decoder.push(chunk.value)) yield record;
        }
      } finally {
        reader.cancel().catch(() => undefined);
      }
    })();

    return {
      records,
      close(): void {
        reader.cancel().catch(() => undefined);
        controller.abort();
      },
    };
  }

  /**
   * Relays one viewer request. It is a separate request rather than a message
   * on the stream because the stream is one-way: a request travelling the
   * other way would have to interleave with a binary frame payload, and the
   * separation `docs/API.md` section 18.2 requires is easier to keep than to
   * restore.
   */
  async requestQuality(
    browserSessionId: string,
    request: QualityRequest,
  ): Promise<QualityState> {
    const response = await this.#fetch(
      `${this.#endpoint}/internal/v1/browser-sessions/${encodeURIComponent(browserSessionId)}/live/quality`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#credential}`,
          "content-type": "application/json",
        },
        body: encodeLiveViewFrame({
          envelope: {
            protocol_version: 1,
            message_id: newId("msg_"),
            type: "live.quality_request",
            sent_at: new Date().toISOString(),
            browser_session_id: browserSessionId,
          },
          type: "live.quality_request",
          payload: request,
        }),
      },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new ApiError(
        "BROWSER_SESSION_NOT_ACTIVE",
        `The browser worker refused a quality request with status ${String(response.status)}.`,
      );
    }
    const decoded = decodeLiveViewFrame(text);
    if (!decoded.ok || decoded.value.type !== "live.quality") {
      throw new ApiError(
        "INTERNAL_ERROR",
        "The browser worker answered a quality request with the wrong message.",
      );
    }
    return decoded.value.payload;
  }
}
