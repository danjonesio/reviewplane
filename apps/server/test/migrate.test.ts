/**
 * The migration runner, against a real database.
 *
 * `docs/DEVELOPMENT.md` section 7 wants migrations that are forward-only,
 * transactional and applied once. Each of those is a property of this runner
 * rather than of any individual migration, so each is asserted here.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import {
  MIGRATION_LOCK_KEY,
  MIGRATIONS_DIRECTORY,
  MigrationLockUnavailableError,
  NON_TRANSACTIONAL_STATEMENTS,
  listMigrations,
  migrate,
  migrateInTransaction,
  migrationDeclarations,
  migrationReport,
  migrationState,
  parseDowngradeDeclaration,
} from "../src/db/migrate.ts";
import { createPool } from "../src/db/pool.ts";
import type { Pool } from "../src/db/pool.ts";
import { startPostgres } from "./support/postgres.ts";
import type { TestDatabase } from "./support/postgres.ts";

describe("the migration runner", () => {
  let postgres: TestDatabase;
  let pool: Pool;

  before(async () => {
    postgres = await startPostgres();
    pool = createPool(postgres.url);
  });

  after(async () => {
    await pool.end();
    await postgres.stop();
  });

  test("committed migrations apply once and are then reported as applied", async () => {
    const first = await migrate(pool);
    assert.ok(first.applied.length > 0, "no migration was applied");
    assert.deepEqual([...first.applied].sort(), first.applied, "migrations ran out of order");

    const second = await migrate(pool);
    assert.deepEqual(second.applied, [], "a migration was applied twice");
    assert.deepEqual(second.alreadyApplied, first.applied);
  });

  test("every migration is numbered, named and unique", async () => {
    // Lexical order is the apply order, so the runner refuses a name that does
    // not carry a zero-padded number, and two files may not claim one position.
    const files = await listMigrations(MIGRATIONS_DIRECTORY);
    for (const file of files) {
      assert.match(file, /^[0-9]{4}_[a-z0-9_]+\.sql$/u, `${file} is not a migration name`);
    }
    const numbers = files.map((file) => file.slice(0, 4));
    assert.equal(new Set(numbers).size, numbers.length, `two migrations share a number: ${files.join(", ")}`);
  });

  test("the committed migrations create the tables the server depends on", async () => {
    await migrate(pool);
    const result = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const tables = new Set(result.rows.map((row) => row.table_name));
    for (const required of [
      "schema_migrations",
      "organisations",
      "projects",
      "connectors",
      "published_services",
      "route_capabilities",
      "events",
      "event_streams",
    ]) {
      assert.ok(tables.has(required), `the migrations did not create ${required}`);
    }
  });

  test("a failing migration leaves neither a partial schema nor a claim of success", async () => {
    const directory = mkdtempSync(join(tmpdir(), "reviewplane-migrations-"));
    writeFileSync(
      join(directory, "9001_creates_a_table.sql"),
      "CREATE TABLE migration_probe (id text PRIMARY KEY);",
    );
    writeFileSync(
      join(directory, "9002_is_not_valid_sql.sql"),
      "CREATE TABLE migration_probe_two (id text PRIMARY KEY); SELECT this_function_does_not_exist();",
    );

    await assert.rejects(migrate(pool, directory), /9002_is_not_valid_sql\.sql failed/u);

    const client = await pool.connect();
    try {
      const applied = await client.query<{ filename: string }>(
        `SELECT filename FROM schema_migrations WHERE filename LIKE '900%'`,
      );
      assert.deepEqual(
        applied.rows.map((row) => row.filename),
        ["9001_creates_a_table.sql"],
        "a failed migration was recorded as applied",
      );

      const tables = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name LIKE 'migration_probe%'`,
      );
      assert.deepEqual(
        tables.rows.map((row) => row.table_name),
        ["migration_probe"],
        "the failed migration left part of its schema behind",
      );
    } finally {
      await client.query(`DROP TABLE IF EXISTS migration_probe`);
      await client.query(`DELETE FROM schema_migrations WHERE filename LIKE '900%'`);
      client.release();
    }
  });

  test("a migration whose name is not numbered is refused", async () => {
    const directory = mkdtempSync(join(tmpdir(), "reviewplane-migrations-"));
    writeFileSync(join(directory, "add-a-table.sql"), "SELECT 1;");
    await assert.rejects(migrate(pool, directory), /NNNN_lower_snake_case\.sql/u);
  });

  test("concurrent starts do not race", async () => {
    // Several replicas booting at once must not both try to apply the same
    // file: the advisory lock serialises them.
    const results = await Promise.all([migrate(pool), migrate(pool), migrate(pool)]);
    const appliedTwice = results.flatMap((result) => result.applied);
    assert.deepEqual(appliedTwice, [], "a migration was applied by a concurrent start");
  });

  /**
   * `docs/DEPLOYMENT.md` section 15: "Database migrations must state whether
   * downgrade is supported."
   *
   * The requirement is on every migration, so it is asserted over every
   * migration rather than over the runner's ability to read one. A new file
   * that omits the line fails here, which is the only thing that keeps the
   * statement from rotting: the runner's default reading is
   * `not_supported`, and a default is not a statement.
   */
  test("every committed migration states whether downgrade is supported", async () => {
    const declarations = await migrationDeclarations();
    assert.ok(declarations.length > 0, "no migration was found");
    const silent = declarations.filter((entry) => !entry.declared).map((entry) => entry.filename);
    assert.deepEqual(
      silent,
      [],
      `these migrations declare no downgrade support; add a "-- downgrade: not supported (reason)" line`,
    );
    for (const entry of declarations) {
      assert.ok(
        entry.downgrade === "supported" || entry.downgrade === "not_supported",
        `${entry.filename} declares ${entry.downgrade}`,
      );
    }
  });

  /**
   * `reviewplane restore` applies migrations inside its load transaction, so
   * that a failed restore rolls the schema back with the rows and nothing has
   * to be dropped by hand. That only holds while every migration is
   * transactional.
   *
   * The rule is asserted over the files rather than remembered, because the
   * consequence of breaking it is not a failing migration — it is a restore
   * that cannot roll back cleanly, discovered by whoever needed the rollback.
   */
  test("no migration contains a statement that cannot run in a transaction", async () => {
    const directory = MIGRATIONS_DIRECTORY;
    const offenders: string[] = [];
    for (const file of await listMigrations(directory)) {
      const sql = await readFile(join(directory, file), "utf8");
      // Comments are stripped first: several migrations discuss indexes and
      // extensions in prose, and a scan that reported what a file says rather
      // than what it does would be noise.
      const statements = sql
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n");
      for (const pattern of NON_TRANSACTIONAL_STATEMENTS) {
        if (pattern.test(statements)) offenders.push(`${file}: ${pattern.source}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "these migrations cannot run inside a transaction, which reviewplane restore requires",
    );
  });

  test("migrations applied in a caller's transaction disappear when it rolls back", async () => {
    // The property `restore` depends on, asserted directly: PostgreSQL rolls
    // back DDL, so a rolled-back migration leaves no table behind and there is
    // nothing for a restore to clean up.
    const isolated = await startPostgres();
    const isolatedPool = createPool(isolated.url);
    const client = await isolatedPool.connect();
    try {
      await client.query("begin");
      const result = await migrateInTransaction(client, MIGRATIONS_DIRECTORY, {
        through: "0002_organisations_and_projects.sql",
      });
      assert.deepEqual(result.applied, [
        "0001_events.sql",
        "0002_organisations_and_projects.sql",
      ]);
      const inside = await client.query<{ count: string }>(
        "select count(*)::text as count from information_schema.tables where table_schema = 'public'",
      );
      assert.ok(Number(inside.rows[0]?.count) > 0, "the migrations created nothing");

      await client.query("rollback");
      const after = await client.query<{ count: string }>(
        "select count(*)::text as count from information_schema.tables where table_schema = 'public'",
      );
      assert.equal(after.rows[0]?.count, "0", "a rolled-back migration left a table behind");
    } finally {
      client.release();
      await isolatedPool.end();
      await isolated.stop();
    }
  });

  test("a migration that declares nothing is read as not supported", () => {
    const silent = parseDowngradeDeclaration("0001_x.sql", "-- a comment\nSELECT 1;");
    assert.equal(silent.downgrade, "not_supported");
    assert.equal(silent.declared, false);

    const stated = parseDowngradeDeclaration(
      "0002_x.sql",
      "-- downgrade: supported (drops the column it added)\nSELECT 1;",
    );
    assert.equal(stated.downgrade, "supported");
    assert.equal(stated.declared, true);
    assert.equal(stated.note, "drops the column it added");
  });

  test("the migration report carries the downgrade declaration of every file", async () => {
    await migrate(pool);
    const report = await migrationReport(pool);
    assert.equal(report.pending.length, 0);
    assert.ok(report.applied.length > 0);
    assert.equal(report.schema_version, report.applied[report.applied.length - 1]?.filename);
    for (const record of report.applied) {
      assert.ok(record.downgrade === "supported" || record.downgrade === "not_supported");
    }
  });

  /**
   * A restore brings an empty installation to the archive's schema version and
   * no further, because loading rows into a schema a later migration has
   * already reshaped is the upgrade happening in the wrong order.
   */
  test("migrate --through stops at the migration it names", async () => {
    const isolated = await startPostgres();
    const isolatedPool = createPool(isolated.url);
    try {
      const files = await listMigrations();
      const target = files[2] as string;
      const result = await migrate(isolatedPool, MIGRATIONS_DIRECTORY, { through: target });
      assert.deepEqual(result.applied, files.slice(0, 3));

      const state = await migrationState(isolatedPool);
      assert.equal(state.schemaVersion, target);
      assert.equal(state.pending.length, files.length - 3);

      await assert.rejects(
        migrate(isolatedPool, MIGRATIONS_DIRECTORY, { through: "9999_not_a_migration.sql" }),
        /has no migration/u,
      );
    } finally {
      await isolatedPool.end();
      await isolated.stop();
    }
  });

  /**
   * The migration-lock preflight of `docs/OPERATIONS.md` section 12: a second
   * migration must be told why it cannot start rather than waiting silently.
   */
  test("a migration lock held by another process is reported, not waited on", async () => {
    const isolated = await startPostgres();
    const isolatedPool = createPool(isolated.url);
    const holder = createPool(isolated.url);
    const client = await holder.connect();
    try {
      await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
      await assert.rejects(
        migrate(isolatedPool, MIGRATIONS_DIRECTORY, { noWait: true }),
        MigrationLockUnavailableError,
      );
      // Nothing was applied while the lock was held.
      const state = await migrationState(isolatedPool);
      assert.equal(state.applied.length, 0);
    } finally {
      client.release();
      await holder.end();
      await isolatedPool.end();
      await isolated.stop();
    }
  });
});
