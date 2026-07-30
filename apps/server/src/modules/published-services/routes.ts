/**
 * Published-service endpoints (`docs/API.md` section 10).
 *
 * ```text
 * GET    /api/v1/projects/:projectId/published-services
 * POST   /api/v1/projects/:projectId/published-services
 * DELETE /api/v1/published-services/:serviceId
 * POST   /api/v1/published-services/:serviceId/capabilities
 * ```
 *
 * The fourth is an addition: a browser session cannot use a route without a
 * capability, and `docs/ARCHITECTURE.md` section 7.3 makes the control plane
 * the minting authority. `docs/API.md` section 10 records it.
 *
 * Handlers do no authorisation arithmetic of their own. They parse, they call
 * the service and they render; every rule lives in the service layer, which is
 * what `docs/DEVELOPMENT.md` section 8 means by authorisation in the service
 * layer rather than the UI.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { ApiError, apiData, apiError } from "../../errors.ts";
import type { EventActor } from "./events.ts";
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
 * The Stage 0 actor.
 *
 * Human accounts and agent sessions arrive with the issues that introduce them;
 * until then every authenticated caller is the bootstrap administrator, and
 * saying so explicitly is better than a placeholder that later reads as a real
 * identity (`docs/EVENTS.md` section 5: actor identity is never inferred from
 * display text).
 */
const BOOTSTRAP_ACTOR: EventActor = {
  type: "human_user",
  id: "usr_bootstrap",
  display: "Bootstrap administrator",
};

export interface PublishedServiceRouteOptions {
  readonly service: PublishedServiceService;
  /** Runs before every handler. */
  readonly authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export function registerPublishedServiceRoutes(
  app: FastifyInstance,
  options: PublishedServiceRouteOptions,
): void {
  const { service, authenticate } = options;

  app.get<{ Params: { projectId: string }; Querystring: { limit?: string } }>(
    "/api/v1/projects/:projectId/published-services",
    { preHandler: authenticate },
    async (request, reply) => {
      const limit = Math.min(Number(request.query.limit ?? MAX_LIMIT) || MAX_LIMIT, MAX_LIMIT);
      const services = await service.list(request.params.projectId, limit);
      return reply.send(apiData(services, request.id));
    },
  );

  app.post<{ Params: { projectId: string }; Body: CreateBody }>(
    "/api/v1/projects/:projectId/published-services",
    { preHandler: authenticate },
    async (request, reply) => {
      const body = request.body ?? {};
      const created = await service.create(
        {
          projectId: request.params.projectId,
          connectorId: requireString(body.connector_id, "connector_id"),
          workspaceId: requireString(body.workspace_id, "workspace_id"),
          localHost: requireString(body.local_host, "local_host"),
          localPort: requirePort(body.local_port),
          protocol: requireString(body.protocol ?? "http", "protocol"),
          ttlSeconds: typeof body.ttl_seconds === "number" ? body.ttl_seconds : 3600,
          allowedBrowserSessionIds: requireSessionIds(body.allowed_browser_session_ids),
        },
        BOOTSTRAP_ACTOR,
        request.id,
      );
      return reply.code(201).send(apiData(created, request.id));
    },
  );

  app.delete<{ Params: { serviceId: string } }>(
    "/api/v1/published-services/:serviceId",
    { preHandler: authenticate },
    async (request, reply) => {
      const revoked = await service.revoke(request.params.serviceId, BOOTSTRAP_ACTOR, request.id);
      return reply.send(apiData(revoked, request.id));
    },
  );

  app.post<{ Params: { serviceId: string }; Body: MintBody }>(
    "/api/v1/published-services/:serviceId/capabilities",
    { preHandler: authenticate },
    async (request, reply) => {
      const body = request.body ?? {};
      const minted = await service.mint(
        request.params.serviceId,
        requireString(body.browser_session_id, "browser_session_id"),
        typeof body.ttl_seconds === "number" ? body.ttl_seconds : undefined,
        BOOTSTRAP_ACTOR,
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
 * (`docs/SECURITY.md` section 18).
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
