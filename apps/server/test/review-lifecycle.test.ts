/**
 * The review and finding lifecycle against a real database (RVP-37).
 *
 * `docs/TESTING.md` section 2 "Component", section 4 "Domain", section 9 "API",
 * section 10 "Security" and section 11 "Fault injection". The unit half of the
 * authority rules is in `review-domain.test.ts`, where it runs without a
 * database; this file proves the same rules hold through the transport, the
 * transaction and the audit trail — which is the part a caller can actually
 * reach.
 *
 * The suite prints the API transcripts and the event sequence the issue asks
 * for as evidence, so a reader can see the authority boundary holding rather
 * than take it on trust.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { decodeReviewEvent } from "@reviewplane/protocol/review";

import { main } from "../src/cli.ts";

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
  harness = await startHarness(postgres.pool, { runJobs: true });
});

const ADMIN = { authorization: `Bearer ${BOOTSTRAP_TOKEN}` };
const COMMIT = "4a45b94f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60";
const SCREENSHOT = encodePng(780, 1688);

/** The actor the bootstrap administrator writes as. */
const HUMAN = { type: "human_user" as const, id: "bootstrap", display: "bootstrap administrator" };

interface Fixture {
  readonly organisationId: string;
  readonly projectId: string;
  readonly browserSessionId: string;
  readonly artefactId: string;
}

async function seedFixture(): Promise<Fixture> {
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
  assert.equal(session.statusCode, 201, session.body);
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
      filename: "homepage.png",
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
    payload: SCREENSHOT,
  });
  const completed = await app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/complete`,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}` },
    payload: { sha256: sha256(SCREENSHOT), size_bytes: SCREENSHOT.byteLength },
  });
  assert.equal(completed.statusCode, 200, completed.body);
  return { organisationId, projectId, browserSessionId, artefactId };
}

function scopeOf(fixture: Fixture): { organisationId: string; projectId: string } {
  return { organisationId: fixture.organisationId, projectId: fixture.projectId };
}

async function createReview(
  fixture: Fixture,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; version: number; slug: string; priority?: string }> {
  const created = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${fixture.projectId}/reviews`,
    headers: ADMIN,
    payload: {
      slug: "bugs-on-homepage",
      title: "Bugs on homepage",
      captured_branch: "feat/homepage-refresh",
      captured_commit: COMMIT,
      captured_workspace_id: "wsp_refresh_dev",
      source_browser_session_id: fixture.browserSessionId,
      ...overrides,
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  return (created.json() as { data: { id: string; version: number; slug: string } }).data;
}

async function createFinding(
  fixture: Fixture,
  reviewId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; version: number; source: string; status: string }> {
  const created = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/reviews/${reviewId}/findings`,
    headers: ADMIN,
    payload: {
      title: "Hero heading overlaps the basket button",
      severity: "high",
      url: "https://route-01jhomepage.internal.invalid/",
      viewport: { width: 390, height: 844, device_scale_factor: 2 },
      scroll_position: { x: 0, y: 320 },
      captured_commit: COMMIT,
      screenshot_artefact_id: fixture.artefactId,
      ...overrides,
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  return (created.json() as { data: { finding: { id: string; version: number; source: string; status: string } } })
    .data.finding;
}

/** Every event of one type on a project stream, oldest first. */
async function eventsOfType(
  projectId: string,
  type: string,
): Promise<{ payload: Record<string, unknown>; actor_type: string }[]> {
  const rows = await postgres.pool.query<{
    payload: Record<string, unknown>;
    actor_type: string;
  }>("SELECT payload, actor_type FROM events WHERE stream_key = $1 AND type = $2 ORDER BY sequence", [
    projectId,
    type,
  ]);
  return rows.rows;
}

async function eventTypes(projectId: string): Promise<string[]> {
  const rows = await postgres.pool.query<{ type: string }>(
    "SELECT type FROM events WHERE stream_key = $1 ORDER BY sequence",
    [projectId],
  );
  return rows.rows.map((row) => row.type);
}

// ---------------------------------------------------------------- lifecycle

test("a review carries a priority and moves through its documented lifecycle", async () => {
  const fixture = await seedFixture();
  const review = await createReview(fixture, { priority: "critical" });
  assert.equal(review.priority, "critical");

  const app = harness.built.app;
  const assigned = await app.inject({
    method: "POST",
    url: `/api/v1/reviews/${review.id}/assign`,
    headers: ADMIN,
    payload: { expected_version: review.version, reason: "for the homepage rework" },
  });
  // DRAFT is not READY, so the claim does not move the status; the assignment
  // is still recorded because who owns the work is a separate fact.
  assert.equal(assigned.statusCode, 200, assigned.body);

  const ready = await app.inject({
    method: "PATCH",
    url: `/api/v1/reviews/${review.id}`,
    headers: ADMIN,
    payload: { expected_version: 2, status: "READY" },
  });
  assert.equal(ready.statusCode, 200, ready.body);

  const toUser = await app.inject({
    method: "POST",
    url: `/api/v1/reviews/${review.id}/assign`,
    headers: ADMIN,
    payload: { expected_version: 3 },
  });
  assert.equal(toUser.statusCode, 200, toUser.body);
  assert.equal((toUser.json() as { data: { status: string } }).data.status, "ASSIGNED");

  const started = await app.inject({
    method: "PATCH",
    url: `/api/v1/reviews/${review.id}`,
    headers: ADMIN,
    payload: { expected_version: 4, status: "IN_PROGRESS" },
  });
  assert.equal(started.statusCode, 200, started.body);

  const submitted = await app.inject({
    method: "POST",
    url: `/api/v1/reviews/${review.id}/request-review`,
    headers: ADMIN,
    payload: { expected_version: 5, reason: "ready for a look" },
  });
  assert.equal(submitted.statusCode, 200, submitted.body);
  assert.equal(
    (submitted.json() as { data: { status: string } }).data.status,
    "AWAITING_HUMAN_REVIEW",
  );

  const accepted = await app.inject({
    method: "POST",
    url: `/api/v1/reviews/${review.id}/accept`,
    headers: ADMIN,
    payload: { expected_version: 6 },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal((accepted.json() as { data: { status: string } }).data.status, "ACCEPTED");

  const reopened = await app.inject({
    method: "POST",
    url: `/api/v1/reviews/${review.id}/reopen`,
    headers: ADMIN,
    payload: { expected_version: 7, reason: "the basket is still hidden at 390x844" },
  });
  assert.equal(reopened.statusCode, 200, reopened.body);
  const reopenedReview = (reopened.json() as {
    data: { status: string; reopen_count: number; closed_at?: string };
  }).data;
  assert.equal(reopenedReview.status, "CHANGES_REQUESTED");
  assert.equal(reopenedReview.reopen_count, 1);
  // Reopening makes the review writable again, so it is no longer closed.
  assert.equal(reopenedReview.closed_at, undefined);

  const events = await eventTypes(fixture.projectId);
  for (const expected of [
    "review.created",
    "review.named",
    "review.assigned",
    "review.status_changed",
    "review.accepted",
    "review.reopened",
  ]) {
    assert.ok(events.includes(expected), `${expected} was never recorded: ${events.join(", ")}`);
  }

  const acceptance = await eventsOfType(fixture.projectId, "review.accepted");
  assert.equal(acceptance.length, 1);
  assert.equal(acceptance[0]?.actor_type, "human_user");
  assert.deepEqual(acceptance[0]?.payload["accepted_by"], HUMAN);

  const reopens = await eventsOfType(fixture.projectId, "review.reopened");
  assert.equal(reopens[0]?.payload["reopen_count"], 1);
  assert.equal(reopens[0]?.payload["from"], "ACCEPTED");
});

test("archiving records what the review was archived from, and keeps its findings", async () => {
  const fixture = await seedFixture();
  const review = await createReview(fixture);
  const finding = await createFinding(fixture, review.id);

  const cancelled = await harness.built.app.inject({
    method: "PATCH",
    url: `/api/v1/reviews/${review.id}`,
    headers: ADMIN,
    payload: { expected_version: review.version, status: "CANCELLED" },
  });
  assert.equal(cancelled.statusCode, 200, cancelled.body);

  const archived = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/reviews/${review.id}/archive`,
    headers: ADMIN,
    payload: { expected_version: 2, reason: "superseded" },
  });
  assert.equal(archived.statusCode, 200, archived.body);

  const events = await eventsOfType(fixture.projectId, "review.archived");
  assert.equal(events[0]?.payload["from"], "CANCELLED");

  // Archival is not deletion (`docs/DOMAIN_MODEL.md` section 6).
  const stillThere = await postgres.pool.query("SELECT id FROM findings WHERE id = $1", [
    finding.id,
  ]);
  assert.equal(stillThere.rowCount, 1);
});

test("a review cannot be accepted while a human-authored finding is outstanding", async () => {
  const fixture = await seedFixture();
  const review = await createReview(fixture);
  const finding = await createFinding(fixture, review.id);
  assert.equal(finding.source, "human");

  const reviews = harness.built.reviews;
  const scope = scopeOf(fixture);
  await reviews.updateReview(scope, review.id, { expectedVersion: 1, status: "READY" }, HUMAN);
  await reviews.updateReview(scope, review.id, { expectedVersion: 2, status: "ASSIGNED" }, HUMAN);
  await reviews.updateReview(scope, review.id, { expectedVersion: 3, status: "IN_PROGRESS" }, HUMAN);
  await reviews.updateReview(
    scope,
    review.id,
    { expectedVersion: 4, status: "AWAITING_HUMAN_REVIEW" },
    HUMAN,
  );

  const refused = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/reviews/${review.id}/accept`,
    headers: ADMIN,
    payload: { expected_version: 5 },
  });
  assert.equal(refused.statusCode, 403, refused.body);
  const body = refused.json() as { error: { code: string; details?: Record<string, unknown> } };
  assert.equal(body.error.code, "POLICY_DENIED");
  assert.match(String(body.error.details?.["reason"]), new RegExp(finding.id, "u"));

  // Waiving it is a decision, and it unblocks acceptance.
  const waived = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/findings/${finding.id}/wont-fix`,
    headers: ADMIN,
    payload: { expected_version: finding.version, reason: "out of scope for this release" },
  });
  assert.equal(waived.statusCode, 200, waived.body);

  const accepted = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/reviews/${review.id}/accept`,
    headers: ADMIN,
    payload: { expected_version: 5 },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const acceptance = await eventsOfType(fixture.projectId, "review.accepted");
  assert.equal(acceptance[0]?.payload["human_finding_count"], 1);
});

test("waiving a finding without a reason is refused", async () => {
  const fixture = await seedFixture();
  const review = await createReview(fixture);
  const finding = await createFinding(fixture, review.id);
  const refused = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/findings/${finding.id}/wont-fix`,
    headers: ADMIN,
    payload: { expected_version: finding.version },
  });
  assert.equal(refused.statusCode, 422, refused.body);
  assert.equal((refused.json() as { error: { code: string } }).error.code, "EVIDENCE_REQUIRED");
});

// ----------------------------------------------------------------- findings

test("a finding travels open to awaiting human review and every step is evented", async () => {
  const fixture = await seedFixture();
  const review = await createReview(fixture);
  const finding = await createFinding(fixture, review.id);
  const scope = scopeOf(fixture);
  const reviews = harness.built.reviews;
  const agent = { type: "agent_session" as const, id: "ags_claude", display: "Claude Code" };

  await reviews.claimFinding(scope, finding.id, 1, agent);
  await reviews.updateFinding(scope, finding.id, { expectedVersion: 2, status: "IN_PROGRESS" }, agent);
  await reviews.updateFinding(
    scope,
    finding.id,
    {
      expectedVersion: 3,
      status: "FIXED_UNVERIFIED",
      resolutionNote: "Raised the collapse breakpoint to 900px.",
    },
    agent,
  );
  const submitted = await reviews.updateFinding(
    scope,
    finding.id,
    { expectedVersion: 4, status: "AWAITING_HUMAN_REVIEW" },
    agent,
  );
  assert.equal(submitted.status, "AWAITING_HUMAN_REVIEW");

  const transitions = (await eventsOfType(fixture.projectId, "finding.status_changed")).map(
    (event) => `${String(event.payload["from"])} -> ${String(event.payload["to"])}`,
  );
  assert.deepEqual(transitions, [
    "OPEN -> CLAIMED",
    "CLAIMED -> IN_PROGRESS",
    "IN_PROGRESS -> FIXED_UNVERIFIED",
    "FIXED_UNVERIFIED -> AWAITING_HUMAN_REVIEW",
  ]);
  process.stdout.write(`EVIDENCE finding transitions: ${transitions.join(", ")}\n`);

  // The claim is its own fact, recorded beside the status change.
  const claims = await eventsOfType(fixture.projectId, "finding.claimed");
  assert.equal(claims.length, 1);
  assert.deepEqual(claims[0]?.payload["claimed_by"], {
    type: "agent_session",
    id: "ags_claude",
    display: "Claude Code",
  });
});

test("a human accepting a finding records the decision, not only the status", async () => {
  const fixture = await seedFixture();
  const review = await createReview(fixture);
  const finding = await createFinding(fixture, review.id);
  const scope = scopeOf(fixture);
  const reviews = harness.built.reviews;

  await reviews.updateFinding(scope, finding.id, { expectedVersion: 1, status: "CLAIMED" }, HUMAN);
  await reviews.updateFinding(scope, finding.id, { expectedVersion: 2, status: "IN_PROGRESS" }, HUMAN);
  await reviews.updateFinding(
    scope,
    finding.id,
    { expectedVersion: 3, status: "FIXED_UNVERIFIED", resolutionNote: "Fixed." },
    HUMAN,
  );
  await reviews.updateFinding(
    scope,
    finding.id,
    { expectedVersion: 4, status: "AWAITING_HUMAN_REVIEW" },
    HUMAN,
  );

  const accepted = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/findings/${finding.id}/accept`,
    headers: ADMIN,
    payload: { expected_version: 5, reason: "checked at 390x844 and 1440x900" },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal((accepted.json() as { data: { status: string } }).data.status, "RESOLVED");

  const decided = await eventsOfType(fixture.projectId, "finding.resolved");
  assert.equal(decided.length, 1);
  assert.equal(decided[0]?.payload["disposition"], "RESOLVED");
  assert.equal(decided[0]?.payload["source"], "human");
  assert.deepEqual(decided[0]?.payload["decided_by"], HUMAN);

  // Reopening preserves prior history rather than clearing it.
  const reopened = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/findings/${finding.id}/reopen`,
    headers: ADMIN,
    payload: { expected_version: 6, reason: "still reproduces on iOS Safari" },
  });
  assert.equal(reopened.statusCode, 200, reopened.body);
  assert.equal((reopened.json() as { data: { status: string } }).data.status, "REOPENED");
  const reopens = await eventsOfType(fixture.projectId, "finding.reopened");
  assert.equal(reopens[0]?.payload["from"], "RESOLVED");
  assert.equal(reopens[0]?.payload["verification_count"], 0);

  // The resolution bookkeeping is cleared, so a reopened finding is not
  // reported as decided by somebody who has since changed their mind.
  const row = await postgres.pool.query<{ resolved_at: Date | null; reopen_count: number }>(
    "SELECT resolved_at, reopen_count FROM findings WHERE id = $1",
    [finding.id],
  );
  assert.equal(row.rows[0]?.resolved_at, null);
  assert.equal(Number(row.rows[0]?.reopen_count), 1);
});

test("a duplicate must name another finding in the same project", async () => {
  const fixture = await seedFixture();
  const review = await createReview(fixture);
  const first = await createFinding(fixture, review.id);
  const second = await createFinding(fixture, review.id, { title: "The same thing again" });

  const itself = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/findings/${second.id}/wont-fix`,
    headers: ADMIN,
    payload: {
      expected_version: second.version,
      reason: "duplicate",
      duplicate_of_finding_id: second.id,
    },
  });
  assert.equal(itself.statusCode, 400, itself.body);

  const marked = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/findings/${second.id}/wont-fix`,
    headers: ADMIN,
    payload: {
      expected_version: second.version,
      reason: "duplicate of the first report",
      duplicate_of_finding_id: first.id,
    },
  });
  assert.equal(marked.statusCode, 200, marked.body);
  assert.equal((marked.json() as { data: { status: string } }).data.status, "DUPLICATE");
  const decided = await eventsOfType(fixture.projectId, "finding.resolved");
  assert.equal(decided[0]?.payload["duplicate_of_finding_id"], first.id);
});

// ------------------------------------------------------------------ comments

test("comments are append-only, attributed to the actor, and keep their history", async () => {
  const fixture = await seedFixture();
  const review = await createReview(fixture);
  const finding = await createFinding(fixture, review.id);
  const app = harness.built.app;

  const onReview = await app.inject({
    method: "POST",
    url: `/api/v1/reviews/${review.id}/comments`,
    headers: ADMIN,
    payload: { body: "Work the critical findings first." },
  });
  assert.equal(onReview.statusCode, 201, onReview.body);
  const reviewComment = (onReview.json() as { data: Record<string, unknown> }).data;
  assert.deepEqual(reviewComment["created_by"], HUMAN);
  assert.equal(reviewComment["finding_id"], undefined);
  assert.equal(reviewComment["revision"], 1);

  const onFinding = await app.inject({
    method: "POST",
    url: `/api/v1/findings/${finding.id}/comments`,
    headers: ADMIN,
    payload: { body: "Reproduced at 390x844." },
  });
  assert.equal(onFinding.statusCode, 201, onFinding.body);
  assert.equal(
    (onFinding.json() as { data: { finding_id: string } }).data.finding_id,
    finding.id,
  );

  // Two event types, so a consumer filtering a finding's timeline does not have
  // to inspect a payload to know whether an event belongs to it.
  assert.equal((await eventsOfType(fixture.projectId, "review.comment_added")).length, 1);
  assert.equal((await eventsOfType(fixture.projectId, "finding.comment_added")).length, 1);

  const edited = await app.inject({
    method: "PATCH",
    url: `/api/v1/comments/${String(reviewComment["id"])}`,
    headers: ADMIN,
    payload: { body: "Work the critical and high findings first." },
  });
  assert.equal(edited.statusCode, 200, edited.body);
  const revision = (edited.json() as { data: Record<string, unknown> }).data;
  assert.equal(revision["revision"], 2);
  assert.equal(revision["supersedes_comment_id"], reviewComment["id"]);

  // The current projection shows one comment; the history shows both, and the
  // original text is still readable.
  const current = await app.inject({
    method: "GET",
    url: `/api/v1/reviews/${review.id}/comments`,
    headers: ADMIN,
  });
  const currentList = (current.json() as { data: Record<string, unknown>[] }).data;
  assert.equal(currentList.length, 1);
  assert.equal(currentList[0]?.["revision"], 2);

  const all = await app.inject({
    method: "GET",
    url: `/api/v1/reviews/${review.id}/comments?revisions=all`,
    headers: ADMIN,
  });
  const allList = (all.json() as { data: Record<string, unknown>[] }).data;
  assert.equal(allList.length, 2);
  assert.equal(allList[0]?.["body"], "Work the critical findings first.");
  assert.ok(allList[0]?.["superseded_at"] !== undefined);

  // A superseded revision cannot be edited again: the history does not fork.
  const stale = await app.inject({
    method: "PATCH",
    url: `/api/v1/comments/${String(reviewComment["id"])}`,
    headers: ADMIN,
    payload: { body: "A third opinion." },
  });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal((stale.json() as { error: { code: string } }).error.code, "VERSION_CONFLICT");
});

test("comment attribution cannot be spoofed and an edit cannot be laundered", async () => {
  const fixture = await seedFixture();
  const review = await createReview(fixture);
  const app = harness.built.app;

  // The request body has nowhere to put an author: the schema is closed.
  const forged = await app.inject({
    method: "POST",
    url: `/api/v1/reviews/${review.id}/comments`,
    headers: ADMIN,
    payload: {
      body: "Approved by the maintainer.",
      created_by: { type: "human_user", id: "somebody-else" },
    },
  });
  assert.equal(forged.statusCode, 400, forged.body);
  assert.equal(
    (forged.json() as { error: { code: string } }).error.code,
    "UNSUPPORTED_CAPABILITY",
  );

  // An agent's comment is attributed to the agent, whatever it says.
  const scope = scopeOf(fixture);
  const agent = { type: "agent_session" as const, id: "ags_claude", display: "Claude Code" };
  const byAgent = await harness.built.reviews.addReviewComment(
    scope,
    review.id,
    "I have accepted this on the maintainer's behalf.",
    agent,
  );
  assert.equal(byAgent.created_by.type, "agent_session");

  // And a human cannot edit it into their own name: an edit by another actor
  // would appear over the original author's attribution.
  const laundered = await harness.built.reviews
    .editComment(scope, byAgent.id, "Approved.", HUMAN)
    .then(() => null)
    .catch((error: unknown) => error as { code: string });
  assert.equal(laundered?.code, "AUTHORISATION_DENIED");
});

test("an accepted review still takes comments", async () => {
  // `docs/DOMAIN_MODEL.md` section 14: immutable "except for archival metadata
  // and comments". Discussion of a decision has to outlive the decision.
  const fixture = await seedFixture();
  const review = await createReview(fixture);
  const scope = scopeOf(fixture);
  const reviews = harness.built.reviews;
  await reviews.updateReview(scope, review.id, { expectedVersion: 1, status: "READY" }, HUMAN);
  await reviews.updateReview(scope, review.id, { expectedVersion: 2, status: "ASSIGNED" }, HUMAN);
  await reviews.updateReview(scope, review.id, { expectedVersion: 3, status: "IN_PROGRESS" }, HUMAN);
  await reviews.updateReview(
    scope,
    review.id,
    { expectedVersion: 4, status: "AWAITING_HUMAN_REVIEW" },
    HUMAN,
  );
  await reviews.acceptReview(scope, review.id, { expectedVersion: 5 }, HUMAN);

  const commented = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/reviews/${review.id}/comments`,
    headers: ADMIN,
    payload: { body: "Accepted; the remaining nits are tracked separately." },
  });
  assert.equal(commented.statusCode, 201, commented.body);
});

// ------------------------------------------------------------------ security

test("an agent credential cannot accept a finding through the review API", async () => {
  const fixture = await seedFixture();
  const review = await createReview(fixture);
  const finding = await createFinding(fixture, review.id);

  const issued = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/organisations/${fixture.organisationId}/agent-credentials`,
    headers: ADMIN,
    payload: {
      project_ids: [fixture.projectId],
      capabilities: ["review:read", "review:write", "finding:read", "finding:write"],
      label: "test agent",
    },
  });
  assert.equal(issued.statusCode, 201, issued.body);
  const token = (issued.json() as { data: { token: string } }).data.token;

  for (const path of ["accept", "wont-fix", "reopen"]) {
    const denied = await harness.built.app.inject({
      method: "POST",
      url: `/api/v1/findings/${finding.id}/${path}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { expected_version: finding.version, reason: "done" },
    });
    assert.equal(denied.statusCode, 403, `${path}: ${denied.body}`);
    assert.equal(
      (denied.json() as { error: { code: string } }).error.code,
      "AUTHORISATION_DENIED",
      denied.body,
    );
    process.stdout.write(`EVIDENCE agent ${path} denial: 403 AUTHORISATION_DENIED\n`);
  }

  // Nothing moved.
  const unchanged = await postgres.pool.query<{ status: string; version: number }>(
    "SELECT status, version FROM findings WHERE id = $1",
    [finding.id],
  );
  assert.equal(unchanged.rows[0]?.status, "OPEN");
  assert.equal(Number(unchanged.rows[0]?.version), 1);
});

test("an agent actor is refused in the domain layer and the attempt is audited", async () => {
  // The exit criterion. The route above refuses an agent credential at the
  // transport; this is the path the MCP server takes, which reaches the domain
  // with an `agent_session` actor and no HTTP request at all.
  const fixture = await seedFixture();
  const review = await createReview(fixture);
  const finding = await createFinding(fixture, review.id);
  const scope = scopeOf(fixture);
  const reviews = harness.built.reviews;
  const agent = { type: "agent_session" as const, id: "ags_claude", display: "Claude Code" };

  // The agent takes the finding as far as it is allowed to, so that every
  // final disposition below is a *legal* transition and the refusal is about
  // authority rather than about the shape of the status machine.
  await reviews.claimFinding(scope, finding.id, 1, agent);
  await reviews.updateFinding(scope, finding.id, { expectedVersion: 2, status: "IN_PROGRESS" }, agent);
  await reviews.updateFinding(
    scope,
    finding.id,
    { expectedVersion: 3, status: "FIXED_UNVERIFIED", resolutionNote: "Fixed." },
    agent,
  );
  await reviews.updateFinding(
    scope,
    finding.id,
    { expectedVersion: 4, status: "AWAITING_HUMAN_REVIEW" },
    agent,
  );

  for (const status of ["RESOLVED", "WONT_FIX", "DUPLICATE"] as const) {
    const denial = await reviews
      .updateFinding(scope, finding.id, { expectedVersion: 5, status }, agent)
      .then(() => null)
      .catch((error: unknown) => error as { code: string; message: string });
    assert.equal(denial?.code, "AUTHORISATION_DENIED", `an agent reached ${status}`);
  }

  const audited = await eventsOfType(fixture.projectId, "finding.status_change_denied");
  assert.equal(audited.length, 3);
  for (const event of audited) {
    assert.equal(event.actor_type, "agent_session");
    assert.equal(event.payload["code"], "AUTHORISATION_DENIED");
    assert.equal(event.payload["source"], "human");
    assert.equal(event.payload["from"], "AWAITING_HUMAN_REVIEW");
  }

  // And the finding did not move.
  assert.equal((await reviews.getFinding(scope, finding.id)).status, "AWAITING_HUMAN_REVIEW");
  process.stdout.write(
    `EVIDENCE audited denials: ${audited.map((event) => String(event.payload["requested"])).join(", ")}\n`,
  );

  // And the same for a review an agent tries to accept.
  await reviews.updateReview(scope, review.id, { expectedVersion: 1, status: "READY" }, HUMAN);
  await reviews.updateReview(scope, review.id, { expectedVersion: 2, status: "ASSIGNED" }, HUMAN);
  await reviews.updateReview(scope, review.id, { expectedVersion: 3, status: "IN_PROGRESS" }, HUMAN);
  await reviews.updateReview(
    scope,
    review.id,
    { expectedVersion: 4, status: "AWAITING_HUMAN_REVIEW" },
    HUMAN,
  );
  const refused = await reviews
    .acceptReview(scope, review.id, { expectedVersion: 5 }, agent)
    .then(() => null)
    .catch((error: unknown) => error as { code: string });
  assert.equal(refused?.code, "AUTHORISATION_DENIED");
  const reviewDenials = await eventsOfType(fixture.projectId, "review.status_change_denied");
  assert.equal(reviewDenials.length, 1);
  assert.equal(reviewDenials[0]?.payload["requested"], "ACCEPTED");
});

test("a client-supplied source is refused rather than honoured", async () => {
  const fixture = await seedFixture();
  const review = await createReview(fixture);

  const forged = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/reviews/${review.id}/findings`,
    headers: ADMIN,
    payload: {
      title: "Something an agent wants to close itself",
      severity: "low",
      source: "agent",
      url: "https://route-01jhomepage.internal.invalid/",
      viewport: { width: 390, height: 844, device_scale_factor: 2 },
      scroll_position: { x: 0, y: 0 },
      captured_commit: COMMIT,
      screenshot_artefact_id: fixture.artefactId,
    },
  });
  assert.equal(forged.statusCode, 400, forged.body);
  assert.equal(
    (forged.json() as { error: { code: string } }).error.code,
    "UNSUPPORTED_CAPABILITY",
  );

  // A finding created by a human is human-authored; one created by an agent is
  // agent-authored, and neither is a choice the caller made.
  const byHuman = await createFinding(fixture, review.id);
  assert.equal(byHuman.source, "human");

  const byAgent = await harness.built.reviews.createFinding(
    scopeOf(fixture),
    review.id,
    {
      title: "An agent's own note",
      severity: "low",
      url: "https://route-01jhomepage.internal.invalid/",
      viewport: { width: 390, height: 844, device_scale_factor: 2 },
      scrollPosition: { x: 0, y: 0 },
      capturedCommit: COMMIT,
      screenshotArtefactId: fixture.artefactId,
    },
    { type: "agent_session", id: "ags_claude" },
  );
  assert.equal(byAgent.finding.source, "agent");
});

test("a foreign review is not found, by identifier and by slug, exactly as an unknown one is", async () => {
  const mine = await seedFixture();
  const theirs = await seedFixture();
  const foreign = await createReview(theirs);
  const foreignFinding = await createFinding(theirs, foreign.id);

  const viewer = await harness.built.viewers.issue({
    organisationId: mine.organisationId,
    projectIds: [mine.projectId],
    display: "scoped viewer",
    withCsrfToken: true,
  });
  // A real account session, CSRF token and all: the point of this test is what
  // the *scope* check answers, so nothing earlier in the chain may refuse first.
  const headers = {
    cookie: `reviewplane_viewer=${viewer.token}`,
    "x-csrf-token": viewer.csrfToken ?? "",
  };

  // Every route added by this issue resolves the record in one query carrying
  // the identifier, the session's project scope and its organisation together,
  // so a foreign identifier and an unknown one produce the same refusal byte
  // for byte (`docs/SECURITY.md` section 7). The pre-existing `GET
  // /api/v1/reviews/:reviewId` still looks the row up before applying scope and
  // answers PROJECT_CONTEXT_MISMATCH; that is RVP-66 and RVP-67, and it is not
  // a pattern anything below repeats.
  const probes: readonly [string, string, Record<string, unknown> | undefined][] = [
    ["POST", `/api/v1/reviews/${foreign.id}/accept`, { expected_version: 1 }],
    ["POST", `/api/v1/reviews/${foreign.id}/assign`, { expected_version: 1 }],
    ["POST", `/api/v1/reviews/${foreign.id}/comments`, { body: "hello" }],
    ["GET", `/api/v1/reviews/${foreign.id}/comments`, undefined],
    ["POST", `/api/v1/findings/${foreignFinding.id}/claim`, { expected_version: 1 }],
    ["POST", `/api/v1/findings/${foreignFinding.id}/accept`, { expected_version: 1 }],
  ];
  const unknownReviewId = `rev_${"0".repeat(20)}`;
  const unknownFindingId = `fin_${"0".repeat(20)}`;
  for (const [method, url, payload] of probes) {
    const foreignResponse = await harness.built.app.inject({
      method: method as "GET",
      url,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
    const unknownResponse = await harness.built.app.inject({
      method: method as "GET",
      url: url.replace(foreign.id, unknownReviewId).replace(foreignFinding.id, unknownFindingId),
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
    assert.equal(foreignResponse.statusCode, 404, `${url}: ${foreignResponse.body}`);
    assert.equal(unknownResponse.statusCode, 404, url);
    // The correlation identifier differs by construction; nothing else may.
    const withoutRequestId = (body: string): string => body.replace(/req_[a-z0-9]+/gu, "req_x");
    assert.equal(withoutRequestId(foreignResponse.body), withoutRequestId(unknownResponse.body), url);
  }

  // And by slug: the named lookup an agent uses resolves inside its own project
  // only, so the same name in another project is simply absent.
  const bySlug = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/projects/${mine.projectId}/reviews?slug=bugs-on-homepage`,
    headers,
  });
  assert.equal(bySlug.statusCode, 404, bySlug.body);
});

test("every new state-changing review route requires the CSRF token", async () => {
  const fixture = await seedFixture();
  const review = await createReview(fixture);
  const finding = await createFinding(fixture, review.id);
  const app = harness.built.app;

  const viewer = await harness.built.viewers.issue({
    organisationId: fixture.organisationId,
    projectIds: null,
    display: "account session",
    userId: null,
    withCsrfToken: true,
  });
  assert.ok(viewer.csrfToken !== null);
  const cookieOnly = { cookie: `reviewplane_viewer=${viewer.token}` };
  const withToken = { ...cookieOnly, "x-csrf-token": viewer.csrfToken };

  const routes: readonly [string, string, Record<string, unknown>][] = [
    ["POST", `/api/v1/reviews/${review.id}/assign`, { expected_version: 1 }],
    ["POST", `/api/v1/reviews/${review.id}/request-review`, { expected_version: 1 }],
    ["POST", `/api/v1/reviews/${review.id}/accept`, { expected_version: 1 }],
    ["POST", `/api/v1/reviews/${review.id}/reopen`, { expected_version: 1 }],
    ["POST", `/api/v1/reviews/${review.id}/archive`, { expected_version: 1 }],
    ["POST", `/api/v1/reviews/${review.id}/comments`, { body: "forged" }],
    ["POST", `/api/v1/findings/${finding.id}/claim`, { expected_version: 1 }],
    ["POST", `/api/v1/findings/${finding.id}/accept`, { expected_version: 1 }],
    ["POST", `/api/v1/findings/${finding.id}/wont-fix`, { expected_version: 1, reason: "no" }],
    ["POST", `/api/v1/findings/${finding.id}/reopen`, { expected_version: 1 }],
    ["POST", `/api/v1/findings/${finding.id}/comments`, { body: "forged" }],
  ];

  for (const [method, url, payload] of routes) {
    const forged = await app.inject({ method: method as "POST", url, headers: cookieOnly, payload });
    assert.equal(forged.statusCode, 403, `${url} accepted a cookie-only write: ${forged.body}`);
    const body = forged.json() as { error: { code: string; details?: Record<string, unknown> } };
    assert.equal(body.error.code, "AUTHORISATION_DENIED", url);
    assert.equal(body.error.details?.["reason"], "csrf_token_invalid", url);
  }

  // The export route queues durable work, so it is a write too.
  const forgedExport = await app.inject({
    method: "GET",
    url: `/api/v1/reviews/${review.id}/export`,
    headers: cookieOnly,
  });
  assert.equal(forgedExport.statusCode, 403, forgedExport.body);

  // Nothing above changed anything: the review is still version 1.
  const unchanged = await app.inject({
    method: "GET",
    url: `/api/v1/reviews/${review.id}`,
    headers: withToken,
  });
  assert.equal((unchanged.json() as { data: { version: number } }).data.version, 1);
});

// ----------------------------------------------------------- fault injection

test("a human and an agent claiming at once produce one claim and one conflict", async () => {
  const fixture = await seedFixture();
  const review = await createReview(fixture);
  const finding = await createFinding(fixture, review.id);
  const scope = scopeOf(fixture);
  const reviews = harness.built.reviews;

  const settled = await Promise.allSettled([
    reviews.claimFinding(scope, finding.id, 1, HUMAN),
    reviews.claimFinding(scope, finding.id, 1, {
      type: "agent_session",
      id: "ags_claude",
    }),
  ]);
  const fulfilled = settled.filter((result) => result.status === "fulfilled");
  const rejected = settled.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1, "both claims succeeded");
  assert.equal(rejected.length, 1, "both claims failed");
  const reason = (rejected[0] as PromiseRejectedResult).reason as {
    code: string;
    details?: Record<string, unknown>;
  };
  assert.equal(reason.code, "VERSION_CONFLICT");
  assert.equal(reason.details?.["current_version"], 2);
  process.stdout.write(
    `EVIDENCE concurrent claim: one claim, one VERSION_CONFLICT with current_version=2\n`,
  );

  // Exactly one claim event, so the audit trail does not show two owners.
  assert.equal((await eventsOfType(fixture.projectId, "finding.claimed")).length, 1);
});

test("a duplicate review creation with the same slug produces one review", async () => {
  const fixture = await seedFixture();
  const first = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${fixture.projectId}/reviews`,
    headers: { ...ADMIN, "idempotency-key": "create-bugs-on-homepage" },
    payload: {
      slug: "bugs-on-homepage",
      title: "Bugs on homepage",
      captured_branch: "feat/homepage-refresh",
      captured_commit: COMMIT,
      captured_workspace_id: "wsp_refresh_dev",
      source_browser_session_id: fixture.browserSessionId,
    },
  });
  assert.equal(first.statusCode, 201, first.body);

  const second = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${fixture.projectId}/reviews`,
    headers: { ...ADMIN, "idempotency-key": "create-bugs-on-homepage" },
    payload: {
      slug: "bugs-on-homepage",
      title: "Bugs on homepage",
      captured_branch: "feat/homepage-refresh",
      captured_commit: COMMIT,
      captured_workspace_id: "wsp_refresh_dev",
      source_browser_session_id: fixture.browserSessionId,
    },
  });
  // The partial unique index is the enforcement, so a second creation is
  // refused rather than producing a second review with the same name.
  assert.equal(second.statusCode, 409, second.body);
  assert.equal(
    (second.json() as { error: { code: string } }).error.code,
    "IDEMPOTENCY_CONFLICT",
  );

  const count = await postgres.pool.query<{ count: string }>(
    "SELECT count(*) AS count FROM reviews WHERE project_id = $1 AND slug = $2",
    [fixture.projectId, "bugs-on-homepage"],
  );
  assert.equal(Number(count.rows[0]?.count), 1);
});

test("reviews page by keyset and refuse a cursor this API did not issue", async () => {
  const fixture = await seedFixture();
  for (let index = 0; index < 3; index += 1) {
    await createReview(fixture, { slug: `review-${String(index)}`, title: `Review ${String(index)}` });
  }
  const app = harness.built.app;
  const first = await app.inject({
    method: "GET",
    url: `/api/v1/projects/${fixture.projectId}/reviews?limit=2`,
    headers: ADMIN,
  });
  assert.equal(first.statusCode, 200, first.body);
  const page = first.json() as { data: { id: string }[]; meta: { next_cursor?: string } };
  assert.equal(page.data.length, 2);
  assert.ok(page.meta.next_cursor !== undefined);

  const second = await app.inject({
    method: "GET",
    url: `/api/v1/projects/${fixture.projectId}/reviews?limit=2&cursor=${page.meta.next_cursor ?? ""}`,
    headers: ADMIN,
  });
  const rest = second.json() as { data: { id: string }[]; meta: { next_cursor?: string } };
  assert.equal(rest.data.length, 1);
  assert.equal(rest.meta.next_cursor, undefined);
  // No row appears twice and none is lost.
  const ids = new Set([...page.data, ...rest.data].map((review) => review.id));
  assert.equal(ids.size, 3);

  const forged = await app.inject({
    method: "GET",
    url: `/api/v1/projects/${fixture.projectId}/reviews?cursor=not-a-cursor`,
    headers: ADMIN,
  });
  assert.equal(forged.statusCode, 422, forged.body);
});

// ------------------------------------------------------------------- export

test("a review export produces one durable artefact with its hash", async () => {
  const fixture = await seedFixture();
  const review = await createReview(fixture);
  await createFinding(fixture, review.id);
  await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/reviews/${review.id}/comments`,
    headers: ADMIN,
    payload: { body: "Fix the heading first." },
  });

  const requested = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/reviews/${review.id}/export`,
    headers: ADMIN,
  });
  assert.equal(requested.statusCode, 202, requested.body);
  const queued = (requested.json() as { data: { id: string; status: string } }).data;
  assert.equal(queued.status, "pending");

  // Asking again while the run is in flight joins it rather than queueing a
  // second one.
  const again = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/reviews/${review.id}/export`,
    headers: ADMIN,
  });
  assert.equal((again.json() as { data: { id: string } }).data.id, queued.id);

  const ran = await harness.built.jobs?.drain();
  assert.ok((ran ?? 0) >= 1, "the export job never ran");

  const ready = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/reviews/${review.id}/export`,
    headers: ADMIN,
  });
  const complete = (ready.json() as {
    data: { status: string; artefact_id: string | null; sha256: string | null; size_bytes: number | null };
  }).data;
  assert.equal(complete.status, "ready", ready.body);
  assert.ok(complete.artefact_id !== null);
  assert.match(String(complete.sha256), /^[0-9a-f]{64}$/u);
  assert.ok((complete.size_bytes ?? 0) > 0);
  process.stdout.write(
    `EVIDENCE review export: ${String(complete.artefact_id)} sha256=${String(complete.sha256)} bytes=${String(complete.size_bytes)}\n`,
  );

  const artefact = await harness.built.artefacts.readContent(String(complete.artefact_id));
  assert.equal(artefact.record.kind, "review_export");
  assert.equal(artefact.record.state, "available");
  assert.equal(artefact.record.sha256, complete.sha256);
  const document = JSON.parse(artefact.bytes.toString("utf8")) as {
    format: string;
    version: number;
    review: { slug: string };
    findings: unknown[];
    comments: unknown[];
    artefacts: { sha256?: string }[];
  };
  assert.equal(document.format, "reviewplane-review");
  assert.equal(document.version, 1);
  assert.equal(document.review.slug, "bugs-on-homepage");
  assert.equal(document.findings.length, 1);
  assert.equal(document.comments.length, 1);
  // The manifest carries the digest section 7 of docs/REVIEW_FORMAT.md needs
  // for integrity, and no bytes: this is the metadata-only privacy mode.
  assert.match(String(document.artefacts[0]?.sha256), /^[0-9a-f]{64}$/u);
});

test("an export whose job fails leaves no artefact and no ready export", async () => {
  const fixture = await seedFixture();
  const review = await createReview(fixture);
  const requested = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/reviews/${review.id}/export`,
    headers: ADMIN,
  });
  const queued = (requested.json() as { data: { id: string } }).data;

  // The review disappears between the request and the run, which is the shape
  // every mid-flight failure takes: the handler throws, the transaction rolls
  // back, and nothing half-written survives it.
  await postgres.pool.query("DELETE FROM reviews WHERE id = $1", [review.id]);
  await harness.built.jobs?.drain();

  const exports = await postgres.pool.query<{ status: string; artefact_id: string | null }>(
    "SELECT status, artefact_id FROM review_exports WHERE id = $1",
    [queued.id],
  );
  // The review was deleted, so the export row went with it (ON DELETE CASCADE);
  // what must never exist is a ready export with no artefact behind it.
  for (const row of exports.rows) {
    assert.notEqual(row.status, "ready");
    assert.equal(row.artefact_id, null);
  }
  const artefacts = await postgres.pool.query<{ count: string }>(
    "SELECT count(*) AS count FROM artefacts WHERE kind = 'review_export'",
  );
  assert.equal(Number(artefacts.rows[0]?.count), 0);
});

test("reviewplane export-review writes the same document the job builds", async () => {
  const fixture = await seedFixture();
  const review = await createReview(fixture);
  await createFinding(fixture, review.id);

  const projectSlug = await postgres.pool.query<{ slug: string }>(
    "SELECT slug FROM projects WHERE id = $1",
    [fixture.projectId],
  );
  const out = join(await mkdtemp(join(tmpdir(), "reviewplane-export-")), "bugs.review.json");
  const previous = process.env["REVIEWPLANE_DATABASE_URL"];
  process.env["REVIEWPLANE_DATABASE_URL"] = postgres.url;
  try {
    // The whole server configuration is deliberately not required: an operator
    // exporting a review has no gateway, no worker and no capability key.
    const code = await main([
      "export-review",
      "--project",
      String(projectSlug.rows[0]?.slug),
      "--review",
      "bugs-on-homepage",
      "--out",
      out,
    ]);
    assert.equal(code, 0);
  } finally {
    if (previous === undefined) delete process.env["REVIEWPLANE_DATABASE_URL"];
    else process.env["REVIEWPLANE_DATABASE_URL"] = previous;
  }

  const written = JSON.parse(await readFile(out, "utf8")) as {
    format: string;
    privacy_mode: string;
    review: { slug: string };
    findings: unknown[];
  };
  assert.equal(written.format, "reviewplane-review");
  assert.equal(written.privacy_mode, "metadata_only");
  assert.equal(written.review.slug, "bugs-on-homepage");
  assert.equal(written.findings.length, 1);

  // A review the caller's project does not hold is not found rather than
  // exported from somewhere else.
  process.env["REVIEWPLANE_DATABASE_URL"] = postgres.url;
  try {
    assert.equal(
      await main(["export-review", "--project", "no-such-project", "--review", "bugs-on-homepage"]),
      1,
    );
    assert.equal(
      await main([
        "export-review",
        "--project",
        String(projectSlug.rows[0]?.slug),
        "--review",
        "no-such-review",
      ]),
      1,
    );
  } finally {
    if (previous === undefined) delete process.env["REVIEWPLANE_DATABASE_URL"];
    else process.env["REVIEWPLANE_DATABASE_URL"] = previous;
  }
});

// ------------------------------------------------------------------ contract

test("every new lifecycle event satisfies the protocol schema", async () => {
  const fixture = await seedFixture();
  const review = await createReview(fixture);
  const finding = await createFinding(fixture, review.id);
  const scope = scopeOf(fixture);
  const reviews = harness.built.reviews;

  await reviews.assignReview(scope, review.id, { expectedVersion: 1 }, HUMAN);
  await reviews.addReviewComment(scope, review.id, "A note on the review itself.", HUMAN);
  await reviews.addComment(scope, finding.id, "A note on the finding.", HUMAN);
  await reviews.updateFinding(scope, finding.id, { expectedVersion: 1, status: "CLAIMED" }, HUMAN);
  await reviews.updateFinding(scope, finding.id, { expectedVersion: 2, status: "IN_PROGRESS" }, HUMAN);
  await reviews.updateFinding(
    scope,
    finding.id,
    { expectedVersion: 3, status: "FIXED_UNVERIFIED", resolutionNote: "Fixed." },
    HUMAN,
  );
  await reviews.updateFinding(
    scope,
    finding.id,
    { expectedVersion: 4, status: "AWAITING_HUMAN_REVIEW" },
    HUMAN,
  );
  await reviews.disposeFinding(scope, finding.id, "RESOLVED", { expectedVersion: 5 }, HUMAN);
  await reviews.reopenFinding(scope, finding.id, { expectedVersion: 6 }, HUMAN);
  await reviews
    .updateFinding(
      scope,
      finding.id,
      { expectedVersion: 7, status: "RESOLVED" },
      { type: "agent_session", id: "ags_claude" },
    )
    .catch(() => undefined);

  const rows = await postgres.pool.query<{
    id: string;
    sequence: string;
    type: string;
    occurred_at: Date;
    organisation_id: string;
    project_id: string;
    actor_type: string;
    actor_id: string | null;
    actor_display: string | null;
    correlation: Record<string, string>;
    payload: Record<string, unknown>;
  }>("SELECT * FROM events WHERE stream_key = $1 ORDER BY sequence", [fixture.projectId]);

  const reviewDomain = rows.rows.filter(
    (row) => row.type.startsWith("review.") || row.type.startsWith("finding."),
  );
  assert.ok(reviewDomain.length >= 12, `only ${String(reviewDomain.length)} review events`);
  for (const row of reviewDomain) {
    const decoded = decodeReviewEvent(
      JSON.stringify({
        id: row.id,
        schema_version: 1,
        sequence: Number(row.sequence),
        type: row.type,
        occurred_at: row.occurred_at.toISOString(),
        organisation_id: row.organisation_id,
        project_id: row.project_id,
        actor: {
          type: row.actor_type,
          ...(row.actor_id === null ? {} : { id: row.actor_id }),
          ...(row.actor_display === null ? {} : { display: row.actor_display }),
        },
        correlation: row.correlation,
        payload: row.payload,
      }),
    );
    assert.ok(
      decoded.ok,
      `${row.type} does not satisfy the schema: ${decoded.ok ? "" : decoded.error.message}`,
    );
  }
  process.stdout.write(
    `EVIDENCE event sequence: ${reviewDomain.map((row) => row.type).join(" -> ")}\n`,
  );
});
