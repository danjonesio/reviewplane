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
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { createZstdDecompress } from "node:zlib";

import { newEntityId } from "@reviewplane/protocol/platform";

import {
  migrate,
  MIGRATION_LOCK_KEY,
  MIGRATIONS_DIRECTORY,
  migrationState,
} from "../src/db/migrate.ts";
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

  /**
   * The case the reader exists for.
   *
   * Node's zstd decompressor does **not** error on an incomplete frame: it
   * emits what it could decode and ends the stream cleanly, so a file cut in
   * half arrives at the tar layer as a short but perfectly valid byte sequence
   * and nothing below this reader will object to it. The guarantee is therefore
   * this reader's alone, and it is asserted as the invariant rather than as a
   * particular error message: **a truncated archive is either refused or read
   * whole; it is never read short.**
   *
   * Both outcomes are legitimate and the test accepts either, because a cut
   * that removes only trailing frame bytes takes no data with it — losing the
   * last byte of a zstd epilogue leaves every member present and matching. What
   * must never happen is a read that returns fewer members, or a shorter
   * member, and reports success.
   */
  test("a truncated archive is refused or read whole, never read short", async () => {
    const places = await scratch();
    const body = Buffer.from(randomBytes(200_000).toString("hex"), "utf8");
    const writer = ArchiveWriter.open(places.archive);
    await writer.addBuffer("manifest.json", Buffer.from("{}"));
    await writer.addBuffer("database/events.jsonl", body);
    await writer.close();
    const size = (await stat(places.archive)).size;

    const readMembers = async (path: string): Promise<{ path: string; bytes: number }[]> => {
      const members: { path: string; bytes: number }[] = [];
      await readArchive(path, (member) => {
        let seen = 0;
        return Promise.resolve({
          write: (chunk: Buffer): void => {
            seen += chunk.length;
          },
          end: (): void => {
            members.push({ path: member.path, bytes: seen });
          },
        });
      });
      return members;
    };

    const whole = await readMembers(places.archive);
    assert.deepEqual(whole, [
      { path: "manifest.json", bytes: 2 },
      { path: "database/events.jsonl", bytes: body.length },
    ]);

    for (const [label, bytes] of [
      ["one byte short", size - 1],
      ["ten bytes short", size - 10],
      ["half", Math.floor(size / 2)],
      ["a hundred bytes", 100],
      ["empty", 0],
    ] as const) {
      const cut = `${places.archive}.cut-${String(bytes)}`;
      await copyFile(places.archive, cut);
      await truncate(cut, bytes);
      let members: { path: string; bytes: number }[] | null = null;
      try {
        members = await readMembers(cut);
      } catch (error) {
        assert.match((error as Error).message, /truncated|corrupt/u, `cut to ${label}`);
      }
      if (members !== null) {
        assert.deepEqual(
          members,
          whole,
          `an archive cut to ${label} was read short and reported as complete`,
        );
      }
    }

    // Recorded as its own assertion rather than as a comment, because the
    // reader's whole justification rests on it: if a future Node did error on
    // an incomplete frame, this fails and the reasoning above is revisited.
    const decompressed = createReadStream(
      `${places.archive}.cut-${String(Math.floor(size / 2))}`,
    ).pipe(createZstdDecompress());
    await assert.doesNotReject(async () => {
      for await (const chunk of decompressed) void chunk;
    }, "Node's zstd decompressor now errors on an incomplete frame");
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

  /**
   * The round trip has to be byte-identical, and the case that breaks it is a
   * multi-byte character landing on a decompressor chunk boundary.
   *
   * `chunk.toString("utf8")` decodes each chunk alone, so half a character at a
   * boundary became U+FFFD before anything could join the halves — silently,
   * with the row counts unchanged and the manifest digests already checked
   * against the archive's *bytes*. A restore reported success and three rows in
   * twenty-one came back mangled.
   *
   * The rows are padded so the table's export crosses several 16 KiB
   * boundaries, and the text is compared as bytes rather than as strings so a
   * replacement character cannot compare equal to what it replaced.
   */
  test("text survives the round trip byte for byte, across chunk boundaries", async () => {
    const places = await scratch();
    const seeded = await seedInstallation(postgres.pool, places.store);

    // The content is deliberately adversarial rather than realistic-looking. A
    // sprinkling of accents among ASCII only breaks when a boundary happens to
    // land on one, which makes the test a coin toss: an earlier version of it
    // passed against the unfixed code. A long run of four-byte characters makes
    // the hit certain — three of every four byte positions are inside a
    // character — so the test fails whenever the decoding is wrong and not
    // merely when it is unlucky. The realistic marks are kept beside it because
    // they are what a review title actually contains.
    const marks = ["em—dash", "café", "naïve", "日本語", "🙂 emoji", "Ω≈ç√", "straße"];
    const titles: string[] = [];
    for (let index = 0; index < 96; index += 1) {
      const mark = marks[index % marks.length] as string;
      const title = `${"🙂".repeat(300)} ${mark} ${"é".repeat(200)} ${String(index)}`;
      titles.push(title);
      await postgres.pool.query(
        `insert into reviews (id, organisation_id, project_id, slug, title, status,
                              created_by_actor_type, captured_branch, captured_commit,
                              captured_workspace_id)
         values ($1, $2, $3, $4, $5, 'READY', 'human_user', 'main', 'c0ffee1', 'wsp_1')`,
        [
          newEntityId("review"),
          seeded.organisationId,
          seeded.projectId,
          `unicode-${String(index)}`,
          title,
        ],
      );
    }

    await createBackup({
      pool: postgres.pool,
      output: places.archive,
      mode: "database",
      artefactPath: places.store,
      artefactDriver: "filesystem",
      environment: {},
    });
    const member = await readMember(places.archive, "database/reviews.jsonl");
    assert.ok(
      member.length > 16 * 1024,
      `the reviews member is ${String(member.length)} bytes, too small to cross a chunk boundary`,
    );

    const result = await restoreBackup({
      pool: targetPool,
      archive: places.archive,
      artefactPath: places.restoreStore,
    });
    assert.equal(result.applied, true);

    const restored = await targetPool.query<{ slug: string; title: string }>(
      "select slug, title from reviews order by slug",
    );
    const byTitle = new Map(restored.rows.map((row) => [row.slug, row.title]));
    for (const [index, title] of titles.entries()) {
      const back = byTitle.get(`unicode-${String(index)}`);
      assert.ok(back !== undefined, `review unicode-${String(index)} did not come back`);
      assert.deepEqual(
        Buffer.from(back, "utf8"),
        Buffer.from(title, "utf8"),
        `review unicode-${String(index)} changed in the round trip`,
      );
    }
    assert.ok(
      !restored.rows.some((row) => row.title.includes("�")),
      "a replacement character reached the restored data",
    );
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
    // Not "no rows" but "no schema": the load rolls back, and the schema the
    // restore created on the way in goes with it, so the target is exactly as
    // the command found it and the operator can run it again.
    const tables = await targetPool.query<{ count: string }>(
      "select count(*)::text as count from information_schema.tables where table_schema = 'public'",
    );
    assert.equal(tables.rows[0]?.count, "0", "a failed load left a schema behind");
  });
});

/**
 * Restoring an archive taken at an **older** schema than this build.
 *
 * This is the rollback path `docs/DEPLOYMENT.md` §15 documents and the shape
 * the Stage 0 upgrade begins with, and it was the one path nothing exercised:
 * every other restore test uses an archive at the current head, where every
 * table and every column the post-load steps touch happens to exist. Against a
 * `0054` archive they do not — `event_outbox` arrives at `0056`,
 * `install_tokens` at `0070` and `viewer_sessions.revocation_reason` at
 * `0071` — and the steps that used to run after the commit failed there, having
 * already committed the data, written no audit event and rotated nothing.
 */
describe("restoring an archive from an older schema", () => {
  /** The Stage 0 head: before the event outbox, the install tokens and the CSRF columns. */
  const OLD_SCHEMA = "0054_idempotency_keys.sql";

  /** A database migrated only as far as `OLD_SCHEMA`, with one live session. */
  async function oldInstallation(): Promise<{
    database: TestDatabase;
    pool: Pool;
    organisationId: string;
    sessionId: string;
  }> {
    const database = await startPostgres();
    const pool = createPool(database.url);
    await migrate(pool, MIGRATIONS_DIRECTORY, { through: OLD_SCHEMA });
    const organisationId = newEntityId("organisation");
    const sessionId = newEntityId("human_session");
    await pool.query("insert into organisations (id, name, slug) values ($1, 'Old', 'old-org')", [
      organisationId,
    ]);
    await pool.query(
      `insert into viewer_sessions (id, organisation_id, project_ids, token_sha256, display, expires_at)
       values ($1, $2, null, $3, 'Administrator', now() + interval '1 day')`,
      [sessionId, organisationId, createHash("sha256").update("old").digest("hex")],
    );
    return { database, pool, organisationId, sessionId };
  }

  test("restores to completion, with the audit event the schema can hold", async () => {
    const places = await scratch();
    const source = await oldInstallation();
    const restored = await startPostgres();
    const restoredPool = createPool(restored.url);
    try {
      const backup = await createBackup({
        pool: source.pool,
        output: places.archive,
        mode: "database",
        artefactPath: places.store,
        artefactDriver: "filesystem",
        environment: {},
      });
      assert.equal(backup.manifest.schema_version, OLD_SCHEMA);

      const result = await restoreBackup({
        pool: restoredPool,
        archive: places.archive,
        artefactPath: places.restoreStore,
      });
      assert.equal(result.applied, true);
      // The restore stops at the archive's schema and says what is left.
      assert.ok(result.plan.migrationsPendingAfter.length > 0);
      assert.equal(result.plan.migrationsPendingAfter[0], "0055_users_and_stage_1_seed.sql");

      const state = await migrationState(restoredPool);
      assert.equal(state.schemaVersion, OLD_SCHEMA);

      // The acceptance criterion: backup and restore emit audit events. The
      // event is written even though `event_outbox` does not exist at this
      // schema — only the delivery obligation is skipped.
      const events = await restoredPool.query<{ payload: Record<string, unknown> }>(
        "select payload from events where type = $1",
        [BACKUP_RESTORED_EVENT],
      );
      assert.equal(events.rows.length, 1, "the restore wrote no backup.restored event");
      assert.equal(events.rows[0]?.payload["schema_version"], OLD_SCHEMA);

      const organisations = await restoredPool.query<{ count: string }>(
        "select count(*)::text as count from organisations",
      );
      assert.equal(organisations.rows[0]?.count, "1");
    } finally {
      await restoredPool.end().catch(() => undefined);
      await restored.stop();
      await source.pool.end().catch(() => undefined);
      await source.database.stop();
    }
  });

  test("a new hostname rotates the credentials the old schema does have", async () => {
    const places = await scratch();
    const source = await oldInstallation();
    const restored = await startPostgres();
    const restoredPool = createPool(restored.url);
    try {
      await createBackup({
        pool: source.pool,
        output: places.archive,
        mode: "database",
        artefactPath: places.store,
        artefactDriver: "filesystem",
        environment: { REVIEWPLANE_GATEWAY_DOMAIN: "old.example" },
      });

      const result = await restoreBackup({
        pool: restoredPool,
        archive: places.archive,
        artefactPath: places.restoreStore,
        hostname: "new.example",
      });
      assert.equal(result.applied, true);
      assert.equal(result.invalidated.humanSessions, 1);
      // `install_tokens` does not exist at this schema, so the step reports
      // nothing rather than failing on a table it cannot see.
      assert.equal(result.invalidated.installTokens, 0);

      const live = await restoredPool.query<{ count: string }>(
        "select count(*)::text as count from viewer_sessions where revoked_at is null",
      );
      assert.equal(live.rows[0]?.count, "0", "a session issued for the old host survived");
      // The column that does not exist at this schema was not written, and the
      // one that does was.
      const columns = await restoredPool.query<{ count: string }>(
        `select count(*)::text as count from information_schema.columns
          where table_schema = 'public' and table_name = 'viewer_sessions'
            and column_name = 'revocation_reason'`,
      );
      assert.equal(columns.rows[0]?.count, "0");

      const events = await restoredPool.query<{ payload: Record<string, unknown> }>(
        "select payload from events where type = $1",
        [BACKUP_RESTORED_EVENT],
      );
      assert.equal(events.rows[0]?.payload["hostname_changed"], true);
    } finally {
      await restoredPool.end().catch(() => undefined);
      await restored.stop();
      await source.pool.end().catch(() => undefined);
      await source.database.stop();
    }
  });

  /**
   * A failed restore must leave the database as it found it — **including the
   * things an empty-installation check cannot see**.
   *
   * The check counts base tables in `public`. A database with no base tables
   * can still hold a view, a function, a sequence, a type and an extension, and
   * managed PostgreSQL commonly pre-installs extensions there;
   * `docs/DEPLOYMENT.md` §11 supports an operator-managed external database. An
   * earlier fix migrated first and then ran `drop schema public cascade` on
   * failure, guarded by that table count, and destroyed all five.
   *
   * They survive now because nothing is dropped: the migrations run inside the
   * restore's transaction and a rollback undoes them.
   */
  test("a failure leaves objects the emptiness check cannot see untouched", async () => {
    const places = await scratch();
    const source = await oldInstallation();
    const restored = await startPostgres();
    const restoredPool = createPool(restored.url);
    try {
      // A database with no base table, and a great deal to lose.
      await restoredPool.query("create extension if not exists pgcrypto");
      await restoredPool.query("create sequence tenancy_counter");
      await restoredPool.query("create type tenancy_kind as enum ('internal', 'external')");
      await restoredPool.query("create view tenancy_report as select 1 as one");
      await restoredPool.query(
        "create function tenancy_answer() returns integer language sql as $$ select 42 $$",
      );
      const inventory = async (): Promise<Record<string, string | undefined>> => {
        const { rows } = await restoredPool.query<Record<string, string>>(
          `select (select count(*)::text from information_schema.tables
                    where table_schema = 'public' and table_type = 'BASE TABLE') as base_tables,
                  (select count(*)::text from information_schema.views where table_schema = 'public') as views,
                  (select count(*)::text from information_schema.sequences where sequence_schema = 'public') as sequences,
                  (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = 'tenancy_answer') as functions,
                  (select count(*)::text from pg_type t join pg_namespace n on n.oid = t.typnamespace
                    where n.nspname = 'public' and t.typname = 'tenancy_kind') as types,
                  (select count(*)::text from pg_extension where extname = 'pgcrypto') as extensions`,
        );
        return rows[0] ?? {};
      };
      const before = await inventory();
      assert.equal(before["base_tables"], "0", "the emptiness check would not have passed");
      assert.deepEqual(
        [before["views"], before["sequences"], before["functions"], before["types"], before["extensions"]],
        ["1", "1", "1", "1", "1"],
        "the fixture did not create what it meant to",
      );

      await createBackup({
        pool: source.pool,
        output: places.archive,
        mode: "database",
        artefactPath: places.store,
        artefactDriver: "filesystem",
        environment: {},
      });
      const broken = await rebuildArchive(places.archive, (_path, data) => data, {
        editManifest: (manifest) => ({
          ...manifest,
          tables: manifest.tables.map((table) =>
            table.name === "organisations" ? { ...table, rows: table.rows + 5 } : table,
          ),
        }),
      });

      await assert.rejects(() =>
        restoreBackup({
          pool: restoredPool,
          archive: broken,
          artefactPath: places.restoreStore,
        }),
      );

      assert.deepEqual(await inventory(), before, "a failed restore changed the database");
    } finally {
      await restoredPool.end().catch(() => undefined);
      await restored.stop();
      await source.pool.end().catch(() => undefined);
      await source.database.stop();
    }
  });

  /**
   * The wedge the post-commit phase created: a failure after the load left the
   * data committed, so the operator's retry was refused with "the target
   * installation already has N table(s)" and there was no way forward.
   */
  test("a failure leaves the installation restorable again", async () => {
    const places = await scratch();
    const source = await oldInstallation();
    const restored = await startPostgres();
    const restoredPool = createPool(restored.url);
    try {
      await createBackup({
        pool: source.pool,
        output: places.archive,
        mode: "database",
        artefactPath: places.store,
        artefactDriver: "filesystem",
        environment: {},
      });
      // An archive that loads and then fails its row-count check, which is the
      // last thing the load transaction does before the post-load steps.
      const broken = await rebuildArchive(places.archive, (_path, data) => data, {
        editManifest: (manifest) => ({
          ...manifest,
          tables: manifest.tables.map((table) =>
            table.name === "organisations" ? { ...table, rows: table.rows + 5 } : table,
          ),
        }),
      });

      await assert.rejects(() =>
        restoreBackup({
          pool: restoredPool,
          archive: broken,
          artefactPath: places.restoreStore,
        }),
      );
      // The load rolled back *and* the schema the restore itself created was
      // removed with it, so the target is back to the state the command found
      // it in. A rollback alone was not enough: the migrations run outside the
      // transaction, and a surviving schema is what made the next attempt fail
      // the empty-installation check and left the operator stuck.
      const tables = await restoredPool.query<{ count: string }>(
        "select count(*)::text as count from information_schema.tables where table_schema = 'public'",
      );
      assert.equal(tables.rows[0]?.count, "0", "a failed restore left a schema behind");

      // And the retry works, which is the property that matters.
      const retry = await restoreBackup({
        pool: restoredPool,
        archive: places.archive,
        artefactPath: places.restoreStore,
      });
      assert.equal(retry.applied, true);
      const after = await restoredPool.query<{ count: string }>(
        "select count(*)::text as count from organisations",
      );
      assert.equal(after.rows[0]?.count, "1");
    } finally {
      await restoredPool.end().catch(() => undefined);
      await restored.stop();
      await source.pool.end().catch(() => undefined);
      await source.database.stop();
    }
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
