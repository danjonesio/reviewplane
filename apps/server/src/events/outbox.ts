/**
 * Post-commit fan-out (`docs/EVENTS.md` section 9, `docs/ARCHITECTURE.md`
 * section 10).
 *
 * `appendEvent` writes an `event_outbox` row in the same transaction as the
 * event. This dispatcher claims those rows after commit, delivers them to the
 * in-process bus and marks them dispatched. The claim is
 * `FOR UPDATE SKIP LOCKED`, so several control-plane processes can run one
 * dispatcher each without delivering an event twice and without a broker
 * (`docs/ARCHITECTURE.md` section 4.8).
 *
 * The steps of section 10 map onto this file exactly:
 *
 *   1. a command commits state and event in PostgreSQL — `recordStateChange`;
 *   2. a notifier publishes committed event identifiers — {@link publish};
 *   3. the realtime process fetches and broadcasts authorised payloads — here;
 *   4. clients resume using last seen sequence — `events/routes.ts`.
 *
 * A poll runs regardless of step 2, because step 2 is an optimisation: it makes
 * delivery immediate for an event this process committed, and its absence
 * delays delivery rather than losing it. That is the property the outbox exists
 * for — a process that dies between commit and delivery leaves the row behind,
 * and the next dispatcher picks it up.
 */

import type { Pool } from "../db/pool.ts";
import { inTransaction } from "../db/pool.ts";
import type { AppendedEvent } from "./append.ts";
import { EventStreamReader, type EventBus } from "./stream.ts";

/** How many outbox rows one claim takes. */
const BATCH_SIZE = 200;

/** How often the dispatcher polls when nothing has nudged it. */
const DEFAULT_POLL_INTERVAL_MS = 250;

/** How long a delivered row is kept before being pruned. */
const RETENTION_MS = 60_000;

export interface OutboxDispatcherOptions {
  readonly pool: Pool;
  readonly bus: EventBus;
  readonly pollIntervalMs?: number;
  readonly logger?: { warn(fields: Record<string, unknown>, message: string): void };
}

export class OutboxDispatcher {
  readonly #pool: Pool;
  readonly #bus: EventBus;
  readonly #reader: EventStreamReader;
  readonly #pollIntervalMs: number;
  readonly #logger: OutboxDispatcherOptions["logger"];
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #draining: Promise<void> | null = null;
  /** Set while a drain is in flight and another nudge arrived meanwhile. */
  #again = false;

  constructor(options: OutboxDispatcherOptions) {
    this.#pool = options.pool;
    this.#bus = options.bus;
    this.#reader = new EventStreamReader(options.pool);
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#logger = options.logger;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#timer = setInterval(() => {
      void this.drain().catch(() => undefined);
    }, this.#pollIntervalMs);
    // The dispatcher must not hold the process open on shutdown.
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await this.#draining?.catch(() => undefined);
  }

  /**
   * Nudges the dispatcher after a commit.
   *
   * It never delivers here: the event takes the same path whether this process
   * or another committed it, so there is exactly one place it can be delivered
   * twice from, and that place claims with `SKIP LOCKED`.
   */
  publish(_event: AppendedEvent): void {
    void this.drain().catch(() => undefined);
  }

  /**
   * Claims and delivers every pending row.
   *
   * Serialised: a second caller does not start a second claim but marks the
   * in-flight one to run again, so a burst of commits produces one extra pass
   * rather than one pass each.
   */
  async drain(): Promise<void> {
    if (this.#draining !== null) {
      this.#again = true;
      return this.#draining;
    }
    const run = (async () => {
      try {
        let delivered = 0;
        do {
          this.#again = false;
          delivered = await this.#claimAndDeliver();
        } while (delivered === BATCH_SIZE || this.#again);
      } finally {
        this.#draining = null;
      }
    })();
    this.#draining = run;
    return run;
  }

  async #claimAndDeliver(): Promise<number> {
    const claimed = await inTransaction(this.#pool, async (client) => {
      const rows = await client.query<{ event_id: string }>(
        `select event_id from event_outbox
          where dispatched_at is null
          order by stream_key, sequence
          for update skip locked
          limit $1`,
        [BATCH_SIZE],
      );
      const ids = rows.rows.map((row) => row.event_id);
      if (ids.length === 0) return [];
      await client.query(
        `update event_outbox
            set dispatched_at = now(), attempts = attempts + 1
          where event_id = any($1)`,
        [ids],
      );
      return ids;
    });

    if (claimed.length === 0) return 0;

    // Delivery happens after the claim commits. A subscriber that receives an
    // event this process is still deciding to keep would be reading uncommitted
    // state, which is the failure the outbox exists to avoid.
    const events = await this.#reader.byIds(claimed);
    for (const event of events) this.#bus.deliver(event);
    return claimed.length;
  }

  /**
   * Removes delivered rows older than the retention window.
   *
   * The audit history is `events`; a permanent second copy of it here would be a
   * second thing to retain, redact and erase under `docs/EVENTS.md` section 12.
   */
  async prune(): Promise<number> {
    const result = await this.#pool.query(
      `delete from event_outbox
        where dispatched_at is not null and dispatched_at < now() - ($1 || ' milliseconds')::interval`,
      [String(RETENTION_MS)],
    );
    const removed = result.rowCount ?? 0;
    if (removed > 0) this.#logger?.warn({ removed }, "pruned dispatched outbox rows");
    return removed;
  }
}
