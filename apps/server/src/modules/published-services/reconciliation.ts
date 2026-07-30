/**
 * Applying reconnect reconciliation (`docs/CONNECTOR_PROTOCOL.md` §17).
 *
 * The decision table is in `../connectors/reconciliation.ts` and is pure. This
 * is where its answers become real: routes the control plane will not continue
 * are withdrawn from the gateway and ended in the database, browser sessions
 * bound to them are marked degraded rather than terminated, and every decision
 * produces the lifecycle event `docs/EVENTS.md` §7 names.
 *
 * The ordering is deliberate and is the same one revocation uses: the gateway
 * is told first. Marking a record closed while the gateway still carried the
 * route would leave the tunnel open with the control plane believing it shut,
 * which is the one ordering that turns a closure into a lie.
 */

import type { ReconnectRequest, ReconnectResponse, RouteDecision } from "@reviewplane/protocol";
import type { FastifyBaseLogger } from "fastify";

import type { Pool } from "../../db/pool.ts";
import { inTransaction } from "../../db/pool.ts";
import { appendEvent } from "../../events/append.ts";
import {
  boundDecisions,
  classifyUpgrade,
  decideSessions,
  formatDestination,
  reconcileRoutes,
  type AuthoritativeRoute,
  type ClaimedRoute,
  type ConnectorReconciler,
  type ReconciledRoute,
  type UpgradePolicy,
} from "../connectors/reconciliation.ts";
import type { TunnelGateway } from "./gateway-client.ts";
import * as repository from "./repository.ts";
import type { PublishedService } from "./repository.ts";

/** Bound on the routes one reconciliation reads for a connector. */
const MAX_LIVE_ROUTES = 256;

export interface ReconcilerConfig {
  readonly organisationId: string;
  readonly upgrade: UpgradePolicy;
}

function toAuthoritative(record: PublishedService): AuthoritativeRoute {
  return {
    routeId: record.id,
    projectId: record.project_id,
    connectorId: record.connector_id,
    workspaceId: record.workspace_id,
    localHost: record.local_host,
    localPort: record.local_port,
    protocol: record.protocol === "https" ? "https" : "http",
    expiresAt: record.expires_at,
    status: record.status,
    allowedBrowserSessionIds: record.allowed_browser_session_ids,
    observedDestination: record.observed_destination,
  };
}

function toClaimed(request: ReconnectRequest): ClaimedRoute[] {
  return request.active_routes.map((route) => ({
    routeId: route.route_id,
    projectId: route.project_id,
    workspaceId: route.workspace_id,
    observedDestination: route.observed_destination,
    expiresAt: route.expires_at,
  }));
}

export class PublishedServiceReconciler implements ConnectorReconciler {
  readonly #pool: Pool;
  readonly #gateway: TunnelGateway;
  readonly #config: ReconcilerConfig;
  readonly #logger: FastifyBaseLogger;
  readonly #now: () => Date;

  constructor(
    pool: Pool,
    gateway: TunnelGateway,
    config: ReconcilerConfig,
    logger: FastifyBaseLogger,
    now: () => Date = () => new Date(),
  ) {
    this.#pool = pool;
    this.#gateway = gateway;
    this.#config = config;
    this.#logger = logger;
    this.#now = now;
  }

  async reconcile(input: {
    readonly connectorId: string;
    readonly request: ReconnectRequest;
    readonly requestId: string;
  }): Promise<ReconnectResponse> {
    const now = this.#now();
    const claimed = toClaimed(input.request);

    const client = await this.#pool.connect();
    let authoritative: AuthoritativeRoute[];
    try {
      const own = await repository.findLiveForConnector(client, input.connectorId, MAX_LIVE_ROUTES);
      const named = await repository.findByIds(
        client,
        claimed.map((route) => route.routeId),
      );
      const merged = new Map<string, PublishedService>();
      for (const record of [...own, ...named]) merged.set(record.id, record);
      authoritative = [...merged.values()].map(toAuthoritative);
    } finally {
      client.release();
    }

    const decided = boundDecisions(
      reconcileRoutes({ connectorId: input.connectorId, claimed, authoritative, now }),
    );

    for (const entry of decided) {
      await this.#closeIfNeeded(entry, input, now);
    }

    const sessions = decideSessions(decided);
    await this.#applySessionDecisions(input.connectorId, decided, input.requestId, now);

    const upgrade = classifyUpgrade(input.request.connector_version, this.#config.upgrade);
    const routes: RouteDecision[] = decided.map((entry) => entry.decision);

    // One line carrying the connector identity and every route identifier, which
    // is what `docs/ARCHITECTURE.md` §15 asks for on the path operators debug
    // most often. No credential appears: the payload has no field for one, and
    // the decisions are a closed vocabulary.
    this.#logger.info(
      {
        connector_id: input.connectorId,
        request_id: input.requestId,
        connector_version: input.request.connector_version,
        upgrade,
        claimed_routes: claimed.map((route) => route.routeId),
        claimed_streams: input.request.active_streams.length,
        decisions: routes.map((route) => ({
          route_id: route.route_id,
          decision: route.decision,
          reason: route.reason,
        })),
        sessions: sessions.map((session) => ({
          browser_session_id: session.browser_session_id,
          decision: session.decision,
          reason: session.reason,
        })),
      },
      "connector reconciliation",
    );

    return {
      reconciled_at: now.toISOString(),
      upgrade,
      routes,
      sessions,
    };
  }

  /** Ends a route the reconciliation refused to continue. */
  async #closeIfNeeded(
    entry: ReconciledRoute,
    input: { readonly connectorId: string; readonly requestId: string },
    now: Date,
  ): Promise<void> {
    if (entry.decision.decision !== "revoke") return;
    const routeId = entry.decision.route_id;
    const record = entry.record;

    if (entry.closure === "none") {
      if (record === null) {
        // A route this control plane never had. There is no record to end and
        // no project to attribute it to, so the audit trail records the refusal
        // against the organisation stream.
        await inTransaction(this.#pool, async (client) => {
          await appendEvent(client, {
            type: "published_service.revoked",
            organisationId: this.#config.organisationId,
            actor: { type: "connector", id: input.connectorId },
            correlation: {
              request_id: input.requestId,
              connector_id: input.connectorId,
              published_service_id: routeId,
            },
            payload: {
              published_service_id: routeId,
              new_status: "revoked",
              error_class: "ROUTE_EXPIRED",
              reason: entry.decision.reason,
              trigger: "reconnect_reconciliation",
            },
            occurredAt: now,
          });
        });
      }
      // A record that has already ended, or one owned by another connector, is
      // left exactly as it is. The connector is still told to close it.
      return;
    }

    await this.#gateway.revokeRoute(routeId);
    await inTransaction(this.#pool, async (client) => {
      const ended = await repository.markEnded(
        client,
        routeId,
        entry.closure === "expired" ? "expired" : "revoked",
      );
      if (ended === null) return;
      const revokedCapabilities = await repository.revokeCapabilitiesForService(client, routeId);
      await appendEvent(client, {
        type: entry.closure === "expired" ? "published_service.expired" : "published_service.revoked",
        organisationId: this.#config.organisationId,
        projectId: ended.project_id,
        actor: { type: "connector", id: input.connectorId },
        correlation: {
          request_id: input.requestId,
          connector_id: input.connectorId,
          published_service_id: routeId,
        },
        payload: {
          published_service_id: routeId,
          previous_status: record?.status ?? "ready",
          new_status: entry.closure === "expired" ? "expired" : "revoked",
          reason: entry.decision.reason,
          trigger: "reconnect_reconciliation",
          revoked_capability_ids: revokedCapabilities,
        },
        occurredAt: now,
      });
    });
  }

  /**
   * Returns sessions whose route resumed to a usable status, and leaves the
   * rest degraded.
   *
   * A session is never terminated here. `docs/ARCHITECTURE.md` §14 requires the
   * review and session metadata to be retained through a connector outage, and
   * `docs/DOMAIN_MODEL.md` §12 has `DEGRADED` for exactly this: allocated, not
   * usable, still diagnosable.
   */
  async #applySessionDecisions(
    connectorId: string,
    decided: readonly ReconciledRoute[],
    requestId: string,
    now: Date,
  ): Promise<void> {
    // Two ways a session is affected by a route, and both must be answered,
    // because `handleDisconnect` degrades by both: the route names the session
    // in its allow-list, and the session record names the route it was allocated
    // against. Restoring only the first would leave a session degraded for ever
    // whenever the two disagree.
    const namedSessions = new Set<string>();
    const continuedRoutes = new Set<string>();
    for (const entry of decided) {
      if (entry.decision.decision !== "continue") continue;
      continuedRoutes.add(entry.decision.route_id);
      for (const session of entry.record?.allowedBrowserSessionIds ?? []) namedSessions.add(session);
    }
    if (continuedRoutes.size === 0 && namedSessions.size === 0) return;

    const client = await this.#pool.connect();
    let sessions: repository.BoundBrowserSession[];
    try {
      const bound = await repository.findLiveSessionsForConnector(client, connectorId);
      const named = await repository.findLiveSessionsByIds(client, [...namedSessions]);
      const candidates = new Map<string, repository.BoundBrowserSession>();
      for (const session of bound) {
        if (session.published_service_id !== null && continuedRoutes.has(session.published_service_id)) {
          candidates.set(session.id, session);
        }
      }
      for (const session of named) candidates.set(session.id, session);
      sessions = [...candidates.values()];
    } finally {
      client.release();
    }

    for (const session of sessions) {
      if (session.status !== "DEGRADED") continue;
      await inTransaction(this.#pool, async (transaction) => {
        const previous = await repository.setSessionStatus(transaction, session.id, "READY", [
          "DEGRADED",
        ]);
        if (previous === null) return;
        await appendEvent(transaction, {
          type: "browser_session.resumed",
          organisationId: session.organisation_id,
          projectId: session.project_id,
          actor: { type: "connector", id: connectorId },
          correlation: {
            request_id: requestId,
            connector_id: connectorId,
            browser_session_id: session.id,
            ...(session.published_service_id === null
              ? {}
              : { published_service_id: session.published_service_id }),
          },
          payload: {
            previous_status: previous,
            new_status: "READY",
            reason: "connector_reconnected",
          },
          occurredAt: now,
        });
      });
    }
  }

  /**
   * A connector's channel has gone.
   *
   * Its routes stay in the record — they are unavailable, not revoked, and a
   * reconnect within their TTL resumes them — and every browser session bound to
   * one is marked degraded so that the outage is visible in the session rather
   * than only in a log.
   */
  async handleDisconnect(input: {
    readonly connectorId: string;
    readonly requestId: string;
  }): Promise<void> {
    const now = this.#now();
    const client = await this.#pool.connect();
    let sessions: repository.BoundBrowserSession[];
    try {
      sessions = await repository.findLiveSessionsForConnector(client, input.connectorId);
    } finally {
      client.release();
    }
    if (sessions.length === 0) return;

    const degraded: string[] = [];
    for (const session of sessions) {
      await inTransaction(this.#pool, async (transaction) => {
        const previous = await repository.setSessionStatus(transaction, session.id, "DEGRADED", [
          "REQUESTED",
          "ALLOCATING",
          "READY",
          "ACTIVE",
          "PAUSED",
        ]);
        if (previous === null) return;
        degraded.push(session.id);
        await appendEvent(transaction, {
          type: "browser_session.degraded",
          organisationId: session.organisation_id,
          projectId: session.project_id,
          actor: { type: "connector", id: input.connectorId },
          correlation: {
            request_id: input.requestId,
            connector_id: input.connectorId,
            browser_session_id: session.id,
            ...(session.published_service_id === null
              ? {}
              : { published_service_id: session.published_service_id }),
            ...(session.worker_id === null ? {} : { worker_id: session.worker_id }),
          },
          payload: {
            previous_status: previous,
            new_status: "DEGRADED",
            reason: "connector_disconnected",
          },
          occurredAt: now,
        });
      });
    }
    if (degraded.length > 0) {
      this.#logger.warn(
        { connector_id: input.connectorId, browser_session_ids: degraded },
        "browser sessions degraded by a connector disconnect",
      );
    }
  }
}

export { formatDestination };
