/**
 * Inbox items and their HTTP endpoints (`docs/DOMAIN_MODEL.md` §21,
 * `docs/API.md` §16, RVP-49), against a real database.
 *
 * The agent half of the inbox is asserted through the real MCP client in
 * `apps/mcp-server/test/mcp.test.ts`. What is asserted here is the half a human
 * uses and the half that has to hold whichever caller arrives:
 *
 * * a delivery is written in the same transaction as the assignment that caused
 *   it, and a repeated assignment delivers once;
 * * acknowledgement and completion are different acts with different records;
 * * a state-changing route reachable by a session cookie demands the CSRF
 *   token, because completing or dismissing delivered feedback is the quietest
 *   possible way to make a review disappear;
 * * an agent credential cannot reach these routes at all;
 * * another project's item is not found, byte for byte as an unknown one is.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  BOOTSTRAP_TOKEN,
  WORKER_CREDENTIAL,
  seedProjectAndWorker,
  startHarness,
  type Harness,
} from "./support/worker-harness.ts";
import { claimSessionFor, type SessionCookies } from "./support/identity.ts";
import { encodePng, sha256 } from "./support/png.ts";
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
const COMMIT = "4a45b94f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60";
const SCREENSHOT = encodePng(780, 1688);

interface Fixture {
  readonly organisationId: string;
  readonly projectId: string;
  readonly reviewId: string;
  readonly reviewVersion: number;
  readonly agentSessionId: string;
}

/** A project, a READY review and an agent session to assign it to. */
async function seedFixture(slug = "bugs-on-homepage"): Promise<Fixture> {
  const { organisationId, projectId } = await seedProjectAndWorker(harness);
  const app = harness.built.app;

  const session = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/browser-sessions`,
    headers: ADMIN,
    payload: {
      organisation_id: organisationId,
      viewport: { width: 390, height: 844, device_scale_factor: 2 },
    },
  });
  const browserSessionId = (session.json() as { data: { id: string } }).data.id;

  const intent = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/artefacts/uploads`,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}` },
    payload: {
      kind: "screenshot",
      content_type: "image/png",
      size_bytes: SCREENSHOT.byteLength,
      sha256: sha256(SCREENSHOT),
      retention_class: "verification_evidence",
      browser_session_id: browserSessionId,
    },
  });
  const { artefact_id: artefactId, upload_path: uploadPath } = (
    intent.json() as { data: { artefact_id: string; upload_path: string } }
  ).data;
  await app.inject({
    method: "POST",
    url: uploadPath,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}`, "content-type": "image/png" },
    payload: SCREENSHOT,
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/complete`,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}` },
    payload: { sha256: sha256(SCREENSHOT), size_bytes: SCREENSHOT.byteLength },
  });

  const workspace = await app.inject({
    method: "PUT",
    url: `/api/v1/projects/${projectId}/workspaces`,
    headers: ADMIN,
    payload: { root_path: `/workspace/${slug}`, branch: "redesign", head_commit: COMMIT },
  });
  const workspaceId = (workspace.json() as { data: { id: string } }).data.id;

  const review = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/reviews`,
    headers: ADMIN,
    payload: {
      slug,
      title: "Bugs on homepage",
      status: "READY",
      priority: "high",
      captured_branch: "redesign",
      captured_commit: COMMIT,
      captured_workspace_id: workspaceId,
      source_browser_session_id: browserSessionId,
    },
  });
  const created = (review.json() as { data: { id: string; version: number } }).data;

  await app.inject({
    method: "POST",
    url: `/api/v1/reviews/${created.id}/findings`,
    headers: ADMIN,
    payload: {
      title: "Hero heading overlaps the navigation",
      severity: "high",
      url: "https://route-id.internal.invalid/",
      viewport: { width: 390, height: 844, device_scale_factor: 2 },
      scroll_position: { x: 0, y: 0 },
      captured_commit: COMMIT,
      screenshot_artefact_id: artefactId,
    },
  });

  // An agent session, as an MCP connection would create one.
  const credential = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/organisations/${organisationId}/agent-credentials`,
    headers: ADMIN,
    payload: { project_ids: [projectId], label: "claude-code" },
  });
  const credentialId = (credential.json() as { data: { credential_id: string } }).data
    .credential_id;
  const agentSessionId = `ags_${Math.random().toString(36).slice(2, 12)}`;
  await postgres.pool.query(
    `INSERT INTO agent_sessions
       (id, organisation_id, project_id, credential_id, agent_type, agent_version,
        capabilities, status)
     VALUES ($1,$2,$3,$4,'claude-code','test',ARRAY['review:read'],'ACTIVE')`,
    [agentSessionId, organisationId, projectId, credentialId],
  );

  return {
    organisationId,
    projectId,
    reviewId: created.id,
    reviewVersion: created.version,
    agentSessionId,
  };
}

async function assign(fixture: Fixture, version: number): Promise<number> {
  const response = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/reviews/${fixture.reviewId}/assign`,
    headers: ADMIN,
    payload: { expected_version: version, assigned_agent_session_id: fixture.agentSessionId },
  });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as { data: { version: number } }).data.version;
}

async function listInbox(fixture: Fixture): Promise<{
  items: { id: string; status: string; type: string; review_slug: string | null }[];
  pendingCount: number;
}> {
  const response = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/projects/${fixture.projectId}/inbox`,
    headers: ADMIN,
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as {
    data: { id: string; status: string; type: string; review_slug: string | null }[];
    meta: { pending_count: number };
  };
  return { items: body.data, pendingCount: body.meta.pending_count };
}

async function session(fixture: Fixture): Promise<SessionCookies> {
  return claimSessionFor(harness.built, postgres.pool, fixture.organisationId);
}

test("assignment delivers one inbox item, and assigning again delivers one", async () => {
  const fixture = await seedFixture();
  const version = await assign(fixture, fixture.reviewVersion);
  await assign(fixture, version);

  const inbox = await listInbox(fixture);
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0]?.type, "review_assigned");
  assert.equal(inbox.items[0]?.status, "pending");
  assert.equal(inbox.items[0]?.review_slug, "bugs-on-homepage");
  assert.equal(inbox.pendingCount, 1);

  const events = await postgres.pool.query(
    "SELECT type FROM events WHERE type = 'inbox_item.created'",
  );
  assert.equal(events.rowCount, 1, "one delivery, one audit record");
});

test("acknowledgement and completion are different acts with different records", async () => {
  const fixture = await seedFixture();
  await assign(fixture, fixture.reviewVersion);
  const inbox = await listInbox(fixture);
  const itemId = inbox.items[0]?.id as string;
  const cookies = await session(fixture);

  const acknowledged = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/inbox/${itemId}/acknowledge`,
    headers: cookies.writeHeaders,
  });
  assert.equal(acknowledged.statusCode, 200, acknowledged.body);
  const afterAck = (acknowledged.json() as {
    data: { status: string; acknowledged_at: string | null; completed_at: string | null };
  }).data;
  assert.equal(afterAck.status, "acknowledged");
  assert.ok(afterAck.acknowledged_at !== null);
  assert.equal(afterAck.completed_at, null, "acknowledgement is not completion");

  const completed = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/inbox/${itemId}/complete`,
    headers: cookies.writeHeaders,
  });
  assert.equal(completed.statusCode, 200, completed.body);
  const afterComplete = (completed.json() as {
    data: { status: string; acknowledged_at: string | null; completed_at: string | null };
  }).data;
  assert.equal(afterComplete.status, "completed");
  // Both timestamps survive: which of the two happened, and when, is the
  // question the durable record exists to answer.
  assert.ok(afterComplete.acknowledged_at !== null);
  assert.ok(afterComplete.completed_at !== null);

  const types = await postgres.pool.query<{ type: string }>(
    "SELECT type FROM events WHERE type LIKE 'inbox_item.%' ORDER BY sequence",
  );
  assert.deepEqual(
    types.rows.map((row) => row.type),
    ["inbox_item.created", "inbox_item.acknowledged", "inbox_item.completed"],
  );
});

test("a repeated acknowledgement acknowledges once", async () => {
  const fixture = await seedFixture();
  await assign(fixture, fixture.reviewVersion);
  const itemId = (await listInbox(fixture)).items[0]?.id as string;
  const cookies = await session(fixture);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await harness.built.app.inject({
      method: "POST",
      url: `/api/v1/inbox/${itemId}/acknowledge`,
      headers: cookies.writeHeaders,
    });
    assert.equal(response.statusCode, 200, response.body);
  }
  const events = await postgres.pool.query(
    "SELECT type FROM events WHERE type = 'inbox_item.acknowledged'",
  );
  assert.equal(events.rowCount, 1);
});

test("a state-changing inbox route refuses a cookie request with no CSRF token", async () => {
  const fixture = await seedFixture();
  await assign(fixture, fixture.reviewVersion);
  const itemId = (await listInbox(fixture)).items[0]?.id as string;
  const cookies = await session(fixture);

  for (const action of ["acknowledge", "complete", "dismiss"]) {
    const forged = await harness.built.app.inject({
      method: "POST",
      url: `/api/v1/inbox/${itemId}/${action}`,
      // The cookie a browser would attach on a cross-origin request, without
      // the header only same-origin script can set.
      headers: { cookie: cookies.readHeaders["cookie"] as string },
    });
    assert.equal(forged.statusCode, 403, `${action}: ${forged.body}`);
    assert.match(forged.body, /csrf/iu);
  }
  const rows = await postgres.pool.query<{ status: string }>(
    "SELECT status FROM inbox_items WHERE id = $1",
    [itemId],
  );
  assert.equal(rows.rows[0]?.status, "pending", "a forged request changed nothing");
});

test("an agent credential cannot reach the inbox API", async () => {
  const fixture = await seedFixture();
  await assign(fixture, fixture.reviewVersion);
  const itemId = (await listInbox(fixture)).items[0]?.id as string;

  const issued = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/organisations/${fixture.organisationId}/agent-credentials`,
    headers: ADMIN,
    payload: { project_ids: [fixture.projectId], label: "agent" },
  });
  const token = (issued.json() as { data: { token: string } }).data.token;

  for (const [method, url] of [
    ["GET", `/api/v1/projects/${fixture.projectId}/inbox`],
    ["POST", `/api/v1/inbox/${itemId}/acknowledge`],
    ["POST", `/api/v1/inbox/${itemId}/complete`],
  ] as const) {
    const response = await harness.built.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 403, `${method} ${url}: ${response.body}`);
    assert.match(response.body, /AUTHORISATION_DENIED/u);
  }
});

test("another project's inbox item is not found, exactly as an unknown one is", async () => {
  const mine = await seedFixture();
  const theirs = await seedFixture("somebody-elses-review");
  await assign(theirs, theirs.reviewVersion);
  const theirItem = (await listInbox(theirs)).items[0]?.id as string;

  const cookies = await claimSessionFor(harness.built, postgres.pool, mine.organisationId, {
    email: "scoped@localhost",
  });
  // The session is scoped to one project rather than the organisation, which is
  // what makes the comparison meaningful: an organisation-wide session would
  // pass the project term unconditionally and the test would prove nothing.
  await postgres.pool.query("UPDATE viewer_sessions SET project_ids = $1::text[]", [
    [mine.projectId],
  ]);

  const foreign = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/inbox/${theirItem}/acknowledge`,
    headers: cookies.writeHeaders,
  });
  const unknown = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/inbox/inb_doesnotexist/acknowledge`,
    headers: cookies.writeHeaders,
  });
  assert.equal(foreign.statusCode, unknown.statusCode);
  const strip = (body: string): string => body.replaceAll(/"request_id":"[^"]*"/gu, "");
  assert.equal(strip(foreign.body), strip(unknown.body));
});

test("an unknown inbox status on the listing is refused rather than ignored", async () => {
  const fixture = await seedFixture();
  const response = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/projects/${fixture.projectId}/inbox?status=whatever`,
    headers: ADMIN,
  });
  assert.equal(response.statusCode, 400, response.body);
});
