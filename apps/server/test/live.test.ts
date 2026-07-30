/**
 * The live-frame channel: authorisation, transport separation, fan-out, drop
 * behaviour, limits and the absence of any persisted frame.
 *
 * `docs/TESTING.md` sections 2, 9, 10 and 11 all land here. The negative
 * authorisation cases are first because they are the ones that must hold even
 * when everything else is broken: a refused viewer must never receive a frame,
 * and the refusal happens at the HTTP handshake, so it is observable as a
 * status code rather than as an absence of messages.
 */

import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";

import { encodeLiveViewFrame } from "@reviewplane/protocol/live-view";

import {
  BOOTSTRAP_TOKEN,
  seedProjectAndWorker,
  startHarness,
  type Harness,
} from "./helpers/harness.ts";
import { UpgradeRefused, connectLive, type LiveClient } from "./helpers/live-client.ts";
import { startPostgres, truncateAll, type DisposablePostgres } from "./helpers/postgres.ts";

let postgres: DisposablePostgres;
let harness: Harness;
let origin: string;

const DESKTOP = { width: 1440, height: 900, device_scale_factor: 1 };
const ALLOWED_ORIGIN = "https://reviewplane.test";

before(async () => {
  postgres = await startPostgres();
});

after(async () => {
  await harness?.stop();
  await postgres?.stop();
});

beforeEach(async () => {
  await harness?.stop();
  await truncateAll(postgres.pool);
  harness = await startHarness(postgres.pool);
  origin = await harness.listen();
});

async function startSession(projectId: string, organisationId: string): Promise<string> {
  const response = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/browser-sessions`,
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
    payload: {
      organisation_id: organisationId,
      viewport: DESKTOP,
      controller: { type: "agent", id: "ags_live_test" },
      service_origin: "https://route-live.internal.invalid",
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  return (response.json() as { data: { id: string } }).data.id;
}

/** Signs in as the bootstrap administrator and returns the cookie to present. */
async function administratorCookie(): Promise<string> {
  const response = await harness.built.app.inject({
    method: "POST",
    url: "/api/v1/auth/viewer-sessions",
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
  });
  assert.equal(response.statusCode, 201, response.body);
  const cookie = response.headers["set-cookie"];
  assert.ok(typeof cookie === "string");
  return cookie.split(";")[0] as string;
}

/** Mints a viewer session scoped to one project and returns its cookie. */
async function projectCookie(projectId: string): Promise<string> {
  const response = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/viewer-sessions`,
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
  });
  assert.equal(response.statusCode, 201, response.body);
  const token = (response.json() as { data: { token: string } }).data.token;
  return `reviewplane_viewer=${encodeURIComponent(token)}`;
}

async function seededSession(): Promise<{
  sessionId: string;
  projectId: string;
  organisationId: string;
}> {
  const seed = await seedProjectAndWorker(harness);
  const sessionId = await startSession(seed.projectId, seed.organisationId);
  return { sessionId, projectId: seed.projectId, organisationId: seed.organisationId };
}

// ---------------------------------------------------------------------------
// Authorisation (docs/TESTING.md sections 9 and 10)
// ---------------------------------------------------------------------------

test("an unauthenticated viewer is refused before any frame is sent", async () => {
  const { sessionId } = await seededSession();
  await assert.rejects(
    () => connectLive(origin, sessionId, { origin: ALLOWED_ORIGIN }),
    (error: unknown) => {
      assert.ok(error instanceof UpgradeRefused);
      assert.equal(error.status, 401);
      assert.match(error.body, /AUTHENTICATION_REQUIRED/u);
      return true;
    },
  );
  // Nothing reached the worker either: the producer is only started for a
  // viewer that got past authorisation.
  assert.equal(harness.live.opened.length, 0);
});

test("a viewer scoped to another project is refused before any frame is sent", async () => {
  const { sessionId } = await seededSession();
  const other = await harness.built.app.inject({
    method: "POST",
    url: "/api/v1/organisations",
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
    payload: { name: "Other", slug: "other-organisation" },
  });
  const otherOrganisation = (other.json() as { data: { id: string } }).data.id;
  const otherProject = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/organisations/${otherOrganisation}/projects`,
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
    payload: { name: "Other", slug: "other-project" },
  });
  const otherProjectId = (otherProject.json() as { data: { id: string } }).data.id;
  const cookie = await projectCookie(otherProjectId);

  await assert.rejects(
    () => connectLive(origin, sessionId, { origin: ALLOWED_ORIGIN, cookie }),
    (error: unknown) => {
      assert.ok(error instanceof UpgradeRefused);
      assert.equal(error.status, 403);
      assert.match(error.body, /PROJECT_CONTEXT_MISMATCH/u);
      return true;
    },
  );
  assert.equal(harness.live.opened.length, 0);
});

test("a viewer scoped to the owning project is accepted", async () => {
  const { sessionId, projectId } = await seededSession();
  const cookie = await projectCookie(projectId);
  const client = await connectLive(origin, sessionId, { origin: ALLOWED_ORIGIN, cookie });
  await client.waitFor((current) => current.messages.some((m) => m.type === "live.attached"));
  await client.close();
});

test("an unknown origin cannot open the live socket", async () => {
  const { sessionId } = await seededSession();
  const cookie = await administratorCookie();
  await assert.rejects(
    () => connectLive(origin, sessionId, { origin: "https://evil.example", cookie }),
    (error: unknown) => {
      assert.ok(error instanceof UpgradeRefused);
      assert.equal(error.status, 403);
      return true;
    },
  );
});

test("a terminated browser session refuses a live viewer", async () => {
  const { sessionId } = await seededSession();
  await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${sessionId}/terminate`,
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
  });
  const cookie = await administratorCookie();
  await assert.rejects(
    () => connectLive(origin, sessionId, { origin: ALLOWED_ORIGIN, cookie }),
    (error: unknown) => {
      assert.ok(error instanceof UpgradeRefused);
      assert.match(error.body, /BROWSER_SESSION_NOT_ACTIVE/u);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Transport (docs/API.md section 18.2)
// ---------------------------------------------------------------------------

test("frames arrive as metadata then a separate binary payload", async () => {
  const { sessionId } = await seededSession();
  const cookie = await administratorCookie();
  const client = await connectLive(origin, sessionId, { origin: ALLOWED_ORIGIN, cookie });
  await client.waitFor((current) => current.messages.some((m) => m.type === "live.attached"));
  await waitForWorkerStream();

  const payload = Buffer.from("ÿØÿnot-a-real-jpeg", "binary");
  harness.live.pushFrame(payload);
  await client.waitFor((current) => current.frames.length === 1);

  const frame = client.frames[0];
  assert.ok(frame !== undefined);
  assert.equal(frame.metadata.format, "image/jpeg");
  assert.equal(frame.metadata.byte_length, payload.byteLength);
  assert.deepEqual([...frame.payload], [...payload]);
  assert.equal(client.orphanPayloads, 0, "a payload arrived with no metadata before it");

  // The metadata message carries no image bytes of its own.
  const metadataMessage = client.messages.find((message) => message.type === "live.frame");
  assert.ok(metadataMessage !== undefined);
  assert.ok(
    !JSON.stringify(metadataMessage.payload).includes(payload.toString("base64")),
    "the image must not travel inside the JSON message",
  );
  await client.close();
});

test("the first messages state the session and the terms of the stream", async () => {
  const { sessionId, projectId } = await seededSession();
  const cookie = await administratorCookie();
  const client = await connectLive(origin, sessionId, { origin: ALLOWED_ORIGIN, cookie });
  await client.waitFor((current) => current.messages.some((m) => m.type === "live.attached"));

  const state = client.messages.find((message) => message.type === "live.session_state");
  assert.ok(state !== undefined, "the session state must arrive before frames");
  assert.equal(state.payload.viewport.width, 1440);

  const attached = client.messages.find((message) => message.type === "live.attached");
  assert.ok(attached !== undefined);
  assert.equal(attached.payload.project_id, projectId);
  // ADR-0009 on the wire: this stream advertises that its frames are kept
  // nowhere.
  assert.equal(attached.payload.retention, "never");
  await client.close();
});

test("the thumbnail mode is requested of the worker", async () => {
  const { sessionId } = await seededSession();
  const cookie = await administratorCookie();
  const client = await connectLive(origin, sessionId, {
    origin: ALLOWED_ORIGIN,
    cookie,
    mode: "thumbnail",
  });
  await client.waitFor((current) => current.messages.some((m) => m.type === "live.attached"));
  await waitForWorkerStream();
  assert.equal(harness.live.opened[0]?.mode, "thumbnail");
  await client.close();
});

// ---------------------------------------------------------------------------
// Fan-out and producer lifetime
// ---------------------------------------------------------------------------

test("two viewers share one worker stream", async () => {
  const { sessionId } = await seededSession();
  const cookie = await administratorCookie();
  const first = await connectLive(origin, sessionId, { origin: ALLOWED_ORIGIN, cookie });
  await first.waitFor((current) => current.messages.some((m) => m.type === "live.attached"));
  await waitForWorkerStream();
  const second = await connectLive(origin, sessionId, { origin: ALLOWED_ORIGIN, cookie });
  await second.waitFor((current) => current.messages.some((m) => m.type === "live.attached"));

  assert.equal(harness.live.opened.length, 1, "a second viewer must not start a second capture");

  harness.live.pushFrame(Buffer.alloc(64, 1));
  await first.waitFor((current) => current.frames.length === 1);
  await second.waitFor((current) => current.frames.length === 1);

  await first.close();
  await second.close();
});

test("the producer stops when the last viewer leaves", async () => {
  const { sessionId } = await seededSession();
  const cookie = await administratorCookie();
  const first = await connectLive(origin, sessionId, { origin: ALLOWED_ORIGIN, cookie });
  await first.waitFor((current) => current.messages.some((m) => m.type === "live.attached"));
  await waitForWorkerStream();
  const second = await connectLive(origin, sessionId, { origin: ALLOWED_ORIGIN, cookie });
  await second.waitFor((current) => current.messages.some((m) => m.type === "live.attached"));

  await first.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(harness.live.open, "one viewer remains, so capture continues");

  await second.close();
  const deadline = Date.now() + 2000;
  while (harness.live.open && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(harness.live.open, false, "capture must stop when nobody is watching");
});

test("a worker stream that ends produces an actionable failure state", async () => {
  const { sessionId } = await seededSession();
  const cookie = await administratorCookie();
  const client = await connectLive(origin, sessionId, { origin: ALLOWED_ORIGIN, cookie });
  await client.waitFor((current) => current.messages.some((m) => m.type === "live.attached"));
  await waitForWorkerStream();

  harness.live.endStream();
  await client.waitFor((current) => current.messages.some((m) => m.type === "live.error"));
  const failure = client.messages.find((message) => message.type === "live.error");
  assert.ok(failure !== undefined);
  // docs/UX_FLOWS.md section 18: a named cause, not "something went wrong".
  assert.equal(failure.payload.state, "browser_worker_failed");
  assert.equal(failure.payload.retryable, true);
  await client.close();
});

test("a session whose live capture is refused keeps the session usable", async () => {
  const { sessionId } = await seededSession();
  harness.live.refuseWith = 503;
  const cookie = await administratorCookie();
  const client = await connectLive(origin, sessionId, { origin: ALLOWED_ORIGIN, cookie });
  await client.waitFor((current) => current.messages.some((m) => m.type === "live.error"));
  const failure = client.messages.find((message) => message.type === "live.error");
  assert.equal(failure?.payload.state, "live_capture_unavailable");

  // The session itself is untouched: a command still runs.
  const command = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${sessionId}/commands`,
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
    payload: {
      control_epoch: 1,
      controller: { type: "agent", id: "ags_live_test" },
      command: {
        command: "navigate",
        timeout_ms: 5000,
        navigate: { url: "/", wait_until: "load" },
      },
    },
  });
  assert.equal(command.statusCode, 200, command.body);
  await client.close();
});

// ---------------------------------------------------------------------------
// Limits (docs/API.md section 19)
// ---------------------------------------------------------------------------

test("a fifth viewer on one session is rate limited", async () => {
  const { sessionId } = await seededSession();
  const cookie = await administratorCookie();
  const clients: LiveClient[] = [];
  for (let index = 0; index < 4; index += 1) {
    const client = await connectLive(origin, sessionId, { origin: ALLOWED_ORIGIN, cookie });
    await client.waitFor((current) => current.messages.some((m) => m.type === "live.attached"));
    clients.push(client);
  }
  await assert.rejects(
    () => connectLive(origin, sessionId, { origin: ALLOWED_ORIGIN, cookie }),
    (error: unknown) => {
      assert.ok(error instanceof UpgradeRefused);
      assert.equal(error.status, 429);
      assert.match(error.body, /RATE_LIMITED/u);
      return true;
    },
  );
  for (const client of clients) await client.close();
});

test("a flood of client messages is refused rather than relayed", async () => {
  const { sessionId } = await seededSession();
  const cookie = await administratorCookie();
  const client = await connectLive(origin, sessionId, { origin: ALLOWED_ORIGIN, cookie });
  await client.waitFor((current) => current.messages.some((m) => m.type === "live.attached"));
  await waitForWorkerStream();

  const request = encodeLiveViewFrame({
    envelope: {
      protocol_version: 1,
      message_id: "msg_flood",
      type: "live.quality_request",
      sent_at: new Date().toISOString(),
      browser_session_id: sessionId,
    },
    type: "live.quality_request",
    payload: { mode: "thumbnail", requested_at: new Date().toISOString() },
  });
  for (let index = 0; index < 40; index += 1) client.send(request);

  await client.waitFor((current) =>
    current.messages.some(
      (message) => message.type === "live.error" && message.payload.state === "viewer_rate_limited",
    ),
  );
  // The throttle also means the worker was not asked forty times.
  assert.ok(
    harness.live.qualityRequests.length <= 2,
    `relayed ${String(harness.live.qualityRequests.length)} quality requests`,
  );
  await client.close();
});

test("a quality request reaches the worker and its decision reaches the viewer", async () => {
  const { sessionId } = await seededSession();
  const cookie = await administratorCookie();
  const client = await connectLive(origin, sessionId, { origin: ALLOWED_ORIGIN, cookie });
  await client.waitFor((current) => current.messages.some((m) => m.type === "live.attached"));
  await waitForWorkerStream();

  client.send(
    encodeLiveViewFrame({
      envelope: {
        protocol_version: 1,
        message_id: "msg_quality",
        type: "live.quality_request",
        sent_at: new Date().toISOString(),
        browser_session_id: sessionId,
      },
      type: "live.quality_request",
      payload: { mode: "thumbnail", max_fps: 5, requested_at: new Date().toISOString() },
    }),
  );
  await client.waitFor((current) => current.messages.some((m) => m.type === "live.quality"));
  assert.equal(harness.live.qualityRequests.length, 1);
  await client.close();
});

// ---------------------------------------------------------------------------
// Frame lifetime (ADR-0009, docs/SECURITY.md section 14)
// ---------------------------------------------------------------------------

test("a sustained viewing session persists no frame anywhere", async () => {
  const { sessionId, projectId } = await seededSession();
  const cookie = await administratorCookie();
  const client = await connectLive(origin, sessionId, { origin: ALLOWED_ORIGIN, cookie });
  await client.waitFor((current) => current.messages.some((m) => m.type === "live.attached"));
  await waitForWorkerStream();

  // A distinctive byte pattern, so a search for it is meaningful.
  const marker = Buffer.from("REVIEWPLANE-LIVE-FRAME-MARKER");
  for (let index = 0; index < 120; index += 1) {
    harness.live.pushFrame(Buffer.concat([marker, Buffer.alloc(4096, index % 251)]));
  }
  await client.waitFor((current) => current.frames.length >= 100, 10000);
  await client.close();

  // 1. The artefact store is untouched.
  const entries = await readdir(harness.artefactRoot).catch(() => []);
  assert.deepEqual(entries, [], "the artefact store must hold nothing after live viewing");

  // 2. No artefact row exists.
  const artefacts = await postgres.pool.query<{ count: string }>(
    "SELECT count(*) AS count FROM artefacts",
  );
  assert.equal(Number(artefacts.rows[0]?.count ?? 0), 0);

  // 3. No event payload carries frame bytes, and the audit records that a
  //    human watched without recording what they saw. Both events are awaited
  //    before the payloads are read: they are written on their own
  //    transactions, so reading first would be a race rather than a check.
  await waitForEvent(projectId, "browser.live_view_started");
  await waitForEvent(projectId, "browser.live_view_stopped");
  const events = await postgres.pool.query<{ type: string; payload: unknown }>(
    "SELECT type, payload FROM events WHERE project_id = $1 ORDER BY sequence",
    [projectId],
  );
  for (const row of events.rows) {
    assert.ok(
      !JSON.stringify(row.payload).includes(marker.toString("utf8")),
      `event ${row.type} carried frame content`,
    );
    assert.ok(!JSON.stringify(row.payload).includes("base64"));
  }

  // 4. No table anywhere holds the marker.
  const columns = await postgres.pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type IN ('text', 'jsonb', 'bytea', 'character varying')`,
  );
  for (const column of columns.rows) {
    const found = await postgres.pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM "${column.table_name}" WHERE "${column.column_name}"::text LIKE $1`,
      [`%${marker.toString("utf8")}%`],
    );
    assert.equal(
      Number(found.rows[0]?.count ?? 0),
      0,
      `${column.table_name}.${column.column_name} holds live frame content`,
    );
  }
});

test("the audit records who watched and for how many frames", async () => {
  const { sessionId, projectId } = await seededSession();
  const cookie = await administratorCookie();
  const client = await connectLive(origin, sessionId, { origin: ALLOWED_ORIGIN, cookie });
  await client.waitFor((current) => current.messages.some((m) => m.type === "live.attached"));
  await waitForWorkerStream();
  harness.live.pushFrame(Buffer.alloc(32, 7));
  await client.waitFor((current) => current.frames.length === 1);
  await client.close();

  const stopped = await waitForEvent(projectId, "browser.live_view_stopped");
  const payload = stopped as { frames_sent?: number };
  assert.equal(payload.frames_sent, 1);
});

// ---------------------------------------------------------------------------
// Viewer sessions
// ---------------------------------------------------------------------------

test("the viewer session cookie is HTTP-only and same-site", async () => {
  const response = await harness.built.app.inject({
    method: "POST",
    url: "/api/v1/auth/viewer-sessions",
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
  });
  const cookie = response.headers["set-cookie"];
  assert.ok(typeof cookie === "string");
  assert.match(cookie, /HttpOnly/u);
  assert.match(cookie, /SameSite=Strict/u);
});

test("a worker credential cannot mint a viewer session", async () => {
  const response = await harness.built.app.inject({
    method: "POST",
    url: "/api/v1/auth/viewer-sessions",
    headers: { authorization: "Bearer worker-credential-for-tests" },
  });
  assert.equal(response.statusCode, 403);
});

test("a revoked viewer session cannot open a live stream", async () => {
  const { sessionId } = await seededSession();
  const cookie = await administratorCookie();
  await harness.built.app.inject({
    method: "DELETE",
    url: "/api/v1/auth/viewer-sessions/current",
    headers: { cookie },
  });
  await assert.rejects(
    () => connectLive(origin, sessionId, { origin: ALLOWED_ORIGIN, cookie }),
    (error: unknown) => {
      assert.ok(error instanceof UpgradeRefused);
      assert.equal(error.status, 401);
      return true;
    },
  );
});

test("a project-scoped viewer sees only its own project", async () => {
  const seed = await seedProjectAndWorker(harness);
  const cookie = await projectCookie(seed.projectId);
  const response = await harness.built.app.inject({
    method: "GET",
    url: "/api/v1/projects",
    headers: { cookie },
  });
  assert.equal(response.statusCode, 200);
  const projects = (response.json() as { data: { id: string }[] }).data;
  assert.deepEqual(
    projects.map((project) => project.id),
    [seed.projectId],
  );
});

// ---------------------------------------------------------------------------

async function waitForWorkerStream(timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!harness.live.open) {
    if (Date.now() > deadline) throw new Error("the worker live stream never opened");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForEvent(
  projectId: string,
  type: string,
  timeoutMs = 3000,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await postgres.pool.query<{ payload: unknown }>(
      "SELECT payload FROM events WHERE project_id = $1 AND type = $2 ORDER BY sequence DESC LIMIT 1",
      [projectId, type],
    );
    const row = rows.rows[0];
    if (row !== undefined) return row.payload;
    if (Date.now() > deadline) throw new Error(`event ${type} was never recorded`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
