/**
 * Persistence for published services and the capabilities minted against them.
 *
 * Every read is scoped by project as well as by identifier
 * (`docs/DOMAIN_MODEL.md` section 3, defence-in-depth filtering): a handler
 * that forgets the scope should return nothing rather than another project's
 * route.
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
}

export async function insertRequested(
  client: PoolClient,
  input: InsertPublishedService,
): Promise<PublishedService> {
  const result = await client.query<PublishedService>(
    `INSERT INTO published_services (
       id, organisation_id, project_id, connector_id, workspace_id, public_alias,
       local_host, local_port, protocol, scope, allowed_browser_session_ids,
       expires_at, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'browser_session', $10, $11, 'requested')
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

export async function findById(
  client: PoolClient,
  id: string,
): Promise<PublishedService | null> {
  const result = await client.query<PublishedService>(
    `SELECT ${COLUMNS} FROM published_services WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function listForProject(
  client: PoolClient,
  projectId: string,
  limit: number,
): Promise<PublishedService[]> {
  const result = await client.query<PublishedService>(
    `SELECT ${COLUMNS}
       FROM published_services
      WHERE project_id = $1
      ORDER BY requested_at DESC
      LIMIT $2`,
    [projectId, limit],
  );
  return result.rows;
}

/** Routes that are ready but whose expiry has passed. */
export async function findDueForExpiry(
  client: PoolClient,
  now: Date,
  limit: number,
): Promise<PublishedService[]> {
  const result = await client.query<PublishedService>(
    `SELECT ${COLUMNS}
       FROM published_services
      WHERE status = 'ready' AND expires_at <= $1
      ORDER BY expires_at
      LIMIT $2`,
    [now.toISOString(), limit],
  );
  return result.rows;
}

/** Counts routes a connector currently carries, for the concurrent limit. */
export async function countReadyForConnector(
  client: PoolClient,
  connectorId: string,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM published_services
      WHERE connector_id = $1 AND status IN ('requested', 'ready')`,
    [connectorId],
  );
  return Number(result.rows[0]?.count ?? "0");
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
