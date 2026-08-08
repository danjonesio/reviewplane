/**
 * The standing **cross-project and cross-organisation isolation gate** (RVP-96,
 * `docs/TESTING.md` sections 10 and 16, `docs/SECURITY.md` section 7).
 *
 * `docs/TESTING.md` section 16 makes "cross-project isolation tests fail" a
 * release-blocking condition. This file is that condition's owner. It is not a
 * second copy of `cross-tenant-authority.test.ts`, which is the *regression*
 * suite for two named defects (RVP-91, RVP-92) and covers three routes; this is
 * the *standing* suite, and it is shaped by why those defects were invisible
 * rather than by where they happened to be.
 *
 * ## The session shape is the requirement
 *
 * `principal.projectIds === null` means "not narrowed to specific projects",
 * and it is **the shape every real sign-in issues**. It was read as
 * administrator authority at four sites. Two probes were available before those
 * defects were found, and neither can see this class:
 *
 *   * a **project-scoped** session is refused correctly by the wrong predicate,
 *     so it passes against the defect and against the fix;
 *   * the **bootstrap administrator** carries `organisationId: null` *and*
 *     `projectIds: null`, so both tenancy terms in every scoped query go
 *     vacuous and a missing one ships green. Whole suites have passed while
 *     proving nothing for exactly this reason.
 *
 * So the attacker here is always an **organisation-wide viewer of another
 * organisation**: a real sign-in through `POST /api/v1/auth/bootstrap`, with a
 * real `organisationId`, a real CSRF token and `projectIds: null`. The
 * project-scoped probe is kept beside it, never instead of it: a term that is
 * doing work fails the organisation-wide probe while the project-scoped one
 * still passes, and that asymmetry is what makes a mutation test meaningful. A
 * change that fails both is refusing everything, which is a different change —
 * which is why the bootstrap administrator's positive control is here too.
 *
 * ## Every probe states what it proves
 *
 * A refusal that is byte-identical between a foreign identifier and an unknown
 * one proves nothing on its own: a route that refuses on CSRF, on credential
 * shape or on body validation *before* it resolves the record produces two
 * identical refusals while having no tenancy check at all. So every probe runs
 * a third leg — the **owner**, over the same route with the same body — and
 * fails when the owner earns the same refusal. That leg is the discriminator,
 * and without it this file would be a very thorough way of proving nothing. It
 * is not a theoretical precaution: it caught four routes that take a bearer
 * credential and no human session at all, where the comparison would have been
 * two identical `AUTHENTICATION_REQUIRED` refusals.
 *
 * ## Both inventories are enumerated, not listed
 *
 * The table classification below is checked against `information_schema` on a
 * **migrated** database rather than against the migration SQL. A later
 * `ALTER TABLE` is invisible to a grep of the migration that created the table,
 * and views are invisible to a query that filters on `BASE TABLE`. A relation
 * this file does not classify fails the gate, so a new table forces a decision
 * about its tenancy rather than arriving unexamined.
 *
 * The probe list is checked the same way against **Fastify's own route table**,
 * so a route added under any prefix by any plugin is in scope. Every route
 * taking a path parameter is either probed here or named in a recorded
 * exemption; one in neither fails the gate. A list only ever covers the routes
 * somebody remembered, and the routes somebody forgot are what this file is
 * for.
 */

import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
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
import {
  FIXTURE_TABLES,
  startMigratedDatabase,
  truncateAll,
  type MigratedDatabase,
} from "./support/postgres.ts";
import { registeredRoutes, routeKey } from "./support/routes.ts";

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
const MOBILE = { width: 390, height: 844, device_scale_factor: 2 };
const DESKTOP = { width: 1440, height: 900, device_scale_factor: 1 };
const COMMIT = "4a45b94f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60";
/** The commit a change landed in. A verification may not name the captured one. */
const FIXED_COMMIT = "b4c5d6e7f809192a3b4c5d6e7f809192a3b4c5d6";
const SCREENSHOT = encodePng(780, 1688);

// ===========================================================================
// Part 1 — the inventory
// ===========================================================================

/**
 * How a relation carries tenancy.
 *
 * Three classes, because there are three honest answers and no fourth. The
 * acceptance criterion for this gate names them: scoped, global by design, or
 * inheriting an applied check.
 */
type Classification =
  /** Carries `organisation_id`. Every read of it must carry the term. */
  | { readonly kind: "scoped" }
  /**
   * Deliberately deployment-wide. `why` is the reason, and it is required so
   * that "this table has no organisation column" is never the whole argument —
   * the absence is what a forgotten term looks like too.
   */
  | { readonly kind: "global"; readonly why: string }
  /**
   * No tenancy column of its own; the authority is applied at `parent`.
   *
   * **The risk signal is not "junction table" — it is "junction whose parent is
   * unscoped".** `verification_artefacts` and `browser_worker_projects` are the
   * same shape in opposite classes: the first hangs off `verifications`, which
   * carries the term, so every read of it is already inside a tenancy; the
   * second hangs off `browser_workers`, which carries none, so nothing about
   * the shape supplies one and a route must. Where the parent is unscoped,
   * `provenBy` names the test in this file that proves the route does.
   */
  | {
      readonly kind: "inherits";
      readonly parent: string;
      readonly why: string;
      readonly provenBy?: string;
    };

const DEPLOYMENT_ADMINISTRATOR_PROOF =
  "the browser-worker junction is reachable only by the deployment administrator";

/**
 * Test names this file registers as the proof of a classification.
 *
 * Registration happens while the module is evaluated, so the set is complete
 * before any test body runs, wherever in the file the proof is written. The
 * alternative — searching this file's own source for the name — cannot see a
 * test whose name is a constant rather than a literal, which is precisely the
 * form a named proof takes.
 */
const PROOFS = new Set<string>();

/** Registers a test and records that a classification may cite it. */
function provingTest(name: string, body: () => Promise<void>): void {
  PROOFS.add(name);
  test(name, body);
}

/**
 * Every relation the migrations create, and how it carries tenancy.
 *
 * Adding a table without adding it here fails the gate. That is the point: the
 * decision "is this scoped, deployment-wide, or covered by its parent?" is one
 * somebody has to make, and making it at review time is cheaper than making it
 * after a disclosure.
 */
const INVENTORY: Readonly<Record<string, Classification>> = {
  // ---- scoped: the organisation is a column, and a query must carry it -----
  agent_credentials: { kind: "scoped" },
  agent_sessions: { kind: "scoped" },
  annotations: { kind: "scoped" },
  annotations_current: { kind: "scoped" },
  artefact_access_grants: { kind: "scoped" },
  artefacts: { kind: "scoped" },
  comments: { kind: "scoped" },
  connector_enrolment_tokens: { kind: "scoped" },
  connectors: { kind: "scoped" },
  environments: { kind: "scoped" },
  events: { kind: "scoped" },
  findings: { kind: "scoped" },
  idempotency_keys: { kind: "scoped" },
  inbox_items: { kind: "scoped" },
  install_tokens: { kind: "scoped" },
  jobs: { kind: "scoped" },
  projects: { kind: "scoped" },
  published_services: { kind: "scoped" },
  review_exports: { kind: "scoped" },
  reviews: { kind: "scoped" },
  route_capabilities: { kind: "scoped" },
  users: { kind: "scoped" },
  verifications: { kind: "scoped" },
  viewer_sessions: { kind: "scoped" },
  workspaces: { kind: "scoped" },

  // ---- global by design ---------------------------------------------------
  organisations: {
    kind: "global",
    why: "the tenancy term itself: an organisation cannot be scoped by the organisation it is",
  },
  browser_workers: {
    kind: "global",
    why: "the pool is deployment-wide (ADR-0034); a worker belongs to no organisation, and its assignment is the only tenancy it has, which is what makes reading or changing it deployment administration",
  },
  connector_tls_material: {
    kind: "global",
    why: "the deployment's own certificate authority, created once when the app is built; it is key material and is not reachable from any tenant-facing route",
  },
  authentication_attempt_limits: {
    kind: "global",
    why: "a rate-limit counter keyed by a digest of the subject, deliberately not by tenant: a per-tenant counter would let one tenant's failures be hidden by another's",
  },
  event_streams: {
    kind: "global",
    why: "a sequence allocator keyed by stream, holding no data beyond the last sequence; it is written only by appendEvent and is reachable from no route",
  },
  schema_migrations: {
    kind: "global",
    why: "the migration ledger, which belongs to the installation",
  },

  // ---- inheriting an applied check ---------------------------------------
  control_leases: {
    kind: "inherits",
    parent: "browser_sessions",
    why: "one lease per browser session, reached only through the session, which carries the term",
  },
  verification_artefacts: {
    kind: "inherits",
    parent: "verifications",
    why: "evidence rows hanging off a verification, which carries the term; the parent applies the check before this table is reached",
  },
  event_outbox: {
    kind: "inherits",
    parent: "events",
    why: "post-commit fan-out rows keyed by event; the dispatcher scopes delivery by the stream the event carries",
  },
  browser_worker_projects: {
    kind: "inherits",
    parent: "browser_workers",
    why: "the assignment junction — and its parent carries NO tenancy term, so nothing about the shape supplies one. This is the RVP-91 shape: a guard read `projectIds === null` as authority over it, which let any tenant's ordinary user reassign a worker away from another tenant. The authority has to come from the route",
    provenBy: DEPLOYMENT_ADMINISTRATOR_PROOF,
  },

  // ---- scoped, listed here because it is reached by identifier ------------
  browser_sessions: { kind: "scoped" },
};

interface Relation {
  readonly name: string;
  readonly type: string;
  readonly hasOrganisationColumn: boolean;
}

/**
 * The relations a migrated database actually has.
 *
 * `information_schema` on a migrated database, never the migration SQL: a later
 * `ALTER TABLE` adding or dropping a column is invisible to a grep of the
 * migration that created the table, and this enumeration cannot be fooled by
 * one. `table_type` is read rather than filtered, so views are included —
 * `annotations_current` is a view and is read by identifier by the review
 * routes, so a query that asked only for `BASE TABLE` would omit the one
 * relation a caller reaches most often.
 */
async function relations(): Promise<Relation[]> {
  const rows = await postgres.pool.query<{
    table_name: string;
    table_type: string;
    organisation_columns: string;
  }>(
    `SELECT t.table_name,
            t.table_type,
            count(c.column_name) FILTER (WHERE c.column_name = 'organisation_id')::text
              AS organisation_columns
       FROM information_schema.tables t
       LEFT JOIN information_schema.columns c
              ON c.table_schema = t.table_schema AND c.table_name = t.table_name
      WHERE t.table_schema = 'public'
      GROUP BY t.table_name, t.table_type
      ORDER BY t.table_name`,
  );
  return rows.rows.map((row) => ({
    name: row.table_name,
    type: row.table_type,
    hasOrganisationColumn: row.organisation_columns !== "0",
  }));
}

test("every relation the migrations create is classified, and every classification names a relation", async () => {
  const present = await relations();
  const found = new Set(present.map((relation) => relation.name));
  const classified = new Set(Object.keys(INVENTORY));

  const unclassified = [...found].filter((name) => !classified.has(name)).sort();
  assert.deepEqual(
    unclassified,
    [],
    `these relations exist in the migrated schema and this gate does not classify them. ` +
      `Add each to INVENTORY as scoped, global (with the reason it belongs to the deployment) ` +
      `or inherits (naming the parent that applies the check): ${unclassified.join(", ")}`,
  );

  const stale = [...classified].filter((name) => !found.has(name)).sort();
  assert.deepEqual(
    stale,
    [],
    `these names are classified here and no longer exist. A classification nobody can reach is ` +
      `a claim about nothing: ${stale.join(", ")}`,
  );

  // Views are covered, not merely permitted. A run against a schema whose views
  // had all been dropped would satisfy every assertion above while covering
  // less than this file claims.
  const views = present.filter((relation) => relation.type === "VIEW").map((row) => row.name);
  assert.ok(views.length > 0, "the enumeration must include views, not only BASE TABLE");
  for (const view of views) assert.ok(classified.has(view), `the view ${view} is unclassified`);
});

test("each relation's classification matches the columns the migrated schema gives it", async () => {
  // Both directions. A `scoped` entry over a table with no organisation column
  // is a claim that cannot be enforced; a `global` or `inherits` entry over a
  // table that *has* one is a term nobody is obliged to use, which is how a
  // scoped table quietly becomes unscoped in practice.
  for (const relation of await relations()) {
    const classification = INVENTORY[relation.name];
    assert.ok(classification !== undefined, relation.name);
    if (classification.kind === "scoped") {
      assert.ok(
        relation.hasOrganisationColumn,
        `${relation.name} is classified scoped and has no organisation_id column`,
      );
    } else {
      assert.ok(
        !relation.hasOrganisationColumn,
        `${relation.name} is classified ${classification.kind} and does have an organisation_id ` +
          `column, so it should be classified scoped and every read of it must carry the term`,
      );
    }
  }
});

test("a junction whose parent carries no tenancy term names the guard that supplies one, and this file proves it", async () => {
  const present = new Set((await relations()).map((relation) => relation.name));

  for (const [name, classification] of Object.entries(INVENTORY)) {
    if (classification.kind !== "inherits") continue;
    assert.ok(
      present.has(classification.parent),
      `${name} inherits from ${classification.parent}, which does not exist`,
    );
    const parent = INVENTORY[classification.parent];
    assert.ok(parent !== undefined, `${classification.parent} is unclassified`);

    if (parent.kind === "scoped") {
      // The parent applies the term. Nothing further is owed.
      assert.equal(classification.provenBy, undefined, name);
      continue;
    }

    // "Junction whose parent is unscoped" — the RVP-91 shape. Naming a guard is
    // not enough on its own, so the named proof must exist in this file. A
    // classification that cited a test nobody wrote would be the same kind of
    // false comfort this gate exists to remove.
    assert.ok(
      classification.provenBy !== undefined,
      `${name} hangs off ${classification.parent}, which carries no tenancy term, so nothing ` +
        `about its shape supplies authority. Name the test that proves the route does.`,
    );
    assert.ok(
      PROOFS.has(classification.provenBy),
      `${name} names the proof "${classification.provenBy}" and this file registers no such test`,
    );
  }
});

test("the fixture reset covers every base table the migrations create", async () => {
  // The disposable database is part of this suite's trusted computing base
  // (`docs/TESTING.md` section 2). A table the reset misses carries one suite's
  // tenants into the next, which is a cross-tenant leak inside the harness —
  // and it would show up as another suite failing, days later, for a reason
  // that has nothing to do with it.
  const base = (await relations())
    .filter((relation) => relation.type === "BASE TABLE")
    .map((relation) => relation.name);
  const reset = new Set(FIXTURE_TABLES);
  // `connector_tls_material` is the deployment's certificate authority, created
  // once when the app is built; dropping it between tests would leave the
  // connector module without the identity it has already issued from.
  // `schema_migrations` is the ledger the reset exists on top of.
  const exempt = new Set(["connector_tls_material", "schema_migrations"]);

  const missed = base.filter((name) => !reset.has(name) && !exempt.has(name)).sort();
  assert.deepEqual(
    missed,
    [],
    `truncateAll does not clear these tables, so rows written by one test survive into the ` +
      `next: ${missed.join(", ")}`,
  );
  const gone = [...reset].filter((name) => !base.includes(name)).sort();
  assert.deepEqual(gone, [], `truncateAll names tables that no longer exist: ${gone.join(", ")}`);
});

// ===========================================================================
// Part 2 — two tenants, and every record reached by its own identifier
// ===========================================================================

interface Tenant {
  readonly organisationId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly connectorId: string;
  readonly browserSessionId: string;
  readonly artefactId: string;
  readonly grantId: string;
  readonly reviewId: string;
  readonly findingId: string;
  readonly commentId: string;
  readonly annotationId: string;
  readonly publishedServiceId: string;
  readonly environmentId: string;
  readonly verificationId: string;
  readonly inboxItemId: string;
  readonly agentCredentialId: string;
  /** An **organisation-wide** signed-in human: a real sign-in, `projectIds: null`. */
  readonly cookies: SessionCookies;
}

async function inject(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  headers: Record<string, string>,
  payload?: Record<string, unknown>,
) {
  return harness.built.app.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload }),
  });
}

/**
 * One tenant: an organisation, a project, and one of every record a route
 * reaches by identifier.
 *
 * Everything is created through the API a person or a worker uses, except the
 * published service. Publication resolves a connector that must be online, and
 * a connector process is another suite's subject (`route-publication.test.ts`);
 * what this file needs is a row a route can be asked for, so the row is
 * written directly and the route is what is under test.
 */
async function seedTenant(email: string): Promise<Tenant> {
  const seeded = await seedProjectAndWorker(harness);
  const cookies = await claimSessionFor(harness.built, postgres.pool, seeded.organisationId, {
    email,
  });
  const write = cookies.writeHeaders as Record<string, string>;

  const session = await inject(
    "POST",
    `/api/v1/projects/${seeded.projectId}/browser-sessions`,
    write,
    { viewport: MOBILE },
  );
  assert.equal(session.statusCode, 201, session.body);
  const browserSessionId = (session.json() as { data: { id: string } }).data.id;

  const intent = await inject(
    "POST",
    `/api/v1/projects/${seeded.projectId}/artefacts/uploads`,
    WORKER,
    {
      kind: "screenshot",
      content_type: "image/png",
      size_bytes: SCREENSHOT.byteLength,
      sha256: sha256(SCREENSHOT),
      retention_class: "verification_evidence",
      browser_session_id: browserSessionId,
      filename: "homepage.png",
    },
  );
  assert.equal(intent.statusCode, 201, intent.body);
  const { artefact_id: artefactId, upload_path: uploadPath } = (
    intent.json() as { data: { artefact_id: string; upload_path: string } }
  ).data;
  const uploaded = await harness.built.app.inject({
    method: "POST",
    url: uploadPath,
    headers: { ...WORKER, "content-type": "image/png" },
    payload: SCREENSHOT,
  });
  assert.equal(uploaded.statusCode, 202, uploaded.body);
  const completed = await inject("POST", `/api/v1/artefacts/${artefactId}/complete`, WORKER, {
    sha256: sha256(SCREENSHOT),
    size_bytes: SCREENSHOT.byteLength,
  });
  assert.equal(completed.statusCode, 200, completed.body);

  const grant = await inject("POST", `/api/v1/artefacts/${artefactId}/grants`, write);
  assert.equal(grant.statusCode, 201, grant.body);
  const grantId = (grant.json() as { data: { grant_id: string } }).data.grant_id;

  const review = await inject("POST", `/api/v1/projects/${seeded.projectId}/reviews`, write, {
    slug: "bugs-on-homepage",
    title: "Bugs on homepage",
    description: "Fix these before continuing.",
    captured_branch: "feat/homepage-refresh",
    captured_commit: COMMIT,
    captured_workspace_id: seeded.workspaceId,
    source_browser_session_id: browserSessionId,
  });
  assert.equal(review.statusCode, 201, review.body);
  const reviewId = (review.json() as { data: { id: string } }).data.id;

  const finding = await inject("POST", `/api/v1/reviews/${reviewId}/findings`, write, {
    title: "Hero heading overlaps the basket button",
    description: "At 390x844 the heading wraps onto the button.",
    severity: "high",
    url: "https://route-01jhomepage.internal.invalid/",
    viewport: MOBILE,
    scroll_position: { x: 0, y: 320 },
    captured_commit: COMMIT,
    screenshot_artefact_id: artefactId,
    acceptance_criteria: "The basket button is operable at 390x844.",
  });
  assert.equal(finding.statusCode, 201, finding.body);
  const findingId = (finding.json() as { data: { finding: { id: string } } }).data.finding.id;

  const comment = await inject("POST", `/api/v1/findings/${findingId}/comments`, write, {
    body: "Reproduced at 390x844.",
  });
  assert.equal(comment.statusCode, 201, comment.body);
  const commentId = (comment.json() as { data: { id: string } }).data.id;

  const annotation = await inject("POST", `/api/v1/findings/${findingId}/annotations`, write, {
    artefact_id: artefactId,
    type: "rectangle",
    geometry: { x: 0.1, y: 0.2, width: 0.4, height: 0.1 },
    label: "Overlap",
  });
  assert.equal(annotation.statusCode, 201, annotation.body);
  const annotationId = (annotation.json() as { data: { id: string } }).data.id;

  const publishedServiceId = `svc_${seeded.projectId.slice(4, 16)}`;
  await postgres.pool.query(
    `INSERT INTO published_services (
        id, organisation_id, project_id, connector_id, workspace_id, public_alias,
        local_host, local_port, protocol, allowed_browser_session_ids, expires_at, status, ready_at)
     VALUES ($1, $2, $3, $4, $5, $6, '127.0.0.1', 4321, 'http', ARRAY[$7]::text[],
             now() + interval '1 hour', 'ready', now())`,
    [
      publishedServiceId,
      seeded.organisationId,
      seeded.projectId,
      seeded.connectorId,
      seeded.workspaceId,
      `alias-${seeded.projectId.slice(4, 16)}`,
      browserSessionId,
    ],
  );

  // A verification, so the route that reads one by identifier has something to
  // read for its owner. Without it that probe would compare two 404s, one of
  // them for the honest reason that no verification exists, and the owner leg
  // would flag it as vacuous — which is the check working.
  const claimed = await inject("PATCH", `/api/v1/findings/${findingId}`, write, {
    expected_version: 1,
    status: "CLAIMED",
  });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const verification = await inject("POST", `/api/v1/findings/${findingId}/verifications`, write, {
    summary: "Raised the collapse breakpoint to 900px.",
    branch: "redesign",
    commit: FIXED_COMMIT,
    tested_viewports: [MOBILE, DESKTOP],
    checks: {
      reproduced_before: true,
      console_errors_reviewed: true,
      network_failures_reviewed: true,
    },
    artefact_ids: [artefactId],
  });
  assert.equal(verification.statusCode, 201, verification.body);
  const verificationId = (verification.json() as { data: { verification_id: string } }).data
    .verification_id;

  const credential = await inject(
    "POST",
    `/api/v1/organisations/${seeded.organisationId}/agent-credentials`,
    ADMIN,
    { project_ids: [seeded.projectId], capabilities: ["review:read"], label: "isolation gate" },
  );
  assert.equal(credential.statusCode, 201, credential.body);
  const agentCredentialId = (credential.json() as { data: { credential_id: string } }).data
    .credential_id;

  const environments = await postgres.pool.query<{ environment_id: string }>(
    "SELECT environment_id FROM connectors WHERE id = $1",
    [seeded.connectorId],
  );
  const environmentId = environments.rows[0]?.environment_id;
  assert.ok(typeof environmentId === "string");

  // An inbox item is written directly. Producing one through the product means
  // assigning a review to an agent session, which is `inbox.test.ts`'s subject;
  // what this file needs is a row a route can be asked for by identifier, and
  // the route is what is under test.
  const inboxItemId = `inb_${seeded.projectId.slice(4, 16)}`;
  await postgres.pool.query(
    `INSERT INTO inbox_items (
        id, organisation_id, project_id, recipient_type, recipient_id, type, title,
        review_id, finding_id, status)
     VALUES ($1, $2, $3, 'agent_session', 'ags_isolation_gate', 'review_assigned',
             'Bugs on homepage', $4, $5, 'pending')`,
    [inboxItemId, seeded.organisationId, seeded.projectId, reviewId, findingId],
  );

  return {
    organisationId: seeded.organisationId,
    projectId: seeded.projectId,
    workspaceId: seeded.workspaceId,
    connectorId: seeded.connectorId,
    browserSessionId,
    artefactId,
    grantId,
    reviewId,
    findingId,
    commentId,
    annotationId,
    publishedServiceId,
    environmentId,
    verificationId,
    inboxItemId,
    agentCredentialId,
    cookies,
  };
}

/** What a probe substitutes: the tenant's identifier, or one that never existed. */
type Subject =
  | "review"
  | "finding"
  | "comment"
  | "annotation"
  | "artefact"
  | "grant"
  | "browserSession"
  | "project"
  | "publishedService"
  | "inboxItem"
  | "environment";

/**
 * An identifier of the right shape that no row has.
 *
 * The shape matters. A refusal that differed because one identifier parsed and
 * the other did not would be a difference about syntax rather than about
 * existence, and the comparison below would be meaningless.
 */
const UNKNOWN: Readonly<Record<Subject, string>> = {
  review: "rvw_does_not_exist_at_all",
  finding: "fnd_does_not_exist_at_all",
  comment: "cmt_does_not_exist_at_all",
  annotation: "ann_does_not_exist_at_all",
  artefact: "art_does_not_exist_at_all",
  grant: "agr_does_not_exist_at_all",
  browserSession: "brs_does_not_exist_at_all",
  project: "prj_does_not_exist_at_all",
  publishedService: "svc_does_not_exist_at_all",
  inboxItem: "inb_does_not_exist_at_all",
  environment: "env_does_not_exist_at_all",
};

function identifierOf(tenant: Tenant, subject: Subject): string {
  switch (subject) {
    case "review":
      return tenant.reviewId;
    case "finding":
      return tenant.findingId;
    case "comment":
      return tenant.commentId;
    case "annotation":
      return tenant.annotationId;
    case "artefact":
      return tenant.artefactId;
    case "grant":
      return tenant.grantId;
    case "browserSession":
      return tenant.browserSessionId;
    case "project":
      return tenant.projectId;
    case "publishedService":
      return tenant.publishedServiceId;
    case "inboxItem":
      return tenant.inboxItemId;
    case "environment":
      return tenant.environmentId;
  }
}

interface Probe {
  readonly subject: Subject;
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /**
   * The Fastify route template.
   *
   * A template rather than a builder so that the coverage check below can match
   * a probe against the server's own route table: a probe naming a path this
   * server does not register would be a probe of nothing, and a route this list
   * does not name would be a route nobody checked.
   */
  readonly route: string;
  /** Built from the **victim**, because that is the request an attacker sends. */
  readonly payload?: (victim: Tenant) => Record<string, unknown>;
  /** Trailing path parameters, where the route names a record under the first. */
  readonly rest?: (tenant: Tenant) => readonly string[];
}

/**
 * One probe's concrete URL, with `id` substituted for the subject's parameter.
 *
 * A route with more than one parameter names a record hanging off the first.
 * The first is what the route resolves in the caller's scope, so the rest come
 * from `rest` where the fixture has them and from an identifier that never
 * existed where it does not.
 */
function urlFor(probe: Probe, id: string, tenant: Tenant): string {
  const parameters = probe.route.match(/:[A-Za-z]+/gu) ?? [];
  let url = probe.route.replace(parameters[0] as string, id);
  const rest = probe.rest?.(tenant) ?? [];
  parameters.slice(1).forEach((parameter, index) => {
    url = url.replace(parameter, rest[index] ?? "unk_does_not_exist_at_all");
  });
  return url;
}

const REVIEW_TRANSITIONS = ["assign", "accept", "archive", "request-review", "reopen"] as const;
const FINDING_TRANSITIONS = ["claim", "accept", "wont-fix", "reopen"] as const;
const INBOX_ACTS = ["acknowledge", "complete", "dismiss"] as const;

/**
 * Every route that reaches a tenant-owned record by an identifier in its path
 * and is reachable by a signed-in person.
 *
 * Grouped by subject so each group runs against its own freshly seeded pair of
 * tenants: the owner leg of a `DELETE` changes the world, and a group that
 * shared a fixture with the next would make the order of this list part of the
 * behaviour under test.
 *
 * The list is checked against the server's own route table below, so it cannot
 * quietly fall behind the routes.
 */
const PROBES: readonly Probe[] = [
  // ---- reviews -----------------------------------------------------------
  { subject: "review", method: "GET", route: "/api/v1/reviews/:reviewId" },
  { subject: "review", method: "GET", route: "/api/v1/reviews/:reviewId/findings" },
  { subject: "review", method: "GET", route: "/api/v1/reviews/:reviewId/comments" },
  { subject: "review", method: "GET", route: "/api/v1/reviews/:reviewId/export" },
  {
    subject: "review",
    method: "POST",
    route: "/api/v1/reviews/:reviewId/comments",
    payload: () => ({ body: "Seen from another organisation." }),
  },
  {
    subject: "review",
    method: "POST",
    route: "/api/v1/reviews/:reviewId/findings",
    payload: (victim) => ({
      title: "Planted from another organisation",
      description: "This must never be written.",
      severity: "low",
      url: "https://route-01jhomepage.internal.invalid/",
      viewport: MOBILE,
      scroll_position: { x: 0, y: 0 },
      captured_commit: COMMIT,
      screenshot_artefact_id: victim.artefactId,
    }),
  },
  {
    subject: "review",
    method: "PATCH",
    route: "/api/v1/reviews/:reviewId",
    payload: () => ({ expected_version: 1, title: "Renamed by a stranger" }),
  },
  ...REVIEW_TRANSITIONS.map(
    (act): Probe => ({
      subject: "review",
      method: "POST",
      route: `/api/v1/reviews/:reviewId/${act}`,
      payload: () => ({ expected_version: 1, reason: "Taken by a stranger." }),
    }),
  ),

  // ---- findings ----------------------------------------------------------
  { subject: "finding", method: "GET", route: "/api/v1/findings/:findingId" },
  { subject: "finding", method: "GET", route: "/api/v1/findings/:findingId/annotations" },
  { subject: "finding", method: "GET", route: "/api/v1/findings/:findingId/comments" },
  { subject: "finding", method: "GET", route: "/api/v1/findings/:findingId/verification" },
  { subject: "finding", method: "GET", route: "/api/v1/findings/:findingId/verifications" },
  {
    subject: "finding",
    method: "GET",
    route: "/api/v1/findings/:findingId/verifications/:verificationId",
    rest: (tenant) => [tenant.verificationId],
  },
  {
    subject: "finding",
    method: "POST",
    route: "/api/v1/findings/:findingId/comments",
    payload: () => ({ body: "Seen from another organisation." }),
  },
  {
    subject: "finding",
    method: "POST",
    route: "/api/v1/findings/:findingId/annotations",
    payload: (victim) => ({
      artefact_id: victim.artefactId,
      type: "rectangle",
      geometry: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
      label: "Planted",
    }),
  },
  {
    subject: "finding",
    method: "POST",
    route: "/api/v1/findings/:findingId/verifications",
    payload: (victim) => ({
      summary: "Planted from another organisation.",
      branch: "redesign",
      commit: FIXED_COMMIT,
      tested_viewports: [MOBILE, DESKTOP],
      checks: {
        reproduced_before: true,
        console_errors_reviewed: true,
        network_failures_reviewed: true,
      },
      artefact_ids: [victim.artefactId],
    }),
  },
  {
    subject: "finding",
    method: "PATCH",
    route: "/api/v1/findings/:findingId",
    payload: () => ({ expected_version: 1, status: "CLAIMED" }),
  },
  ...FINDING_TRANSITIONS.map(
    (act): Probe => ({
      subject: "finding",
      method: "POST",
      route: `/api/v1/findings/:findingId/${act}`,
      payload: () => ({ expected_version: 1, reason: "Taken by a stranger." }),
    }),
  ),

  // ---- comments and annotations ------------------------------------------
  {
    subject: "comment",
    method: "PATCH",
    route: "/api/v1/comments/:commentId",
    payload: () => ({ expected_revision: 1, body: "Edited by a stranger." }),
  },
  {
    subject: "annotation",
    method: "PATCH",
    route: "/api/v1/annotations/:annotationId",
    payload: () => ({ expected_revision: 1, label: "Edited by a stranger" }),
  },
  { subject: "annotation", method: "DELETE", route: "/api/v1/annotations/:annotationId" },

  // ---- artefacts ---------------------------------------------------------
  { subject: "artefact", method: "GET", route: "/api/v1/artefacts/:artefactId" },
  { subject: "artefact", method: "POST", route: "/api/v1/artefacts/:artefactId/grants" },
  { subject: "artefact", method: "DELETE", route: "/api/v1/artefacts/:artefactId" },
  { subject: "grant", method: "GET", route: "/api/v1/artefact-content/:grantId" },

  // ---- browser sessions --------------------------------------------------
  { subject: "browserSession", method: "GET", route: "/api/v1/browser-sessions/:sessionId" },
  {
    subject: "browserSession",
    method: "GET",
    route: "/api/v1/browser-sessions/:sessionId/timeline",
  },
  {
    subject: "browserSession",
    method: "POST",
    route: "/api/v1/browser-sessions/:sessionId/commands",
    payload: () => ({ control_epoch: 1, command: { command: "snapshot", timeout_ms: 5000 } }),
  },
  {
    subject: "browserSession",
    method: "POST",
    route: "/api/v1/browser-sessions/:sessionId/allocate",
    payload: (victim) => ({ published_service_id: victim.publishedServiceId }),
  },
  {
    subject: "browserSession",
    method: "POST",
    route: "/api/v1/browser-sessions/:sessionId/control/request",
    payload: () => ({ controller_type: "system" }),
  },
  {
    subject: "browserSession",
    method: "POST",
    route: "/api/v1/browser-sessions/:sessionId/control/release",
    payload: () => ({ control_epoch: 1 }),
  },
  {
    subject: "browserSession",
    method: "POST",
    route: "/api/v1/browser-sessions/:sessionId/pause",
    payload: () => ({ control_epoch: 1 }),
  },
  {
    subject: "browserSession",
    method: "POST",
    route: "/api/v1/browser-sessions/:sessionId/resume",
    payload: () => ({ control_epoch: 1 }),
  },
  {
    subject: "browserSession",
    method: "POST",
    route: "/api/v1/browser-sessions/:sessionId/terminate",
    payload: () => ({ control_epoch: 1 }),
  },

  // ---- projects ----------------------------------------------------------
  { subject: "project", method: "GET", route: "/api/v1/projects/:projectId" },
  { subject: "project", method: "GET", route: "/api/v1/projects/:projectId/reviews" },
  { subject: "project", method: "GET", route: "/api/v1/projects/:projectId/workspaces" },
  { subject: "project", method: "GET", route: "/api/v1/projects/:projectId/browser-sessions" },
  { subject: "project", method: "GET", route: "/api/v1/projects/:projectId/published-services" },
  { subject: "project", method: "GET", route: "/api/v1/projects/:projectId/activity" },
  { subject: "project", method: "GET", route: "/api/v1/projects/:projectId/inbox" },
  { subject: "project", method: "GET", route: "/api/v1/projects/:projectId/environments" },
  {
    subject: "project",
    method: "POST",
    route: "/api/v1/projects/:projectId/reviews",
    payload: (victim) => ({
      slug: "planted-by-a-stranger",
      title: "Planted",
      description: "This must never be written.",
      captured_branch: "main",
      captured_commit: COMMIT,
      captured_workspace_id: victim.workspaceId,
      source_browser_session_id: victim.browserSessionId,
    }),
  },
  {
    subject: "project",
    method: "POST",
    route: "/api/v1/projects/:projectId/browser-sessions",
    payload: () => ({ viewport: MOBILE }),
  },
  {
    subject: "project",
    method: "POST",
    route: "/api/v1/projects/:projectId/published-services",
    payload: (victim) => ({
      local_port: 5173,
      protocol: "http",
      workspace_id: victim.workspaceId,
      browser_session_ids: [victim.browserSessionId],
    }),
  },
  {
    subject: "project",
    method: "PATCH",
    route: "/api/v1/projects/:projectId",
    payload: () => ({ expected_version: 1, name: "Renamed by a stranger" }),
  },
  { subject: "project", method: "DELETE", route: "/api/v1/projects/:projectId" },

  // ---- published services ------------------------------------------------
  {
    subject: "publishedService",
    method: "POST",
    route: "/api/v1/published-services/:serviceId/capabilities",
    payload: (victim) => ({ browser_session_id: victim.browserSessionId }),
  },
  {
    subject: "publishedService",
    method: "DELETE",
    route: "/api/v1/published-services/:serviceId",
  },

  // ---- the inbox ---------------------------------------------------------
  ...INBOX_ACTS.map(
    (act): Probe => ({
      subject: "inboxItem",
      method: "POST",
      route: `/api/v1/inbox/:itemId/${act}`,
      payload: () => ({ note: "Handled by a stranger." }),
    }),
  ),

  // ---- environments ------------------------------------------------------
  { subject: "environment", method: "GET", route: "/api/v1/environments/:environmentId" },
];

/**
 * Routes taking a record identifier that this gate deliberately does not probe,
 * and why.
 *
 * An exemption has to be written down. A route absent from **both** lists fails
 * the coverage check below, so "nobody thought about it" and "somebody decided"
 * are different states of this file rather than the same silence.
 */
const NOT_PROBED_HERE: Readonly<Record<string, string>> = {
  "POST /api/v1/organisations/:organisationId/projects":
    "bearer-only provisioning; no human session reaches it at all, which its own test below asserts",
  "POST /api/v1/organisations/:organisationId/agent-credentials": "the same",
  "POST /api/v1/projects/:projectId/viewer-sessions":
    "bearer-only: minting a narrowed session is how the project-scoped probe itself is obtained",
  "POST /api/v1/projects/:projectId/artefacts/uploads":
    "a machine-credential route; the worker's own project scoping is apps/server/test/security.test.ts",
  "POST /api/v1/artefacts/:artefactId/content":
    "a machine-credential route; covered by artefact-security.test.ts",
  "POST /api/v1/artefacts/:artefactId/complete": "the same",
  "PUT /api/v1/projects/:projectId/workspaces":
    "a bearer-only route: a workspace is reported by a connector or written by the administrator, never by a signed-in person. The owner leg caught this probe proving nothing, which is what it is for; connector-lifecycle.test.ts covers the tenancy",
  "DELETE /api/v1/agent-credentials/:credentialId":
    "bearer-only for the same reason, and caught the same way: issuing and revoking an agent credential is administration, and connector-agent-credentials.test.ts covers the scope one is issued in",
  "PUT /api/v1/browser-workers/:workerId/assignments":
    "deployment administration over a pool that belongs to no organisation (ADR-0034); proved by its own test below",
  "GET /api/v1/connectors/:connectorId":
    "the connector surface, whose foreign-versus-unknown equality is connector-lifecycle.test.ts",
  "POST /api/v1/connectors/:connectorId/revoke": "the same",
  "POST /internal/v1/browser-sessions/:sessionId/status":
    "the worker channel, authenticated by the worker credential; security.test.ts covers it",
  "GET /ws/v1/browser-sessions/:sessionId/live":
    "a WebSocket handshake rather than a request-response route; live.test.ts asserts the refusal happens before the upgrade exists",
  "GET /ws/v1/projects/:projectId/events":
    "the same, for the project event stream; event-stream.test.ts",
};

const SUBJECTS: readonly Subject[] = [
  ...new Set(PROBES.map((probe) => probe.subject)),
] as readonly Subject[];

/** Replaces the request identifier, the only per-request member of a body. */
function normalise(body: string): unknown {
  const parsed = JSON.parse(body) as { meta?: { request_id?: string } };
  if (parsed.meta !== undefined) parsed.meta.request_id = "req_normalised";
  return parsed;
}

function outcome(response: { statusCode: number; body: string }): string {
  if (response.statusCode < 400) return `${String(response.statusCode)} ok`;
  const parsed = JSON.parse(response.body) as { error?: { code?: string } };
  return `${String(response.statusCode)} ${parsed.error?.code ?? "?"}`;
}

/**
 * Every base table an attacker's write could land in, **derived from the
 * inventory** rather than listed.
 *
 * A scoped table is exactly a table with an `organisation_id`, which is exactly
 * a table a row can be planted in under a victim's tenancy.
 *
 * **What this is not:** the first warning that a table was added. The inventory
 * test above already fails on an unclassified relation, so a new table is never
 * silent — it stops the gate until somebody classifies it. What a hand list
 * added was a *second* place to remember afterwards, and nothing failed when
 * that second place was forgotten: a table could be correctly classified
 * `scoped` and still sit outside this sweep, with the "no write landed"
 * assertion passing over less than it claimed. Deriving removes the second
 * place rather than supplying the first warning, and that is the whole of the
 * improvement.
 *
 * Views are excluded because they hold no rows of their own; the base table
 * beneath each one is counted instead.
 */
async function scopedTables(): Promise<string[]> {
  return (await relations())
    .filter(
      (relation) => relation.type === "BASE TABLE" && INVENTORY[relation.name]?.kind === "scoped",
    )
    .map((relation) => relation.name)
    .sort();
}

/** A row count over every table an attacker's write could land in. */
async function rowCounts(organisationId: string, tables: readonly string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const rows = await postgres.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE organisation_id = $1`,
      [organisationId],
    );
    counts[table] = Number(rows.rows[0]?.count ?? "0");
  }
  return counts;
}

for (const subject of SUBJECTS) {
  const group = PROBES.filter((probe) => probe.subject === subject);

  test(`another organisation's ${subject} is, to an organisation-wide user, byte-identical to one that never existed`, async () => {
    const victim = await seedTenant("victim@localhost");
    const attacker = await seedTenant("attacker@localhost");
    const tables = await scopedTables();
    assert.ok(tables.length > 10, `only ${String(tables.length)} scoped tables were swept`);

    for (const probe of group) {
      const payload = probe.payload?.(victim);
      const label = `${probe.method} ${probe.route}`;
      // Bracketing only the attacker's two calls. The owner leg below is a
      // legitimate write and is meant to change things.
      const before = await rowCounts(victim.organisationId, tables);

      const foreign = await inject(
        probe.method,
        urlFor(probe, identifierOf(victim, subject), victim),
        attacker.cookies.writeHeaders as Record<string, string>,
        payload,
      );
      const unknown = await inject(
        probe.method,
        urlFor(probe, UNKNOWN[subject], victim),
        attacker.cookies.writeHeaders as Record<string, string>,
        payload,
      );

      // Bodies, not statuses. A matching status carrying a different message,
      // or a different `details` object, tells a caller the identifier exists
      // exactly as a different status would (`docs/API.md` section 5).
      assert.deepEqual(
        normalise(foreign.body),
        normalise(unknown.body),
        `${label}: a foreign identifier is distinguishable from an unknown one.\n` +
          `  foreign: ${foreign.body}\n  unknown: ${unknown.body}`,
      );
      assert.ok(foreign.statusCode >= 400, `${label}: the foreign call succeeded: ${foreign.body}`);

      // Neither attacker call wrote anything into the victim's organisation.
      // A refusal that reports an error after the write has landed is still a
      // cross-tenant write.
      assert.deepEqual(
        await rowCounts(victim.organisationId, tables),
        before,
        `${label}: a refused cross-tenant call still wrote into the victim's organisation`,
      );

      // The refusal must not carry the victim's tenancy back to the caller.
      assert.ok(
        !foreign.body.includes(victim.organisationId),
        `${label}: the refusal named the victim's organisation`,
      );
      assert.ok(
        !foreign.body.includes(victim.projectId),
        `${label}: the refusal named the victim's project`,
      );

      // The discriminator. Without this leg, a route that refused on CSRF, on
      // credential shape or on body validation *before* resolving the record
      // would produce two identical refusals and pass, while having no tenancy
      // check at all. Running the same call as the owner is what tells the two
      // apart.
      const owner = await inject(
        probe.method,
        urlFor(probe, identifierOf(victim, subject), victim),
        victim.cookies.writeHeaders as Record<string, string>,
        payload,
      );
      assert.notEqual(
        outcome(owner),
        outcome(foreign),
        `${label}: the owner earns the same answer as a stranger, so the comparison above ` +
          `proves nothing about tenancy. Either the route is refusing everyone before it ` +
          `resolves anything, or the fixture does not put this route in reach of its owner.\n` +
          `  owner: ${owner.body}`,
      );
    }
  });
}

test("the organisation provisioning routes take no human session at all, in any organisation", async () => {
  // These are the Stage 0 provisioning routes, and they are **bearer only**:
  // `requireAdministrator` refuses anything that is not the deployment's
  // bootstrap credential, before any lookup and before any body is read.
  //
  // That is why they are not in the matrix above. A cross-tenant probe with a
  // cookie session would compare two `AUTHENTICATION_REQUIRED` refusals and
  // pass while proving nothing about tenancy — which is exactly the vacuous
  // pass the owner leg exists to catch, and it caught this one. The property
  // these routes have is stronger and different, so it is stated separately.
  //
  // If a later change makes one of them reachable by a signed-in person, this
  // test fails, and whoever makes that change has to add the tenancy term and
  // move the route into the matrix. Reaching them today needs a credential that
  // is deployment-wide by construction, so there is no second tenant for it to
  // be wrong about.
  const victim = await seedTenant("victim@localhost");
  const attacker = await seedTenant("attacker@localhost");

  for (const route of [
    { path: `/api/v1/organisations/${victim.organisationId}/projects`, payload: { name: "Planted", slug: "planted-by-a-stranger" } },
    {
      path: `/api/v1/organisations/${victim.organisationId}/agent-credentials`,
      payload: { project_ids: [victim.projectId], capabilities: ["review:read"], label: "planted" },
    },
  ]) {
    // Every human credential shape, against another organisation and against
    // its own. All four are refused identically, because none of them is a
    // bearer credential.
    for (const [who, headers] of [
      ["a stranger", attacker.cookies.writeHeaders],
      ["its own organisation's user", victim.cookies.writeHeaders],
    ] as const) {
      const refused = await inject(
        "POST",
        route.path,
        headers as Record<string, string>,
        route.payload,
      );
      assert.equal(refused.statusCode, 401, `${route.path} as ${who}: ${refused.body}`);
      assert.equal(
        (refused.json() as { error: { code: string } }).error.code,
        "AUTHENTICATION_REQUIRED",
        refused.body,
      );
    }
  }

  const projects = await postgres.pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM projects WHERE organisation_id = $1",
    [victim.organisationId],
  );
  assert.equal(Number(projects.rows[0]?.count), 1, "no project was planted");
  // One per tenant, from the fixture. What matters is that no *further* one was
  // planted by a caller with no authority to mint it.
  const credentials = await postgres.pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM agent_credentials WHERE organisation_id = $1",
    [victim.organisationId],
  );
  assert.equal(Number(credentials.rows[0]?.count), 1);

  // And the bootstrap credential still reaches them, so the refusals above are
  // about the credential rather than about the routes being gone.
  const created = await inject(
    "POST",
    `/api/v1/organisations/${victim.organisationId}/projects`,
    ADMIN,
    { name: "Sibling", slug: `sibling-${victim.projectId.slice(4, 14)}` },
  );
  assert.equal(created.statusCode, 201, created.body);
});

test("every route that takes a record identifier is probed here or exempted with a reason", async () => {
  // The same discipline as the table inventory above, applied to routes: the set
  // is read from the server's own route table rather than listed, so a route
  // added under any prefix by any plugin is in scope. A list only ever covers
  // the routes somebody remembered, and the routes somebody forgot are the ones
  // this gate exists for.
  const registered = registeredRoutes(harness.built.app.printRoutes({ commonPrefix: false }));
  assert.ok(registered.length > 40, `the route table parsed to ${String(registered.length)} routes`);
  // The parser has to be right about at least one parameterised route deep in
  // the tree, or a silent parse failure would empty the check below.
  assert.ok(
    registered.some(
      (route) =>
        route.method === "GET" &&
        route.route === "/api/v1/findings/:findingId/verifications/:verificationId",
    ),
    `the route table did not parse: ${registered.map(routeKey).join(", ")}`,
  );

  const probed = new Set(PROBES.map((probe) => `${probe.method} ${probe.route}`));
  const exempt = new Set(Object.keys(NOT_PROBED_HERE));

  const unexamined = registered
    .filter((route) => /:[A-Za-z]+/u.test(route.route))
    .map(routeKey)
    .filter((key) => !probed.has(key) && !exempt.has(key))
    .sort();
  assert.deepEqual(
    unexamined,
    [],
    `these routes take a record identifier and this gate neither probes them nor records why ` +
      `not. Add each to PROBES, or to NOT_PROBED_HERE naming the suite that covers it:\n  ` +
      unexamined.join("\n  "),
  );

  const known = new Set(registered.map(routeKey));
  const phantom = [...probed, ...exempt].filter((key) => !known.has(key)).sort();
  assert.deepEqual(
    phantom,
    [],
    `these are named here and this server registers no such route, so they are probes of ` +
      `nothing:\n  ${phantom.join("\n  ")}`,
  );
});

test("the root test:security command names every package that holds a gate", async () => {
  // The last hand-written list in this deliverable, and the one furthest from
  // the gates it decides. `pnpm test:security` is what a release pipeline names
  // (docs/TESTING.md section 16), and it names its packages explicitly because
  // `pnpm -r --if-present run <missing>` exits **0** having run nothing —
  // measured, not assumed — so a deleted script would turn the whole command
  // into a green no-op. An explicit filter exits 1 instead.
  //
  // That trades one silent failure for a smaller one: a package that grows a
  // gate and is not added to the filter would be quietly outside the command
  // while `pnpm test` went on running its files. So the filter is reconciled
  // here against the packages that actually hold gate files. The rule this is
  // an instance of: when a list decides coverage, something has to compare it
  // to the thing it claims to cover.
  const root = new URL("../../../", import.meta.url);
  const rootScript = JSON.parse(await readFile(new URL("package.json", root), "utf8")) as {
    scripts: Record<string, string>;
  };
  const command = rootScript.scripts["test:security"];
  assert.ok(command !== undefined, "the root package.json declares no test:security");

  // Which packages actually hold a gate, read off the filesystem.
  const apps = await readdir(new URL("apps/", root), { withFileTypes: true });
  const holders: string[] = [];
  for (const entry of apps) {
    if (!entry.isDirectory()) continue;
    const testDirectory = new URL(`apps/${entry.name}/test/`, root);
    const files = await readdir(testDirectory).catch(() => [] as string[]);
    if (!files.some((file) => /^security-gate-.*\.test\.ts$/u.test(file))) continue;
    const manifest = JSON.parse(
      await readFile(new URL(`apps/${entry.name}/package.json`, root), "utf8"),
    ) as { name: string; scripts?: Record<string, string> };
    assert.ok(
      manifest.scripts?.["test:security"] !== undefined,
      `${entry.name} holds security-gate files and declares no test:security script, so ` +
        `pnpm test:security would not run them`,
    );
    holders.push(manifest.name);
  }
  assert.ok(holders.length >= 2, `only ${String(holders.length)} packages hold gate files`);

  const unnamed = holders.filter((name) => !command.includes(name)).sort();
  assert.deepEqual(
    unnamed,
    [],
    `these packages hold security-gate files and the root test:security command does not ` +
      `name them, so the command reports on less than it claims:\n  ${unnamed.join("\n  ")}`,
  );

  // And the reverse: a package named by the command that holds no gate would
  // make the command fail for a reason unrelated to security, which is how a
  // gate stops being read.
  const named = [...command.matchAll(/@reviewplane\/[a-z-]+/gu)].map((match) => match[0]);
  const empty = named.filter((name) => !holders.includes(name)).sort();
  assert.deepEqual(
    empty,
    [],
    `the root test:security command names these packages and they hold no gate:\n  ` +
      empty.join("\n  "),
  );
});

test("every suite an exemption hands a route to exists", async () => {
  // An exemption's reason names the suite that covers the route instead. That
  // is a **coverage claim**, and until this test nothing executed it: rename or
  // delete one of those files and this gate would go on naming it, confidently
  // and wrongly, while the route it hands over became covered by nothing.
  //
  // It is the same shape as the classification check above, and deliberately
  // just as narrow: it proves the file is there, **not** that the suite still
  // covers the route. Nothing cheap could prove the second, and a check that
  // read as stronger than it is would be the same defect wearing a different
  // hat. The realistic decay is a rename or a deletion, and that is what this
  // sees.
  const directory = new URL(".", import.meta.url);
  const named = new Set<string>();
  for (const reason of Object.values(NOT_PROBED_HERE)) {
    for (const suite of reason.match(/[A-Za-z0-9-]+\.test\.ts/gu) ?? []) named.add(suite);
  }
  assert.ok(named.size > 0, "no exemption names a suite, so this check is asserting nothing");

  const missing: string[] = [];
  for (const suite of [...named].sort()) {
    const exists = await stat(new URL(suite, directory)).then(
      () => true,
      () => false,
    );
    if (!exists) missing.push(suite);
  }
  assert.deepEqual(
    missing,
    [],
    `these suites are named in NOT_PROBED_HERE as covering a route this gate skips, and no ` +
      `such file exists beside this one:\n  ${missing.join("\n  ")}`,
  );
});

test("no listing an organisation-wide user can reach carries another organisation's rows", async () => {
  const victim = await seedTenant("victim@localhost");
  const attacker = await seedTenant("attacker@localhost");

  const listings: readonly { readonly url: string; readonly forbidden: readonly string[] }[] = [
    {
      url: "/api/v1/projects",
      forbidden: [victim.projectId, victim.organisationId],
    },
    { url: "/api/v1/organisation", forbidden: [victim.organisationId] },
    { url: "/api/v1/connectors", forbidden: [victim.connectorId, victim.organisationId] },
    {
      url: `/api/v1/projects/${attacker.projectId}/reviews`,
      forbidden: [victim.reviewId, victim.projectId],
    },
    {
      url: `/api/v1/projects/${attacker.projectId}/workspaces`,
      forbidden: [victim.workspaceId, victim.projectId],
    },
    {
      url: `/api/v1/projects/${attacker.projectId}/browser-sessions`,
      forbidden: [victim.browserSessionId],
    },
    {
      url: `/api/v1/projects/${attacker.projectId}/published-services`,
      forbidden: [victim.publishedServiceId],
    },
    {
      url: `/api/v1/projects/${attacker.projectId}/activity`,
      forbidden: [victim.reviewId, victim.findingId, victim.browserSessionId],
    },
    { url: `/api/v1/projects/${attacker.projectId}/inbox`, forbidden: [victim.findingId] },
  ];

  for (const listing of listings) {
    const response = await inject(
      "GET",
      listing.url,
      attacker.cookies.readHeaders as Record<string, string>,
    );
    assert.ok(response.statusCode < 400, `${listing.url}: ${response.body}`);
    for (const identifier of listing.forbidden) {
      assert.ok(
        !response.body.includes(identifier),
        `${listing.url} disclosed ${identifier}`,
      );
    }
  }

  // And the attacker's own rows are there, so the assertions above are about
  // the tenancy term rather than about a listing that returns nothing.
  const own = await inject(
    "GET",
    "/api/v1/projects",
    attacker.cookies.readHeaders as Record<string, string>,
  );
  assert.ok(own.body.includes(attacker.projectId), own.body);
});

test("a search cannot reach another organisation's reviews or findings by their text", async () => {
  // `docs/TESTING.md` section 10: "Project A agent cannot **search** project B's
  // reviews or findings." A search is a second way in, and a filter applied
  // after an unscoped query looks identical from the outside until the term the
  // caller searched for is one only the other tenant has.
  const victim = await seedTenant("victim@localhost");
  const attacker = await seedTenant("attacker@localhost");

  for (const query of [
    `q=${encodeURIComponent("Bugs on homepage")}`,
    "slug=bugs-on-homepage",
    `commit=${COMMIT.slice(0, 12)}`,
    "branch=feat/homepage-refresh",
    "status=DRAFT",
  ]) {
    const searched = await inject(
      "GET",
      `/api/v1/projects/${attacker.projectId}/reviews?${query}`,
      attacker.cookies.readHeaders as Record<string, string>,
    );
    assert.ok(searched.statusCode < 400, `${query}: ${searched.body}`);
    assert.ok(!searched.body.includes(victim.reviewId), `${query} reached the victim's review`);
  }

  // The same search over the attacker's own project finds the attacker's own
  // review, so the absences above are the tenancy term and not the filter.
  const own = await inject(
    "GET",
    `/api/v1/projects/${attacker.projectId}/reviews?slug=bugs-on-homepage`,
    attacker.cookies.readHeaders as Record<string, string>,
  );
  assert.ok(own.body.includes(attacker.reviewId), own.body);
});

// ===========================================================================
// Part 3 — the other two probes, kept beside the first and never instead of it
// ===========================================================================

/** A viewer session narrowed to one project — the shape that always refused. */
async function projectScopedCookie(projectId: string): Promise<Record<string, string>> {
  const minted = await inject("POST", `/api/v1/projects/${projectId}/viewer-sessions`, ADMIN);
  assert.equal(minted.statusCode, 201, minted.body);
  const token = (minted.json() as { data: { token: string } }).data.token;
  return { cookie: `reviewplane_viewer=${encodeURIComponent(token)}` };
}

test("a project-scoped session is refused another project of its own organisation", async () => {
  // The leg the wrong predicate already got right. It is here for the mutation
  // test rather than for the coverage: a tenancy term that is doing work fails
  // the organisation-wide probe above *while this one still passes*. A change
  // that breaks both is refusing everything, which is a different change.
  //
  // It is also the only human probe that states a **cross-project** boundary at
  // all. Inside one organisation an organisation-wide session administers
  // (`docs/SECURITY.md` section 7), so project isolation between two projects of
  // one organisation is a property of narrowed sessions and of agent
  // credentials — not of every signed-in person.
  const owner = await seedTenant("owner@localhost");
  const sibling = await inject(
    "POST",
    `/api/v1/organisations/${owner.organisationId}/projects`,
    ADMIN,
    { name: "Sibling", slug: `sibling-${owner.projectId.slice(4, 14)}` },
  );
  assert.equal(sibling.statusCode, 201, sibling.body);
  const siblingId = (sibling.json() as { data: { id: string } }).data.id;
  const scoped = await projectScopedCookie(siblingId);

  const foreign = await inject("GET", `/api/v1/projects/${owner.projectId}/reviews`, scoped);
  const unknown = await inject("GET", `/api/v1/projects/${UNKNOWN.project}/reviews`, scoped);
  assert.equal(foreign.statusCode, 404, foreign.body);
  assert.deepEqual(normalise(foreign.body), normalise(unknown.body));

  const review = await inject("GET", `/api/v1/reviews/${owner.reviewId}`, scoped);
  const unknownReview = await inject("GET", `/api/v1/reviews/${UNKNOWN.review}`, scoped);
  assert.equal(review.statusCode, 404, review.body);
  assert.deepEqual(normalise(review.body), normalise(unknownReview.body));

  // Its own project is reachable, so the refusals above are the project term.
  const own = await inject("GET", `/api/v1/projects/${siblingId}/reviews`, scoped);
  assert.equal(own.statusCode, 200, own.body);
});

test("an unauthenticated caller cannot tell a record that exists from one that never did", async () => {
  // The second half of the RVP-67 property, and the half a signed-in probe
  // cannot see. The artefact routes used to resolve the row *before*
  // authenticating, so an identifier that existed earned
  // `AUTHENTICATION_REQUIRED` and one that did not earned `RESOURCE_NOT_FOUND`
  // — an oracle over another tenant's identifiers held by a caller with no
  // credential at all.
  //
  // `docs/SECURITY.md` section 7 still described that as an outstanding defect
  // when this gate was written; the routes now resolve the actor first, and
  // this is what holds them there.
  const victim = await seedTenant("victim@localhost");

  const surfaces: readonly { readonly url: (id: string) => string; readonly id: string; readonly unknown: string }[] = [
    { url: (id) => `/api/v1/artefacts/${id}`, id: victim.artefactId, unknown: UNKNOWN.artefact },
    {
      url: (id) => `/api/v1/artefact-content/${id}`,
      id: victim.grantId,
      unknown: UNKNOWN.grant,
    },
    { url: (id) => `/api/v1/reviews/${id}`, id: victim.reviewId, unknown: UNKNOWN.review },
    { url: (id) => `/api/v1/findings/${id}`, id: victim.findingId, unknown: UNKNOWN.finding },
    {
      url: (id) => `/api/v1/browser-sessions/${id}`,
      id: victim.browserSessionId,
      unknown: UNKNOWN.browserSession,
    },
    { url: (id) => `/api/v1/projects/${id}`, id: victim.projectId, unknown: UNKNOWN.project },
  ];

  for (const surface of surfaces) {
    const existing = await inject("GET", surface.url(surface.id), {});
    const missing = await inject("GET", surface.url(surface.unknown), {});
    assert.ok(existing.statusCode >= 400, `${surface.url("<id>")}: ${existing.body}`);
    assert.deepEqual(
      normalise(existing.body),
      normalise(missing.body),
      `${surface.url("<id>")}: an unauthenticated caller can tell an identifier that exists ` +
        `from one that never did.\n  existing: ${existing.body}\n  unknown:  ${missing.body}`,
    );
  }
});

test("an agent credential scoped to one project cannot read another project's artefact", async () => {
  // The agent surface's share of cross-project isolation. An agent credential
  // carries a real `project_ids` array, so it is the one caller for whom
  // "project A cannot reach project B" is a boundary inside one organisation.
  const owner = await seedTenant("owner@localhost");
  const sibling = await inject(
    "POST",
    `/api/v1/organisations/${owner.organisationId}/projects`,
    ADMIN,
    { name: "Sibling", slug: `sibling-${owner.projectId.slice(4, 14)}` },
  );
  const siblingId = (sibling.json() as { data: { id: string } }).data.id;

  const issued = await inject(
    "POST",
    `/api/v1/organisations/${owner.organisationId}/agent-credentials`,
    ADMIN,
    { project_ids: [siblingId], capabilities: ["review:read", "finding:read"], label: "sibling" },
  );
  assert.equal(issued.statusCode, 201, issued.body);
  const token = (issued.json() as { data: { token: string } }).data.token;
  const agent = { authorization: `Bearer ${token}` };

  const foreign = await inject("GET", `/api/v1/artefacts/${owner.artefactId}`, agent);
  const unknown = await inject("GET", `/api/v1/artefacts/${UNKNOWN.artefact}`, agent);
  assert.equal(foreign.statusCode, 404, foreign.body);
  assert.deepEqual(normalise(foreign.body), normalise(unknown.body));

  // The human review API is closed to it entirely, by token shape and before
  // any lookup (`docs/SECURITY.md` sections 6.3 and 7).
  const review = await inject("GET", `/api/v1/reviews/${owner.reviewId}`, agent);
  assert.equal(review.statusCode, 403, review.body);
  assert.equal(
    (review.json() as { error: { code: string } }).error.code,
    "AUTHORISATION_DENIED",
    review.body,
  );
});

provingTest(DEPLOYMENT_ADMINISTRATOR_PROOF, async () => {
  // Named by `browser_worker_projects` in the inventory above: a junction whose
  // parent carries no tenancy term, so the authority has to come from the route
  // and nothing about the shape supplies it. This is RVP-91 exactly — the guard
  // read `projectIds === null` as "is an administrator", which is what every
  // real sign-in issues, so any tenant's ordinary user could list the fleet and
  // reassign a worker away from another tenant.
  const victim = await seedTenant("victim@localhost");
  const attacker = await seedTenant("attacker@localhost");

  const assignments = async (workerId: string): Promise<string[]> => {
    const rows = await postgres.pool.query<{ project_id: string }>(
      "SELECT project_id FROM browser_worker_projects WHERE worker_id = $1 ORDER BY project_id",
      [workerId],
    );
    return rows.rows.map((row) => row.project_id);
  };
  const workers = await postgres.pool.query<{ id: string }>("SELECT id FROM browser_workers");
  const workerId = workers.rows[0]?.id;
  assert.ok(workerId !== undefined);

  await inject("PUT", `/api/v1/browser-workers/${workerId}/assignments`, ADMIN, {
    project_ids: [victim.projectId],
  });
  assert.deepEqual(await assignments(workerId), [victim.projectId]);

  const listed = await inject(
    "GET",
    "/api/v1/browser-workers",
    attacker.cookies.readHeaders as Record<string, string>,
  );
  assert.equal(listed.statusCode, 403, listed.body);
  assert.ok(!listed.body.includes(workerId));

  const seized = await harness.built.app.inject({
    method: "PUT",
    url: `/api/v1/browser-workers/${workerId}/assignments`,
    headers: attacker.cookies.writeHeaders,
    payload: { project_ids: [attacker.projectId] },
  });
  assert.equal(seized.statusCode, 403, seized.body);
  // `assign()` deletes every existing row before inserting, so the refusal has
  // to leave the victim's assignment standing rather than report an error after
  // the delete. Stripping it is a cross-tenant denial of service the victim
  // reads as `BROWSER_CAPACITY_EXHAUSTED` — which is also what a genuinely full
  // worker produces, with no way to tell them apart.
  assert.deepEqual(await assignments(workerId), [victim.projectId]);

  // The deployment administrator still administers it, so the refusals above
  // are about who is asking.
  const byAdministrator = await inject("GET", "/api/v1/browser-workers", ADMIN);
  assert.equal(byAdministrator.statusCode, 200, byAdministrator.body);
  assert.ok(byAdministrator.body.includes(workerId));
});

test("the bootstrap administrator still reaches every record both tenants own", async () => {
  // The positive control, and it is load-bearing. Every assertion above is a
  // refusal, and a change that refused everything would satisfy all of them.
  // This is the leg such a change fails.
  const victim = await seedTenant("victim@localhost");
  const attacker = await seedTenant("attacker@localhost");

  for (const tenant of [victim, attacker]) {
    for (const url of [
      `/api/v1/reviews/${tenant.reviewId}`,
      `/api/v1/findings/${tenant.findingId}`,
      `/api/v1/artefacts/${tenant.artefactId}`,
      `/api/v1/browser-sessions/${tenant.browserSessionId}`,
      `/api/v1/projects/${tenant.projectId}`,
      `/api/v1/projects/${tenant.projectId}/workspaces`,
    ]) {
      const response = await inject("GET", url, ADMIN);
      assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
    }
  }
});

test("each tenant reads its own records over the same routes a stranger is refused", async () => {
  // The second positive control, and the one that makes the matrix above about
  // tenancy rather than about a session that can reach nothing. It uses the
  // organisation-wide cookie session — the same credential the attacker legs
  // use — so the only difference between this test and those is which
  // organisation the record belongs to.
  const victim = await seedTenant("victim@localhost");
  const attacker = await seedTenant("attacker@localhost");

  for (const tenant of [victim, attacker]) {
    const headers = tenant.cookies.readHeaders as Record<string, string>;
    for (const url of [
      `/api/v1/reviews/${tenant.reviewId}`,
      `/api/v1/findings/${tenant.findingId}`,
      `/api/v1/artefacts/${tenant.artefactId}`,
      `/api/v1/artefact-content/${tenant.grantId}`,
      `/api/v1/browser-sessions/${tenant.browserSessionId}`,
      `/api/v1/projects/${tenant.projectId}`,
    ]) {
      const response = await inject("GET", url, headers);
      assert.ok(response.statusCode < 400, `${url}: ${response.body}`);
    }
  }
});
