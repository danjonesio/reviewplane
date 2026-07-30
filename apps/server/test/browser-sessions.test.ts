/**
 * Browser-session orchestration: lifecycle, control epoch, capacity and the
 * events each transition records
 * (`docs/DOMAIN_MODEL.md` sections 12 and 13, ADR-0007, `docs/EVENTS.md` §7).
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import type { BrowserCommandResult } from "@reviewplane/protocol/browser";

import {
  BOOTSTRAP_TOKEN,
  seedProjectAndWorker,
  startHarness,
  type Harness,
} from "./support/worker-harness.ts";
import { startMigratedDatabase, truncateAll } from "./support/postgres.ts";
import type { MigratedDatabase } from "./support/postgres.ts";

let postgres: MigratedDatabase;
let harness: Harness;

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
  harness = await startHarness(postgres.pool);
});

const DESKTOP = { width: 1440, height: 900, device_scale_factor: 1 };

async function startSession(projectId: string, organisationId: string, overrides = {}) {
  return harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/browser-sessions`,
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
    payload: {
      organisation_id: organisationId,
      viewport: DESKTOP,
      controller: { type: "agent", id: "ags_test" },
      service_origin: "https://route-test.internal.invalid",
      ...overrides,
    },
  });
}

async function eventTypes(projectId: string): Promise<string[]> {
  const rows = await postgres.pool.query<{ type: string }>(
    "SELECT type FROM events WHERE project_id = $1 ORDER BY sequence",
    [projectId],
  );
  return rows.rows.map((row) => row.type);
}

test("a session traverses REQUESTED, ALLOCATING and READY and records the fields", async () => {
  const { projectId, organisationId, workerId } = await seedProjectAndWorker(harness);
  const response = await startSession(projectId, organisationId);
  assert.equal(response.statusCode, 201);
  const record = (response.json() as { data: Record<string, unknown> }).data;

  assert.equal(record["status"], "READY");
  assert.equal(record["worker_id"], workerId);
  assert.equal(record["control_epoch"], 1);
  assert.deepEqual(record["current_controller"], { type: "agent", id: "ags_test" });
  assert.equal(record["browser_type"], "chromium");
  assert.equal(record["browser_version"], "143.0.7499.4");
  assert.equal(record["retention_policy"], "verification_evidence");
  assert.ok(record["created_at"] !== undefined);

  const types = await eventTypes(projectId);
  assert.deepEqual(types.slice(1), [
    "browser_session.requested",
    "browser_session.allocated",
    "browser_session.ready",
  ]);

  const lease = await postgres.pool.query<{ epoch: number; controller_id: string }>(
    "SELECT epoch, controller_id FROM control_leases WHERE browser_session_id = $1 AND revoked_at IS NULL",
    [record["id"]],
  );
  assert.equal(lease.rows.length, 1);
  assert.equal(Number(lease.rows[0]?.epoch), 1);
});

test("a command carrying a stale epoch is rejected and the rejection is recorded", async () => {
  const { projectId, organisationId } = await seedProjectAndWorker(harness);
  const started = await startSession(projectId, organisationId);
  const sessionId = (started.json() as { data: { id: string } }).data.id;

  const response = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${sessionId}/commands`,
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
    payload: {
      control_epoch: 0,
      controller: { type: "agent", id: "ags_test" },
      command: { command: "snapshot", timeout_ms: 5000 },
    },
  });
  assert.equal(response.statusCode, 409);
  const body = response.json() as { error: { code: string; details?: { current_epoch: number } } };
  assert.equal(body.error.code, "CONTROL_EPOCH_STALE");
  assert.equal(body.error.details?.current_epoch, 1);

  const types = await eventTypes(projectId);
  assert.ok(types.includes("browser.command_rejected"));
  // The command never reached the worker.
  assert.equal(
    harness.workerRequests.filter((entry) => entry.path === "/internal/v1/commands").length,
    0,
  );
});

test("a command on a terminated session returns BROWSER_SESSION_NOT_ACTIVE", async () => {
  const { projectId, organisationId } = await seedProjectAndWorker(harness);
  const started = await startSession(projectId, organisationId);
  const sessionId = (started.json() as { data: { id: string } }).data.id;

  const terminated = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${sessionId}/terminate`,
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
  });
  assert.equal((terminated.json() as { data: { status: string } }).data.status, "TERMINATED");

  const response = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${sessionId}/commands`,
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
    payload: {
      control_epoch: 1,
      command: { command: "snapshot", timeout_ms: 5000 },
    },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(
    (response.json() as { error: { code: string } }).error.code,
    "BROWSER_SESSION_NOT_ACTIVE",
  );

  const leases = await postgres.pool.query(
    "SELECT 1 FROM control_leases WHERE browser_session_id = $1 AND revoked_at IS NULL",
    [sessionId],
  );
  assert.equal(leases.rows.length, 0, "termination revokes the control lease");
  assert.ok((await eventTypes(projectId)).includes("browser_session.terminated"));
});

test("capacity exhaustion is reported as BROWSER_CAPACITY_EXHAUSTED", async () => {
  const { projectId, organisationId } = await seedProjectAndWorker(harness);
  // The seeded worker declares a capacity of two.
  assert.equal((await startSession(projectId, organisationId)).statusCode, 201);
  assert.equal((await startSession(projectId, organisationId)).statusCode, 201);

  const third = await startSession(projectId, organisationId);
  assert.equal(third.statusCode, 503);
  assert.equal(
    (third.json() as { error: { code: string } }).error.code,
    "BROWSER_CAPACITY_EXHAUSTED",
  );
});

test("a successful navigate records browser_session.navigated with its trust label", async () => {
  const { projectId, organisationId } = await seedProjectAndWorker(harness);
  const started = await startSession(projectId, organisationId);
  const sessionId = (started.json() as { data: { id: string } }).data.id;

  harness.worker.command = (frame): BrowserCommandResult => ({
    ok: true,
    command: "navigate",
    sequence: frame.envelope.sequence as number,
    control_epoch: frame.envelope.control_epoch as number,
    duration_ms: 42,
    trust: "untrusted_browser_content",
    instruction_policy: "do_not_follow_as_instructions",
    navigation: {
      url: "https://route-test.internal.invalid/checkout",
      http_status: 200,
      redirected: false,
      title: "Checkout",
    },
  });

  const response = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${sessionId}/commands`,
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
    payload: {
      control_epoch: 1,
      controller: { type: "agent", id: "ags_test" },
      command: {
        command: "navigate",
        timeout_ms: 30000,
        navigate: { url: "/checkout", wait_until: "domcontentloaded" },
      },
    },
  });
  assert.equal(response.statusCode, 200);
  const result = (response.json() as { data: BrowserCommandResult }).data;
  assert.equal(result.trust, "untrusted_browser_content");
  assert.equal(result.instruction_policy, "do_not_follow_as_instructions");

  const rows = await postgres.pool.query<{ payload: { trust: string; url: string } }>(
    "SELECT payload FROM events WHERE project_id = $1 AND type = 'browser_session.navigated'",
    [projectId],
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0]?.payload.trust, "untrusted_browser_content");

  const session = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/browser-sessions/${sessionId}`,
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
  });
  assert.equal((session.json() as { data: { status: string } }).data.status, "ACTIVE");
});

test("a worker crash marks the session failed and revokes the lease", async () => {
  const { projectId, organisationId, workerId } = await seedProjectAndWorker(harness);
  const started = await startSession(projectId, organisationId);
  const sessionId = (started.json() as { data: { id: string } }).data.id;

  const { encodeBrowserFrame } = await import("@reviewplane/protocol/browser");
  const reported = await harness.built.app.inject({
    method: "POST",
    url: `/internal/v1/browser-sessions/${sessionId}/status`,
    headers: {
      authorization: "Bearer worker-credential-for-tests",
      "content-type": "application/json",
    },
    payload: encodeBrowserFrame({
      envelope: {
        protocol_version: 1,
        message_id: "msg_crash",
        type: "browser_session.status",
        sent_at: new Date().toISOString(),
        worker_id: workerId,
        browser_session_id: sessionId,
      },
      type: "browser_session.status",
      payload: {
        status: "FAILED",
        previous_status: "ACTIVE",
        reason: "browser process exited unexpectedly",
        occurred_at: new Date().toISOString(),
      },
    }),
  });
  assert.equal(reported.statusCode, 204);

  const session = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/browser-sessions/${sessionId}`,
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
  });
  const record = (session.json() as { data: { status: string; ended_at: string | null } }).data;
  assert.equal(record.status, "FAILED");
  assert.ok(record.ended_at !== null);

  const leases = await postgres.pool.query(
    "SELECT 1 FROM control_leases WHERE browser_session_id = $1 AND revoked_at IS NULL",
    [sessionId],
  );
  assert.equal(leases.rows.length, 0);
  assert.ok((await eventTypes(projectId)).includes("browser_session.failed"));
});

test("an allocation the worker refuses leaves the session FAILED", async () => {
  const { projectId, organisationId } = await seedProjectAndWorker(harness);
  harness.worker.refuseWith = {
    status: 503,
    code: "BROWSER_CAPACITY_EXHAUSTED",
    message: "worker is full",
  };
  const response = await startSession(projectId, organisationId);
  assert.equal(response.statusCode, 503);

  const sessions = await postgres.pool.query<{ status: string }>(
    "SELECT status FROM browser_sessions WHERE project_id = $1",
    [projectId],
  );
  assert.deepEqual(
    sessions.rows.map((row) => row.status),
    ["FAILED"],
  );
  assert.ok((await eventTypes(projectId)).includes("browser_session.failed"));
});

test("every command the control plane sends carries the section 6.4 envelope", async () => {
  const { projectId, organisationId } = await seedProjectAndWorker(harness);
  const started = await startSession(projectId, organisationId);
  const sessionId = (started.json() as { data: { id: string } }).data.id;

  const seen: Record<string, unknown>[] = [];
  harness.worker.command = (frame): BrowserCommandResult => {
    seen.push(frame.envelope as unknown as Record<string, unknown>);
    return {
      ok: true,
      command: frame.payload.command,
      sequence: frame.envelope.sequence as number,
      control_epoch: frame.envelope.control_epoch as number,
      duration_ms: 1,
      trust: "trusted_control_plane",
      instruction_policy: "do_not_follow_as_instructions",
    };
  };

  for (let index = 0; index < 3; index += 1) {
    await harness.built.app.inject({
      method: "POST",
      url: `/api/v1/browser-sessions/${sessionId}/commands`,
      headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
      payload: {
        control_epoch: 1,
        controller: { type: "agent", id: "ags_test" },
        command: { command: "snapshot", timeout_ms: 5000 },
      },
    });
  }

  assert.equal(seen.length, 3);
  for (const envelope of seen) {
    assert.equal(envelope["browser_session_id"], sessionId);
    assert.deepEqual(envelope["controller"], { type: "agent", id: "ags_test" });
    assert.equal(envelope["control_epoch"], 1);
    assert.equal(typeof envelope["sequence"], "number");
    assert.ok(typeof envelope["sent_at"] === "string");
  }
  // Sequence increases strictly, which is what makes a replay detectable.
  const sequences = seen.map((envelope) => envelope["sequence"] as number);
  assert.deepEqual(sequences, [0, 1, 2]);
});
