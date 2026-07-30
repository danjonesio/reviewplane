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

import { buildApp, type BuiltApp } from "../../src/app.ts";
import type {
  GatewayRegisterRequest,
  GatewayRouteView,
  TunnelGateway,
} from "../../src/modules/published-services/gateway-client.ts";
import type { RoutePublisher } from "../../src/modules/published-services/service.ts";
import type { ServerConfig } from "../../src/config.ts";
import { newId } from "../../src/ids.ts";
import { testServerConfig } from "./config.ts";

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

export interface Harness {
  readonly built: BuiltApp;
  readonly config: ServerConfig;
  readonly artefactRoot: string;
  readonly worker: StubWorkerBehaviour;
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
  stop(): Promise<void>;
}

export interface HarnessOptions {
  /** Substitutes the connector exchange for tests that are not exercising it. */
  readonly publisher?: RoutePublisher;
  /** Substitutes the tunnel gateway, which this harness does not run. */
  readonly gateway?: TunnelGateway;
}

/**
 * A tunnel gateway that accepts every registration and remembers it.
 *
 * The gateway's own behaviour is tested exhaustively in
 * `services/tunnel-gateway`; a control-plane test that needs a publication to
 * reach `ready` needs a peer, not a second gateway to run.
 */
export class AcceptingGateway implements TunnelGateway {
  readonly registered: GatewayRegisterRequest[] = [];
  readonly revokedRoutes: string[] = [];

  register(request: GatewayRegisterRequest): Promise<GatewayRouteView> {
    this.registered.push(request);
    return Promise.resolve({
      route_id: request.route_id,
      project_id: request.project_id,
      connector_id: request.connector_id,
      public_alias: request.public_alias,
      internal_origin: `https://${request.public_alias}.internal.invalid/`,
      status: "ready",
      expires_at: request.expires_at,
      observed_destination: request.observed_destination,
      connector_connected: true,
      streams_opened: 0,
      streams_active: 0,
      bytes_to_destination: 0,
      bytes_from_destination: 0,
    });
  }

  revokeRoute(routeId: string): Promise<void> {
    this.revokedRoutes.push(routeId);
    return Promise.resolve();
  }

  revokeCapability(): Promise<void> {
    return Promise.resolve();
  }
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
  });

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

  return {
    built,
    config,
    artefactRoot,
    worker,
    workerRequests,
    allocations,
    async stop() {
      await built.app.close();
      await rm(artefactRoot, { recursive: true, force: true });
    },
  };
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
