/**
 * The project event stream: replay from a sequence, then live delivery
 * (`docs/EVENTS.md` sections 3 and 10, `docs/API.md` section 18.1).
 *
 * Two halves, and the join between them is the interesting part.
 *
 * **Replay** reads committed rows from `events`, which is the durable record.
 * **Live delivery** is an in-process bus fed by the outbox dispatcher after
 * commit. A subscriber that switched from one to the other naively would lose
 * every event committed between the last replayed row and the moment it
 * attached, so it attaches *first* and buffers, then replays, then drains the
 * buffer discarding anything already replayed. Nothing is lost and nothing is
 * delivered twice, which is what `docs/EVENTS.md` section 3's "resumes from last
 * acknowledged project sequence" has to mean in practice.
 *
 * The bus is per process. Fan-out between processes is the outbox plus
 * PostgreSQL notification of `docs/ARCHITECTURE.md` section 10; a broker is
 * deferred until measured load requires one.
 */

import type { Pool } from "../db/pool.ts";
import type { AppendedEvent } from "./append.ts";

/** One stored event, in the envelope shape of `docs/EVENTS.md` section 2. */
export interface StoredEvent {
  readonly id: string;
  readonly schema_version: number;
  readonly sequence: number;
  readonly type: string;
  readonly occurred_at: string;
  readonly recorded_at: string;
  readonly organisation_id: string;
  readonly project_id?: string;
  readonly actor: { type: string; id?: string; display?: string };
  readonly correlation: Record<string, string>;
  readonly payload: Record<string, unknown>;
}

interface EventRow {
  readonly id: string;
  readonly schema_version: number;
  readonly sequence: string;
  readonly type: string;
  readonly occurred_at: Date;
  readonly recorded_at: Date;
  readonly organisation_id: string;
  readonly project_id: string | null;
  readonly actor_type: string;
  readonly actor_id: string | null;
  readonly actor_display: string | null;
  readonly correlation: Record<string, string>;
  readonly payload: Record<string, unknown>;
}

function toEnvelope(row: EventRow): StoredEvent {
  return {
    id: row.id,
    schema_version: row.schema_version,
    sequence: Number(row.sequence),
    type: row.type,
    occurred_at: row.occurred_at.toISOString(),
    recorded_at: row.recorded_at.toISOString(),
    organisation_id: row.organisation_id,
    ...(row.project_id === null ? {} : { project_id: row.project_id }),
    actor: {
      type: row.actor_type,
      ...(row.actor_id === null ? {} : { id: row.actor_id }),
      ...(row.actor_display === null ? {} : { display: row.actor_display }),
    },
    correlation: row.correlation,
    payload: row.payload,
  };
}

const EVENT_COLUMNS = `id, schema_version, sequence, type, occurred_at, recorded_at,
  organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload`;

/** Where a stream currently is, and how far back it can be replayed. */
export interface StreamPosition {
  readonly currentSequence: number;
  readonly earliestAvailableSequence: number;
}

export class EventStreamReader {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * The stream's current position and its replay window.
   *
   * `earliestAvailableSequence` is read from the stored rows rather than from a
   * configured retention number, so a deployment that has deleted history under
   * `docs/EVENTS.md` section 12 reports the truth rather than a policy.
   */
  async position(streamKey: string): Promise<StreamPosition> {
    const result = await this.#pool.query<{ current: string | null; earliest: string | null }>(
      `select
         (select last_sequence from event_streams where stream_key = $1) as current,
         (select min(sequence) from events where stream_key = $1) as earliest`,
      [streamKey],
    );
    const row = result.rows[0];
    const current = row?.current == null ? 0 : Number(row.current);
    const earliest = row?.earliest == null ? 0 : Number(row.earliest);
    return { currentSequence: current, earliestAvailableSequence: earliest };
  }

  /** Committed events after `afterSequence`, in order, bounded by `limit`. */
  async replay(streamKey: string, afterSequence: number, limit: number): Promise<StoredEvent[]> {
    const result = await this.#pool.query<EventRow>(
      `select ${EVENT_COLUMNS} from events
        where stream_key = $1 and sequence > $2
        order by sequence asc
        limit $3`,
      [streamKey, afterSequence, limit],
    );
    return result.rows.map(toEnvelope);
  }

  /** One event by identifier, for the outbox dispatcher. */
  async byIds(ids: readonly string[]): Promise<StoredEvent[]> {
    if (ids.length === 0) return [];
    const result = await this.#pool.query<EventRow>(
      `select ${EVENT_COLUMNS} from events where id = any($1) order by stream_key, sequence asc`,
      [ids],
    );
    return result.rows.map(toEnvelope);
  }
}

export type EventListener = (event: StoredEvent) => void;

/**
 * In-process fan-out of committed events, keyed by stream.
 *
 * A listener is registered against one stream key, so a subscriber can never be
 * handed another project's event by a bug in the delivery path rather than in
 * the authorisation path — the two failure modes are kept apart on purpose.
 */
export class EventBus {
  readonly #listeners = new Map<string, Set<EventListener>>();

  subscribe(streamKey: string, listener: EventListener): () => void {
    let listeners = this.#listeners.get(streamKey);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(streamKey, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.#listeners.get(streamKey);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) this.#listeners.delete(streamKey);
    };
  }

  /** Delivers to every listener on the event's stream. */
  deliver(event: StoredEvent): void {
    const streamKey = event.project_id ?? event.organisation_id;
    for (const listener of this.#listeners.get(streamKey) ?? []) {
      // One misbehaving subscriber must not stop the rest of the fan-out.
      try {
        listener(event);
      } catch {
        // The socket layer logs its own failures; there is nothing safe to say
        // about another subscriber's exception here.
      }
    }
  }

  /** Whether anything in this process is listening to a stream. */
  hasListeners(streamKey: string): boolean {
    return (this.#listeners.get(streamKey)?.size ?? 0) > 0;
  }

  /** Listener counts, for readiness and tests. */
  get size(): number {
    let total = 0;
    for (const listeners of this.#listeners.values()) total += listeners.size;
    return total;
  }
}

/**
 * The publisher `recordStateChange` calls after commit.
 *
 * It nudges the outbox dispatcher rather than delivering directly, so that a
 * single event takes exactly one path to a subscriber whether it was committed
 * by this process or by another one. Two paths would mean two chances to
 * deliver it twice.
 */
export interface CommitNotifier {
  publish(event: AppendedEvent): void;
}
