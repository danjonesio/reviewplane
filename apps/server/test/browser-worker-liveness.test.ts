/**
 * Browser-worker liveness, assignment refresh and session reconciliation
 * (RVP-60, RVP-70; ADR-0026, ADR-0027; `docs/OPERATIONS.md` sections 8.1
 * and 9).
 *
 * Two properties are asserted separately on purpose, because they fail
 * separately:
 *
 *   * the **sweep** makes the stored state honest, so an operator reading
 *     `browser_workers` or the timeline sees a worker that is gone;
 *   * the **query term** makes the decision safe, so a worker that dies between
 *     two sweeps still cannot be scheduled onto.
 *
 * The scheduler test deliberately never runs the sweep. If it did, it would
 * pass with the liveness term removed from `WorkerRegistry.active` — the row
 * would already say `degraded` — and would be asserting the sweep twice instead
 * of asserting the thing RVP-70 says is unproven.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { encodeBrowserFrame } from "@reviewplane/protocol/browser";

import { newId } from "../src/ids.ts";
import { sweepBrowserWorkers } from "../src/modules/browser-sessions/monitor.ts";
import type { BrowserWorkerConfig } from "../src/modules/browser-sessions/config.ts";
import {
  BOOTSTRAP_TOKEN,
  WORKER_CREDENTIAL,
  seedProjectAndWorker,
  startHarness,
  type Harness,
} from "./support/worker-harness.ts";
import { startMigratedDatabase, truncateAll, type MigratedDatabase } from "./support/postgres.ts";

let postgres: MigratedDatabase;
let harness: Harness;

/**
 * Short enough to drive from a test, and still ordered as production is: the
 * lost budget exceeds the degraded budget, which exceeds the heartbeat
 * interval. Silence is produced by moving `last_heartbeat_at` backwards rather
 * than by sleeping, so the suite measures the rule and not the clock.
 */
const FAST: BrowserWorkerConfig = {
  heartbeatIntervalSeconds: 5,
  degradedAfterSeconds: 10,
  lostAfterSeconds: 20,
  monitorIntervalSeconds: 3600,
};

const AUTH = { authorization: `Bearer ${BOOTSTRAP_TOKEN}` };
const DESKTOP = { width: 1440, height: 900, device_scale_factor: 1 };

before(async () => {
  postgres = await startMigratedDatabase();
});

after(async () => {
  await harness?.stop();
  await postgres?.stop();
});

beforeEach(async () => {
  await harness?.stop();
  await truncateAll(postgres.pool);
  harness = await startHarness(postgres.pool, { browserWorkerConfig: FAST });
});

/** Ages a worker's last heartbeat by the given number of seconds. */
async function silenceFor(workerId: string, seconds: number): Promise<void> {
  await postgres.pool.query(
    `UPDATE browser_workers
        SET last_heartbeat_at = now() - make_interval(secs => $2),
            registered_at     = now() - make_interval(secs => $2)
      WHERE id = $1`,
    [workerId, seconds],
  );
}

async function workerStatus(workerId: string): Promise<string> {
  const rows = await postgres.pool.query<{ status: string }>(
    "SELECT status FROM browser_workers WHERE id = $1",
    [workerId],
  );
  return rows.rows[0]?.status ?? "missing";
}

async function sweep() {
  return sweepBrowserWorkers({
    pool: postgres.pool,
    workers: harness.built.workers,
    client: harness.built.workerClient,
    sessions: harness.built.sessions,
    config: FAST,
  });
}

async function eventTypes(): Promise<string[]> {
  const rows = await postgres.pool.query<{ type: string }>(
    "SELECT type FROM events ORDER BY sequence",
  );
  return rows.rows.map((row) => row.type);
}

// ---------------------------------------------------------------------------
// The sweep: state
// ---------------------------------------------------------------------------

test("a worker that stops heartbeating is degraded, then lost, and each transition emits its event", async () => {
  const { workerId } = await seedProjectAndWorker(harness);
  assert.equal(await workerStatus(workerId), "active");

  await silenceFor(workerId, FAST.degradedAfterSeconds + 1);
  const first = await sweep();
  assert.equal(first.degraded, 1);
  assert.equal(first.lost, 0);
  assert.equal(await workerStatus(workerId), "degraded");
  assert.ok((await eventTypes()).includes("browser_worker.degraded"));

  await silenceFor(workerId, FAST.lostAfterSeconds + 1);
  const second = await sweep();
  assert.equal(second.lost, 1);
  assert.equal(await workerStatus(workerId), "lost");
  assert.ok((await eventTypes()).includes("browser_worker.lost"));

  const row = await postgres.pool.query<{ degraded_at: Date | null; lost_at: Date | null }>(
    "SELECT degraded_at, lost_at FROM browser_workers WHERE id = $1",
    [workerId],
  );
  assert.ok(row.rows[0]?.degraded_at !== null);
  assert.ok(row.rows[0]?.lost_at !== null);
});

test("a worker silent past the lost budget goes straight to lost rather than through degraded", async () => {
  const { workerId } = await seedProjectAndWorker(harness);
  await silenceFor(workerId, FAST.lostAfterSeconds + 5);
  const result = await sweep();
  assert.equal(result.lost, 1);
  assert.equal(result.degraded, 0);
  assert.equal(await workerStatus(workerId), "lost");
});

test("a heartbeat within the threshold is not reaped", async () => {
  const { workerId } = await seedProjectAndWorker(harness);
  await silenceFor(workerId, FAST.degradedAfterSeconds - 3);
  const result = await sweep();
  assert.equal(result.degraded, 0);
  assert.equal(result.lost, 0);
  assert.equal(await workerStatus(workerId), "active");
});

test("a worker that heartbeats again recovers and the recovery is recorded", async () => {
  const { workerId } = await seedProjectAndWorker(harness);
  await silenceFor(workerId, FAST.degradedAfterSeconds + 1);
  await sweep();
  assert.equal(await workerStatus(workerId), "degraded");

  await heartbeat();
  assert.equal(await workerStatus(workerId), "active");
  const rows = await postgres.pool.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM events WHERE type = 'browser_worker.registered' ORDER BY sequence",
  );
  assert.ok(
    rows.rows.some((row) => row.payload["trigger"] === "heartbeat_recovered"),
    "a recovery is a fact an operator reading a timeline needs",
  );
});

// ---------------------------------------------------------------------------
// The query term: decision
// ---------------------------------------------------------------------------

test("a session requested when the only worker has gone quiet is refused with BROWSER_CAPACITY_EXHAUSTED, without any sweep having run", async () => {
  const { projectId, workerId } = await seedProjectAndWorker(harness);
  await silenceFor(workerId, FAST.degradedAfterSeconds + 1);
  // No sweep. The row still says `active`; only the liveness term in the
  // scheduler's own query can refuse this, which is the half RVP-70 recorded as
  // unproven.
  assert.equal(await workerStatus(workerId), "active");

  const response = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/browser-sessions`,
    headers: AUTH,
    payload: { viewport: DESKTOP },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(
    (response.json() as { error: { code: string } }).error.code,
    "BROWSER_CAPACITY_EXHAUSTED",
  );
  // No session row was created and the worker was never contacted.
  const sessions = await postgres.pool.query("SELECT 1 FROM browser_sessions");
  assert.equal(sessions.rows.length, 0);
  assert.equal(
    harness.workerRequests.filter((entry) => entry.path === "/internal/v1/sessions").length,
    0,
  );
});

test("reviewplane status does not count a stale worker's capacity", async () => {
  const { workerId } = await seedProjectAndWorker(harness);
  const { gatherStatus } = await import("../src/modules/operations/status.ts");

  const healthy = await gatherStatus({
    pool: postgres.pool,
    artefactPath: harness.artefactRoot,
    workerStaleAfterSeconds: FAST.degradedAfterSeconds,
  });
  assert.equal(healthy.browser_capacity.workers, 1);
  assert.equal(healthy.browser_capacity.capacity, 2);

  await silenceFor(workerId, FAST.degradedAfterSeconds + 1);
  const stale = await gatherStatus({
    pool: postgres.pool,
    artefactPath: harness.artefactRoot,
    workerStaleAfterSeconds: FAST.degradedAfterSeconds,
  });
  assert.equal(stale.browser_capacity.workers, 0);
  assert.equal(stale.browser_capacity.capacity, 0);
  assert.equal(stale.browser_capacity.stale_workers, 1);
});

// ---------------------------------------------------------------------------
// Assignment refresh (ADR-0026)
// ---------------------------------------------------------------------------

async function heartbeat(activeSessions = 0) {
  return harness.built.app.inject({
    method: "POST",
    url: "/internal/v1/workers/heartbeat",
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}`, "content-type": "application/json" },
    payload: encodeBrowserFrame({
      envelope: {
        protocol_version: 1,
        message_id: newId("msg_"),
        type: "worker.heartbeat",
        sent_at: new Date().toISOString(),
        worker_id: "wkr_ignored",
      },
      type: "worker.heartbeat",
      payload: {
        active_sessions: activeSessions,
        capacity: 2,
        observed_at: new Date().toISOString(),
      },
    }),
  });
}

test("a heartbeat is answered with the assignment that is current now", async () => {
  const { projectId, workerId } = await seedProjectAndWorker(harness);

  const granted = await heartbeat();
  assert.equal(granted.statusCode, 200);
  const { decodeBrowserFrame } = await import("@reviewplane/protocol/browser");
  const decoded = decodeBrowserFrame(granted.body);
  assert.ok(decoded.ok, "the heartbeat answer must be a decodable frame");
  assert.equal(decoded.value.type, "worker.heartbeat.ack");
  assert.deepEqual(
    [...(decoded.value.payload as { assigned_projects: readonly string[] }).assigned_projects],
    [projectId],
  );

  // The revoke direction, which is the security-relevant one: an assignment an
  // administrator removes must be visible on the next heartbeat, not at the
  // worker's next restart.
  await harness.built.app.inject({
    method: "PUT",
    url: `/api/v1/browser-workers/${workerId}/assignments`,
    headers: AUTH,
    payload: { project_ids: [] },
  });

  const revoked = await heartbeat();
  const afterRevocation = decodeBrowserFrame(revoked.body);
  assert.ok(afterRevocation.ok);
  assert.deepEqual(
    [...(afterRevocation.value.payload as { assigned_projects: readonly string[] }).assigned_projects],
    [],
  );
});

test("an unassigned project is refused a session even though the worker is live", async () => {
  const { projectId, workerId } = await seedProjectAndWorker(harness);
  await harness.built.app.inject({
    method: "PUT",
    url: `/api/v1/browser-workers/${workerId}/assignments`,
    headers: AUTH,
    payload: { project_ids: [] },
  });

  const response = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/browser-sessions`,
    headers: AUTH,
    payload: { viewport: DESKTOP },
  });
  assert.equal(
    (response.json() as { error: { code: string } }).error.code,
    "PROJECT_CONTEXT_MISMATCH",
  );
});

/**
 * The two copies of the assignment, and the window between them.
 *
 * `browser_worker_projects` is written by the PUT and read by the control
 * plane's own check, which therefore passes immediately. The worker's copy is
 * an in-memory set restated on its next heartbeat (ADR-0026), so it converges
 * up to one heartbeat interval later, and until it does the worker refuses the
 * allocation the control plane has just authorised.
 *
 * That window is designed, not a defect — but a refusal that says only "this
 * worker is not assigned to the project" while the fleet view says it is has no
 * way of being read correctly, and it cost a full end-to-end investigation
 * once: `deploy/compose/e2e/run.sh` waited on the row rather than on the
 * worker, reported that the worker had "picked up its assignment", and then
 * lost the race at the next step.
 */
test("a worker refusing a project the control plane has assigned is reported as a stale worker copy, not as an unassigned one", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  // seedProjectAndWorker assigns the project, so the control plane's own check
  // passes; the worker is the one refusing, exactly as a worker that has not
  // yet heartbeated since the assignment does.
  harness.worker.refuseWith = {
    status: 403,
    code: "PROJECT_CONTEXT_MISMATCH",
    message: "This worker is not assigned to the project the browser session belongs to.",
  };

  const response = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/browser-sessions`,
    headers: AUTH,
    payload: { viewport: DESKTOP },
  });
  const error = (response.json() as { error: { code: string; message: string; details?: Record<string, unknown> } }).error;
  assert.equal(error.code, "PROJECT_CONTEXT_MISMATCH");
  assert.match(error.message, /stale/u);
  assert.match(error.message, /heartbeat/u);
  // The wait is bounded and the answer says by how much, so a caller can retry
  // rather than guess or restart the worker.
  assert.match(error.message, new RegExp(String(FAST.heartbeatIntervalSeconds), "u"));
  assert.equal(error.details?.["browser_worker_assignment"], "stale");
});

test("a worker refusing a project the control plane has not assigned is left saying so", async () => {
  const { projectId, workerId } = await seedProjectAndWorker(harness);
  const session = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/browser-sessions`,
    headers: AUTH,
    payload: { viewport: DESKTOP, allocate: false },
  });
  const sessionId = (session.json() as { data: { id: string } }).data.id;

  // The assignment is withdrawn after the reservation, so the allocation runs
  // with no row anywhere. The worker's refusal is then simply correct and must
  // not be dressed up as a synchronisation delay that will pass on its own.
  await harness.built.app.inject({
    method: "PUT",
    url: `/api/v1/browser-workers/${workerId}/assignments`,
    headers: AUTH,
    payload: { project_ids: [] },
  });
  harness.worker.refuseWith = {
    status: 403,
    code: "PROJECT_CONTEXT_MISMATCH",
    message: "This worker is not assigned to the project the browser session belongs to.",
  };

  const response = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${sessionId}/allocate`,
    headers: AUTH,
    payload: {},
  });
  const error = (response.json() as { error: { code: string; message: string } }).error;
  assert.equal(error.code, "PROJECT_CONTEXT_MISMATCH");
  assert.doesNotMatch(error.message, /stale/u);
});

// ---------------------------------------------------------------------------
// Reconciliation (docs/OPERATIONS.md section 9)
// ---------------------------------------------------------------------------

test("a context no live session claims is terminated as an orphan and recorded", async () => {
  const { projectId, workerId } = await seedProjectAndWorker(harness);
  harness.worker.contexts = [
    {
      browser_session_id: "brs_orphan",
      project_id: projectId,
      status: "ACTIVE",
      control_epoch: 1,
    },
  ];

  const result = await sweep();
  assert.equal(result.orphanContextsTerminated, 1);
  const terminations = harness.workerRequests.filter(
    (entry) => entry.path === "/internal/v1/terminate",
  );
  assert.equal(terminations.length, 1);

  const rows = await postgres.pool.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM events WHERE type = 'browser_session.reconciled'",
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0]?.payload["action"], "orphan_context_terminated");
  assert.ok(workerId.length > 0);
});

test("a session the worker no longer holds is marked DEGRADED and stays diagnosable", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const started = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/browser-sessions`,
    headers: AUTH,
    payload: { viewport: DESKTOP },
  });
  const sessionId = (started.json() as { data: { id: string } }).data.id;

  // The worker reports it holds nothing, which is what a restarted worker
  // reports.
  harness.worker.contexts = [];
  const result = await sweep();
  assert.equal(result.sessionsDegraded, 1);

  const record = await harness.built.sessions.get(sessionId);
  assert.equal(record.status, "DEGRADED");
  assert.equal(record.ended_at, null, "a degraded session is retained, not ended");
  assert.ok((await eventTypes()).includes("browser_session.degraded"));
});

test("a session on a worker that has been lost is failed", async () => {
  const { projectId, workerId } = await seedProjectAndWorker(harness);
  const started = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/browser-sessions`,
    headers: AUTH,
    payload: { viewport: DESKTOP },
  });
  const sessionId = (started.json() as { data: { id: string } }).data.id;

  await silenceFor(workerId, FAST.lostAfterSeconds + 1);
  // The first sweep concludes the worker is lost. The session is reconciled in
  // the same pass, because a worker moved out of the schedulable set is exactly
  // the one whose sessions can no longer be recovered by asking it.
  const first = await sweep();
  assert.equal(await workerStatus(workerId), "lost");
  assert.equal(first.sessionsFailed, 1);
  const record = await harness.built.sessions.get(sessionId);
  assert.equal(record.status, "FAILED");
  const leases = await postgres.pool.query(
    "SELECT 1 FROM control_leases WHERE browser_session_id = $1 AND revoked_at IS NULL",
    [sessionId],
  );
  assert.equal(leases.rows.length, 0);
});

test("a control lease past its expiry is revoked by the sweep, without moving the epoch", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const started = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/browser-sessions`,
    headers: AUTH,
    payload: { viewport: DESKTOP },
  });
  const sessionId = (started.json() as { data: { id: string } }).data.id;
  harness.worker.contexts = [
    { browser_session_id: sessionId, project_id: projectId, status: "READY", control_epoch: 1 },
  ];

  await postgres.pool.query(
    "UPDATE control_leases SET expires_at = now() - interval '1 minute' WHERE browser_session_id = $1",
    [sessionId],
  );
  const result = await sweep();
  assert.equal(result.leasesExpired, 1);

  const leases = await postgres.pool.query<{ reason: string }>(
    "SELECT reason FROM control_leases WHERE browser_session_id = $1 AND revoked_at IS NOT NULL",
    [sessionId],
  );
  assert.equal(leases.rows[0]?.reason, "lease expired");

  const record = await harness.built.sessions.get(sessionId);
  assert.equal(record.control_epoch, 1, "an expiry is nobody taking control");
});
