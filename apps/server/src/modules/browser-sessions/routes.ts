/**
 * Browser-session endpoints (`docs/API.md` section 11) and the worker-facing
 * internal channel (`docs/ARCHITECTURE.md` section 11).
 *
 * The two are separated deliberately. `/api/v1/...` is the human and
 * integration surface. `/internal/v1/...` is the worker channel: a worker
 * credential is accepted there and nowhere administrative, which is the
 * boundary `docs/SECURITY.md` section 6.3 requires for a non-human credential.
 *
 * **Who may call the human surface changed with RVP-30.** Stage 0 accepted only
 * the bootstrap administrator token, because no human session existed and
 * nothing but a script started a browser. `docs/UX_FLOWS.md` section 6 requires
 * a reader to start a session from the project Live page, so these routes now
 * resolve the human of `modules/identity/authorisation.ts` and the project they
 * name — which the bootstrap token still maps to, so an operator's
 * `Authorization: Bearer` continues to work unchanged. A browser-worker, agent
 * or connector credential reaches none of them.
 *
 * The moment a cookie can authenticate a state-changing route, a forged
 * cross-origin write becomes possible, so every state-changing route here
 * applies the strict `requireCsrfToken`. Starting a browser session opens a
 * central Chromium against a private development machine; it is exactly the
 * shape that must not be forgeable.
 *
 * **Scope.** Every route resolves the project through `resolveProject`, which
 * carries the identifier, the caller's organisation and the session's project
 * scope in one predicate, and every session lookup is filtered by that project.
 * A session in another project answers `RESOURCE_NOT_FOUND` byte for byte as an
 * unknown identifier does (`docs/API.md` section 5).
 */

import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  decodeBrowserFrame,
  encodeBrowserFrame,
  type BrowserCommand,
  type ControllerIdentity,
  type Viewport,
} from "@reviewplane/protocol/browser";

import type { Pool } from "../../db/pool.ts";
import { requireBearer } from "../../auth.ts";
import { ApiError } from "../../errors.ts";
import type { EventActor } from "../../events/append.ts";
import { newId } from "../../ids.ts";
import {
  requireCsrfToken,
  requireHuman,
  resolveProject,
  type AuthorisedProject,
} from "../identity/authorisation.ts";
import type { ViewerPrincipal } from "../live/viewer-sessions.ts";
import type { BrowserSessionRecord, BrowserSessionService } from "./service.ts";
import type { WorkerRegistry } from "./workers.ts";

export interface BrowserSessionRoutesOptions {
  readonly pool: Pool;
  readonly sessions: BrowserSessionService;
  readonly workers: WorkerRegistry;
  readonly defaultHeartbeatSeconds?: number;
}

function actorOfPrincipal(principal: ViewerPrincipal): EventActor {
  return {
    type: "human_user",
    ...(principal.userId === null ? {} : { id: principal.userId }),
    display: principal.display,
  };
}

/**
 * The controller a human acts as.
 *
 * Stage 1 has no human interactive control (`docs/ROADMAP.md` defers takeover
 * to Stage 2), so a human operating these routes acts as the `system`
 * controller: the acts they can perform — start, pause, resume, end — are
 * lifecycle changes rather than page input, and giving them an interactive
 * `human` lease here would create the controller Stage 2 is meant to introduce
 * with its own machinery.
 */
function systemController(principal: ViewerPrincipal): ControllerIdentity {
  return { type: "system", id: `sys_${principal.viewerSessionId}` };
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ApiError("VALIDATION_FAILED", `${field} must be an integer.`, { field });
  }
  return value;
}

function requireViewport(value: unknown): Viewport {
  if (typeof value !== "object" || value === null) {
    throw new ApiError("VALIDATION_FAILED", "viewport is required.", { field: "viewport" });
  }
  const raw = value as Record<string, unknown>;
  const width = requireInteger(raw["width"], "viewport.width");
  const height = requireInteger(raw["height"], "viewport.height");
  const scale = raw["device_scale_factor"] ?? 1;
  if (typeof scale !== "number" || scale < 1 || scale > 4) {
    throw new ApiError("VALIDATION_FAILED", "viewport.device_scale_factor must be between 1 and 4.", {
      field: "viewport.device_scale_factor",
    });
  }
  if (width < 240 || width > 3840 || height < 240 || height > 2160) {
    throw new ApiError("VALIDATION_FAILED", "viewport is outside the supported range.", {
      field: "viewport",
    });
  }
  return { width, height, device_scale_factor: scale };
}

export async function registerBrowserSessionRoutes(
  app: FastifyInstance,
  options: BrowserSessionRoutesOptions,
): Promise<void> {
  /** Resolves the human and the project they named, for a read. */
  const readerFor = async (
    request: FastifyRequest,
    projectId: string,
  ): Promise<{ principal: ViewerPrincipal; project: AuthorisedProject }> => {
    const principal = requireHuman(request);
    const project = await resolveProject(options.pool, principal, projectId);
    return { principal, project };
  };

  /** The same, plus the CSRF rule, for a write. */
  const writerFor = async (
    request: FastifyRequest,
    projectId: string,
  ): Promise<{ principal: ViewerPrincipal; project: AuthorisedProject }> => {
    const principal = requireHuman(request);
    requireCsrfToken(request, principal);
    const project = await resolveProject(options.pool, principal, projectId);
    return { principal, project };
  };

  /**
   * Resolves a session by identifier inside the caller's scope.
   *
   * The session is read first and then its project is resolved through the
   * authorisation layer, so a session whose project the caller cannot reach
   * produces `RESOURCE_NOT_FOUND` from `resolveProject` — the same refusal an
   * unknown session identifier produces. Neither can be used to enumerate the
   * other.
   */
  const sessionFor = async (
    request: FastifyRequest,
    sessionId: string,
    write: boolean,
  ): Promise<{
    principal: ViewerPrincipal;
    project: AuthorisedProject;
    session: BrowserSessionRecord;
  }> => {
    const principal = requireHuman(request);
    if (write) requireCsrfToken(request, principal);
    const session = await options.sessions.get(sessionId);
    const project = await resolveProject(options.pool, principal, session.project_id);
    return { principal, project, session };
  };

  // ---------------------------------------------------------------------
  // Worker administration
  // ---------------------------------------------------------------------

  app.put("/api/v1/browser-workers/:workerId/assignments", async (request, reply) => {
    const principal = requireHuman(request);
    requireCsrfToken(request, principal);
    if (principal.projectIds !== null) {
      throw new ApiError(
        "AUTHORISATION_DENIED",
        "This session is scoped to a project and cannot assign a browser worker.",
      );
    }
    const { workerId } = request.params as { workerId: string };
    const body = request.body as { project_ids?: string[] };
    const assigned = await options.workers.assign(workerId, body.project_ids ?? []);
    return reply.send({
      data: { worker_id: workerId, project_ids: assigned },
      meta: { request_id: request.id },
    });
  });

  app.get("/api/v1/browser-workers", async (request, reply) => {
    const principal = requireHuman(request);
    if (principal.projectIds !== null) {
      throw new ApiError(
        "AUTHORISATION_DENIED",
        "This session is scoped to a project and cannot read the browser-worker fleet.",
      );
    }
    return reply.send({
      data: await options.workers.schedulableRows(),
      meta: { request_id: request.id },
    });
  });

  // ---------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------

  app.post("/api/v1/projects/:projectId/browser-sessions", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { principal, project } = await writerFor(request, projectId);
    const body = (request.body ?? {}) as {
      organisation_id?: string;
      viewport?: unknown;
      controller?: ControllerIdentity;
      published_service_id?: string;
      agent_session_id?: string;
      retention_class?: "action_screenshots" | "verification_evidence";
      allocate?: boolean;
    };
    // The organisation is derived from the resolved project and never taken
    // from the caller: on a project route an organisation the caller names is
    // an authorisation input the caller chose. It is still accepted so that
    // existing clients keep working, and refused when it disagrees rather than
    // ignored, because silently ignoring it would let a caller believe it had
    // been honoured.
    if (body.organisation_id !== undefined && body.organisation_id !== project.organisationId) {
      throw new ApiError(
        "VALIDATION_FAILED",
        "organisation_id does not match the organisation that owns this project. It is derived from the project and does not need to be sent.",
        { field: "organisation_id" },
      );
    }
    const viewport = requireViewport(body.viewport);
    const common = {
      organisationId: project.organisationId,
      projectId,
      viewport,
      controller: body.controller ?? systemController(principal),
      retentionClass: body.retention_class ?? ("verification_evidence" as const),
      ...(body.agent_session_id === undefined ? {} : { agentSessionId: body.agent_session_id }),
      actor: actorOfPrincipal(principal),
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
    const { sessionId } = request.params as { sessionId: string };
    const { principal } = await sessionFor(request, sessionId, true);
    const body = (request.body ?? {}) as { published_service_id?: string };
    const record = await options.sessions.allocate({
      browserSessionId: sessionId,
      ...(body.published_service_id === undefined
        ? {}
        : { publishedServiceId: body.published_service_id }),
      actor: actorOfPrincipal(principal),
      requestId: request.id,
    });
    return reply.send({ data: record, meta: { request_id: request.id } });
  });

  app.get("/api/v1/projects/:projectId/browser-sessions", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    await readerFor(request, projectId);
    return reply.send({
      data: await options.sessions.listForProject(projectId),
      meta: { request_id: request.id },
    });
  });

  app.get("/api/v1/browser-sessions/:sessionId", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const { session } = await sessionFor(request, sessionId, false);
    return reply.send({ data: session, meta: { request_id: request.id } });
  });

  app.get("/api/v1/browser-sessions/:sessionId/timeline", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const { session } = await sessionFor(request, sessionId, false);
    const query = (request.query ?? {}) as { limit?: string };
    const limit = query.limit === undefined ? 100 : Number(query.limit);
    return reply.send({
      data: await options.sessions.timeline(
        sessionId,
        session.project_id,
        Number.isFinite(limit) ? limit : 100,
      ),
      meta: { request_id: request.id },
    });
  });

  app.post("/api/v1/browser-sessions/:sessionId/commands", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const { principal, session } = await sessionFor(request, sessionId, true);
    const body = request.body as {
      control_epoch?: number;
      controller?: unknown;
      command?: BrowserCommand;
    };
    if (body.command === undefined || body.control_epoch === undefined) {
      throw new ApiError(
        "VALIDATION_FAILED",
        "command and control_epoch are required on a browser command.",
      );
    }
    // The controller is **derived from the authenticated principal** and is no
    // longer accepted from the body. A body-supplied controller is a claim
    // about the actor rather than the actor: it let a caller assert the
    // identity of whoever held the lease and so satisfy the ownership check by
    // naming its owner. `docs/SECURITY.md` section 7 requires the *actor* to
    // own the lease, and outranks the `docs/API.md` section 11 example that
    // showed the field — which is updated in the same change (ADR-0028).
    //
    // A body that still carries one is refused rather than ignored, because a
    // caller that believes it chose the controller and did not is worse off
    // than one that is told the field is gone.
    if (body.controller !== undefined) {
      throw new ApiError(
        "VALIDATION_FAILED",
        "controller is no longer accepted on a browser command: the control plane derives it from the authenticated caller (docs/API.md section 11).",
        { field: "controller" },
      );
    }
    const result = await options.sessions.runCommand({
      browserSessionId: sessionId,
      projectId: session.project_id,
      controller: systemController(principal),
      controlEpoch: body.control_epoch,
      command: body.command,
      actor: actorOfPrincipal(principal),
    });
    return reply.send({ data: result, meta: { request_id: request.id } });
  });

  app.post("/api/v1/browser-sessions/:sessionId/pause", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const { principal, session } = await sessionFor(request, sessionId, true);
    const body = (request.body ?? {}) as { control_epoch?: number };
    const record = await options.sessions.pause({
      browserSessionId: sessionId,
      projectId: session.project_id,
      controller: session.current_controller ?? systemController(principal),
      controlEpoch: body.control_epoch ?? session.control_epoch,
      actor: actorOfPrincipal(principal),
    });
    return reply.send({ data: record, meta: { request_id: request.id } });
  });

  app.post("/api/v1/browser-sessions/:sessionId/resume", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const { principal, session } = await sessionFor(request, sessionId, true);
    const body = (request.body ?? {}) as { control_epoch?: number };
    const record = await options.sessions.resume({
      browserSessionId: sessionId,
      projectId: session.project_id,
      controller: session.current_controller ?? systemController(principal),
      controlEpoch: body.control_epoch ?? session.control_epoch,
      actor: actorOfPrincipal(principal),
    });
    return reply.send({ data: record, meta: { request_id: request.id } });
  });

  app.post("/api/v1/browser-sessions/:sessionId/control/request", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const { principal, session } = await sessionFor(request, sessionId, true);
    const body = (request.body ?? {}) as {
      controller_type?: ControllerIdentity["type"];
      controller_id?: string;
      reason?: string;
    };
    const controllerType = body.controller_type ?? "human";
    const record = await options.sessions.requestControl({
      browserSessionId: sessionId,
      projectId: session.project_id,
      controller: {
        type: controllerType,
        id: body.controller_id ?? systemController(principal).id,
      },
      ...(body.reason === undefined ? {} : { reason: body.reason }),
      actor: actorOfPrincipal(principal),
    });
    return reply.send({ data: record, meta: { request_id: request.id } });
  });

  app.post("/api/v1/browser-sessions/:sessionId/control/release", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const { principal, session } = await sessionFor(request, sessionId, true);
    const body = (request.body ?? {}) as { control_epoch?: number };
    const record = await options.sessions.releaseControl({
      browserSessionId: sessionId,
      projectId: session.project_id,
      controller: session.current_controller ?? systemController(principal),
      controlEpoch: body.control_epoch ?? session.control_epoch,
      actor: actorOfPrincipal(principal),
    });
    return reply.send({ data: record, meta: { request_id: request.id } });
  });

  app.post("/api/v1/browser-sessions/:sessionId/terminate", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const { principal } = await sessionFor(request, sessionId, true);
    const record = await options.sessions.terminate(
      sessionId,
      "requested",
      actorOfPrincipal(principal),
    );
    return reply.send({ data: record, meta: { request_id: request.id } });
  });

  // ---------------------------------------------------------------------
  // Worker channel
  // ---------------------------------------------------------------------

  // This replaces Fastify's own JSON parser for the **whole instance**, so what
  // it does with a malformed body is what every JSON route in this server does
  // with one.
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
      } catch {
        // A bare `SyntaxError` used to be handed on, and it carries no status
        // and no code — so the error hook treated a body the *client*
        // malformed as an unhandled server failure and answered
        // `500 INTERNAL_ERROR`, with a stack trace in the log. Fastify's own
        // parser reports `statusCode: 400`; replacing the parser lost that, and
        // this restores it in this API's vocabulary. The parser's message is
        // not carried: it quotes the input, and the input is what the refusal
        // is about (`docs/SECURITY.md` §18).
        done(
          new ApiError("VALIDATION_FAILED", "The request body is not valid JSON.", undefined, 400),
          undefined,
        );
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
        heartbeat_interval_seconds:
          options.defaultHeartbeatSeconds ?? registration.heartbeatIntervalSeconds,
      },
    });
  });

  /**
   * Records a heartbeat and answers with the assignment that is current now
   * (ADR-0026).
   *
   * This used to answer `204 No Content`, which is why an assignment removed by
   * an administrator went on being served until the worker restarted. The
   * answer is the whole current set rather than a change list, so a worker that
   * missed one converges on the next.
   */
  app.post("/internal/v1/workers/heartbeat", async (request, reply) => {
    const credential = requireBearer(request);
    const principal = await options.workers.principal(credential);
    const decoded = decodeBrowserFrame(request.body as string);
    if (!decoded.ok || decoded.value.type !== "worker.heartbeat") {
      throw new ApiError("UNSUPPORTED_CAPABILITY", "A worker.heartbeat frame is required.");
    }
    const acknowledged = await options.workers.recordHeartbeat(
      principal.workerId,
      decoded.value.payload.active_sessions,
    );
    return reply
      .header("content-type", "application/json")
      .send(
        encodeBrowserFrame({
          envelope: {
            protocol_version: 1,
            message_id: newId("msg_"),
            type: "worker.heartbeat.ack",
            sent_at: new Date().toISOString(),
            worker_id: principal.workerId,
            correlation_id: decoded.value.envelope.message_id,
          },
          type: "worker.heartbeat.ack",
          payload: {
            assigned_projects: acknowledged.assignedProjects,
            heartbeat_interval_seconds:
              options.defaultHeartbeatSeconds ?? acknowledged.heartbeatIntervalSeconds,
            observed_at: new Date().toISOString(),
          },
        }),
      );
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
    const principal = requireHuman(request);
    if (principal.projectIds !== null) {
      throw new ApiError(
        "AUTHORISATION_DENIED",
        "This session is scoped to a project and cannot read the worker protocol example.",
      );
    }
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
