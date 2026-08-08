/**
 * The standing **stale-command and control-epoch gate** (RVP-96, `docs/TESTING.md`
 * sections 5 and 10, `docs/SECURITY.md` section 8, ADR-0007).
 *
 * `docs/TESTING.md` section 16 makes "stale control commands are accepted" a
 * release-blocking condition. This file is that condition's owner, and it is
 * shaped by what made the condition unowned for so long.
 *
 * **Every assertion here is made over HTTP, with the epoch supplied by the
 * caller.** That is the entire point. `browser-authority.test.ts` proves the
 * same matrix by calling `BrowserSessionService` directly, which means the test
 * chooses the controller and the epoch — the two arguments an HTTP caller never
 * gets to choose. A defect lived in exactly that gap: four lifecycle routes read
 * both authority inputs *out of the session record they were about to
 * authorise*, so the check compared the record to itself and admitted anybody,
 * and all 27 service-level tests passed either way (RVP-30). The generalised
 * rule, which this file exists to keep true:
 *
 *   **never source an authority input from the record being authorised.**
 *
 * Two callers are needed to state the property at all. A single caller can only
 * ever present the epoch it was just handed, so "the epoch moved and the old one
 * stopped working" is unobservable. So this suite signs in **two ordinary
 * organisation-wide humans in one project** — the shape every real sign-in
 * issues, `projectIds: null` with a real `organisationId` — and has the second
 * take control. Everything the first had prepared is then stale, which is the
 * situation the epoch exists for.
 *
 * The refusal is asserted three ways over, because each catches something the
 * others do not:
 *
 *   * the **status and code**, which a caller acts on;
 *   * `harness.workerRequests`, because `docs/SECURITY.md` section 7 requires the
 *     command to be refused *before it reaches Chromium* — a worker-side refusal
 *     produces the same HTTP status while failing that requirement;
 *   * the **stored event**, because `browser.command_rejected` has no per-type
 *     payload schema, so a denial that refuses correctly and records nothing
 *     would otherwise pass.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { seedProjectAndWorker, startHarness, type Harness } from "./support/worker-harness.ts";
import { claimSessionFor, type SessionCookies } from "./support/identity.ts";
import { startMigratedDatabase, truncateAll, type MigratedDatabase } from "./support/postgres.ts";
import { registeredRoutes, routeKey } from "./support/routes.ts";

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

/**
 * A **system capture**: `SYSTEM_CAPTURE_COMMANDS` in the browser protocol.
 *
 * A `system` controller may issue one without holding the interactive lease,
 * and issuing one never transfers or revokes it (`docs/TESTING.md` section 5).
 * It is used for the epoch cases below on purpose: the epoch is compared
 * *before* lease ownership, so a capture that bypasses the lease entirely must
 * still be refused when the epoch has moved. That is the harder half of the
 * property, and a matrix that only ever presented interactive commands would
 * not state it.
 */
const SNAPSHOT = { command: "snapshot", timeout_ms: 5000 } as const;

/**
 * An **interactive** command: `INTERACTIVE_COMMANDS` in the browser protocol.
 *
 * Needed wherever the assertion is about the *lease* rather than the epoch,
 * because a capture is admitted without it by design.
 */
const TYPE_TEXT = {
  command: "type_text",
  timeout_ms: 5000,
  type_text: { snapshot_id: "bsn_one", ref: "e4", text: "a refurbished laptop" },
} as const;

interface Human {
  readonly cookies: SessionCookies;
}

interface Project {
  readonly organisationId: string;
  readonly projectId: string;
  /** The human who starts the session and is later displaced. */
  readonly first: Human;
  /** The human who takes control, making the first one's epoch stale. */
  readonly second: Human;
}

/**
 * One project with **two** signed-in organisation-wide humans.
 *
 * Both are real sign-ins through `POST /api/v1/auth/bootstrap`, so both carry a
 * real `organisationId`, a real CSRF token and `projectIds: null`. Two are
 * needed because the routes derive the controller identity from the caller
 * (ADR-0028): a second controller cannot be conjured by a second request from
 * the same session, and one that was named in a body would be testing a surface
 * the product refuses.
 */
async function projectWithTwoHumans(): Promise<Project> {
  const seeded = await seedProjectAndWorker(harness);
  const first = await claimSessionFor(harness.built, postgres.pool, seeded.organisationId, {
    email: "first@localhost",
  });
  const second = await claimSessionFor(harness.built, postgres.pool, seeded.organisationId, {
    email: "second@localhost",
  });
  return {
    organisationId: seeded.organisationId,
    projectId: seeded.projectId,
    first: { cookies: first },
    second: { cookies: second },
  };
}

function post(who: Human, path: string, payload: Record<string, unknown> = {}) {
  return harness.built.app.inject({
    method: "POST",
    url: path,
    headers: who.cookies.writeHeaders,
    payload,
  });
}

async function startSession(owner: Human, projectId: string) {
  const response = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/browser-sessions`,
    headers: owner.cookies.writeHeaders,
    payload: { viewport: DESKTOP },
  });
  assert.equal(response.statusCode, 201, response.body);
  return (response.json() as { data: { id: string; control_epoch: number } }).data;
}

/** How many command requests the control plane has made to the worker. */
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

interface SessionState {
  readonly status: string;
  readonly epoch: number;
  readonly controller: { type: string; id: string } | null;
}

async function stateOf(sessionId: string): Promise<SessionState> {
  const record = await harness.built.sessions.get(sessionId);
  return {
    status: record.status,
    epoch: record.control_epoch,
    controller: record.current_controller as SessionState["controller"],
  };
}

function code(body: string): string {
  return (JSON.parse(body) as { error: { code: string } }).error.code;
}

function currentEpochDetail(body: string): unknown {
  return (JSON.parse(body) as { error: { details?: { current_epoch?: unknown } } }).error.details
    ?.current_epoch;
}

/**
 * Every lifecycle act a caller reaches over HTTP that takes an epoch.
 *
 * `prepare` runs as the **new** controller, so the session is in the status the
 * act requires before the stale caller tries it. `#requireControl` checks the
 * status before the epoch, so a `resume` of a `READY` session would be refused
 * with `BROWSER_SESSION_NOT_ACTIVE` and prove nothing about the epoch.
 */
const EPOCH_ROUTES: readonly {
  readonly name: string;
  readonly path: string;
  readonly payload?: Record<string, unknown>;
  readonly prepare?: (holder: Human, sessionId: string, epoch: number) => Promise<void>;
  /** The status the session must still be in after the stale act is refused. */
  readonly statusAfter: string;
}[] = [
  { name: "commands", path: "commands", payload: { command: SNAPSHOT }, statusAfter: "READY" },
  { name: "pause", path: "pause", statusAfter: "READY" },
  {
    name: "resume",
    path: "resume",
    statusAfter: "PAUSED",
    prepare: async (holder, sessionId, epoch) => {
      const paused = await post(holder, `/api/v1/browser-sessions/${sessionId}/pause`, {
        control_epoch: epoch,
      });
      assert.equal(paused.statusCode, 200, paused.body);
    },
  },
  { name: "control/release", path: "control/release", statusAfter: "READY" },
  { name: "terminate", path: "terminate", statusAfter: "READY" },
];

/**
 * Session routes that deliberately take no epoch, and why.
 *
 * The matrix above is a list, and a list of routes is exactly the thing that
 * falls behind the routes. The test below reconciles it against the server's
 * own route table, so a lifecycle route added later is either gated here or
 * refused an exemption rather than simply absent.
 *
 * **Two things this is not.** It is not the failure RVP-30 was: that was four
 * *existing* routes reading the epoch out of the record they were authorising,
 * not a new route going unlisted, and the matrix above is what holds that. And
 * it is not the first check a new session route trips — the isolation gate's
 * route coverage already fails on one, because every route taking a path
 * parameter must be probed for tenancy or exempted there (verified: adding
 * `POST .../reset` fails that gate too).
 *
 * What this asks is the question that gate does not. Once somebody satisfies
 * the isolation gate by adding the new route to its probe list, nothing else
 * goes on to ask whether the route takes an epoch — so a route can be fully
 * covered for tenancy and completely ungated for staleness. That gap is this
 * test's whole subject, and it is narrower than "a lifecycle route nobody
 * checks".
 */
const NO_EPOCH: Readonly<Record<string, string>> = {
  "GET /api/v1/browser-sessions/:sessionId": "a read; it changes nothing and holds no lease",
  "GET /api/v1/browser-sessions/:sessionId/timeline": "the same",
  "POST /api/v1/browser-sessions/:sessionId/allocate":
    "binds a session to a route before any controller acts, so there is no epoch yet to be stale against; its authority is the caller's project scope, which apps/server/test/allocation-authority.test.ts covers",
  "POST /api/v1/browser-sessions/:sessionId/control/request":
    "this is how an epoch is *acquired*. Requiring the caller to present the current one would make taking control from a stale reader impossible, which is the situation control/request exists for",
};

test("every browser-session route either takes an epoch or is recorded as not needing one", async () => {
  // Read from Fastify's table rather than listed, so a lifecycle route added
  // under this prefix by anybody is in scope. A route in neither set fails,
  // and a name in either set that the server does not register fails too — an
  // exemption for a route that no longer exists is a decision about nothing.
  const registered = registeredRoutes(harness.built.app.printRoutes({ commonPrefix: false })).filter(
    (route) => route.route.startsWith("/api/v1/browser-sessions/:sessionId"),
  );
  assert.ok(
    registered.length >= 9,
    `the route table parsed to ${String(registered.length)} session routes`,
  );

  const gated = new Set(
    EPOCH_ROUTES.map((route) => `POST /api/v1/browser-sessions/:sessionId/${route.path}`),
  );
  const exempt = new Set(Object.keys(NO_EPOCH));

  const unexamined = registered
    .map(routeKey)
    .filter((key) => !gated.has(key) && !exempt.has(key))
    .sort();
  assert.deepEqual(
    unexamined,
    [],
    `these browser-session routes are neither gated here nor recorded as taking no epoch. ` +
      `A lifecycle route that nobody checks for a stale epoch is how RVP-30 got in:\n  ` +
      unexamined.join("\n  "),
  );

  const known = new Set(registered.map(routeKey));
  const phantom = [...gated, ...exempt].filter((key) => !known.has(key)).sort();
  assert.deepEqual(
    phantom,
    [],
    `these are named here and this server registers no such route:\n  ${phantom.join("\n  ")}`,
  );
});

// ---------------------------------------------------------------------------
// The gate: a superseded epoch is refused on every route that takes one
// ---------------------------------------------------------------------------

for (const route of EPOCH_ROUTES) {
  test(`${route.name} refuses an epoch a control transfer superseded, before the worker sees it`, async () => {
    const project = await projectWithTwoHumans();
    const session = await startSession(project.first, project.projectId);
    assert.equal(session.control_epoch, 1);

    // The second human takes control. This is the only thing that makes the
    // first one's epoch stale, and it is done over HTTP as the product does it.
    const taken = await post(
      project.second,
      `/api/v1/browser-sessions/${session.id}/control/request`,
      { controller_type: "system" },
    );
    assert.equal(taken.statusCode, 200, taken.body);
    const held = (taken.json() as { data: { control_epoch: number } }).data.control_epoch;
    assert.equal(held, 2, "a transfer must increment the epoch");

    await route.prepare?.(project.second, session.id, held);

    const before = await stateOf(session.id);
    const commandsBefore = commandRequests();
    const rejectionsBefore = (await rejections(project.projectId)).length;

    // The first human's prepared act, carrying the epoch it was handed when it
    // started the session. Nothing about the request is malformed; it is simply
    // no longer current.
    const refused = await post(project.first, `/api/v1/browser-sessions/${session.id}/${route.path}`, {
      control_epoch: session.control_epoch,
      ...(route.payload ?? {}),
    });

    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(code(refused.body), "CONTROL_EPOCH_STALE", refused.body);
    // The refusal tells the caller what the epoch now is, which is what lets a
    // well-behaved client refresh and retry rather than guess.
    assert.equal(currentEpochDetail(refused.body), held, refused.body);

    // Refused by the control plane, not by the worker. `docs/SECURITY.md`
    // section 7 requires the command to be authorised before it reaches
    // Chromium, and a worker-side refusal produces this same status.
    assert.equal(
      commandRequests(),
      commandsBefore,
      "a stale command must not reach the worker at all",
    );

    // Nothing moved.
    assert.deepEqual(await stateOf(session.id), before);
    assert.equal(before.status, route.statusAfter);
    assert.equal(before.epoch, held, "a refused act must not move the epoch");

    // And it was recorded. `browser.command_rejected` has no per-type payload
    // schema, so only a read of the stored row can catch a denial that refuses
    // correctly and records nothing.
    const recorded = await rejections(project.projectId);
    assert.equal(
      recorded.length,
      rejectionsBefore + 1,
      "a denial with no record is indistinguishable from an attempt that never happened",
    );
    const last = recorded.at(-1) as Record<string, unknown>;
    assert.equal(last["reason_code"], "CONTROL_EPOCH_STALE");
    assert.equal(last["reason"], "control_epoch_stale");
    assert.equal(last["presented_epoch"], session.control_epoch);
    assert.equal(last["current_epoch"], held);
  });

  test(`${route.name} refuses an epoch ahead of the session's as firmly as one behind it`, async () => {
    // The check is equality, not "at least". A `>=` comparison would pass every
    // stale command that guessed high, and a caller that has to guess is a
    // caller that will eventually guess right.
    const project = await projectWithTwoHumans();
    const session = await startSession(project.first, project.projectId);
    await route.prepare?.(project.first, session.id, session.control_epoch);

    const before = await stateOf(session.id);
    const refused = await post(project.first, `/api/v1/browser-sessions/${session.id}/${route.path}`, {
      control_epoch: session.control_epoch + 7,
      ...(route.payload ?? {}),
    });
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(code(refused.body), "CONTROL_EPOCH_STALE", refused.body);
    assert.deepEqual(await stateOf(session.id), before);
  });

  test(`${route.name} requires the caller to supply the epoch rather than reading the session's`, async () => {
    // The RVP-30 defect exactly: the route filled the epoch in from the record
    // it was about to authorise, so `#requireControl` compared the record to
    // itself. A body with no epoch must be refused, never completed.
    const project = await projectWithTwoHumans();
    const session = await startSession(project.first, project.projectId);
    await route.prepare?.(project.first, session.id, session.control_epoch);

    const before = await stateOf(session.id);
    const refused = await post(
      project.first,
      `/api/v1/browser-sessions/${session.id}/${route.path}`,
      route.payload ?? {},
    );
    assert.equal(refused.statusCode, 422, refused.body);
    assert.equal(code(refused.body), "VALIDATION_FAILED", refused.body);
    assert.deepEqual(await stateOf(session.id), before);
  });
}

// ---------------------------------------------------------------------------
// The epoch itself: monotonic, and one holder at a time
// ---------------------------------------------------------------------------

test("the epoch increases strictly, and no lease ever exists at an epoch the session does not carry", async () => {
  const project = await projectWithTwoHumans();
  const session = await startSession(project.first, project.projectId);

  const seen = [session.control_epoch];
  // Six alternating takeovers. Each is a transfer between two distinct
  // controller identities, because each human's controller is derived from its
  // own viewer session (`sys_<viewerSessionId>`).
  for (let round = 0; round < 6; round += 1) {
    const who = round % 2 === 0 ? project.second : project.first;
    const taken = await post(who, `/api/v1/browser-sessions/${session.id}/control/request`, {
      controller_type: "system",
    });
    assert.equal(taken.statusCode, 200, taken.body);
    seen.push((taken.json() as { data: { control_epoch: number } }).data.control_epoch);
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7], "every transfer increments by exactly one");

  // ADR-0007's mechanism is that the lease and the epoch move in one
  // transaction, so a lease can never be readable at an epoch the session is
  // not at. Exactly one lease is live, and it is at the session's epoch.
  const leases = await postgres.pool.query<{ epoch: number; revoked_at: Date | null }>(
    "SELECT epoch, revoked_at FROM control_leases WHERE browser_session_id = $1 ORDER BY epoch",
    [session.id],
  );
  assert.deepEqual(
    leases.rows.map((row) => row.epoch),
    seen,
  );
  const live = leases.rows.filter((row) => row.revoked_at === null);
  assert.equal(live.length, 1, "exactly one lease is live");
  assert.equal(live[0]?.epoch, seen.at(-1));
  assert.equal((await stateOf(session.id)).epoch, seen.at(-1));
});

test("two humans cannot both hold the lease: the displaced one is refused at the current epoch too", async () => {
  const project = await projectWithTwoHumans();
  const session = await startSession(project.first, project.projectId);

  const taken = await post(project.second, `/api/v1/browser-sessions/${session.id}/control/request`, {
    controller_type: "system",
  });
  const held = (taken.json() as { data: { control_epoch: number } }).data.control_epoch;

  // Presenting the *correct* current epoch is not enough. The epoch says "the
  // world has not moved since I read it"; the lease says "and it is mine".
  // Without the second check, a displaced caller that simply refreshed would
  // drive a session somebody else controls.
  const refused = await post(project.first, `/api/v1/browser-sessions/${session.id}/commands`, {
    control_epoch: held,
    command: TYPE_TEXT,
  });
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(code(refused.body), "CONTROL_NOT_OWNED", refused.body);
  assert.equal(commandRequests(), 0, "the worker must never see a command it would also refuse");

  // The holder, at the same epoch, is admitted — so the refusal above is about
  // who is asking and not about the session being unusable.
  const allowed = await post(project.second, `/api/v1/browser-sessions/${session.id}/commands`, {
    control_epoch: held,
    command: TYPE_TEXT,
  });
  assert.equal(allowed.statusCode, 200, allowed.body);
  assert.equal(commandRequests(), 1);
});

test("a system capture from a controller without the lease is admitted and does not steal it", async () => {
  // `docs/TESTING.md` section 5: "System screenshot does not steal interactive
  // lease." It is stated here rather than left implicit because it is the one
  // asymmetry in the matrix, and a gate whose reader does not know about it
  // would read the test above as proving more than it does. A capture bypasses
  // the lease **and nothing else** — it is still subject to the epoch, which is
  // the case the loop above covers.
  const project = await projectWithTwoHumans();
  const session = await startSession(project.first, project.projectId);
  const taken = await post(project.second, `/api/v1/browser-sessions/${session.id}/control/request`, {
    controller_type: "system",
  });
  const held = (taken.json() as { data: { control_epoch: number } }).data.control_epoch;
  const holder = (await stateOf(session.id)).controller;

  const captured = await post(project.first, `/api/v1/browser-sessions/${session.id}/commands`, {
    control_epoch: held,
    command: SNAPSHOT,
  });
  assert.equal(captured.statusCode, 200, captured.body);

  const after = await stateOf(session.id);
  assert.deepEqual(after.controller, holder, "a capture must not transfer the lease");
  assert.equal(after.epoch, held, "a capture must not move the epoch");
  const live = await postgres.pool.query(
    "SELECT 1 FROM control_leases WHERE browser_session_id = $1 AND revoked_at IS NULL",
    [session.id],
  );
  assert.equal(live.rows.length, 1);
});

test("a controller identity in the body is refused rather than honoured", async () => {
  // The other half of "never source an authority input from the record being
  // authorised": do not source it from the request either. A body-supplied
  // controller is a claim about the actor rather than the actor, and naming the
  // incumbent would satisfy the ownership check by assertion (ADR-0028).
  const project = await projectWithTwoHumans();
  const session = await startSession(project.first, project.projectId);
  const taken = await post(project.second, `/api/v1/browser-sessions/${session.id}/control/request`, {
    controller_type: "system",
  });
  const held = (taken.json() as { data: { control_epoch: number } }).data.control_epoch;
  const holder = (await stateOf(session.id)).controller;
  assert.ok(holder !== null);

  const impersonated = await post(project.first, `/api/v1/browser-sessions/${session.id}/commands`, {
    control_epoch: held,
    controller: holder,
    command: SNAPSHOT,
  });
  assert.equal(impersonated.statusCode, 422, impersonated.body);
  assert.equal(code(impersonated.body), "VALIDATION_FAILED", impersonated.body);
  assert.equal(commandRequests(), 0);
  assert.deepEqual((await stateOf(session.id)).controller, holder);
});

test("re-requesting control the caller already holds does not move the epoch", async () => {
  // `docs/TESTING.md` section 5 requires duplicate control commands to be
  // idempotent. An increment here would invalidate every command the caller had
  // already prepared, which is the opposite of what the epoch is for.
  const project = await projectWithTwoHumans();
  const session = await startSession(project.first, project.projectId);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const again = await post(project.first, `/api/v1/browser-sessions/${session.id}/control/request`, {
      controller_type: "system",
    });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal((again.json() as { data: { control_epoch: number } }).data.control_epoch, 1);
  }
  const leases = await postgres.pool.query(
    "SELECT 1 FROM control_leases WHERE browser_session_id = $1",
    [session.id],
  );
  assert.equal(leases.rows.length, 1);

  // And the epoch the caller has been holding all along still works.
  const allowed = await post(project.first, `/api/v1/browser-sessions/${session.id}/commands`, {
    control_epoch: 1,
    command: SNAPSHOT,
  });
  assert.equal(allowed.statusCode, 200, allowed.body);
});

test("a release moves the epoch, so the released epoch stops working", async () => {
  // Release increments too. After a release nobody holds the lease, so the
  // ownership check no longer refuses anything — and a command still carrying
  // the released epoch would pass it. `docs/SECURITY.md` section 8 requires the
  // increment for exactly this reason.
  const project = await projectWithTwoHumans();
  const session = await startSession(project.first, project.projectId);

  const released = await post(
    project.first,
    `/api/v1/browser-sessions/${session.id}/control/release`,
    { control_epoch: session.control_epoch },
  );
  assert.equal(released.statusCode, 200, released.body);
  const after = await stateOf(session.id);
  assert.equal(after.controller, null);
  assert.equal(after.epoch, session.control_epoch + 1);

  const stale = await post(project.first, `/api/v1/browser-sessions/${session.id}/commands`, {
    control_epoch: session.control_epoch,
    command: SNAPSHOT,
  });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(code(stale.body), "CONTROL_EPOCH_STALE", stale.body);
  assert.equal(commandRequests(), 0);
});

test("a stale command from another organisation is refused as not found, and learns nothing about the epoch", async () => {
  // The two guards compose in the right order. A caller outside the session's
  // tenancy must not be told `CONTROL_EPOCH_STALE`, because that answer confirms
  // the session exists and reports its epoch — an oracle over another
  // organisation's identifiers (`docs/TESTING.md` section 10).
  const owner = await projectWithTwoHumans();
  const session = await startSession(owner.first, owner.projectId);
  const stranger = await projectWithTwoHumans();

  const foreign = await post(stranger.first, `/api/v1/browser-sessions/${session.id}/commands`, {
    control_epoch: 999,
    command: SNAPSHOT,
  });
  const unknown = await post(stranger.first, "/api/v1/browser-sessions/brs_nope/commands", {
    control_epoch: 999,
    command: SNAPSHOT,
  });
  assert.equal(foreign.statusCode, 404, foreign.body);
  assert.equal(code(foreign.body), "RESOURCE_NOT_FOUND");
  assert.ok(!foreign.body.includes("epoch"), "the refusal must not report the session's epoch");

  const normalise = (body: string): unknown => {
    const parsed = JSON.parse(body) as { meta?: { request_id?: string } };
    if (parsed.meta !== undefined) parsed.meta.request_id = "req_normalised";
    return parsed;
  };
  assert.deepEqual(normalise(foreign.body), normalise(unknown.body));
  assert.equal(commandRequests(), 0);
  // Nothing was written to the victim's timeline by a caller with no authority
  // there.
  assert.deepEqual(await rejections(owner.projectId), []);
});
