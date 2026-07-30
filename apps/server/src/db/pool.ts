/** PostgreSQL pool plus a helper that keeps a command and its event atomic. */

import { Pool, type PoolClient } from "pg";

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 10 });
}

/**
 * Runs `work` inside one transaction. `docs/EVENTS.md` section 9 requires a
 * state change and its event to commit together, and `docs/ARCHITECTURE.md`
 * section 5.1 requires multi-step commands to be atomic where practical.
 */
export async function inTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
