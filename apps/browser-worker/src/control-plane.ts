/**
 * The worker's client for the control plane.
 *
 * `docs/ARCHITECTURE.md` section 11 requires worker identity and mutual
 * authentication. In Stage 0 that is two distinct credentials over the
 * internal network: this side presents `REVIEWPLANE_WORKER_CREDENTIAL` on
 * every call, and the control plane presents a different credential to the
 * worker's own listener. Neither credential works in the other direction, and
 * neither is an administrator token.
 *
 * The worker holds no artefact-store credentials (ADR-0012): a capture is
 * uploaded through the control-plane artefact API, and the control plane
 * verifies size and hash before the artefact becomes available
 * (`docs/API.md` section 15). If verification does not succeed the worker
 * reports `ARTEFACT_UPLOAD_INCOMPLETE` and no evidence is claimed.
 */

import { createHash } from "node:crypto";

import {
  decodeBrowserFrame,
  encodeBrowserFrame,
  type BrowserFrame,
  type Envelope,
  type ScreenshotResult,
  type SessionLimits,
  type SessionStatusReport,
  type WorkerHeartbeatAck,
  type WorkerRegistrationAck,
} from "@reviewplane/protocol/browser";

import { ArtefactUploadError, type ArtefactUploadRequest } from "./session/commands.ts";
import { newId } from "./ids.ts";

export interface ControlPlaneOptions {
  readonly baseUrl: string;
  readonly credential: string;
  readonly workerName: string;
  readonly requestTimeoutMs?: number;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetchImplementation?: typeof fetch;
}

interface ApiEnvelope<T> {
  readonly data?: T;
  readonly error?: { readonly code?: string; readonly message?: string };
}

interface UploadIntent {
  readonly artefact_id: string;
  readonly upload_path: string;
}

interface ArtefactRecord {
  readonly id: string;
  readonly state: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly content_type: string;
}

export class ControlPlaneClient {
  #baseUrl: string;
  #credential: string;
  #workerName: string;
  #timeoutMs: number;
  #fetch: typeof fetch;
  #workerId: string | null = null;

  constructor(options: ControlPlaneOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.#credential = options.credential;
    this.#workerName = options.workerName;
    this.#timeoutMs = options.requestTimeoutMs ?? 30000;
    this.#fetch = options.fetchImplementation ?? globalThis.fetch;
  }

  get workerId(): string | null {
    return this.#workerId;
  }

  #headers(contentType: string): Record<string, string> {
    return {
      // Never logged: docs/SECURITY.md section 18 forbids authorisation
      // headers in logs, and nothing in this client logs its own request.
      authorization: `Bearer ${this.#credential}`,
      "content-type": contentType,
    };
  }

  async #send(path: string, body: BodyInit, contentType: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);
    try {
      return await this.#fetch(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers: this.#headers(contentType),
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  #envelope(type: Envelope["type"], extra: Partial<Envelope> = {}): Envelope {
    return {
      protocol_version: 1,
      message_id: newId("msg_"),
      type,
      sent_at: new Date().toISOString(),
      ...(this.#workerId === null ? {} : { worker_id: this.#workerId }),
      ...extra,
    };
  }

  /** Registers the worker and records the identity the control plane assigns. */
  async register(registration: {
    readonly workerVersion: string;
    readonly browserVersion: string;
    readonly capacity: number;
    readonly labels: readonly string[];
    readonly sandboxEnabled: boolean;
    readonly startedAt: Date;
  }): Promise<{ workerId: string; ack: WorkerRegistrationAck }> {
    const frame: BrowserFrame = {
      envelope: this.#envelope("worker.register"),
      type: "worker.register",
      payload: {
        worker_name: this.#workerName,
        worker_version: registration.workerVersion,
        browser_type: "chromium",
        browser_version: registration.browserVersion,
        capacity: registration.capacity,
        labels: [...registration.labels],
        sandbox_enabled: registration.sandboxEnabled,
        started_at: registration.startedAt.toISOString(),
      },
    };
    const response = await this.#send(
      "/internal/v1/workers/register",
      encodeBrowserFrame(frame),
      "application/json",
    );
    if (!response.ok) {
      throw new Error(`worker registration was refused with status ${String(response.status)}`);
    }
    const body = (await response.json()) as { worker_id?: string; payload?: WorkerRegistrationAck };
    const workerId = body.worker_id;
    const ack = body.payload;
    if (typeof workerId !== "string" || ack === undefined || !ack.accepted) {
      throw new Error("worker registration was not accepted by the control plane");
    }
    this.#workerId = workerId;
    return { workerId, ack };
  }

  /**
   * Heartbeats and returns the acknowledgement, which restates the worker's
   * current project assignment (ADR-0026).
   *
   * The assignment used to arrive once, in the registration acknowledgement,
   * and was cached for the life of the process. So an assignment an
   * administrator *removed* went on being served until the worker restarted —
   * an authorisation gap, not merely an inconvenience. It is restated here so
   * that a revocation takes effect within one heartbeat interval.
   *
   * A heartbeat the control plane could not answer returns `null`. The caller
   * keeps the assignment it has: losing an answer is not the same as being told
   * the set is empty, and treating it as empty would take a working worker out
   * of service every time the control plane restarted.
   */
  async heartbeat(state: {
    readonly activeSessions: number;
    readonly capacity: number;
    readonly residentMemoryMb: number;
  }): Promise<WorkerHeartbeatAck | null> {
    const frame: BrowserFrame = {
      envelope: this.#envelope("worker.heartbeat"),
      type: "worker.heartbeat",
      payload: {
        active_sessions: state.activeSessions,
        capacity: state.capacity,
        resident_memory_mb: state.residentMemoryMb,
        observed_at: new Date().toISOString(),
      },
    };
    const response = await this.#send(
      "/internal/v1/workers/heartbeat",
      encodeBrowserFrame(frame),
      "application/json",
    );
    if (!response.ok) return null;
    const text = await response.text();
    if (text === "") return null;
    const decoded = decodeBrowserFrame(text);
    if (!decoded.ok || decoded.value.type !== "worker.heartbeat.ack") return null;
    return decoded.value.payload;
  }

  /** Reports a lifecycle transition the worker observed. */
  async reportStatus(browserSessionId: string, report: SessionStatusReport): Promise<void> {
    const frame: BrowserFrame = {
      envelope: this.#envelope("browser_session.status", {
        browser_session_id: browserSessionId,
      }),
      type: "browser_session.status",
      payload: report,
    };
    await this.#send(
      `/internal/v1/browser-sessions/${encodeURIComponent(browserSessionId)}/status`,
      encodeBrowserFrame(frame),
      "application/json",
    );
  }

  /**
   * Uploads a capture: intent, then bytes, then completion with the observed
   * digest. The artefact is usable only once the control plane reports it
   * available, which it does only after verifying size and hash itself.
   */
  async upload(request: ArtefactUploadRequest): Promise<ScreenshotResult> {
    const sha256 = createHash("sha256").update(request.bytes).digest("hex");
    const sizeBytes = request.bytes.byteLength;

    const intentResponse = await this.#send(
      `/api/v1/projects/${encodeURIComponent(request.projectId)}/artefacts/uploads`,
      JSON.stringify({
        kind: request.kind,
        content_type: request.contentType,
        size_bytes: sizeBytes,
        sha256,
        browser_session_id: request.browserSessionId,
        retention_class: request.retentionClass,
      }),
      "application/json",
    );
    const intent = await readEnvelope<UploadIntent>(intentResponse, "upload intent");

    const uploadResponse = await this.#send(
      intent.upload_path,
      new Uint8Array(request.bytes),
      request.contentType,
    );
    if (!uploadResponse.ok) {
      throw new ArtefactUploadError(
        "ARTEFACT_UPLOAD_INCOMPLETE",
        `Artefact content upload failed with status ${String(uploadResponse.status)}.`,
      );
    }

    const completeResponse = await this.#send(
      `/api/v1/artefacts/${encodeURIComponent(intent.artefact_id)}/complete`,
      JSON.stringify({ sha256, size_bytes: sizeBytes }),
      "application/json",
    );
    const record = await readEnvelope<ArtefactRecord>(completeResponse, "artefact completion");

    if (record.state !== "available") {
      throw new ArtefactUploadError(
        "ARTEFACT_UPLOAD_INCOMPLETE",
        `The control plane has not made artefact ${record.id} available.`,
      );
    }
    if (record.sha256 !== sha256 || record.size_bytes !== sizeBytes) {
      throw new ArtefactUploadError(
        "ARTEFACT_UPLOAD_INCOMPLETE",
        "The control plane verified a different digest or size than the worker captured.",
      );
    }

    return {
      artefact_id: record.id,
      sha256: record.sha256,
      size_bytes: record.size_bytes,
      content_type: "image/png",
      viewport: request.viewport,
      scroll_position: request.scrollPosition,
      full_page: request.fullPage,
      captured_at: request.capturedAt.toISOString(),
    };
  }
}

async function readEnvelope<T>(response: Response, what: string): Promise<T> {
  let body: ApiEnvelope<T>;
  try {
    body = (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new ArtefactUploadError(
      "ARTEFACT_UPLOAD_INCOMPLETE",
      `${what} returned a response the worker could not read (status ${String(response.status)}).`,
    );
  }
  if (!response.ok || body.data === undefined) {
    const code = body.error?.code ?? "ARTEFACT_UPLOAD_INCOMPLETE";
    throw new ArtefactUploadError(
      code === "AUTHORISATION_DENIED" || code === "AUTHENTICATION_REQUIRED"
        ? code
        : "ARTEFACT_UPLOAD_INCOMPLETE",
      `${what} was refused: ${body.error?.message ?? `status ${String(response.status)}`}`,
    );
  }
  return body.data;
}

/** Default session limits, used until the control plane states its own. */
export function defaultSessionLimits(overrides: Partial<SessionLimits> = {}): SessionLimits {
  return {
    max_duration_seconds: 7200,
    default_timeout_ms: 30000,
    max_command_timeout_ms: 120000,
    screenshot_max_bytes: 20971520,
    snapshot_max_nodes: 400,
    snapshot_max_bytes: 32768,
    ...overrides,
  };
}
