/**
 * Published-service events.
 *
 * `docs/EVENTS.md` section 7 names them and section 9 requires the state change
 * and its event to commit in one transaction, so every writer here takes a
 * client rather than the pool: the caller owns the transaction.
 *
 * Payload rules are section 8: stable identifiers, previous and new state,
 * reason codes for denial, and no raw secrets or sensitive headers. A
 * capability value never appears — the identifier does, which is what
 * revocation and audit actually need.
 */

import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "../../db/pool.ts";

/** The published-service events of `docs/EVENTS.md` section 7. */
export const PUBLISHED_SERVICE_EVENTS = [
  "published_service.requested",
  "published_service.ready",
  "published_service.failed",
  "published_service.expired",
  "published_service.revoked",
] as const;

export type PublishedServiceEvent = (typeof PUBLISHED_SERVICE_EVENTS)[number];

/** Actor types of `docs/EVENTS.md` section 5. */
export type ActorType =
  | "human_user"
  | "agent_session"
  | "connector"
  | "browser_worker"
  | "system"
  | "integration";

export interface EventActor {
  readonly type: ActorType;
  readonly id?: string;
  readonly display?: string;
}

export interface EventCorrelation {
  readonly [key: string]: string | undefined;
  readonly request_id?: string;
  readonly causation_event_id?: string;
  readonly browser_session_id?: string;
  readonly connector_id?: string;
  readonly published_service_id?: string;
}

export interface RecordEventInput {
  readonly type: PublishedServiceEvent;
  readonly organisationId: string;
  readonly projectId: string;
  readonly actor: EventActor;
  readonly correlation: EventCorrelation;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt?: Date;
}

export interface RecordedEvent {
  readonly id: string;
  readonly sequence: number;
}

/** Generates an opaque event identifier (`docs/DOMAIN_MODEL.md` section 3). */
export function newEventId(): string {
  return `evt_${randomUUID().replaceAll("-", "")}`;
}

/**
 * Appends one event, allocating the next sequence for its project stream.
 *
 * The sequence comes from a row this statement locks and increments, not from
 * `max(sequence) + 1`: two commands committing at once must not be able to
 * choose the same number, and `docs/EVENTS.md` section 3 makes the sequence a
 * consumer's resume point.
 */
export async function recordEvent(
  client: DatabaseClient,
  input: RecordEventInput,
): Promise<RecordedEvent> {
  const sequenceResult = await client.query<{ next_sequence: string }>(
    `INSERT INTO event_sequences (project_id, next_sequence)
     VALUES ($1, 2)
     ON CONFLICT (project_id)
     DO UPDATE SET next_sequence = event_sequences.next_sequence + 1
     RETURNING event_sequences.next_sequence - 1 AS next_sequence`,
    [input.projectId],
  );
  const sequence = Number(sequenceResult.rows[0]?.next_sequence ?? 1);
  const id = newEventId();
  await client.query(
    `INSERT INTO events (
       id, schema_version, sequence, type, occurred_at, organisation_id,
       project_id, actor_type, actor_id, actor_display, correlation, payload
     ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      sequence,
      input.type,
      (input.occurredAt ?? new Date()).toISOString(),
      input.organisationId,
      input.projectId,
      input.actor.type,
      input.actor.id ?? null,
      input.actor.display ?? null,
      JSON.stringify(pruneUndefined(input.correlation)),
      JSON.stringify(input.payload),
    ],
  );
  return { id, sequence };
}

function pruneUndefined(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const pruned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) pruned[key] = entry;
  }
  return pruned;
}
