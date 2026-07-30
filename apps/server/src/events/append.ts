/**
 * Append-only domain and audit events (`docs/EVENTS.md`).
 *
 * `AGENTS.md` requires every meaningful state change to produce an audit
 * record, and `docs/EVENTS.md` §9 requires the state change and its event to
 * commit in one transaction — so `appendEvent` takes a client, never a pool,
 * and callers wrap both in `inTransaction`.
 *
 * `sequence` is monotonic within a stream. A stream is a project where one
 * exists and the organisation otherwise, which is what lets a connector event
 * that precedes any project association still be ordered and resumed.
 */

import { randomUUID } from "node:crypto";

import type { PoolClient } from "../db/pool.ts";

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
}

/** The current event envelope version (`docs/EVENTS.md` §2). */
export const EVENT_SCHEMA_VERSION = 1;

export async function appendEvent(client: PoolClient, input: AppendEventInput): Promise<AppendedEvent> {
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
  const id = `evt_${randomUUID().replaceAll("-", "")}`;

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
      JSON.stringify(pruneUndefined(input.payload ?? {})),
    ],
  );
  return { id, sequence, type: input.type };
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
