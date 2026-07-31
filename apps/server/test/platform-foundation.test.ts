/**
 * The Stage 1 platform foundation, against a real database
 * (`docs/TESTING.md` section 2 "Component" and "Fault injection").
 *
 * What is asserted here is the substrate every other Stage 1 surface stands on:
 * that `reviewplane migrate` applies the baseline and reports a schema version,
 * that readiness refuses traffic while migrations are pending, that the API
 * envelope and its stable codes are what `docs/API.md` section 5 prints, that a
 * page is a keyset page with an opaque cursor, that idempotency replays rather
 * than repeats, and that a write with the database gone changes nothing and
 * audits nothing.
 *
 * The suite prints the evidence the issue asks for — migration output, a
 * success envelope, a `VERSION_CONFLICT` and a paginated response — so a reader
 * can see the shapes rather than take them on trust.
 */

import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { decodeCursor, isEntityId } from "@reviewplane/protocol/platform";

import { buildApp, type BuiltApp } from "../src/app.ts";
import { MIGRATIONS_DIRECTORY, listMigrations, migrate, migrationState } from "../src/db/migrate.ts";
import { createPool, inTransaction } from "../src/db/pool.ts";
import { EXIT_MIGRATIONS_PENDING, main as cli } from "../src/cli.ts";
import { appendEvent, assertPayloadCarriesNoSecret, EventPayloadError, recordStateChange } from "../src/events/append.ts";
import { describeFailure, registerHealthRoutes } from "../src/health.ts";
import { newEntityId, newId } from "../src/ids.ts";
import { TEST_BOOTSTRAP_TOKEN, testServerConfig } from "./support/config.ts";
import { startMigratedDatabase, startPostgres, truncateAll, type MigratedDatabase } from "./support/postgres.ts";

const ADMIN = { authorization: `Bearer ${TEST_BOOTSTRAP_TOKEN}` };

let postgres: MigratedDatabase;
let built: BuiltApp;
let artefactRoot: string;

before(async () => {
  postgres = await startMigratedDatabase();
  artefactRoot = await mkdtemp(join(tmpdir(), "reviewplane-platform-"));
});

after(async () => {
  await built?.stop();
  await postgres?.stop();
  if (artefactRoot !== undefined) await rm(artefactRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await built?.stop();
  await truncateAll(postgres.pool);
  built = await buildApp({
    config: testServerConfig({ artefactPath: artefactRoot, allowedOrigins: ["https://reviewplane.test"] }),
    pool: postgres.pool,
    outboxPollIntervalMs: 20,
  });
});

async function seedProject(): Promise<{ organisationId: string; projectId: string }> {
  const slug = `org-${newId("").slice(0, 12)}`.toLowerCase();
  const organisation = await built.app.inject({
    method: "POST",
    url: "/api/v1/organisations",
    headers: ADMIN,
    payload: { name: "Acme", slug },
  });
  assert.equal(organisation.statusCode, 201, organisation.body);
  const organisationId = (organisation.json() as { data: { id: string } }).data.id;
  const project = await built.app.inject({
    method: "POST",
    url: `/api/v1/organisations/${organisationId}/projects`,
    headers: ADMIN,
    payload: { name: "Storefront", slug: `prj-${newId("").slice(0, 12)}`.toLowerCase() },
  });
  assert.equal(project.statusCode, 201, project.body);
  return { organisationId, projectId: (project.json() as { data: { id: string } }).data.id };
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

describe("entity identifiers", () => {
  test("every documented prefix mints an opaque identifier that encodes nothing", () => {
    // `docs/DOMAIN_MODEL.md` section 3 and the RVP-9 prefix list. The suffix is
    // randomness alone: Stage 0 encoded `Date.now()` in it, which is exactly
    // the timestamp the document forbids.
    for (const kind of [
      "organisation",
      "project",
      "environment",
      "connector",
      "workspace",
      "agent_session",
      "browser_session",
      "review",
      "finding",
      "annotation",
      "artefact",
      "verification",
      "event",
    ] as const) {
      const id = newEntityId(kind);
      assert.ok(isEntityId(id), `${kind} minted an identifier outside the character class`);
      assert.match(id.slice(id.indexOf("_") + 1), /^[0-9a-f]{32}$/u);
    }

    const early = newEntityId("review");
    const late = newEntityId("review");
    assert.notEqual(early, late);
    // Sorting identifiers must not sort by creation time. If it did, a consumer
    // would come to rely on it and the prefix rules would become a lie.
    assert.ok(early.slice(4) !== late.slice(4));
  });
});

// ---------------------------------------------------------------------------
// Migrations, the migration command and readiness
// ---------------------------------------------------------------------------

describe("reviewplane migrate and readiness", () => {
  test("the baseline applies to an empty database and reports a schema version", async () => {
    const fresh = await startPostgres();
    const pool = createPool(fresh.url);
    try {
      const before = await migrationState(pool);
      assert.equal(before.schemaVersion, null);
      assert.ok(before.pending.length > 0);

      const result = await migrate(pool);
      const state = await migrationState(pool);
      assert.deepEqual(state.pending, []);
      assert.equal(state.schemaVersion, result.applied[result.applied.length - 1]);
      process.stdout.write(
        `evidence: reviewplane migrate applied ${String(result.applied.length)} migration(s); schema version ${String(state.schemaVersion)}\n`,
      );

      // Stage 1 seeds exactly one organisation and one user, and the seed
      // leaves an audit record like any other state change.
      const organisations = await pool.query<{ count: string }>("select count(*) from organisations");
      const users = await pool.query<{ count: string }>("select count(*) from users");
      assert.equal(organisations.rows[0]?.count, "1");
      assert.equal(users.rows[0]?.count, "1");
      const seedEvent = await pool.query<{ type: string }>(
        "select type from events where type = 'organisation.created'",
      );
      assert.equal(seedEvent.rows.length, 1, "the seeded organisation left no audit record");
    } finally {
      await pool.end();
      await fresh.stop();
    }
  });

  test("the upgrade path applies on top of the Stage 0 head", async () => {
    // `docs/ROADMAP.md`: "Upgrade from previous stage data fixture succeeds".
    // The check is that the Stage 1 migrations apply to a database that stopped
    // at 0054, and that the seed leaves an existing organisation alone.
    const fresh = await startPostgres();
    const pool = createPool(fresh.url);
    try {
      const files = await listMigrations(MIGRATIONS_DIRECTORY);
      const stage0 = files.filter((file) => Number(file.slice(0, 4)) <= 54);
      const stage1 = files.filter((file) => Number(file.slice(0, 4)) > 54);
      assert.ok(stage1.length > 0, "this change adds no migration");

      const staging = await mkdtemp(join(tmpdir(), "reviewplane-stage0-"));
      try {
        for (const file of stage0) {
          const source = await import("node:fs/promises").then(async (fs) =>
            fs.readFile(join(MIGRATIONS_DIRECTORY, file), "utf8"),
          );
          await writeFile(join(staging, file), source, "utf8");
        }
        await migrate(pool, staging);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }

      // A Stage 0 deployment already has an organisation created through the
      // API. The seed must not add a second one.
      const existing = newEntityId("organisation");
      await pool.query("insert into organisations (id, name, slug) values ($1, $2, $3)", [
        existing,
        "Existing",
        "existing",
      ]);

      const upgrade = await migrate(pool);
      assert.deepEqual(upgrade.applied, stage1, "the Stage 1 migrations did not apply on top of 0054");
      const organisations = await pool.query<{ id: string }>("select id from organisations");
      assert.deepEqual(
        organisations.rows.map((row) => row.id),
        [existing],
        "the seed added an organisation to a deployment that already had one",
      );
    } finally {
      await pool.end();
      await fresh.stop();
    }
  });

  test("readiness reports not-ready while migrations are pending", async () => {
    const fresh = await startPostgres();
    const pool = createPool(fresh.url);
    // The health module alone, on a bare instance: the full application cannot
    // be built against an unmigrated database, which is itself the point — a
    // deployment that migrates separately runs a process whose schema is behind
    // its code, and readiness is what keeps traffic away from it.
    const pendingApp = Fastify({ logger: false });
    try {
      registerHealthRoutes(pendingApp, { role: "api", pool });
      const notReady = await pendingApp.inject({ method: "GET", url: "/health/ready" });
      assert.equal(notReady.statusCode, 503);
      const body = notReady.json() as {
        status: string;
        pending_migrations: number;
        checks: Record<string, { status: string }>;
      };
      assert.equal(body.status, "not_ready");
      assert.ok(body.pending_migrations > 0);
      assert.equal(body.checks["migrations"]?.status, "fail");

      // Liveness must stay green: a schema behind its code is not a reason for
      // an orchestrator to restart the process, and restarting would not fix it.
      const live = await pendingApp.inject({ method: "GET", url: "/health/live" });
      assert.equal(live.statusCode, 200);

      await migrate(pool);
      const ready = await pendingApp.inject({ method: "GET", url: "/health/ready" });
      assert.equal(ready.statusCode, 200);
      assert.equal((ready.json() as { status: string }).status, "ready");
    } finally {
      await pendingApp.close();
      await pool.end();
      await fresh.stop();
    }
  });

  test("the migrate command reports a pending schema with its own exit code", async () => {
    const fresh = await startPostgres();
    try {
      process.env["REVIEWPLANE_DATABASE_URL"] = fresh.url;
      assert.equal(await cli(["migrate", "--status"]), EXIT_MIGRATIONS_PENDING);
      assert.equal(await cli(["migrate"]), 0);
      assert.equal(await cli(["migrate", "--status"]), 0);
      assert.equal(await cli(["version"]), 0);
      assert.equal(await cli(["nonsense"]), 1);
    } finally {
      delete process.env["REVIEWPLANE_DATABASE_URL"];
      await fresh.stop();
    }
  });

  test("the jobs role serves the three endpoints and reports not-ready before migrating", async () => {
    // `docs/OPERATIONS.md` section 2 requires every service to expose them, and
    // a background role that exposed nothing would give an operator no way to
    // ask whether work is being done. The role must also start against a schema
    // that is behind its code and report the fact, rather than exiting into an
    // orchestrator's restart loop while a separate migration step runs.
    const fresh = await startPostgres();
    const port = 18081 + Math.floor(Math.random() * 900);
    process.env["REVIEWPLANE_DATABASE_URL"] = fresh.url;
    process.env["REVIEWPLANE_JOBS_HEALTH_HOST"] = "127.0.0.1";
    process.env["REVIEWPLANE_JOBS_HEALTH_PORT"] = String(port);
    const role = cli(["jobs"]);
    try {
      const origin = `http://127.0.0.1:${String(port)}`;
      await waitForListener(origin);

      const live = await fetch(`${origin}/health/live`);
      assert.equal(live.status, 200);
      assert.equal(((await live.json()) as { role: string }).role, "jobs");

      const version = await fetch(`${origin}/version`);
      assert.equal(version.status, 200);
      assert.equal(((await version.json()) as { role: string }).role, "jobs");

      const notReady = await fetch(`${origin}/health/ready`);
      assert.equal(notReady.status, 503, "the jobs role was ready against an unmigrated schema");
      const body = (await notReady.json()) as {
        status: string;
        pending_migrations: number;
        checks: Record<string, { status: string }>;
      };
      assert.equal(body.status, "not_ready");
      assert.ok(body.pending_migrations > 0);
      assert.equal(body.checks["job_runner"]?.status, "fail");

      // Once the schema catches up the role starts claiming, and readiness
      // follows without the process being restarted.
      const pool = createPool(fresh.url);
      await migrate(pool);
      await pool.end();
      const ready = await waitForReady(`${origin}/health/ready`);
      assert.equal(ready.status, 200, "the jobs role never became ready after migrating");
      assert.equal(
        ((await ready.json()) as { checks: Record<string, { status: string }> }).checks[
          "job_runner"
        ]?.status,
        "pass",
      );
    } finally {
      process.emit("SIGTERM");
      await role;
      delete process.env["REVIEWPLANE_DATABASE_URL"];
      delete process.env["REVIEWPLANE_JOBS_HEALTH_HOST"];
      delete process.env["REVIEWPLANE_JOBS_HEALTH_PORT"];
      await fresh.stop();
    }
  });

  test("the api, mcp and jobs roles all answer the three documented endpoints", async () => {
    // The `api` role is this app; the `mcp` role registers the same module in
    // `apps/mcp-server`, and the `jobs` role in the CLI. What is asserted here
    // is that the module answers all three, which is what makes the three roles
    // consistent rather than three similar implementations.
    for (const path of ["/health/live", "/health/ready", "/version"]) {
      const response = await built.app.inject({ method: "GET", url: path });
      assert.equal(response.statusCode, 200, `${path} answered ${String(response.statusCode)}`);
    }
    const version = built.app.inject({ method: "GET", url: "/version" });
    const body = (await version).json() as { role: string; protocol_version: number };
    assert.equal(body.role, "api");
    assert.equal(body.protocol_version, 1);
  });
});

// ---------------------------------------------------------------------------
// Envelope, errors and pagination
// ---------------------------------------------------------------------------

describe("the API envelope", () => {
  test("a success carries data and a request identifier", async () => {
    const { projectId } = await seedProject();
    const response = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
      headers: ADMIN,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { data: { id: string }; meta: { request_id: string } };
    assert.equal(body.data.id, projectId);
    assert.match(body.meta.request_id, /^req_/u);
    process.stdout.write(`evidence: success envelope ${JSON.stringify(body)}\n`);
  });

  test("a refusal carries a stable code, a message and the same request identifier", async () => {
    const response = await built.app.inject({
      method: "GET",
      url: "/api/v1/projects/prj_does_not_exist",
      headers: ADMIN,
    });
    assert.equal(response.statusCode, 404);
    const body = response.json() as {
      error: { code: string; message: string };
      meta: { request_id: string };
    };
    assert.equal(body.error.code, "RESOURCE_NOT_FOUND");
    assert.match(body.meta.request_id, /^req_/u);
  });

  test("a page carries an opaque next_cursor and does not repeat or skip a row", async () => {
    const { organisationId } = await seedProject();
    for (let index = 0; index < 5; index += 1) {
      const created = await built.app.inject({
        method: "POST",
        url: `/api/v1/organisations/${organisationId}/projects`,
        headers: ADMIN,
        payload: { name: `Project ${String(index)}`, slug: `page-${String(index)}-${newId("").slice(0, 8)}` },
      });
      assert.equal(created.statusCode, 201, created.body);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const url = cursor === undefined ? "/api/v1/projects?limit=2" : `/api/v1/projects?limit=2&cursor=${cursor}`;
      const response = await built.app.inject({ method: "GET", url, headers: ADMIN });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json() as {
        data: { id: string }[];
        meta: { request_id: string; next_cursor?: string };
      };
      if (page === 0) process.stdout.write(`evidence: paginated response ${JSON.stringify(body)}\n`);
      assert.ok(body.data.length <= 2);
      for (const project of body.data) seen.push(project.id);
      if (body.meta.next_cursor === undefined) break;
      // The cursor is opaque to a client, but this test is the server and may
      // check that it is the shape the schema defines.
      assert.ok(decodeCursor(body.meta.next_cursor).ok);
      cursor = body.meta.next_cursor;
    }
    assert.equal(new Set(seen).size, seen.length, "a project appeared on two pages");
    assert.equal(seen.length, 6, "the pages did not cover every project");
  });

  test("a cursor this API did not issue is refused rather than treated as page one", async () => {
    const response = await built.app.inject({
      method: "GET",
      url: "/api/v1/projects?cursor=bm90LWEtY3Vyc29y",
      headers: ADMIN,
    });
    assert.equal(response.statusCode, 422);
    assert.equal((response.json() as { error: { code: string } }).error.code, "VALIDATION_FAILED");
  });

  test("limit is bounded, so one request cannot ask for the whole table", async () => {
    const response = await built.app.inject({
      method: "GET",
      url: "/api/v1/projects?limit=100000",
      headers: ADMIN,
    });
    assert.equal(response.statusCode, 422);
  });
});

// ---------------------------------------------------------------------------
// Events: transactionality, payload rules and the activity timeline
// ---------------------------------------------------------------------------

describe("event records", () => {
  test("a state change and its event commit together and allocate a per-project sequence", async () => {
    const { organisationId, projectId } = await seedProject();
    const rows = await postgres.pool.query<{ sequence: string; type: string; project_id: string }>(
      "select sequence, type, project_id from events where stream_key = $1 order by sequence",
      [projectId],
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]?.type, "project.created");
    assert.equal(rows.rows[0]?.sequence, "1");

    for (let index = 0; index < 20; index += 1) {
      await recordStateChange(
        postgres.pool,
        {
          type: "project.updated",
          organisationId,
          projectId,
          actor: { type: "system" },
          payload: { changed_fields: ["name"] },
        },
        async (client) => {
          await client.query("update projects set updated_at = now() where id = $1", [projectId]);
        },
      );
    }
    const sequences = await postgres.pool.query<{ sequence: string }>(
      "select sequence from events where stream_key = $1 order by sequence",
      [projectId],
    );
    assert.deepEqual(
      sequences.rows.map((row) => Number(row.sequence)),
      Array.from({ length: 21 }, (_value, index) => index + 1),
      "the project sequence is not monotonic without gaps",
    );
  });

  test("a failed state change writes neither the state nor the event", async () => {
    const { organisationId, projectId } = await seedProject();
    const before = await countEvents(projectId);
    await assert.rejects(
      recordStateChange(
        postgres.pool,
        { type: "project.updated", organisationId, projectId, actor: { type: "system" }, payload: {} },
        async (client) => {
          await client.query("update projects set name = $2 where id = $1", [projectId, "renamed"]);
          throw new Error("the handler failed after writing");
        },
      ),
    );
    assert.equal(await countEvents(projectId), before, "a rolled-back change left an event");
    const project = await postgres.pool.query<{ name: string }>(
      "select name from projects where id = $1",
      [projectId],
    );
    assert.notEqual(project.rows[0]?.name, "renamed", "a rolled-back change left state");
  });

  test("every event that commits also enqueues its fan-out obligation", async () => {
    const { projectId } = await seedProject();
    const outbox = await postgres.pool.query<{ event_id: string }>(
      `select event_outbox.event_id from event_outbox
         join events on events.id = event_outbox.event_id
        where events.stream_key = $1`,
      [projectId],
    );
    assert.equal(outbox.rows.length, 1, "a committed event owes no delivery");
  });

  test("a payload carrying a credential-shaped member is refused", () => {
    // `docs/EVENTS.md` section 8 and `docs/SECURITY.md` section 18. An event is
    // append-only: a credential written here cannot be taken out again.
    assert.throws(
      () => {
        assertPayloadCarriesNoSecret({ enrolment_token: "rp1.secret" });
      },
      EventPayloadError,
    );
    assert.throws(
      () => {
        assertPayloadCarriesNoSecret({ request: { headers: { authorization: "Bearer x" } } });
      },
      EventPayloadError,
    );
    assert.throws(
      () => {
        assertPayloadCarriesNoSecret({ session: { cookie: "reviewplane_viewer=x" } });
      },
      EventPayloadError,
    );
    // An identifier of a credential is exactly what an audit event should say.
    assertPayloadCarriesNoSecret({ credential_id: "agc_1", capability_id: "cap_1" });
  });

  test("no module writes domain state without also appending an event", async () => {
    // `AGENTS.md`: "Every meaningful state change must produce an audit/event
    // record." A component test can only prove it for the paths it exercises,
    // so this one reads the source instead: a module that writes to a domain
    // table must also reach `appendEvent`.
    //
    // The exemptions are named individually and each states why the table it
    // writes is not domain state. Adding one is a decision a reader can see and
    // argue with; leaving a module out silently is not.
    const exempt = new Map<string, string>([
      // Short-lived credentials and claims, not domain records. A viewer session
      // is audited by the authentication events of docs/EVENTS.md section 7 when
      // those land; an idempotency key is a request-deduplication artefact whose
      // own creation is not an occurrence anybody audits.
      // A viewer session is a credential rather than a domain record, so this
      // store writes no event of its own. Every route that calls it does:
      // `modules/identity/routes.ts` and the ADR-0016 sign-out in
      // `modules/live/routes.ts` both record `session.revoked`, and issuing one
      // is recorded by the `authentication.login_succeeded` beside it. The
      // wording matters — this exemption previously claimed an audit that one
      // of those two routes was not in fact performing (RVP-12 review, F1).
      ["modules/live/viewer-sessions.ts", "viewer sessions are credentials, not domain records; every route that issues or revokes one writes the matching authentication event"],
      ["modules/agents/idempotency.ts", "an idempotency key deduplicates a request; it is not a change"],
      // Throttling state. The refusal it produces is audited as
      // authentication.login_failed with reason `rate_limited`, so the fact an
      // operator needs — that the limiter engaged — is in the event stream; the
      // counter itself is bookkeeping, and an event per failed guess would let
      // an attacker fill the audit trail.
      ["modules/identity/rate-limit.ts", "login throttling state; the refusal it produces is evented as authentication.login_failed"],
      // Registry and liveness bookkeeping. A worker heartbeat every few seconds
      // is exactly the high-frequency signal docs/EVENTS.md section 7 says must
      // be sampled or summarised rather than emitted as durable events.
      ["modules/browser-sessions/workers.ts", "worker registration and heartbeats are liveness, not domain state"],
      ["modules/connectors/monitor.ts", "connector liveness bookkeeping; the transitions it detects are evented by the channel"],
      // The scan matches on prose here, not on SQL: this module issues no
      // statement of its own. Every write it causes goes through
      // `modules/connectors/repository.ts` (the lifecycle transitions, which
      // append `connector.connected` and `connector.disconnected` in the same
      // transaction) or `modules/connectors/workspaces.ts` (which appends
      // `workspace.observed` and `workspace.head_changed` in the same
      // transaction). The one write that produces no event is the heartbeat
      // timestamp, which is liveness for the same reason `monitor.ts` above is.
      ["modules/connectors/channel.ts", "issues no SQL; the transitions and observations it dispatches are evented by repository.ts and workspaces.ts"],
      ["modules/connectors/repository.ts", "row access for the connector module, which appends its events in its own layer"],
      ["modules/connectors/certificate-authority.ts", "the certificate authority is deployment material, not a project record"],
      ["modules/published-services/repository.ts", "row access for the published-service service, which appends the events"],
      ["modules/agents/workspaces.ts", "workspace observation is evented by the connector reconciliation that reports it"],
      ["modules/agents/credentials.ts", "row access for the agent-credential routes, which append agent_credential.issued and session.revoked"],
    ]);

    const { readdir, readFile } = await import("node:fs/promises");
    const root = join(import.meta.dirname, "..", "src");
    const offenders: string[] = [];

    // Prose is not a write. A block comment explaining that a claim is
    // `SELECT ... FOR UPDATE SKIP LOCKED` used to make the module that
    // contained it an offender, which is a scan that reports what a file says
    // rather than what it does. Only whole-line and block comments are removed,
    // so a `//` inside a string — a URL, most often — cannot truncate a line of
    // real code and hide a write on it.
    const stripComments = (source: string): string =>
      source
        .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
        .split("\n")
        .filter((line) => {
          const trimmed = line.trimStart();
          return !trimmed.startsWith("//") && !trimmed.startsWith("*");
        })
        .join("\n");

    const walk = async (directory: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          await walk(join(directory, entry.name), relative);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const source = stripComments(await readFile(join(directory, entry.name), "utf8"));
        const writes = /\b(INSERT INTO|UPDATE |DELETE FROM)\b/iu.test(source);
        if (!writes) continue;
        if (exempt.has(relative)) continue;
        // The event tables and the job runner are the audit machinery itself.
        if (relative.startsWith("events/") || relative.startsWith("db/") || relative.startsWith("jobs/")) continue;
        if (!source.includes("appendEvent") && !source.includes("recordStateChange")) {
          offenders.push(relative);
        }
      }
    };
    await walk(root, "");

    assert.deepEqual(
      offenders,
      [],
      `these modules write state without appending an event: ${offenders.join(", ")}`,
    );
  });

  test("the activity timeline pages the same events the stream delivers", async () => {
    const { organisationId, projectId } = await seedProject();
    for (let index = 0; index < 4; index += 1) {
      await recordStateChange(
        postgres.pool,
        {
          type: "project.updated",
          organisationId,
          projectId,
          actor: { type: "system" },
          payload: { changed_fields: ["name"] },
        },
        async () => undefined,
      );
    }
    const first = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/activity?limit=2`,
      headers: ADMIN,
    });
    assert.equal(first.statusCode, 200, first.body);
    const body = first.json() as {
      data: { sequence: number; type: string }[];
      meta: { next_cursor?: string };
    };
    assert.equal(body.data.length, 2);
    assert.equal(body.data[0]?.sequence, 5, "the newest event is not first");
    assert.ok(body.meta.next_cursor !== undefined);

    const second = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/activity?limit=2&cursor=${body.meta.next_cursor}`,
      headers: ADMIN,
    });
    const page2 = second.json() as { data: { sequence: number }[] };
    assert.deepEqual(
      page2.data.map((event) => event.sequence),
      [3, 2],
    );
  });

  test("another project's activity is not found rather than denied", async () => {
    // The refusal must not confirm that the project exists
    // (`docs/SECURITY.md`, RVP-9 "foreign ID lookup returns not-found").
    const { projectId } = await seedProject();
    const viewer = await built.viewers.issue({
      organisationId: null,
      projectIds: [`prj_${"a".repeat(16)}`],
      display: "scoped viewer",
      ttlSeconds: 300,
    });
    const response = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/activity`,
      headers: { cookie: `reviewplane_viewer=${viewer.token}` },
    });
    assert.equal(response.statusCode, 404);
    assert.equal((response.json() as { error: { code: string } }).error.code, "RESOURCE_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// Fault injection
// ---------------------------------------------------------------------------

describe("when the database is unavailable", () => {
  test("a state-changing request is denied rather than proceeding unaudited", async () => {
    // `docs/ARCHITECTURE.md` section 14: "Reject state-changing actions safely
    // ... Do not continue unaudited destructive operations."
    const isolated = await startPostgres();
    const pool = createPool(isolated.url);
    await migrate(pool);
    let app: BuiltApp | undefined;
    try {
      app = await buildApp({
        config: testServerConfig({ artefactPath: artefactRoot }),
        pool,
      });
      const organisation = await app.app.inject({
        method: "POST",
        url: "/api/v1/organisations",
        headers: ADMIN,
        payload: { name: "Acme", slug: "acme-outage" },
      });
      assert.equal(organisation.statusCode, 201);
      const organisationId = (organisation.json() as { data: { id: string } }).data.id;

      // The outage. Everything after this point must refuse rather than pretend.
      await isolated.stop();

      const refused = await app.app.inject({
        method: "POST",
        url: `/api/v1/organisations/${organisationId}/projects`,
        headers: ADMIN,
        payload: { name: "Storefront", slug: "storefront" },
      });
      assert.equal(refused.statusCode, 500);
      assert.equal((refused.json() as { error: { code: string } }).error.code, "INTERNAL_ERROR");

      const notReady = await app.app.inject({ method: "GET", url: "/health/ready" });
      assert.equal(notReady.statusCode, 503);
      const body = notReady.json() as { checks: Record<string, { status: string; detail?: string }> };
      assert.equal(body.checks["database"]?.status, "fail");
      // The detail an operator reads must not carry the connection string.
      assert.ok(!(body.checks["database"]?.detail ?? "").includes(isolated.url));
    } finally {
      await app?.stop();
      await pool.end().catch(() => undefined);
      await isolated.stop().catch(() => undefined);
    }
  });

  test("readiness never discloses the database address, in any failure shape", async () => {
    // `/health/ready` is the least protected endpoint the process serves: a
    // probe reaches it without authenticating. A driver's message names the
    // host it failed to reach, with a port on a refused connection and without
    // one on a resolver failure, so both shapes have to be scrubbed.
    //
    // Each case is driven through a real pool rather than asserted against a
    // hand-written message, because the thing under test is what the driver
    // actually says, not what this test remembers it saying.
    const cases = [
      { url: "postgres://v:v@127.0.0.1:59999/v", secrets: ["127.0.0.1", "59999"] },
      { url: "postgres://v:v@[::1]:59998/v", secrets: ["::1", "59998"] },
      {
        url: "postgres://v:v@db-internal.corp.invalid:5432/v",
        secrets: ["db-internal.corp.invalid", "corp.invalid"],
      },
      {
        url: "postgresql://admin:s3cr3t@pg-primary.prod:6432/appdb",
        secrets: ["pg-primary.prod", "s3cr3t", "admin", "6432"],
      },
    ];

    for (const testCase of cases) {
      const pool = createPool(testCase.url);
      const app = Fastify({ logger: false });
      registerHealthRoutes(app, { role: "api", pool });
      try {
        const response = await app.inject({ method: "GET", url: "/health/ready" });
        assert.equal(response.statusCode, 503, testCase.url);
        const detail = (
          response.json() as { checks: Record<string, { detail?: string }> }
        ).checks["database"]?.detail;
        assert.ok(detail !== undefined, `no database detail for ${testCase.url}`);

        for (const secret of testCase.secrets) {
          assert.ok(
            !detail.includes(secret),
            `readiness disclosed ${JSON.stringify(secret)} for ${testCase.url}: ${detail}`,
          );
        }
        assert.ok(
          detail.includes("[address redacted]"),
          `the address was not redacted for ${testCase.url}: ${detail}`,
        );
        // The failure class must survive: an operator needs to know that the
        // name did not resolve rather than that the port refused it.
        assert.match(detail, /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/u, testCase.url);
        process.stdout.write(`evidence: readiness detail for ${testCase.url} => ${detail}\n`);
      } finally {
        await app.close();
        await pool.end().catch(() => undefined);
      }
    }
  });

  test("scrubbing an address does not mangle a message that merely looks like one", () => {
    // The rule is anchored on the failure codes precisely so that ordinary
    // prose survives it. A regression here would make every other readiness
    // detail unreadable while nobody noticed.
    assert.equal(
      describeFailure(new Error("Connection terminated unexpectedly")),
      "Connection terminated unexpectedly",
    );
    assert.equal(
      describeFailure(new Error("timeout exceeded when establishing a connection")),
      "timeout exceeded when establishing a connection",
    );
    assert.equal(
      describeFailure(new Error("see docs/SECURITY.md section 18:5 for the rule")),
      "see docs/SECURITY.md section 18:5 for the rule",
    );
    // A connection string carries the credential as well as the address.
    assert.equal(
      describeFailure(new Error("could not connect to postgres://admin:s3cr3t@pg.prod:6432/db")),
      "could not connect to postgres://[redacted]",
    );
  });

  test("appendEvent inside a failed transaction leaves no partial event", async () => {
    const { organisationId, projectId } = await seedProject();
    const before = await countEvents(projectId);
    await assert.rejects(
      inTransaction(postgres.pool, async (client) => {
        await appendEvent(client, {
          type: "project.updated",
          organisationId,
          projectId,
          actor: { type: "system" },
          payload: { changed_fields: ["name"] },
        });
        throw new Error("the command failed after the event was written");
      }),
    );
    assert.equal(await countEvents(projectId), before);
  });
});

/** Polls until a listener accepts, so the test does not race the bind. */
async function waitForListener(origin: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${origin}/health/live`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`nothing was listening on ${origin} within ${String(timeoutMs)} ms`);
}

/** Polls readiness until it passes, so the test does not race the recheck. */
async function waitForReady(url: string, timeoutMs = 30_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let last = await fetch(url);
  while (Date.now() < deadline) {
    if (last.status === 200) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
    last = await fetch(url);
  }
  return last;
}

async function countEvents(projectId: string): Promise<number> {
  const rows = await postgres.pool.query<{ count: string }>(
    "select count(*) from events where stream_key = $1",
    [projectId],
  );
  return Number(rows.rows[0]?.count ?? "0");
}
