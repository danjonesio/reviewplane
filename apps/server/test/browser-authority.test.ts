/**
 * The browser-command authorisation matrix, the control lease and the pause
 * gate (`docs/SECURITY.md` sections 7 and 8, ADR-0007, ADR-0028).
 *
 * Every test here asserts **which side refused**. The exit criterion is that a
 * command is authorised "before reaching Chromium", and a worker-side-only
 * refusal produces the right-looking HTTP status while failing that criterion —
 * so `harness.workerRequests` is checked for zero command requests rather than
 * the response status alone.
 *
 * The event assertions read the event store directly rather than inferring an
 * event from the error code that came back. `browser.command_rejected` has no
 * per-type payload schema, so nothing but an assertion against the stored row
 * can catch a denial that refuses correctly and records nothing — which is what
 * every denial except the stale epoch did until RVP-30.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { BOOTSTRAP_TOKEN, seedProjectAndWorker, startHarness, type Harness } from "./support/worker-harness.ts";
import { startMigratedDatabase, truncateAll, type MigratedDatabase } from "./support/postgres.ts";

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
const OPERATOR = { type: "system", id: "sys_bootstrap" } as const;
const AUTH = { authorization: `Bearer ${BOOTSTRAP_TOKEN}` };

async function startSession(projectId: string, overrides: Record<string, unknown> = {}) {
  const response = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/browser-sessions`,
    headers: AUTH,
    payload: { viewport: DESKTOP, ...overrides },
  });
  return response;
}

async function sessionIdFor(projectId: string, overrides: Record<string, unknown> = {}) {
  const response = await startSession(projectId, overrides);
  assert.equal(response.statusCode, 201, response.body);
  return (response.json() as { data: { id: string } }).data.id;
}

/**
 * A session whose interactive lease belongs to an agent.
 *
 * Through the service, because that is how the product produces this state:
 * `browser_session_start` supplies the agent controller from the credential
 * behind the MCP connection.
 *
 * `agentSessionId` is deliberately not set: it carries a foreign key to
 * `agent_sessions`, so a fabricated one is refused by the database. The
 * controller identity carries no such constraint — which is part of why the
 * route derives it rather than accepting it (ADR-0028). The HTTP route derives the controller from the
 * caller and refuses one in the body (ADR-0028), so setting this up over HTTP
 * would exercise a surface that no longer exists.
 */
async function agentHeldSession(
  organisationId: string,
  projectId: string,
  agentId = "ags_owner",
): Promise<string> {
  const record = await harness.built.sessions.start({
    organisationId,
    projectId,
    viewport: DESKTOP,
    controller: { type: "agent", id: agentId },
    retentionClass: "verification_evidence",
    actor: { type: "agent_session", id: agentId },
  });
  return record.id;
}

function commandRequests(): number {
  return harness.workerRequests.filter((entry) => entry.path === "/internal/v1/commands").length;
}

async function rejections(projectId: string): Promise<Record<string, unknown>[]> {
  const rows = await postgres.pool.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM events WHERE project_id = $1 AND type = 'browser.command_rejected' ORDER BY sequence",
    [projectId],
  );
  return rows.rows.map((row) => row.payload);
}

const SNAPSHOT = { command: "snapshot", timeout_ms: 5000 } as const;
const NAVIGATE = {
  command: "navigate",
  timeout_ms: 30000,
  navigate: { url: "/checkout", wait_until: "domcontentloaded" },
} as const;

// ---------------------------------------------------------------------------
// Project scope
// ---------------------------------------------------------------------------

test("a command for a session in another project is refused, is not disclosed, and is recorded on the actor's project", async () => {
  const first = await seedProjectAndWorker(harness);
  const sessionId = await sessionIdFor(first.projectId);
  const second = await seedProjectAndWorker(harness);

  const before = commandRequests();
  await assert.rejects(
    () =>
      harness.built.sessions.runCommand({
        browserSessionId: sessionId,
        projectId: second.projectId,
        controller: OPERATOR,
        controlEpoch: 1,
        command: SNAPSHOT,
        actor: { type: "human_user", display: "stranger" },
      }),
    (error: { code?: string; message?: string }) =>
      error.code === "RESOURCE_NOT_FOUND" && error.message === "The browser session was not found.",
  );
  assert.equal(commandRequests(), before, "the command must not reach the worker");

  // The refusal is the one an unknown identifier earns, word for word: a
  // distinct message would confirm the identifier exists (`docs/API.md` §5).
  await assert.rejects(
    () =>
      harness.built.sessions.runCommand({
        browserSessionId: "brs_does_not_exist",
        projectId: second.projectId,
        controller: OPERATOR,
        controlEpoch: 1,
        command: SNAPSHOT,
        actor: { type: "human_user", display: "stranger" },
      }),
    (error: { code?: string; message?: string }) =>
      error.code === "RESOURCE_NOT_FOUND" && error.message === "The browser session was not found.",
  );

  // Recorded on the *actor's* project, never the session's: writing it to the
  // other project's stream would let a caller with no authority there append
  // rows to a timeline they cannot read.
  const onActorProject = await rejections(second.projectId);
  assert.equal(onActorProject.length, 1);
  assert.equal(onActorProject[0]?.["reason"], "project_mismatch");
  assert.equal(onActorProject[0]?.["cross_project"], true);
  assert.equal(
    onActorProject[0]?.["current_epoch"],
    undefined,
    "a cross-project attempt learns nothing about the session it named",
  );
  assert.deepEqual(await rejections(first.projectId), []);
});

// ---------------------------------------------------------------------------
// Epoch and lease
// ---------------------------------------------------------------------------

test("a stale epoch is refused with the current epoch and recorded, and the command never reaches the worker", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const sessionId = await sessionIdFor(projectId);

  const response = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${sessionId}/commands`,
    headers: AUTH,
    payload: { control_epoch: 0, command: SNAPSHOT },
  });
  assert.equal(response.statusCode, 409);
  const body = response.json() as { error: { code: string; details?: { current_epoch: number } } };
  assert.equal(body.error.code, "CONTROL_EPOCH_STALE");
  assert.equal(body.error.details?.current_epoch, 1);
  assert.equal(commandRequests(), 0);

  const recorded = await rejections(projectId);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.["reason_code"], "CONTROL_EPOCH_STALE");
  assert.equal(recorded[0]?.["reason"], "control_epoch_stale");
  assert.equal(recorded[0]?.["presented_epoch"], 0);
  assert.equal(recorded[0]?.["current_epoch"], 1);
});

test("a controller that does not hold the lease is refused by the control plane, not by the worker", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const sessionId = await sessionIdFor(projectId);

  await assert.rejects(
    () =>
      harness.built.sessions.runCommand({
        browserSessionId: sessionId,
        projectId,
        controller: { type: "agent", id: "ags_someone_else" },
        controlEpoch: 1,
        command: NAVIGATE,
        actor: { type: "agent_session", id: "ags_someone_else" },
      }),
    (error: { code?: string }) => error.code === "CONTROL_NOT_OWNED",
  );
  assert.equal(commandRequests(), 0, "the worker must never see a command it would also refuse");

  const recorded = await rejections(projectId);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.["reason"], "control_not_owned");
  assert.equal(recorded[0]?.["interactive"], true);
});

test("a system capture is admitted without the lease and does not take it", async () => {
  const { projectId, organisationId } = await seedProjectAndWorker(harness);
  // The session's lease belongs to an agent.
  const sessionId = await agentHeldSession(organisationId, projectId);

  const result = await harness.built.sessions.runCommand({
    browserSessionId: sessionId,
    projectId,
    controller: { type: "system", id: "sys_capture" },
    controlEpoch: 1,
    command: SNAPSHOT,
    actor: { type: "system", display: "capture" },
  });
  assert.equal(result.ok, true);
  assert.equal(commandRequests(), 1);

  const after = await harness.built.sessions.get(sessionId);
  assert.deepEqual(after.current_controller, { type: "agent", id: "ags_owner" });
  assert.equal(after.control_epoch, 1, "a system capture never moves the epoch");
  assert.deepEqual(await rejections(projectId), []);
});

test("an interactive command from a system controller that does not hold the lease is refused", async () => {
  const { projectId, organisationId } = await seedProjectAndWorker(harness);
  const sessionId = await agentHeldSession(organisationId, projectId);

  await assert.rejects(
    () =>
      harness.built.sessions.runCommand({
        browserSessionId: sessionId,
        projectId,
        controller: { type: "system", id: "sys_capture" },
        controlEpoch: 1,
        command: NAVIGATE,
        actor: { type: "system", display: "capture" },
      }),
    (error: { code?: string }) => error.code === "CONTROL_NOT_OWNED",
  );
  assert.equal(commandRequests(), 0);
});

// ---------------------------------------------------------------------------
// Control transfer
// ---------------------------------------------------------------------------

test("control transfer increments the epoch, and the previous epoch stops working", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const sessionId = await sessionIdFor(projectId);

  const transferred = await harness.built.sessions.requestControl({
    browserSessionId: sessionId,
    projectId,
    controller: { type: "agent", id: "ags_new" },
    actor: { type: "agent_session", id: "ags_new" },
  });
  assert.equal(transferred.control_epoch, 2);
  assert.deepEqual(transferred.current_controller, { type: "agent", id: "ags_new" });

  const leases = await postgres.pool.query<{ epoch: number; revoked_at: Date | null }>(
    "SELECT epoch, revoked_at FROM control_leases WHERE browser_session_id = $1 ORDER BY epoch",
    [sessionId],
  );
  assert.equal(leases.rows.length, 2);
  assert.ok(leases.rows[0]?.revoked_at !== null, "the superseded lease is revoked");
  assert.equal(leases.rows[1]?.revoked_at, null);

  // The old controller's prepared command now carries a stale epoch.
  await assert.rejects(
    () =>
      harness.built.sessions.runCommand({
        browserSessionId: sessionId,
        projectId,
        controller: OPERATOR,
        controlEpoch: 1,
        command: NAVIGATE,
        actor: { type: "human_user", display: "operator" },
      }),
    (error: { code?: string }) => error.code === "CONTROL_EPOCH_STALE",
  );

  const types = await postgres.pool.query<{ type: string }>(
    "SELECT type FROM events WHERE project_id = $1 ORDER BY sequence",
    [projectId],
  );
  const names = types.rows.map((row) => row.type);
  assert.ok(names.includes("browser.control_requested"));
  assert.ok(names.includes("browser.control_transferred"));
});

test("requesting control the caller already holds is idempotent and does not move the epoch", async () => {
  const { projectId, organisationId } = await seedProjectAndWorker(harness);
  const sessionId = await agentHeldSession(organisationId, projectId);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record = await harness.built.sessions.requestControl({
      browserSessionId: sessionId,
      projectId,
      controller: { type: "agent", id: "ags_owner" },
      actor: { type: "agent_session", id: "ags_owner" },
    });
    assert.equal(record.control_epoch, 1);
  }
  const leases = await postgres.pool.query(
    "SELECT 1 FROM control_leases WHERE browser_session_id = $1",
    [sessionId],
  );
  assert.equal(leases.rows.length, 1);
});

test("releasing control increments the epoch and clears the controller", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const sessionId = await sessionIdFor(projectId);

  const released = await harness.built.sessions.releaseControl({
    browserSessionId: sessionId,
    projectId,
    controller: OPERATOR,
    controlEpoch: 1,
    actor: { type: "human_user", display: "operator" },
  });
  assert.equal(released.control_epoch, 2);
  assert.equal(released.current_controller, null);

  const rows = await postgres.pool.query<{ type: string }>(
    "SELECT type FROM events WHERE project_id = $1 AND type = 'browser.control_released'",
    [projectId],
  );
  assert.equal(rows.rows.length, 1);
});

test("human interactive control is refused with UNSUPPORTED_CAPABILITY and the attempt is audited", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const sessionId = await sessionIdFor(projectId);

  const response = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${sessionId}/control/request`,
    headers: AUTH,
    // No `controller_id`: the control plane derives the identity from the
    // caller, and a body that names one is refused before the capability
    // refusal is reached.
    payload: { controller_type: "human" },
  });
  assert.equal((response.json() as { error: { code: string } }).error.code, "UNSUPPORTED_CAPABILITY");

  const rows = await postgres.pool.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM events WHERE project_id = $1 AND type = 'browser.control_requested'",
    [projectId],
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0]?.payload["granted"], false);
  assert.equal(rows.rows[0]?.payload["reason_code"], "UNSUPPORTED_CAPABILITY");

  const session = await harness.built.sessions.get(sessionId);
  assert.equal(session.control_epoch, 1, "a refused request must not move the epoch");
});

// ---------------------------------------------------------------------------
// Pause
// ---------------------------------------------------------------------------

test("a paused session refuses interactive commands and still admits system capture", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const sessionId = await sessionIdFor(projectId);

  const paused = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${sessionId}/pause`,
    headers: AUTH,
    payload: { control_epoch: 1 },
  });
  assert.equal((paused.json() as { data: { status: string } }).data.status, "PAUSED");

  const refused = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${sessionId}/commands`,
    headers: AUTH,
    payload: { control_epoch: 1, command: NAVIGATE },
  });
  const refusal = refused.json() as {
    error: { code: string; details?: { browser_session_status?: string } };
  };
  assert.equal(refusal.error.code, "BROWSER_SESSION_NOT_ACTIVE");
  // The detail is under the name `error_details` declares. A member the schema
  // does not declare is dropped on the way to an agent, so a detail named
  // anything else is a detail nobody receives.
  assert.equal(refusal.error.details?.browser_session_status, "PAUSED");
  assert.equal(commandRequests(), 0);
  const recorded = await rejections(projectId);
  assert.equal(recorded.at(-1)?.["reason"], "session_paused");

  // A non-interactive capture continues (`docs/MCP_SPEC.md` section 7.3).
  const captured = await harness.built.sessions.runCommand({
    browserSessionId: sessionId,
    projectId,
    controller: { type: "system", id: "sys_capture" },
    controlEpoch: 1,
    command: SNAPSHOT,
    actor: { type: "system", display: "capture" },
  });
  assert.equal(captured.ok, true);
  assert.equal(commandRequests(), 1);

  const resumed = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${sessionId}/resume`,
    headers: AUTH,
    payload: { control_epoch: 1 },
  });
  assert.equal((resumed.json() as { data: { status: string } }).data.status, "READY");

  const types = await postgres.pool.query<{ type: string }>(
    "SELECT type FROM events WHERE project_id = $1 ORDER BY sequence",
    [projectId],
  );
  const names = types.rows.map((row) => row.type);
  assert.ok(names.includes("browser_session.paused"));
  assert.ok(names.includes("browser_session.resumed"));
});

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

test("browser_type refuses a value that looks like secret material, and the refusal never carries the value", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const sessionId = await sessionIdFor(projectId);
  const secret = "rpa_ZXhhbXBsZWFnZW50dG9rZW52YWx1ZQ";

  const response = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${sessionId}/commands`,
    headers: AUTH,
    payload: {
      control_epoch: 1,
      command: {
        command: "type_text",
        timeout_ms: 5000,
        type_text: { snapshot_id: "bsn_one", ref: "e4", text: secret },
      },
    },
  });
  assert.equal((response.json() as { error: { code: string } }).error.code, "POLICY_DENIED");
  assert.equal(commandRequests(), 0);
  assert.ok(!response.body.includes(secret), "the refusal must not echo the value");

  const recorded = await rejections(projectId);
  assert.equal(recorded.at(-1)?.["reason"], "secret_material_refused");
  const serialised = JSON.stringify(recorded);
  assert.ok(!serialised.includes(secret), "the event must not carry the value");
});

test("an ordinary value is typed", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const sessionId = await sessionIdFor(projectId);

  const response = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${sessionId}/commands`,
    headers: AUTH,
    payload: {
      control_epoch: 1,
      command: {
        command: "type_text",
        timeout_ms: 5000,
        type_text: { snapshot_id: "bsn_one", ref: "e4", text: "a refurbished laptop" },
      },
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(commandRequests(), 1);
});

// ---------------------------------------------------------------------------
// Route association
// ---------------------------------------------------------------------------

test("a navigation is refused once the route no longer authorises the session", async () => {
  const { projectId, organisationId, connectorId, workspaceId } =
    await seedProjectAndWorker(harness);
  const sessionId = await sessionIdFor(projectId, { allocate: false });

  await postgres.pool.query(
    `INSERT INTO published_services (
        id, organisation_id, project_id, connector_id, workspace_id, public_alias,
        local_host, local_port, protocol, allowed_browser_session_ids, expires_at, status, ready_at)
     VALUES ($1, $2, $3, $4, $5, $6, '127.0.0.1', 4321, 'http', ARRAY[$7]::text[],
             now() + interval '1 hour', 'ready', now())`,
    ["svc_route_test", organisationId, projectId, connectorId, workspaceId, "alias-route-test", sessionId],
  );
  await postgres.pool.query(
    "UPDATE browser_sessions SET published_service_id = $2, service_origin = $3, status = 'READY' WHERE id = $1",
    [sessionId, "svc_route_test", "https://alias-route-test.internal.invalid"],
  );

  const allowed = await harness.built.sessions.runCommand({
    browserSessionId: sessionId,
    projectId,
    controller: OPERATOR,
    controlEpoch: 1,
    command: NAVIGATE,
    actor: { type: "human_user", display: "operator" },
  });
  assert.equal(allowed.ok, true);

  // The route is revoked. The worker's egress policy was fixed when its context
  // was created and cannot see this; only the control plane can.
  await postgres.pool.query(
    "UPDATE published_services SET status = 'revoked', ended_at = now() WHERE id = $1",
    ["svc_route_test"],
  );

  const before = commandRequests();
  await assert.rejects(
    () =>
      harness.built.sessions.runCommand({
        browserSessionId: sessionId,
        projectId,
        controller: OPERATOR,
        controlEpoch: 1,
        command: NAVIGATE,
        actor: { type: "human_user", display: "operator" },
      }),
    (error: { code?: string }) => error.code === "AUTHORISATION_DENIED",
  );
  assert.equal(commandRequests(), before, "the navigation must not reach the worker");
  assert.equal((await rejections(projectId)).at(-1)?.["reason"], "route_not_associated");

  // A capture is unaffected: it does not reach the network.
  const captured = await harness.built.sessions.runCommand({
    browserSessionId: sessionId,
    projectId,
    controller: { type: "system", id: "sys_capture" },
    controlEpoch: 1,
    command: SNAPSHOT,
    actor: { type: "system", display: "capture" },
  });
  assert.equal(captured.ok, true);
});

// ---------------------------------------------------------------------------
// Audit completeness
// ---------------------------------------------------------------------------

test("a command against a terminated session is refused and recorded", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const sessionId = await sessionIdFor(projectId);
  const ended = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${sessionId}/terminate`,
    headers: AUTH,
    payload: { control_epoch: 1 },
  });
  assert.equal(ended.statusCode, 200, ended.body);

  const response = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${sessionId}/commands`,
    headers: AUTH,
    payload: { control_epoch: 1, command: SNAPSHOT },
  });
  assert.equal(
    (response.json() as { error: { code: string } }).error.code,
    "BROWSER_SESSION_NOT_ACTIVE",
  );
  const recorded = await rejections(projectId);
  assert.equal(recorded.length, 1, "a denial that records nothing is the defect this asserts against");
  assert.equal(recorded[0]?.["reason"], "session_not_active");
  assert.equal(recorded[0]?.["session_status"], "TERMINATED");
});

test("a controller supplied in the command body is refused rather than honoured", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const sessionId = await sessionIdFor(projectId);

  const response = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${sessionId}/commands`,
    headers: AUTH,
    payload: {
      control_epoch: 1,
      controller: { type: "agent", id: "ags_impersonated" },
      command: SNAPSHOT,
    },
  });
  assert.equal(response.statusCode, 422);
  assert.equal((response.json() as { error: { code: string } }).error.code, "VALIDATION_FAILED");
  assert.equal(commandRequests(), 0);
});

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

test("the timeline returns the session's events newest first", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const sessionId = await sessionIdFor(projectId);

  const response = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/browser-sessions/${sessionId}/timeline`,
    headers: AUTH,
  });
  assert.equal(response.statusCode, 200);
  const entries = (response.json() as { data: { type: string }[] }).data;
  assert.ok(entries.length >= 3);
  assert.equal(entries[0]?.type, "browser_session.ready");
  assert.ok(entries.some((entry) => entry.type === "browser_session.requested"));
});

// ---------------------------------------------------------------------------
// Refused allocation and controller-aware termination
// ---------------------------------------------------------------------------

test("an allocation refused before the worker is contacted does not keep holding a browser slot", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  // The seeded worker declares a capacity of two, so four refused starts used to
  // be enough to make the project unable to start any session at all: a
  // REQUESTED row with ended_at IS NULL is exactly what the capacity query
  // counts.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const refused = await startSession(projectId, { published_service_id: "svc_does_not_exist" });
    assert.notEqual(refused.statusCode, 201, refused.body);
  }

  const held = await postgres.pool.query<{ count: string }>(
    `SELECT count(*) AS count FROM browser_sessions
      WHERE project_id = $1 AND ended_at IS NULL AND status NOT IN ('TERMINATED', 'FAILED')`,
    [projectId],
  );
  assert.equal(Number(held.rows[0]?.count), 0, "a refusal must not consume the resource it refused");

  // And the project can still start a session.
  assert.equal((await startSession(projectId)).statusCode, 201);
});

test("ending a session with a superseded epoch is refused and the session survives", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const sessionId = await sessionIdFor(projectId);
  await harness.built.sessions.requestControl({
    browserSessionId: sessionId,
    projectId,
    controller: { type: "agent", id: "ags_new" },
    actor: { type: "agent_session", id: "ags_new" },
  });

  await assert.rejects(
    () =>
      harness.built.sessions.end({
        browserSessionId: sessionId,
        projectId,
        controller: OPERATOR,
        controlEpoch: 1,
        reason: "requested",
        actor: { type: "human_user", display: "operator" },
      }),
    (error: { code?: string }) => error.code === "CONTROL_EPOCH_STALE",
  );
  const record = await harness.built.sessions.get(sessionId);
  assert.notEqual(record.status, "TERMINATED");
  assert.equal(record.ended_at, null);
});

test("ending a session as a controller that does not hold the lease is refused", async () => {
  const { projectId, organisationId } = await seedProjectAndWorker(harness);
  const sessionId = await agentHeldSession(organisationId, projectId);

  await assert.rejects(
    () =>
      harness.built.sessions.end({
        browserSessionId: sessionId,
        projectId,
        controller: { type: "agent", id: "ags_intruder" },
        controlEpoch: 1,
        reason: "requested",
        actor: { type: "agent_session", id: "ags_intruder" },
      }),
    (error: { code?: string }) => error.code === "CONTROL_NOT_OWNED",
  );
  assert.notEqual((await harness.built.sessions.get(sessionId)).status, "TERMINATED");
});
