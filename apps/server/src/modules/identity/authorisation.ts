/**
 * Request authorisation (`docs/SECURITY.md` section 7).
 *
 * "Every request must be authorised using actor identity, organisation,
 * project, resource, action and current session state. Do not rely on UI
 * visibility for enforcement." That sentence is the whole of this file's remit,
 * and it is one file so that a new module inherits the rules rather than
 * restating them.
 *
 * The shape is: **resolve everywhere, refuse at the route.**
 *
 *   * A hook resolves the actor for every `/api/` request and attaches it, so
 *     a handler never re-reads a header and two handlers cannot disagree about
 *     what a credential means. Resolution alone refuses nothing: a route that
 *     is deliberately unauthenticated — the first-run status, the login itself
 *     — still runs.
 *   * The guards below are what refuse. Each names the rule it enforces, and
 *     each is a function a handler calls rather than a convention it follows.
 *
 * Two refusals are worth their comments:
 *
 * **A machine credential is refused by shape, before any lookup.** An agent
 * token presented to an administrative route is denied because it starts with
 * `rpa_`, not because a database read said so — a check that needed PostgreSQL
 * would fail open exactly when PostgreSQL is down, and `docs/SECURITY.md`
 * section 6.3 is not a rule that may hold only while the database is up.
 *
 * **A foreign identifier is answered `RESOURCE_NOT_FOUND`.** `docs/API.md`
 * section 5 requires it: `AUTHORISATION_DENIED` would confirm that the
 * resource exists, which is the enumeration a cross-project attacker wants.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";

import { bearerToken, credentialMatches } from "../../auth.ts";
import type { Pool } from "../../db/pool.ts";
import { ApiError, notFound } from "../../errors.ts";
import { looksLikeAgentToken } from "../agents/credentials.ts";
import {
  CSRF_HEADER,
  VIEWER_SESSION_COOKIE,
  csrfTokenMatches,
  readCookie,
} from "../live/viewer-sessions.ts";
import type { ViewerPrincipal, ViewerSessionStore } from "../live/viewer-sessions.ts";

/** What a request's credential turned out to be. */
export type ResolvedActor =
  | { readonly type: "human"; readonly principal: ViewerPrincipal }
  | { readonly type: "browser_worker" }
  | { readonly type: "agent" }
  | { readonly type: "anonymous" };

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Resolved by the hook this module installs, for every `/api/` request. It
     * is undefined elsewhere — on a health probe, on the connector channel —
     * because those routes are not part of the human API and resolving a
     * credential for them would invent an actor that does not exist.
     */
    reviewplaneActor?: ResolvedActor;
  }
}

/** The actor a request resolved to, defaulting to nobody. */
export function actorOf(request: FastifyRequest): ResolvedActor {
  return request.reviewplaneActor ?? { type: "anonymous" };
}

export interface AuthorisationOptions {
  readonly pool: Pool;
  readonly viewers: ViewerSessionStore;
  readonly bootstrapToken: string;
  readonly workerCredential: string;
}

/**
 * Installs the resolution hook.
 *
 * It runs on `preHandler` rather than `onRequest` so that route parameters are
 * already parsed: "resolve the project too" is only meaningful once the router
 * has decided which project the path named.
 */
export function registerAuthorisation(app: FastifyInstance, options: AuthorisationOptions): void {
  app.decorateRequest("reviewplaneActor", undefined);
  app.addHook("preHandler", async (request) => {
    if (!request.url.startsWith("/api/")) return;
    request.reviewplaneActor = await resolveActor(request, options);
  });
}

/**
 * Turns a request's credential into an actor.
 *
 * A credential this server does not recognise resolves to `anonymous` rather
 * than to a refusal: telling an unauthenticated caller that its token was
 * *wrong* rather than *absent* confirms that some token would have worked.
 */
export async function resolveActor(
  request: FastifyRequest,
  options: AuthorisationOptions,
): Promise<ResolvedActor> {
  const bearer = bearerToken(request);
  if (bearer !== null) {
    if (credentialMatches(bearer, options.bootstrapToken)) {
      return { type: "human", principal: bootstrapPrincipal() };
    }
    if (credentialMatches(bearer, options.workerCredential)) return { type: "browser_worker" };
    if (looksLikeAgentToken(bearer)) return { type: "agent" };
    return { type: "anonymous" };
  }

  const cookie = readCookie(request.headers.cookie, VIEWER_SESSION_COOKIE);
  if (cookie === null) return { type: "anonymous" };
  const principal = await options.viewers.resolve(cookie);
  return principal === null ? { type: "anonymous" } : { type: "human", principal };
}

/** The organisation-wide principal the bootstrap administrator token maps to. */
export function bootstrapPrincipal(): ViewerPrincipal {
  return {
    type: "human_viewer",
    viewerSessionId: "bootstrap",
    userId: null,
    organisationId: null,
    projectIds: null,
    display: "bootstrap administrator",
    credential: "bootstrap_token",
    csrfTokenDigest: null,
    expiresAt: null,
  };
}

/**
 * The human behind a request, or a refusal.
 *
 * A machine credential is denied rather than reported as missing: it
 * authenticated, and it may not act here (`docs/SECURITY.md` section 6.3).
 */
export function requireHuman(request: FastifyRequest): ViewerPrincipal {
  const actor = actorOf(request);
  switch (actor.type) {
    case "human":
      return actor.principal;
    case "browser_worker":
      throw new ApiError(
        "AUTHORISATION_DENIED",
        "A browser-worker credential is not a human session and cannot call this endpoint.",
      );
    case "agent":
      throw new ApiError(
        "AUTHORISATION_DENIED",
        "An agent credential is not a human session and cannot call this endpoint (docs/SECURITY.md section 6.3).",
      );
    default:
      throw new ApiError("AUTHENTICATION_REQUIRED", "Sign in to continue.");
  }
}

/**
 * The human who may administer the organisation.
 *
 * Stage 1 has no roles (`docs/DOMAIN_MODEL.md` section 5 defers them to Stage
 * 3), so the rule is scope rather than role: an organisation-wide session
 * administers, and a project-scoped session — a delegation minted for one
 * project — does not. Adding roles later replaces this predicate and nothing
 * else, because no handler decides for itself what an administrator is.
 */
export function requireOrganisationAdministrator(request: FastifyRequest): ViewerPrincipal {
  const principal = requireHuman(request);
  if (principal.projectIds !== null) {
    throw new ApiError(
      "AUTHORISATION_DENIED",
      "This session is scoped to a project and cannot administer the organisation.",
    );
  }
  return principal;
}

/**
 * Enforces the CSRF token on a state-changing request (`docs/API.md` section
 * 4).
 *
 * Only a cookie-authenticated request needs it: a cookie is attached by the
 * browser to a request another origin caused, and a bearer token is not. A
 * session with no CSRF token — the ADR-0016 bootstrap exchange — cannot satisfy
 * the check and is refused here rather than admitted by a null comparison,
 * which is what keeps that exchange a read-only credential.
 */
export function requireCsrfToken(request: FastifyRequest, principal: ViewerPrincipal): void {
  if (principal.credential !== "cookie") return;
  const presented = request.headers[CSRF_HEADER];
  const value = Array.isArray(presented) ? presented[0] : presented;
  if (!csrfTokenMatches(value, principal.csrfTokenDigest)) {
    // The log line records that a request was refused and never the token that
    // was or was not presented (`docs/SECURITY.md` section 18).
    request.log.warn({ route: request.url }, "state-changing request refused: CSRF token");
    throw new ApiError(
      "AUTHORISATION_DENIED",
      "This request changes state and must carry the session's CSRF token in the X-CSRF-Token header.",
      { field: "x_csrf_token", reason: "csrf_token_invalid" },
    );
  }
}

/**
 * Enforces the CSRF token on a request that ends the caller's **own** session.
 *
 * The difference from {@link requireCsrfToken} is deliberate and narrow. That
 * guard refuses a session with no CSRF token outright, which is right for every
 * route that changes domain state: the ADR-0016 exchange must not reach one.
 * But a session must always be able to end itself, and the exchange issues no
 * CSRF token, so applying the strict guard to sign-out would leave those
 * sessions with no way to end at all.
 *
 * So the rule here is by what the session carries. An account session always
 * carries a CSRF token and must present it — that is the case the review
 * proved: a password session could be ended by a cookie alone. A session that
 * carries none is the read-only bootstrap exchange, and the worst a forged
 * request achieves against it is signing a viewer out.
 */
export function requireCsrfTokenWhenSessionCarriesOne(
  request: FastifyRequest,
  principal: ViewerPrincipal,
): void {
  if (principal.csrfTokenDigest === null) return;
  requireCsrfToken(request, principal);
}

/** A project as the authorisation layer sees it. */
export interface AuthorisedProject {
  readonly id: string;
  readonly organisationId: string;
  readonly status: string;
}

/**
 * Resolves a project inside the caller's scope.
 *
 * The filtering is defence in depth: the identifier, the session's project
 * scope and the session's organisation all appear in the predicate, so a row
 * that satisfies one and not the others is not returned by the query rather
 * than being returned and then rejected by a later `if`.
 */
export async function resolveProject(
  pool: Pool,
  principal: ViewerPrincipal,
  projectId: string,
): Promise<AuthorisedProject> {
  const scope = principal.projectIds === null ? null : [...principal.projectIds];
  const rows = await pool.query<{ id: string; organisation_id: string; status: string }>(
    `SELECT id, organisation_id, status
       FROM projects
      WHERE id = $1
        AND ($2::text[] IS NULL OR id = ANY($2))
        AND ($3::text IS NULL OR organisation_id = $3)`,
    [projectId, scope, principal.organisationId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw notFound("The project");
  return { id: row.id, organisationId: row.organisation_id, status: row.status };
}

/** The project scope as a SQL parameter: null for organisation-wide. */
export function scopeParameter(principal: ViewerPrincipal): string[] | null {
  return principal.projectIds === null ? null : [...principal.projectIds];
}
