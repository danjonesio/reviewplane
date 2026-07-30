/**
 * Database access for environments, connectors and enrolment tokens.
 *
 * Every state change that matters is written together with its event inside one
 * transaction, per `docs/EVENTS.md` §9.
 */

import type { Pool, PoolClient } from "../../db/pool.ts";
import { inTransaction } from "../../db/pool.ts";
import { appendEvent, type AppendedEvent } from "../../events/append.ts";

/** `docs/DOMAIN_MODEL.md` §8 connector lifecycle. */
export type ConnectorStatus = "PENDING_ENROLMENT" | "ACTIVE" | "DEGRADED" | "DISCONNECTED" | "REVOKED";

export interface ConnectorRecord {
  readonly id: string;
  readonly organisationId: string;
  readonly environmentId: string;
  readonly projectId: string | null;
  readonly certificateFingerprint: string;
  readonly certificateNotAfter: Date;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly status: ConnectorStatus;
  readonly connectedAt: Date | null;
  readonly lastHeartbeatAt: Date | null;
  readonly revokedAt: Date | null;
}

interface ConnectorRow {
  id: string;
  organisation_id: string;
  environment_id: string;
  project_id: string | null;
  certificate_fingerprint: string;
  certificate_not_after: Date;
  version: string;
  capabilities: string[];
  status: ConnectorStatus;
  connected_at: Date | null;
  last_heartbeat_at: Date | null;
  revoked_at: Date | null;
}

const CONNECTOR_COLUMNS = `id, organisation_id, environment_id, project_id, certificate_fingerprint,
  certificate_not_after, version, capabilities, status, connected_at, last_heartbeat_at, revoked_at`;

function toConnector(row: ConnectorRow): ConnectorRecord {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    environmentId: row.environment_id,
    projectId: row.project_id,
    certificateFingerprint: row.certificate_fingerprint,
    certificateNotAfter: row.certificate_not_after,
    version: row.version,
    capabilities: row.capabilities,
    status: row.status,
    connectedAt: row.connected_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    revokedAt: row.revoked_at,
  };
}

/** Ensures the Stage 0 organisation exists. */
export async function ensureOrganisation(pool: Pool, id: string, name: string): Promise<void> {
  await pool.query(
    "insert into organisations (id, name) values ($1, $2) on conflict (id) do nothing",
    [id, name],
  );
}

export interface EnrolmentTokenRecord {
  readonly id: string;
  readonly organisationId: string;
  readonly projectId: string | null;
  readonly environmentLabels: readonly string[];
  readonly maxUses: number;
  readonly uses: number;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly revokedAt: Date | null;
}

interface TokenRow {
  id: string;
  organisation_id: string;
  project_id: string | null;
  environment_labels: string[];
  max_uses: number;
  uses: number;
  expires_at: Date;
  consumed_at: Date | null;
  revoked_at: Date | null;
}

function toToken(row: TokenRow): EnrolmentTokenRecord {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    projectId: row.project_id,
    environmentLabels: row.environment_labels,
    maxUses: row.max_uses,
    uses: row.uses,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    revokedAt: row.revoked_at,
  };
}

export interface CreateEnrolmentTokenInput {
  readonly id: string;
  readonly organisationId: string;
  readonly projectId: string | null;
  readonly tokenHash: string;
  readonly environmentLabels: readonly string[];
  readonly maxUses: number;
  readonly expiresAt: Date;
  readonly createdBy: string;
}

export async function createEnrolmentToken(
  pool: Pool,
  input: CreateEnrolmentTokenInput,
): Promise<EnrolmentTokenRecord> {
  const result = await pool.query<TokenRow>(
    `insert into connector_enrolment_tokens
       (id, organisation_id, project_id, token_hash, environment_labels, max_uses, expires_at, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id, organisation_id, project_id, environment_labels, max_uses, uses,
               expires_at, consumed_at, revoked_at`,
    [
      input.id,
      input.organisationId,
      input.projectId,
      input.tokenHash,
      input.environmentLabels,
      input.maxUses,
      input.expiresAt,
      input.createdBy,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("connectors: the enrolment token was not created");
  return toToken(row);
}

/**
 * Locks the token row for the duration of the enrolment transaction. Two
 * connectors racing to redeem the same one-time token therefore serialise, and
 * the second sees the consumed row.
 */
export async function lockEnrolmentTokenByHash(
  client: PoolClient,
  tokenHash: string,
): Promise<EnrolmentTokenRecord | null> {
  const result = await client.query<TokenRow>(
    `select id, organisation_id, project_id, environment_labels, max_uses, uses,
            expires_at, consumed_at, revoked_at
       from connector_enrolment_tokens
      where token_hash = $1
      for update`,
    [tokenHash],
  );
  const row = result.rows[0];
  return row === undefined ? null : toToken(row);
}

export async function consumeEnrolmentToken(client: PoolClient, tokenId: string): Promise<void> {
  await client.query(
    `update connector_enrolment_tokens
        set uses        = uses + 1,
            consumed_at = case when uses + 1 >= max_uses then now() else consumed_at end
      where id = $1`,
    [tokenId],
  );
}

export async function findEnrolmentTokenById(
  pool: Pool,
  tokenId: string,
): Promise<EnrolmentTokenRecord | null> {
  const result = await pool.query<TokenRow>(
    `select id, organisation_id, project_id, environment_labels, max_uses, uses,
            expires_at, consumed_at, revoked_at
       from connector_enrolment_tokens where id = $1`,
    [tokenId],
  );
  const row = result.rows[0];
  return row === undefined ? null : toToken(row);
}

export interface CreateEnvironmentInput {
  readonly id: string;
  readonly organisationId: string;
  readonly projectId: string | null;
  readonly name: string;
  readonly platform: string;
  readonly architecture: string;
  readonly labels: readonly string[];
}

export async function insertEnvironment(client: PoolClient, input: CreateEnvironmentInput): Promise<void> {
  await client.query(
    `insert into environments (id, organisation_id, project_id, name, platform, architecture, labels, last_seen_at)
       values ($1, $2, $3, $4, $5, $6, $7, now())`,
    [
      input.id,
      input.organisationId,
      input.projectId,
      input.name,
      input.platform,
      input.architecture,
      input.labels,
    ],
  );
}

export interface CreateConnectorInput {
  readonly id: string;
  readonly organisationId: string;
  readonly environmentId: string;
  readonly projectId: string | null;
  readonly enrolmentTokenId: string;
  readonly certificateFingerprint: string;
  readonly certificateSerial: string;
  readonly certificateNotAfter: Date;
  readonly publicKey: string;
  readonly version: string;
  readonly capabilities: readonly string[];
}

export async function insertConnector(client: PoolClient, input: CreateConnectorInput): Promise<void> {
  await client.query(
    `insert into connectors
       (id, organisation_id, environment_id, project_id, enrolment_token_id, certificate_fingerprint,
        certificate_serial, certificate_not_after, public_key, version, capabilities, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'PENDING_ENROLMENT')`,
    [
      input.id,
      input.organisationId,
      input.environmentId,
      input.projectId,
      input.enrolmentTokenId,
      input.certificateFingerprint,
      input.certificateSerial,
      input.certificateNotAfter,
      input.publicKey,
      input.version,
      input.capabilities,
    ],
  );
}

export async function findConnectorByFingerprint(
  pool: Pool,
  fingerprint: string,
): Promise<ConnectorRecord | null> {
  const result = await pool.query<ConnectorRow>(
    `select ${CONNECTOR_COLUMNS} from connectors where certificate_fingerprint = $1`,
    [fingerprint],
  );
  const row = result.rows[0];
  return row === undefined ? null : toConnector(row);
}

export async function findConnectorById(pool: Pool, id: string): Promise<ConnectorRecord | null> {
  const result = await pool.query<ConnectorRow>(`select ${CONNECTOR_COLUMNS} from connectors where id = $1`, [
    id,
  ]);
  const row = result.rows[0];
  return row === undefined ? null : toConnector(row);
}

export async function listConnectors(pool: Pool, organisationId: string): Promise<ConnectorRecord[]> {
  const result = await pool.query<ConnectorRow>(
    `select ${CONNECTOR_COLUMNS} from connectors where organisation_id = $1 order by created_at desc`,
    [organisationId],
  );
  return result.rows.map(toConnector);
}

/**
 * Moves a connector to a new lifecycle state and records the transition.
 *
 * The update is conditional on the current status so that two observers racing
 * to report the same transition produce one event, not two. It returns null
 * when the transition did not apply.
 */
export async function transitionConnector(
  pool: Pool,
  input: {
    readonly connectorId: string;
    readonly from: readonly ConnectorStatus[];
    readonly to: ConnectorStatus;
    readonly eventType: string;
    readonly touchConnectedAt?: boolean;
    readonly touchRevokedAt?: boolean;
    readonly payload?: Record<string, unknown>;
  },
): Promise<AppendedEvent | null> {
  return inTransaction(pool, async (client) => {
    const updated = await client.query<ConnectorRow>(
      `update connectors
          set status       = $3,
              connected_at = case when $4 then now() else connected_at end,
              revoked_at   = case when $5 then now() else revoked_at end
        where id = $1 and status = any($2::text[])
        returning ${CONNECTOR_COLUMNS}`,
      [
        input.connectorId,
        input.from,
        input.to,
        input.touchConnectedAt ?? false,
        input.touchRevokedAt ?? false,
      ],
    );
    const row = updated.rows[0];
    if (row === undefined) return null;
    const connector = toConnector(row);
    return appendEvent(client, {
      type: input.eventType,
      organisationId: connector.organisationId,
      projectId: connector.projectId,
      actor: { type: "connector", id: connector.id },
      correlation: { connector_id: connector.id, environment_id: connector.environmentId },
      payload: {
        previous_status: input.from.join("|"),
        new_status: input.to,
        ...(input.payload ?? {}),
      },
    });
  });
}

/** Records a heartbeat. The status transition is handled separately. */
export async function recordHeartbeat(pool: Pool, connectorId: string): Promise<void> {
  await pool.query(
    `update connectors set last_heartbeat_at = now() where id = $1 and status <> 'REVOKED'`,
    [connectorId],
  );
  await pool.query(
    `update environments
        set last_seen_at = now()
      where id = (select environment_id from connectors where id = $1)`,
    [connectorId],
  );
}

/**
 * Connectors whose last heartbeat is older than `olderThanSeconds` and whose
 * status is one of `statuses`. This is the input to the heartbeat state
 * machine of `docs/DOMAIN_MODEL.md` §8.
 */
export async function findStaleConnectors(
  pool: Pool,
  statuses: readonly ConnectorStatus[],
  olderThanSeconds: number,
): Promise<ConnectorRecord[]> {
  const result = await pool.query<ConnectorRow>(
    `select ${CONNECTOR_COLUMNS}
       from connectors
      where status = any($1::text[])
        and coalesce(last_heartbeat_at, connected_at, created_at) < now() - make_interval(secs => $2)`,
    [statuses, olderThanSeconds],
  );
  return result.rows.map(toConnector);
}

/**
 * Revokes a connector identity (`docs/CONNECTOR_PROTOCOL.md` §18). The
 * administrative endpoint that calls this is Stage 1; the fail-closed
 * behaviour it produces is Stage 0, so the operation exists now and is proved
 * by the security tests.
 */
export async function revokeConnector(
  pool: Pool,
  connectorId: string,
  actor: { readonly type: "human_user" | "system"; readonly id?: string },
): Promise<AppendedEvent | null> {
  return inTransaction(pool, async (client) => {
    const updated = await client.query<ConnectorRow>(
      `update connectors
          set status = 'REVOKED', revoked_at = now()
        where id = $1 and status <> 'REVOKED'
        returning ${CONNECTOR_COLUMNS}`,
      [connectorId],
    );
    const row = updated.rows[0];
    if (row === undefined) return null;
    const connector = toConnector(row);
    return appendEvent(client, {
      type: "connector.revoked",
      organisationId: connector.organisationId,
      projectId: connector.projectId,
      actor: actor.id === undefined ? { type: actor.type } : { type: actor.type, id: actor.id },
      correlation: { connector_id: connector.id, environment_id: connector.environmentId },
      payload: { previous_status: connector.status, new_status: "REVOKED" },
    });
  });
}
