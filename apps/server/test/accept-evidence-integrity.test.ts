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
 * interface, and the version check alone cannot be: the way to accept swapped
 * evidence is a client that re-reads the finding when the button is pressed and
 * sends the version it has just fetched rather than the version it rendered.
 * That is a natural thing to write, and it defeats everything the first three
 * tests prove.
 *
 * RVP-55 therefore added a second control, and the tests under **the pin**
 * below are about it: a decision names the verification it is about, and the
 * control plane refuses one that is no longer the finding's current claim
 * (ADR-0035). A re-read cannot produce the identifier the reviewer was shown —
 * it produces the *new* claim's identifier, which is refused from the other
 * direction — so the refetching client is closed here rather than only in the
 * browser. `apps/web/test/ui/review-workspace.browser.test.ts` proves the
 * client actually sends what it rendered, which is the half a server test still
 * cannot see.
 *
 * The third test is not decoration. A client that always sent a
 * stale-by-construction version would satisfy the second and be unable to
 * accept anything at all, so the pair asserts that the refusal is specific to a
 * superseded claim rather than general.
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

/** The claim a decision may currently be taken on, or null. */
async function currentVerificationId(findingId: string): Promise<string | null> {
  const rows = await postgres.pool.query<{ id: string }>(
    "SELECT id FROM verifications WHERE finding_id = $1 AND status = 'submitted'",
    [findingId],
  );
  return rows.rows[0]?.id ?? null;
}

/** One verification's stored status, read rather than inferred. */
async function verificationStatus(verificationId: string): Promise<string> {
  const rows = await postgres.pool.query<{ status: string }>(
    "SELECT status FROM verifications WHERE id = $1",
    [verificationId],
  );
  return rows.rows[0]?.status ?? "missing";
}

/** Events of one type for one finding, read from the store. */
async function eventsFor(type: string, findingId: string): Promise<Record<string, unknown>[]> {
  const rows = await postgres.pool.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM events
      WHERE type = $2 AND payload->>'finding_id' = $1
      ORDER BY sequence`,
    [findingId, type],
  );
  return rows.rows.map((row) => row.payload);
}

function accept(findingId: string, expectedVersion: number, verificationId?: string | null) {
  return harness.built.app.inject({
    method: "POST",
    url: `/api/v1/findings/${findingId}/accept`,
    headers: ADMIN,
    payload: {
      expected_version: expectedVersion,
      ...(verificationId === undefined || verificationId === null
        ? {}
        : { verification_id: verificationId }),
    },
  });
}

function reopen(
  findingId: string,
  expectedVersion: number,
  reason: string,
  verificationId?: string | null,
) {
  return harness.built.app.inject({
    method: "POST",
    url: `/api/v1/findings/${findingId}/reopen`,
    headers: ADMIN,
    payload: {
      expected_version: expectedVersion,
      reason,
      ...(verificationId === undefined || verificationId === null
        ? {}
        : { verification_id: verificationId }),
    },
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
  const claimShown = await currentVerificationId(fixture.findingId);

  const accepted = await accept(fixture.findingId, shownToReviewer, claimShown);

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

// ------------------------------------------------------------------- the pin
//
// The three tests above are about version arithmetic, and the docstring at the
// top of this file names the client shape that defeats it: one that re-reads
// the finding when the button is pressed. The tests below are about the control
// that survives that shape, because it is not arithmetic — the decision names
// the claim, and a re-read cannot supply the identifier the reviewer was shown
// (it returns the *new* claim's identifier, which this refuses from the other
// direction) (ADR-0035).

test("an accept refetching the version it sends is still refused after a swap", async () => {
  const fixture = await findingAwaitingReview();

  // What the comparison rendered from.
  const claimShown = await currentVerificationId(fixture.findingId);
  assert.notEqual(claimShown, null);

  // The agent swaps the evidence underneath the open comparison.
  await supersedeWithWeakerEvidence(fixture);

  // The defective client: it re-reads the finding to "get the current version"
  // and sends that, which is exactly what makes the version check useless. It
  // still sends the verification it rendered, because that is the only one it
  // has.
  const refetched = await currentVersion(fixture.findingId);
  const refused = await accept(fixture.findingId, refetched, claimShown);

  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(
    (refused.json() as { error: { code: string } }).error.code,
    "VERSION_CONFLICT",
    refused.body,
  );
  assert.deepEqual(
    await resolvedEvents(fixture.findingId),
    [],
    "a refused accept must not record a disposition",
  );
  assert.equal(await findingStatus(fixture.findingId), "AWAITING_HUMAN_REVIEW");
});

test("an accept naming no claim at all is refused while one is pending", async () => {
  const fixture = await findingAwaitingReview();
  const shownToReviewer = await currentVersion(fixture.findingId);

  const refused = await accept(fixture.findingId, shownToReviewer);

  assert.equal(refused.statusCode, 422, refused.body);
  const body = refused.json() as { error: { code: string; details?: { field?: string } } };
  assert.equal(body.error.code, "EVIDENCE_REQUIRED", refused.body);
  assert.equal(body.error.details?.field, "verification_id");
  assert.deepEqual(await resolvedEvents(fixture.findingId), []);
  assert.equal(await findingStatus(fixture.findingId), "AWAITING_HUMAN_REVIEW");

  // A refused decision is an attempt, and every refused transition is audited
  // (`docs/DOMAIN_MODEL.md` section 15).
  const denials = await eventsFor("finding.status_change_denied", fixture.findingId);
  assert.equal(denials.length, 1, "the refused decision is audited");
  assert.equal(denials[0]?.["requested"], "RESOLVED");
  assert.equal(denials[0]?.["code"], "EVIDENCE_REQUIRED");
});

test("accepting decides the claim it named, and the event says which", async () => {
  const fixture = await findingAwaitingReview();
  const shownToReviewer = await currentVersion(fixture.findingId);
  const claimShown = (await currentVerificationId(fixture.findingId)) as string;

  const accepted = await accept(fixture.findingId, shownToReviewer, claimShown);
  assert.equal(accepted.statusCode, 200, accepted.body);

  // The claim carries the decision on itself, with a human reviewer and a time
  // the database now requires (migration 0153).
  assert.equal(await verificationStatus(claimShown), "accepted");
  const decided = await postgres.pool.query<{
    reviewed_at: Date | null;
    reviewed_by_actor_type: string | null;
  }>("SELECT reviewed_at, reviewed_by_actor_type FROM verifications WHERE id = $1", [claimShown]);
  assert.notEqual(decided.rows[0]?.reviewed_at ?? null, null);
  assert.equal(decided.rows[0]?.reviewed_by_actor_type, "human_user");

  // And the trail names the evidence, which `finding.resolved` never did
  // (RVP-93).
  const events = await eventsFor("finding.verification_accepted", fixture.findingId);
  assert.equal(events.length, 1, "exactly one acceptance");
  assert.equal(events[0]?.["verification_id"], claimShown);
  assert.equal((events[0]?.["decided_by"] as { type?: string } | undefined)?.type, "human_user");
  assert.equal(
    (events[0]?.["submitted_by"] as { type?: string } | undefined)?.type,
    "agent_session",
  );
  assert.equal(events[0]?.["after_artefact_id"], fixture.afterArtefactId);

  // Nothing is current afterwards, so a second accept has no claim to name.
  assert.equal(await currentVerificationId(fixture.findingId), null);

  // The whole trail an accept leaves, read out of the event store rather than
  // described. RVP-93 was that this was answerable only by ordering.
  const trail = await postgres.pool.query<{ type: string; payload: Record<string, unknown> }>(
    `SELECT type, payload FROM events
      WHERE payload->>'finding_id' = $1 AND type LIKE 'finding.%'
      ORDER BY sequence`,
    [fixture.findingId],
  );
  for (const row of trail.rows) {
    process.stdout.write(`EVIDENCE event ${row.type} ${JSON.stringify(row.payload)}\n`);
  }
});

test("an accepted finding takes no further claim", async () => {
  const fixture = await findingAwaitingReview();
  const shownToReviewer = await currentVersion(fixture.findingId);
  const claimShown = (await currentVerificationId(fixture.findingId)) as string;

  assert.equal((await accept(fixture.findingId, shownToReviewer, claimShown)).statusCode, 200);

  // Accepting decides the claim, so nothing is `submitted` and a new
  // submission would insert as the current one rather than superseding
  // anything. Every surface reading "the latest verification" would then serve
  // an agent's post-hoc claim beside a human's acceptance of a different one.
  const refused = await harness.built.reviews
    .submitVerification(
      { organisationId: fixture.organisationId, projectId: fixture.projectId },
      fixture.findingId,
      {
        summary: "Post-acceptance claim.",
        branch: "redesign",
        commit: FIXED_COMMIT,
        testedViewports: MOBILE_ONLY,
        checks: WEAKER_CHECKS,
        artefactIds: [fixture.afterArtefactId],
        workspaceBranch: null,
      } as never,
      AGENT,
    )
    .then(() => null)
    .catch((error: unknown) => error as { code?: string; message?: string });

  assert.equal(refused?.code, "POLICY_DENIED", refused?.message ?? "the submission was accepted");
  // Nothing was written, and the claim a human accepted is still the one the
  // finding serves.
  assert.equal(await currentVerificationId(fixture.findingId), null);
  assert.equal(await verificationStatus(claimShown), "accepted");
  const claims = await postgres.pool.query<{ count: string }>(
    "SELECT count(*) AS count FROM verifications WHERE finding_id = $1",
    [fixture.findingId],
  );
  assert.equal(Number(claims.rows[0]?.count), 1);

  // The route answers the same way, so the rule is not a property of the
  // service method.
  const overHttp = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/findings/${fixture.findingId}/verifications`,
    headers: ADMIN,
    payload: {
      summary: "Post-acceptance claim over HTTP.",
      branch: "redesign",
      commit: FIXED_COMMIT,
      tested_viewports: MOBILE_ONLY,
      checks: WEAKER_CHECKS,
      artefact_ids: [fixture.afterArtefactId],
    },
  });
  assert.equal(overHttp.statusCode, 403, overHttp.body);
  assert.equal((overHttp.json() as { error: { code: string } }).error.code, "POLICY_DENIED");
});

test("a reopened finding takes a claim again", async () => {
  // The refusal above is about a decided finding, not about a finding that has
  // been decided once. Reopening is the human act that makes more work
  // possible, and an agent must be able to submit against the result — a rule
  // that stopped there would make a reopen a dead end.
  const fixture = await findingAwaitingReview();
  const shownToReviewer = await currentVersion(fixture.findingId);
  const claimShown = (await currentVerificationId(fixture.findingId)) as string;

  assert.equal(
    (await reopen(fixture.findingId, shownToReviewer, "Still overlaps at 390px.", claimShown))
      .statusCode,
    200,
  );

  const scope = { organisationId: fixture.organisationId, projectId: fixture.projectId };
  const resubmitted = await harness.built.reviews.submitVerification(
    scope,
    fixture.findingId,
    {
      summary: "Second attempt after the reopen.",
      branch: "redesign",
      commit: FIXED_COMMIT,
      testedViewports: BOTH_VIEWPORTS,
      checks: PASSING_CHECKS,
      artefactIds: [fixture.afterArtefactId],
      workspaceBranch: null,
    } as never,
    AGENT,
  );
  assert.equal(resubmitted.verification.status, "submitted");
  // And the rejected record is still there, which is what makes a repeatedly
  // reopened finding readable (`docs/DOMAIN_MODEL.md` section 19).
  assert.equal(await verificationStatus(claimShown), "rejected");
});

test("reopening rejects the claim it named and keeps the record", async () => {
  const fixture = await findingAwaitingReview();
  const shownToReviewer = await currentVersion(fixture.findingId);
  const claimShown = (await currentVerificationId(fixture.findingId)) as string;

  const reopened = await reopen(
    fixture.findingId,
    shownToReviewer,
    "The navigation still overlaps the logo at 390px.",
    claimShown,
  );
  assert.equal(reopened.statusCode, 200, reopened.body);
  assert.equal(await findingStatus(fixture.findingId), "REOPENED");

  // Rejected, not deleted: the history of what has been claimed before and
  // failed is what a human needs in order to judge the next claim
  // (`docs/DOMAIN_MODEL.md` section 19).
  assert.equal(await verificationStatus(claimShown), "rejected");
  const kept = await postgres.pool.query<{ count: string }>(
    "SELECT count(*) AS count FROM verifications WHERE finding_id = $1",
    [fixture.findingId],
  );
  assert.equal(Number(kept.rows[0]?.count), 1);

  const events = await eventsFor("finding.verification_rejected", fixture.findingId);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.["verification_id"], claimShown);
  assert.equal(events[0]?.["reason"], "The navigation still overlaps the logo at 390px.");
});

test("a reopen with no reason is refused when the request skips the form", async () => {
  const fixture = await findingAwaitingReview();
  const shownToReviewer = await currentVersion(fixture.findingId);
  const claimShown = await currentVerificationId(fixture.findingId);

  // Sent directly at the API, which is the only way to observe the rule: a form
  // that requires a field proves nothing about the server behind it
  // (`docs/SECURITY.md` section 7).
  const refused = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/findings/${fixture.findingId}/reopen`,
    headers: ADMIN,
    payload: {
      expected_version: shownToReviewer,
      ...(claimShown === null ? {} : { verification_id: claimShown }),
    },
  });

  assert.equal(refused.statusCode, 422, refused.body);
  const body = refused.json() as { error: { code: string; details?: { field?: string } } };
  assert.equal(body.error.code, "EVIDENCE_REQUIRED", refused.body);
  assert.equal(body.error.details?.field, "reason");
  assert.equal(await findingStatus(fixture.findingId), "AWAITING_HUMAN_REVIEW");
  assert.equal(await verificationStatus(claimShown as string), "submitted");

  // A whitespace reason is the same refusal: the rule is about a statement, not
  // about a field being present.
  const blank = await reopen(fixture.findingId, shownToReviewer, "   ", claimShown);
  assert.equal(blank.statusCode, 422, blank.body);
  assert.equal((blank.json() as { error: { code: string } }).error.code, "EVIDENCE_REQUIRED");
});

test("a decision's reason is readable as a comment, not only as an event payload", async () => {
  const fixture = await findingAwaitingReview();
  const shownToReviewer = await currentVersion(fixture.findingId);
  const claimShown = await currentVerificationId(fixture.findingId);

  const reopened = await reopen(
    fixture.findingId,
    shownToReviewer,
    "Still overlaps at 390px; the breakpoint moved the wrong way.",
    claimShown,
  );
  assert.equal(reopened.statusCode, 200, reopened.body);

  // `docs/UX_FLOWS.md` section 13 asks a reopen for a *comment*. An event
  // payload is not one: it is not in the discussion an agent reads, and the
  // whole point of requiring the statement is that somebody has to act on it
  // (ADR-0036).
  const comments = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/findings/${fixture.findingId}/comments`,
    headers: ADMIN,
  });
  assert.equal(comments.statusCode, 200, comments.body);
  const bodies = (comments.json() as { data: { body: string; created_by: { type: string } }[] })
    .data;
  const decision = bodies.find(
    (comment) => comment.body === "Still overlaps at 390px; the breakpoint moved the wrong way.",
  );
  assert.notEqual(decision, undefined, comments.body);
  assert.equal(decision?.created_by.type, "human_user");
});
