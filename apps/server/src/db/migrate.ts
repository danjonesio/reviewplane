/**
 * Minimal forward-only migration runner (`docs/DEVELOPMENT.md` section 7).
 *
 * Files in `migrations/` are applied in lexical order, once each, and the
 * filename is recorded in `schema_migrations`. Each file runs inside its own
 * transaction, so a failure leaves the database on the last complete
 * migration rather than half-way through one.
 *
 * There is no down-migration: forward-only is the documented default, and a
 * reversible step that has never been exercised is worse than none.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Pool } from "pg";

const MIGRATION_PATTERN = /^[0-9]{4}_[a-z0-9_]+\.sql$/u;

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

async function ensureRegistry(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/** Migration filenames, validated and in the order they must be applied. */
export async function listMigrations(directory: string): Promise<string[]> {
  const entries = await readdir(directory);
  const files = entries.filter((entry) => entry.endsWith(".sql")).sort();
  for (const file of files) {
    if (!MIGRATION_PATTERN.test(file)) {
      throw new Error(
        `migration ${file} must be named NNNN_lower_snake_case.sql so ordering is unambiguous`,
      );
    }
  }
  return files;
}

export async function migrate(pool: Pool, directory: string): Promise<MigrationResult> {
  await ensureRegistry(pool);
  const files = await listMigrations(directory);

  const existing = await pool.query<{ filename: string }>(
    "SELECT filename FROM schema_migrations",
  );
  const alreadyApplied = new Set(existing.rows.map((row) => row.filename));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (alreadyApplied.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = await readFile(join(directory, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied.push(file);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error(`migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
}
