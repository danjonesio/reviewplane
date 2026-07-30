/**
 * A minimal forward-only migration runner (`docs/DEVELOPMENT.md` §7).
 *
 * Migrations are plain SQL files in `apps/server/migrations`, applied in
 * lexical order, each inside its own transaction, each recorded by file name in
 * `schema_migrations` so that it runs exactly once. Plain SQL stays reviewable
 * in a way a generated migration is not, and there is no down migration:
 * forward-only is the documented default, and a reversible step that has never
 * been exercised is worse than none.
 *
 * A PostgreSQL advisory lock serialises concurrent starts, so that two server
 * processes coming up together cannot apply the same file twice.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Pool } from "./pool.ts";

/** Lock key for the migration advisory lock. Any stable value works. */
const MIGRATION_LOCK_KEY = 0x52564d47; // "RVMG"

/**
 * File names must be `NNNN_lower_snake_case.sql` so that lexical order is the
 * apply order and two migrations written on different branches cannot claim an
 * ambiguous position.
 */
const MIGRATION_PATTERN = /^[0-9]{4}_[a-z0-9_]+\.sql$/u;

export const MIGRATIONS_DIRECTORY = join(import.meta.dirname, "..", "..", "migrations");

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

/** Migration file names, validated, in the order they must be applied. */
export async function listMigrations(directory: string = MIGRATIONS_DIRECTORY): Promise<string[]> {
  const entries = await readdir(directory);
  const files = entries
    .filter((name) => name.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));
  for (const file of files) {
    if (!MIGRATION_PATTERN.test(file)) {
      throw new Error(
        `migration ${file} must be named NNNN_lower_snake_case.sql so ordering is unambiguous`,
      );
    }
  }
  return files;
}

/** The migration-state table, and the schema version it reports. */
export interface MigrationState {
  /** Files on disk that this database has not applied, in apply order. */
  readonly pending: readonly string[];
  /** Files this database has applied. */
  readonly applied: readonly string[];
  /**
   * The highest applied migration's file name, or `null` for an empty database.
   * It is the "schema version" `docs/DEPLOYMENT.md` §11 asks a migration command
   * to report: a file name rather than a number, because the file name is what
   * an operator finds in the repository.
   */
  readonly schemaVersion: string | null;
}

/**
 * Reads the migration state without changing it.
 *
 * `docs/DEPLOYMENT.md` §11 requires readiness to fail when required migrations
 * are missing, and `docs/OPERATIONS.md` §2 names that as the example of an API
 * that is not ready. So readiness asks this question rather than asking whether
 * a connection can be opened: a process serving requests against a schema older
 * than its code is exactly the state readiness exists to keep traffic away from.
 *
 * An absent `schema_migrations` table is a database nobody has migrated, not an
 * error: every file is pending.
 */
export async function migrationState(
  pool: Pool,
  directory = MIGRATIONS_DIRECTORY,
): Promise<MigrationState> {
  const files = await listMigrations(directory);
  const table = await pool.query<{ present: boolean }>(
    "select to_regclass('schema_migrations') is not null as present",
  );
  const done = new Set<string>();
  if (table.rows[0]?.present === true) {
    const existing = await pool.query<{ filename: string }>(
      "select filename from schema_migrations",
    );
    for (const row of existing.rows) done.add(row.filename);
  }
  const applied = files.filter((file) => done.has(file));
  const pending = files.filter((file) => !done.has(file));
  return {
    pending,
    applied,
    schemaVersion: applied.length === 0 ? null : (applied[applied.length - 1] as string),
  };
}

export async function migrate(pool: Pool, directory = MIGRATIONS_DIRECTORY): Promise<MigrationResult> {
  const files = await listMigrations(directory);
  const client = await pool.connect();
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  try {
    await client.query(
      `create table if not exists schema_migrations (
         filename    text        primary key,
         applied_at  timestamptz not null default now()
       )`,
    );
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      const existing = await client.query<{ filename: string }>("select filename from schema_migrations");
      const done = new Set(existing.rows.map((row) => row.filename));
      for (const file of files) {
        if (done.has(file)) {
          alreadyApplied.push(file);
          continue;
        }
        const sql = await readFile(join(directory, file), "utf8");
        await client.query("begin");
        try {
          await client.query(sql);
          await client.query("insert into schema_migrations (filename) values ($1)", [file]);
          await client.query("commit");
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          throw new Error(`migration ${file} failed: ${String(error)}`, { cause: error });
        }
        applied.push(file);
      }
    } finally {
      await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
  return { applied, alreadyApplied };
}
