/**
 * The migration runner (`docs/DEVELOPMENT.md` section 7): forward-only, once
 * each, recorded by filename, transactional per file.
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { listMigrations, migrate } from "../src/db/migrate.ts";
import { MIGRATIONS_DIRECTORY, startPostgres, type DisposablePostgres } from "./helpers/postgres.ts";

let postgres: DisposablePostgres;

before(async () => {
  postgres = await startPostgres();
});

after(async () => {
  await postgres?.stop();
});

test("migrations are applied once and recorded by filename", async () => {
  // The helper already migrated, so a second run applies nothing.
  const second = await migrate(postgres.pool, MIGRATIONS_DIRECTORY);
  assert.deepEqual(second.applied, []);
  assert.ok(second.skipped.length >= 5);

  const recorded = await postgres.pool.query<{ filename: string }>(
    "SELECT filename FROM schema_migrations ORDER BY filename",
  );
  assert.deepEqual(
    recorded.rows.map((row) => row.filename),
    await listMigrations(MIGRATIONS_DIRECTORY),
  );
});

test("migration filenames are ordered by number and rejected when malformed", async () => {
  const files = await listMigrations(MIGRATIONS_DIRECTORY);
  assert.deepEqual(files, [...files].sort());
  for (const file of files) assert.match(file, /^[0-9]{4}_[a-z0-9_]+\.sql$/u);

  const directory = await mkdtemp(join(tmpdir(), "reviewplane-migrations-"));
  await writeFile(join(directory, "AddThings.sql"), "SELECT 1", "utf8");
  await assert.rejects(() => listMigrations(directory), /must be named/u);
});

test("a failing migration leaves the database on the last complete one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reviewplane-migrations-"));
  await writeFile(join(directory, "9990_good.sql"), "CREATE TABLE migrate_probe (id int)", "utf8");
  await writeFile(join(directory, "9991_broken.sql"), "CREATE TABLE (", "utf8");

  await assert.rejects(() => migrate(postgres.pool, directory), /9991_broken\.sql failed/u);

  const probe = await postgres.pool.query(
    "SELECT to_regclass('migrate_probe') IS NOT NULL AS present",
  );
  assert.equal((probe.rows[0] as { present: boolean }).present, true);
  const recorded = await postgres.pool.query(
    "SELECT filename FROM schema_migrations WHERE filename = '9991_broken.sql'",
  );
  assert.equal(recorded.rows.length, 0);
  await postgres.pool.query("DROP TABLE migrate_probe");
  await postgres.pool.query("DELETE FROM schema_migrations WHERE filename = '9990_good.sql'");
});
