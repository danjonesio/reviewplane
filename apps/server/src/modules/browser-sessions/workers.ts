/**
 * Browser-worker identity, assignment and liveness (`docs/SECURITY.md` section
 * 6.4, `docs/ARCHITECTURE.md` section 11, `docs/OPERATIONS.md` section 8).
 *
 * A worker authenticates with its own credential, which is not the
 * administrator token, and it may only be given sessions for the projects an
 * administrator has assigned to it. "Not yet assigned" means "serves nothing":
 * there is no wildcard.
 *
 * Two rules here changed with RVP-30.
 *
 * **The assignment is restated on every heartbeat** (ADR-0026). It used to be
 * sent once, in the registration acknowledgement, and the worker cached it for
 * the life of the process. So an assignment *added* mid-flight did not take
 * effect until the worker restarted — an availability problem — and an
 * assignment *removed* did not take effect until the worker restarted either,
 * which is an authorisation problem: a worker went on serving a project an
 * administrator had unassigned. The heartbeat now answers with the whole
 * current set, so a revocation is bounded by one heartbeat interval.
 *
 * **Liveness is a state, not an inference** (ADR-0027). `last_heartbeat_at` was
 * written and never read; a stopped worker stayed `active` for ever. It is now
 * swept by `monitor.ts` and filtered by `liveness.ts` in every query that
 * decides something.
 */

import type { Pool, PoolClient } from "pg";

import type { WorkerRegistration } from "@reviewplane/protocol/browser";

import { credentialDigest, credentialMatches, type WorkerPrincipal } from "../../auth.ts";
import { inTransaction } from "../../db/pool.ts";
import { appendEvent, type EventActor } from "../../events/append.ts";
import { ApiError, notFound } from "../../errors.ts";
import { newId } from "../../ids.ts";
import { DEFAULT_BROWSER_WORKER_CONFIG, type BrowserWorkerConfig } from "./config.ts";
import { SCHEDULABLE_WORKER_STATUSES, workerLivePredicate } from "./liveness.ts";

export interface WorkerRow {
  readonly id: string;
  readonly name: string;
  readonly capacity: number;
  readonly sandbox_enabled: boolean;
  readonly status: string;
  readonly browser_version: string;
}

const WORKER_COLUMNS = "id, name, capacity, sandbox_enabled, status, browser_version";

const SYSTEM_ACTOR: EventActor = { type: "system", display: "browser worker registry" };

/**
 * The organisation a worker-lifecycle event is recorded against.
 *
 * A browser worker belongs to the deployment rather than to an organisation:
 * it is assigned projects, and those projects may in principle span
 * organisations. An event needs a stream, so it is recorded against the
 * deployment's organisation — the same choice `modules/backup` makes for the
 * archive events, and for the same reason. A deployment with no organisation
 * yet has nothing to correlate the event to, so the transition still happens
 * and only the audit record is skipped.
 */
async function deploymentOrganisation(pool: Pool | PoolClient): Promise<string | null> {
  const rows = await pool.query<{ id: string }>(
    "SELECT id FROM organisations ORDER BY created_at LIMIT 1",
  );
  return rows.rows[0]?.id ?? null;
}

export class WorkerRegistry {
  readonly #pool: Pool;
  readonly #expectedCredential: string;
  readonly #config: BrowserWorkerConfig;

  constructor(
    pool: Pool,
    expectedCredential: string,
    config: BrowserWorkerConfig = DEFAULT_BROWSER_WORKER_CONFIG,
  ) {
    this.#pool = pool;
    this.#expectedCredential = expectedCredential;
    this.#config = config;
  }

  get config(): BrowserWorkerConfig {
    return this.#config;
  }

  /**
   * Registers or refreshes the worker record.
   *
   * `docs/SECURITY.md` section 10 requires the Chromium sandbox to stay
   * enabled, and describes disabling it as an unsupported, high-risk
   * configuration. Such a worker is refused outright rather than recorded as a
   * risk and then used.
   *
   * Registration also clears any `degraded`/`lost` marks: a worker that has
   * just announced itself is live by observation, and leaving the mark would
   * make a recovered worker unschedulable until a sweep noticed.
   */
  async register(
    credential: string,
    registration: WorkerRegistration,
  ): Promise<{
    workerId: string;
    assignedProjects: string[];
    heartbeatIntervalSeconds: number;
  }> {
    if (!credentialMatches(credential, this.#expectedCredential)) {
      throw new ApiError("AUTHENTICATION_REQUIRED", "The worker credential was not recognised.");
    }
    if (!registration.sandbox_enabled) {
      throw new ApiError(
        "POLICY_DENIED",
        "A browser worker with the Chromium sandbox disabled is not accepted (docs/SECURITY.md section 10).",
      );
    }
    const digest = credentialDigest(credential);
    const existing = await this.#pool.query<{ id: string; status: string }>(
      "SELECT id, status FROM browser_workers WHERE name = $1",
      [registration.worker_name],
    );
    const previous = existing.rows[0];
    const workerId = previous?.id ?? newId("wkr_");

    await inTransaction(this.#pool, async (client) => {
      await client.query(
        `INSERT INTO browser_workers (
            id, name, credential_sha256, worker_version, browser_type, browser_version,
            capacity, labels, sandbox_enabled, status, registered_at, last_heartbeat_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 'active', now(), now())
         ON CONFLICT (name) DO UPDATE SET
            credential_sha256 = EXCLUDED.credential_sha256,
            worker_version    = EXCLUDED.worker_version,
            browser_version   = EXCLUDED.browser_version,
            capacity          = EXCLUDED.capacity,
            labels            = EXCLUDED.labels,
            sandbox_enabled   = EXCLUDED.sandbox_enabled,
            status            = 'active',
            registered_at     = now(),
            last_heartbeat_at = now(),
            degraded_at       = NULL,
            lost_at           = NULL`,
        [
          workerId,
          registration.worker_name,
          digest,
          registration.worker_version,
          registration.browser_type,
          registration.browser_version,
          registration.capacity,
          JSON.stringify(registration.labels),
          registration.sandbox_enabled,
        ],
      );
      const organisationId = await deploymentOrganisation(client);
      if (organisationId !== null) {
        await appendEvent(client, {
          type: "browser_worker.registered",
          organisationId,
          actor: { type: "browser_worker", id: workerId, display: registration.worker_name },
          correlation: { worker_id: workerId },
          payload: {
            previous_status: previous?.status ?? null,
            new_status: "active",
            capacity: registration.capacity,
            browser_type: registration.browser_type,
            browser_version: registration.browser_version,
            sandbox_enabled: registration.sandbox_enabled,
          },
        });
      }
    });

    return {
      workerId,
      assignedProjects: await this.assignedProjects(workerId),
      heartbeatIntervalSeconds: this.#config.heartbeatIntervalSeconds,
    };
  }

  async assignedProjects(workerId: string): Promise<string[]> {
    const rows = await this.#pool.query<{ project_id: string }>(
      "SELECT project_id FROM browser_worker_projects WHERE worker_id = $1 ORDER BY project_id",
      [workerId],
    );
    return rows.rows.map((row) => row.project_id);
  }

  /** Replaces a worker's assignment. Administrative action only. */
  async assign(workerId: string, projectIds: readonly string[]): Promise<string[]> {
    const worker = await this.byId(workerId);
    await this.#pool.query("DELETE FROM browser_worker_projects WHERE worker_id = $1", [worker.id]);
    for (const projectId of projectIds) {
      await this.#pool.query(
        "INSERT INTO browser_worker_projects (worker_id, project_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [worker.id, projectId],
      );
    }
    return this.assignedProjects(worker.id);
  }

  async byId(workerId: string): Promise<WorkerRow> {
    const rows = await this.#pool.query(
      `SELECT ${WORKER_COLUMNS} FROM browser_workers WHERE id = $1`,
      [workerId],
    );
    const row = rows.rows[0] as WorkerRow | undefined;
    if (row === undefined) throw notFound("The browser worker");
    return row;
  }

  /**
   * A worker that may be scheduled onto **now**.
   *
   * The liveness term is in the query rather than in a caller's `if`, and that
   * is the point of RVP-70: a worker that died between two sweeps still has
   * `status = 'active'`, and a scheduler that read only the status would
   * dispatch a session to a container that is gone. The failure would then
   * surface as a session that never becomes ready instead of
   * `BROWSER_CAPACITY_EXHAUSTED`.
   *
   * Stage 1 has one worker (`docs/ROADMAP.md`: multiple workers and worker
   * labels are Stage 2), so this returns the oldest live one. What Stage 2
   * replaces is the ordering, not the predicate.
   */
  async active(): Promise<WorkerRow | null> {
    const rows = await this.#pool.query(
      `SELECT ${WORKER_COLUMNS}
         FROM browser_workers
        WHERE status = ANY($2)
          AND ${workerLivePredicate(1)}
        ORDER BY registered_at
        LIMIT 1`,
      [this.#config.degradedAfterSeconds, SCHEDULABLE_WORKER_STATUSES],
    );
    return (rows.rows[0] as WorkerRow | undefined) ?? null;
  }

  /**
   * Every worker whose row still claims it can work, live or not.
   *
   * The reconciler needs this: a worker that has gone quiet is exactly the one
   * whose sessions have to be reconsidered, so filtering it out here would hide
   * the rows the sweep exists to act on.
   */
  async schedulableRows(): Promise<readonly (WorkerRow & { live: boolean })[]> {
    const rows = await this.#pool.query<WorkerRow & { live: boolean }>(
      `SELECT ${WORKER_COLUMNS}, ${workerLivePredicate(1)} AS live
         FROM browser_workers
        WHERE status = ANY($2)
        ORDER BY registered_at`,
      [this.#config.degradedAfterSeconds, SCHEDULABLE_WORKER_STATUSES],
    );
    return rows.rows;
  }

  /**
   * Resolves the principal behind a presented worker credential, with the
   * projects it may act for. A worker whose assignment is empty authenticates
   * successfully and can do nothing, which is the intended shape.
   *
   * A `lost` or `revoked` worker does not resolve: it may not report a session
   * status or upload evidence, because the control plane has already concluded
   * it is not there. A `degraded` one still does — being late is not being gone,
   * and refusing its heartbeat would be the one action that could recover it.
   */
  async principal(credential: string): Promise<WorkerPrincipal> {
    if (!credentialMatches(credential, this.#expectedCredential)) {
      throw new ApiError("AUTHENTICATION_REQUIRED", "The worker credential was not recognised.");
    }
    const digest = credentialDigest(credential);
    const rows = await this.#pool.query<{ id: string; name: string }>(
      "SELECT id, name FROM browser_workers WHERE credential_sha256 = $1 AND status = ANY($2)",
      [digest, SCHEDULABLE_WORKER_STATUSES],
    );
    const row = rows.rows[0];
    if (row === undefined) {
      throw new ApiError(
        "AUTHORISATION_DENIED",
        "This worker credential is not registered with an active worker.",
      );
    }
    return {
      type: "browser_worker",
      workerId: row.id,
      name: row.name,
      assignedProjects: new Set(await this.assignedProjects(row.id)),
    };
  }

  /**
   * Records a heartbeat and answers with the assignment that is current now.
   *
   * The answer is the whole set rather than a change list, so a worker that
   * missed an earlier answer converges anyway and neither side keeps a diff
   * (ADR-0026). A worker that had been degraded or lost recovers here: it is
   * heartbeating, which is the observation the sweep was inferring from its
   * absence.
   */
  async recordHeartbeat(
    workerId: string,
    activeSessions: number,
  ): Promise<{ assignedProjects: string[]; heartbeatIntervalSeconds: number }> {
    const previous = await this.#pool.query<{ status: string }>(
      "SELECT status FROM browser_workers WHERE id = $1",
      [workerId],
    );
    const previousStatus = previous.rows[0]?.status ?? null;
    await inTransaction(this.#pool, async (client) => {
      await client.query(
        `UPDATE browser_workers
            SET last_heartbeat_at = now(),
                active_sessions   = $2,
                status            = 'active',
                degraded_at       = NULL,
                lost_at           = NULL
          WHERE id = $1`,
        [workerId, activeSessions],
      );
      const organisationId = await deploymentOrganisation(client);
      if (previousStatus !== null && previousStatus !== "active" && organisationId !== null) {
        // A worker that was degraded or lost and is heartbeating again has
        // recovered. The recovery is recorded, because "it came back" and "it
        // never went" are different facts to an operator reading a timeline.
        await appendEvent(client, {
          type: "browser_worker.registered",
          organisationId,
          actor: { type: "browser_worker", id: workerId },
          correlation: { worker_id: workerId },
          payload: {
            previous_status: previousStatus,
            new_status: "active",
            trigger: "heartbeat_recovered",
          },
        });
      }
    });
    return {
      assignedProjects: await this.assignedProjects(workerId),
      heartbeatIntervalSeconds: this.#config.heartbeatIntervalSeconds,
    };
  }

  /**
   * Moves a worker to a status the liveness sweep concluded.
   *
   * Conditional on the statuses it may leave, and it reads the row `FOR UPDATE`
   * first, so two sweeps racing produce one transition and one event rather
   * than two.
   */
  async transition(
    workerId: string,
    from: readonly string[],
    to: "degraded" | "lost",
    payload: Readonly<Record<string, unknown>>,
  ): Promise<boolean> {
    return inTransaction(this.#pool, async (client: PoolClient) => {
      const locked = await client.query<{ status: string; name: string }>(
        "SELECT status, name FROM browser_workers WHERE id = $1 FOR UPDATE",
        [workerId],
      );
      const row = locked.rows[0];
      if (row === undefined || !from.includes(row.status)) return false;
      await client.query(
        `UPDATE browser_workers
            SET status = $2,
                degraded_at = CASE WHEN $2 = 'degraded' THEN now() ELSE degraded_at END,
                lost_at     = CASE WHEN $2 = 'lost'     THEN now() ELSE lost_at     END
          WHERE id = $1`,
        [workerId, to],
      );
      const organisationId = await deploymentOrganisation(client);
      if (organisationId !== null) {
        await appendEvent(client, {
          type: to === "lost" ? "browser_worker.lost" : "browser_worker.degraded",
          organisationId,
          actor: SYSTEM_ACTOR,
          correlation: { worker_id: workerId },
          payload: { previous_status: row.status, new_status: to, ...payload },
        });
      }
      return true;
    });
  }

  /** Workers silent for longer than the budget, in the statuses given. */
  async findSilent(
    statuses: readonly string[],
    silentForSeconds: number,
  ): Promise<readonly { id: string; name: string }[]> {
    const rows = await this.#pool.query<{ id: string; name: string }>(
      `SELECT id, name
         FROM browser_workers
        WHERE status = ANY($2)
          AND NOT (${workerLivePredicate(1)})`,
      [silentForSeconds, statuses],
    );
    return rows.rows;
  }
}
