/**
 * The migration runner, against a real database.
 *
 * `docs/DEVELOPMENT.md` section 7 wants migrations that are forward-only,
 * transactional and applied once. Each of those is a property of this runner
 * rather than of any individual migration, so each is asserted here.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { MIGRATIONS_DIRECTORY, listMigrations, migrate } from "../src/db/migrate.ts";
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
});
