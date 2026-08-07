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

beforeEach(async () => {
  await harness?.stop();
  await truncateAll(postgres.pool);
  seededProjects = [];
  harness = await startHarness(postgres.pool, {
    publisher: new StubRoutePublisher(),
    gateway: new AcceptingGateway(),
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
