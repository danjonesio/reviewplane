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

import type {
  MigrationDowngrade,
  MigrationRecord,
  MigrationState as MigrationReport,
} from "@reviewplane/protocol/platform";

import type { Pool, PoolClient } from "./pool.ts";

/**
 * Lock key for the migration advisory lock. Any stable value works.
 *
 * Exported because the upgrade preflight of `docs/OPERATIONS.md` §12 has to
 * test the availability of *this* lock. A second copy of the number in the
 * preflight would be a preflight that reported a free lock while the runner
 * waited on a held one.
 */
export const MIGRATION_LOCK_KEY = 0x52564d47; // "RVMG"

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
  pool: Pool | PoolClient,
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

/**
 * The declaration `docs/DEPLOYMENT.md` §15 requires of every migration:
 * "Database migrations must state whether downgrade is supported."
 *
 * It is a comment line in the migration itself —
 * `-- downgrade: not supported (reason)` — rather than a table somewhere else,
 * because the statement has to travel with the statements it describes. A
 * registry in another file is a registry that goes stale on the first branch
 * that forgets it.
 *
 * A file that declares nothing is reported as `not_supported`, which is the
 * repository default (`docs/DEVELOPMENT.md` §7) and the safe reading: nothing
 * in Stage 1 implements automated downgrade, so the only rollback is restoring
 * the backup taken before the upgrade. `apps/server/test/migrate.test.ts`
 * requires every committed migration to declare it explicitly, so the default
 * is a safety net rather than a way to skip the statement.
 */
export interface MigrationDeclaration {
  readonly filename: string;
  readonly downgrade: MigrationDowngrade;
  readonly note: string | undefined;
  /** Whether the file itself said so, rather than the default being applied. */
  readonly declared: boolean;
}

const DOWNGRADE_LINE = /^--[ \t]*downgrade:[ \t]*(supported|not supported)[ \t]*(.*)$/imu;

/** Parses one migration's downgrade declaration from its source. */
export function parseDowngradeDeclaration(filename: string, sql: string): MigrationDeclaration {
  const match = DOWNGRADE_LINE.exec(sql);
  if (match === null) {
    return {
      filename,
      downgrade: "not_supported",
      note: "the migration declares nothing; the repository default is forward-only",
      declared: false,
    };
  }
  const note = (match[2] ?? "").trim().replace(/^\((.*)\)$/su, "$1").trim();
  return {
    filename,
    downgrade: match[1]?.toLowerCase() === "supported" ? "supported" : "not_supported",
    note: note === "" ? undefined : note,
    declared: true,
  };
}

/** Every migration's declaration, keyed by file name, in apply order. */
export async function migrationDeclarations(
  directory = MIGRATIONS_DIRECTORY,
): Promise<MigrationDeclaration[]> {
  const files = await listMigrations(directory);
  const declarations: MigrationDeclaration[] = [];
  for (const file of files) {
    declarations.push(
      parseDowngradeDeclaration(file, await readFile(join(directory, file), "utf8")),
    );
  }
  return declarations;
}

/**
 * The migration state in the shape `packages/protocol` defines
 * (`MigrationState`), which is what `reviewplane migrate --status --json`
 * prints and what the upgrade preflight reads.
 *
 * It carries the downgrade declaration of every migration, applied and pending,
 * so an operator planning an upgrade can see before running it that the
 * migrations about to be applied cannot be undone.
 */
export async function migrationReport(
  pool: Pool | PoolClient,
  directory = MIGRATIONS_DIRECTORY,
): Promise<MigrationReport> {
  const state = await migrationState(pool, directory);
  const declarations = new Map(
    (await migrationDeclarations(directory)).map((entry) => [entry.filename, entry]),
  );
  const record = (filename: string): MigrationRecord => {
    const declaration = declarations.get(filename);
    return {
      filename,
      downgrade: declaration?.downgrade ?? "not_supported",
      ...(declaration?.note === undefined ? {} : { note: declaration.note }),
    };
  };
  return {
    ...(state.schemaVersion === null ? {} : { schema_version: state.schemaVersion }),
    applied: state.applied.map(record),
    pending: state.pending.map(record),
  };
}

export interface MigrateOptions {
  /**
   * Stop after this migration instead of applying every pending one.
   *
   * A restore uses it: an archive records the schema version its rows were
   * written against, and the restore brings an empty installation to exactly
   * that version before loading them. Running past it first would load rows
   * into a schema a later migration had already reshaped, which is the upgrade
   * happening in the wrong order.
   */
  readonly through?: string;
  /**
   * Refuse to wait for the migration lock, and report it instead.
   *
   * The upgrade preflight of `docs/OPERATIONS.md` §12 has to answer "is the
   * migration lock available" without becoming the process that holds it.
   */
  readonly noWait?: boolean;
}

/** Thrown when `noWait` was asked for and another process holds the lock. */
export class MigrationLockUnavailableError extends Error {}

/** The files `through` selects, refusing a name this build does not have. */
function filesThrough(all: readonly string[], through: string | undefined): readonly string[] {
  if (through === undefined) return all;
  if (!all.includes(through)) {
    throw new Error(
      `this build has no migration ${through}, so it cannot bring a database to that schema version`,
    );
  }
  return all.slice(0, all.indexOf(through) + 1);
}

/** The table the runner keeps its own record in. Created on first use. */
const SCHEMA_MIGRATIONS_DDL = `create table if not exists schema_migrations (
   filename    text        primary key,
   applied_at  timestamptz not null default now()
 )`;

/**
 * Applies pending migrations **on the caller's client, inside the caller's
 * transaction**, committing nothing.
 *
 * `reviewplane restore` uses it, and the reason is worth stating because it is
 * the difference between a safe restore and a destructive one. PostgreSQL has
 * transactional DDL: a `CREATE TABLE` that is rolled back leaves no table. So a
 * restore that creates its schema inside the same transaction as its load has
 * nothing to undo when it fails — the schema, the rows and the audit event all
 * disappear together and the database is exactly as the command found it.
 *
 * The alternative, which this replaced, was to migrate first and then remove
 * the schema by hand if the load failed. That meant `drop schema public
 * cascade` existing in the product, guarded by a check that counted **base
 * tables** — so a database holding a view, a function, a sequence or an
 * extension in `public` (which managed PostgreSQL commonly pre-installs, and
 * `docs/DEPLOYMENT.md` §11 supports) passed the guard and lost them. A rollback
 * cannot make that mistake, because it undoes what this transaction did and
 * nothing else.
 *
 * Every committed migration is transactional: none uses `CREATE INDEX
 * CONCURRENTLY`, `VACUUM`, `CREATE DATABASE` or `CREATE EXTENSION`, and
 * `apps/server/test/migrate.test.ts` asserts that, so a migration that could
 * not run this way cannot land unnoticed.
 *
 * The advisory lock is taken for the **transaction**, so it is released by the
 * commit or the rollback rather than needing a matching unlock.
 */
export async function migrateInTransaction(
  client: PoolClient,
  directory = MIGRATIONS_DIRECTORY,
  options: { readonly through?: string } = {},
): Promise<MigrationResult> {
  const files = filesThrough(await listMigrations(directory), options.through);
  await client.query(SCHEMA_MIGRATIONS_DDL);
  await client.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
  const existing = await client.query<{ filename: string }>("select filename from schema_migrations");
  const done = new Set(existing.rows.map((row) => row.filename));
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  for (const file of files) {
    if (done.has(file)) {
      alreadyApplied.push(file);
      continue;
    }
    const sql = await readFile(join(directory, file), "utf8");
    try {
      await client.query(sql);
      await client.query("insert into schema_migrations (filename) values ($1)", [file]);
    } catch (error) {
      // No rollback here: the caller owns the transaction, and rolling it back
      // would discard work this function did not do.
      throw new Error(`migration ${file} failed: ${String(error)}`, { cause: error });
    }
    applied.push(file);
  }
  return { applied, alreadyApplied };
}

/**
 * Statements no migration may contain, because they cannot run inside a
 * transaction — and {@link migrateInTransaction} runs every migration inside
 * one.
 *
 * Adding one of these to a migration would make a restore impossible to roll
 * back safely, which is why the rule is asserted over the files rather than
 * remembered.
 */
export const NON_TRANSACTIONAL_STATEMENTS: readonly RegExp[] = [
  /\bconcurrently\b/iu,
  /\bvacuum\b/iu,
  /\bcreate\s+database\b/iu,
  /\bcreate\s+tablespace\b/iu,
  /\balter\s+system\b/iu,
  /\bcreate\s+extension\b/iu,
];

export async function migrate(
  pool: Pool,
  directory = MIGRATIONS_DIRECTORY,
  options: MigrateOptions = {},
): Promise<MigrationResult> {
  const files = filesThrough(await listMigrations(directory), options.through);
  const client = await pool.connect();
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  try {
    await client.query(SCHEMA_MIGRATIONS_DDL);
    if (options.noWait === true) {
      const taken = await client.query<{ locked: boolean }>(
        "select pg_try_advisory_lock($1) as locked",
        [MIGRATION_LOCK_KEY],
      );
      if (taken.rows[0]?.locked !== true) {
        throw new MigrationLockUnavailableError(
          "another process holds the migration lock; no concurrent migration was started",
        );
      }
    } else {
      await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    }
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
