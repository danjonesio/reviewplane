/**
 * Browser-session endpoints (`docs/API.md` section 11) and the worker-facing
 * internal channel (`docs/ARCHITECTURE.md` section 11).
 *
 * The two are separated deliberately. `/api/v1/...` is the human and
 * integration surface and is administrative in Stage 0. `/internal/v1/...` is
 * the worker channel: a worker credential is accepted there and nowhere
 * administrative, which is the boundary `docs/SECURITY.md` section 6.3
 * requires for a non-human credential.
 */

import type { FastifyInstance } from "fastify";

import {
  decodeBrowserFrame,
  encodeBrowserFrame,
  type BrowserCommand,
  type ControllerIdentity,
  type Viewport,
} from "@reviewplane/protocol/browser";

import { requireAdministrator, requireBearer } from "../../auth.ts";
import { ApiError } from "../../errors.ts";
import type { EventActor } from "../../events/append.ts";
import { newId } from "../../ids.ts";
import type { BrowserSessionService } from "./service.ts";
import type { WorkerRegistry } from "./workers.ts";

export interface BrowserSessionRoutesOptions {
  readonly sessions: BrowserSessionService;
  readonly workers: WorkerRegistry;
  readonly bootstrapToken: string;
  readonly workerCredential: string;
  readonly defaultHeartbeatSeconds?: number;
}

const ADMINISTRATOR: EventActor = { type: "human_user", display: "bootstrap administrator" };

export async function registerBrowserSessionRoutes(
  app: FastifyInstance,
  options: BrowserSessionRoutesOptions,
): Promise<void> {
  const admin = (request: Parameters<typeof requireAdministrator>[0]): void => {
    requireAdministrator(request, options.bootstrapToken, options.workerCredential);
  };

  // ---------------------------------------------------------------------
  // Administrative surface
  // ---------------------------------------------------------------------

  app.put("/api/v1/browser-workers/:workerId/assignments", async (request, reply) => {
    admin(request);
    const { workerId } = request.params as { workerId: string };
    const body = request.body as { project_ids?: string[] };
    const assigned = await options.workers.assign(workerId, body.project_ids ?? []);
    return reply.send({ data: { worker_id: workerId, project_ids: assigned }, meta: { request_id: request.id } });
  });

  app.get("/api/v1/browser-workers", async (request, reply) => {
    admin(request);
    const worker = await options.workers.active();
    return reply.send({ data: worker === null ? [] : [worker], meta: { request_id: request.id } });
  });

  app.post("/api/v1/projects/:projectId/browser-sessions", async (request, reply) => {
    admin(request);
    const { projectId } = request.params as { projectId: string };
    const body = request.body as {
      organisation_id?: string;
      viewport?: Viewport;
      controller?: ControllerIdentity;
      published_service_id?: string;
      agent_session_id?: string;
      retention_class?: "action_screenshots" | "verification_evidence";
      allocate?: boolean;
    };
    if (body.organisation_id === undefined || body.viewport === undefined) {
      throw new ApiError(
        "UNSUPPORTED_CAPABILITY",
        "organisation_id and viewport are required to start a browser session.",
      );
    }
    const common = {
      organisationId: body.organisation_id,
      projectId,
      viewport: body.viewport,
      controller: body.controller ?? { type: "agent", id: newId("ags_") },
      retentionClass: body.retention_class ?? "verification_evidence",
      ...(body.agent_session_id === undefined ? {} : { agentSessionId: body.agent_session_id }),
      actor: ADMINISTRATOR,
    } as const;

    // allocate=false reserves the identifier without contacting the worker, so
    // that it can be named in a route's allowed_browser_session_ids before the
    // session's egress origin is fixed (docs/API.md section 11).
    if (body.allocate === false) {
      const reserved = await options.sessions.create(common);
      return reply.status(201).send({ data: reserved, meta: { request_id: request.id } });
    }

    const record = await options.sessions.start({
      ...common,
      ...(body.published_service_id === undefined
        ? {}
        : { publishedServiceId: body.published_service_id }),
      requestId: request.id,
    });
    return reply.status(201).send({ data: record, meta: { request_id: request.id } });
  });

  /**
   * Allocates a reserved session on its worker, optionally binding a published
   * service. The origin and the capability are derived from the route here; a
   * caller-supplied origin is not accepted, because the origin is the egress
   * allow-list itself.
   */
  app.post("/api/v1/browser-sessions/:sessionId/allocate", async (request, reply) => {
    admin(request);
    const { sessionId } = request.params as { sessionId: string };
    const body = (request.body ?? {}) as { published_service_id?: string };
    const record = await options.sessions.allocate({
      browserSessionId: sessionId,
      ...(body.published_service_id === undefined
        ? {}
        : { publishedServiceId: body.published_service_id }),
      actor: ADMINISTRATOR,
      requestId: request.id,
    });
    return reply.send({ data: record, meta: { request_id: request.id } });
  });

  app.get("/api/v1/projects/:projectId/browser-sessions", async (request, reply) => {
    admin(request);
    const { projectId } = request.params as { projectId: string };
    return reply.send({
      data: await options.sessions.listForProject(projectId),
      meta: { request_id: request.id },
    });
  });

  app.get("/api/v1/browser-sessions/:sessionId", async (request, reply) => {
    admin(request);
    const { sessionId } = request.params as { sessionId: string };
    return reply.send({ data: await options.sessions.get(sessionId), meta: { request_id: request.id } });
  });

  app.post("/api/v1/browser-sessions/:sessionId/commands", async (request, reply) => {
    admin(request);
    const { sessionId } = request.params as { sessionId: string };
    const body = request.body as {
      control_epoch?: number;
      controller?: ControllerIdentity;
      command?: BrowserCommand;
    };
    if (body.command === undefined || body.control_epoch === undefined) {
      throw new ApiError(
        "UNSUPPORTED_CAPABILITY",
        "command and control_epoch are required on a browser command.",
      );
    }
    const session = await options.sessions.get(sessionId);
    const result = await options.sessions.runCommand({
      browserSessionId: sessionId,
      controller: body.controller ?? session.current_controller ?? { type: "system", id: "system" },
      controlEpoch: body.control_epoch,
      command: body.command,
      actor: ADMINISTRATOR,
    });
    return reply.send({ data: result, meta: { request_id: request.id } });
  });

  app.post("/api/v1/browser-sessions/:sessionId/terminate", async (request, reply) => {
    admin(request);
    const { sessionId } = request.params as { sessionId: string };
    const record = await options.sessions.terminate(sessionId, "requested", ADMINISTRATOR);
    return reply.send({ data: record, meta: { request_id: request.id } });
  });

  // ---------------------------------------------------------------------
  // Worker channel
  // ---------------------------------------------------------------------

  app.addContentTypeParser(
    "application/json",
    { parseAs: "string", bodyLimit: 262144 },
    (request, body, done) => {
      // Worker-channel routes need the raw frame bytes so the generated
      // decoder, not Fastify, decides whether the frame is acceptable.
      if (typeof request.url === "string" && request.url.startsWith("/internal/v1/")) {
        done(null, body);
        return;
      }
      try {
        done(null, JSON.parse(body as string) as unknown);
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  app.post("/internal/v1/workers/register", async (request, reply) => {
    const credential = requireBearer(request);
    const decoded = decodeBrowserFrame(request.body as string);
    if (!decoded.ok || decoded.value.type !== "worker.register") {
      throw new ApiError("UNSUPPORTED_CAPABILITY", "A worker.register frame is required.");
    }
    const registration = await options.workers.register(credential, decoded.value.payload);
    return reply.send({
      worker_id: registration.workerId,
      payload: {
        accepted: true,
        assigned_projects: registration.assignedProjects,
        session_limits: {
          max_duration_seconds: 7200,
          default_timeout_ms: 30000,
          max_command_timeout_ms: 120000,
          screenshot_max_bytes: 20971520,
          snapshot_max_nodes: 400,
          snapshot_max_bytes: 32768,
        },
        heartbeat_interval_seconds: options.defaultHeartbeatSeconds ?? 15,
      },
    });
  });

  app.post("/internal/v1/workers/heartbeat", async (request, reply) => {
    const credential = requireBearer(request);
    const principal = await options.workers.principal(credential);
    const decoded = decodeBrowserFrame(request.body as string);
    if (!decoded.ok || decoded.value.type !== "worker.heartbeat") {
      throw new ApiError("UNSUPPORTED_CAPABILITY", "A worker.heartbeat frame is required.");
    }
    await options.workers.recordHeartbeat(principal.workerId, decoded.value.payload.active_sessions);
    return reply.status(204).send();
  });

  app.post("/internal/v1/browser-sessions/:sessionId/status", async (request, reply) => {
    const credential = requireBearer(request);
    const principal = await options.workers.principal(credential);
    const { sessionId } = request.params as { sessionId: string };
    const decoded = decodeBrowserFrame(request.body as string);
    if (!decoded.ok || decoded.value.type !== "browser_session.status") {
      throw new ApiError("UNSUPPORTED_CAPABILITY", "A browser_session.status frame is required.");
    }
    const session = await options.sessions.get(sessionId);
    if (!principal.assignedProjects.has(session.project_id)) {
      throw new ApiError(
        "PROJECT_CONTEXT_MISMATCH",
        "This worker is not assigned to the project the browser session belongs to.",
      );
    }
    if (session.worker_id !== principal.workerId) {
      throw new ApiError(
        "AUTHORISATION_DENIED",
        "This browser session is allocated to a different worker.",
      );
    }
    await options.sessions.applyWorkerReport(sessionId, decoded.value.payload, {
      type: "browser_worker",
      id: principal.workerId,
      display: principal.name,
    });
    return reply.status(204).send();
  });

  // Exposed so an operator can confirm the frame encoding the worker channel
  // speaks without attaching a debugger to either process.
  app.get("/internal/v1/protocol", async (request, reply) => {
    admin(request);
    return reply.send({
      data: {
        example: encodeBrowserFrame({
          envelope: {
            protocol_version: 1,
            message_id: "msg_example",
            type: "worker.heartbeat",
            sent_at: "2026-07-29T00:00:00Z",
            worker_id: "wkr_example",
          },
          type: "worker.heartbeat",
          payload: {
            active_sessions: 0,
            capacity: 1,
            observed_at: "2026-07-29T00:00:00Z",
          },
        }),
      },
      meta: { request_id: request.id },
    });
  });
}
