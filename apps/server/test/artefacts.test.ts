/**
 * Artefact upload, verification and retrieval
 * (`docs/API.md` section 15, ADR-0012, `docs/TESTING.md` section 10
 * "Artefacts", section 11 "Artefact store unavailable").
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";

import {
  BOOTSTRAP_TOKEN,
  WORKER_CREDENTIAL,
  seedProjectAndWorker,
  startHarness,
  type Harness,
} from "./helpers/harness.ts";
import { startPostgres, truncateAll, type DisposablePostgres } from "./helpers/postgres.ts";

let postgres: DisposablePostgres;
let harness: Harness;

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
});

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000a49444154789c6300010000050001" +
    "0d0a2db40000000049454e44ae426082",
  "hex",
);

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Reading bytes back takes two steps now (ADR-0019): mint a short-lived grant
 * for one artefact, then read the grant's own path. There is no route that
 * serves an artefact from its identifier.
 */
async function readContent(artefactId: string, token = BOOTSTRAP_TOKEN) {
  const granted = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/grants`,
    headers: { authorization: `Bearer ${token}` },
  });
  if (granted.statusCode !== 201) return granted;
  const { url } = (granted.json() as { data: { url: string } }).data;
  return harness.built.app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function intent(projectId: string, overrides: Record<string, unknown> = {}) {
  return harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/artefacts/uploads`,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}` },
    payload: {
      kind: "screenshot",
      content_type: "image/png",
      size_bytes: PNG.byteLength,
      sha256: digest(PNG),
      retention_class: "verification_evidence",
      ...overrides,
    },
  });
}

test("an artefact becomes available only after the server verifies it", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const created = await intent(projectId);
  assert.equal(created.statusCode, 201);
  const { artefact_id: artefactId, upload_path: uploadPath } = (
    created.json() as { data: { artefact_id: string; upload_path: string } }
  ).data;

  const pending = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/artefacts/${artefactId}`,
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
  });
  assert.equal((pending.json() as { data: { state: string } }).data.state, "pending");

  // Content is not served for an unverified artefact: no grant can be minted
  // for one, so there is nothing to present at the content route.
  const early = await readContent(artefactId);
  assert.equal(early.statusCode, 409);
  assert.equal((early.json() as { error: { code: string } }).error.code, "ARTEFACT_UPLOAD_INCOMPLETE");

  const uploaded = await harness.built.app.inject({
    method: "POST",
    url: uploadPath,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}`, "content-type": "image/png" },
    payload: PNG,
  });
  assert.equal(uploaded.statusCode, 202);
  assert.equal((uploaded.json() as { data: { state: string } }).data.state, "uploaded");

  // Still not available: the bytes are stored but not yet verified.
  const beforeCompletion = await readContent(artefactId);
  assert.equal(beforeCompletion.statusCode, 409);

  const completed = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/complete`,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}` },
    payload: { sha256: digest(PNG), size_bytes: PNG.byteLength },
  });
  assert.equal(completed.statusCode, 200);
  const record = (completed.json() as { data: { state: string; sha256: string } }).data;
  assert.equal(record.state, "available");
  assert.equal(record.sha256, digest(PNG));

  const content = await readContent(artefactId);
  assert.equal(content.statusCode, 200);
  assert.equal(content.headers["content-type"], "image/png");
  assert.equal(content.headers["x-content-type-options"], "nosniff");
  assert.equal(content.headers["content-security-policy"], "default-src 'none'; sandbox");
  assert.equal(digest(content.rawPayload), digest(PNG));
});

test("a digest that does not match the stored bytes leaves the artefact unavailable", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const other = Buffer.concat([PNG, Buffer.from("tampered")]);
  const created = await intent(projectId, { sha256: digest(other), size_bytes: other.byteLength });
  const { artefact_id: artefactId, upload_path: uploadPath } = (
    created.json() as { data: { artefact_id: string; upload_path: string } }
  ).data;

  await harness.built.app.inject({
    method: "POST",
    url: uploadPath,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}`, "content-type": "image/png" },
    payload: PNG,
  });
  const completed = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/complete`,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}` },
    payload: { sha256: digest(other) },
  });
  assert.equal(completed.statusCode, 409);
  assert.equal(
    (completed.json() as { error: { code: string } }).error.code,
    "ARTEFACT_UPLOAD_INCOMPLETE",
  );

  const record = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/artefacts/${artefactId}`,
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
  });
  assert.equal((record.json() as { data: { state: string } }).data.state, "failed");
});

test("a completion digest that contradicts the intent is refused", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const created = await intent(projectId);
  const { artefact_id: artefactId, upload_path: uploadPath } = (
    created.json() as { data: { artefact_id: string; upload_path: string } }
  ).data;
  await harness.built.app.inject({
    method: "POST",
    url: uploadPath,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}`, "content-type": "image/png" },
    payload: PNG,
  });
  const completed = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/complete`,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}` },
    payload: { sha256: "b".repeat(64) },
  });
  assert.equal(completed.statusCode, 409);
});

test("the artefact store is unavailable: completion fails and nothing becomes available", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const created = await intent(projectId);
  const { artefact_id: artefactId, upload_path: uploadPath } = (
    created.json() as { data: { artefact_id: string; upload_path: string } }
  ).data;
  await harness.built.app.inject({
    method: "POST",
    url: uploadPath,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}`, "content-type": "image/png" },
    payload: PNG,
  });

  // The stored object disappears between upload and completion.
  await rm(harness.artefactRoot, { recursive: true, force: true });

  const completed = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/complete`,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}` },
    payload: { sha256: digest(PNG) },
  });
  assert.equal(completed.statusCode, 409);
  const record = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/artefacts/${artefactId}`,
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
  });
  assert.equal((record.json() as { data: { state: string } }).data.state, "failed");
});

test("artefact keys are content-addressed and carry no caller-supplied name", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const created = await intent(projectId, { kind: "screenshot" });
  const { artefact_id: artefactId, upload_path: uploadPath } = (
    created.json() as { data: { artefact_id: string; upload_path: string } }
  ).data;
  await harness.built.app.inject({
    method: "POST",
    url: uploadPath,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}`, "content-type": "image/png" },
    payload: PNG,
  });
  await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/complete`,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}` },
    payload: { sha256: digest(PNG) },
  });

  const stored = await postgres.pool.query<{ storage_key: string }>(
    "SELECT storage_key FROM artefacts WHERE id = $1",
    [artefactId],
  );
  const key = stored.rows[0]?.storage_key ?? "";
  assert.equal(key, `sha256/${digest(PNG).slice(0, 2)}/${digest(PNG).slice(2)}`);
  const shards = await readdir(`${harness.artefactRoot}/sha256`);
  assert.deepEqual(shards, [digest(PNG).slice(0, 2)]);
});

test("upload_started, upload_completed and screenshot.captured are all recorded", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const created = await intent(projectId);
  const { artefact_id: artefactId, upload_path: uploadPath } = (
    created.json() as { data: { artefact_id: string; upload_path: string } }
  ).data;
  await harness.built.app.inject({
    method: "POST",
    url: uploadPath,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}`, "content-type": "image/png" },
    payload: PNG,
  });
  await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/complete`,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}` },
    payload: { sha256: digest(PNG) },
  });

  const events = await postgres.pool.query<{ type: string; actor_type: string; sequence: string }>(
    "SELECT type, actor_type, sequence FROM events WHERE project_id = $1 ORDER BY sequence",
    [projectId],
  );
  const types = events.rows.map((row) => row.type);
  assert.ok(types.includes("artefact.upload_started"));
  assert.ok(types.includes("artefact.upload_completed"));
  assert.ok(types.includes("screenshot.captured"));
  for (const row of events.rows.filter((entry) => entry.type.startsWith("artefact."))) {
    assert.equal(row.actor_type, "browser_worker");
  }
  // Sequence is monotonic within the project stream.
  const sequences = events.rows.map((row) => Number(row.sequence));
  assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right));
  assert.equal(new Set(sequences).size, sequences.length);
});

test("an oversized or unsupported artefact intent is refused", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const wrongType = await intent(projectId, { content_type: "text/html" });
  assert.equal(wrongType.statusCode, 400);
  const oversized = await intent(projectId, { size_bytes: 999999999 });
  assert.equal(oversized.statusCode, 403);
  const badDigest = await intent(projectId, { sha256: "not-a-digest" });
  assert.equal(badDigest.statusCode, 400);
});
