/**
 * The browser-worker liveness sweep and the session reconciler
 * (`docs/OPERATIONS.md` sections 8 and 9, ADR-0027).
 *
 * Two jobs, one timer, because they answer the same question in the same pass:
 * what does the control plane still believe that is no longer true?
 *
 * **Liveness.** A worker that stops heartbeating moves `active → degraded →
 * lost`, each transition emitting its event. The shape is the connector's
 * (`modules/connectors/monitor.ts`) on purpose: one concept of liveness in the
 * product, so an operator who has read one has read both. `lost` is evaluated
 * before `degraded`, so a worker silent for a long time lands in `lost` rather
 * than being degraded now and only caught next pass.
 *
 * **Reconciliation.** For every worker that is still live, the control plane
 * asks what contexts it is actually holding and compares:
 *
 *   * a context the control plane has no live session for is an **orphan**, and
 *     is terminated on the worker — it is holding a browser nobody owns;
 *   * a session the control plane believes is live on a worker that no longer
 *     holds it is **missing**, and is marked `DEGRADED` rather than terminated,
 *     because `docs/DOMAIN_MODEL.md` section 12 requires a session to stay
 *     diagnosable rather than disappear;
 *   * a session on a worker that has been **lost** is failed, because the
 *     browser it was running in is gone and evidence already uploaded stays
 *     exactly where it is (`docs/ARCHITECTURE.md` section 14).
 *
 * Stale control leases expire in the same pass.
 */

import type { Pool } from "pg";

import type { WorkerContext } from "@reviewplane/protocol/browser";

import { inTransaction } from "../../db/pool.ts";
import { appendEvent, type EventActor } from "../../events/append.ts";
import type { BrowserWorkerConfig } from "./config.ts";
import type { BrowserSessionService } from "./service.ts";
import type { BrowserWorkerClient } from "./worker-client.ts";
import type { WorkerRegistry } from "./workers.ts";

const SYSTEM_ACTOR: EventActor = { type: "system", display: "browser session reconciler" };

export interface SweepResult {
  readonly degraded: number;
  readonly lost: number;
  readonly orphanContextsTerminated: number;
  readonly sessionsDegraded: number;
  readonly sessionsFailed: number;
  readonly leasesExpired: number;
}

export interface MonitorOptions {
  readonly pool: Pool;
  readonly workers: WorkerRegistry;
  readonly client: BrowserWorkerClient;
  readonly sessions: BrowserSessionService;
  readonly config: BrowserWorkerConfig;
  readonly log?: (message: string, detail: Record<string, unknown>) => void;
}

/** Sessions the control plane still believes are live, by worker. */
interface LiveSessionRow {
  readonly id: string;
  readonly worker_id: string;
  readonly project_id: string;
  readonly organisation_id: string;
  readonly status: string;
}

async function liveSessions(pool: Pool): Promise<readonly LiveSessionRow[]> {
  const rows = await pool.query<LiveSessionRow>(
    `SELECT id, worker_id, project_id, organisation_id, status
       FROM browser_sessions
      WHERE ended_at IS NULL
        AND worker_id IS NOT NULL
        AND status IN ('ALLOCATING', 'READY', 'ACTIVE', 'PAUSED', 'DEGRADED')`,
  );
  return rows.rows;
}

/**
 * Expires control leases that have run out.
 *
 * `docs/SECURITY.md` section 8 requires leases to expire. Until this ran,
 * `expires_at` was written and never enforced, so a lease outlived its window
 * and a controller that had walked away still held the browser. Expiring the
 * lease does **not** move the epoch: the epoch moves when a controller changes,
 * and nobody has taken control here. The next `control/request` increments it.
 */
async function expireStaleLeases(pool: Pool): Promise<number> {
  const result = await pool.query(
    `UPDATE control_leases
        SET revoked_at = now(),
            reason     = 'lease expired'
      WHERE revoked_at IS NULL
        AND expires_at < now()`,
  );
  return result.rowCount ?? 0;
}

/** One pass of the liveness sweep and the reconciler. */
export async function sweepBrowserWorkers(options: MonitorOptions): Promise<SweepResult> {
  const { pool, workers, config } = options;
  const log = options.log ?? ((): void => undefined);
  let degraded = 0;
  let lost = 0;

  // `lost` first: a worker silent for longer than the lost budget is also
  // silent for longer than the degraded one, and evaluating `degraded` first
  // would move it there and only conclude next pass.
  for (const worker of await workers.findSilent(["active", "degraded"], config.lostAfterSeconds)) {
    const moved = await workers.transition(worker.id, ["active", "degraded"], "lost", {
      trigger: "heartbeat_timeout",
      silent_for_seconds_at_least: config.lostAfterSeconds,
    });
    if (moved) {
      lost += 1;
      log("browser worker lost", { worker_id: worker.id, worker: worker.name });
    }
  }
  for (const worker of await workers.findSilent(["active"], config.degradedAfterSeconds)) {
    const moved = await workers.transition(worker.id, ["active"], "degraded", {
      trigger: "heartbeat_delay",
      silent_for_seconds_at_least: config.degradedAfterSeconds,
    });
    if (moved) {
      degraded += 1;
      log("browser worker degraded", { worker_id: worker.id, worker: worker.name });
    }
  }

  const reconciliation = await reconcileSessions(options);
  const leasesExpired = await expireStaleLeases(pool);

  return { degraded, lost, ...reconciliation, leasesExpired };
}

interface ReconciliationResult {
  readonly orphanContextsTerminated: number;
  readonly sessionsDegraded: number;
  readonly sessionsFailed: number;
}

async function reconcileSessions(options: MonitorOptions): Promise<ReconciliationResult> {
  const { pool, workers, client, sessions } = options;
  const log = options.log ?? ((): void => undefined);
  let orphanContextsTerminated = 0;
  let sessionsDegraded = 0;
  let sessionsFailed = 0;

  const sessionRows = await liveSessions(pool);
  const rows = await workers.schedulableRows();
  const live = new Map(rows.map((row) => [row.id, row.live]));

  // A session whose worker is gone from the schedulable set entirely — lost or
  // revoked — cannot be recovered by asking the worker, because there is no
  // worker to ask.
  for (const session of sessionRows) {
    if (live.has(session.worker_id)) continue;
    await sessions
      .markReconciled(session.id, "FAILED", "the browser worker running this session is gone")
      .catch(() => undefined);
    sessionsFailed += 1;
  }

  for (const [workerId, isLive] of live) {
    const owned = sessionRows.filter((session) => session.worker_id === workerId);
    if (!isLive) {
      // A worker that has stopped heartbeating but is not yet lost: its
      // sessions are not credible, and `docs/DOMAIN_MODEL.md` section 12 says a
      // session in that position is DEGRADED and stays diagnosable.
      for (const session of owned) {
        if (session.status === "DEGRADED") continue;
        await sessions
          .markReconciled(session.id, "DEGRADED", "the browser worker stopped reporting")
          .catch(() => undefined);
        sessionsDegraded += 1;
      }
      continue;
    }

    let contexts: readonly WorkerContext[];
    try {
      contexts = (await client.contexts(workerId)).contexts;
    } catch (error) {
      log("could not read worker contexts", {
        worker_id: workerId,
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const held = new Set(contexts.map((context) => context.browser_session_id));
    const expected = new Set(owned.map((session) => session.id));

    for (const context of contexts) {
      if (expected.has(context.browser_session_id)) continue;
      // The worker is holding a browser the control plane has no live session
      // for. Terminating it is the whole point of `docs/OPERATIONS.md` section
      // 9: an orphan context consumes a slot and holds page state nobody owns.
      await client
        .terminate(workerId, context.browser_session_id, "failure", "orphan context reconciled")
        .catch(() => undefined);
      orphanContextsTerminated += 1;
      await recordOrphan(pool, workerId, context);
      log("terminated orphan browser context", {
        worker_id: workerId,
        browser_session_id: context.browser_session_id,
      });
    }

    for (const session of owned) {
      if (held.has(session.id)) continue;
      if (session.status === "ALLOCATING") continue;
      if (session.status === "DEGRADED") continue;
      await sessions
        .markReconciled(session.id, "DEGRADED", "the worker no longer holds this browser context")
        .catch(() => undefined);
      sessionsDegraded += 1;
    }
  }

  return { orphanContextsTerminated, sessionsDegraded, sessionsFailed };
}

async function recordOrphan(
  pool: Pool,
  workerId: string,
  context: WorkerContext,
): Promise<void> {
  const organisation = await pool.query<{ organisation_id: string }>(
    "SELECT organisation_id FROM projects WHERE id = $1",
    [context.project_id],
  );
  const organisationId = organisation.rows[0]?.organisation_id;
  if (organisationId === undefined) return;
  await inTransaction(pool, async (client) => {
    await appendEvent(client, {
      type: "browser_session.reconciled",
      organisationId,
      projectId: context.project_id,
      actor: SYSTEM_ACTOR,
      correlation: { browser_session_id: context.browser_session_id, worker_id: workerId },
      payload: {
        action: "orphan_context_terminated",
        reported_status: context.status,
        reported_control_epoch: context.control_epoch,
      },
    });
  });
}

/** The timer that runs the sweep, started and stopped with the server. */
export class BrowserWorkerMonitor {
  readonly #options: MonitorOptions;
  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(options: MonitorOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      // One pass at a time. A sweep that overlapped itself would race two
      // transitions for the same worker, and the conditional update would then
      // be the only thing keeping the event count honest.
      if (this.#running) return;
      this.#running = true;
      void sweepBrowserWorkers(this.#options)
        .catch(() => undefined)
        .finally(() => {
          this.#running = false;
        });
    }, this.#options.config.monitorIntervalSeconds * 1000);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }
}
