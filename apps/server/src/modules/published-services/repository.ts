/**
 * Persistence for published services and the capabilities minted against them.
 *
 * Reads split into two families, and which one a caller may use is the whole
 * security property of this file.
 *
 * **Caller-facing reads carry the caller's scope.** {@link findInScope} and
 * {@link listInScope} take the identifier, the organisation and the session's
 * project scope and put all three in **one** predicate, so a route outside the
 * caller's scope produces no row rather than a row that a later `if` is trusted
 * to reject. That is what makes a foreign identifier and an unknown one answer
 * `RESOURCE_NOT_FOUND` byte-identically (`docs/API.md` section 5), and it is
 * the shape RVP-66 records: the organisation is a term in the query, never a
 * value read back off the record that was found.
 *
 * **Internal reads carry the scope their own caller already established.** The
 * expiry sweep, reconnect reconciliation and connector revocation act for the
 * system or for one connector identity, and their scope is the connector or the
 * clock rather than a human session. They are named for what they select —
 * {@link findDueForExpiry}, {@link findLiveForConnector} — and none of them is
 * reachable from an HTTP handler.
 *
 * There is deliberately no unscoped read by identifier. One existed, every
 * caller-facing path used it, and the result was that `DELETE
 * /api/v1/published-services/:serviceId` revoked another organisation's route.
 */

import type { PoolClient } from "../../db/pool.ts";

/** Statuses of `docs/DOMAIN_MODEL.md` section 10. */
export type PublishedServiceStatus = "requested" | "ready" | "failed" | "expired" | "revoked";

/** The published-service record. */
export interface PublishedService {
  readonly id: string;
  readonly organisation_id: string;
  readonly project_id: string;
  readonly connector_id: string;
  readonly workspace_id: string;
  readonly public_alias: string;
  readonly local_host: string;
  readonly local_port: number;
  readonly protocol: string;
  readonly scope: string;
  readonly allowed_browser_session_ids: readonly string[];
  readonly expires_at: Date;
  readonly status: PublishedServiceStatus;
  readonly failure_class: string | null;
  readonly observed_destination: string | null;
  readonly requested_at: Date;
  readonly ready_at: Date | null;
  readonly ended_at: Date | null;
}

const COLUMNS = `
  id, organisation_id, project_id, connector_id, workspace_id, public_alias,
  local_host, local_port, protocol, scope, allowed_browser_session_ids,
  expires_at, status, failure_class, observed_destination,
  requested_at, ready_at, ended_at
`;

export interface InsertPublishedService {
  readonly id: string;
  readonly organisationId: string;
  readonly projectId: string;
  readonly connectorId: string;
  readonly workspaceId: string;
  readonly publicAlias: string;
  readonly localHost: string;
  readonly localPort: number;
  readonly protocol: string;
  readonly allowedBrowserSessionIds: readonly string[];
  readonly expiresAt: Date;
  /** When publication was asked for, from the service's clock. */
  readonly requestedAt: Date;
}

export async function insertRequested(
  client: PoolClient,
  input: InsertPublishedService,
): Promise<PublishedService> {
  const result = await client.query<PublishedService>(
    `INSERT INTO published_services (
       id, organisation_id, project_id, connector_id, workspace_id, public_alias,
       local_host, local_port, protocol, scope, allowed_browser_session_ids,
       expires_at, status, requested_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'browser_session', $10, $11, 'requested', $12)
     RETURNING ${COLUMNS}`,
    [
      input.id,
      input.organisationId,
      input.projectId,
      input.connectorId,
      input.workspaceId,
      input.publicAlias,
      input.localHost,
      input.localPort,
      input.protocol,
      [...input.allowedBrowserSessionIds],
      input.expiresAt.toISOString(),
      // The service's clock, not the column default. `expires_at` is already
      // computed from the injected clock, and the completion sweep compares
      // `requested_at` against that same clock: a row stamped by `now()` and
      // read against an injected instant is two clocks compared to each other,
      // which is the confusion `docs/TESTING.md` §6 warns about for stream and
      // socket deadlines. The same argument applies here.
      input.requestedAt.toISOString(),
    ],
  );
  return result.rows[0] as PublishedService;
}

export async function markReady(
  client: PoolClient,
  id: string,
  observedDestination: string,
): Promise<PublishedService | null> {
  const result = await client.query<PublishedService>(
    `UPDATE published_services
        SET status = 'ready', observed_destination = $2, ready_at = now()
      WHERE id = $1 AND status = 'requested'
      RETURNING ${COLUMNS}`,
    [id, observedDestination],
  );
  return result.rows[0] ?? null;
}

export async function markFailed(
  client: PoolClient,
  id: string,
  failureClass: string,
): Promise<PublishedService | null> {
  const result = await client.query<PublishedService>(
    `UPDATE published_services
        SET status = 'failed', failure_class = $2, ended_at = now()
      WHERE id = $1 AND status IN ('requested', 'ready')
      RETURNING ${COLUMNS}`,
    [id, failureClass],
  );
  return result.rows[0] ?? null;
}

/**
 * Ends a route.
 *
 * The status filter is what makes the transition idempotent under a retry: a
 * second revocation of the same route changes nothing and returns null, rather
 * than producing a second `published_service.revoked` event.
 */
export async function markEnded(
  client: PoolClient,
  id: string,
  status: "expired" | "revoked",
): Promise<PublishedService | null> {
  const result = await client.query<PublishedService>(
    `UPDATE published_services
        SET status = $2, ended_at = now()
      WHERE id = $1 AND status IN ('requested', 'ready')
      RETURNING ${COLUMNS}`,
    [id, status],
  );
  return result.rows[0] ?? null;
}

/**
 * The scope a caller acts in.
 *
 * `organisationId` is `null` only for the organisation-wide bootstrap
 * administrator, which `docs/adr/0016-viewer-sessions-from-bootstrap-token.md`
 * defines as belonging to no organisation row; `projectIds` is `null` for a
 * session that is not delegated to a subset of projects. Both mirror
 * `modules/identity/authorisation.ts`, so one rule about what a principal may
 * reach is expressed once.
 */
export interface CallerScope {
  readonly organisationId: string | null;
  readonly projectIds: readonly string[] | null;
}

/**
 * Reads one route inside the caller's scope.
 *
 * The identifier, the organisation and the project scope are three terms of one
 * predicate. A route in another organisation is *not found* — not found and
 * then refused, which would leak its existence through the difference between
 * two responses.
 */
export async function findInScope(
  client: PoolClient,
  input: { readonly id: string } & CallerScope,
): Promise<PublishedService | null> {
  const result = await client.query<PublishedService>(
    `SELECT ${COLUMNS}
       FROM published_services
      WHERE id = $1
        AND ($2::text IS NULL OR organisation_id = $2)
        AND ($3::text[] IS NULL OR project_id = ANY($3))`,
    [input.id, input.organisationId, input.projectIds === null ? null : [...input.projectIds]],
  );
  return result.rows[0] ?? null;
}

/** Lists one project's routes inside the caller's scope. */
export async function listInScope(
  client: PoolClient,
  input: { readonly projectId: string; readonly limit: number } & CallerScope,
): Promise<PublishedService[]> {
  const result = await client.query<PublishedService>(
    `SELECT ${COLUMNS}
       FROM published_services
      WHERE project_id = $1
        AND ($2::text IS NULL OR organisation_id = $2)
        AND ($3::text[] IS NULL OR project_id = ANY($3))
      ORDER BY requested_at DESC
      LIMIT $4`,
    [
      input.projectId,
      input.organisationId,
      input.projectIds === null ? null : [...input.projectIds],
      input.limit,
    ],
  );
  return result.rows;
}

/**
 * Routes still waiting to be published, older than a grace.
 *
 * The grace is what separates "nobody is finishing this" from "the request
 * that asked for it is finishing it right now". It is an internal read: the
 * scope was established when the route was requested, and the process running
 * the sweep acts for the deployment rather than for a session.
 */
export async function findPending(
  client: PoolClient,
  requestedBefore: Date,
  limit: number,
): Promise<PublishedService[]> {
  const result = await client.query<PublishedService>(
    `SELECT ${COLUMNS}
       FROM published_services
      WHERE status = 'requested' AND requested_at <= $1
      ORDER BY requested_at
      LIMIT $2`,
    [requestedBefore.toISOString(), limit],
  );
  return result.rows;
}

/**
 * Routes that are still live but whose expiry has passed.
 *
 * `requested` is included as well as `ready`. A route that was asked for and
 * never completed — the connector never answered, or the process that would
 * have finished it went away — holds a slot against the per-connector limit for
 * as long as it sits there, and `docs/DOMAIN_MODEL.md` §10 requires that
 * nothing leaves a route in `requested` indefinitely. Selecting only `ready`
 * made that promise depend on a one-second sweep having run, which is not the
 * same thing as the expiry being enforced.
 */
export async function findDueForExpiry(
  client: PoolClient,
  now: Date,
  limit: number,
): Promise<PublishedService[]> {
  const result = await client.query<PublishedService>(
    `SELECT ${COLUMNS}
       FROM published_services
      WHERE status IN ('requested', 'ready') AND expires_at <= $1
      ORDER BY expires_at
      LIMIT $2`,
    [now.toISOString(), limit],
  );
  return result.rows;
}

/**
 * Every route a connector holds in a live status, for reconnect reconciliation
 * (`docs/CONNECTOR_PROTOCOL.md` §17).
 *
 * `requested` is included so that a publication interrupted by the disconnect
 * is visible to the decision table rather than invisible to it.
 */
export async function findLiveForConnector(
  client: PoolClient,
  connectorId: string,
  limit: number,
): Promise<PublishedService[]> {
  const result = await client.query<PublishedService>(
    `SELECT ${COLUMNS}
       FROM published_services
      WHERE connector_id = $1 AND status IN ('requested', 'ready')
      ORDER BY id
      LIMIT $2`,
    [connectorId, limit],
  );
  return result.rows;
}

/**
 * Resolves route identifiers a connector claimed, whoever owns them.
 *
 * The ownership check is the point: a claim on another connector's route has to
 * be refused, and refusing it needs the record it names, not only the records
 * the claiming connector owns.
 */
export async function findByIds(
  client: PoolClient,
  ids: readonly string[],
): Promise<PublishedService[]> {
  if (ids.length === 0) return [];
  const result = await client.query<PublishedService>(
    `SELECT ${COLUMNS} FROM published_services WHERE id = ANY($1::text[]) ORDER BY id`,
    [[...ids]],
  );
  return result.rows;
}

/** A browser session bound to one of a connector's routes. */
export interface BoundBrowserSession {
  readonly id: string;
  readonly organisation_id: string;
  readonly project_id: string;
  readonly status: string;
  readonly published_service_id: string | null;
  readonly worker_id: string | null;
}

/**
 * Live browser sessions bound to a connector's routes.
 *
 * A disconnect makes those sessions degraded rather than terminated
 * (`docs/ARCHITECTURE.md` §14: retain review and session metadata), so this is
 * scoped to sessions that have not already ended.
 */
export async function findLiveSessionsForConnector(
  client: PoolClient,
  connectorId: string,
): Promise<BoundBrowserSession[]> {
  const result = await client.query<BoundBrowserSession>(
    `SELECT s.id, s.organisation_id, s.project_id, s.status, s.published_service_id, s.worker_id
       FROM browser_sessions s
       JOIN published_services p ON p.id = s.published_service_id
      WHERE p.connector_id = $1
        AND s.ended_at IS NULL
        AND s.status NOT IN ('TERMINATED', 'FAILED', 'TERMINATING')
      ORDER BY s.id`,
    [connectorId],
  );
  return result.rows;
}

/** Reads live browser sessions by identifier, for reconciliation. */
export async function findLiveSessionsByIds(
  client: PoolClient,
  ids: readonly string[],
): Promise<BoundBrowserSession[]> {
  if (ids.length === 0) return [];
  const result = await client.query<BoundBrowserSession>(
    `SELECT id, organisation_id, project_id, status, published_service_id, worker_id
       FROM browser_sessions
      WHERE id = ANY($1::text[])
        AND ended_at IS NULL
        AND status NOT IN ('TERMINATED', 'FAILED', 'TERMINATING')
      ORDER BY id`,
    [[...ids]],
  );
  return result.rows;
}

/** Moves a browser session to a new status, returning the previous one. */
export async function setSessionStatus(
  client: PoolClient,
  sessionId: string,
  status: string,
  from: readonly string[],
): Promise<string | null> {
  const result = await client.query<{ previous_status: string }>(
    `UPDATE browser_sessions AS s
        SET status = $2
       FROM (SELECT id, status FROM browser_sessions WHERE id = $1 FOR UPDATE) AS current
      WHERE s.id = current.id AND current.status = ANY($3::text[])
      RETURNING current.status AS previous_status`,
    [sessionId, status, [...from]],
  );
  return result.rows[0]?.previous_status ?? null;
}

/** Counts routes a connector currently carries, for the concurrent limit. */
/**
 * How many routes a connector is already carrying, inside one organisation.
 *
 * The organisation term is not decoration. This count is the per-connector
 * limit of `docs/CONNECTOR_PROTOCOL.md` §11, and without it a caller in one
 * organisation could fill another organisation's connector to its limit by
 * naming that connector's identifier: the rows would be invisible to the victim
 * (the listing is project scoped) and would refuse its own publications. A
 * connector belongs to exactly one organisation, so adding the term costs
 * nothing and removes the shared counter.
 */
export async function countReadyForConnector(
  client: PoolClient,
  connectorId: string,
  organisationId: string,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM published_services
      WHERE connector_id = $1
        AND organisation_id = $2
        AND status IN ('requested', 'ready')`,
    [connectorId, organisationId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

/**
 * Resolves the connector a route may be published through.
 *
 * This exists because `connector_id` arrives in a request body. `resolveProject`
 * scopes the *project* to the caller and scoped nothing else, so a caller could
 * name any connector in the deployment — which is how one organisation could
 * exhaust another's route limit with rows the victim could not see.
 *
 * **The organisation is always required. The project is required only when the
 * connector has one.** `docs/CONNECTOR_PROTOCOL.md` §4.1 lets an enrolment
 * token be organisation scoped, and a connector enrolled that way serves any
 * project in its organisation — neither it nor its environment names one.
 * Requiring a project match outright would have refused every such connector,
 * which is a working deployment shape rather than an attack. A connector that
 * *is* bound to a project, directly or through its environment, may be used for
 * that project and no other.
 */
export async function findPublishableConnector(
  client: PoolClient,
  input: {
    readonly connectorId: string;
    readonly organisationId: string;
    readonly projectId: string;
  },
): Promise<{ readonly id: string; readonly status: string } | null> {
  const result = await client.query<{ id: string; status: string }>(
    `SELECT connectors.id, connectors.status
       FROM connectors
       JOIN environments ON environments.id = connectors.environment_id
      WHERE connectors.id = $1
        AND connectors.organisation_id = $2
        AND (
          $3 IN (connectors.project_id, environments.project_id)
          OR (connectors.project_id IS NULL AND environments.project_id IS NULL)
        )`,
    [input.connectorId, input.organisationId, input.projectId],
  );
  return result.rows[0] ?? null;
}

/** Resolves a workspace inside one organisation and project. */
export async function findWorkspaceInProject(
  client: PoolClient,
  input: {
    readonly workspaceId: string;
    readonly organisationId: string;
    readonly projectId: string;
  },
): Promise<{ readonly id: string } | null> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM workspaces
      WHERE id = $1 AND organisation_id = $2 AND project_id = $3`,
    [input.workspaceId, input.organisationId, input.projectId],
  );
  return result.rows[0] ?? null;
}

/**
 * Which of the named browser sessions belong to this organisation and project.
 *
 * The caller compares what it asked for against what comes back. Returning the
 * found set rather than a boolean is what lets the refusal name the first
 * identifier that was not reachable without a second query, and what makes
 * "every one of them" the condition rather than "at least one".
 */
export async function findBrowserSessionsInProject(
  client: PoolClient,
  input: {
    readonly browserSessionIds: readonly string[];
    readonly organisationId: string;
    readonly projectId: string;
  },
): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM browser_sessions
      WHERE id = ANY($1) AND organisation_id = $2 AND project_id = $3`,
    [[...input.browserSessionIds], input.organisationId, input.projectId],
  );
  return result.rows.map((row) => row.id);
}

export interface RouteCapabilityRecord {
  readonly id: string;
  readonly published_service_id: string;
  readonly browser_session_id: string;
  readonly key_id: string;
  readonly issued_at: Date;
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
}

/**
 * Records a minted capability.
 *
 * The token is not stored. A row holding the bearer credential would turn a
 * database read into a route grant, and nothing needs it: revocation works from
 * the identifier and verification works from the signature.
 */
export async function insertCapability(
  client: PoolClient,
  input: {
    readonly id: string;
    readonly organisationId: string;
    readonly projectId: string;
    readonly publishedServiceId: string;
    readonly browserSessionId: string;
    readonly keyId: string;
    readonly issuedAt: Date;
    readonly expiresAt: Date;
  },
): Promise<RouteCapabilityRecord> {
  const result = await client.query<RouteCapabilityRecord>(
    `INSERT INTO route_capabilities (
       id, organisation_id, project_id, published_service_id,
       browser_session_id, key_id, issued_at, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, published_service_id, browser_session_id, key_id,
               issued_at, expires_at, revoked_at`,
    [
      input.id,
      input.organisationId,
      input.projectId,
      input.publishedServiceId,
      input.browserSessionId,
      input.keyId,
      input.issuedAt.toISOString(),
      input.expiresAt.toISOString(),
    ],
  );
  return result.rows[0] as RouteCapabilityRecord;
}

/** Marks every live capability for a route as revoked. */
export async function revokeCapabilitiesForService(
  client: PoolClient,
  publishedServiceId: string,
): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `UPDATE route_capabilities
        SET revoked_at = now()
      WHERE published_service_id = $1 AND revoked_at IS NULL
      RETURNING id`,
    [publishedServiceId],
  );
  return result.rows.map((row) => row.id);
}
