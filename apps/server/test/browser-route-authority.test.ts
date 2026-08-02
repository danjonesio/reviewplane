/**
 * The browser-session **routes**, driven over HTTP as a real signed-in human.
 *
 * `browser-authority.test.ts` proves the matrix by calling
 * `BrowserSessionService` directly, which means it supplies the controller and
 * the epoch — the two arguments HTTP never lets a caller choose. That is
 * exactly the gap a defect can live in, and one did: four lifecycle routes read
 * both authority inputs *out of the session record* and passed them to a check
 * that compares them against that same record, so `#requireControl` compared
 * the record to itself and admitted anybody. Every test in the service-level
 * suite still passed with the routes fixed, which is the proof that suite could
 * not see it.
 *
 * So this suite drives the routes, and it authenticates with a real **account**
 * session rather than the bootstrap token. The bootstrap principal has
 * `organisationId: null` and `projectIds: null`, so both tenancy terms in every
 * scoped query go vacuous and a regression dropping one would ship green.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { seedProjectAndWorker, startHarness, type Harness } from "./support/worker-harness.ts";
import { claimSessionFor, type SessionCookies } from "./support/identity.ts";
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

interface Tenant {
  readonly organisationId: string;
  readonly projectId: string;
  readonly cookies: SessionCookies;
}

/** A project, a worker assigned to it, and a signed-in human who owns it. */
async function tenant(email: string): Promise<Tenant> {
  const seeded = await seedProjectAndWorker(harness);
  const cookies = await claimSessionFor(harness.built, postgres.pool, seeded.organisationId, {
    email,
  });
  return { organisationId: seeded.organisationId, projectId: seeded.projectId, cookies };
}

async function startSession(
  owner: Tenant,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; control_epoch: number }> {
  const response = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${owner.projectId}/browser-sessions`,
    headers: owner.cookies.writeHeaders,
    payload: { viewport: DESKTOP, ...overrides },
  });
  assert.equal(response.statusCode, 201, response.body);
  return (response.json() as { data: { id: string; control_epoch: number } }).data;
}

/**
 * A session whose interactive lease belongs to an agent.
 *
 * It goes through the service rather than the HTTP route because that is how
 * the product produces this state: `browser_session_start` supplies the agent
 * controller from the credential behind the MCP connection. The route derives
 * the controller from the caller and refuses one in the body, so a test that
 * set this up over HTTP would be exercising a surface that no longer exists.
 *
 * `agentSessionId` is deliberately not set: it carries a foreign key to
 * `agent_sessions`, so a fabricated one is refused by the database. The
 * controller identity carries no such constraint — which is part of why the
 * route derives it rather than accepting it (ADR-0028).
 */
async function agentHeldSession(
  owner: Tenant,
  agentId = "ags_owner",
): Promise<{ id: string; control_epoch: number }> {
  const record = await harness.built.sessions.start({
    organisationId: owner.organisationId,
    projectId: owner.projectId,
    viewport: DESKTOP,
    controller: { type: "agent", id: agentId },
    retentionClass: "verification_evidence",
    actor: { type: "agent_session", id: agentId },
  });
  return { id: record.id, control_epoch: record.control_epoch };
}

function post(caller: Tenant, path: string, payload: Record<string, unknown> = {}) {
  return harness.built.app.inject({
    method: "POST",
    url: path,
    headers: caller.cookies.writeHeaders,
    payload,
  });
}

async function eventsFor(projectId: string): Promise<Record<string, unknown>[]> {
  const rows = await postgres.pool.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM events WHERE project_id = $1 AND type = 'browser.command_rejected' ORDER BY sequence",
    [projectId],
  );
  return rows.rows.map((row) => row.payload);
}

async function statusOf(id: string): Promise<string> {
  return (await harness.built.sessions.get(id)).status;
}

// ---------------------------------------------------------------------------
// The blocker: a lifecycle route must not read its own authority inputs out of
// the record it is authorising against.
// ---------------------------------------------------------------------------

/**
 * `resume` only applies to a `PAUSED` session, and the state check runs before
 * the lease check, so a resume of a READY session is refused for the wrong
 * reason. The agent that holds the lease pauses it first — which is also the
 * realistic shape: the human is trying to resume a session an agent paused.
 */
const LIFECYCLE: readonly {
  readonly name: string;
  readonly path: string;
  readonly prepare?: (sessionId: string, projectId: string) => Promise<void>;
}[] = [
  { name: "pause", path: "pause" },
  {
    name: "resume",
    path: "resume",
    prepare: async (sessionId, projectId) => {
      await harness.built.sessions.pause({
        browserSessionId: sessionId,
        projectId,
        controller: { type: "agent", id: "ags_owner" },
        controlEpoch: 1,
        actor: { type: "agent_session", id: "ags_owner" },
      });
    },
  },
  { name: "control/release", path: "control/release" },
  { name: "terminate", path: "terminate" },
];

for (const route of LIFECYCLE) {
  test(`${route.name} refuses a human who does not hold the lease, and the session is unchanged`, async () => {
    const owner = await tenant("owner@localhost");
    // The lease belongs to an agent. The human is a member of the project — it
    // is their project — and holds no lease.
    const session = await agentHeldSession(owner);

    await route.prepare?.(session.id, owner.projectId);
    const before = await statusOf(session.id);
    const response = await post(owner, `/api/v1/browser-sessions/${session.id}/${route.path}`, {
      control_epoch: session.control_epoch,
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(
      (response.json() as { error: { code: string } }).error.code,
      "CONTROL_NOT_OWNED",
      response.body,
    );

    const after = await harness.built.sessions.get(session.id);
    assert.equal(after.status, before, "a refused lifecycle act must change nothing");
    assert.deepEqual(after.current_controller, { type: "agent", id: "ags_owner" });
    assert.equal(after.control_epoch, session.control_epoch);
  });

  test(`${route.name} requires control_epoch rather than defaulting to the session's own`, async () => {
    const owner = await tenant("owner@localhost");
    const session = await agentHeldSession(owner);

    // No `control_epoch`. The defect was that the route filled it in from the
    // record, so the epoch check compared the record to itself.
    const response = await post(owner, `/api/v1/browser-sessions/${session.id}/${route.path}`, {});
    assert.equal(response.statusCode, 422, response.body);
    assert.equal(
      (response.json() as { error: { code: string } }).error.code,
      "VALIDATION_FAILED",
      response.body,
    );
    assert.equal(await statusOf(session.id), "READY");
  });

  test(`${route.name} records a browser.command_rejected when it refuses`, async () => {
    const owner = await tenant("owner@localhost");
    const session = await agentHeldSession(owner);

    await route.prepare?.(session.id, owner.projectId);
    const before = (await eventsFor(owner.projectId)).length;
    await post(owner, `/api/v1/browser-sessions/${session.id}/${route.path}`, {
      control_epoch: session.control_epoch,
    });
    const recorded = await eventsFor(owner.projectId);
    assert.equal(
      recorded.length,
      before + 1,
      "a denial with no record is indistinguishable from an attempt that never happened",
    );
    const last = recorded.at(-1) as Record<string, unknown>;
    assert.equal(last["kind"], "lifecycle");
    assert.equal(last["reason"], "control_not_owned");
    assert.equal(last["reason_code"], "CONTROL_NOT_OWNED");
    assert.equal(last["presented_controller_type"], "system");
  });
}

test("the human who started a session holds its lease and may drive its lifecycle", async () => {
  const owner = await tenant("owner@localhost");
  const session = await startSession(owner);

  const paused = await post(owner, `/api/v1/browser-sessions/${session.id}/pause`, {
    control_epoch: session.control_epoch,
  });
  assert.equal(paused.statusCode, 200, paused.body);
  assert.equal((paused.json() as { data: { status: string } }).data.status, "PAUSED");

  const resumed = await post(owner, `/api/v1/browser-sessions/${session.id}/resume`, {
    control_epoch: session.control_epoch,
  });
  assert.equal(resumed.statusCode, 200, resumed.body);
  assert.equal((resumed.json() as { data: { status: string } }).data.status, "READY");

  const ended = await post(owner, `/api/v1/browser-sessions/${session.id}/terminate`, {
    control_epoch: session.control_epoch,
  });
  assert.equal(ended.statusCode, 200, ended.body);
  assert.equal((ended.json() as { data: { status: string } }).data.status, "TERMINATED");
});

test("a pause records the human who paused it, not the controller it displaced", async () => {
  const owner = await tenant("owner@localhost");
  const session = await startSession(owner);
  await post(owner, `/api/v1/browser-sessions/${session.id}/pause`, {
    control_epoch: session.control_epoch,
  });

  const rows = await postgres.pool.query<{ actor_type: string; payload: Record<string, unknown> }>(
    "SELECT actor_type, payload FROM events WHERE project_id = $1 AND type = 'browser_session.paused'",
    [owner.projectId],
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0]?.actor_type, "human_user");
  assert.equal(
    rows.rows[0]?.payload["controller_type"],
    "system",
    "the audit record must name the actor, not whoever held the lease",
  );
});

// ---------------------------------------------------------------------------
// Reclaiming a session somebody else holds
// ---------------------------------------------------------------------------

test("a human reclaims an agent's session through control/request, which moves the epoch", async () => {
  const owner = await tenant("owner@localhost");
  const session = await agentHeldSession(owner);

  const taken = await post(owner, `/api/v1/browser-sessions/${session.id}/control/request`, {
    controller_type: "system",
  });
  assert.equal(taken.statusCode, 200, taken.body);
  const record = (taken.json() as { data: { control_epoch: number } }).data;
  assert.equal(record.control_epoch, session.control_epoch + 1);

  // And now the lifecycle acts the human was refused above succeed.
  const ended = await post(owner, `/api/v1/browser-sessions/${session.id}/terminate`, {
    control_epoch: record.control_epoch,
  });
  assert.equal(ended.statusCode, 200, ended.body);
});

test("control/request does not accept a controller identity from the caller", async () => {
  const owner = await tenant("owner@localhost");
  const session = await agentHeldSession(owner);

  // Planting a lease owned by an identity that does not exist, and revoking the
  // incumbent's as a side effect, was possible until the adversarial pass.
  const planted = await post(owner, `/api/v1/browser-sessions/${session.id}/control/request`, {
    controller_type: "agent",
    controller_id: "ags_not_a_real_session",
  });
  assert.equal(planted.statusCode, 422, planted.body);
  assert.equal(
    (planted.json() as { error: { code: string } }).error.code,
    "VALIDATION_FAILED",
    planted.body,
  );

  const onBehalf = await post(owner, `/api/v1/browser-sessions/${session.id}/control/request`, {
    controller_type: "agent",
  });
  assert.equal(
    (onBehalf.json() as { error: { code: string } }).error.code,
    "AUTHORISATION_DENIED",
    onBehalf.body,
  );

  const after = await harness.built.sessions.get(session.id);
  assert.deepEqual(after.current_controller, { type: "agent", id: "ags_owner" });
  assert.equal(after.control_epoch, session.control_epoch, "a refused request must not move it");
});

// ---------------------------------------------------------------------------
// Tenancy, over HTTP, with both scope terms non-vacuous
// ---------------------------------------------------------------------------

test("starting a session does not accept a controller identity from the caller", async () => {
  const owner = await tenant("owner@localhost");

  // Weaker than the lifecycle case — no session exists yet, so nothing is being
  // seized — and the same shape. A caller could name an identity it is not,
  // and the session's lease would belong to it: the creator would hold no lease
  // on its own session and could not end it without taking control first, while
  // the slot counted against the worker's capacity.
  const planted = await post(owner, `/api/v1/projects/${owner.projectId}/browser-sessions`, {
    viewport: DESKTOP,
    controller: { type: "agent", id: "ags_not_a_real_session" },
  });
  assert.equal(planted.statusCode, 422, planted.body);
  assert.equal(
    (planted.json() as { error: { code: string } }).error.code,
    "VALIDATION_FAILED",
    planted.body,
  );
  const rows = await postgres.pool.query("SELECT 1 FROM browser_sessions");
  assert.equal(rows.rows.length, 0, "a refused start must not create a session");

  // And the session a caller does create is one it controls.
  const session = await startSession(owner);
  const record = await harness.built.sessions.get(session.id);
  assert.equal(record.current_controller?.type, "system");
  const ended = await post(owner, `/api/v1/browser-sessions/${session.id}/terminate`, {
    control_epoch: record.control_epoch,
  });
  assert.equal(ended.statusCode, 200, ended.body);
});

test("another organisation's session is refused with the same bytes an unknown identifier earns", async () => {
  const owner = await tenant("owner@localhost");
  const session = await startSession(owner);
  const stranger = await tenant("stranger@localhost");

  const normalise = (body: string): unknown => {
    const parsed = JSON.parse(body) as { meta?: { request_id?: string } };
    if (parsed.meta !== undefined) parsed.meta.request_id = "req_normalised";
    return parsed;
  };

  const reads: readonly ((id: string) => string)[] = [
    (id) => `/api/v1/browser-sessions/${id}`,
    (id) => `/api/v1/browser-sessions/${id}/timeline`,
  ];
  for (const url of reads) {
    const foreign = await harness.built.app.inject({
      method: "GET",
      url: url(session.id),
      headers: stranger.cookies.readHeaders,
    });
    const unknown = await harness.built.app.inject({
      method: "GET",
      url: url("brs_does_not_exist"),
      headers: stranger.cookies.readHeaders,
    });
    assert.equal(foreign.statusCode, 404, foreign.body);
    assert.equal(unknown.statusCode, 404, unknown.body);
    // The bodies, not the statuses. Wording is as much an existence oracle as a
    // status difference is (`docs/TESTING.md` §10).
    assert.deepEqual(normalise(foreign.body), normalise(unknown.body), url("…"));
  }

  const writes: readonly {
    readonly path: string;
    readonly payload: Record<string, unknown>;
  }[] = [
    {
      path: "commands",
      payload: { control_epoch: 1, command: { command: "snapshot", timeout_ms: 5000 } },
    },
    { path: "terminate", payload: { control_epoch: 1 } },
    { path: "pause", payload: { control_epoch: 1 } },
    { path: "control/release", payload: { control_epoch: 1 } },
  ];
  for (const route of writes) {
    const foreign = await post(
      stranger,
      `/api/v1/browser-sessions/${session.id}/${route.path}`,
      route.payload,
    );
    const unknown = await post(
      stranger,
      `/api/v1/browser-sessions/brs_does_not_exist/${route.path}`,
      route.payload,
    );
    assert.equal(foreign.statusCode, 404, `${route.path}: ${foreign.body}`);
    assert.deepEqual(normalise(foreign.body), normalise(unknown.body), route.path);
  }

  // Nothing the stranger did touched the session, and nothing was written to
  // its owner's timeline.
  assert.equal(await statusOf(session.id), "READY");
  assert.deepEqual(await eventsFor(owner.projectId), []);
});

test("a project-scoped read of another organisation's project is refused", async () => {
  const owner = await tenant("owner@localhost");
  await startSession(owner);
  const stranger = await tenant("stranger@localhost");

  const listed = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/projects/${owner.projectId}/browser-sessions`,
    headers: stranger.cookies.readHeaders,
  });
  assert.equal(listed.statusCode, 404, listed.body);

  const started = await post(stranger, `/api/v1/projects/${owner.projectId}/browser-sessions`, {
    viewport: DESKTOP,
  });
  assert.equal(started.statusCode, 404, started.body);
});

test("a state-changing lifecycle route requires the CSRF token", async () => {
  const owner = await tenant("owner@localhost");
  const session = await startSession(owner);

  // Cookie without the header: the shape a forged cross-origin write has.
  const forged = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${session.id}/pause`,
    headers: owner.cookies.readHeaders,
    payload: { control_epoch: session.control_epoch },
  });
  assert.equal(forged.statusCode, 403, forged.body);
  assert.equal(await statusOf(session.id), "READY");
});
