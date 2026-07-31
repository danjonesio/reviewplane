/**
 * The upgrade path from the committed Stage 0 installation
 * (`docs/TESTING.md` §13, and the Stage 1 exit criterion "upgrade from previous
 * stage data fixture succeeds" in `docs/ROADMAP.md` §3).
 *
 * The sequence §13 fixes is followed literally, in order:
 *
 *   1. restore the prior-version fixture — `test/fixtures/stage0/database.sql`
 *      into an empty database, and its artefact store onto a volume;
 *   2. start the new version — a pool from this build, which must report the
 *      schema as behind rather than serving against it;
 *   3. apply the migration — every file from `0055` to the current head;
 *   4. verify reviews and artefacts — the named review, its findings, its
 *      annotations, the agent's verification and the bytes behind all three;
 *   5. verify connector compatibility — a Stage 0 connector build across the
 *      upgrade;
 *   6. verify rollback limitations — what the migrations say about downgrade,
 *      and what the operator is therefore told to keep.
 *
 * It runs against the real committed fixture rather than a synthetic one on
 * purpose. A migration tested only against a freshly created schema is a
 * migration tested against data no release ever wrote, and the whole reason
 * this fixture was captured while `main` was the Stage 0 build is that the
 * shape of Stage 0's rows cannot be reconstructed afterwards.
 *
 * The upgrade is then backed up and restored into a third database, because
 * "the data survived the migration" and "the data can be got back out again"
 * are the two guarantees RVP-56 ships and the second is the one that is only
 * ever tested deliberately.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

import { listMigrations, migrate, migrationReport, migrationState } from "../src/db/migrate.ts";
import { createPool, type Pool } from "../src/db/pool.ts";
import { createBackup } from "../src/modules/backup/backup.ts";
import { runPreflight } from "../src/modules/backup/preflight.ts";
import { restoreBackup } from "../src/modules/backup/restore.ts";
import { classifyUpgrade } from "../src/modules/connectors/reconciliation.ts";
import { ArtefactService } from "../src/modules/artefacts/service.ts";
import { createArtefactStore } from "../src/modules/artefacts/store/index.ts";
import { ReviewService } from "../src/modules/reviews/service.ts";
import { startPostgres, type TestDatabase } from "./support/postgres.ts";


const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "test", "fixtures", "stage0");

interface FixtureManifest {
  readonly schema: { migration_head: string; migrations_applied: number; migrations: string[] };
  readonly database: { row_counts: Record<string, number> };
  readonly artefact_store: {
    root: string;
    objects: { artefact_id: string; storage_key: string; sha256: string; size_bytes: number }[];
  };
  readonly key_material: { included: boolean };
  readonly contents: {
    review: { id: string; slug: string; status: string };
    findings: { id: string; status: string; severity: string; annotations: number }[];
    verification: { id: string; status: string; after_artefact_id: string };
  };
}

let manifest: FixtureManifest;
let stage0: TestDatabase;
let pool: Pool;
let workspace: string;
let artefactRoot: string;

before(async () => {
  manifest = JSON.parse(await readFile(join(FIXTURE, "manifest.json"), "utf8")) as FixtureManifest;
  workspace = await mkdtemp(join(tmpdir(), "reviewplane-upgrade-"));
  artefactRoot = join(workspace, "artefacts");
  await mkdir(artefactRoot, { recursive: true });

  stage0 = await startPostgres();
  pool = createPool(stage0.url);
});

after(async () => {
  await pool?.end().catch(() => undefined);
  await stage0?.stop();
  if (workspace !== undefined) await rm(workspace, { recursive: true, force: true });
});

/** `psql --file database.sql`, which is the restore the fixture documents. */
async function restoreFixtureDump(container: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      "docker",
      [
        "exec",
        "--interactive",
        container,
        "psql",
        "--username",
        "postgres",
        "--dbname",
        "reviewplane",
        "--quiet",
        "--set",
        "ON_ERROR_STOP=1",
      ],
      { maxBuffer: 64 * 1024 * 1024 },
      (error) => {
        if (error === null) resolve();
        else reject(error);
      },
    );
    createReadStream(join(FIXTURE, "database.sql")).pipe(child.stdin as NodeJS.WritableStream);
  });
}

async function digestOf(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

describe("upgrading from the committed Stage 0 fixture", () => {
  test("the committed fixture is the fixture the manifest describes", async () => {
    const checksums = (
      JSON.parse(await readFile(join(FIXTURE, "manifest.json"), "utf8")) as {
        checksums: { files: Record<string, string> };
      }
    ).checksums.files;
    for (const [name, expected] of Object.entries(checksums)) {
      assert.equal(await digestOf(join(FIXTURE, name)), expected, `${name} is not what the manifest records`);
    }
    assert.equal(manifest.key_material.included, false, "the fixture claims to carry key material");
  });

  test("step 1: the prior-version fixture restores", async () => {
    await restoreFixtureDump(stage0.containerName);
    await cp(join(FIXTURE, manifest.artefact_store.root), artefactRoot, { recursive: true });

    const state = await migrationState(pool);
    assert.equal(state.schemaVersion, manifest.schema.migration_head);
    assert.equal(state.applied.length, manifest.schema.migrations_applied);

    for (const [table, rows] of Object.entries(manifest.database.row_counts)) {
      const { rows: counted } = await pool.query<{ count: string }>(
        `select count(*)::text as count from "${table}"`,
      );
      assert.equal(Number(counted[0]?.count), rows, `${table} restored a different number of rows`);
    }
  });

  test("step 2: the new version reports the schema as behind rather than serving against it", async () => {
    const state = await migrationState(pool);
    assert.ok(state.pending.length > 0, "this build has no migrations beyond the fixture's head");
    assert.equal(state.pending[0], "0055_users_and_stage_1_seed.sql");

    // The preflight of `docs/OPERATIONS.md` section 12, run before the
    // migration as `docs/DEPLOYMENT.md` section 15 step 5 requires. The source
    // version is supported, and the absence of a backup is a failure — which is
    // the whole point of running it before an upgrade.
    const report = await runPreflight({ pool, artefactPath: artefactRoot });
    const named = new Map(report.checks.map((entry) => [entry.name, entry]));
    assert.deepEqual(
      [...named.keys()].sort(),
      [
        "backup_freshness",
        "connector_compatibility",
        "disk_space",
        "migration_lock",
        "source_version",
        "worker_compatibility",
      ],
      "the preflight omitted a check",
    );
    assert.equal(named.get("source_version")?.status, "pass");
    assert.match(named.get("source_version")?.detail ?? "", /0054_idempotency_keys\.sql/u);
    assert.equal(named.get("migration_lock")?.status, "pass");
    assert.equal(named.get("backup_freshness")?.status, "fail");
    assert.equal(report.ok, false, "a preflight with no backup reported ok");
  });

  test("step 2b: a backup taken before the upgrade satisfies the preflight and is the rollback artefact", async () => {
    const archive = join(workspace, "pre-upgrade.tar.zst");
    const backup = await createBackup({
      pool,
      output: archive,
      mode: "full",
      artefactPath: artefactRoot,
      artefactDriver: "filesystem",
      environment: {},
    });
    assert.equal(backup.manifest.schema_version, manifest.schema.migration_head);
    assert.equal(backup.manifest.artefact_objects, manifest.artefact_store.objects.length);
    assert.deepEqual(backup.missingArtefacts, []);

    const report = await runPreflight({ pool, artefactPath: artefactRoot });
    const named = new Map(report.checks.map((entry) => [entry.name, entry]));
    assert.equal(named.get("backup_freshness")?.status, "pass");
    assert.equal(report.ok, true, `preflight refused the upgrade: ${JSON.stringify(report.checks)}`);
  });

  test("step 3: the migrations apply", async () => {
    const before = await migrationState(pool);
    const result = await migrate(pool);
    assert.deepEqual(result.applied, [...before.pending]);

    const after = await migrationState(pool);
    const head = (await listMigrations()).at(-1);
    assert.equal(after.schemaVersion, head);
    assert.equal(after.pending.length, 0);
  });

  test("step 4: the review, its findings, its annotations and its evidence survived", async () => {
    const review = await pool.query<{ id: string; slug: string; status: string }>(
      "select id, slug, status from reviews",
    );
    assert.equal(review.rows.length, 1);
    assert.equal(review.rows[0]?.id, manifest.contents.review.id);
    assert.equal(review.rows[0]?.slug, "bugs-on-homepage");
    assert.equal(review.rows[0]?.status, manifest.contents.review.status);

    const findings = await pool.query<{ id: string; status: string; severity: string }>(
      "select id, status, severity from findings order by created_at",
    );
    assert.deepEqual(
      findings.rows.map((row) => ({ id: row.id, status: row.status, severity: row.severity })),
      manifest.contents.findings.map((finding) => ({
        id: finding.id,
        status: finding.status,
        severity: finding.severity,
      })),
    );

    // Annotation geometry is still normalised, which is the property the
    // annotation canvas depends on and the one a migration could silently
    // break (`AGENTS.md`, ADR-0006).
    const annotations = await pool.query<{ id: string; geometry: Record<string, number> }>(
      "select id, geometry from annotations_current",
    );
    assert.equal(
      annotations.rows.length,
      manifest.contents.findings.reduce((total, finding) => total + finding.annotations, 0),
    );
    for (const row of annotations.rows) {
      for (const [member, value] of Object.entries(row.geometry)) {
        assert.ok(value >= 0 && value <= 1, `annotation geometry ${member} is ${String(value)}`);
      }
    }

    const verification = await pool.query<{ id: string; status: string; artefact_id: string }>(
      `select v.id, v.status, va.artefact_id
         from verifications v
         join verification_artefacts va on va.verification_id = v.id and va.role = 'after'`,
    );
    assert.equal(verification.rows[0]?.id, manifest.contents.verification.id);
    assert.equal(verification.rows[0]?.status, manifest.contents.verification.status);
    assert.equal(verification.rows[0]?.artefact_id, manifest.contents.verification.after_artefact_id);

    // Every artefact the metadata references is present and is the bytes the
    // row records. Application metadata is authoritative for availability
    // (ADR-0012), so this is the direction that matters.
    const artefacts = await pool.query<{ id: string; storage_key: string; sha256: string; size_bytes: string }>(
      "select id, storage_key, sha256, size_bytes from artefacts where deleted_at is null",
    );
    assert.equal(artefacts.rows.length, manifest.artefact_store.objects.length);
    for (const row of artefacts.rows) {
      const path = join(artefactRoot, row.storage_key);
      assert.equal(await digestOf(path), row.sha256, `artefact ${row.id} does not match its digest`);
      assert.equal((await stat(path)).size, Number(row.size_bytes));
    }
  });

  test("step 4b: the review builds the document the UI and the export read", async () => {
    const project = await pool.query<{ id: string; organisation_id: string }>(
      "select id, organisation_id from projects limit 1",
    );
    const scope = {
      organisationId: project.rows[0]?.organisation_id ?? "",
      projectId: project.rows[0]?.id ?? "",
    };
    const artefacts = new ArtefactService(
      pool,
      createArtefactStore({
        driver: "filesystem",
        path: artefactRoot,
        maxBytes: 20_971_520,
        s3: {
          endpoint: "",
          bucket: "",
          region: "",
          accessKeyId: "",
          secretAccessKey: "",
          pathStyle: true,
          prefix: undefined,
        },
      }),
      20_971_520,
    );
    const document = await new ReviewService(pool, artefacts).buildExportDocument(
      scope,
      manifest.contents.review.id,
    );
    const rendered = JSON.stringify(document);
    assert.match(rendered, /bugs-on-homepage/u);
    for (const finding of manifest.contents.findings) assert.ok(rendered.includes(finding.id));

    // The export carries the findings' original screenshots
    // (`docs/REVIEW_FORMAT.md`); the agent's after screenshot is evidence
    // attached to the verification rather than to a finding, so it is asserted
    // where it lives — available, and with the bytes its row records.
    const after = await pool.query<{ state: string; storage_key: string; sha256: string }>(
      "select state, storage_key, sha256 from artefacts where id = $1",
      [manifest.contents.verification.after_artefact_id],
    );
    assert.equal(after.rows[0]?.state, "available");
    assert.equal(
      await digestOf(join(artefactRoot, after.rows[0]?.storage_key ?? "")),
      after.rows[0]?.sha256,
    );
  });

  test("step 5: a Stage 0 connector is still classified across the upgrade", async () => {
    // `docs/CONNECTOR_PROTOCOL.md` section 19 and `docs/OPERATIONS.md` section
    // 12: an old connector either keeps working inside the documented support
    // window, or is told UPGRADE_REQUIRED. Both directions are asserted,
    // because "it keeps working" alone would also pass with no policy at all.
    const shipped = { minimumVersion: "0.0.0", recommendedVersion: "0.0.0" };
    assert.equal(classifyUpgrade("0.1.0", shipped), "compatible");

    const tightened = { minimumVersion: "0.2.0", recommendedVersion: "0.3.0" };
    assert.equal(classifyUpgrade("0.1.0", tightened), "upgrade_required");
    assert.equal(classifyUpgrade("0.2.5", tightened), "upgrade_recommended");

    // The preflight reads the same classifier, so what it reports and what the
    // reconnect exchange decides cannot disagree. The fixture enrols no
    // connector — Stage 0 shipped none — so the check reports that rather than
    // inventing a compatibility answer.
    const report = await runPreflight({
      pool,
      artefactPath: artefactRoot,
      minimumConnectorVersion: "0.2.0",
      recommendedConnectorVersion: "0.3.0",
    });
    const connectors = report.checks.find((entry) => entry.name === "connector_compatibility");
    assert.equal(connectors?.status, "pass");
    assert.match(connectors?.detail ?? "", /no connector is enrolled/u);
  });

  test("step 6: the migrations state that they cannot be downgraded", async () => {
    const report = await migrationReport(pool);
    const upgraded = report.applied.filter((record) => record.filename > manifest.schema.migration_head);
    assert.ok(upgraded.length > 0, "the upgrade applied no migration");
    for (const record of upgraded) {
      assert.equal(
        record.downgrade,
        "not_supported",
        `${record.filename} claims a downgrade Stage 1 does not implement`,
      );
      assert.ok((record.note ?? "").length > 0, `${record.filename} gives no reason`);
    }
    // The documented limitation is that the only way back is the archive taken
    // at step 2b — so that archive is *restored*, not stat-ed.
    //
    // The previous version of this asserted `size > 0`, which would have passed
    // on a file of zeroes and never exercised the restore path below `0056` at
    // all. That is exactly where the post-load steps failed: `event_outbox`
    // (`0056`), `install_tokens` (`0070`) and
    // `viewer_sessions.revocation_reason` (`0071`) do not exist at the Stage 0
    // head, and a check on a file's length could not see it.
    const rollback = join(workspace, "pre-upgrade.tar.zst");
    const target = await startPostgres();
    const targetPool = createPool(target.url);
    const rollbackStore = join(workspace, "rollback-artefacts");
    await mkdir(rollbackStore, { recursive: true });
    try {
      const result = await restoreBackup({
        pool: targetPool,
        archive: rollback,
        artefactPath: rollbackStore,
        hostname: "rolled-back.invalid",
      });
      assert.equal(result.applied, true, "the rollback archive did not restore");
      assert.deepEqual(result.missingArtefacts, []);

      // It comes back at the Stage 0 head, with the migrations the upgrade
      // applied reported as pending rather than silently applied.
      const state = await migrationState(targetPool);
      assert.equal(state.schemaVersion, manifest.schema.migration_head);
      assert.deepEqual(
        result.plan.migrationsPendingAfter,
        upgraded.map((record) => record.filename),
      );

      // The review is there, and so is the audit record — on a schema with no
      // event outbox to deliver it through.
      const review = await targetPool.query<{ slug: string; status: string }>(
        "select slug, status from reviews where id = $1",
        [manifest.contents.review.id],
      );
      assert.equal(review.rows[0]?.slug, "bugs-on-homepage");
      assert.equal(review.rows[0]?.status, manifest.contents.review.status);
      const events = await targetPool.query<{ payload: Record<string, unknown> }>(
        "select payload from events where type = 'backup.restored'",
      );
      assert.equal(events.rows.length, 1, "the rollback restore wrote no audit event");
      assert.equal(events.rows[0]?.payload["schema_version"], manifest.schema.migration_head);
      assert.equal(events.rows[0]?.payload["hostname_changed"], true);

      for (const object of manifest.artefact_store.objects) {
        assert.equal(
          await digestOf(join(rollbackStore, object.storage_key)),
          object.sha256,
          `${object.storage_key} did not survive the rollback`,
        );
      }
    } finally {
      await targetPool.end().catch(() => undefined);
      await target.stop();
    }
  });

  test("the upgraded installation backs up and restores whole", async () => {
    const archive = join(workspace, "post-upgrade.tar.zst");
    const backup = await createBackup({
      pool,
      output: archive,
      mode: "full",
      artefactPath: artefactRoot,
      artefactDriver: "filesystem",
      environment: { REVIEWPLANE_GATEWAY_DOMAIN: "stage0.invalid" },
    });
    assert.equal(backup.manifest.schema_version, (await listMigrations()).at(-1));
    assert.deepEqual(backup.missingArtefacts, []);

    const target = await startPostgres();
    const targetPool = createPool(target.url);
    const restoreRoot = join(workspace, "restored-artefacts");
    await mkdir(restoreRoot, { recursive: true });
    try {
      const result = await restoreBackup({
        pool: targetPool,
        archive,
        artefactPath: restoreRoot,
        hostname: "moved.invalid",
      });
      assert.equal(result.applied, true);
      assert.deepEqual(result.missingArtefacts, []);
      assert.deepEqual(result.plan.migrationsPendingAfter, []);

      const review = await targetPool.query<{ slug: string; status: string }>(
        "select slug, status from reviews where id = $1",
        [manifest.contents.review.id],
      );
      assert.equal(review.rows[0]?.slug, "bugs-on-homepage");
      assert.equal(review.rows[0]?.status, manifest.contents.review.status);

      const annotations = await targetPool.query<{ count: string }>(
        "select count(*)::text as count from annotations_current",
      );
      assert.equal(
        Number(annotations.rows[0]?.count),
        manifest.contents.findings.reduce((total, finding) => total + finding.annotations, 0),
      );

      for (const object of manifest.artefact_store.objects) {
        assert.equal(
          await digestOf(join(restoreRoot, object.storage_key)),
          object.sha256,
          `${object.storage_key} did not survive the round trip`,
        );
      }

      // The archive excluded the connector authority's private key, so the
      // restore says the identities it signed have to be re-enrolled rather
      // than presenting them as usable.
      assert.equal(backup.manifest.key_material.included, false);
    } finally {
      await targetPool.end().catch(() => undefined);
      await target.stop();
    }
  });
});

