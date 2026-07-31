/**
 * `reviewplane backup` and `reviewplane restore` against a real database
 * (`docs/TESTING.md` §14, and the fault-injection rows of §11).
 *
 * The cases that matter here are the failures. A backup command is easy to
 * write and easy to believe; what makes it worth relying on is that a truncated
 * archive, an altered member, an archive from a newer release, a target that is
 * not empty and an artefact whose bytes are missing are each *refused or
 * reported* rather than absorbed. Every one of those has its own test below,
 * and each asserts the refusal rather than only asserting that the happy path
 * still works.
 *
 * The database is real for the same reason the rest of this suite's is: the
 * export goes through `row_to_json`, the load goes through
 * `json_populate_recordset` and the atomicity comes from deferred foreign
 * keys — none of which a fake exercises.
 */

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { newEntityId } from "@reviewplane/protocol/platform";

import { MIGRATION_LOCK_KEY, migrationState } from "../src/db/migrate.ts";
import { createPool, type Pool } from "../src/db/pool.ts";
import { ArchiveWriter, digestFile, readArchive } from "../src/modules/backup/archive.ts";
import {
  BACKUP_CREATED_EVENT,
  BACKUP_RESTORED_EVENT,
  createBackup,
  describeConfiguration,
  KEY_MATERIAL_WARNING,
} from "../src/modules/backup/backup.ts";
import { MANIFEST_PATH, parseManifest, renderManifest } from "../src/modules/backup/manifest.ts";
import { renderPreflight, runPreflight } from "../src/modules/backup/preflight.ts";
import {
  ArchiveIntegrityError,
  IncompatibleArchiveError,
  InstallationNotEmptyError,
  inspectArchive,
  restoreBackup,
} from "../src/modules/backup/restore.ts";
import {
  startMigratedDatabase,
  startPostgres,
  truncateAll,
  type MigratedDatabase,
  type TestDatabase,
} from "./support/postgres.ts";

let postgres: MigratedDatabase;
let workspace: string;

/** A pool on a second, initially empty database that restores are aimed at. */
let target: TestDatabase;
let targetPool: Pool;

before(async () => {
  postgres = await startMigratedDatabase();
  target = await startPostgres();
  targetPool = createPool(target.url);
  workspace = await mkdtemp(join(tmpdir(), "reviewplane-backup-"));
});

after(async () => {
  await targetPool?.end().catch(() => undefined);
  await target?.stop();
  await postgres?.stop();
  if (workspace !== undefined) await rm(workspace, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAll(postgres.pool);
  await dropEverything(targetPool);
});

/** Returns the restore target to the state a fresh installation is in. */
async function dropEverything(pool: Pool): Promise<void> {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
}

interface Seeded {
  readonly organisationId: string;
  readonly projectId: string;
  readonly reviewId: string;
  readonly findingId: string;
  readonly artefactId: string;
  readonly storageKey: string;
  readonly artefactPath: string;
}

/**
 * One review with one annotated finding and one stored screenshot.
 *
 * Written as rows rather than driven through the API because this suite is
 * about the archive, not about the review API — and because the rows have to
 * exist in a shape a restore can be checked against digit for digit.
 */
async function seedInstallation(pool: Pool, root: string): Promise<Seeded> {
  const organisationId = newEntityId("organisation");
  const userId = newEntityId("user");
  const projectId = newEntityId("project");
  const reviewId = newEntityId("review");
  const findingId = newEntityId("finding");
  const artefactId = newEntityId("artefact");
  const annotationId = newEntityId("annotation");

  const bytes = randomBytes(2048);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const storageKey = `sha256/${digest.slice(0, 2)}/${digest.slice(2)}`;
  const artefactPath = join(root, storageKey);
  await mkdir(join(root, "sha256", digest.slice(0, 2)), { recursive: true });
  await writeFile(artefactPath, bytes);

  await pool.query("insert into organisations (id, name, slug) values ($1, $2, $3)", [
    organisationId,
    "Refresh",
    `refresh-${organisationId.slice(4, 12)}`,
  ]);
  await pool.query(
    "insert into users (id, organisation_id, email, display_name) values ($1, $2, $3, $4)",
    [userId, organisationId, "administrator@localhost", "Administrator"],
  );
  await pool.query(
    "insert into projects (id, organisation_id, name, slug) values ($1, $2, $3, $4)",
    [projectId, organisationId, "Refresh Surplus", `refresh-surplus-${projectId.slice(4, 12)}`],
  );
  await pool.query(
    `insert into artefacts (id, organisation_id, project_id, kind, state, storage_key,
                            content_type, declared_size_bytes, declared_sha256, size_bytes,
                            sha256, retention_class, created_by_actor_type, available_at,
                            content_width_px, content_height_px)
     values ($1, $2, $3, 'screenshot', 'available', $4, 'image/png', $5, $6, $5, $6,
             'verification_evidence', 'human_user', now(), 780, 1688)`,
    [artefactId, organisationId, projectId, storageKey, bytes.length, digest],
  );
  await pool.query(
    `insert into reviews (id, organisation_id, project_id, slug, title, status,
                          created_by_actor_type, captured_branch, captured_commit,
                          captured_workspace_id)
     values ($1, $2, $3, 'bugs-on-homepage', 'Bugs on homepage', 'READY', 'human_user',
             'redesign', 'c0ffee1', 'wsp_fixture')`,
    [reviewId, organisationId, projectId],
  );
  await pool.query(
    `insert into findings (id, organisation_id, project_id, review_id, title, severity, status,
                           source, screenshot_artefact_id, url, viewport, scroll_position,
                           captured_commit, created_by_actor_type)
     values ($1, $2, $3, $4, 'Hero heading overlaps the navigation', 'high', 'OPEN',
             'human', $5, 'https://route-id.internal.invalid/', $6, $7, 'c0ffee1', 'human_user')`,
    [
      findingId,
      organisationId,
      projectId,
      reviewId,
      artefactId,
      JSON.stringify({ width: 390, height: 844, device_scale_factor: 2 }),
      JSON.stringify({ x: 0, y: 0 }),
    ],
  );
  await pool.query(
    `insert into annotations (id, organisation_id, project_id, finding_id, artefact_id, type,
                              geometry, label, revision, created_by_actor_type)
     values ($1, $2, $3, $4, $5, 'rectangle', $6, 'Overlap', 1, 'human_user')`,
    [
      annotationId,
      organisationId,
      projectId,
      findingId,
      artefactId,
      JSON.stringify({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }),
    ],
  );
  return { organisationId, projectId, reviewId, findingId, artefactId, storageKey, artefactPath };
}

let caseNumber = 0;

/** A private directory for one case: the store, the target store and archives. */
async function scratch(): Promise<{ store: string; restoreStore: string; archive: string }> {
  caseNumber += 1;
  const base = join(workspace, `case-${String(caseNumber)}`);
  await mkdir(join(base, "store"), { recursive: true });
  await mkdir(join(base, "restore-store"), { recursive: true });
  return {
    store: join(base, "store"),
    restoreStore: join(base, "restore-store"),
    archive: join(base, "backup.tar.zst"),
  };
}

describe("the archive container", () => {
  test("refuses a member path that escapes the destination", async () => {
    const places = await scratch();
    const writer = ArchiveWriter.open(places.archive);
    for (const path of ["../escape", "/etc/passwd", "a/../../b", "a\\b", "./x"]) {
      await assert.rejects(
        () => writer.addBuffer(path, Buffer.from("x")),
        /not accepted|traverses/u,
        `${path} was accepted`,
      );
    }
    await writer.abort();
  });

  test("a truncated archive fails to read rather than reading short", async () => {
    const places = await scratch();
    const writer = ArchiveWriter.open(places.archive);
    await writer.addBuffer("manifest.json", Buffer.from("{}"));
    await writer.addBuffer(
      "database/events.jsonl",
      Buffer.from(randomBytes(200_000).toString("hex"), "utf8"),
    );
    await writer.close();

    const size = (await stat(places.archive)).size;
    await truncate(places.archive, Math.floor(size / 2));
    await assert.rejects(
      () => readArchive(places.archive, () => Promise.resolve(null)),
      /truncated|unexpected|Error/u,
    );
  });

  test("an interrupted write leaves nothing at the destination", async () => {
    const places = await scratch();
    const writer = ArchiveWriter.open(places.archive);
    await writer.addBuffer("manifest.json", Buffer.from("{}"));
    await writer.abort();
    await assert.rejects(() => stat(places.archive), /ENOENT/u);
    assert.ok(writer.partialPath !== null);
    await assert.rejects(() => stat(writer.partialPath as string), /ENOENT/u);
  });

  test("a streamed archive is the same archive, and is not renamed into place", async () => {
    // `--output -` is what makes the command usable inside a container: the
    // bytes land in the operator's own shell redirection on the host. The
    // archive itself must be identical to the file form's.
    const places = await scratch();
    const destination = join(places.store, "streamed.tar.zst");
    const sink = createWriteStream(destination);
    const writer = ArchiveWriter.toStream(sink);
    await writer.addBuffer("manifest.json", Buffer.from("{}"));
    const finished = await writer.close();
    assert.equal(finished.path, null);
    assert.equal(finished.bytes, (await stat(destination)).size);
    assert.equal(finished.sha256, (await digestFile(destination)).sha256);
  });
});

describe("the manifest", () => {
  test("round-trips through its schema", async () => {
    const places = await scratch();
    await seedInstallation(postgres.pool, places.store);
    const result = await createBackup({
      pool: postgres.pool,
      output: places.archive,
      mode: "full",
      artefactPath: places.store,
      artefactDriver: "filesystem",
      environment: {},
    });
    const reparsed = parseManifest(renderManifest(result.manifest));
    assert.deepEqual(reparsed, result.manifest);
  });

  test("refuses a manifest version this build does not read", () => {
    assert.throws(
      () => parseManifest(Buffer.from(JSON.stringify({ manifest_version: 2 }))),
      /manifest version 2/u,
    );
  });

  test("refuses a structurally invalid manifest", () => {
    assert.throws(
      () => parseManifest(Buffer.from(JSON.stringify({ manifest_version: 1, mode: "sideways" }))),
      /not a valid backup manifest/u,
    );
  });

  test("records the setting names and never a credential value", () => {
    const described = describeConfiguration({
      REVIEWPLANE_GATEWAY_DOMAIN: "reviews.example",
      REVIEWPLANE_DATABASE_URL: "postgres://reviewplane:hunter2@postgres:5432/reviewplane",
      REVIEWPLANE_CAPABILITY_KEY: "0123456789abcdef",
      REVIEWPLANE_POSTGRES_PASSWORD: "hunter2",
      PATH: "/usr/bin",
    });
    const names = described.settings.map((setting) => setting.name);
    assert.deepEqual(names, [
      "REVIEWPLANE_CAPABILITY_KEY",
      "REVIEWPLANE_DATABASE_URL",
      "REVIEWPLANE_GATEWAY_DOMAIN",
      "REVIEWPLANE_POSTGRES_PASSWORD",
    ]);
    const rendered = JSON.stringify(described);
    assert.ok(!rendered.includes("hunter2"), "a credential reached the configuration record");
    assert.ok(!rendered.includes("0123456789abcdef"), "a key reached the configuration record");
    assert.ok(rendered.includes("reviews.example"), "a non-secret setting was dropped");
  });
});

describe("backup", () => {
  test("produces an archive whose manifest carries version, schema, mode, inventory and checksums", async () => {
    const places = await scratch();
    const seeded = await seedInstallation(postgres.pool, places.store);
    const result = await createBackup({
      pool: postgres.pool,
      output: places.archive,
      mode: "full",
      artefactPath: places.store,
      artefactDriver: "filesystem",
      environment: { REVIEWPLANE_GATEWAY_DOMAIN: "reviews.example" },
    });

    const state = await migrationState(postgres.pool);
    assert.equal(result.manifest.manifest_version, 1);
    assert.equal(result.manifest.mode, "full");
    assert.equal(result.manifest.schema_version, state.schemaVersion);
    assert.equal(result.manifest.source.hostname, "reviews.example");
    assert.equal(result.manifest.source.artefact_driver, "filesystem");
    assert.equal(result.manifest.checksum_algorithm, "sha256");
    assert.equal(result.manifest.artefact_objects, 1);
    assert.ok(result.manifest.entries.length >= result.manifest.tables.length + 1);
    assert.equal(result.sha256.length, 64);

    // Every table in the catalogue is listed, not a hard-coded subset.
    const catalogue = await postgres.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
    );
    assert.deepEqual(
      result.manifest.tables.map((table) => table.name),
      catalogue.rows.map((row) => row.table_name),
    );
    assert.equal(result.manifest.tables.find((table) => table.name === "reviews")?.rows, 1);
    assert.equal(
      result.manifest.entries.find((entry) => entry.path === `artefacts/${seeded.storageKey}`)?.sha256,
      seeded.storageKey.split("/").slice(1).join(""),
    );

    // Integrity is verifiable from the archive alone.
    const inspected = await inspectArchive(places.archive);
    assert.equal(inspected.manifest.schema_version, state.schemaVersion);
  });

  test("records a backup.created audit event", async () => {
    const places = await scratch();
    await seedInstallation(postgres.pool, places.store);
    await createBackup({
      pool: postgres.pool,
      output: places.archive,
      mode: "full",
      artefactPath: places.store,
      artefactDriver: "filesystem",
      environment: {},
    });
    const { rows } = await postgres.pool.query<{ payload: Record<string, unknown> }>(
      "select payload from events where type = $1",
      [BACKUP_CREATED_EVENT],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.payload["mode"], "full");
    assert.equal(rows[0]?.payload["key_material_included"], false);
    assert.equal(String(rows[0]?.payload["archive_sha256"]).length, 64);
  });

  test("database mode records the mode and carries no artefact object", async () => {
    const places = await scratch();
    await seedInstallation(postgres.pool, places.store);
    const result = await createBackup({
      pool: postgres.pool,
      output: places.archive,
      mode: "database",
      artefactPath: places.store,
      artefactDriver: "s3",
      environment: {},
    });
    assert.equal(result.manifest.mode, "database");
    assert.equal(result.manifest.artefact_objects, 0);
    assert.equal(result.manifest.source.artefact_driver, "s3");
    assert.ok(!result.manifest.entries.some((entry) => entry.path.startsWith("artefacts/")));
  });

  test("refuses a full backup of an installation whose artefacts are external", async () => {
    const places = await scratch();
    await seedInstallation(postgres.pool, places.store);
    await assert.rejects(
      () =>
        createBackup({
          pool: postgres.pool,
          output: places.archive,
          mode: "full",
          artefactPath: places.store,
          artefactDriver: "s3",
          environment: {},
        }),
      /--mode database/u,
    );
  });

  test("records an artefact the metadata references and the store does not hold", async () => {
    const places = await scratch();
    const seeded = await seedInstallation(postgres.pool, places.store);
    await rm(seeded.artefactPath);
    const result = await createBackup({
      pool: postgres.pool,
      output: places.archive,
      mode: "full",
      artefactPath: places.store,
      artefactDriver: "filesystem",
      environment: {},
    });
    assert.deepEqual(result.missingArtefacts, [seeded.storageKey]);
    assert.deepEqual(result.manifest.artefacts_missing, [seeded.storageKey]);
  });
});

describe("key material", () => {
  test("is excluded by default, and the manifest says so", async () => {
    const places = await scratch();
    await seedInstallation(postgres.pool, places.store);
    await seedCertificateAuthority(postgres.pool);

    const result = await createBackup({
      pool: postgres.pool,
      output: places.archive,
      mode: "full",
      artefactPath: places.store,
      artefactDriver: "filesystem",
      environment: {},
    });
    assert.equal(result.manifest.key_material.included, false);
    assert.deepEqual(result.manifest.key_material.excluded_tables, ["connector_tls_material"]);
    assert.equal(
      result.manifest.tables.find((table) => table.name === "connector_tls_material")?.rows,
      0,
    );
    const body = await readMember(places.archive, "database/connector_tls_material.jsonl");
    assert.equal(body.length, 0);
    assert.ok(!(await archiveContains(places.archive, CA_PRIVATE_KEY)));
  });

  test("the opt-in warns, carries the rows and records that it did", async () => {
    const places = await scratch();
    await seedInstallation(postgres.pool, places.store);
    await seedCertificateAuthority(postgres.pool);
    const printed: string[] = [];
    const result = await createBackup({
      pool: postgres.pool,
      output: places.archive,
      mode: "full",
      includeKeyMaterial: true,
      artefactPath: places.store,
      artefactDriver: "filesystem",
      environment: {},
      log: (line) => printed.push(line),
    });
    assert.ok(printed.includes(KEY_MATERIAL_WARNING), "the opt-in printed no warning");
    assert.equal(result.manifest.key_material.included, true);
    assert.deepEqual(result.manifest.key_material.excluded_tables, []);
    assert.equal(
      result.manifest.tables.find((table) => table.name === "connector_tls_material")?.rows,
      1,
    );
    assert.ok(await archiveContains(places.archive, CA_PRIVATE_KEY));

    const { rows } = await postgres.pool.query<{ payload: Record<string, unknown> }>(
      "select payload from events where type = $1",
      [BACKUP_CREATED_EVENT],
    );
    assert.equal(rows[0]?.payload["key_material_included"], true);
  });
});

describe("restore", () => {
  test("a dry run verifies the archive and writes nothing", async () => {
    const places = await scratch();
    await seedInstallation(postgres.pool, places.store);
    await createBackup({
      pool: postgres.pool,
      output: places.archive,
      mode: "full",
      artefactPath: places.store,
      artefactDriver: "filesystem",
      environment: {},
    });

    const result = await restoreBackup({
      pool: targetPool,
      archive: places.archive,
      artefactPath: places.restoreStore,
      dryRun: true,
    });
    assert.equal(result.applied, false);
    assert.equal(result.plan.artefactObjects, 1);
    assert.ok(result.plan.rows > 0);
    assert.deepEqual(result.plan.blockers, []);

    const tables = await targetPool.query<{ count: string }>(
      "select count(*)::text as count from information_schema.tables where table_schema = 'public'",
    );
    assert.equal(tables.rows[0]?.count, "0", "the dry run created a schema");
    await assert.rejects(() => stat(join(places.restoreStore, "sha256")), /ENOENT/u);
  });

  test("restores reviews, findings, annotations and evidence into an empty installation", async () => {
    const places = await scratch();
    const seeded = await seedInstallation(postgres.pool, places.store);
    const backup = await createBackup({
      pool: postgres.pool,
      output: places.archive,
      mode: "full",
      artefactPath: places.store,
      artefactDriver: "filesystem",
      environment: {},
    });

    const result = await restoreBackup({
      pool: targetPool,
      archive: places.archive,
      artefactPath: places.restoreStore,
    });
    assert.equal(result.applied, true);
    assert.deepEqual(result.missingArtefacts, []);

    // Every table comes back with the count the manifest recorded, except the
    // three the restore's own audit event writes to and `schema_migrations`,
    // which the migration runner owns rather than the archive.
    const writtenByTheAudit = new Set(["events", "event_streams", "event_outbox"]);
    for (const table of backup.manifest.tables) {
      if (table.name === "schema_migrations" || writtenByTheAudit.has(table.name)) continue;
      const { rows } = await targetPool.query<{ count: string }>(
        `select count(*)::text as count from "${table.name}"`,
      );
      assert.equal(
        Number(rows[0]?.count),
        table.rows,
        `${table.name} restored a different number of rows`,
      );
    }
    const events = await targetPool.query<{ count: string }>(
      "select count(*)::text as count from events",
    );
    assert.equal(
      Number(events.rows[0]?.count),
      (backup.manifest.tables.find((table) => table.name === "events")?.rows ?? 0) + 1,
      "the restore did not add exactly its own backup.restored event",
    );

    const review = await targetPool.query<{ slug: string; status: string }>(
      "select slug, status from reviews where id = $1",
      [seeded.reviewId],
    );
    assert.equal(review.rows[0]?.slug, "bugs-on-homepage");
    const annotation = await targetPool.query<{ geometry: Record<string, number> }>(
      "select geometry from annotations where finding_id = $1",
      [seeded.findingId],
    );
    assert.deepEqual(annotation.rows[0]?.geometry, { x: 0.1, y: 0.2, width: 0.3, height: 0.4 });

    const restoredBytes = await readFile(join(places.restoreStore, seeded.storageKey));
    const original = await readFile(seeded.artefactPath);
    assert.ok(restoredBytes.equals(original), "the evidence bytes changed in the round trip");

    const { rows } = await targetPool.query<{ payload: Record<string, unknown> }>(
      "select payload from events where type = $1",
      [BACKUP_RESTORED_EVENT],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.payload["artefacts_missing"], 0);
  });

  test("refuses an installation that is not empty", async () => {
    const places = await scratch();
    await seedInstallation(postgres.pool, places.store);
    await createBackup({
      pool: postgres.pool,
      output: places.archive,
      mode: "full",
      artefactPath: places.store,
      artefactDriver: "filesystem",
      environment: {},
    });
    await restoreBackup({
      pool: targetPool,
      archive: places.archive,
      artefactPath: places.restoreStore,
    });
    await assert.rejects(
      () =>
        restoreBackup({
          pool: targetPool,
          archive: places.archive,
          artefactPath: places.restoreStore,
        }),
      InstallationNotEmptyError,
    );
  });

  test("refuses an archive whose schema version this build does not have", async () => {
    const places = await scratch();
    await seedInstallation(postgres.pool, places.store);
    await createBackup({
      pool: postgres.pool,
      output: places.archive,
      mode: "database",
      artefactPath: places.store,
      artefactDriver: "filesystem",
      environment: {},
    });
    const forged = await rewriteManifest(places.archive, (manifest) => ({
      ...manifest,
      schema_version: "9999_from_the_future.sql",
    }));
    await assert.rejects(
      () =>
        restoreBackup({
          pool: targetPool,
          archive: forged,
          artefactPath: places.restoreStore,
        }),
      IncompatibleArchiveError,
    );
  });

  test("refuses an altered member", async () => {
    const places = await scratch();
    await seedInstallation(postgres.pool, places.store);
    await createBackup({
      pool: postgres.pool,
      output: places.archive,
      mode: "full",
      artefactPath: places.store,
      artefactDriver: "filesystem",
      environment: {},
    });
    // Rebuild the archive with one member's bytes changed and the manifest left
    // as it was: exactly what a tampered or bit-rotted archive looks like.
    const altered = await rebuildArchive(places.archive, (path, data) =>
      path === "database/reviews.jsonl" ? Buffer.from(data.toString("utf8").replace("bugs", "BUGS")) : data,
    );
    await assert.rejects(
      () => inspectArchive(altered),
      (error: unknown) =>
        error instanceof ArchiveIntegrityError && /does not match the digest|bytes; the manifest/u.test(error.message),
    );
  });

  test("refuses an archive with a member its manifest does not declare", async () => {
    const places = await scratch();
    await seedInstallation(postgres.pool, places.store);
    await createBackup({
      pool: postgres.pool,
      output: places.archive,
      mode: "database",
      artefactPath: places.store,
      artefactDriver: "filesystem",
      environment: {},
    });
    const smuggled = await rebuildArchive(places.archive, (_path, data) => data, {
      extra: [{ path: "database/smuggled.jsonl", data: Buffer.from("{}\n") }],
    });
    await assert.rejects(() => inspectArchive(smuggled), /manifest does not declare/u);
  });

  test("refuses a truncated archive before writing anything", async () => {
    const places = await scratch();
    await seedInstallation(postgres.pool, places.store);
    await createBackup({
      pool: postgres.pool,
      output: places.archive,
      mode: "full",
      artefactPath: places.store,
      artefactDriver: "filesystem",
      environment: {},
    });
    const size = (await stat(places.archive)).size;
    await truncate(places.archive, size - 64);
    await assert.rejects(() =>
      restoreBackup({
        pool: targetPool,
        archive: places.archive,
        artefactPath: places.restoreStore,
      }),
    );
    const tables = await targetPool.query<{ count: string }>(
      "select count(*)::text as count from information_schema.tables where table_schema = 'public'",
    );
    assert.equal(tables.rows[0]?.count, "0", "a refused restore created a schema");
  });

  test("reports evidence the metadata references and the store does not hold", async () => {
    const places = await scratch();
    const seeded = await seedInstallation(postgres.pool, places.store);
    await rm(seeded.artefactPath);
    await createBackup({
      pool: postgres.pool,
      output: places.archive,
      mode: "full",
      artefactPath: places.store,
      artefactDriver: "filesystem",
      environment: {},
    });
    const lines: string[] = [];
    const result = await restoreBackup({
      pool: targetPool,
      archive: places.archive,
      artefactPath: places.restoreStore,
      log: (line) => lines.push(line),
    });
    assert.equal(result.applied, true);
    assert.deepEqual(result.missingArtefacts, [seeded.storageKey]);
    assert.ok(
      lines.some((line) => line.includes("MISSING EVIDENCE")),
      "the restore did not report the missing evidence",
    );
    const { rows } = await targetPool.query<{ payload: Record<string, unknown> }>(
      "select payload from events where type = $1",
      [BACKUP_RESTORED_EVENT],
    );
    assert.equal(rows[0]?.payload["artefacts_missing"], 1);
  });

  test("restoring to a new hostname revokes the credentials issued for the old one", async () => {
    const places = await scratch();
    const seeded = await seedInstallation(postgres.pool, places.store);
    await postgres.pool.query(
      `insert into viewer_sessions (id, organisation_id, project_ids, token_sha256, display, expires_at)
       values ($1, $2, null, $3, 'Administrator', now() + interval '1 day')`,
      [newEntityId("human_session"), seeded.organisationId, createHash("sha256").update("t").digest("hex")],
    );
    await createBackup({
      pool: postgres.pool,
      output: places.archive,
      mode: "full",
      artefactPath: places.store,
      artefactDriver: "filesystem",
      environment: { REVIEWPLANE_GATEWAY_DOMAIN: "old.example" },
    });

    const lines: string[] = [];
    const result = await restoreBackup({
      pool: targetPool,
      archive: places.archive,
      artefactPath: places.restoreStore,
      hostname: "new.example",
      log: (line) => lines.push(line),
    });
    assert.equal(result.invalidated.humanSessions, 1);
    const live = await targetPool.query<{ count: string }>(
      "select count(*)::text as count from viewer_sessions where revoked_at is null",
    );
    assert.equal(live.rows[0]?.count, "0");
    assert.ok(
      lines.some((line) => line.includes("REVIEWPLANE_GATEWAY_DOMAIN")),
      "the restore did not say which setting to change",
    );
    const { rows } = await targetPool.query<{ payload: Record<string, unknown> }>(
      "select payload from events where type = $1",
      [BACKUP_RESTORED_EVENT],
    );
    assert.equal(rows[0]?.payload["hostname_changed"], true);
  });

  test("a database-only archive says its evidence lives in external storage", async () => {
    const places = await scratch();
    await seedInstallation(postgres.pool, places.store);
    await createBackup({
      pool: postgres.pool,
      output: places.archive,
      mode: "database",
      artefactPath: places.store,
      artefactDriver: "s3",
      environment: {},
    });
    const lines: string[] = [];
    const result = await restoreBackup({
      pool: targetPool,
      archive: places.archive,
      artefactPath: places.restoreStore,
      log: (line) => lines.push(line),
    });
    assert.equal(result.applied, true);
    assert.equal(result.missingArtefacts.length, 1);
    assert.ok(
      lines.some((line) => line.includes("database-only archive") && line.includes("s3")),
      "the restore did not explain where the evidence is",
    );
  });

  test("a load that would leave a dangling reference writes nothing", async () => {
    const places = await scratch();
    await seedInstallation(postgres.pool, places.store);
    await createBackup({
      pool: postgres.pool,
      output: places.archive,
      mode: "database",
      artefactPath: places.store,
      artefactDriver: "filesystem",
      environment: {},
    });
    // Remove the organisations every other row references, leaving the manifest
    // untouched but the data inconsistent: the deferred foreign keys must catch
    // it at the end of the load and roll the whole thing back.
    const broken = await rebuildArchive(
      places.archive,
      (path, data) => (path === "database/organisations.jsonl" ? Buffer.alloc(0) : data),
      {
        recomputeEntries: true,
        editManifest: (manifest) => ({
          ...manifest,
          tables: manifest.tables.map((table) =>
            table.name === "organisations" ? { ...table, rows: 0 } : table,
          ),
        }),
      },
    );
    await assert.rejects(() =>
      restoreBackup({
        pool: targetPool,
        archive: broken,
        artefactPath: places.restoreStore,
      }),
    );
    const reviews = await targetPool.query<{ count: string }>(
      "select count(*)::text as count from reviews",
    );
    assert.equal(reviews.rows[0]?.count, "0", "a failed load left rows behind");
  });
});

describe("the upgrade preflight", () => {
  test("reports every check of docs/OPERATIONS.md section 12, including the ones that pass", async () => {
    const places = await scratch();
    await seedInstallation(postgres.pool, places.store);
    const report = await runPreflight({ pool: postgres.pool, artefactPath: places.store });
    assert.deepEqual(
      report.checks.map((entry) => entry.name),
      [
        "source_version",
        "backup_freshness",
        "disk_space",
        "connector_compatibility",
        "worker_compatibility",
        "migration_lock",
      ],
    );
    for (const entry of report.checks) assert.ok(entry.detail.length > 0, `${entry.name} said nothing`);
    assert.match(renderPreflight(report), /source_version/u);
  });

  test("an installation that has never backed up fails, and one that has passes", async () => {
    const places = await scratch();
    await seedInstallation(postgres.pool, places.store);

    const before = await runPreflight({ pool: postgres.pool, artefactPath: places.store });
    assert.equal(check(before, "backup_freshness").status, "fail");
    assert.equal(before.ok, false);

    await createBackup({
      pool: postgres.pool,
      output: places.archive,
      mode: "full",
      artefactPath: places.store,
      artefactDriver: "filesystem",
      environment: {},
    });

    const after = await runPreflight({ pool: postgres.pool, artefactPath: places.store });
    assert.equal(check(after, "backup_freshness").status, "pass");
    assert.equal(after.ok, true, JSON.stringify(after.checks));

    // A backup older than the window is a warning, not a failure: it is still a
    // rollback artefact, and refusing the upgrade over its age would push an
    // operator into skipping the preflight.
    const stale = await runPreflight({
      pool: postgres.pool,
      artefactPath: places.store,
      now: () => new Date(Date.now() + 48 * 3_600_000),
    });
    assert.equal(check(stale, "backup_freshness").status, "warn");
    assert.equal(stale.ok, true);
  });

  test("free space that cannot be measured is a failure rather than a silence", async () => {
    const report = await runPreflight({
      pool: postgres.pool,
      artefactPath: join(workspace, "no-such-volume"),
    });
    assert.equal(check(report, "disk_space").status, "fail");
    assert.equal(report.ok, false);
  });

  test("a connector below the minimum is reported before the upgrade, not after it", async () => {
    const places = await scratch();
    const seeded = await seedInstallation(postgres.pool, places.store);
    const environmentId = newEntityId("environment");
    await postgres.pool.query(
      `insert into environments (id, organisation_id, name, platform, architecture, labels)
       values ($1, $2, 'dev-vm', 'linux', 'amd64', '{}')`,
      [environmentId, seeded.organisationId],
    );
    await postgres.pool.query(
      `insert into connectors (id, organisation_id, environment_id, status, version, capabilities,
                               public_key, certificate_fingerprint, certificate_serial,
                               certificate_not_after)
       values ($1, $2, $3, 'ACTIVE', '0.1.0', '{}', 'key', 'fingerprint', '01',
               now() + interval '30 days')`,
      [newEntityId("connector"), seeded.organisationId, environmentId],
    );
    await createBackup({
      pool: postgres.pool,
      output: places.archive,
      mode: "full",
      artefactPath: places.store,
      artefactDriver: "filesystem",
      environment: {},
    });
    const report = await runPreflight({
      pool: postgres.pool,
      artefactPath: places.store,
      minimumConnectorVersion: "0.2.0",
      recommendedConnectorVersion: "0.3.0",
    });
    const connectors = check(report, "connector_compatibility");
    assert.equal(connectors.status, "warn");
    assert.match(connectors.detail, /UPGRADE_REQUIRED/u);
    // A connector that will be refused does not block the control plane's own
    // upgrade: it is the connector that has to move.
    assert.equal(report.ok, true, JSON.stringify(report.checks));
  });

  test("a held migration lock is a failure and starts no migration", async () => {
    const places = await scratch();
    await seedInstallation(postgres.pool, places.store);
    const holder = createPool(postgres.url);
    const client = await holder.connect();
    try {
      await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
      const report = await runPreflight({ pool: postgres.pool, artefactPath: places.store });
      assert.equal(check(report, "migration_lock").status, "fail");
      assert.equal(report.ok, false);
    } finally {
      client.release();
      await holder.end();
    }
  });
});

/** One named check from a preflight report. */
function check(
  report: Awaited<ReturnType<typeof runPreflight>>,
  name: string,
): { status: string; detail: string } {
  const found = report.checks.find((entry) => entry.name === name);
  assert.ok(found !== undefined, `the report has no ${name} check`);
  return found;
}

/**
 * The connector certificate authority, with a private key a test can search
 * the archive for.
 *
 * `truncateAll` deliberately leaves this table alone, so the row is removed
 * first: the assertion is about which archive carries it, and a row left over
 * from another case would make both directions of that assertion pass.
 */
const CA_PRIVATE_KEY = "private-key-material-that-must-not-travel";

async function seedCertificateAuthority(pool: Pool): Promise<void> {
  await pool.query("delete from connector_tls_material");
  await pool.query(
    `insert into connector_tls_material (purpose, certificate_pem, private_key_pem, not_after)
     values ('certificate_authority', 'cert', $1, now() + interval '365 days')`,
    [CA_PRIVATE_KEY],
  );
}

/** Reads one member out of an archive. */
async function readMember(archive: string, path: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  await readArchive(archive, (member) =>
    Promise.resolve(
      member.path === path
        ? {
            write: (chunk: Buffer): void => {
              parts.push(chunk);
            },
            end: (): void => undefined,
          }
        : null,
    ),
  );
  return Buffer.concat(parts);
}

/** Whether any member of an archive holds a given string. */
async function archiveContains(archive: string, needle: string): Promise<boolean> {
  let found = false;
  await readArchive(archive, () =>
    Promise.resolve({
      write: (chunk: Buffer): void => {
        if (chunk.toString("utf8").includes(needle)) found = true;
      },
      end: (): void => undefined,
    }),
  );
  return found;
}

/** Reads every member into memory. Only used on the small archives above. */
async function readAllMembers(archive: string): Promise<{ path: string; data: Buffer }[]> {
  const members: { path: string; data: Buffer }[] = [];
  await readArchive(archive, (member) => {
    const parts: Buffer[] = [];
    return Promise.resolve({
      write: (chunk: Buffer): void => {
        parts.push(chunk);
      },
      end: (): void => {
        members.push({ path: member.path, data: Buffer.concat(parts) });
      },
    });
  });
  return members;
}

/**
 * Rebuilds an archive with members changed, added or replaced, leaving the
 * manifest as it was unless `editManifest` says otherwise.
 *
 * This is how the tampering cases are written: they produce a file that is a
 * perfectly well-formed archive and disagrees with its own manifest, which is
 * the shape corruption and tampering both take.
 */
async function rebuildArchive(
  archive: string,
  edit: (path: string, data: Buffer) => Buffer,
  options: {
    extra?: { path: string; data: Buffer }[];
    editManifest?: (manifest: ReturnType<typeof parseManifest>) => ReturnType<typeof parseManifest>;
    /**
     * Bring the manifest's entries back into agreement with the members.
     *
     * Off by default, because the tampering cases are exactly the ones where
     * the two disagree. On for the case that needs a *well-formed* archive
     * carrying inconsistent data, so the refusal it provokes comes from the
     * database rather than from the integrity check.
     */
    recomputeEntries?: boolean;
  } = {},
): Promise<string> {
  const members = await readAllMembers(archive);
  const extra = options.extra ?? [];
  const out = join(
    workspace,
    `rebuilt-${String(caseNumber)}-${String(extra.length)}${options.recomputeEntries === true ? "-r" : ""}.tar.zst`,
  );
  const edited = members
    .filter((member) => member.path !== MANIFEST_PATH)
    .map((member) => ({ path: member.path, data: edit(member.path, member.data) }))
    .concat(extra);

  const original = parseManifest(
    (members.find((member) => member.path === MANIFEST_PATH) as { data: Buffer }).data,
  );
  const withEdits = options.editManifest === undefined ? original : options.editManifest(original);
  const manifest =
    options.recomputeEntries === true
      ? {
          ...withEdits,
          entries: edited.map((member) => ({
            path: member.path,
            bytes: member.data.length,
            sha256: createHash("sha256").update(member.data).digest("hex"),
          })),
        }
      : withEdits;

  const writer = ArchiveWriter.open(out);
  await writer.addBuffer(MANIFEST_PATH, renderManifest(manifest));
  for (const member of edited) await writer.addBuffer(member.path, member.data);
  await writer.close();
  return out;
}

/** Rewrites only the manifest, leaving every other member as it was. */
async function rewriteManifest(
  archive: string,
  edit: (manifest: ReturnType<typeof parseManifest>) => ReturnType<typeof parseManifest>,
): Promise<string> {
  return rebuildArchive(archive, (_path, data) => data, { editManifest: edit });
}
