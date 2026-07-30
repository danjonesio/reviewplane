/**
 * Artefact endpoints (`docs/API.md` section 15).
 *
 * The worker uploads through these routes and holds no storage credentials
 * (ADR-0012). A worker principal may only act inside the projects it is
 * assigned to, and only administrators may read content back in Stage 0 —
 * `docs/SECURITY.md` section 13 wants short-lived scoped access, which the
 * signed-URL work will add; until then the surface stays narrow rather than
 * broadly readable.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import { requireAdministrator, requireBearer, type Principal } from "../../auth.ts";
import { ApiError } from "../../errors.ts";
import type { EventActor } from "../../events.ts";
import type { ArtefactService } from "./service.ts";
import type { WorkerRegistry } from "../browser-sessions/workers.ts";

export interface ArtefactRoutesOptions {
  readonly pool: Pool;
  readonly artefacts: ArtefactService;
  readonly workers: WorkerRegistry;
  readonly bootstrapToken: string;
  readonly workerCredential: string;
  readonly maxBytes: number;
}

function actorFor(principal: Principal): EventActor {
  return principal.type === "administrator"
    ? { type: "human_user", display: "bootstrap administrator" }
    : { type: "browser_worker", id: principal.workerId, display: principal.name };
}

export async function registerArtefactRoutes(
  app: FastifyInstance,
  options: ArtefactRoutesOptions,
): Promise<void> {
  // Screenshot bytes arrive as an octet stream; Fastify must hand them over
  // untouched rather than trying to parse them.
  app.addContentTypeParser(
    "image/png",
    { parseAs: "buffer", bodyLimit: options.maxBytes },
    (_request, body, done) => {
      done(null, body);
    },
  );

  /** Either principal may act on artefacts; the scope differs. */
  const resolvePrincipal = async (request: FastifyRequest): Promise<Principal> => {
    const token = requireBearer(request);
    if (token === options.bootstrapToken) return { type: "administrator" };
    return options.workers.principal(token);
  };

  const requireProjectAccess = (principal: Principal, projectId: string): void => {
    if (principal.type === "administrator") return;
    if (!principal.assignedProjects.has(projectId)) {
      throw new ApiError(
        "PROJECT_CONTEXT_MISMATCH",
        "This worker is not assigned to the project the artefact belongs to.",
      );
    }
  };

  app.post("/api/v1/projects/:projectId/artefacts/uploads", async (request, reply) => {
    const principal = await resolvePrincipal(request);
    const { projectId } = request.params as { projectId: string };
    requireProjectAccess(principal, projectId);

    const body = request.body as {
      kind?: string;
      content_type?: string;
      size_bytes?: number;
      sha256?: string;
      retention_class?: string;
      browser_session_id?: string;
    };
    const record = await options.artefacts.createIntent({
      organisationId: await organisationOfProject(options.pool, projectId),
      projectId,
      kind: body.kind ?? "screenshot",
      contentType: body.content_type ?? "",
      sizeBytes: Number(body.size_bytes ?? 0),
      sha256: body.sha256 ?? "",
      retentionClass: body.retention_class ?? "action_screenshots",
      ...(body.browser_session_id === undefined
        ? {}
        : { browserSessionId: body.browser_session_id }),
      actor: actorFor(principal),
    });

    return reply.status(201).send({
      data: {
        artefact_id: record.id,
        state: record.state,
        upload_path: `/api/v1/artefacts/${record.id}/content`,
      },
      meta: { request_id: request.id },
    });
  });

  app.post("/api/v1/artefacts/:artefactId/content", async (request, reply) => {
    const principal = await resolvePrincipal(request);
    const { artefactId } = request.params as { artefactId: string };
    const existing = await options.artefacts.get(artefactId);
    requireProjectAccess(principal, existing.project_id);

    const body = request.body;
    if (!Buffer.isBuffer(body)) {
      throw new ApiError(
        "UNSUPPORTED_CAPABILITY",
        "Artefact content must be sent as image/png bytes.",
      );
    }
    const record = await options.artefacts.storeContent(artefactId, body);
    return reply.status(202).send({
      data: { artefact_id: record.id, state: record.state },
      meta: { request_id: request.id },
    });
  });

  app.post("/api/v1/artefacts/:artefactId/complete", async (request, reply) => {
    const principal = await resolvePrincipal(request);
    const { artefactId } = request.params as { artefactId: string };
    const existing = await options.artefacts.get(artefactId);
    requireProjectAccess(principal, existing.project_id);

    const body = request.body as { sha256?: string; size_bytes?: number };
    const record = await options.artefacts.complete(
      artefactId,
      {
        sha256: body.sha256 ?? "",
        ...(body.size_bytes === undefined ? {} : { sizeBytes: Number(body.size_bytes) }),
      },
      actorFor(principal),
    );
    return reply.send({
      data: {
        id: record.id,
        state: record.state,
        sha256: record.sha256,
        size_bytes: record.size_bytes,
        content_type: record.content_type,
        kind: record.kind,
      },
      meta: { request_id: request.id },
    });
  });

  app.get("/api/v1/artefacts/:artefactId", async (request, reply) => {
    const principal = await resolvePrincipal(request);
    const { artefactId } = request.params as { artefactId: string };
    const record = await options.artefacts.get(artefactId);
    requireProjectAccess(principal, record.project_id);
    return reply.send({ data: record, meta: { request_id: request.id } });
  });

  app.get("/api/v1/artefacts/:artefactId/content", async (request, reply) => {
    // Reading evidence back is administrative in Stage 0.
    requireAdministrator(request, options.bootstrapToken, options.workerCredential);
    const { artefactId } = request.params as { artefactId: string };
    const { record, bytes } = await options.artefacts.readContent(artefactId);
    return reply
      .header("content-type", record.content_type)
      // docs/SECURITY.md section 13: never render an artefact as active
      // content under the control-plane origin.
      .header("content-disposition", `attachment; filename="${record.id}.png"`)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cache-control", "private, no-store")
      .send(bytes);
  });
}

/** Looks up the organisation that owns a project. */
async function organisationOfProject(pool: Pool, projectId: string): Promise<string> {
  const rows = await pool.query<{ organisation_id: string }>(
    "SELECT organisation_id FROM projects WHERE id = $1",
    [projectId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new ApiError("RESOURCE_NOT_FOUND", "The project was not found.");
  }
  return row.organisation_id;
}
