/**
 * The routes where `projectIds === null` was read as authority (RVP-91,
 * RVP-92), driven over HTTP.
 *
 * **The session shape is the whole point of this suite.** `projectIds: null`
 * means "not narrowed to specific projects", and it is what *every* real
 * sign-in issues (`modules/identity/routes.ts` issues it for both the install
 * token and the password path). Four guards read it as "is an administrator" —
 * three inverted, one short-circuiting an `&&` — so every tenant's ordinary
 * organisation-wide user satisfied them.
 *
 * Both defects survived a full test suite because the probes available were
 * the two shapes that cannot see this class:
 *
 *   * a **project-scoped** session, which the wrong predicate refuses
 *     correctly, so it passes against the defect and against the fix;
 *   * the **bootstrap administrator**, which has `organisationId: null` and
 *     `projectIds: null`, so every tenancy term in every scoped query goes
 *     vacuous and a missing one ships green.
 *
 * So the primary probe here is an **organisation-wide viewer of a different
 * organisation**: `claimSessionFor` against tenant B's organisation, which
 * signs in the way a person does and carries a real `organisationId` and a
 * real CSRF token. The project-scoped probe is kept beside it, not instead of
 * it — the pair is what makes the mutation test meaningful, because a term
 * that is doing work fails the organisation-wide probe *while the
 * project-scoped one still passes*. A change that breaks both is refusing
 * everything, which is not the same fix.
 *
 * These are routes, not services. RVP-30 shipped a route-level blocker that 27
 * service-level tests passed over, and both of these defects are in the guard
 * rather than in the query it protects, so nothing below calls a service
 * directly.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  BOOTSTRAP_TOKEN,
  seedProjectAndWorker,
  startHarness,
  type Harness,
} from "./support/worker-harness.ts";
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

const ADMIN = { authorization: `Bearer ${BOOTSTRAP_TOKEN}` };

interface Tenant {
  readonly organisationId: string;
  readonly projectId: string;
  readonly workerId: string;
  readonly workspaceId: string;
  /** An **organisation-wide** signed-in human: `projectIds: null`. */
  readonly cookies: SessionCookies;
}

/**
 * A tenant: organisation, project, an assigned browser worker, a workspace
 * carrying a developer-machine path, and a signed-in organisation-wide human.
 */
async function tenant(email: string): Promise<Tenant> {
  const seeded = await seedProjectAndWorker(harness);
  const cookies = await claimSessionFor(harness.built, postgres.pool, seeded.organisationId, {
    email,
  });
  return {
    organisationId: seeded.organisationId,
    projectId: seeded.projectId,
    workerId: seeded.workerId,
    workspaceId: seeded.workspaceId,
    cookies,
  };
}

/** A viewer session narrowed to one project — the shape that already refused. */
async function projectScopedCookie(projectId: string): Promise<Record<string, string>> {
  const minted = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/viewer-sessions`,
    headers: ADMIN,
  });
  assert.equal(minted.statusCode, 201, minted.body);
  const token = (minted.json() as { data: { token: string } }).data.token;
  return { cookie: `reviewplane_viewer=${encodeURIComponent(token)}` };
}

/** Replaces the request identifier, the only per-request member of a body. */
function normalise(body: string): unknown {
  const parsed = JSON.parse(body) as { meta?: { request_id?: string } };
  if (parsed.meta !== undefined) parsed.meta.request_id = "req_normalised";
  return parsed;
}

function errorCode(body: string): string {
  return (JSON.parse(body) as { error: { code: string } }).error.code;
}

async function assignmentsOf(workerId: string): Promise<string[]> {
  const rows = await postgres.pool.query<{ project_id: string }>(
    "SELECT project_id FROM browser_worker_projects WHERE worker_id = $1 ORDER BY project_id",
    [workerId],
  );
  return rows.rows.map((row) => row.project_id);
}

// ---------------------------------------------------------------------------
// RVP-92 — GET /api/v1/projects/:projectId/workspaces
// ---------------------------------------------------------------------------

test("an organisation-wide viewer cannot read another organisation's workspaces", async () => {
  const victim = await tenant("victim@localhost");
  const attacker = await tenant("attacker@localhost");

  const foreign = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/projects/${victim.projectId}/workspaces`,
    headers: attacker.cookies.readHeaders,
  });
  const unknown = await harness.built.app.inject({
    method: "GET",
    url: "/api/v1/projects/prj_does_not_exist_at_all/workspaces",
    headers: attacker.cookies.readHeaders,
  });

  // Equality of **bodies**, not of statuses. A matching 404 carrying a
  // different message distinguishes the two exactly as a status difference
  // would, and that difference is an existence oracle (`docs/TESTING.md`
  // section 10, `docs/API.md` section 5). The refusal this replaced was
  // `PROJECT_CONTEXT_MISMATCH`, a 403, which announced the project exists.
  assert.equal(foreign.statusCode, 404, foreign.body);
  assert.equal(unknown.statusCode, 404, unknown.body);
  assert.deepEqual(normalise(foreign.body), normalise(unknown.body));

  // The disclosure this route made was not a generic cross-tenant read.
  // `root_path` is the developer machine's absolute filesystem path, which
  // `docs/DOMAIN_MODEL.md` section 9 reduces to `path_hash` and
  // `display_label` on the connector protocol *so that it is not disclosed*.
  const paths = await postgres.pool.query<{ root_path: string }>(
    "SELECT root_path FROM workspaces WHERE id = $1",
    [victim.workspaceId],
  );
  const rootPath = paths.rows[0]?.root_path;
  assert.ok(typeof rootPath === "string" && rootPath.length > 0);
  assert.ok(
    !foreign.body.includes(rootPath),
    `the refusal disclosed the developer-machine path ${rootPath}`,
  );
  assert.ok(!foreign.body.includes(victim.organisationId));
});

test("an organisation-wide viewer still reads its own project's workspaces", async () => {
  const owner = await tenant("owner@localhost");

  const response = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/projects/${owner.projectId}/workspaces`,
    headers: owner.cookies.readHeaders,
  });
  assert.equal(response.statusCode, 200, response.body);
  const data = (response.json() as { data: { id: string; organisation_id: string }[] }).data;
  assert.deepEqual(
    data.map((workspace) => workspace.id),
    [owner.workspaceId],
  );
  assert.equal(data[0]?.organisation_id, owner.organisationId);
});

test("a project-scoped session is still refused another project's workspaces", async () => {
  // The leg the old guard got right, kept so the mutation test can show the
  // asymmetry. On its own it cannot see this class at all.
  const victim = await tenant("victim@localhost");
  const attacker = await tenant("attacker@localhost");
  const scoped = await projectScopedCookie(attacker.projectId);

  const refused = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/projects/${victim.projectId}/workspaces`,
    headers: scoped,
  });
  assert.equal(refused.statusCode, 404, refused.body);
  assert.equal(errorCode(refused.body), "RESOURCE_NOT_FOUND");

  const own = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/projects/${attacker.projectId}/workspaces`,
    headers: scoped,
  });
  assert.equal(own.statusCode, 200, own.body);
});

test("the bootstrap administrator still reads any project's workspaces", async () => {
  const owner = await tenant("owner@localhost");
  const response = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/projects/${owner.projectId}/workspaces`,
    headers: ADMIN,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((response.json() as { data: unknown[] }).data.length, 1);
});

// ---------------------------------------------------------------------------
// RVP-91 — the browser-worker fleet
// ---------------------------------------------------------------------------

test("an organisation-wide viewer cannot list the deployment's browser workers", async () => {
  const victim = await tenant("victim@localhost");
  const attacker = await tenant("attacker@localhost");

  const refused = await harness.built.app.inject({
    method: "GET",
    url: "/api/v1/browser-workers",
    headers: attacker.cookies.readHeaders,
  });
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(errorCode(refused.body), "AUTHORISATION_DENIED");
  // The registry is deployment-wide (ADR-0034), so the whole fleet — worker
  // identifiers, capacity, versions and liveness — was in one 200.
  assert.ok(!refused.body.includes(victim.workerId));
  assert.ok(!refused.body.includes(attacker.workerId));
});

test("an organisation-wide viewer cannot reassign a worker away from another tenant", async () => {
  const victim = await tenant("victim@localhost");
  const attacker = await tenant("attacker@localhost");

  // One worker, serving the victim. `seedProjectAndWorker` registers by name,
  // so both tenants resolve to the same deployment-wide row; assigning it to
  // the victim alone is the state the reproduction starts from.
  await harness.built.app.inject({
    method: "PUT",
    url: `/api/v1/browser-workers/${victim.workerId}/assignments`,
    headers: ADMIN,
    payload: { project_ids: [victim.projectId] },
  });
  assert.deepEqual(await assignmentsOf(victim.workerId), [victim.projectId]);

  const refused = await harness.built.app.inject({
    method: "PUT",
    url: `/api/v1/browser-workers/${victim.workerId}/assignments`,
    headers: attacker.cookies.writeHeaders,
    payload: { project_ids: [attacker.projectId] },
  });
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(errorCode(refused.body), "AUTHORISATION_DENIED");

  // `assign()` deletes every existing assignment row before inserting, so the
  // refusal has to leave the victim's assignment standing rather than merely
  // report an error after the delete. Stripping it would be a cross-tenant
  // denial of service the victim reads as `BROWSER_CAPACITY_EXHAUSTED` — the
  // same code a full worker produces, with no way to tell them apart.
  assert.deepEqual(await assignmentsOf(victim.workerId), [victim.projectId]);
});

test("an organisation-wide viewer cannot read the worker protocol example", async () => {
  const attacker = await tenant("attacker@localhost");
  const refused = await harness.built.app.inject({
    method: "GET",
    url: "/internal/v1/protocol",
    headers: attacker.cookies.readHeaders,
  });
  // The least severe of the three: the body is a constant example frame with
  // no tenant data in it. It is corrected for consistency, so the
  // deployment-administrator rule has one statement rather than two.
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(errorCode(refused.body), "AUTHORISATION_DENIED");
});

test("a project-scoped session is still refused all three worker routes", async () => {
  const owner = await tenant("owner@localhost");
  const scoped = await projectScopedCookie(owner.projectId);

  for (const [method, url] of [
    ["GET", "/api/v1/browser-workers"],
    ["GET", "/internal/v1/protocol"],
    ["PUT", `/api/v1/browser-workers/${owner.workerId}/assignments`],
  ] as const) {
    const refused = await harness.built.app.inject({
      method,
      url,
      headers: scoped,
      ...(method === "PUT" ? { payload: { project_ids: [owner.projectId] } } : {}),
    });
    assert.equal(refused.statusCode, 403, `${method} ${url}: ${refused.body}`);
    assert.equal(errorCode(refused.body), "AUTHORISATION_DENIED");
  }
});

test("the bootstrap administrator still administers the fleet", async () => {
  const owner = await tenant("owner@localhost");

  const listed = await harness.built.app.inject({
    method: "GET",
    url: "/api/v1/browser-workers",
    headers: ADMIN,
  });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.ok(
    (listed.json() as { data: { id: string }[] }).data.some((row) => row.id === owner.workerId),
  );

  const assigned = await harness.built.app.inject({
    method: "PUT",
    url: `/api/v1/browser-workers/${owner.workerId}/assignments`,
    headers: ADMIN,
    payload: { project_ids: [owner.projectId] },
  });
  assert.equal(assigned.statusCode, 200, assigned.body);

  const protocol = await harness.built.app.inject({
    method: "GET",
    url: "/internal/v1/protocol",
    headers: ADMIN,
  });
  assert.equal(protocol.statusCode, 200, protocol.body);
});

// ---------------------------------------------------------------------------
// The second line, below the routes
// ---------------------------------------------------------------------------

test("the workspace queries carry the organisation term themselves", async () => {
  // Explicitly the *second* line, and recorded as such. Over HTTP the route's
  // `resolveProject` refuses first, so removing this term alone changes no
  // observable behaviour — a mutation confirmed it: the suite above stays
  // green. It is here because `docs/SECURITY.md` section 7 requires a row
  // outside the caller's tenancy not to be returned at all, rather than
  // returned and dropped by a later branch, and because `WorkspaceStore` is
  // reachable from `apps/mcp-server` as well as from these routes.
  const victim = await tenant("victim@localhost");
  const attacker = await tenant("attacker@localhost");
  const store = harness.built.workspaces;

  assert.deepEqual(await store.listForProject(victim.projectId, attacker.organisationId), []);
  assert.equal(await store.get(victim.workspaceId, attacker.organisationId), null);

  const own = await store.listForProject(victim.projectId, victim.organisationId);
  assert.deepEqual(
    own.map((workspace) => workspace.id),
    [victim.workspaceId],
  );
  assert.equal((await store.get(victim.workspaceId, victim.organisationId))?.id, victim.workspaceId);
});

test("an assignment naming a project that does not exist writes nothing", async () => {
  const owner = await tenant("owner@localhost");
  await harness.built.app.inject({
    method: "PUT",
    url: `/api/v1/browser-workers/${owner.workerId}/assignments`,
    headers: ADMIN,
    payload: { project_ids: [owner.projectId] },
  });

  const refused = await harness.built.app.inject({
    method: "PUT",
    url: `/api/v1/browser-workers/${owner.workerId}/assignments`,
    headers: ADMIN,
    payload: { project_ids: [owner.projectId, "prj_does_not_exist_at_all"] },
  });
  // Every named project is resolved inside the caller's scope *before* the
  // delete, so a set the caller may not name in full changes nothing — rather
  // than the assignment being cleared and the insert then failing on a foreign
  // key.
  assert.equal(refused.statusCode, 404, refused.body);
  assert.equal(errorCode(refused.body), "RESOURCE_NOT_FOUND");
  assert.deepEqual(await assignmentsOf(owner.workerId), [owner.projectId]);
});
