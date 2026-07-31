/**
 * Published-service endpoints (`docs/API.md` §10).
 *
 * ```text
 * GET    /api/v1/projects/:projectId/published-services
 * POST   /api/v1/projects/:projectId/published-services
 * DELETE /api/v1/published-services/:serviceId
 * POST   /api/v1/published-services/:serviceId/capabilities
 * ```
 *
 * The fourth is an addition: a browser session cannot use a route without a
 * capability, and `docs/ARCHITECTURE.md` §7.3 makes the control plane the
 * minting authority. `docs/API.md` §10 records it.
 *
 * Three properties of this surface are load-bearing, and all three changed when
 * the publication UI of `docs/UX_FLOWS.md` §6 arrived.
 *
 * **Who may call it.** Stage 0 accepted only the bootstrap administrator token,
 * because no human session existed and nothing but a script published a route.
 * Publishing from the project Live page means a **cookie** now authenticates
 * these routes, so they resolve the organisation administrator of
 * `modules/identity/authorisation.ts` — which the bootstrap token still maps
 * to, so an operator's `Authorization: Bearer` continues to work unchanged. A
 * browser-worker, agent or connector credential reaches none of them
 * (`docs/SECURITY.md` §6.3).
 *
 * **CSRF.** The moment a cookie can authenticate a state-changing route, a
 * forged cross-origin write becomes possible: the browser attaches the cookie
 * to a request another origin caused, and a bearer token is not attached that
 * way. Every state-changing route here therefore applies the strict
 * `requireCsrfToken`, in a `preHandler` so that it runs **before the body is
 * decoded** — a refusal that happened after parsing would still have spent the
 * work an attacker asked for. Publication is exactly the shape that must not be
 * forgeable: it opens a tunnel from a central browser into a development
 * machine, and minting mints a bearer credential for it.
 *
 * **Scope.** Every lookup carries the identifier, the caller's organisation and
 * the session's project scope in one SQL predicate. A route outside the
 * caller's scope produces no row, so a foreign identifier and an unknown one
 * answer `RESOURCE_NOT_FOUND` byte-identically and neither can be used to
 * enumerate the other (`docs/API.md` §5). `DELETE` is the one that mattered
 * most: it took an identifier and no scope at all, so a route in another
 * organisation could be revoked by anyone who could guess its identifier.
 *
 * Handlers do no authorisation arithmetic of their own beyond that. They parse,
 * they call the service and they render; every domain rule lives in the service
 * layer, which is what `docs/DEVELOPMENT.md` §8 means by authorisation in the
 * service layer rather than the UI.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { Pool } from "../../db/pool.ts";
import { ApiError, apiData, apiError } from "../../errors.ts";
import {
  requireCsrfToken,
  requireOrganisationAdministrator,
  resolveProject,
  scopeParameter,
} from "../identity/authorisation.ts";
import type { ViewerPrincipal } from "../live/viewer-sessions.ts";
import type { EventActor } from "./events.ts";
import type { CallerScope } from "./repository.ts";
import type { PublishedServiceService } from "./service.ts";

/** The maximum page size for the listing endpoint. */
const MAX_LIMIT = 100;

interface CreateBody {
  connector_id?: unknown;
  workspace_id?: unknown;
  local_host?: unknown;
  local_port?: unknown;
  protocol?: unknown;
  ttl_seconds?: unknown;
  allowed_browser_session_ids?: unknown;
}

interface MintBody {
  browser_session_id?: unknown;
  ttl_seconds?: unknown;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError("VALIDATION_FAILED", `${field} is required.`, { field });
  }
  if (value.length > 64) {
    throw new ApiError("VALIDATION_FAILED", `${field} is too long.`, { field });
  }
  return value;
}

function requirePort(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ApiError("VALIDATION_FAILED", "local_port must be a port number.", {
      field: "local_port",
    });
  }
  return value;
}

function requireSessionIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ApiError("VALIDATION_FAILED", "allowed_browser_session_ids is required.", {
      field: "allowed_browser_session_ids",
    });
  }
  return value.map((entry, index) =>
    requireString(entry, `allowed_browser_session_ids[${String(index)}]`),
  );
}

/**
 * The scope a principal acts in.
 *
 * It is read from the **principal** and never from the record being reached.
 * `organisationId` is null for the organisation-wide bootstrap administrator,
 * which belongs to no organisation row (ADR-0016); `projectIds` is null for a
 * session that is not delegated to a subset of projects.
 */
function scopeOf(principal: ViewerPrincipal): CallerScope {
  return { organisationId: principal.organisationId, projectIds: scopeParameter(principal) };
}

/** The actor an event is attributed to (`docs/EVENTS.md` §5). */
function actorOfPrincipal(principal: ViewerPrincipal): EventActor {
  return {
    type: "human_user",
    ...(principal.userId === null ? {} : { id: principal.userId }),
    ...(principal.display === null ? {} : { display: principal.display }),
  };
}

export interface PublishedServiceRouteOptions {
  readonly pool: Pool;
  readonly service: PublishedServiceService;
}

export function registerPublishedServiceRoutes(
  app: FastifyInstance,
  options: PublishedServiceRouteOptions,
): void {
  const { pool, service } = options;

  /**
   * The guard every state-changing route on this surface uses.
   *
   * It runs as a `preHandler`, which Fastify invokes after routing and before
   * the handler, and it refuses on the credential alone: nothing in the body is
   * read to decide it.
   */
  const administratorWrite = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const principal = requireOrganisationAdministrator(request);
    requireCsrfToken(request, principal);
    await Promise.resolve();
  };

  const administratorRead = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    requireOrganisationAdministrator(request);
    await Promise.resolve();
  };

  app.get<{ Params: { projectId: string }; Querystring: { limit?: string } }>(
    "/api/v1/projects/:projectId/published-services",
    { preHandler: administratorRead },
    async (request, reply) => {
      const principal = requireOrganisationAdministrator(request);
      // Resolving the project first means an unreachable project is absent
      // rather than an empty list, which would be indistinguishable from a
      // project that simply has no routes.
      const project = await resolveProject(pool, principal, request.params.projectId);
      const limit = Math.min(Number(request.query.limit ?? MAX_LIMIT) || MAX_LIMIT, MAX_LIMIT);
      const services = await service.list(project.id, scopeOf(principal), limit);
      return reply.send(apiData(services, request.id));
    },
  );

  app.post<{ Params: { projectId: string }; Body: CreateBody }>(
    "/api/v1/projects/:projectId/published-services",
    { preHandler: administratorWrite },
    async (request, reply) => {
      const principal = requireOrganisationAdministrator(request);
      const project = await resolveProject(pool, principal, request.params.projectId);
      const body = request.body ?? {};
      const created = await service.create(
        {
          projectId: project.id,
          // The organisation of the resolved project, not the deployment's
          // default and not the caller's: those three can differ, and a row
          // whose organisation and project disagree is one no reader can act on.
          organisationId: project.organisationId,
          connectorId: requireString(body.connector_id, "connector_id"),
          workspaceId: requireString(body.workspace_id, "workspace_id"),
          localHost: requireString(body.local_host, "local_host"),
          localPort: requirePort(body.local_port),
          protocol: requireString(body.protocol ?? "http", "protocol"),
          ttlSeconds: typeof body.ttl_seconds === "number" ? body.ttl_seconds : 3600,
          allowedBrowserSessionIds: requireSessionIds(body.allowed_browser_session_ids),
        },
        actorOfPrincipal(principal),
        request.id,
      );
      return reply.code(201).send(apiData(created, request.id));
    },
  );

  app.delete<{ Params: { serviceId: string } }>(
    "/api/v1/published-services/:serviceId",
    { preHandler: administratorWrite },
    async (request, reply) => {
      const principal = requireOrganisationAdministrator(request);
      const revoked = await service.revoke(
        request.params.serviceId,
        scopeOf(principal),
        actorOfPrincipal(principal),
        request.id,
      );
      return reply.send(apiData(revoked, request.id));
    },
  );

  app.post<{ Params: { serviceId: string }; Body: MintBody }>(
    "/api/v1/published-services/:serviceId/capabilities",
    { preHandler: administratorWrite },
    async (request, reply) => {
      const principal = requireOrganisationAdministrator(request);
      const body = request.body ?? {};
      const minted = await service.mint(
        request.params.serviceId,
        requireString(body.browser_session_id, "browser_session_id"),
        typeof body.ttl_seconds === "number" ? body.ttl_seconds : undefined,
        scopeOf(principal),
        actorOfPrincipal(principal),
        request.id,
      );
      return reply.code(201).send(apiData(minted, request.id));
    },
  );
}

/**
 * Renders a failure.
 *
 * One hook renders every error so that no handler can answer with a stack
 * trace or an unstructured message, and so that an unexpected failure becomes
 * `INTERNAL_ERROR` rather than leaking what went wrong
 * (`docs/SECURITY.md` §18).
 */
export function renderError(error: unknown, request: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof ApiError) {
    void reply.code(error.status).send(apiError(error.code, error.message, request.id, error.details));
    return;
  }
  request.log.error({ err: error, request_id: request.id }, "unhandled failure");
  void reply
    .code(500)
    .send(apiError("INTERNAL_ERROR", "The request could not be completed.", request.id));
}
