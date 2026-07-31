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

const CONNECTOR_COLUMN_NAMES = [
  "id",
  "organisation_id",
  "environment_id",
  "project_id",
  "certificate_fingerprint",
  "certificate_not_after",
  "version",
  "capabilities",
  "status",
  "connected_at",
  "last_heartbeat_at",
  "revoked_at",
] as const;

const CONNECTOR_COLUMNS = CONNECTOR_COLUMN_NAMES.join(", ");

/** The same columns qualified, for a statement that joins another relation. */
const QUALIFIED_CONNECTOR_COLUMNS = CONNECTOR_COLUMN_NAMES.map((column) => `connectors.${column}`).join(
  ", ",
);

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

/**
 * Ensures the Stage 0 organisation exists.
 *
 * The slug is derived from the identifier rather than from the display name: it
 * is unique across the deployment, and a display name an operator can change
 * must not be able to collide with another organisation's slug.
 */
export async function ensureOrganisation(pool: Pool, id: string, name: string): Promise<void> {
  await pool.query(
    "insert into organisations (id, name, slug) values ($1, $2, $3) on conflict (id) do nothing",
    [id, name, id.toLowerCase().replaceAll(/[^a-z0-9-]/gu, "-")],
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

/**
 * Resolves one connector inside the caller's organisation and project scope.
 *
 * The identifier, the organisation and the session's project scope are all in
 * the predicate rather than in an `if` after the read. A row that satisfies one
 * and not the others is not returned at all, so a foreign identifier and an
 * unknown one produce the same empty result and the caller cannot answer them
 * differently even by accident (`docs/API.md` §5; RVP-66 and RVP-67 record what
 * happens when this is a check instead of a predicate).
 */
export async function findConnectorInScope(
  pool: Pool,
  input: {
    readonly connectorId: string;
    readonly organisationId: string;
    readonly projectIds: readonly string[] | null;
  },
): Promise<ConnectorRecord | null> {
  const scope = input.projectIds === null ? null : [...input.projectIds];
  const result = await pool.query<ConnectorRow>(
    `select ${CONNECTOR_COLUMNS}
       from connectors
      where id = $1
        and organisation_id = $2
        and ($3::text[] is null or project_id = any($3))`,
    [input.connectorId, input.organisationId, scope],
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

export async function listConnectors(
  pool: Pool,
  organisationId: string,
  projectIds: readonly string[] | null = null,
): Promise<ConnectorRecord[]> {
  const scope = projectIds === null ? null : [...projectIds];
  const result = await pool.query<ConnectorRow>(
    `select ${CONNECTOR_COLUMNS}
       from connectors
      where organisation_id = $1
        and ($2::text[] is null or project_id = any($2))
      order by created_at desc`,
    [organisationId, scope],
  );
  return result.rows.map(toConnector);
}

/** Connectors belonging to one environment, newest identity first. */
export async function listConnectorsForEnvironments(
  pool: Pool,
  environmentIds: readonly string[],
): Promise<ConnectorRecord[]> {
  if (environmentIds.length === 0) return [];
  const result = await pool.query<ConnectorRow>(
    `select ${CONNECTOR_COLUMNS} from connectors where environment_id = any($1::text[])
      order by created_at desc`,
    [[...environmentIds]],
  );
  return result.rows.map(toConnector);
}

/** `docs/DOMAIN_MODEL.md` §7. */
export interface EnvironmentRecord {
  readonly id: string;
  readonly organisationId: string;
  readonly projectId: string | null;
  readonly name: string;
  readonly platform: string;
  readonly architecture: string;
  readonly labels: readonly string[];
  readonly trustLevel: string;
  readonly status: string;
  readonly lastSeenAt: Date | null;
  readonly createdAt: Date;
}

interface EnvironmentRow {
  id: string;
  organisation_id: string;
  project_id: string | null;
  name: string;
  platform: string;
  architecture: string;
  labels: string[];
  trust_level: string;
  status: string;
  last_seen_at: Date | null;
  created_at: Date;
}

const ENVIRONMENT_COLUMNS = `id, organisation_id, project_id, name, platform, architecture, labels,
  trust_level, status, last_seen_at, created_at`;

function toEnvironment(row: EnvironmentRow): EnvironmentRecord {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    projectId: row.project_id,
    name: row.name,
    platform: row.platform,
    architecture: row.architecture,
    labels: row.labels,
    trustLevel: row.trust_level,
    status: row.status,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

/**
 * The environments a project may use.
 *
 * An environment enrolled with an organisation-scoped token carries no
 * `project_id` and is available to every project in the organisation, which is
 * what `docs/DOMAIN_MODEL.md` §7 means by "or authorised project set". The
 * organisation is in the predicate either way.
 */
export async function listEnvironmentsForProject(
  pool: Pool,
  input: { readonly organisationId: string; readonly projectId: string },
): Promise<EnvironmentRecord[]> {
  const result = await pool.query<EnvironmentRow>(
    `select ${ENVIRONMENT_COLUMNS}
       from environments
      where organisation_id = $1
        and (project_id is null or project_id = $2)
      order by created_at desc
      limit 200`,
    [input.organisationId, input.projectId],
  );
  return result.rows.map(toEnvironment);
}

/**
 * Resolves one environment inside the caller's organisation and project scope,
 * with every clause in the predicate for the reason
 * {@link findConnectorInScope} gives.
 */
export async function findEnvironmentInScope(
  pool: Pool,
  input: {
    readonly environmentId: string;
    readonly organisationId: string;
    readonly projectIds: readonly string[] | null;
  },
): Promise<EnvironmentRecord | null> {
  const scope = input.projectIds === null ? null : [...input.projectIds];
  const result = await pool.query<EnvironmentRow>(
    `select ${ENVIRONMENT_COLUMNS}
       from environments
      where id = $1
        and organisation_id = $2
        and ($3::text[] is null or project_id is null or project_id = any($3))`,
    [input.environmentId, input.organisationId, scope],
  );
  const row = result.rows[0];
  return row === undefined ? null : toEnvironment(row);
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
    readonly actor?: { readonly type: "connector" | "human_user" | "system"; readonly id?: string };
    readonly payload?: Record<string, unknown>;
  },
): Promise<AppendedEvent | null> {
  return inTransaction(pool, async (client) => {
    // The previous status comes out of a locked read in the same statement,
    // rather than from the list of statuses the transition was willing to
    // accept. Recording the willing set was wrong in a way an auditor could
    // not see through: `previous_status` read `PENDING_ENROLMENT|DEGRADED|
    // DISCONNECTED`, which names three states the connector was not in and one
    // it was, and no consumer could tell which. The event payload schema in
    // `packages/protocol/schemas/platform/v1.schema.json` now says
    // `previous_status` is a single status, and this is what makes that true.
    const updated = await client.query<ConnectorRow & { previous_status: ConnectorStatus }>(
      `with previous as (
         select id, status from connectors where id = $1 for update
       )
       update connectors
          set status       = $3,
              connected_at = case when $4 then now() else connected_at end,
              revoked_at   = case when $5 then now() else revoked_at end
         from previous
        where connectors.id = previous.id and previous.status = any($2::text[])
        returning ${QUALIFIED_CONNECTOR_COLUMNS}, previous.status as previous_status`,
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
    const actor = input.actor ?? { type: "connector" as const, id: connector.id };
    return appendEvent(client, {
      type: input.eventType,
      organisationId: connector.organisationId,
      projectId: connector.projectId,
      actor: actor.id === undefined ? { type: actor.type } : { type: actor.type, id: actor.id },
      correlation: { connector_id: connector.id, environment_id: connector.environmentId },
      payload: {
        previous_status: row.previous_status,
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
  // Delegated rather than reimplemented. This function had the same audit
  // defect `transitionConnector` was repaired for, and worse: it read
  // `previous_status` off the row its own `UPDATE ... RETURNING` produced, which
  // is the row *after* the update, so every event it wrote said
  // `{"previous_status": "REVOKED", "new_status": "REVOKED"}` — a transition
  // from a state to itself, which never happened. Two implementations of one
  // transition is how the second one drifts, so there is now one.
  return transitionConnector(pool, {
    connectorId,
    from: ["PENDING_ENROLMENT", "ACTIVE", "DEGRADED", "DISCONNECTED"],
    to: "REVOKED",
    eventType: "connector.revoked",
    touchRevokedAt: true,
    actor,
    // `routes_revoked` and `sessions_disconnected` are what revocation reached
    // beyond the identity, and reaching them is `modules/connectors/revocation.ts`.
    // This entry point changes the record alone, so it reports zero rather than
    // omitting the counts and leaving a reader to guess whether the routes were
    // closed or merely unrecorded.
    payload: { routes_revoked: 0, sessions_disconnected: 0, channels_closed: 0 },
  });
}
