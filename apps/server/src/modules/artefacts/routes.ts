/**
 * Artefact endpoints (`docs/API.md` §15).
 *
 * The worker uploads through these routes and holds no storage credentials
 * (ADR-0012). A worker principal may only act inside the projects it is
 * assigned to.
 *
 * **The order of operations is the security property.** Every route here
 * resolves the caller *first*, turns that principal into a scope — an
 * organisation and a set of projects — and only then looks the artefact up,
 * with the identifier, the project scope and the organisation in one predicate.
 * A row belonging to another tenant is therefore never returned and then
 * rejected, and a foreign identifier is answered exactly as an unknown one is
 * (`docs/TESTING.md` §10). The older shape here looked the artefact up first
 * and compared afterwards, which made the two refusals distinguishable and the
 * identifier space enumerable.
 *
 * This repaired the defect in this module; `modules/reviews/routes.ts`, which
 * RVP-66 and RVP-67 also named, was repaired separately and now resolves every
 * record through one helper that takes the organisation from the authenticated
 * principal rather than from the row. Two ways to reach a record by identifier
 * is what let the two modules drift apart in the first place.
 *
 * **Reading bytes back works differently from every other route here**, and
 * deliberately so (ADR-0019). There is **no** path that serves an artefact from
 * its identifier. A caller mints a grant for one artefact and then reads
 * `/api/v1/artefact-content/:grantId`; the grant identifier is unguessable and
 * short-lived, and it admits nobody on its own, because the request must still
 * authenticate as the subject the grant was minted for. That split is what lets
 * an `<img>` element load evidence — it can carry a URL and a cookie, but not
 * an `Authorization` header — without putting a credential in a URL, which
 * `docs/SECURITY.md` §18 forbids.
 *
 * **Active content is never rendered here.** A DOM snapshot is `text/html`, and
 * `docs/SECURITY.md` §13 forbids rendering active markup under the
 * control-plane origin. Its bytes are served as an attachment, with the
 * disposition derived from the media type rather than chosen by the caller, so
 * there is no request that can ask for it inline.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import { requireBearer, type Principal } from "../../auth.ts";
import { ApiError, notFound } from "../../errors.ts";
import type { ActorType, EventActor } from "../../events/append.ts";
import { requireCsrfToken } from "../identity/authorisation.ts";
import { dispositionFor } from "./kinds.ts";
import {
  ARTEFACT_GRANT_TTL_SECONDS,
  UNRESTRICTED_SCOPE,
  type ArtefactRecord,
  type ArtefactScope,
  type ArtefactService,
} from "./service.ts";
import { IdempotencyStore, requestDigest } from "../agents/idempotency.ts";
import type { WorkerRegistry } from "../browser-sessions/workers.ts";
import type { ViewerPrincipal } from "../live/viewer-sessions.ts";

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
   * overwrite, complete or delete an artefact.
   */
  readonly agentAuth?: (request: FastifyRequest) => Promise<AgentArtefactPrincipal | null>;
}

function actorFor(principal: Principal): EventActor {
  return principal.type === "administrator"
    ? { type: "human_user", display: "bootstrap administrator" }
    : { type: "browser_worker", id: principal.workerId, display: principal.name };
}

/** The subject a grant is bound to, and the rows that subject may see. */
interface ArtefactCaller {
  readonly subjectType: ActorType;
  readonly subjectId: string;
  readonly display: string;
  readonly scope: ArtefactScope;
}

export async function registerArtefactRoutes(
  app: FastifyInstance,
  options: ArtefactRoutesOptions,
): Promise<void> {
  const idempotency = new IdempotencyStore(options.pool);

  // Artefact bytes arrive as an opaque stream; Fastify must hand them over
  // untouched rather than trying to parse them.
  //
  // The transport header is not the artefact's media type. That is declared on
  // the intent and verified against the bytes, so an uploader sends
  // `application/octet-stream` — or, for the two image types the browser worker
  // already uses, the image type itself — and a DOM snapshot or an
  // accessibility snapshot travels as opaque bytes. Registering a parser for
  // `application/json` here would replace the one every other route on this
  // server needs, and a JSON body Fastify had parsed and re-serialised would no
  // longer hash to what the uploader declared.
  for (const mediaType of ["image/png", "image/jpeg", "application/octet-stream"]) {
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
   * Turns the request's credential into a subject and a scope, **before any
   * artefact is looked up**.
   *
   * A human viewer session is the usual caller; the administrator token, a
   * worker credential and an agent credential are all accepted so that an
   * operator with `curl`, the browser worker and an agent session read evidence
   * through the same mechanism rather than through three weaker ones.
   *
   * `intent` separates reading evidence from minting a grant to read it, or
   * deleting one. A write inserts a row and records an event, so a
   * cookie-authenticated caller must echo the session's CSRF token
   * (`docs/API.md` §4.0). The check runs before anything else this function
   * does with the session, and outside any `catch`: swallowing its refusal
   * would be a guard that refuses nothing.
   *
   * **The fallthrough across three mechanisms is deliberate**, and the
   * `.catch(() => null)` on each is narrower than it looks. Each resolver
   * either produces a principal or does not; a rejection means "this request
   * does not carry a credential of my kind", which is a reason to try the next
   * mechanism and never a reason to admit anybody. Nothing here returns a
   * principal it did not resolve, and the last step — `resolvePrincipal` —
   * throws rather than falling through to an anonymous caller, so a request
   * with no recognised credential is refused rather than admitted with an empty
   * scope. `requireCsrfToken` is called before the `return` and outside the
   * `catch` that wraps the resolver, so its refusal propagates rather than
   * demoting a cookie session to the next mechanism.
   */
  const resolveCaller = async (
    request: FastifyRequest,
    intent: "read" | "write",
  ): Promise<ArtefactCaller> => {
    if (options.viewerAuth !== undefined) {
      const viewer = await options.viewerAuth(request).catch(() => null);
      if (viewer !== null) {
        if (intent === "write") requireCsrfToken(request, viewer);
        return {
          subjectType: "human_user",
          subjectId: viewer.viewerSessionId,
          display: viewer.display,
          scope: {
            organisationId: viewer.organisationId,
            projectIds: viewer.projectIds === null ? null : [...viewer.projectIds],
          },
        };
      }
    }
    if (options.agentAuth !== undefined) {
      const agent = await options.agentAuth(request).catch(() => null);
      if (agent !== null) {
        return {
          subjectType: "agent_session",
          subjectId: agent.credentialId,
          display: agent.display,
          scope: { organisationId: agent.organisationId, projectIds: [...agent.projectIds] },
        };
      }
    }
    const principal = await resolvePrincipal(request);
    if (principal.type === "administrator") {
      return {
        subjectType: "human_user",
        subjectId: "bootstrap",
        display: "bootstrap administrator",
        scope: UNRESTRICTED_SCOPE,
      };
    }
    return {
      subjectType: "browser_worker",
      subjectId: principal.workerId,
      display: principal.name,
      // A worker carries no organisation of its own; its assignment to a set of
      // projects is the whole of its scope, and a project belongs to exactly
      // one organisation, so the project filter decides the tenant.
      scope: { organisationId: null, projectIds: [...principal.assignedProjects] },
    };
  };

  /**
   * `POST /api/v1/projects/:projectId/artefacts/uploads`
   *
   * The intent is idempotent on the caller's `Idempotency-Key`
   * (`docs/MCP_SPEC.md` §10): a worker that crashed mid-upload and retried the
   * whole flow gets the same artefact back rather than a second pending row for
   * the same capture, which is the `docs/TESTING.md` §11 fault-injection case.
   */
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
      source_artefact_id?: string;
      filename?: string;
    };
    const actor = actorFor(principal);
    const idempotencyKey = headerValue(request, "idempotency-key");
    const keyScope =
      idempotencyKey === null
        ? null
        : {
            projectId,
            actorType: actor.type,
            actorId: actor.id ?? "bootstrap",
            tool: "artefact_upload_intent",
            key: idempotencyKey,
          };
    if (keyScope !== null) {
      const claimed = await idempotency.claim(keyScope, requestDigest(body));
      if (claimed.replayed) {
        return reply.status(200).send({ data: claimed.response, meta: { request_id: request.id } });
      }
    }

    const record = await options.artefacts.createIntent({
      organisationId: await organisationOfProject(options.pool, projectId),
      projectId,
      kind: body.kind ?? "screenshot",
      contentType: body.content_type ?? "",
      sizeBytes: Number(body.size_bytes ?? 0),
      sha256: body.sha256 ?? "",
      ...(body.retention_class === undefined ? {} : { retentionClass: body.retention_class }),
      ...(body.browser_session_id === undefined
        ? {}
        : { browserSessionId: body.browser_session_id }),
      ...(body.source_artefact_id === undefined
        ? {}
        : { sourceArtefactId: body.source_artefact_id }),
      ...(body.filename === undefined ? {} : { filenameLabel: body.filename }),
      actor,
    });

    const data = {
      artefact_id: record.id,
      state: record.state,
      // Stage 1 proxies the upload under both drivers, so the server is where
      // content-type validation happens and no byte reaches storage before it
      // passes. `upload_url` in the protocol is for the Stage 2 presigned-upload
      // path ADR-0012 permits and this build does not issue.
      upload_path: `/api/v1/artefacts/${record.id}/content`,
      max_bytes: options.maxBytes,
    };
    if (keyScope !== null) await idempotency.complete(keyScope, data);
    return reply.status(201).send({ data, meta: { request_id: request.id } });
  });

  app.post("/api/v1/artefacts/:artefactId/content", async (request, reply) => {
    const principal = await resolvePrincipal(request);
    const { artefactId } = request.params as { artefactId: string };
    const existing = await options.artefacts.getInScope(artefactId, scopeOfPrincipal(principal));

    const body = request.body;
    if (!Buffer.isBuffer(body)) {
      throw new ApiError(
        "UNSUPPORTED_CAPABILITY",
        "Artefact content must be sent as the bytes declared on intent.",
      );
    }
    const record = await options.artefacts.storeContent(existing, body, actorFor(principal));
    return reply.status(202).send({
      data: { artefact_id: record.id, state: record.state },
      meta: { request_id: request.id },
    });
  });

  app.post("/api/v1/artefacts/:artefactId/complete", async (request, reply) => {
    const principal = await resolvePrincipal(request);
    const { artefactId } = request.params as { artefactId: string };
    const existing = await options.artefacts.getInScope(artefactId, scopeOfPrincipal(principal));

    const body = request.body as { sha256?: string; size_bytes?: number };
    const record = await options.artefacts.complete(
      existing,
      {
        sha256: body.sha256 ?? "",
        ...(body.size_bytes === undefined ? {} : { sizeBytes: Number(body.size_bytes) }),
      },
      actorFor(principal),
    );
    return reply.send({ data: publicArtefact(record), meta: { request_id: request.id } });
  });

  app.get("/api/v1/artefacts/:artefactId", async (request, reply) => {
    const { artefactId } = request.params as { artefactId: string };
    const caller = await resolveCaller(request, "read");
    // A read of metadata is authorised exactly as a read of bytes is, and by
    // the same query.
    const record = await options.artefacts.getInScope(artefactId, caller.scope);
    return reply.send({ data: publicArtefact(record), meta: { request_id: request.id } });
  });

  /**
   * Mints a short-lived grant for one artefact (`docs/SECURITY.md` §13,
   * ADR-0012, ADR-0019).
   */
  app.post("/api/v1/artefacts/:artefactId/grants", async (request, reply) => {
    const { artefactId } = request.params as { artefactId: string };
    const caller = await resolveCaller(request, "write");
    const record = await options.artefacts.getInScope(artefactId, caller.scope);
    const grant = await options.artefacts.grantAccess({
      record,
      subjectType: caller.subjectType,
      subjectId: caller.subjectId,
      actor: { type: caller.subjectType, id: caller.subjectId, display: caller.display },
    });
    return reply.status(201).send({
      data: {
        grant_id: grant.id,
        artefact_id: grant.artefact_id,
        // Under the `s3` driver the driver decides what the URL points at
        // (ADR-0019); the caller sees one flow either way.
        url: grant.presigned_url ?? `/api/v1/artefact-content/${grant.id}`,
        expires_at: grant.expires_at,
        expires_in_seconds: ARTEFACT_GRANT_TTL_SECONDS,
        disposition: dispositionFor(record.content_type),
      },
      meta: { request_id: request.id },
    });
  });

  /**
   * `DELETE /api/v1/artefacts/:artefactId` (`docs/API.md` §15).
   *
   * Deletion is audited (`docs/SECURITY.md` §16) and the metadata row is
   * retained so the identifier still resolves in the audit trail. Retention
   * *enforcement* is Stage 2: nothing sweeps expired artefacts, and this is the
   * only path that removes any.
   */
  app.delete("/api/v1/artefacts/:artefactId", async (request, reply) => {
    const { artefactId } = request.params as { artefactId: string };
    const caller = await resolveCaller(request, "write");
    if (caller.subjectType !== "human_user") {
      // Only a human destroys evidence. An agent submits it and a worker
      // captures it; neither may remove it. `AGENTS.md`'s acceptance-authority
      // rule has the same shape — a machine principal may add to the record and
      // may not close it — and `docs/SECURITY.md` §6.3 and §6.4 keep machine
      // credentials out of anything administrative.
      throw new ApiError(
        "AUTHORISATION_DENIED",
        caller.subjectType === "agent_session"
          ? "An agent credential may read evidence and may not delete it."
          : "A browser-worker credential may write evidence and may not delete it.",
      );
    }
    const record = await options.artefacts.getInScope(artefactId, caller.scope);
    const reason = headerValue(request, "x-reviewplane-reason");
    const deleted = await options.artefacts.delete(
      record,
      { type: caller.subjectType, id: caller.subjectId, display: caller.display },
      reason ?? undefined,
    );
    return reply.send({
      data: {
        artefact_id: record.id,
        deleted_at: deleted.record.deleted_at,
        bytes_removed: deleted.bytesRemoved,
      },
      meta: { request_id: request.id },
    });
  });

  /**
   * The only route that serves artefact bytes.
   *
   * The grant is resolved first, then the caller is authenticated and matched
   * against the grant's subject.
   *
   * **Every refusal here is the same refusal.** An unknown grant, an expired
   * one, a revoked one and a live one presented by the wrong principal all
   * produce `unusableGrant()` — one status, one code, one message. Telling them
   * apart is an existence oracle over grant identifiers, which is the class
   * `docs/TESTING.md` §10 and RVP-67 are about; that the identifier is 24
   * random bytes makes the oracle expensive to exploit rather than absent, and
   * "expensive" is not the property the criterion asks for. It costs a caller
   * nothing, because the remedy is the same in all four cases: mint a new
   * grant.
   */
  app.get("/api/v1/artefact-content/:grantId", async (request, reply) => {
    const { grantId } = request.params as { grantId: string };
    const grant = await options.artefacts.resolveGrant(grantId);
    if (grant === null) throw unusableGrant();

    if (grant.subject_type === "agent_session") {
      // ADR-0019's agent flow. The grant names one agent session; the caller
      // proves it may act as that session by presenting the credential the
      // session was opened with. A credential that no longer owns the session —
      // because it expired, was revoked, or never owned it — is refused exactly
      // as an unknown grant is.
      const agent =
        options.agentAuth === undefined
          ? null
          : await options.agentAuth(request).catch(() => null);
      const owns =
        agent !== null &&
        agent.organisationId === grant.organisation_id &&
        agent.projectIds.has(grant.project_id) &&
        (agent.sessionIds.has(grant.subject_id) || agent.credentialId === grant.subject_id);
      if (!owns) throw unusableGrant();
    } else {
      // A caller that cannot authenticate at all reaches the same refusal: the
      // resolution below throws, and it must not be a different refusal from
      // the one a wrong subject gets.
      const caller = await resolveCaller(request, "read").catch(() => null);
      if (
        caller === null ||
        caller.subjectType !== grant.subject_type ||
        caller.subjectId !== grant.subject_id
      ) {
        throw unusableGrant();
      }
    }

    // The grant names one artefact and was minted against a scoped lookup, so
    // the read is inside the grant's own project and organisation rather than
    // by identifier alone.
    const record = await options.artefacts.getInScope(grant.artefact_id, {
      organisationId: grant.organisation_id,
      projectIds: [grant.project_id],
    });
    const bytes = await options.artefacts.readContent(record);
    return sendArtefactBytes(reply, record, bytes);
  });
}

/**
 * Serves artefact bytes with the headers that keep `docs/SECURITY.md` §13 true.
 *
 * The disposition is derived from the media type and is not a parameter: active
 * markup is always an attachment, so it is downloaded rather than rendered
 * under the control-plane origin, and there is no request that can ask
 * otherwise. `nosniff` is what stops a browser deciding for itself that an
 * inert type is really a document; the sandboxing content-security policy is
 * what makes that decision harmless if it were made anyway. The filename
 * offered on a download is the artefact identifier and never the uploader's
 * display label, which keeps a hostile name out of a reader's filesystem.
 */
function sendArtefactBytes(
  reply: FastifyReply,
  record: ArtefactRecord,
  bytes: Buffer,
): FastifyReply {
  const disposition = dispositionFor(record.content_type);
  const extension = EXTENSION_BY_TYPE[record.content_type] ?? "bin";
  return reply
    .header("content-type", record.content_type)
    .header("content-disposition", `${disposition}; filename="${record.id}.${extension}"`)
    .header("x-content-type-options", "nosniff")
    .header("content-security-policy", "default-src 'none'; sandbox")
    .header("cross-origin-resource-policy", "same-origin")
    .header("x-frame-options", "DENY")
    .header("referrer-policy", "no-referrer")
    .header("cache-control", "private, no-store")
    .send(bytes);
}

/**
 * The one refusal `/api/v1/artefact-content/:grantId` ever gives.
 *
 * Unknown, expired, revoked and issued-to-somebody-else are four different
 * facts and one answer, so a caller learns nothing about which grants exist.
 * The message names all four, which is honest and tells the caller the remedy —
 * mint a new grant — without saying which of them applied.
 */
function unusableGrant(): ApiError {
  return new ApiError(
    "AUTHENTICATION_REQUIRED",
    "This artefact grant is unknown, expired, revoked, or was issued to a different principal. Mint a new one.",
  );
}

/** Extensions, for the name a download is offered under. */
const EXTENSION_BY_TYPE: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "text/html": "html",
  "application/json": "json",
  "text/plain": "txt",
};

/** The rows a machine principal may reach. */
function scopeOfPrincipal(principal: Principal): ArtefactScope {
  return principal.type === "administrator"
    ? UNRESTRICTED_SCOPE
    : { organisationId: null, projectIds: [...principal.assignedProjects] };
}

function contentRectangleOf(
  record: ArtefactRecord,
): { width_px: number; height_px: number } | null {
  if (record.content_width_px === null || record.content_height_px === null) return null;
  return { width_px: record.content_width_px, height_px: record.content_height_px };
}

/** The artefact metadata a client may see (`docs/UX_FLOWS.md` §17). */
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
    // Null states that the bytes are not application-encrypted; Stage 1
    // encrypts nothing (`docs/SECURITY.md` §15).
    encryption_key_reference: record.encryption_key_reference,
    disposition: dispositionFor(record.content_type),
    source_artefact_id: record.source_artefact_id,
    thumbnail_state: record.thumbnail_state,
    thumbnail_artefact_id: record.thumbnail_artefact_id,
    browser_session_id: record.browser_session_id,
    created_at: record.created_at,
    available_at: record.available_at,
    expires_at: record.expires_at,
  };
}

/** One request header, or null. */
function headerValue(request: FastifyRequest, name: string): string | null {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === undefined || value.trim() === "" ? null : value.trim();
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
