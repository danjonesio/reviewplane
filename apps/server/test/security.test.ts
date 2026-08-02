/**
 * Security tests (`docs/TESTING.md` section 10 "Isolation",
 * `docs/SECURITY.md` sections 6.3, 6.4 and 10).
 *
 * These are the negative cases: what a credential must not be able to do.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { encodeBrowserFrame } from "@reviewplane/protocol/browser";

import {
  BOOTSTRAP_TOKEN,
  WORKER_COMMAND_CREDENTIAL,
  WORKER_CREDENTIAL,
  seedProjectAndWorker,
  startHarness,
  type Harness,
} from "./support/worker-harness.ts";
import { startMigratedDatabase, truncateAll } from "./support/postgres.ts";
import type { MigratedDatabase } from "./support/postgres.ts";
import { newId } from "../src/ids.ts";

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

const ADMINISTRATIVE_ROUTES: readonly { method: "GET" | "POST" | "PUT"; url: string }[] = [
  { method: "POST", url: "/api/v1/organisations" },
  { method: "GET", url: "/api/v1/browser-workers" },
  { method: "GET", url: "/internal/v1/protocol" },
];

test("a worker credential cannot call the administrative API", async () => {
  await seedProjectAndWorker(harness);
  for (const route of ADMINISTRATIVE_ROUTES) {
    const response = await harness.built.app.inject({
      method: route.method,
      url: route.url,
      headers: { authorization: `Bearer ${WORKER_CREDENTIAL}` },
      ...(route.method === "GET" ? {} : { payload: { name: "x", slug: "x" } }),
    });
    assert.equal(response.statusCode, 403, `${route.method} ${route.url} was not refused`);
    assert.equal(
      (response.json() as { error: { code: string } }).error.code,
      "AUTHORISATION_DENIED",
      `${route.method} ${route.url} reported the wrong code`,
    );
  }
});

test("the worker command credential is not accepted by the control plane at all", async () => {
  await seedProjectAndWorker(harness);
  // The credential the control plane presents to the worker must not work in
  // the other direction: the two halves of the mutual authentication are
  // separate secrets.
  const response = await harness.built.app.inject({
    method: "GET",
    url: "/api/v1/browser-workers",
    headers: { authorization: `Bearer ${WORKER_COMMAND_CREDENTIAL}` },
  });
  assert.equal(response.statusCode, 401);
});

test("an unauthenticated request is refused before anything is looked up", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const response = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/artefacts/uploads`,
    payload: { kind: "screenshot", content_type: "image/png", size_bytes: 1, sha256: "a".repeat(64) },
  });
  assert.equal(response.statusCode, 401);
});

test("a worker cannot act for a project it is not assigned to", async () => {
  const { organisationId, workerId } = await seedProjectAndWorker(harness);
  const otherProject = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/organisations/${organisationId}/projects`,
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
    payload: { name: "Other", slug: "other-project" },
  });
  const otherProjectId = (otherProject.json() as { data: { id: string } }).data.id;

  const response = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${otherProjectId}/artefacts/uploads`,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}` },
    payload: {
      kind: "screenshot",
      content_type: "image/png",
      size_bytes: 10,
      sha256: "c".repeat(64),
      retention_class: "verification_evidence",
    },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(
    (response.json() as { error: { code: string } }).error.code,
    "PROJECT_CONTEXT_MISMATCH",
  );

  // And the same worker still works for the project it is assigned to.
  const assignments = await harness.built.app.inject({
    method: "PUT",
    url: `/api/v1/browser-workers/${workerId}/assignments`,
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
    payload: { project_ids: [otherProjectId] },
  });
  assert.equal(assignments.statusCode, 200);
  const afterAssignment = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${otherProjectId}/artefacts/uploads`,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}` },
    payload: {
      kind: "screenshot",
      content_type: "image/png",
      size_bytes: 10,
      sha256: "c".repeat(64),
      retention_class: "verification_evidence",
    },
  });
  assert.equal(afterAssignment.statusCode, 201);
});

test("a worker cannot report status for a session allocated elsewhere", async () => {
  const { projectId, organisationId, workerId } = await seedProjectAndWorker(harness);
  const started = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/browser-sessions`,
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
    payload: {
      organisation_id: organisationId,
      viewport: { width: 1440, height: 900, device_scale_factor: 1 },
    },
  });
  const sessionId = (started.json() as { data: { id: string } }).data.id;
  await postgres.pool.query("UPDATE browser_sessions SET worker_id = NULL WHERE id = $1", [
    sessionId,
  ]);

  const response = await harness.built.app.inject({
    method: "POST",
    url: `/internal/v1/browser-sessions/${sessionId}/status`,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}`, "content-type": "application/json" },
    payload: encodeBrowserFrame({
      envelope: {
        protocol_version: 1,
        message_id: newId("msg_"),
        type: "browser_session.status",
        sent_at: new Date().toISOString(),
        worker_id: workerId,
        browser_session_id: sessionId,
      },
      type: "browser_session.status",
      payload: { status: "TERMINATED", occurred_at: new Date().toISOString() },
    }),
  });
  assert.equal(response.statusCode, 403);
  assert.equal(
    (response.json() as { error: { code: string } }).error.code,
    "AUTHORISATION_DENIED",
  );
});

test("a worker with the Chromium sandbox disabled is refused registration", async () => {
  const response = await harness.built.app.inject({
    method: "POST",
    url: "/internal/v1/workers/register",
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}`, "content-type": "application/json" },
    payload: encodeBrowserFrame({
      envelope: {
        protocol_version: 1,
        message_id: newId("msg_"),
        type: "worker.register",
        sent_at: new Date().toISOString(),
      },
      type: "worker.register",
      payload: {
        worker_name: "unsandboxed-worker",
        worker_version: "0.1.0",
        browser_type: "chromium",
        browser_version: "143.0.7499.4",
        capacity: 1,
        labels: [],
        sandbox_enabled: false,
        started_at: new Date().toISOString(),
      },
    }),
  });
  assert.equal(response.statusCode, 403);
  assert.equal((response.json() as { error: { code: string } }).error.code, "POLICY_DENIED");
  const workers = await postgres.pool.query("SELECT 1 FROM browser_workers");
  assert.equal(workers.rows.length, 0);
});

test("a wrong worker credential cannot register a worker", async () => {
  const response = await harness.built.app.inject({
    method: "POST",
    url: "/internal/v1/workers/register",
    headers: { authorization: "Bearer not-the-worker-credential", "content-type": "application/json" },
    payload: encodeBrowserFrame({
      envelope: {
        protocol_version: 1,
        message_id: newId("msg_"),
        type: "worker.register",
        sent_at: new Date().toISOString(),
      },
      type: "worker.register",
      payload: {
        worker_name: "impostor",
        worker_version: "0.1.0",
        browser_type: "chromium",
        browser_version: "143.0.7499.4",
        capacity: 1,
        labels: [],
        sandbox_enabled: true,
        started_at: new Date().toISOString(),
      },
    }),
  });
  assert.equal(response.statusCode, 401);
});

test("a frame the schema refuses never reaches the domain", async () => {
  await seedProjectAndWorker(harness);
  const response = await harness.built.app.inject({
    method: "POST",
    url: "/internal/v1/workers/heartbeat",
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}`, "content-type": "application/json" },
    // capacity is outside its declared bound.
    payload: JSON.stringify({
      protocol_version: 1,
      message_id: "msg_bad",
      type: "worker.heartbeat",
      sent_at: new Date().toISOString(),
      worker_id: "wkr_x",
      payload: { active_sessions: 1, capacity: 9999, observed_at: new Date().toISOString() },
    }),
  });
  assert.equal(response.statusCode, 400);
});

test("the control plane presents its own credential to the worker, not the worker's", async () => {
  const { projectId, organisationId } = await seedProjectAndWorker(harness);
  await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/browser-sessions`,
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
    payload: {
      organisation_id: organisationId,
      viewport: { width: 390, height: 844, device_scale_factor: 2 },
    },
  });
  assert.ok(harness.workerRequests.length > 0);
  for (const request of harness.workerRequests) {
    assert.equal(request.authorization, `Bearer ${WORKER_COMMAND_CREDENTIAL}`);
    assert.notEqual(request.authorization, `Bearer ${WORKER_CREDENTIAL}`);
    assert.notEqual(request.authorization, `Bearer ${BOOTSTRAP_TOKEN}`);
  }
});
