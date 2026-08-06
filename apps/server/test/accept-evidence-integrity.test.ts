/**
 * The evidence a human accepts is the evidence they were shown
 * (RVP-55, RVP-89, `docs/UX_FLOWS.md` §13, `docs/DOMAIN_MODEL.md` §15 and §19).
 *
 * A finding at `AWAITING_HUMAN_REVIEW` got there by passing the completion
 * gate. An agent may then submit a **second, weaker** verification: supersession
 * accepts it, `latestVerification` becomes the new claim, and the status does
 * not move (RVP-89). `GET /verification` is what the review workspace renders,
 * so a reviewer who opened the comparison before the swap and accepts after it
 * would be accepting a claim they were never shown.
 *
 * What stops that is optimistic concurrency, and it works only because of two
 * facts this file pins:
 *
 *   1. **a superseding submission moves the finding's version**, so the swap is
 *      visible to a version check at all; and
 *   2. **an accept carrying a superseded version is refused and writes
 *      nothing** — no disposition, no `finding.resolved`.
 *
 * Both are properties of the control plane. Neither is a property of the user
 * interface, and this file cannot test the interface: the remaining way to
 * accept swapped evidence is a client that re-reads the finding when the button
 * is pressed and sends the version it has just fetched rather than the version
 * it rendered. That is a natural thing to write, it defeats everything below,
 * and catching it needs a browser test in RVP-55 that opens the comparison,
 * lets an agent supersede underneath it, and then presses Accept.
 *
 * The second test is not decoration. A client that always sent a
 * stale-by-construction version would satisfy the first test and be unable to
 * accept anything at all, so the pair asserts that the refusal is specific to a
 * superseded version rather than general.
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
const CAPTURED_COMMIT = "4a45b94f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60";
const FIXED_COMMIT = "b4c5d6e7f809192a3b4c5d6e7f809192a3b4c5d6";

/** The two viewports `AGENTS.md` requires, which are the Stage 1 gate. */
const BOTH_VIEWPORTS = [
  { width: 390, height: 844, device_scale_factor: 2 },
  { width: 1440, height: 900, device_scale_factor: 1 },
];
const MOBILE_ONLY = [{ width: 390, height: 844, device_scale_factor: 2 }];

const PASSING_CHECKS = {
  reproduced_before: true,
  console_errors_reviewed: true,
  network_failures_reviewed: true,
};

/** The claim a replacement submission makes: weaker on every axis. */
const WEAKER_CHECKS = {
  reproduced_before: false,
  console_errors_reviewed: false,
  network_failures_reviewed: false,
};

const AGENT = { type: "agent_session" as const, id: "ags_test", display: "claude-code" };

interface Fixture {
  readonly organisationId: string;
  readonly projectId: string;
  readonly reviewId: string;
  readonly findingId: string;
  readonly afterArtefactId: string;
}

async function uploadScreenshot(
  projectId: string,
  browserSessionId: string,
  bytes: Buffer,
): Promise<string> {
  const app = harness.built.app;
  const intent = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/artefacts/uploads`,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}` },
    payload: {
      kind: "screenshot",
      content_type: "image/png",
      size_bytes: bytes.byteLength,
      sha256: sha256(bytes),
      retention_class: "verification_evidence",
      browser_session_id: browserSessionId,
      filename: "capture.png",
    },
  });
  assert.equal(intent.statusCode, 201, intent.body);
  const { artefact_id: artefactId, upload_path: uploadPath } = (
    intent.json() as { data: { artefact_id: string; upload_path: string } }
  ).data;

  await app.inject({
    method: "POST",
    url: uploadPath,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}`, "content-type": "image/png" },
    payload: bytes,
  });
  const completed = await app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/complete`,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}` },
    payload: { sha256: sha256(bytes), size_bytes: bytes.byteLength },
  });
  assert.equal(completed.statusCode, 200, completed.body);
  return artefactId;
}

/** A finding at `AWAITING_HUMAN_REVIEW`, reached the way an agent reaches it. */
async function findingAwaitingReview(): Promise<Fixture> {
  const { organisationId, projectId } = await seedProjectAndWorker(harness);
  const app = harness.built.app;
  const reviews = harness.built.reviews;
  const scope = { organisationId, projectId };

  const session = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/browser-sessions`,
    headers: ADMIN,
    payload: {
      organisation_id: organisationId,
      viewport: { width: 390, height: 844, device_scale_factor: 2 },
    },
  });
  assert.equal(session.statusCode, 201, session.body);
  const browserSessionId = (session.json() as { data: { id: string } }).data.id;

  const beforeArtefactId = await uploadScreenshot(projectId, browserSessionId, encodePng(780, 1688));
  const afterArtefactId = await uploadScreenshot(projectId, browserSessionId, encodePng(781, 1688));

  const review = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/reviews`,
    headers: ADMIN,
    payload: {
      slug: "bugs-on-homepage",
      title: "Bugs on homepage",
      captured_branch: "feat/homepage-refresh",
      captured_commit: CAPTURED_COMMIT,
      captured_workspace_id: "wsp_refresh_dev",
      source_browser_session_id: browserSessionId,
    },
  });
  assert.equal(review.statusCode, 201, review.body);
  const reviewId = (review.json() as { data: { id: string } }).data.id;

  const finding = await app.inject({
    method: "POST",
    url: `/api/v1/reviews/${reviewId}/findings`,
    headers: ADMIN,
    payload: {
      title: "Hero heading overlaps the basket button",
      severity: "high",
      url: "https://route-01jhomepage.internal.invalid/",
      viewport: { width: 390, height: 844, device_scale_factor: 2 },
      scroll_position: { x: 0, y: 320 },
      captured_commit: CAPTURED_COMMIT,
      screenshot_artefact_id: beforeArtefactId,
    },
  });
  assert.equal(finding.statusCode, 201, finding.body);
  const findingId = (finding.json() as { data: { finding: { id: string } } }).data.finding.id;

  await reviews.updateFinding(scope, findingId, { expectedVersion: 1, status: "CLAIMED" }, AGENT);
  await reviews.updateFinding(scope, findingId, { expectedVersion: 2, status: "IN_PROGRESS" }, AGENT);

  await reviews.submitVerification(
    scope,
    findingId,
    {
      summary: "Changed the navigation collapse breakpoint to 900px.",
      branch: "redesign",
      commit: FIXED_COMMIT,
      testedViewports: BOTH_VIEWPORTS,
      checks: PASSING_CHECKS,
      artefactIds: [afterArtefactId],
      workspaceBranch: null,
    } as never,
    AGENT,
  );
  const moved = await reviews.updateFinding(
    scope,
    findingId,
    { expectedVersion: await currentVersion(findingId), status: "AWAITING_HUMAN_REVIEW" },
    AGENT,
  );
  assert.equal(moved.status, "AWAITING_HUMAN_REVIEW");

  return { organisationId, projectId, reviewId, findingId, afterArtefactId };
}

async function currentVersion(findingId: string): Promise<number> {
  const rows = await postgres.pool.query<{ version: number }>(
    "SELECT version FROM findings WHERE id = $1",
    [findingId],
  );
  return Number(rows.rows[0]?.version ?? 0);
}

async function findingStatus(findingId: string): Promise<string> {
  const rows = await postgres.pool.query<{ status: string }>(
    "SELECT status FROM findings WHERE id = $1",
    [findingId],
  );
  return rows.rows[0]?.status ?? "missing";
}

/** Disposition events for one finding, read from the store rather than inferred. */
async function resolvedEvents(findingId: string): Promise<Record<string, unknown>[]> {
  const rows = await postgres.pool.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM events
      WHERE type = 'finding.resolved' AND payload->>'finding_id' = $1
      ORDER BY sequence`,
    [findingId],
  );
  return rows.rows.map((row) => row.payload);
}

/** The agent replaces the evidence with a claim that would not pass the gate. */
async function supersedeWithWeakerEvidence(fixture: Fixture): Promise<void> {
  await harness.built.reviews.submitVerification(
    { organisationId: fixture.organisationId, projectId: fixture.projectId },
    fixture.findingId,
    {
      summary: "Adjusted the breakpoint again.",
      branch: "redesign",
      commit: FIXED_COMMIT,
      testedViewports: MOBILE_ONLY,
      checks: WEAKER_CHECKS,
      artefactIds: [fixture.afterArtefactId],
      workspaceBranch: null,
    } as never,
    AGENT,
  );
}

function accept(findingId: string, expectedVersion: number) {
  return harness.built.app.inject({
    method: "POST",
    url: `/api/v1/findings/${findingId}/accept`,
    headers: ADMIN,
    payload: { expected_version: expectedVersion },
  });
}

// ---------------------------------------------------------------------------

test("evidence superseded under a pending review moves the finding's version", async () => {
  const fixture = await findingAwaitingReview();
  const shown = await currentVersion(fixture.findingId);

  await supersedeWithWeakerEvidence(fixture);

  const afterSwap = await currentVersion(fixture.findingId);
  assert.ok(
    afterSwap > shown,
    `a superseding submission must move the version, or no version check can see the swap: ${String(shown)} -> ${String(afterSwap)}`,
  );

  // RVP-89: the status does not move, which is why the version is the only
  // signal available to a reviewer's accept. If RVP-89 is resolved by returning
  // the finding to FIXED_UNVERIFIED, this assertion is the one to update — the
  // two below stay correct either way.
  assert.equal(await findingStatus(fixture.findingId), "AWAITING_HUMAN_REVIEW");
});

test("an accept carrying the version the reviewer was shown is refused after a swap, and writes nothing", async () => {
  const fixture = await findingAwaitingReview();

  // What the review workspace rendered.
  const shownToReviewer = await currentVersion(fixture.findingId);

  // The agent swaps the evidence while the comparison is open.
  await supersedeWithWeakerEvidence(fixture);

  // The reviewer presses Accept. The version travelling with it is the one the
  // comparison was rendered from, which is the whole point.
  const refused = await accept(fixture.findingId, shownToReviewer);

  assert.equal(refused.statusCode, 409, refused.body);
  // RVP-89 option 2 (returning the finding to FIXED_UNVERIFIED on supersession)
  // would change this code without changing the outcome; the assertions that
  // follow are the ones that must hold under either design.
  assert.equal(
    (refused.json() as { error: { code: string } }).error.code,
    "VERSION_CONFLICT",
    refused.body,
  );

  // Nothing was written. Asserted against the event store rather than inferred
  // from the status code, because a refusal that still recorded a disposition
  // is exactly the failure this test exists to catch.
  assert.deepEqual(
    await resolvedEvents(fixture.findingId),
    [],
    "a refused accept must not record a disposition",
  );
  assert.equal(
    await findingStatus(fixture.findingId),
    "AWAITING_HUMAN_REVIEW",
    "a refused accept must leave the finding where it was",
  );
});

test("an accept with no interleaving succeeds the first time", async () => {
  const fixture = await findingAwaitingReview();
  const shownToReviewer = await currentVersion(fixture.findingId);

  const accepted = await accept(fixture.findingId, shownToReviewer);

  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(await findingStatus(fixture.findingId), "RESOLVED");

  const resolved = await resolvedEvents(fixture.findingId);
  assert.equal(resolved.length, 1, "exactly one disposition");
  assert.equal(resolved[0]?.["disposition"], "RESOLVED");
  // The decision is a human's, and the record says whose.
  assert.equal(
    (resolved[0]?.["decided_by"] as { type?: string } | undefined)?.type,
    "human_user",
  );
});
