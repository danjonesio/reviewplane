/**
 * Artefact endpoints (`docs/API.md` section 15).
 *
 * The worker uploads through these routes and holds no storage credentials
 * (ADR-0012). A worker principal may only act inside the projects it is
 * assigned to.
 *
 * Reading bytes back works differently from every other route here, and
 * deliberately so (ADR-0019). There is **no** path that serves an artefact
 * from its identifier. A caller mints a grant for one artefact and then reads
 * `/api/v1/artefact-content/:grantId`; the grant identifier is unguessable and
 * short-lived, and it admits nobody on its own, because the request must still
 * authenticate as the subject the grant was minted for. That split is what
 * lets an `<img>` element load evidence — it can carry a URL and a cookie, but
 * not an `Authorization` header — without putting a credential in a URL, which
 * `docs/SECURITY.md` section 18 forbids.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import { requireBearer, type Principal } from "../../auth.ts";
import { ApiError, notFound } from "../../errors.ts";
import type { ActorType, EventActor } from "../../events/append.ts";
import { requireCsrfToken } from "../identity/authorisation.ts";
import {
  ARTEFACT_GRANT_TTL_SECONDS,
  type ArtefactRecord,
  type ArtefactService,
} from "./service.ts";
import type { WorkerRegistry } from "../browser-sessions/workers.ts";
import {
  authorisedForProject,
  type ViewerPrincipal,
} from "../live/viewer-sessions.ts";

/**
 * An agent credential presenting itself to read evidence back.
 *
 * ADR-0019 states the flow: "an agent session mints a grant scoped to itself
 * and fetches with its own credential". The grant names the session, and the
 * credential is what proves the caller is entitled to act as it — so the
 * principal carries the sessions the credential currently owns, and a grant is
 * redeemable only by a credential that owns the session it was minted for.
 */
export interface AgentArtefactPrincipal {
  readonly credentialId: string;
  readonly organisationId: string;
  readonly projectIds: ReadonlySet<string>;
  readonly sessionIds: ReadonlySet<string>;
  readonly display: string;
}

export interface ArtefactRoutesOptions {
  readonly pool: Pool;
  readonly artefacts: ArtefactService;
  readonly workers: WorkerRegistry;
  readonly bootstrapToken: string;
  readonly workerCredential: string;
  readonly maxBytes: number;
  /** Resolves a human viewer (ADR-0016). Humans read evidence; workers write it. */
  readonly viewerAuth?: (request: FastifyRequest) => Promise<ViewerPrincipal>;
  /**
   * Resolves an agent credential (`docs/SECURITY.md` §6.3). It admits an agent
   * to **reading** evidence it already holds a grant for, and to nothing else
   * here: the upload routes below never consult it, so an agent cannot create,
   * overwrite or complete an artefact.
   */
  readonly agentAuth?: (request: FastifyRequest) => Promise<AgentArtefactPrincipal | null>;
}

function actorFor(principal: Principal): EventActor {
  return principal.type === "administrator"
    ? { type: "human_user", display: "bootstrap administrator" }
    : { type: "browser_worker", id: principal.workerId, display: principal.name };
}

/** The subject a grant is bound to, for either kind of principal. */
interface GrantSubject {
  readonly type: ActorType;
  readonly id: string;
  readonly display: string;
}

export async function registerArtefactRoutes(
  app: FastifyInstance,
  options: ArtefactRoutesOptions,
): Promise<void> {
  // Screenshot bytes arrive as an octet stream; Fastify must hand them over
  // untouched rather than trying to parse them.
  for (const mediaType of ["image/png", "image/jpeg"]) {
    app.addContentTypeParser(
      mediaType,
      { parseAs: "buffer", bodyLimit: options.maxBytes },
      (_request, body, done) => {
        done(null, body);
      },
    );
  }

  /** Either machine principal may write artefacts; the scope differs. */
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

  /**
   * The subject of a grant.
   *
   * A human viewer session is the usual one; the administrator token and a
   * worker credential are accepted so an operator with `curl` and the browser
   * worker itself can read evidence back through the same mechanism rather
   * than through a second, weaker one.
   *
   * `intent` is what separates reading evidence from minting a grant to read
   * it. Minting one inserts a row and records `artefact.access_granted`, so it
   * is a state change and a cookie-authenticated caller must echo the session's
   * CSRF token (`docs/API.md` section 4.0). The check is deliberately outside
   * the `catch` above it: swallowing its refusal would be a guard that refuses
   * nothing.
   */
  const resolveGrantSubject = async (
    request: FastifyRequest,
    record: ArtefactRecord,
    intent: "read" | "write",
  ): Promise<GrantSubject> => {
    if (options.viewerAuth !== undefined) {
      const viewer = await options.viewerAuth(request).catch(() => null);
      if (viewer !== null) {
        if (intent === "write") requireCsrfToken(request, viewer);
        if (!authorisedForProject(viewer, record.project_id)) {
          throw new ApiError(
            "PROJECT_CONTEXT_MISMATCH",
            "This viewer session is not authorised for the project that owns this artefact.",
          );
        }
        return { type: "human_user", id: viewer.viewerSessionId, display: viewer.display };
      }
    }
    const principal = await resolvePrincipal(request);
    requireProjectAccess(principal, record.project_id);
    return principal.type === "administrator"
      ? { type: "human_user", id: "bootstrap", display: "bootstrap administrator" }
      : { type: "browser_worker", id: principal.workerId, display: principal.name };
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
      filename?: string;
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
      ...(body.filename === undefined ? {} : { filenameLabel: body.filename }),
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
        "Artefact content must be sent as the image bytes declared on intent.",
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
        content_rectangle: contentRectangleOf(record),
      },
      meta: { request_id: request.id },
    });
  });

  /**
   * The agent principal for this request, where the caller presented an agent
   * credential authorised for the artefact's project.
   */
  const resolveAgent = async (
    request: FastifyRequest,
    record: ArtefactRecord,
  ): Promise<AgentArtefactPrincipal | null> => {
    if (options.agentAuth === undefined) return null;
    const agent = await options.agentAuth(request).catch(() => null);
    if (agent === null) return null;
    if (agent.organisationId !== record.organisation_id || !agent.projectIds.has(record.project_id)) {
      // Cross-project reads are refused before anything about the artefact is
      // returned (`docs/TESTING.md` section 10).
      throw new ApiError(
        "PROJECT_CONTEXT_MISMATCH",
        "This agent credential is not bound to the project that owns this artefact.",
      );
    }
    return agent;
  };

  app.get("/api/v1/artefacts/:artefactId", async (request, reply) => {
    const { artefactId } = request.params as { artefactId: string };
    const record = await options.artefacts.get(artefactId);
    // A read of metadata is authorised the same way a read of bytes is.
    const agent = await resolveAgent(request, record);
    if (agent === null) await resolveGrantSubject(request, record, "read");
    return reply.send({ data: publicArtefact(record), meta: { request_id: request.id } });
  });

  /**
   * Mints a short-lived grant for one artefact (`docs/SECURITY.md` section 13,
   * ADR-0012, ADR-0019).
   */
  app.post("/api/v1/artefacts/:artefactId/grants", async (request, reply) => {
    const { artefactId } = request.params as { artefactId: string };
    const record = await options.artefacts.get(artefactId);
    const subject = await resolveGrantSubject(request, record, "write");
    const grant = await options.artefacts.grantAccess({
      artefactId: record.id,
      subjectType: subject.type,
      subjectId: subject.id,
      actor: { type: subject.type, id: subject.id, display: subject.display },
    });
    return reply.status(201).send({
      data: {
        grant_id: grant.id,
        artefact_id: grant.artefact_id,
        url: `/api/v1/artefact-content/${grant.id}`,
        expires_at: grant.expires_at,
        expires_in_seconds: ARTEFACT_GRANT_TTL_SECONDS,
      },
      meta: { request_id: request.id },
    });
  });

  /**
   * The only route that serves artefact bytes.
   *
   * The grant is resolved first, then the caller is authenticated and matched
   * against the grant's subject. A grant belonging to somebody else is refused
   * exactly as an unknown one is.
   */
  app.get("/api/v1/artefact-content/:grantId", async (request, reply) => {
    const { grantId } = request.params as { grantId: string };
    const grant = await options.artefacts.resolveGrant(grantId);
    if (grant === null) {
      throw new ApiError(
        "AUTHENTICATION_REQUIRED",
        "This artefact grant is unknown, expired or revoked.",
      );
    }
    const record = await options.artefacts.get(grant.artefact_id);
    if (grant.subject_type === "agent_session") {
      // ADR-0019's agent flow. The grant names one agent session; the caller
      // proves it may act as that session by presenting the credential the
      // session was opened with. A credential that no longer owns the session —
      // because it expired, was revoked, or never owned it — is refused exactly
      // as an unknown grant is.
      const agent = await resolveAgent(request, record);
      if (agent === null || !agent.sessionIds.has(grant.subject_id)) {
        throw new ApiError(
          "AUTHORISATION_DENIED",
          "This artefact grant was issued to a different principal.",
        );
      }
    } else {
      const subject = await resolveGrantSubject(request, record, "read");
      if (subject.type !== grant.subject_type || subject.id !== grant.subject_id) {
        throw new ApiError(
          "AUTHORISATION_DENIED",
          "This artefact grant was issued to a different principal.",
        );
      }
    }

    const { bytes } = await options.artefacts.readContent(grant.artefact_id);
    return reply
      .header("content-type", record.content_type)
      // docs/SECURITY.md section 13 and docs/UX_FLOWS.md section 17: never
      // render an artefact as active content under the control-plane origin.
      // `inline` is required for an <img>; the sandbox, the nosniff header and
      // the type allowlist are what make it safe, not the disposition.
      .header("content-disposition", `inline; filename="${record.id}"`)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("referrer-policy", "no-referrer")
      .header("cache-control", "private, no-store")
      .send(bytes);
  });
}

function contentRectangleOf(
  record: ArtefactRecord,
): { width_px: number; height_px: number } | null {
  if (record.content_width_px === null || record.content_height_px === null) return null;
  return { width_px: record.content_width_px, height_px: record.content_height_px };
}

/** The artefact metadata a client may see (`docs/UX_FLOWS.md` section 17). */
function publicArtefact(record: ArtefactRecord): Record<string, unknown> {
  return {
    id: record.id,
    organisation_id: record.organisation_id,
    project_id: record.project_id,
    kind: record.kind,
    state: record.state,
    storage_key: record.storage_key,
    content_type: record.content_type,
    size_bytes: record.size_bytes,
    sha256: record.sha256,
    content_rectangle: contentRectangleOf(record),
    redaction_state: record.redaction_state,
    retention_class: record.retention_class,
    browser_session_id: record.browser_session_id,
    created_at: record.created_at,
    available_at: record.available_at,
  };
}

/** Looks up the organisation that owns a project. */
async function organisationOfProject(pool: Pool, projectId: string): Promise<string> {
  const rows = await pool.query<{ organisation_id: string }>(
    "SELECT organisation_id FROM projects WHERE id = $1",
    [projectId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw notFound("The project");
  return row.organisation_id;
}
