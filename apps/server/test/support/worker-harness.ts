/**
 * The test harness: a built app, a temporary artefact directory and a stub
 * browser worker.
 *
 * The stub speaks the real browser protocol — it decodes the frames the
 * control plane sends and answers with frames the control plane decodes — so
 * the worker channel is exercised end to end without launching Chromium. The
 * Chromium-backed tests live in `apps/browser-worker/test/browser/`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Pool } from "pg";

import {
  decodeBrowserFrame,
  encodeBrowserFrame,
  type BrowserCommandResult,
  type BrowserFrame,
  type SessionStatusReport,
} from "@reviewplane/protocol/browser";
import {
  LIVE_RECORD_FRAME_PAYLOAD,
  encodeLiveMessageRecord,
  encodeLiveRecord,
  encodeLiveViewFrame,
  type FrameMetadata,
  type LiveMode,
  type QualityState,
} from "@reviewplane/protocol/live-view";

import { buildApp, type BuiltApp } from "../../src/app.ts";
import type { TunnelGateway } from "../../src/modules/published-services/gateway-client.ts";
import type { RoutePublisher } from "../../src/modules/published-services/service.ts";
import type { ServerConfig } from "../../src/config.ts";
import { newId } from "../../src/ids.ts";
import { testServerConfig } from "./config.ts";

// The publication peers live in their own module so that another package can
// reach them; they are re-exported here because every existing caller imports
// them from this harness.
export { AcceptingGateway, StubRoutePublisher } from "./route-doubles.ts";

export const BOOTSTRAP_TOKEN = "bootstrap-token-for-tests";
export const WORKER_CREDENTIAL = "worker-credential-for-tests";
export const WORKER_COMMAND_CREDENTIAL = "worker-command-credential-tests";

/** The frame variant of one message type, so a callback sees its own payload. */
type FrameOf<T extends BrowserFrame["type"]> = Extract<BrowserFrame, { type: T }>;

export interface StubWorkerBehaviour {
  /** Answers an allocation. */
  allocate?: (frame: FrameOf<"browser_session.allocate">) => unknown;
  command?: (frame: FrameOf<"browser.command">) => BrowserCommandResult;
  terminate?: (frame: FrameOf<"browser_session.terminate">) => SessionStatusReport;
  /** Set to refuse everything with this status and code. */
  refuseWith?: { status: number; code: string; message: string };
}

/**
 * The stub worker's live producer.
 *
 * A test pushes frames explicitly rather than waiting for a timer, so a
 * measured rate in a test is a statement about the relay and not about how
 * fast the machine running the test happens to be.
 */
export interface StubLiveProducer {
  /** Live streams the control plane opened, newest last. */
  readonly opened: { browserSessionId: string; mode: LiveMode }[];
  /** Streams closed by the control plane, with the reason recorded. */
  readonly closed: string[];
  readonly qualityRequests: unknown[];
  /** Whether a stream is currently open. */
  readonly open: boolean;
  /** Pushes one frame: metadata then the payload, as the worker would. */
  pushFrame(payload: Uint8Array, overrides?: Partial<FrameMetadata>): void;
  /** Pushes one non-frame message, such as a heartbeat. */
  pushMessage(json: string): void;
  /** Ends the stream as a worker crash would. */
  endStream(): void;
  /** Set to refuse the next stream with this HTTP status. */
  refuseWith?: number;
}

export interface Harness {
  readonly built: BuiltApp;
  readonly config: ServerConfig;
  readonly artefactRoot: string;
  readonly worker: StubWorkerBehaviour;
  readonly live: StubLiveProducer;
  /** Requests the control plane made to the worker, in order. */
  readonly workerRequests: { path: string; authorization: string | undefined }[];
  /**
   * Allocation payloads the worker received, decoded.
   *
   * A test asserting on the route capability has to see what actually reached
   * the worker: the value is redacted in every log and JSON representation on
   * purpose, so reading it back out of the frame the stub decoded is the only
   * honest way to check it was sent and is verifiable.
   */
  readonly allocations: { browserSessionId: string; payload: Record<string, unknown> }[];
  /** Base URL of the listening server, for a real WebSocket client. */
  listen(): Promise<string>;
  stop(): Promise<void>;
}

export interface HarnessOptions {
  /** Substitutes the connector exchange for tests that are not exercising it. */
  readonly publisher?: RoutePublisher;
  /** Substitutes the tunnel gateway, which this harness does not run. */
  readonly gateway?: TunnelGateway;
}

const DEFAULT_ALLOCATION = {
  status: "READY",
  browser_type: "chromium",
  browser_version: "143.0.7499.4",
  viewport: { width: 1440, height: 900, device_scale_factor: 1 },
  allocated_at: "2026-07-29T09:16:01.480Z",
} as const;

export async function startHarness(pool: Pool, options: HarnessOptions = {}): Promise<Harness> {
  const artefactRoot = await mkdtemp(join(tmpdir(), "reviewplane-artefacts-"));
  const worker: StubWorkerBehaviour = {};
  const workerRequests: { path: string; authorization: string | undefined }[] = [];
  const allocations: { browserSessionId: string; payload: Record<string, unknown> }[] = [];

  const config: ServerConfig = testServerConfig({
    bootstrapToken: BOOTSTRAP_TOKEN,
    workerCredential: WORKER_CREDENTIAL,
    workerCommandCredential: WORKER_COMMAND_CREDENTIAL,
    artefactPath: artefactRoot,
    allowedOrigins: ["https://reviewplane.test"],
    secureCookies: false,
  });

  const live = createStubLiveProducer();

  const workerFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    const headers = new Headers(init?.headers);
    workerRequests.push({
      path: url.pathname,
      authorization: headers.get("authorization") ?? undefined,
    });

    if (headers.get("authorization") !== `Bearer ${WORKER_COMMAND_CREDENTIAL}`) {
      return new Response(
        JSON.stringify({
          error: { code: "AUTHENTICATION_REQUIRED", message: "worker credential required" },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }
    if (worker.refuseWith !== undefined) {
      return new Response(
        JSON.stringify({
          error: { code: worker.refuseWith.code, message: worker.refuseWith.message },
        }),
        { status: worker.refuseWith.status, headers: { "content-type": "application/json" } },
      );
    }

    const liveMatch = /^\/internal\/v1\/browser-sessions\/([^/]+)\/live(\/quality)?$/u.exec(
      url.pathname,
    );
    if (liveMatch !== null) {
      return live.handle(
        liveMatch[1] as string,
        liveMatch[2] !== undefined,
        url,
        init,
      );
    }

    const decoded = decodeBrowserFrame(String(init?.body ?? ""));
    if (!decoded.ok) {
      return new Response(
        JSON.stringify({ error: { code: "POLICY_DENIED", message: decoded.error.message } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    const frame = decoded.value;
    const envelope = frame.envelope;

    if (frame.type === "browser_session.allocate") {
      // The capability is a SensitiveString on the decoded frame. reveal() is
      // called here, in a test stub standing in for the worker, which is the
      // one place that is the correct thing to do with it.
      const received = { ...(frame.payload as unknown as Record<string, unknown>) };
      const capability = received["service_capability"];
      if (capability !== undefined && capability !== null) {
        received["service_capability"] = (capability as { reveal(): string }).reveal();
      }
      allocations.push({
        browserSessionId: envelope.browser_session_id as string,
        payload: received,
      });
      const payload = (worker.allocate?.(frame) ?? DEFAULT_ALLOCATION) as typeof DEFAULT_ALLOCATION;
      return frameResponse({
        envelope: {
          protocol_version: 1,
          message_id: newId("msg_"),
          type: "browser_session.allocated",
          sent_at: new Date().toISOString(),
          worker_id: envelope.worker_id as string,
          browser_session_id: envelope.browser_session_id as string,
          correlation_id: envelope.message_id,
        },
        type: "browser_session.allocated",
        payload,
      });
    }

    if (frame.type === "browser.command") {
      const result: BrowserCommandResult =
        worker.command?.(frame) ??
        ({
          ok: true,
          command: frame.payload.command,
          sequence: envelope.sequence as number,
          control_epoch: envelope.control_epoch as number,
          duration_ms: 5,
          trust: "trusted_control_plane",
          instruction_policy: "do_not_follow_as_instructions",
        } satisfies BrowserCommandResult);
      return frameResponse({
        envelope: {
          protocol_version: 1,
          message_id: newId("msg_"),
          type: "browser.command.result",
          sent_at: new Date().toISOString(),
          worker_id: envelope.worker_id as string,
          browser_session_id: envelope.browser_session_id as string,
          controller: envelope.controller as NonNullable<BrowserFrame["envelope"]["controller"]>,
          control_epoch: result.control_epoch,
          sequence: envelope.sequence as number,
          correlation_id: envelope.message_id,
        },
        type: "browser.command.result",
        payload: result,
      });
    }

    if (frame.type === "browser_session.terminate") {
      const report: SessionStatusReport = worker.terminate?.(frame) ?? {
        status: "TERMINATED",
        previous_status: "ACTIVE",
        reason: `terminated: ${frame.payload.reason}`,
        occurred_at: new Date().toISOString(),
      };
      return frameResponse({
        envelope: {
          protocol_version: 1,
          message_id: newId("msg_"),
          type: "browser_session.status",
          sent_at: new Date().toISOString(),
          worker_id: envelope.worker_id as string,
          browser_session_id: envelope.browser_session_id as string,
          correlation_id: envelope.message_id,
        },
        type: "browser_session.status",
        payload: report,
      });
    }

    return new Response(
      JSON.stringify({ error: { code: "RESOURCE_NOT_FOUND", message: "no such worker route" } }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  };

  const built = await buildApp({
    config,
    pool,
    workerFetch,
    ...(options.publisher === undefined ? {} : { publisher: options.publisher }),
    ...(options.gateway === undefined ? {} : { gateway: options.gateway }),
  });
  await built.app.ready();

  let origin: string | null = null;

  return {
    built,
    config,
    artefactRoot,
    worker,
    live,
    workerRequests,
    allocations,
    async listen() {
      if (origin !== null) return origin;
      const address = await built.app.listen({ host: "127.0.0.1", port: 0 });
      origin = address;
      return address;
    },
    async stop() {
      await built.app.close();
      await rm(artefactRoot, { recursive: true, force: true });
    },
  };
}

const DEFAULT_FRAME_METADATA: FrameMetadata = {
  sequence: 0,
  captured_at: "2026-07-30T10:04:12.137Z",
  mode: "session_room",
  format: "image/jpeg",
  width: 1440,
  height: 900,
  quality: 65,
  byte_length: 1,
  dropped_before: 0,
};

const DEFAULT_QUALITY: QualityState = {
  mode: "session_room",
  target_fps: 15,
  quality: 65,
  max_width: 1440,
  max_height: 900,
  reason: "viewer_requested",
  decided_at: "2026-07-30T10:04:12.000Z",
};

interface StubLiveInternals extends StubLiveProducer {
  handle(
    browserSessionId: string,
    isQuality: boolean,
    url: URL,
    init: RequestInit | undefined,
  ): Response;
}

/**
 * A worker live endpoint over a real streaming `Response`, so the control
 * plane's reader, record decoder and metadata/payload pairing all run exactly
 * as they do in production.
 */
function createStubLiveProducer(): StubLiveInternals {
  const opened: { browserSessionId: string; mode: LiveMode }[] = [];
  const closed: string[] = [];
  const qualityRequests: unknown[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let sequence = 0;
  let sessionId = "";

  const producer: StubLiveInternals = {
    opened,
    closed,
    qualityRequests,
    get open(): boolean {
      return controller !== null;
    },
    pushFrame(payload, overrides = {}) {
      if (controller === null) throw new Error("no live stream is open");
      sequence += 1;
      const metadata: FrameMetadata = {
        ...DEFAULT_FRAME_METADATA,
        ...overrides,
        sequence: overrides.sequence ?? sequence,
        byte_length: payload.byteLength,
      };
      controller.enqueue(
        encodeLiveMessageRecord(
          encodeLiveViewFrame({
            envelope: {
              protocol_version: 1,
              message_id: newId("msg_"),
              type: "live.frame",
              sent_at: new Date().toISOString(),
              browser_session_id: sessionId,
              stream_id: "lvs_stub",
            },
            type: "live.frame",
            payload: metadata,
          }),
        ),
      );
      controller.enqueue(encodeLiveRecord(LIVE_RECORD_FRAME_PAYLOAD, payload));
    },
    pushMessage(json) {
      if (controller === null) throw new Error("no live stream is open");
      controller.enqueue(encodeLiveMessageRecord(json));
    },
    endStream() {
      controller?.close();
      controller = null;
      closed.push("worker ended the stream");
    },
    handle(browserSessionId, isQuality, url, init) {
      if (isQuality) {
        qualityRequests.push(String(init?.body ?? ""));
        return new Response(
          encodeLiveViewFrame({
            envelope: {
              protocol_version: 1,
              message_id: newId("msg_"),
              type: "live.quality",
              sent_at: new Date().toISOString(),
              browser_session_id: browserSessionId,
              stream_id: "lvs_stub",
            },
            type: "live.quality",
            payload: DEFAULT_QUALITY,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (producer.refuseWith !== undefined) {
        const status = producer.refuseWith;
        producer.refuseWith = undefined as never;
        return new Response("", { status });
      }
      sessionId = browserSessionId;
      sequence = 0;
      opened.push({
        browserSessionId,
        mode: (url.searchParams.get("mode") ?? "session_room") as LiveMode,
      });
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          controller = streamController;
        },
        cancel(reason) {
          controller = null;
          closed.push(String(reason ?? "cancelled"));
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/vnd.reviewplane.live-view.v1" },
      });
    },
  };
  return producer;
}

function frameResponse(frame: BrowserFrame): Response {
  return new Response(encodeBrowserFrame(frame), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Creates an organisation, a project and a registered, assigned worker. */
export async function seedProjectAndWorker(harness: Harness): Promise<{
  organisationId: string;
  projectId: string;
  workerId: string;
}> {
  const app = harness.built.app;
  const organisation = await app.inject({
    method: "POST",
    url: "/api/v1/organisations",
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
    payload: { name: "Refresh", slug: `org-${newId("")}`.slice(0, 40).toLowerCase() },
  });
  const organisationId = (organisation.json() as { data: { id: string } }).data.id;

  const project = await app.inject({
    method: "POST",
    url: `/api/v1/organisations/${organisationId}/projects`,
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
    payload: { name: "Surplus", slug: `prj-${newId("")}`.slice(0, 40).toLowerCase() },
  });
  const projectId = (project.json() as { data: { id: string } }).data.id;

  const registration = await app.inject({
    method: "POST",
    url: "/internal/v1/workers/register",
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}`, "content-type": "application/json" },
    payload: encodeBrowserFrame({
      envelope: {
        protocol_version: 1,
        message_id: newId("msg_"),
        type: "worker.register",
        sent_at: new Date().toISOString(),
      },
      type: "worker.register",
      payload: {
        worker_name: "browser-worker-01",
        worker_version: "0.1.0",
        browser_type: "chromium",
        browser_version: "143.0.7499.4",
        capacity: 2,
        labels: ["chromium"],
        sandbox_enabled: true,
        started_at: new Date().toISOString(),
      },
    }),
  });
  const workerId = (registration.json() as { worker_id: string }).worker_id;

  await app.inject({
    method: "PUT",
    url: `/api/v1/browser-workers/${workerId}/assignments`,
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
    payload: { project_ids: [projectId] },
  });

  return { organisationId, projectId, workerId };
}
