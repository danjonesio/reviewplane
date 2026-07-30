/**
 * PostgreSQL access. `docs/ARCHITECTURE.md` §5.1 makes PostgreSQL authoritative
 * for connectors, environments and events, and requires multi-step commands to
 * write state and events atomically, which `withTransaction` provides.
 */

import pg from "pg";

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(databaseUrl: string): Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

/**
 * Runs `work` inside one transaction, so that a domain change and its event
 * commit together (`docs/EVENTS.md` §9).
 */
export async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
