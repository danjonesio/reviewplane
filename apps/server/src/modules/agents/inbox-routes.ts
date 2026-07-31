/**
 * Inbox endpoints (`docs/API.md` section 16).
 *
 * These are the human half of the inbox. An agent reaches the same records
 * through `agent_inbox_list` and `agent_inbox_acknowledge` on the MCP endpoint,
 * and both call the same store, so "acknowledgement is not completion" has one
 * implementation and two callers.
 *
 * Three properties are enforced here rather than assumed.
 *
 * **A machine credential cannot reach these routes.** An agent token and a
 * worker credential are refused by shape, before any lookup, exactly as they
 * are on the review routes: `docs/SECURITY.md` section 6.3 says an agent token
 * must not reach administrative APIs, and an inbox is where work is directed.
 *
 * **Every state-changing route carries the CSRF guard, before the body is
 * decoded and before the record is looked up.** These routes are reachable by
 * cookie, so a request another origin caused would otherwise be able to
 * complete or dismiss delivered feedback — which is the quietest possible way
 * to make a review disappear (`docs/API.md` section 4.0).
 *
 * **The scope comes from the authenticated principal.** The identifier, the
 * session's project scope and the session's organisation travel in one query,
 * so a foreign identifier and an unknown one answer identically.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import { ApiError, notFound } from "../../errors.ts";
import type { EventActor } from "../../events/append.ts";
import { buildPage, pageMeta, readPageRequest } from "../../http/pagination.ts";
import {
  actorOf,
  requireCsrfToken,
  resolveProject,
  scopeParameter,
} from "../identity/authorisation.ts";
import type { ViewerPrincipal } from "../live/viewer-sessions.ts";
import type { InboxItemStatus, InboxScope, InboxStore } from "./inbox.ts";

export interface InboxRoutesOptions {
  readonly pool: Pool;
  readonly inbox: InboxStore;
  readonly viewerAuth: (request: FastifyRequest) => Promise<ViewerPrincipal>;
}

const STATUSES: readonly InboxItemStatus[] = [
  "pending",
  "acknowledged",
  "completed",
  "dismissed",
  "expired",
];

function humanActor(principal: ViewerPrincipal): EventActor {
  return { type: "human_user", id: principal.viewerSessionId, display: principal.display };
}

export async function registerInboxRoutes(
  app: FastifyInstance,
  options: InboxRoutesOptions,
): Promise<void> {
  const { pool, inbox } = options;

  const refuseMachineCredentials = (request: FastifyRequest): void => {
    const actor = actorOf(request);
    if (actor.type !== "agent" && actor.type !== "browser_worker") return;
    request.log.warn(
      { route: request.url, actor: actor.type },
      "inbox route refused a machine credential",
    );
    throw new ApiError(
      "AUTHORISATION_DENIED",
      actor.type === "agent"
        ? "An agent credential is not a human session and cannot call the inbox API (docs/SECURITY.md section 6.3). Agents read and acknowledge their own inbox through /mcp/v1."
        : "A browser-worker credential is not a human session and cannot call the inbox API.",
      { reason: "machine_credential_on_human_route" },
    );
  };

  const scopeForProject = async (
    request: FastifyRequest,
    projectId: string,
    intent: "read" | "write",
  ): Promise<{ scope: InboxScope; actor: EventActor }> => {
    refuseMachineCredentials(request);
    const principal = await options.viewerAuth(request);
    if (intent === "write") requireCsrfToken(request, principal);
    const project = await resolveProject(pool, principal, projectId);
    return {
      scope: { organisationId: project.organisationId, projectId: project.id },
      actor: humanActor(principal),
    };
  };

  /**
   * The scope for an item reached by its own identifier, in one query.
   *
   * The CSRF guard runs before the lookup and before any body is decoded, so a
   * forged request is refused without touching the record it named.
   */
  const scopedItem = async (
    request: FastifyRequest,
    itemId: string,
    intent: "read" | "write",
  ): Promise<{ scope: InboxScope; actor: EventActor }> => {
    refuseMachineCredentials(request);
    const principal = await options.viewerAuth(request);
    if (intent === "write") requireCsrfToken(request, principal);
    const rows = await pool.query<{ organisation_id: string; project_id: string }>(
      `SELECT organisation_id, project_id
         FROM inbox_items
        WHERE id = $1
          AND ($2::text[] IS NULL OR project_id = ANY($2))
          AND ($3::text IS NULL OR organisation_id = $3)`,
      [itemId, scopeParameter(principal), principal.organisationId],
    );
    const row = rows.rows[0];
    if (row === undefined) throw notFound("The inbox item");
    return {
      scope: { organisationId: row.organisation_id, projectId: row.project_id },
      actor: humanActor(principal),
    };
  };

  const send = (reply: FastifyReply, request: FastifyRequest, data: unknown, status = 200) =>
    reply.status(status).send({ data, meta: { request_id: request.id } });

  app.get("/api/v1/projects/:projectId/inbox", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { scope } = await scopeForProject(request, projectId, "read");
    const query = request.query as { status?: string | string[] };
    const requested = query.status === undefined ? [] : [query.status].flat();
    const unknown = requested.find((value) => !STATUSES.includes(value as InboxItemStatus));
    if (unknown !== undefined) {
      throw new ApiError("UNSUPPORTED_CAPABILITY", "status is not an inbox status.", {
        field: "status",
      });
    }
    const page = readPageRequest(request.query);
    const result = await inbox.list(scope, {
      ...(requested.length === 0 ? {} : { statuses: requested as InboxItemStatus[] }),
      limit: page.limit + 1,
      after: page.after,
    });
    const built = buildPage([...result.items], page, (item) => ({
      sortKey: item.created_at,
      id: item.id,
    }));
    return reply.status(200).send({
      data: built.items,
      meta: { ...pageMeta(request.id, built.nextCursor), pending_count: result.pendingCount },
    });
  });

  app.post("/api/v1/inbox/:itemId/acknowledge", async (request, reply) => {
    const { itemId } = request.params as { itemId: string };
    const { scope, actor } = await scopedItem(request, itemId, "write");
    const result = await inbox.transition(scope, itemId, "acknowledged", actor);
    return send(reply, request, result.item);
  });

  app.post("/api/v1/inbox/:itemId/complete", async (request, reply) => {
    const { itemId } = request.params as { itemId: string };
    const { scope, actor } = await scopedItem(request, itemId, "write");
    const result = await inbox.transition(scope, itemId, "completed", actor);
    return send(reply, request, result.item);
  });

  app.post("/api/v1/inbox/:itemId/dismiss", async (request, reply) => {
    const { itemId } = request.params as { itemId: string };
    const { scope, actor } = await scopedItem(request, itemId, "write");
    const body = (request.body ?? {}) as { reason?: unknown };
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 512) : undefined;
    const result = await inbox.transition(scope, itemId, "dismissed", actor, {
      ...(reason === undefined ? {} : { reason }),
    });
    return send(reply, request, result.item);
  });
}
