/**
 * Domain and audit events (`docs/EVENTS.md`).
 *
 * Section 9 requires the state change and its event to commit together, so
 * `appendEvent` takes the client of an open transaction rather than the pool.
 * Section 3 makes `sequence` monotonic within a project stream; the advisory
 * lock serialises allocation per project so two concurrent commands cannot
 * take the same number.
 *
 * Section 8 forbids raw secrets and sensitive headers in payloads. Callers
 * pass domain identifiers and state transitions; nothing here reads a request
 * body or a header.
 */

import type { PoolClient } from "pg";

import { newId } from "./ids.ts";

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
  readonly request_id?: string;
  readonly causation_event_id?: string;
  readonly browser_session_id?: string;
  readonly agent_session_id?: string;
  readonly review_id?: string;
  readonly finding_id?: string;
  readonly artefact_id?: string;
  readonly worker_id?: string;
}

export interface EventInput {
  readonly type: string;
  readonly organisationId: string;
  readonly projectId: string;
  readonly actor: EventActor;
  readonly correlation?: EventCorrelation;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly occurredAt?: Date;
}

export interface RecordedEvent {
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
}

export async function appendEvent(
  client: PoolClient,
  event: EventInput,
): Promise<RecordedEvent> {
  // Serialises sequence allocation for this project only; unrelated projects
  // are unaffected.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [event.projectId]);
  const next = await client.query<{ sequence: string }>(
    "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM events WHERE project_id = $1",
    [event.projectId],
  );
  const sequence = Number(next.rows[0]?.sequence ?? 1);
  const id = newId("evt_");
  await client.query(
    `INSERT INTO events (
        id, schema_version, project_id, organisation_id, sequence, type,
        occurred_at, actor_type, actor_id, actor_display, correlation, payload
     ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      event.projectId,
      event.organisationId,
      sequence,
      event.type,
      (event.occurredAt ?? new Date()).toISOString(),
      event.actor.type,
      event.actor.id ?? null,
      event.actor.display ?? null,
      JSON.stringify(event.correlation ?? {}),
      JSON.stringify(event.payload ?? {}),
    ],
  );
  return { id, sequence, type: event.type };
}
