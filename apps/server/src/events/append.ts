/**
 * Append-only domain and audit events (`docs/EVENTS.md`).
 *
 * `AGENTS.md` requires every meaningful state change to produce an audit
 * record, and `docs/EVENTS.md` §9 requires the state change and its event to
 * commit in one transaction — so `appendEvent` takes a client, never a pool,
 * and callers wrap both in `inTransaction`. {@link recordStateChange} is the
 * shorter way to say the same thing, and is what new code should use: it makes
 * the event a parameter of the write rather than a second call a handler could
 * forget.
 *
 * `sequence` is monotonic within a stream. A stream is a project where one
 * exists and the organisation otherwise, which is what lets a connector event
 * that precedes any project association still be ordered and resumed.
 *
 * The same transaction enqueues an outbox row. Delivery cannot join the
 * transaction — a socket write inside it would either block the commit or
 * deliver an event that then rolled back — so what commits is the *obligation*
 * to deliver, and `events/outbox.ts` discharges it afterwards
 * (`docs/EVENTS.md` §9).
 */

import { newEntityId } from "@reviewplane/protocol/platform";

import { inTransaction, type Pool, type PoolClient } from "../db/pool.ts";

/** `docs/EVENTS.md` §5. Actor identity is never inferred from display text. */
export type ActorType = "human_user" | "agent_session" | "connector" | "browser_worker" | "system" | "integration";

export interface EventActor {
  readonly type: ActorType;
  readonly id?: string;
  readonly display?: string;
}

/**
 * Correlation identifiers (`docs/EVENTS.md` §2, `docs/ARCHITECTURE.md` §15).
 *
 * The named members are the ones the documents enumerate. The index signature
 * admits a further identifier without a schema change here, but every value is
 * an opaque identifier: correlation never carries a header, a body or a secret
 * (`docs/EVENTS.md` §8).
 */
export interface EventCorrelation {
  readonly [key: string]: string | undefined;
  readonly request_id?: string;
  readonly causation_event_id?: string;
  readonly connector_id?: string;
  readonly environment_id?: string;
  readonly workspace_id?: string;
  readonly published_service_id?: string;
  readonly browser_session_id?: string;
  readonly agent_session_id?: string;
  readonly worker_id?: string;
  readonly artefact_id?: string;
  readonly review_id?: string;
  readonly finding_id?: string;
  readonly annotation_id?: string;
  readonly job_id?: string;
}

export interface AppendEventInput {
  readonly type: string;
  readonly organisationId: string;
  readonly projectId?: string | null;
  readonly actor: EventActor;
  readonly correlation?: EventCorrelation;
  readonly payload?: Record<string, unknown>;
  readonly occurredAt?: Date;
}

export interface AppendedEvent {
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  /** The stream the sequence belongs to: a project, or an organisation. */
  readonly streamKey: string;
}

/** The current event envelope version (`docs/EVENTS.md` §2). */
export const EVENT_SCHEMA_VERSION = 1;

export class EventPayloadError extends Error {}

/**
 * Payload member names that may never appear in an event.
 *
 * `docs/EVENTS.md` §8 and `docs/SECURITY.md` §18 forbid raw secrets, cookies
 * and authorisation headers in a payload. The rule is enforced on the way in
 * rather than left to review, because an event is append-only: a credential
 * written into the audit trail cannot be taken out of it without the
 * cryptographic-erasure machinery of §4, and by then it has been in a backup.
 *
 * The check is on names, which is a heuristic — a field called `note` can still
 * be made to carry a token by a determined caller. It catches the way it
 * actually happens, which is a whole request object or header map being handed
 * to an event as context.
 */
const FORBIDDEN_PAYLOAD_KEYS =
  /^(authorization|authorisation|cookie|set[_-]?cookie|proxy[_-]?authorization|.*(?<!id_)token|.*secret.*|.*password.*|passphrase|private[_-]?key|credential|credentials|capability|bearer|api[_-]?key|session[_-]?key|signing[_-]?key)$/iu;

/**
 * Names that match the pattern above but are known not to carry a value.
 *
 * A count of tokens, or the identifier of a credential record, is exactly the
 * kind of thing an audit event should carry: `agent_credential.issued` records
 * which credential was issued without recording the credential
 * (`docs/EVENTS.md` §7).
 */
const PERMITTED_PAYLOAD_KEYS = new Set([
  "credential_id",
  "capability_id",
  "token_id",
  "secret_reference_id",
  "api_key_id",
  "signing_key_id",
  "key_id",
]);

/**
 * Refuses a payload carrying a credential-shaped member, at any depth.
 *
 * Depth matters: the mistake is nearly always a nested object — a request, a
 * header map, a connector registration — rather than a top-level field somebody
 * typed out.
 */
export function assertPayloadCarriesNoSecret(
  value: unknown,
  path = "payload",
  depth = 0,
): void {
  if (depth > 12 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertPayloadCarriesNoSecret(item, `${path}[${String(index)}]`, depth + 1);
    });
    return;
  }
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (!PERMITTED_PAYLOAD_KEYS.has(key) && FORBIDDEN_PAYLOAD_KEYS.test(key)) {
      throw new EventPayloadError(
        `${path}.${key} is a credential-shaped member; docs/EVENTS.md section 8 forbids raw secrets, cookies and authorisation headers in an event payload. Record an identifier instead of a value.`,
      );
    }
    assertPayloadCarriesNoSecret(member, `${path}.${key}`, depth + 1);
  }
}

export async function appendEvent(client: PoolClient, input: AppendEventInput): Promise<AppendedEvent> {
  const payload = input.payload ?? {};
  assertPayloadCarriesNoSecret(payload);
  assertPayloadCarriesNoSecret(input.correlation ?? {}, "correlation");

  const streamKey = input.projectId ?? input.organisationId;
  const sequenceResult = await client.query<{ last_sequence: string }>(
    `insert into event_streams (stream_key, last_sequence)
       values ($1, 1)
     on conflict (stream_key)
       do update set last_sequence = event_streams.last_sequence + 1
     returning last_sequence`,
    [streamKey],
  );
  const row = sequenceResult.rows[0];
  if (row === undefined) throw new Error("events: the event stream produced no sequence");
  const sequence = Number(row.last_sequence);
  const id = newEntityId("event");

  await client.query(
    `insert into events (
       id, schema_version, stream_key, sequence, type, occurred_at,
       organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      id,
      EVENT_SCHEMA_VERSION,
      streamKey,
      sequence,
      input.type,
      input.occurredAt ?? new Date(),
      input.organisationId,
      input.projectId ?? null,
      input.actor.type,
      input.actor.id ?? null,
      input.actor.display ?? null,
      JSON.stringify(pruneUndefined(input.correlation ?? {})),
      JSON.stringify(pruneUndefined(payload)),
    ],
  );

  // The obligation to fan out, committed with the event it describes.
  await client.query(
    `insert into event_outbox (event_id, stream_key, sequence) values ($1, $2, $3)
     on conflict (event_id) do nothing`,
    [id, streamKey, sequence],
  );

  return { id, sequence, type: input.type, streamKey };
}

/** Something that wants to know an event committed, after it has. */
export interface EventPublisher {
  publish(event: AppendedEvent): void;
}

/**
 * Writes state and its event in one transaction, then publishes after commit.
 *
 * It exists so that "a state change and its event commit together" is a
 * property of the call rather than of a handler remembering two statements: the
 * event is an argument, and there is no way to run `work` without one.
 *
 * When the database is unavailable the transaction never opens, so the state
 * change does not happen and nothing is published — which is the
 * `docs/ARCHITECTURE.md` §14 requirement that a state-changing action be
 * rejected rather than proceeding unaudited.
 */
export async function recordStateChange<T>(
  pool: Pool,
  event: AppendEventInput | ((result: T) => AppendEventInput),
  work: (client: PoolClient) => Promise<T>,
  publisher?: EventPublisher,
): Promise<{ readonly result: T; readonly event: AppendedEvent }> {
  const committed = await inTransaction(pool, async (client) => {
    const result = await work(client);
    const input = typeof event === "function" ? event(result) : event;
    const appended = await appendEvent(client, input);
    return { result, event: appended };
  });
  publisher?.publish(committed.event);
  return committed;
}

/**
 * Drops absent members so that an optional correlation identifier is missing
 * from the stored document rather than present and null. A consumer testing for
 * the key then gets the same answer whichever writer produced the event.
 */
function pruneUndefined(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const pruned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) pruned[key] = entry;
  }
  return pruned;
}
