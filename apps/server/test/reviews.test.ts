/**
 * Review, finding and annotation storage against a real database
 * (`docs/TESTING.md` section 2 "Component", section 4 "Domain", section 9
 * "API", section 10 "Isolation").
 *
 * The suite also prints the database rows the issue asks for as evidence, so
 * the separation of an immutable original from its overlay records is
 * something a reader can see rather than take on trust.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { decodeReviewEvent } from "@reviewplane/protocol/review";

import {
  BOOTSTRAP_TOKEN,
  WORKER_CREDENTIAL,
  seedProjectAndWorker,
  startHarness,
  type Harness,
} from "./helpers/harness.ts";
import { encodePng, sha256 } from "./helpers/png.ts";
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

const ADMIN = { authorization: `Bearer ${BOOTSTRAP_TOKEN}` };
const COMMIT = "4a45b94f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60";

/** The 390x844 preset at a device pixel ratio of 2 (`AGENTS.md`). */
const SCREENSHOT = encodePng(780, 1688);

interface Fixture {
  readonly organisationId: string;
  readonly projectId: string;
  readonly browserSessionId: string;
  readonly artefactId: string;
}

/** A project, a browser session and one verified screenshot to annotate. */
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

  const artefactId = await uploadScreenshot(projectId, browserSessionId, SCREENSHOT);
  return { organisationId, projectId, browserSessionId, artefactId };
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
      filename: "homepage.png",
    },
  });
  assert.equal(intent.statusCode, 201, intent.body);
  const { artefact_id: artefactId, upload_path: uploadPath } = (
    intent.json() as { data: { artefact_id: string; upload_path: string } }
  ).data;

  const uploaded = await app.inject({
    method: "POST",
    url: uploadPath,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}`, "content-type": "image/png" },
    payload: bytes,
  });
  assert.equal(uploaded.statusCode, 202, uploaded.body);

  const completed = await app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/complete`,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}` },
    payload: { sha256: sha256(bytes), size_bytes: bytes.byteLength },
  });
  assert.equal(completed.statusCode, 200, completed.body);
  return artefactId;
}

function reviewBody(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    slug: "bugs-on-homepage",
    title: "Bugs on homepage",
    description: "Fix these before continuing with the product page.",
    captured_branch: "feat/homepage-refresh",
    captured_commit: COMMIT,
    captured_workspace_id: "wsp_refresh_dev",
    source_browser_session_id: fixture.browserSessionId,
    ...overrides,
  };
}

function findingBody(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    title: "Hero heading overlaps the basket button",
    description: "At 390x844 the heading wraps onto the button and hides it.",
    severity: "high",
    source: "human",
    url: "https://route-01jhomepage.internal.invalid/",
    viewport: { width: 390, height: 844, device_scale_factor: 2 },
    scroll_position: { x: 0, y: 320 },
    captured_commit: COMMIT,
    screenshot_artefact_id: fixture.artefactId,
    acceptance_criteria: "The basket button is fully visible and operable at 390x844.",
    ...overrides,
  };
}

async function createReview(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${fixture.projectId}/reviews`,
    headers: ADMIN,
    payload: reviewBody(fixture, overrides),
  });
}

async function createFinding(
  reviewId: string,
  fixture: Fixture,
  overrides: Record<string, unknown> = {},
) {
  return harness.built.app.inject({
    method: "POST",
    url: `/api/v1/reviews/${reviewId}/findings`,
    headers: ADMIN,
    payload: findingBody(fixture, overrides),
  });
}

test("a named review carries its captured branch, commit, workspace and session", async () => {
  const fixture = await seedFixture();
  const created = await createReview(fixture);
  assert.equal(created.statusCode, 201, created.body);
  const review = (created.json() as { data: Record<string, unknown> }).data;

  assert.equal(review["slug"], "bugs-on-homepage");
  assert.equal(review["status"], "DRAFT");
  assert.equal(review["version"], 1);
  assert.equal(review["captured_branch"], "feat/homepage-refresh");
  assert.equal(review["captured_commit"], COMMIT);
  assert.equal(review["captured_workspace_id"], "wsp_refresh_dev");
  assert.equal(review["source_browser_session_id"], fixture.browserSessionId);
  assert.equal(review["project_id"], fixture.projectId);
  assert.equal(review["organisation_id"], fixture.organisationId);
  assert.deepEqual(review["created_by"], {
    type: "human_user",
    id: "bootstrap",
    display: "bootstrap administrator",
  });

  // The review is reachable by the name a human typed, which is what a CLI
  // agent will be given (`docs/UX_FLOWS.md` section 10).
  const byName = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/projects/${fixture.projectId}/reviews?slug=bugs-on-homepage`,
    headers: ADMIN,
  });
  assert.equal(byName.statusCode, 200);
  assert.equal((byName.json() as { data: { id: string }[] }).data[0]?.id, review["id"]);
});

test("a slug is unique within active reviews of a project and free in another", async () => {
  const first = await seedFixture();
  const duplicate = await createReview(first);
  assert.equal(duplicate.statusCode, 201);

  const again = await createReview(first, { title: "Another attempt" });
  assert.equal(again.statusCode, 409);
  assert.equal((again.json() as { error: { code: string } }).error.code, "IDEMPOTENCY_CONFLICT");

  // The same name in a second project is a different review and is allowed.
  const second = await seedFixture();
  const elsewhere = await createReview(second);
  assert.equal(elsewhere.statusCode, 201, elsewhere.body);
  assert.notEqual(
    (elsewhere.json() as { data: { id: string } }).data.id,
    (duplicate.json() as { data: { id: string } }).data.id,
  );
});

test("a cancelled review releases its slug; an accepted one keeps it", async () => {
  const fixture = await seedFixture();
  const first = (await createReview(fixture)).json() as { data: { id: string; version: number } };

  const cancelled = await harness.built.app.inject({
    method: "PATCH",
    url: `/api/v1/reviews/${first.data.id}`,
    headers: ADMIN,
    payload: { expected_version: first.data.version, status: "CANCELLED" },
  });
  assert.equal(cancelled.statusCode, 200, cancelled.body);

  const reused = await createReview(fixture);
  assert.equal(reused.statusCode, 201, reused.body);
});

test("a finding stores its captured context; one missing it is refused", async () => {
  const fixture = await seedFixture();
  const review = (await createReview(fixture)).json() as { data: { id: string } };

  const created = await createFinding(review.data.id, fixture, {
    annotations: [
      {
        artefact_id: fixture.artefactId,
        type: "rectangle",
        geometry: { x: 0.54, y: 0.02, width: 0.38, height: 0.11 },
        label: "Heading overlapping the basket button",
        style_hint: "critical",
      },
    ],
  });
  assert.equal(created.statusCode, 201, created.body);
  const { finding, annotations } = (
    created.json() as {
      data: { finding: Record<string, unknown>; annotations: Record<string, unknown>[] };
    }
  ).data;
  assert.equal(finding["source"], "human");
  assert.equal(finding["status"], "OPEN");
  assert.equal(finding["severity"], "high");
  assert.deepEqual(finding["viewport"], { width: 390, height: 844, device_scale_factor: 2 });
  assert.deepEqual(finding["scroll_position"], { x: 0, y: 320 });
  assert.equal(finding["captured_commit"], COMMIT);
  assert.equal(finding["screenshot_artefact_id"], fixture.artefactId);
  assert.equal(annotations.length, 1);

  // Each required field of docs/UX_FLOWS.md section 9, removed in turn.
  for (const field of ["url", "viewport", "scroll_position", "captured_commit", "screenshot_artefact_id"]) {
    const body = findingBody(fixture) as Record<string, unknown>;
    delete body[field];
    const refused = await harness.built.app.inject({
      method: "POST",
      url: `/api/v1/reviews/${review.data.id}/findings`,
      headers: ADMIN,
      payload: body,
    });
    assert.equal(refused.statusCode, 400, `${field} was accepted as absent`);
  }

  // A viewport without a device pixel ratio is refused by the schema.
  const noRatio = await createFinding(review.data.id, fixture, {
    viewport: { width: 390, height: 844 },
  });
  assert.equal(noRatio.statusCode, 400);
});

test("all five annotation types are stored, and out-of-range geometry is refused", async () => {
  const fixture = await seedFixture();
  const review = (await createReview(fixture)).json() as { data: { id: string } };
  const finding = (await createFinding(review.data.id, fixture)).json() as {
    data: { finding: { id: string } };
  };
  const findingId = finding.data.finding.id;

  const shapes = [
    { type: "rectangle", geometry: { x: 0.54, y: 0.02, width: 0.38, height: 0.11 } },
    { type: "ellipse", geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
    { type: "arrow", geometry: { x: 0.12, y: 0.9, x2: 0.6, y2: 0.14 } },
    { type: "point", geometry: { x: 0.4, y: 0.6 } },
    { type: "numbered_marker", geometry: { x: 0, y: 1 }, marker_number: 2 },
  ];
  for (const shape of shapes) {
    const response = await harness.built.app.inject({
      method: "POST",
      url: `/api/v1/findings/${findingId}/annotations`,
      headers: ADMIN,
      payload: { artefact_id: fixture.artefactId, label: `A ${shape.type}`, ...shape },
    });
    assert.equal(response.statusCode, 201, `${shape.type}: ${response.body}`);
  }

  const listed = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/findings/${findingId}/annotations`,
    headers: ADMIN,
  });
  assert.equal((listed.json() as { data: unknown[] }).data.length, 5);

  // Refused, not clamped: the stored value must never be a rounded version of
  // what the caller sent.
  const outOfRange = [
    { type: "rectangle", geometry: { x: 0.54, y: 0.02, width: 1.38, height: 0.11 } },
    { type: "rectangle", geometry: { x: -0.01, y: 0.02, width: 0.3, height: 0.1 } },
    { type: "rectangle", geometry: { x: 421, y: 17, width: 296, height: 93 } },
    { type: "point", geometry: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } },
    { type: "arrow", geometry: { x: 0.1, y: 0.2 } },
  ];
  for (const shape of outOfRange) {
    const response = await harness.built.app.inject({
      method: "POST",
      url: `/api/v1/findings/${findingId}/annotations`,
      headers: ADMIN,
      payload: { artefact_id: fixture.artefactId, label: "Refused", ...shape },
    });
    assert.equal(response.statusCode, 400, `${JSON.stringify(shape.geometry)} was accepted`);
  }

  const after = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/findings/${findingId}/annotations`,
    headers: ADMIN,
  });
  assert.equal(
    (after.json() as { data: unknown[] }).data.length,
    5,
    "a refused annotation was stored anyway",
  );
});

test("the original is immutable and stored apart from its overlay records", async () => {
  const fixture = await seedFixture();
  const review = (await createReview(fixture)).json() as { data: { id: string } };
  const first = (
    (await createFinding(review.data.id, fixture, {
      annotations: [
        {
          artefact_id: fixture.artefactId,
          type: "rectangle",
          geometry: { x: 0.54, y: 0.02, width: 0.38, height: 0.11 },
          label: "Heading overlapping the basket button",
        },
      ],
    })).json() as { data: { finding: { id: string } } }
  ).data.finding.id;
  const second = (
    (await createFinding(review.data.id, fixture, {
      title: "Basket count is stale after removal",
      severity: "medium",
      annotations: [
        {
          artefact_id: fixture.artefactId,
          type: "numbered_marker",
          geometry: { x: 0.18, y: 0.44 },
          label: "Stale basket count",
          marker_number: 2,
        },
      ],
    })).json() as { data: { finding: { id: string } } }
  ).data.finding.id;

  const artefactRows = await postgres.pool.query(
    `SELECT id, storage_key, sha256, size_bytes, content_type, content_width_px,
            content_height_px, redaction_state, retention_class, filename_label, state
       FROM artefacts WHERE id = $1`,
    [fixture.artefactId],
  );
  const artefact = artefactRows.rows[0] as Record<string, unknown>;
  assert.equal(artefact["storage_key"], `sha256/${sha256(SCREENSHOT).slice(0, 2)}/${sha256(SCREENSHOT).slice(2)}`);
  assert.equal(artefact["sha256"], sha256(SCREENSHOT));
  assert.equal(Number(artefact["size_bytes"]), SCREENSHOT.byteLength);
  assert.equal(Number(artefact["content_width_px"]), 780);
  assert.equal(Number(artefact["content_height_px"]), 1688);
  assert.equal(artefact["redaction_state"], "not_applied");
  // The key is derived from the digest; the name the caller supplied is
  // metadata and appears nowhere in it (ADR-0012).
  assert.equal(artefact["filename_label"], "homepage.png");
  assert.ok(!String(artefact["storage_key"]).includes("homepage"));

  const annotationRows = await postgres.pool.query(
    `SELECT a.id, a.finding_id, a.artefact_id, a.type, a.geometry, a.label, a.revision
       FROM annotations a WHERE a.finding_id = ANY($1) ORDER BY a.created_at`,
    [[first, second]],
  );
  assert.equal(annotationRows.rows.length, 2);
  for (const row of annotationRows.rows as Record<string, unknown>[]) {
    // Every overlay row points at the original and holds no bytes of its own.
    assert.equal(row["artefact_id"], fixture.artefactId);
    for (const value of Object.values(row["geometry"] as Record<string, number>)) {
      assert.ok(value >= 0 && value <= 1, `geometry member ${String(value)} is not normalised`);
    }
  }

  process.stdout.write(
    `EVIDENCE artefact row: ${JSON.stringify(artefact)}\n` +
      `EVIDENCE annotation rows: ${JSON.stringify(annotationRows.rows)}\n`,
  );
});

test("a stale expected_version is refused with VERSION_CONFLICT", async () => {
  const fixture = await seedFixture();
  const review = (await createReview(fixture)).json() as { data: { id: string; version: number } };
  const findingId = (
    (await createFinding(review.data.id, fixture)).json() as {
      data: { finding: { id: string; version: number } };
    }
  ).data.finding.id;

  const claimed = await harness.built.app.inject({
    method: "PATCH",
    url: `/api/v1/findings/${findingId}`,
    headers: ADMIN,
    payload: { expected_version: 1, status: "CLAIMED" },
  });
  assert.equal(claimed.statusCode, 200, claimed.body);
  assert.equal((claimed.json() as { data: { version: number } }).data.version, 2);

  // The second writer still holds version 1.
  const conflict = await harness.built.app.inject({
    method: "PATCH",
    url: `/api/v1/findings/${findingId}`,
    headers: ADMIN,
    payload: { expected_version: 1, status: "IN_PROGRESS" },
  });
  assert.equal(conflict.statusCode, 409);
  const body = conflict.json() as { error: { code: string; details: { current_version: number } } };
  assert.equal(body.error.code, "VERSION_CONFLICT");
  assert.equal(body.error.details.current_version, 2);

  const reviewConflict = await harness.built.app.inject({
    method: "PATCH",
    url: `/api/v1/reviews/${review.data.id}`,
    headers: ADMIN,
    payload: { expected_version: 99, title: "Renamed" },
  });
  assert.equal(reviewConflict.statusCode, 409);
});

test("an agent cannot resolve a human-authored finding through the domain service", async () => {
  const fixture = await seedFixture();
  const review = (await createReview(fixture)).json() as { data: { id: string } };
  const findingId = (
    (await createFinding(review.data.id, fixture)).json() as { data: { finding: { id: string } } }
  ).data.finding.id;

  const scope = { organisationId: fixture.organisationId, projectId: fixture.projectId };
  const agent = { type: "agent_session" as const, id: "ags_claude", display: "Claude Code" };
  const reviews = harness.built.reviews;

  // The agent works the finding as far as it is allowed to.
  await reviews.updateFinding(scope, findingId, { expectedVersion: 1, status: "CLAIMED" }, agent);
  await reviews.updateFinding(scope, findingId, { expectedVersion: 2, status: "IN_PROGRESS" }, agent);

  // A completion claim with no evidence at all is refused before anything else.
  const withoutEvidence = await reviews
    .updateFinding(scope, findingId, { expectedVersion: 3, status: "FIXED_UNVERIFIED" }, agent)
    .then(() => null)
    .catch((error: unknown) => error as { code: string; message: string });
  assert.equal(withoutEvidence?.code, "EVIDENCE_REQUIRED");
  process.stdout.write(`EVIDENCE denial: ${withoutEvidence?.code} ${withoutEvidence?.message}\n`);

  await reviews.updateFinding(
    scope,
    findingId,
    {
      expectedVersion: 3,
      status: "FIXED_UNVERIFIED",
      resolutionNote: "Raised the collapse breakpoint to 900px and re-checked at 390x844.",
    },
    agent,
  );
  const submitted = await reviews.updateFinding(
    scope,
    findingId,
    { expectedVersion: 4, status: "AWAITING_HUMAN_REVIEW" },
    agent,
  );
  assert.equal(submitted.status, "AWAITING_HUMAN_REVIEW");

  // And then it stops. This is the product invariant of `AGENTS.md`.
  const denial = await reviews
    .updateFinding(scope, findingId, { expectedVersion: 5, status: "RESOLVED" }, agent)
    .then(() => null)
    .catch((error: unknown) => error as { code: string; message: string });
  assert.equal(denial?.code, "AUTHORISATION_DENIED");
  process.stdout.write(`EVIDENCE denial: ${denial?.code} ${denial?.message}\n`);

  // Nothing was written: the finding is still awaiting a human.
  const unchanged = await reviews.getFinding(scope, findingId);
  assert.equal(unchanged.status, "AWAITING_HUMAN_REVIEW");
  assert.equal(unchanged.version, 5);

  // A human completes the same transition.
  const accepted = await reviews.updateFinding(
    scope,
    findingId,
    { expectedVersion: 5, status: "RESOLVED" },
    { type: "human_user", id: "bootstrap", display: "bootstrap administrator" },
  );
  assert.equal(accepted.status, "RESOLVED");
});

test("an accepted review refuses an ordinary edit", async () => {
  const fixture = await seedFixture();
  const review = (await createReview(fixture)).json() as { data: { id: string } };
  const scope = { organisationId: fixture.organisationId, projectId: fixture.projectId };
  const human = { type: "human_user" as const, id: "bootstrap", display: "bootstrap administrator" };
  const reviews = harness.built.reviews;

  await reviews.updateReview(scope, review.data.id, { expectedVersion: 1, status: "READY" }, human);
  await reviews.updateReview(scope, review.data.id, { expectedVersion: 2, status: "ASSIGNED" }, human);
  await reviews.updateReview(scope, review.data.id, { expectedVersion: 3, status: "IN_PROGRESS" }, human);
  await reviews.updateReview(
    scope,
    review.data.id,
    { expectedVersion: 4, status: "AWAITING_HUMAN_REVIEW" },
    human,
  );
  await reviews.updateReview(scope, review.data.id, { expectedVersion: 5, status: "ACCEPTED" }, human);

  const refused = await harness.built.app.inject({
    method: "PATCH",
    url: `/api/v1/reviews/${review.data.id}`,
    headers: ADMIN,
    payload: { expected_version: 6, title: "Quietly renamed" },
  });
  assert.equal(refused.statusCode, 403);
  assert.equal((refused.json() as { error: { code: string } }).error.code, "POLICY_DENIED");

  const stillNamed = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/reviews/${review.data.id}`,
    headers: ADMIN,
  });
  assert.equal((stillNamed.json() as { data: { title: string } }).data.title, "Bugs on homepage");
});

test("an agent cannot accept a review", async () => {
  const fixture = await seedFixture();
  const review = (await createReview(fixture)).json() as { data: { id: string } };
  const scope = { organisationId: fixture.organisationId, projectId: fixture.projectId };
  const human = { type: "human_user" as const, id: "bootstrap" };
  const reviews = harness.built.reviews;
  await reviews.updateReview(scope, review.data.id, { expectedVersion: 1, status: "READY" }, human);
  await reviews.updateReview(scope, review.data.id, { expectedVersion: 2, status: "ASSIGNED" }, human);
  await reviews.updateReview(scope, review.data.id, { expectedVersion: 3, status: "IN_PROGRESS" }, human);
  await reviews.updateReview(
    scope,
    review.data.id,
    { expectedVersion: 4, status: "AWAITING_HUMAN_REVIEW" },
    human,
  );

  const denial = await reviews
    .updateReview(
      scope,
      review.data.id,
      { expectedVersion: 5, status: "ACCEPTED" },
      { type: "agent_session", id: "ags_claude" },
    )
    .then(() => null)
    .catch((error: unknown) => error as { code: string });
  assert.equal(denial?.code, "AUTHORISATION_DENIED");
});

test("a finding cannot reference an unverified or foreign artefact", async () => {
  const fixture = await seedFixture();
  const other = await seedFixture();
  const review = (await createReview(fixture)).json() as { data: { id: string } };

  const foreign = await createFinding(review.data.id, fixture, {
    screenshot_artefact_id: other.artefactId,
  });
  assert.equal(foreign.statusCode, 404, foreign.body);

  // An intent with no uploaded bytes is not evidence.
  const pending = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${fixture.projectId}/artefacts/uploads`,
    // The administrator, because seeding the second project reassigned the
    // single Stage 0 worker away from this one.
    headers: ADMIN,
    payload: {
      kind: "screenshot",
      content_type: "image/png",
      size_bytes: 128,
      sha256: "a".repeat(64),
      retention_class: "verification_evidence",
    },
  });
  assert.equal(pending.statusCode, 201, pending.body);
  const pendingId = (pending.json() as { data: { artefact_id: string } }).data.artefact_id;
  const unverified = await createFinding(review.data.id, fixture, {
    screenshot_artefact_id: pendingId,
  });
  assert.equal(unverified.statusCode, 409);
  assert.equal(
    (unverified.json() as { error: { code: string } }).error.code,
    "ARTEFACT_UPLOAD_INCOMPLETE",
  );
});

test("a viewer scoped to another project cannot reach this project's review", async () => {
  const fixture = await seedFixture();
  const other = await seedFixture();
  const review = (await createReview(fixture)).json() as { data: { id: string } };

  const minted = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${other.projectId}/viewer-sessions`,
    headers: ADMIN,
  });
  const token = (minted.json() as { data: { token: string } }).data.token;
  const cookie = `reviewplane_viewer=${encodeURIComponent(token)}`;

  for (const url of [
    `/api/v1/reviews/${review.data.id}`,
    `/api/v1/reviews/${review.data.id}/findings`,
    `/api/v1/projects/${fixture.projectId}/reviews`,
  ]) {
    const refused = await harness.built.app.inject({ method: "GET", url, headers: { cookie } });
    assert.equal(refused.statusCode, 403, `${url} was readable`);
    assert.equal(
      (refused.json() as { error: { code: string } }).error.code,
      "PROJECT_CONTEXT_MISMATCH",
    );
  }

  // The same viewer session reads its own project without trouble.
  const own = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/projects/${other.projectId}/reviews`,
    headers: { cookie },
  });
  assert.equal(own.statusCode, 200);
});

test("annotation revisions are preserved and the current projection hides withdrawn ones", async () => {
  const fixture = await seedFixture();
  const review = (await createReview(fixture)).json() as { data: { id: string } };
  const findingId = (
    (await createFinding(review.data.id, fixture)).json() as { data: { finding: { id: string } } }
  ).data.finding.id;

  const created = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/findings/${findingId}/annotations`,
    headers: ADMIN,
    payload: {
      artefact_id: fixture.artefactId,
      type: "rectangle",
      geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      label: "First position",
    },
  });
  const annotationId = (created.json() as { data: { id: string } }).data.id;

  // A second revision of the same annotation, written directly, stands in for
  // the edit endpoint of `docs/API.md` section 14: what is asserted here is
  // that the projection hides the old revision and the table keeps it.
  await postgres.pool.query(
    `INSERT INTO annotations (id, revision, organisation_id, project_id, finding_id,
                              artefact_id, type, geometry, label, created_by_actor_type)
     VALUES ($1, 2, $2, $3, $4, $5, 'rectangle', $6, 'Moved down', 'human_user')`,
    [
      annotationId,
      fixture.organisationId,
      fixture.projectId,
      findingId,
      fixture.artefactId,
      JSON.stringify({ x: 0.1, y: 0.5, width: 0.2, height: 0.2 }),
    ],
  );

  const current = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/findings/${findingId}/annotations`,
    headers: ADMIN,
  });
  const list = (current.json() as { data: { revision: number; label: string }[] }).data;
  assert.equal(list.length, 1);
  assert.equal(list[0]?.revision, 2);
  assert.equal(list[0]?.label, "Moved down");

  const all = await harness.built.app.inject({
    method: "GET",
    url: `/api/v1/findings/${findingId}/annotations?revisions=all`,
    headers: ADMIN,
  });
  assert.equal((all.json() as { data: unknown[] }).data.length, 2);
});

test("every lifecycle change produces an event that satisfies the protocol schema", async () => {
  const fixture = await seedFixture();
  const review = (await createReview(fixture)).json() as { data: { id: string; version: number } };
  await createFinding(review.data.id, fixture, {
    annotations: [
      {
        artefact_id: fixture.artefactId,
        type: "rectangle",
        geometry: { x: 0.54, y: 0.02, width: 0.38, height: 0.11 },
        label: "Heading overlapping the basket button",
      },
    ],
  });
  await harness.built.app.inject({
    method: "PATCH",
    url: `/api/v1/reviews/${review.data.id}`,
    headers: ADMIN,
    payload: { expected_version: review.data.version, status: "READY" },
  });
  await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${fixture.artefactId}/grants`,
    headers: ADMIN,
  });

  const rows = await postgres.pool.query(
    `SELECT id, schema_version, sequence, type, occurred_at, recorded_at, organisation_id,
            project_id, actor_type, actor_id, actor_display, correlation, payload
       FROM events WHERE project_id = $1 ORDER BY sequence`,
    [fixture.projectId],
  );
  const seen = new Set<string>();
  for (const row of rows.rows as Record<string, unknown>[]) {
    seen.add(row["type"] as string);
    // Every event carries an explicit actor type (`docs/EVENTS.md` section 5).
    assert.ok(typeof row["actor_type"] === "string" && row["actor_type"] !== "");
  }
  for (const expected of [
    "review.created",
    "review.named",
    "review.status_changed",
    "finding.created",
    "finding.annotated",
    "artefact.upload_started",
    "artefact.upload_completed",
    "artefact.access_granted",
    "screenshot.captured",
  ]) {
    assert.ok(seen.has(expected), `${expected} was not recorded`);
  }

  // The stored rows are the docs/EVENTS.md section 2 envelope, so they must
  // decode with the generated codec. This is the contract test of
  // docs/TESTING.md section 2 "Event payload compatibility": a payload written
  // by the service and refused by the schema would fail here.
  let decoded = 0;
  for (const row of rows.rows as Record<string, unknown>[]) {
    const type = row["type"] as string;
    if (!type.startsWith("review.") && !type.startsWith("finding.") &&
        !type.startsWith("artefact.") && !type.startsWith("screenshot.")) {
      continue;
    }
    const event = {
      id: row["id"],
      schema_version: Number(row["schema_version"]),
      sequence: Number(row["sequence"]),
      type,
      occurred_at: (row["occurred_at"] as Date).toISOString(),
      recorded_at: (row["recorded_at"] as Date).toISOString(),
      organisation_id: row["organisation_id"],
      project_id: row["project_id"],
      actor: {
        type: row["actor_type"],
        ...(row["actor_id"] === null ? {} : { id: row["actor_id"] }),
        ...(row["actor_display"] === null ? {} : { display: row["actor_display"] }),
      },
      correlation: row["correlation"],
      payload: row["payload"],
    };
    const result = decodeReviewEvent(JSON.stringify(event));
    assert.ok(
      result.ok,
      `${type} does not satisfy the schema: ${result.ok ? "" : JSON.stringify(result.error)}`,
    );
    decoded += 1;
  }
  assert.ok(decoded >= 9, `only ${String(decoded)} review-domain events were checked`);
  process.stdout.write(`EVIDENCE ${String(decoded)} events decoded against the review schema\n`);
});
