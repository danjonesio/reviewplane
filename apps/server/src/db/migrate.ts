/**
 * The migration runner.
 *
 * `docs/DEVELOPMENT.md` section 7 wants migrations that are forward-only,
 * transactional where supported, versioned and reviewable. Plain SQL files
 * applied in lexical order are all of those, and they stay reviewable in a way
 * a generated migration is not.
 *
 * Each file is applied once inside a transaction, together with the row that
 * records it, so a failed migration leaves neither a half-applied schema nor a
 * claim that it succeeded. An advisory lock serialises concurrent starts, so
 * several replicas booting at once do not race.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { PoolClient } from "pg";

/** Lock identifier for the migration advisory lock. Arbitrary but fixed. */
const MIGRATION_LOCK_ID = 0x5265_7601;

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

/** Lists the migration files in the order they must be applied. */
export function migrationFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/**
 * Applies every migration in `directory` that has not been applied yet.
 *
 * Ordering is lexical, which is why the file names carry a zero-padded number.
 * Concurrent branches are given disjoint number ranges so that two migrations
 * written at the same time cannot claim the same position.
 */
export async function migrate(client: PoolClient, directory: string): Promise<MigrationResult> {
  await client.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_LOCK_ID]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    text        PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    const existing = await client.query<{ filename: string }>(
      `SELECT filename FROM schema_migrations`,
    );
    const applied = new Set(existing.rows.map((row) => row.filename));

    const newlyApplied: string[] = [];
    const alreadyApplied: string[] = [];
    for (const filename of migrationFiles(directory)) {
      if (applied.has(filename)) {
        alreadyApplied.push(filename);
        continue;
      }
      const sql = readFileSync(join(directory, filename), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [filename]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`migrate: ${filename} failed: ${String(error)}`, { cause: error });
      }
      newlyApplied.push(filename);
    }
    return { applied: newlyApplied, alreadyApplied };
  } finally {
    await client.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_LOCK_ID]);
  }
}
