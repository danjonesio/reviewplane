/**
 * What the control plane checks before a browser session may reach a
 * development machine (ADR-0037, RVP-90, RVP-81).
 *
 * `session-service-binding.test.ts` proves the reserve-then-allocate order
 * works. This file proves the things that must be **true of the checks
 * themselves**: that a connector's status is a term of the publication query
 * rather than a value the caller discards, that a route capability cannot
 * outlive the browser session it was minted for, that ending a session
 * withdraws the credential it held, and that a session identifier arriving as
 * an argument is resolved in the caller's scope before anything acts on it.
 *
 * It authenticates as a real **account** session rather than the bootstrap
 * token wherever tenancy is the subject. The bootstrap principal has
 * `organisationId: null` and `projectIds: null`, so both tenancy terms in every
 * scoped query go vacuous and a regression dropping one would ship green —
 * which is the reason `browser-route-authority.test.ts` gives for the same
 * choice, and it applies here for the same reason.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { verifyCapability } from "@reviewplane/protocol";
import type { CapabilityKeyring } from "@reviewplane/protocol";

import {
  AcceptingGateway,
  BOOTSTRAP_TOKEN,
  StubRoutePublisher,
  seedProjectAndWorker,
  startHarness,
  type Harness,
} from "./support/worker-harness.ts";
import { claimSessionFor, type SessionCookies } from "./support/identity.ts";
import { TEST_CAPABILITY_KEY, TEST_CAPABILITY_KEY_ID } from "./support/config.ts";
import { startMigratedDatabase, truncateAll, type MigratedDatabase } from "./support/postgres.ts";

const DESKTOP = { width: 1440, height: 900, device_scale_factor: 1 };
const ADMIN = { authorization: `Bearer ${BOOTSTRAP_TOKEN}` };

let postgres: MigratedDatabase;
let harness: Harness;

before(async () => {
  postgres = await startMigratedDatabase();
});

after(async () => {
  await harness?.stop();
  await postgres?.stop();
});

/**
 * Every project seeded in the current test.
 *
 * `seedProjectAndWorker` registers the same worker name each time and then
 * **replaces** its whole assignment, so a second tenant would detach the first
 * one's worker and every session it tried to reserve would be refused with
 * `PROJECT_CONTEXT_MISMATCH` — a failure that reads as a bug in the code under
 * test and is a fixture artefact. The assignment is restated across all of them
 * after each seed instead.
 */
let seededProjects: string[] = [];

/**
 * The recording gateway double.
 *
 * Held here rather than read back off the harness because `revokeCapability`
 * assertions need the *object* the control plane was given. It records calls
 * rather than merely accepting them: "the control plane told the gateway" is an
 * assertion a test has to be able to make, and a double that returned success
 * without recording makes it unwritable.
 */
let gateway: AcceptingGateway;

beforeEach(async () => {
  await harness?.stop();
  await truncateAll(postgres.pool);
  seededProjects = [];
  gateway = new AcceptingGateway();
  harness = await startHarness(postgres.pool, {
    publisher: new StubRoutePublisher(),
    gateway,
  });
});

interface Tenant {
  readonly organisationId: string;
  readonly projectId: string;
  readonly connectorId: string;
  readonly workspaceId: string;
  readonly cookies: SessionCookies;
}

async function tenant(email: string): Promise<Tenant> {
  const seeded = await seedProjectAndWorker(harness);
  seededProjects.push(seeded.projectId);
  await harness.built.app.inject({
    method: "PUT",
    url: `/api/v1/browser-workers/${seeded.workerId}/assignments`,
    headers: ADMIN,
    payload: { project_ids: [...seededProjects] },
  });
  const cookies = await claimSessionFor(harness.built, postgres.pool, seeded.organisationId, {
    email,
  });
  return { ...seeded, cookies };
}

async function reserve(owner: Tenant): Promise<string> {
  const response = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${owner.projectId}/browser-sessions`,
    headers: owner.cookies.writeHeaders,
    payload: { viewport: DESKTOP, allocate: false },
  });
  assert.equal(response.statusCode, 201, response.body);
  return (response.json() as { data: { id: string } }).data.id;
}

function publish(
  owner: Tenant,
  sessionIds: readonly string[],
  overrides: Record<string, unknown> = {},
) {
  return harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${owner.projectId}/published-services`,
    headers: ADMIN,
    payload: {
      connector_id: owner.connectorId,
      workspace_id: owner.workspaceId,
      local_host: "127.0.0.1",
      local_port: 4321,
      protocol: "http",
      ttl_seconds: 600,
      allowed_browser_session_ids: [...sessionIds],
      ...overrides,
    },
  });
}

async function setConnectorStatus(connectorId: string, status: string): Promise<void> {
  await postgres.pool.query("UPDATE connectors SET status = $2 WHERE id = $1", [
    connectorId,
    status,
  ]);
}

// ------------------------------------------------------------------- RVP-81

test("a revoked connector cannot carry a route, and the refusal precedes the record", async () => {
  // `findPublishableConnector` selected `connectors.status` and every caller
  // discarded it, while `apps/mcp-server/src/development-services.ts` required
  // `ACTIVE` for its own connector selection — so the two publication surfaces
  // disagreed about whether a connector may carry a route at all. The term is
  // now in the SQL at the one point both surfaces provably traverse.
  const owner = await tenant("rvp81-revoked@example.test");
  const sessionId = await reserve(owner);
  await setConnectorStatus(owner.connectorId, "REVOKED");

  const refused = await publish(owner, [sessionId]);
  assert.equal(refused.statusCode, 403, refused.body);
  const body = refused.json() as { error: { code: string; details?: Record<string, unknown> } };
  assert.equal(body.error.code, "IDENTITY_REVOKED");
  assert.equal(body.error.details?.["connector_status"], "REVOKED");

  // Before a row, before an event, before the connector was asked for anything.
  // A refusal that wrote `published_service.requested` first would leave a route
  // record for a machine that may not be reached.
  const rows = await postgres.pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM published_services WHERE project_id = $1",
    [owner.projectId],
  );
  assert.equal(rows.rows[0]?.count, "0");
  const events = await postgres.pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM events WHERE project_id = $1 AND type LIKE 'published_service.%'",
    [owner.projectId],
  );
  assert.equal(events.rows[0]?.count, "0");
});

test("a connector the deployment has and cannot reach is CONNECTOR_OFFLINE, not IDENTITY_REVOKED", async () => {
  // The two are different acts for the operator: a revoked identity will not
  // come back, and a disconnected connector reconnects on its own. Answering
  // both with one code sends somebody to re-enrol a machine that is merely
  // rebooting (`docs/CONNECTOR_PROTOCOL.md` §21, `docs/UX_FLOWS.md` §18).
  const owner = await tenant("rvp81-offline@example.test");
  const sessionId = await reserve(owner);
  for (const status of ["DISCONNECTED", "DEGRADED", "PENDING_ENROLMENT"]) {
    await setConnectorStatus(owner.connectorId, status);
    const refused = await publish(owner, [sessionId]);
    const body = refused.json() as { error: { code: string; details?: Record<string, unknown> } };
    assert.equal(body.error.code, "CONNECTOR_OFFLINE", `${status} produced ${body.error.code}`);
    assert.equal(body.error.details?.["connector_status"], status);
  }
});

test("a connector in another organisation is absent, whatever its status", async () => {
  // The diagnosis runs inside the same tenancy terms the scoped read used, so
  // it cannot become an oracle: a connector in another organisation answers
  // `RESOURCE_NOT_FOUND` whether it is `ACTIVE` or `REVOKED`, byte for byte as
  // an identifier that does not exist does.
  const owner = await tenant("rvp81-scope-owner@example.test");
  const stranger = await tenant("rvp81-scope-stranger@example.test");
  const sessionId = await reserve(owner);

  const bodies: string[] = [];
  for (const status of ["ACTIVE", "REVOKED"]) {
    await setConnectorStatus(stranger.connectorId, status);
    const refused = await publish(owner, [sessionId], { connector_id: stranger.connectorId });
    bodies.push(JSON.stringify((refused.json() as { error: unknown }).error));
  }
  const unknown = await publish(owner, [sessionId], { connector_id: "con_does_not_exist" });
  bodies.push(JSON.stringify((unknown.json() as { error: unknown }).error));
  assert.equal(new Set(bodies).size, 1, `three refusals differ: ${bodies.join(" | ")}`);
  assert.match(bodies[0] as string, /RESOURCE_NOT_FOUND/u);
});

// -------------------------------------------------- the capability's lifetime

test("a route capability may not outlive the browser session it was minted for", async () => {
  const owner = await tenant("capability-bound@example.test");
  // A session whose maximum duration is far shorter than the route's lifetime
  // and shorter than the capability TTL, so the session is the binding term.
  const reserved = await harness.built.sessions.create({
    organisationId: owner.organisationId,
    projectId: owner.projectId,
    viewport: DESKTOP,
    controller: { type: "system", id: "sys_bound" },
    retentionClass: "verification_evidence",
    limits: { max_duration_seconds: 60 },
    actor: { type: "system" },
  });
  const published = await publish(owner, [reserved.id], { ttl_seconds: 28_000 });
  assert.equal(published.statusCode, 201, published.body);
  const routeId = (published.json() as { data: { id: string } }).data.id;

  const allocated = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${reserved.id}/allocate`,
    headers: owner.cookies.writeHeaders,
    payload: { published_service_id: routeId },
  });
  assert.equal(allocated.statusCode, 200, allocated.body);

  const allocation = harness.allocations.at(-1);
  assert.ok(allocation !== undefined, "the worker received no allocation");
  const keyring: CapabilityKeyring = new Map([[TEST_CAPABILITY_KEY_ID, TEST_CAPABILITY_KEY]]);
  const claims = verifyCapability(
    keyring,
    allocation.payload["service_capability"] as string,
    Math.floor(Date.now() / 1000),
  );
  const bound = Math.floor((new Date(reserved.created_at).getTime() + 60_000) / 1000);
  // The credential expires with the browser, not with the route. A capability
  // that outlived the browser it was minted for is a credential nobody is
  // accounting for, and this bound holds without the gateway's cooperation —
  // which matters, because the gateway's revocation set is in memory and does
  // not survive a restart (RVP-76, RVP-99).
  assert.equal(claims.expiresAt, bound, "the mint did not apply the session bound");

  const stored = await postgres.pool.query<{ expires_at: Date }>(
    "SELECT expires_at FROM route_capabilities WHERE browser_session_id = $1",
    [reserved.id],
  );
  assert.equal(Math.floor((stored.rows[0]?.expires_at as Date).getTime() / 1000), bound);
});

test("ending a session withdraws the capabilities it held", async () => {
  const owner = await tenant("capability-withdrawn@example.test");
  const sessionId = await reserve(owner);
  const published = await publish(owner, [sessionId]);
  const routeId = (published.json() as { data: { id: string } }).data.id;
  await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${sessionId}/allocate`,
    headers: owner.cookies.writeHeaders,
    payload: { published_service_id: routeId },
  });

  const live = await postgres.pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM route_capabilities WHERE browser_session_id = $1 AND revoked_at IS NULL",
    [sessionId],
  );
  assert.equal(live.rows[0]?.count, "1");

  await harness.built.sessions.terminate(sessionId, "requested", { type: "system" });

  // `terminate` revoked the control lease and stopped, and
  // `revokeCapabilitiesForService` is per route rather than per session, so
  // nothing withdrew this. `docs/ARCHITECTURE.md` §7.3 nevertheless states that
  // a capability is revocable individually as well as through its route.
  //
  // **This is durable in the control plane and best effort at the gateway.**
  // The gateway verifies from a signature without a database read and its
  // revocation set is in memory (RVP-76), so what this asserts is the record —
  // which is what an auditor reads, and what RVP-99 will make sufficient.
  const after = await postgres.pool.query<{ revoked_at: Date | null }>(
    "SELECT revoked_at FROM route_capabilities WHERE browser_session_id = $1",
    [sessionId],
  );
  assert.equal(after.rows.length, 1);
  assert.notEqual(after.rows[0]?.revoked_at, null, "the capability outlived its session");
});

// ------------------------------------------ the organisation term, structurally

test("the binder passes the caller's organisation and never constructs a null one", async () => {
  // **This test is structural on purpose, and the reason is worth stating.**
  //
  // Setting `organisationId: null` here changes no observable behaviour today,
  // and a behavioural test for it cannot be written: `projects.id` is a global
  // primary key and `projects.organisation_id` is `NOT NULL`, so a specific,
  // caller-derived project term already refuses everything the organisation term
  // would refuse. Every cross-organisation route is also a cross-project route.
  //
  // That is exactly why the term has to be asserted rather than inferred. The
  // safety is a property of *every caller* passing a specific project, not a
  // property of the binder — and a shipped release violated the same implication
  // elsewhere, which is why `CreatePublishedServiceInput.organisationId` carries
  // the comment it does (RVP-91, RVP-92, ADR-0037). A regression that
  // reintroduced `organisationId: null` would pass every behavioural test in
  // this repository. It does not pass this one.
  const scopes: { organisationId: string | null; projectIds: readonly string[] | null }[] = [];
  const route = () => ({
    published_service_id: "svc_recorded",
    public_alias: "svc-recorded",
    route_status: "ready",
    route_expires_at: new Date(Date.now() + 600_000),
    connector_id: "con_recorded",
    connector_status: "ACTIVE",
    session_authorised: true,
    session_created_at: new Date(),
    session_max_duration_seconds: 7200,
    organisation_id: "org_expected",
    project_id: "prj_expected",
  });
  const recording = {
    readAdmissible(input: {
      scope: { organisationId: string | null; projectIds: readonly string[] | null };
    }) {
      scopes.push(input.scope);
      return Promise.resolve(route());
    },
    readBindable(input: {
      scope: { organisationId: string | null; projectIds: readonly string[] | null };
    }) {
      scopes.push(input.scope);
      return Promise.resolve(route());
    },
    existsUnscoped() {
      return Promise.resolve(false);
    },
    mint(
      _serviceId: string,
      _browserSessionId: string,
      _ttlSeconds: number | undefined,
      scope: { organisationId: string | null; projectIds: readonly string[] | null },
    ) {
      scopes.push(scope);
      return Promise.resolve({
        capability_id: "cap_recorded",
        capability: "rp1.recorded",
        browser_session_id: "brs_recorded",
        internal_origin: "https://svc-recorded.internal.invalid/",
        expires_at: new Date().toISOString(),
      });
    },
  };
  const { PublishedServiceBinder } = await import(
    "../src/modules/published-services/session-binder.ts"
  );
  const binder = new PublishedServiceBinder(
    recording as unknown as ConstructorParameters<typeof PublishedServiceBinder>[0],
  );

  await binder.authorise({
    publishedServiceId: "svc_recorded",
    organisationId: "org_expected",
    projectId: "prj_expected",
    browserSessionId: "brs_recorded",
  });
  await binder.bind({
    publishedServiceId: "svc_recorded",
    organisationId: "org_expected",
    projectId: "prj_expected",
    browserSessionId: "brs_recorded",
    actor: { type: "system" },
    requestId: "req_structural",
  });

  // Three reads: `authorise`'s, `bind`'s, and the mint `bind` performs. Every
  // one of them carries the organisation it was given, and none of them carries
  // null — including the mint, which is the last gate before a signed credential
  // exists.
  assert.equal(scopes.length, 3);
  for (const scope of scopes) {
    assert.equal(scope.organisationId, "org_expected", "the binder dropped the organisation term");
    assert.deepEqual(scope.projectIds, ["prj_expected"]);
  }
});

// ------------------------------------------------- the scope allocate carries

test("allocating a session in another tenancy is absent, not forbidden", async () => {
  // `allocate` read through the unscoped `get()` and carried no caller scope at
  // all. Every authorisation it enjoyed happened above it, in the route layer,
  // and held only because its callers named a session they had just created.
  // `browser_session_allocate` takes the identifier as an argument, so the
  // function itself carries the scope now.
  const owner = await tenant("allocate-owner@example.test");
  const stranger = await tenant("allocate-stranger@example.test");
  const theirs = await reserve(owner);

  const foreign = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${theirs}/allocate`,
    headers: stranger.cookies.writeHeaders,
    payload: {},
  });
  const unknown = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/brs_does_not_exist/allocate`,
    headers: stranger.cookies.writeHeaders,
    payload: {},
  });
  assert.equal(foreign.statusCode, 404, foreign.body);
  assert.equal(foreign.statusCode, unknown.statusCode);
  // The error bodies, not the statuses. `docs/TESTING.md` §10: wording is as
  // much an existence oracle as a status code is. `meta.request_id` differs per
  // request by design and is the one member excluded.
  assert.deepEqual(
    (foreign.json() as { error: unknown }).error,
    (unknown.json() as { error: unknown }).error,
  );

  // And the other tenant's reservation did not move.
  const still = await postgres.pool.query<{ status: string }>(
    "SELECT status FROM browser_sessions WHERE id = $1",
    [theirs],
  );
  assert.equal(still.rows[0]?.status, "REQUESTED");
});

test("allocate refuses a session outside the scope it was handed, whatever its caller resolved", async () => {
  // Through the **service**, because that is where the property has to hold.
  // The HTTP route above resolves the session in the caller's scope before it
  // calls `allocate`, so the route test passes whether or not `allocate` carries
  // a scope of its own — which is precisely the shape ADR-0037 rules out: every
  // authorisation `allocate` enjoyed happened above it, and was a property of
  // its callers rather than of it. `browser_session_allocate` takes the session
  // identifier as an argument and inherits none of that.
  const owner = await tenant("allocate-service-owner@example.test");
  const stranger = await tenant("allocate-service-stranger@example.test");
  const theirs = await reserve(owner);

  await assert.rejects(
    async () =>
      harness.built.sessions.allocate({
        browserSessionId: theirs,
        scope: {
          organisationId: stranger.organisationId,
          projectIds: [stranger.projectId],
        },
        actor: { type: "system" },
        requestId: "req_service_scope",
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "RESOURCE_NOT_FOUND");
      return true;
    },
  );

  const still = await postgres.pool.query<{ status: string }>(
    "SELECT status FROM browser_sessions WHERE id = $1",
    [theirs],
  );
  assert.equal(still.rows[0]?.status, "REQUESTED", "the reservation was allocated out of scope");
});

// ---------------------------------------------- the attack list's C-series

/** A reservation, a route naming it, and the request recorded against it. */
async function requested(owner: Tenant): Promise<{ sessionId: string; routeId: string }> {
  const sessionId = await reserve(owner);
  const published = await publish(owner, [sessionId]);
  assert.equal(published.statusCode, 201, published.body);
  const routeId = (published.json() as { data: { id: string } }).data.id;
  await harness.built.sessions.requestAllocation({
    browserSessionId: sessionId,
    scope: { organisationId: owner.organisationId, projectIds: [owner.projectId] },
    publishedServiceId: routeId,
    actor: { type: "system" },
    requestId: `req_${sessionId}`,
  });
  return { sessionId, routeId };
}

test("C1: a mint against an already-failed session writes nothing and raises", async () => {
  // **Both assertions, not either.** With the status predicate on the insert,
  // `result.rows[0]` is `undefined` on a lost race, and a cast to the record
  // type makes that typecheck-clean. A test asserting only the row's absence
  // passes an implementation that returns an `undefined` record — after which
  // `bind` hands `SessionAllocate` a binding whose capability is `undefined` and
  // the worker presents nothing. That is a worse failure than the one the
  // predicate exists to fix, and a row count cannot see it.
  const owner = await tenant("c1-lost-race@example.test");
  const { sessionId, routeId } = await requested(owner);

  // The sweep gets there first.
  await harness.built.sessions.failOverdueAllocations({ deadlineMs: 0 });
  const failed = await postgres.pool.query<{ status: string }>(
    "SELECT status FROM browser_sessions WHERE id = $1",
    [sessionId],
  );
  assert.equal(failed.rows[0]?.status, "FAILED");

  // The in-flight bind now reaches the mint.
  await assert.rejects(
    async () =>
      harness.built.publishedServices.mint(
        routeId,
        sessionId,
        undefined,
        { organisationId: owner.organisationId, projectIds: [owner.projectId] },
        { type: "system" },
        "req_c1_mint",
      ),
    (error: unknown) => {
      // The raise is the assertion the row count cannot make.
      assert.ok(error instanceof Error, "mint resolved instead of raising");
      return true;
    },
  );

  const capabilities = await postgres.pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM route_capabilities WHERE browser_session_id = $1",
    [sessionId],
  );
  assert.equal(capabilities.rows[0]?.count, "0", "a capability exists for a FAILED session");
});

test("C2: a sweep after the mint leaves no live capability and the session never reaches READY", async () => {
  const owner = await tenant("c2-sweep-after-mint@example.test");
  const { sessionId, routeId } = await requested(owner);

  // The bind claims and mints...
  await postgres.pool.query("UPDATE browser_sessions SET status = 'ALLOCATING' WHERE id = $1", [
    sessionId,
  ]);
  const minted = await harness.built.publishedServices.mint(
    routeId,
    sessionId,
    undefined,
    { organisationId: owner.organisationId, projectIds: [owner.projectId] },
    { type: "system" },
    "req_c2_mint",
  );

  // ...and the sweep arrives before `markReady`.
  const before = gateway.revokedCapabilities.length;
  await harness.built.sessions.failOverdueAllocations({ deadlineMs: 0 });

  const capability = await postgres.pool.query<{ revoked_at: Date | null }>(
    "SELECT revoked_at FROM route_capabilities WHERE id = $1",
    [minted.capability_id],
  );
  assert.notEqual(capability.rows[0]?.revoked_at, null, "a capability outlived its swept session");
  assert.deepEqual(
    gateway.revokedCapabilities.slice(before),
    [minted.capability_id],
    "the gateway was not told to withdraw the capability",
  );

  // Note what this does **not** assert: that the gateway then refuses the
  // capability. It verifies from a signature without a database read and its
  // revocation set does not survive a restart (RVP-76), so a test claiming that
  // would assert a property the system does not have. RVP-99 carries it.
  const session = await postgres.pool.query<{ status: string }>(
    "SELECT status FROM browser_sessions WHERE id = $1",
    [sessionId],
  );
  assert.equal(session.rows[0]?.status, "FAILED");
});

test("C4: the sweep races the inline path with the grace at zero, and one allocation wins", async () => {
  // **The grace set to zero is the point.** The grace is an optimisation; the
  // status guard in the claim is the control. A test that only ran with a
  // realistic grace would still pass after the guard was removed — and somebody
  // will remove it *because* the grace exists.
  const owner = await tenant("c4-grace-zero@example.test");
  const { sessionId } = await requested(owner);

  const workerCalls = () =>
    harness.allocations.filter((allocation) => allocation.browserSessionId === sessionId).length;
  const before = workerCalls();

  const [a, b] = await Promise.allSettled([
    harness.built.sessions.completePendingAllocations({ olderThanMs: 0 }),
    harness.built.sessions.completePendingAllocations({ olderThanMs: 0 }),
  ]);
  void a;
  void b;

  assert.equal(workerCalls() - before, 1, "one reservation produced two worker allocations");
  const capabilities = await postgres.pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM route_capabilities WHERE browser_session_id = $1",
    [sessionId],
  );
  assert.equal(capabilities.rows[0]?.count, "1", "one reservation produced two capabilities");
  const allocated = await postgres.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM events
      WHERE type = 'browser_session.allocated' AND correlation ->> 'browser_session_id' = $1`,
    [sessionId],
  );
  assert.equal(allocated.rows[0]?.count, "1");
});

test("C7: a route revoked between the request and the claim fails the reservation and mints nothing", async () => {
  // The check-then-use window the joined read at **claim** time exists to close,
  // and the reason the MCP process must not pre-check route status: a pre-check
  // that admitted would be authoritative-looking and wrong.
  const owner = await tenant("c7-revoked-between@example.test");
  const { sessionId, routeId } = await requested(owner);

  await harness.built.app.inject({
    method: "DELETE",
    url: `/api/v1/published-services/${routeId}`,
    headers: ADMIN,
  });

  await harness.built.sessions.completePendingAllocations({ olderThanMs: 0 });

  const session = await postgres.pool.query<{ status: string }>(
    "SELECT status FROM browser_sessions WHERE id = $1",
    [sessionId],
  );
  assert.equal(session.rows[0]?.status, "FAILED");
  const capabilities = await postgres.pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM route_capabilities WHERE browser_session_id = $1",
    [sessionId],
  );
  assert.equal(capabilities.rows[0]?.count, "0");

  const failure = await harness.built.sessions.allocationFailure(sessionId);
  assert.equal(failure?.code, "PUBLISHED_SERVICE_UNAVAILABLE");
  assert.equal(failure?.details["published_service_id"], routeId);
});

test("C8: a connector that disconnects between the request and the claim is CONNECTOR_OFFLINE", async () => {
  const owner = await tenant("c8-disconnect-between@example.test");
  const { sessionId, routeId } = await requested(owner);
  await setConnectorStatus(owner.connectorId, "DISCONNECTED");

  await harness.built.sessions.completePendingAllocations({ olderThanMs: 0 });

  const failure = await harness.built.sessions.allocationFailure(sessionId);
  assert.equal(failure?.code, "CONNECTOR_OFFLINE");
  assert.equal(failure?.details["connector_status"], "DISCONNECTED");
  assert.equal(failure?.details["published_service_id"], routeId);
});

// ---------------------------------------------- the attack list's F-series

test("F7: a successful bind clears the requested route, so the deadline never reaches it", async () => {
  // **Catastrophic if missed and two lines to assert.** Miss the clear and every
  // healthy bound session is failed by the sweep two minutes after it starts —
  // and no short suite stumbles into it, because nothing else advances the clock
  // that far.
  const owner = await tenant("f7-clears@example.test");
  const { sessionId } = await requested(owner);
  await harness.built.sessions.completePendingAllocations({ olderThanMs: 0 });

  const bound = await postgres.pool.query<{
    status: string;
    requested_published_service_id: string | null;
    allocation_requested_at: Date | null;
  }>(
    "SELECT status, requested_published_service_id, allocation_requested_at FROM browser_sessions WHERE id = $1",
    [sessionId],
  );
  assert.equal(bound.rows[0]?.status, "READY");
  assert.equal(bound.rows[0]?.requested_published_service_id, null);
  assert.equal(bound.rows[0]?.allocation_requested_at, null);

  // Ten times the deadline later, it is still healthy.
  await harness.built.sessions.failOverdueAllocations({ deadlineMs: 0 });
  const after = await postgres.pool.query<{ status: string }>(
    "SELECT status FROM browser_sessions WHERE id = $1",
    [sessionId],
  );
  assert.equal(after.rows[0]?.status, "READY", "the deadline failed a healthy bound session");
});

test("F3/F4: the sweep reaches a DEGRADED reservation and never a route-less one", async () => {
  // The pair. F3 alone passes with a predicate that is too wide; F4 alone passes
  // with one that is too narrow. Neither is sufficient on its own.
  const owner = await tenant("f3f4-predicate@example.test");

  // F3: `BrowserWorkerMonitor` marks an `ALLOCATING` reservation no worker holds
  // as `DEGRADED`, which without the third status in the predicate would move it
  // out of the sweep's reach and strand it holding a slot for ever.
  const { sessionId: degraded } = await requested(owner);
  await postgres.pool.query("UPDATE browser_sessions SET status = 'DEGRADED' WHERE id = $1", [
    degraded,
  ]);

  // F4: a human reservation with no route is somebody's in-progress work.
  const untouched = await reserve(owner);

  await harness.built.sessions.failOverdueAllocations({ deadlineMs: 0 });

  const rows = await postgres.pool.query<{ id: string; status: string }>(
    "SELECT id, status FROM browser_sessions WHERE id = ANY($1)",
    [[degraded, untouched]],
  );
  const byId = new Map(rows.rows.map((row) => [row.id, row.status]));
  assert.equal(byId.get(degraded), "FAILED", "a DEGRADED reservation was stranded");
  assert.equal(
    byId.get(untouched),
    "REQUESTED",
    "the sweep failed a reservation that asked for no route",
  );
});

test("A9: the organisation is a term of the scoped read, not a comparison after it", async () => {
  // A direct test on the read, because no tool call can construct the state that
  // distinguishes them. With `organisationId: null` the project term alone
  // answers, and the answer is correct **only because** a project implies its
  // organisation — an implication a shipped release violated (RVP-91, RVP-92).
  const owner = await tenant("a9-owner@example.test");
  const stranger = await tenant("a9-stranger@example.test");
  const theirSession = await reserve(stranger);
  const published = await publish(stranger, [theirSession]);
  const theirRoute = (published.json() as { data: { id: string } }).data.id;

  const readable = await harness.built.publishedServices.readAdmissible({
    publishedServiceId: theirRoute,
    browserSessionId: theirSession,
    // The other tenant's **project**, with this caller's organisation. The
    // project term alone would return the row.
    scope: { organisationId: owner.organisationId, projectIds: [stranger.projectId] },
  }).then(
    () => "returned",
    (error: unknown) => (error as { code?: string }).code,
  );
  assert.equal(readable, "RESOURCE_NOT_FOUND", "the organisation stopped being a term");
});
