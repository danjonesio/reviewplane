/**
 * Binding a published service to a browser session
 * (`docs/API.md` §11, `docs/ARCHITECTURE.md` §7.3, ADR-0015).
 *
 * The reserve-then-allocate split exists because publication and allocation
 * each need the other to have happened first, and the capability path exists
 * because the gateway authorises on a credential only the control plane may
 * mint. Both are properties of the control plane rather than of the browser, so
 * both are asserted here rather than in the end-to-end scenario, which cannot
 * run on a machine without Docker Compose.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { verifyCapability } from "@reviewplane/protocol";
import type { CapabilityKeyring } from "@reviewplane/protocol";

import { StubRoutePublisher } from "../src/modules/published-services/service.ts";
import {
  AcceptingGateway,
  BOOTSTRAP_TOKEN,
  seedProjectAndWorker,
  startHarness,
  type Harness,
} from "./support/worker-harness.ts";
import { TEST_CAPABILITY_KEY, TEST_CAPABILITY_KEY_ID } from "./support/config.ts";
import { startMigratedDatabase, truncateAll } from "./support/postgres.ts";
import type { MigratedDatabase } from "./support/postgres.ts";

const DESKTOP = { width: 1440, height: 900, device_scale_factor: 1 };

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
  harness = await startHarness(postgres.pool, {
    publisher: new StubRoutePublisher(),
    gateway: new AcceptingGateway(),
  });
});

const authorised = { authorization: `Bearer ${BOOTSTRAP_TOKEN}` };

async function reserveSession(projectId: string, organisationId: string): Promise<string> {
  const response = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/browser-sessions`,
    headers: authorised,
    payload: {
      organisation_id: organisationId,
      viewport: DESKTOP,
      controller: { type: "agent", id: "ags_test" },
      allocate: false,
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  const record = (response.json() as { data: Record<string, unknown> }).data;
  assert.equal(record["status"], "REQUESTED", "a reserved session must not be allocated yet");
  return record["id"] as string;
}

async function publish(
  projectId: string,
  sessionIds: readonly string[],
  environment: { connectorId: string; workspaceId: string },
) {
  return harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/published-services`,
    headers: authorised,
    payload: {
      // Real records in this project. Publication resolves the connector and
      // the workspace inside the caller's organisation and project, so a
      // synthetic identifier is refused rather than written to the row.
      connector_id: environment.connectorId,
      workspace_id: environment.workspaceId,
      local_host: "127.0.0.1",
      local_port: 4321,
      protocol: "http",
      ttl_seconds: 600,
      allowed_browser_session_ids: [...sessionIds],
    },
  });
}

test("a reserved session contacts no worker until it is allocated", async () => {
  const seeded = await seedProjectAndWorker(harness);
  const { projectId, organisationId } = seeded;
  const before = harness.workerRequests.length;
  await reserveSession(projectId, organisationId);
  assert.equal(
    harness.workerRequests.length,
    before,
    "reserving a session must not reach the browser worker",
  );
});

test("publish then allocate binds the route origin and a verifiable capability", async () => {
  const seeded = await seedProjectAndWorker(harness);
  const { projectId, organisationId } = seeded;
  const sessionId = await reserveSession(projectId, organisationId);

  const published = await publish(projectId, [sessionId], seeded);
  assert.equal(published.statusCode, 201, published.body);
  const service = (published.json() as { data: Record<string, string> }).data;

  const allocated = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${sessionId}/allocate`,
    headers: authorised,
    payload: { published_service_id: service["id"] },
  });
  assert.equal(allocated.statusCode, 200, allocated.body);
  const record = (allocated.json() as { data: Record<string, unknown> }).data;
  assert.equal(record["status"], "READY");
  assert.equal(record["published_service_id"], service["id"]);
  // The origin is the route's, with no trailing slash: it is compared against
  // `new URL(...).origin` in the worker, which never carries one.
  assert.equal(record["service_origin"], String(service["internal_origin"]).replace(/\/$/u, ""));

  // The allocation the worker actually received carries a capability the
  // gateway's keyring verifies, bound to this route, project and session.
  const allocation = harness.allocations.at(-1);
  assert.ok(allocation !== undefined, "the worker received no allocation");
  const capability = allocation.payload["service_capability"];
  assert.ok(typeof capability === "string" && capability.length > 0, "no capability was sent");

  // Verified with the same keyring the tunnel gateway would use, so the test
  // asserts the credential is usable rather than merely present.
  const keyring: CapabilityKeyring = new Map([[TEST_CAPABILITY_KEY_ID, TEST_CAPABILITY_KEY]]);
  const claims = verifyCapability(keyring, capability, Math.floor(Date.now() / 1000));
  assert.equal(claims.routeId, service["id"]);
  assert.equal(claims.projectId, projectId);
  assert.equal(claims.browserSessionId, sessionId);
});

test("the capability never appears in a log line or an event payload", async () => {
  const seeded = await seedProjectAndWorker(harness);
  const { projectId, organisationId } = seeded;
  const sessionId = await reserveSession(projectId, organisationId);
  const published = await publish(projectId, [sessionId], seeded);
  const service = (published.json() as { data: Record<string, string> }).data;
  await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${sessionId}/allocate`,
    headers: authorised,
    payload: { published_service_id: service["id"] },
  });

  const allocation = harness.allocations.at(-1);
  const capability = allocation?.payload["service_capability"] as string;
  assert.ok(capability.length > 0);

  const events = await postgres.pool.query<{ payload: unknown; correlation: unknown }>(
    "SELECT payload, correlation FROM events WHERE project_id = $1",
    [projectId],
  );
  assert.ok(
    !JSON.stringify(events.rows).includes(capability),
    "an event payload carries the capability value",
  );

  const sessions = await postgres.pool.query<{ service_origin: string }>(
    "SELECT service_origin FROM browser_sessions WHERE id = $1",
    [sessionId],
  );
  // The origin is persisted; the capability is not. Only its identifier is,
  // which is what revocation and audit need (docs/API.md section 10).
  assert.ok(sessions.rows[0]?.service_origin.startsWith("https://"));
  const stored = await postgres.pool.query<{ count: string }>(
    "SELECT count(*) AS count FROM route_capabilities WHERE browser_session_id = $1",
    [sessionId],
  );
  assert.equal(stored.rows[0]?.count, "1");
});

test("a session the route does not name is refused before anything is minted", async () => {
  const seeded = await seedProjectAndWorker(harness);
  const { projectId, organisationId } = seeded;
  const named = await reserveSession(projectId, organisationId);
  const unnamed = await reserveSession(projectId, organisationId);

  const published = await publish(projectId, [named], seeded);
  const service = (published.json() as { data: Record<string, string> }).data;

  const refused = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${unnamed}/allocate`,
    headers: authorised,
    payload: { published_service_id: service["id"] },
  });
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal((refused.json() as { error: { code: string } }).error.code, "AUTHORISATION_DENIED");

  const minted = await postgres.pool.query<{ count: string }>(
    "SELECT count(*) AS count FROM route_capabilities WHERE browser_session_id = $1",
    [unnamed],
  );
  assert.equal(minted.rows[0]?.count, "0", "a capability was minted for an unauthorised session");
});

test("a route from another project is absent, exactly as one that does not exist", async () => {
  const seeded = await seedProjectAndWorker(harness);
  const { projectId, organisationId } = seeded;

  // A second, complete project: its own connector, workspace and browser
  // session. The route has to be a *legitimate* route somewhere else, because a
  // route naming this session from another project can no longer be created at
  // all — publication resolves every named identifier inside the project it is
  // published in, so that attempt is refused before a row exists. What is left
  // to test here is the binder: a session reaching a route that is real, and
  // belongs to somebody else.
  const elsewhere = await seedProjectAndWorker(harness);
  const elsewhereSession = await reserveSession(elsewhere.projectId, elsewhere.organisationId);
  const published = await publish(elsewhere.projectId, [elsewhereSession], elsewhere);
  assert.equal(published.statusCode, 201, published.body);
  const service = (published.json() as { data: Record<string, string> }).data;

  // `seedProjectAndWorker` registers one worker under a fixed name, so seeding
  // the second project reassigned it away from the first. Both are named again
  // here so that reserving in the first project still works; what is under test
  // is the binder, not the assignment.
  await harness.built.app.inject({
    method: "PUT",
    url: `/api/v1/browser-workers/${seeded.workerId}/assignments`,
    headers: authorised,
    payload: { project_ids: [projectId, elsewhere.projectId] },
  });

  // A fresh reservation per attempt. A refused allocation now *ends* the
  // reservation (RVP-30): a `REQUESTED` row with `ended_at IS NULL` is what the
  // capacity query counts, so leaving it behind meant four refused starts filled
  // a worker and the project could start nothing. The consequence here is that
  // the second attempt has to reserve again, which is what a real caller does.
  const allocate = async (publishedServiceId: string) => {
    const reserved = await reserveSession(projectId, organisationId);
    return harness.built.app.inject({
      method: "POST",
      url: `/api/v1/browser-sessions/${reserved}/allocate`,
      headers: authorised,
      payload: { published_service_id: publishedServiceId },
    });
  };

  // The binder reads the route inside the session's project, so a route in
  // another project produces no row at all. That is why this is
  // RESOURCE_NOT_FOUND rather than the PROJECT_CONTEXT_MISMATCH it used to be:
  // `docs/API.md` section 5 requires a foreign identifier and an unknown one to
  // be indistinguishable, and a refusal that said "wrong project" would confirm
  // that the route exists. The equality below is the assertion — a status code
  // alone would not catch a message that differed.
  const foreign = await allocate(service["id"] as string);
  const unknown = await allocate("svc_does_not_exist_at_all");
  assert.equal(foreign.statusCode, 404, foreign.body);
  assert.equal(unknown.statusCode, 404, unknown.body);

  const normalise = (body: string): unknown => {
    const parsed = JSON.parse(body) as { meta?: { request_id?: string } };
    if (parsed.meta !== undefined) parsed.meta.request_id = "req_normalised";
    return parsed;
  };
  assert.deepEqual(normalise(foreign.body), normalise(unknown.body));
  assert.equal(
    (foreign.json() as { error: { code: string } }).error.code,
    "RESOURCE_NOT_FOUND",
  );

  // No capability was minted for the foreign route.
  const minted = await postgres.pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM route_capabilities WHERE published_service_id = $1",
    [service["id"]],
  );
  assert.equal(minted.rows[0]?.count, "0");
});

test("only a reserved session may be allocated", async () => {
  const seeded = await seedProjectAndWorker(harness);
  const { projectId, organisationId } = seeded;
  const sessionId = await reserveSession(projectId, organisationId);
  const first = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${sessionId}/allocate`,
    headers: authorised,
    payload: {},
  });
  assert.equal(first.statusCode, 200, first.body);

  const second = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${sessionId}/allocate`,
    headers: authorised,
    payload: {},
  });
  assert.equal(second.statusCode, 409, second.body);
  assert.equal(
    (second.json() as { error: { code: string } }).error.code,
    "BROWSER_SESSION_NOT_ACTIVE",
  );
});

test("a session allocated without a route reaches no origin at all", async () => {
  const seeded = await seedProjectAndWorker(harness);
  const { projectId, organisationId } = seeded;
  const sessionId = await reserveSession(projectId, organisationId);
  const allocated = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${sessionId}/allocate`,
    headers: authorised,
    payload: {},
  });
  assert.equal(allocated.statusCode, 200, allocated.body);
  const record = (allocated.json() as { data: Record<string, unknown> }).data;
  assert.equal(record["service_origin"], null);

  const allocation = harness.allocations.at(-1);
  assert.equal(allocation?.payload["service_origin"], undefined);
  assert.equal(
    allocation?.payload["service_capability"],
    undefined,
    "a session with no route must carry no capability",
  );
});
