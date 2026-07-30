/**
 * Durable background work on PostgreSQL row locking
 * (`docs/ARCHITECTURE.md` sections 4.8, 5.1 and 14).
 *
 * "Initial durable jobs may use PostgreSQL row locking. A separate message
 * broker is deferred until measured load requires it." This is that decision
 * implemented, and the two mechanisms that make it safe are worth stating.
 *
 * **`FOR UPDATE SKIP LOCKED`** is why two runners never take the same job: the
 * claim locks the row it selects and skips rows another transaction already
 * holds. No coordination between runners is needed, and adding a runner adds
 * throughput rather than contention.
 *
 * **A lease** is why a crashed runner does not strand a job. The row also
 * carries `locked_until`, and a claim considers a `running` row whose lease has
 * expired to be claimable. A transaction that is rolled back by the server
 * releases its lock immediately; a runner that vanishes without the database
 * noticing costs a lease's delay instead. That is what `docs/ARCHITECTURE.md`
 * section 14's "recover durable jobs" asks of a control-plane restart.
 *
 * Every terminal outcome writes an event, because a job is a state change and
 * `AGENTS.md` admits no exception for the ones nobody is watching.
 */

import { newEntityId } from "@reviewplane/protocol/platform";
import type { JobFailureReason, JobKind } from "@reviewplane/protocol/platform";

import { inTransaction, type Pool, type PoolClient } from "../db/pool.ts";
import { appendEvent, type EventPublisher } from "../events/append.ts";

export type { JobKind };

/** How long a claim holds a job before another runner may take it. */
export const DEFAULT_LEASE_MS = 60_000;

/** How long a handler may run before its attempt is abandoned. */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 55_000;

/** Base of the exponential backoff between attempts. */
const BACKOFF_BASE_MS = 2_000;

/** Cap on the backoff, so a failing job still retries at a useful rate. */
const BACKOFF_MAX_MS = 300_000;

export interface JobRecord {
  readonly id: string;
  readonly organisationId: string;
  readonly projectId: string | null;
  readonly kind: JobKind;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  readonly maxAttempts: number;
}

export interface EnqueueJobInput {
  readonly organisationId: string;
  readonly projectId?: string | null;
  readonly kind: JobKind;
  readonly payload?: Record<string, unknown>;
  readonly runAfter?: Date;
  readonly maxAttempts?: number;
  /**
   * Deduplicates repeated scheduling. A second enqueue with a live job of the
   * same kind and key returns the existing job rather than a second one.
   */
  readonly idempotencyKey?: string;
}

export type JobHandler = (job: JobRecord, client: PoolClient) => Promise<void>;

interface JobRow {
  readonly id: string;
  readonly organisation_id: string;
  readonly project_id: string | null;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  readonly max_attempts: number;
}

function toRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    projectId: row.project_id,
    kind: row.kind as JobKind,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  };
}

/**
 * Enqueues work in an existing transaction.
 *
 * It takes a client rather than a pool so that scheduling a job and making the
 * state change that needs it commit together: a job that exists for a change
 * that rolled back would act on state that never happened, and a change without
 * its job would silently skip the work.
 */
export async function enqueueJob(
  client: PoolClient,
  input: EnqueueJobInput,
): Promise<{ readonly id: string; readonly created: boolean }> {
  const id = newEntityId("job");
  const runAfter = input.runAfter ?? new Date();
  const inserted = await client.query<{ id: string }>(
    `insert into jobs (id, organisation_id, project_id, kind, payload, run_after, max_attempts, idempotency_key)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
     on conflict do nothing
     returning id`,
    [
      id,
      input.organisationId,
      input.projectId ?? null,
      input.kind,
      JSON.stringify(input.payload ?? {}),
      runAfter,
      input.maxAttempts ?? 5,
      input.idempotencyKey ?? null,
    ],
  );
  if (inserted.rows.length === 1) {
    await appendEvent(client, {
      type: "job.enqueued",
      organisationId: input.organisationId,
      projectId: input.projectId ?? null,
      actor: { type: "system", display: "job runner" },
      correlation: { job_id: id },
      payload: { job_id: id, kind: input.kind, run_after: runAfter.toISOString() },
    });
    return { id, created: true };
  }

  // The deduplication index refused the insert, so a live job already covers
  // this work. Returning its identifier lets a caller correlate rather than
  // guess whether anything happened.
  const existing = await client.query<{ id: string }>(
    `select id from jobs
      where kind = $1 and idempotency_key = $2 and status in ('pending', 'running')`,
    [input.kind, input.idempotencyKey ?? null],
  );
  return { id: existing.rows[0]?.id ?? id, created: false };
}

export interface JobRunnerOptions {
  readonly pool: Pool;
  readonly handlers: Readonly<Partial<Record<JobKind, JobHandler>>>;
  readonly pollIntervalMs?: number;
  readonly leaseMs?: number;
  readonly attemptTimeoutMs?: number;
  readonly publisher?: EventPublisher;
  readonly logger?: {
    info(fields: Record<string, unknown>, message: string): void;
    error(fields: Record<string, unknown>, message: string): void;
  };
  /** Identifies this runner in `jobs.locked_by`, for operator diagnosis. */
  readonly runnerId?: string;
}

export class JobRunner {
  readonly #pool: Pool;
  readonly #handlers: Readonly<Partial<Record<JobKind, JobHandler>>>;
  readonly #pollIntervalMs: number;
  readonly #leaseMs: number;
  readonly #attemptTimeoutMs: number;
  readonly #publisher: EventPublisher | undefined;
  readonly #logger: JobRunnerOptions["logger"];
  readonly #runnerId: string;
  #timer: NodeJS.Timeout | null = null;
  #inFlight: Promise<void> | null = null;
  #stopped = true;

  constructor(options: JobRunnerOptions) {
    this.#pool = options.pool;
    this.#handlers = options.handlers;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.#leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.#attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    this.#publisher = options.publisher;
    this.#logger = options.logger;
    this.#runnerId = options.runnerId ?? newEntityId("job");
  }

  get runnerId(): string {
    return this.#runnerId;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        this.#logger?.error({ err: error }, "job poll failed");
      });
    }, this.#pollIntervalMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await this.#inFlight?.catch(() => undefined);
  }

  /** Claims and runs at most one job. Returns whether anything ran. */
  async runOnce(): Promise<boolean> {
    if (this.#inFlight !== null) {
      await this.#inFlight;
      return false;
    }
    const run = this.#claimAndRun();
    this.#inFlight = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await run;
    } finally {
      this.#inFlight = null;
    }
  }

  /** Drains the queue, for tests and for a one-shot `reviewplane jobs --once`. */
  async drain(limit = 100): Promise<number> {
    let done = 0;
    while (done < limit && (await this.runOnce())) done += 1;
    return done;
  }

  async #claimAndRun(): Promise<boolean> {
    const claimed = await this.#claim();
    if (claimed === null) return false;

    const handler = this.#handlers[claimed.kind];
    if (handler === undefined) {
      await this.#fail(claimed, "handler_unknown", `no handler is registered for ${claimed.kind}`);
      return true;
    }

    const started = Date.now();
    try {
      await this.#withTimeout(
        inTransaction(this.#pool, async (client) => handler(claimed, client)),
      );
    } catch (error) {
      const reason: JobFailureReason =
        error instanceof JobTimeoutError ? "attempt_timeout" : "handler_error";
      await this.#fail(claimed, reason, error instanceof Error ? error.message : String(error));
      return true;
    }
    await this.#succeed(claimed, Date.now() - started);
    return true;
  }

  /**
   * Takes one job.
   *
   * The predicate is the whole design: a row is claimable when it is `pending`
   * and due, or when it is `running` with an expired lease — the second case is
   * how a job survives the runner that was holding it disappearing.
   */
  async #claim(): Promise<JobRecord | null> {
    return inTransaction(this.#pool, async (client) => {
      const rows = await client.query<JobRow>(
        `select id, organisation_id, project_id, kind, payload, attempts, max_attempts
           from jobs
          where (status = 'pending' and run_after <= now())
             or (status = 'running' and locked_until is not null and locked_until < now())
          order by run_after, created_at
          for update skip locked
          limit 1`,
      );
      const row = rows.rows[0];
      if (row === undefined) return null;
      await client.query(
        `update jobs
            set status = 'running',
                attempts = attempts + 1,
                locked_until = now() + ($2 || ' milliseconds')::interval,
                locked_by = $3,
                updated_at = now()
          where id = $1`,
        [row.id, String(this.#leaseMs), this.#runnerId],
      );
      return toRecord({ ...row, attempts: row.attempts + 1 });
    });
  }

  async #succeed(job: JobRecord, durationMs: number): Promise<void> {
    const event = await inTransaction(this.#pool, async (client) => {
      await client.query(
        `update jobs
            set status = 'succeeded', completed_at = now(), locked_until = null,
                locked_by = null, last_error = null, updated_at = now()
          where id = $1`,
        [job.id],
      );
      return appendEvent(client, {
        type: "job.succeeded",
        organisationId: job.organisationId,
        projectId: job.projectId,
        actor: { type: "system", display: "job runner" },
        correlation: { job_id: job.id },
        payload: {
          job_id: job.id,
          kind: job.kind,
          attempts: job.attempts,
          duration_ms: Math.min(durationMs, 86_400_000),
        },
      });
    });
    this.#publisher?.publish(event);
  }

  async #fail(job: JobRecord, reason: JobFailureReason, detail: string): Promise<void> {
    const exhausted = job.attempts >= job.maxAttempts;
    const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (job.attempts - 1), BACKOFF_MAX_MS);
    const nextAttemptAt = exhausted ? null : new Date(Date.now() + backoff);
    const finalReason: JobFailureReason =
      exhausted && reason === "handler_error" ? "attempts_exhausted" : reason;

    const event = await inTransaction(this.#pool, async (client) => {
      await client.query(
        `update jobs
            set status = $2,
                run_after = coalesce($3, run_after),
                locked_until = null,
                locked_by = null,
                last_error = $4,
                completed_at = case when $2 = 'failed' then now() else null end,
                updated_at = now()
          where id = $1`,
        [
          job.id,
          exhausted ? "failed" : "pending",
          nextAttemptAt,
          // Bounded, and never a stack trace: `docs/SECURITY.md` section 18.
          detail.slice(0, 500),
        ],
      );
      return appendEvent(client, {
        type: "job.failed",
        organisationId: job.organisationId,
        projectId: job.projectId,
        actor: { type: "system", display: "job runner" },
        correlation: { job_id: job.id },
        payload: {
          job_id: job.id,
          kind: job.kind,
          attempts: job.attempts,
          reason: finalReason,
          retrying: !exhausted,
          ...(nextAttemptAt === null ? {} : { next_attempt_at: nextAttemptAt.toISOString() }),
        },
      });
    });
    this.#logger?.error({ job_id: job.id, kind: job.kind, reason: finalReason }, "job attempt failed");
    this.#publisher?.publish(event);
  }

  async #withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new JobTimeoutError(`attempt exceeded ${String(this.#attemptTimeoutMs)} ms`));
          }, this.#attemptTimeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export class JobTimeoutError extends Error {}
