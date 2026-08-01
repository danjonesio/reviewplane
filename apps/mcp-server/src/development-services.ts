/**
 * The agent-facing half of published development services
 * (`docs/MCP_SPEC.md` §7.2).
 *
 * Two things about this file are security properties rather than plumbing.
 *
 * **Nothing the agent sends chooses a machine.** `development_service_publish`
 * takes a workspace, a local host, a port, a protocol and a lifetime, and that
 * is the whole of §7.2's input. The connector and the browser sessions the
 * route authorises are resolved *here*, from the session's project, because a
 * caller that could name either would be choosing which development machine the
 * central browser reaches — which is the SSRF surface `docs/SECURITY.md` §9
 * exists to close. The schema has no member to put them in, and this file has
 * no code path that would read one.
 *
 * **Publication is two-phase, and this process only performs the first half.**
 * A connector dials the control plane, so its control channel terminates in the
 * `api` process and nowhere else; the MCP endpoint is a separate process
 * (ADR-0020) sharing only the database and the tunnel gateway's control
 * listener. So this process writes the route as `requested` and waits, bounded,
 * for `api` to finish it (ADR-0021). Revocation is not split that way: the
 * gateway verifies a capability from its signature without a database read, so
 * a record marked revoked while the gateway still carried the route would be a
 * revocation of nothing.
 */

import type { Pool } from "pg";

import {
  ApiError,
  type CallerScope,
  type CreatePublishedServiceInput,
  type PublishedServiceService,
  type PublishedServiceView,
} from "@reviewplane/server/domain";

import type { McpConnection } from "./context.ts";

/** The listing bound. It matches the schema's `maxItems`. */
export const MAX_DEVELOPMENT_SERVICES = 100;

/** Route lifetime when the agent names none. One hour of a coding session. */
export const DEFAULT_ROUTE_TTL_SECONDS = 3600;

/**
 * Browser-session statuses a route may authorise.
 *
 * `REQUESTED` is included deliberately: a session's identifier is reserved
 * before the route is published, precisely so it can be named in
 * `allowed_browser_session_ids` before its egress origin is fixed
 * (`docs/API.md` §11). A terminal session is excluded, because a route
 * authorising only sessions that have ended authorises nobody.
 */
const AUTHORISABLE_SESSION_STATUSES = ["REQUESTED", "ALLOCATING", "READY", "ACTIVE", "PAUSED"];

/**
 * The scope an MCP connection acts in.
 *
 * It comes from the credential and the session, never from a tool argument and
 * never from the record being reached. An agent credential carries one
 * organisation and a non-empty set of projects (ADR-0020), and the session is
 * bound to one of them.
 */
export function scopeOf(connection: McpConnection): CallerScope {
  return {
    organisationId: connection.credential.organisationId,
    projectIds: [connection.project.id],
  };
}

export interface ConnectorReference {
  readonly id: string;
  readonly status: string;
}

export class DevelopmentServiceCommands {
  readonly #pool: Pool;
  readonly #services: PublishedServiceService;
  readonly #publishWaitMs: number;

  constructor(pool: Pool, services: PublishedServiceService, publishWaitMs: number) {
    this.#pool = pool;
    this.#services = services;
    this.#publishWaitMs = publishWaitMs;
  }

  list(projectId: string, scope: CallerScope, limit?: number): Promise<PublishedServiceView[]> {
    // The caller's limit is clamped rather than trusted, and a caller that
    // names none gets the schema's maximum: `docs/MCP_SPEC.md` section 13
    // bounds a response by the server's rule and not by the caller's optimism.
    const page = Math.min(limit ?? MAX_DEVELOPMENT_SERVICES, MAX_DEVELOPMENT_SERVICES);
    return this.#services.list(projectId, scope, page);
  }

  /**
   * The connector that may carry a route for this project.
   *
   * Stage 1 has one connector per project — route failover and several
   * concurrent connectors are Stage 2 — so this resolves the connected one and
   * refuses when there is none. `CONNECTOR_OFFLINE` is the documented class for
   * that (`docs/CONNECTOR_PROTOCOL.md` §21), and it is the same code the UI's
   * "No connector connected" state renders.
   */
  async connectorForProject(projectId: string): Promise<ConnectorReference> {
    const rows = await this.#pool.query<{ id: string; status: string }>(
      `SELECT connectors.id, connectors.status
         FROM connectors
         JOIN environments ON environments.id = connectors.environment_id
        WHERE environments.project_id = $1
          AND connectors.status = 'ACTIVE'
        ORDER BY connectors.last_heartbeat_at DESC NULLS LAST, connectors.id
        LIMIT 1`,
      [projectId],
    );
    const connector = rows.rows[0];
    if (connector === undefined) {
      throw new ApiError(
        "CONNECTOR_OFFLINE",
        "No connector is connected for this project, so there is nothing to publish through.",
      );
    }
    return { id: connector.id, status: connector.status };
  }

  /**
   * The browser sessions a new route may authorise.
   *
   * The agent's own sessions come first and are used alone when it has any: a
   * route is a private path into a development machine, and widening it to
   * every session in the project when the agent has one of its own would grant
   * more than was asked for. When the agent has none, the project's other live
   * sessions are used, because `docs/CONNECTOR_PROTOCOL.md` §11 refuses a route
   * that authorises nobody and a human-started session is the ordinary case for
   * an agent asked to look at what a person is watching.
   */
  async publishableSessions(projectId: string, agentSessionId: string): Promise<string[]> {
    const rows = await this.#pool.query<{ id: string; agent_session_id: string | null }>(
      `SELECT id, agent_session_id
         FROM browser_sessions
        WHERE project_id = $1
          AND status = ANY($2)
        ORDER BY created_at DESC
        LIMIT 32`,
      [projectId, AUTHORISABLE_SESSION_STATUSES],
    );
    const own = rows.rows.filter((row) => row.agent_session_id === agentSessionId);
    return (own.length > 0 ? own : rows.rows).map((row) => row.id);
  }

  /**
   * Requests a route and waits, bounded, for the answer.
   *
   * The wait ends in the record as it stands. A route still `requested` when
   * the deadline passes is reported as `requested`, never as ready: an agent
   * that navigated to an origin nothing was carrying would read the failure as
   * a fault in the application it is reviewing.
   */
  async publish(
    input: CreatePublishedServiceInput,
    scope: CallerScope,
    actor: Parameters<PublishedServiceService["request"]>[1],
    requestId: string,
  ): Promise<PublishedServiceView> {
    const requested = await this.#services.request(input, actor, requestId);
    return this.#services.awaitOutcome(requested.id, scope, { timeoutMs: this.#publishWaitMs });
  }

  revoke(
    serviceId: string,
    scope: CallerScope,
    actor: Parameters<PublishedServiceService["revoke"]>[2],
    requestId: string,
  ): Promise<PublishedServiceView> {
    return this.#services.revoke(serviceId, scope, actor, requestId);
  }
}

/** The agent-facing projection of a route (`development_service_view`). */
export function toDevelopmentServiceView(service: PublishedServiceView): Record<string, unknown> {
  return {
    id: service.id,
    status: service.status,
    workspace_id: service.workspace_id,
    local_host: service.local_host,
    local_port: service.local_port,
    protocol: service.protocol,
    internal_origin: service.internal_origin,
    ...(service.observed_destination === null
      ? {}
      : { observed_destination: service.observed_destination }),
    ...(service.failure_class === null ? {} : { failure_class: service.failure_class }),
    expires_at: service.expires_at,
  };
}
