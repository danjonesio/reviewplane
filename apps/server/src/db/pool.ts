/**
 * The PostgreSQL connection pool and the migration entry point.
 *
 * PostgreSQL is the authoritative store (`docs/ARCHITECTURE.md` section 5.1),
 * and `docs/EVENTS.md` section 9 requires a domain command's state change and
 * its event to commit together, so the pool exposes a transaction helper rather
 * than leaving each caller to remember `BEGIN`.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { migrate } from "./migrate.ts";
import type { MigrationResult } from "./migrate.ts";

export type Database = pg.Pool;
export type DatabaseClient = pg.PoolClient;

/** The committed migrations directory. */
export const MIGRATIONS_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
);

export function createPool(databaseUrl: string): Database {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

/** Applies pending migrations on one pooled connection. */
export async function migrateDatabase(pool: Database): Promise<MigrationResult> {
  const client = await pool.connect();
  try {
    return await migrate(client, MIGRATIONS_DIRECTORY);
  } finally {
    client.release();
  }
}

/**
 * Runs `work` in a transaction, committing on success and rolling back on any
 * failure. State and event rows written inside it commit atomically, which is
 * what `docs/EVENTS.md` section 9 asks for.
 */
export async function inTransaction<T>(
  pool: Database,
  work: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
