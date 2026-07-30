/**
 * PostgreSQL access.
 *
 * `docs/ARCHITECTURE.md` §5.1 makes PostgreSQL authoritative for connectors,
 * environments, published services, sessions and events, and requires
 * multi-step commands to write state and events atomically. `docs/EVENTS.md` §9
 * requires a domain command's state change and its event to commit together, so
 * the pool exposes a transaction helper rather than leaving each caller to
 * remember `BEGIN`.
 */

import pg from "pg";

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(databaseUrl: string): Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  // An idle client that the server drops — a database restart, a failover, an
  // administrator terminating a backend — emits `error` on the pool, and an
  // unhandled `error` on an EventEmitter terminates the process. Losing the
  // control plane because PostgreSQL restarted is the opposite of
  // `docs/ARCHITECTURE.md` section 14, which asks for state-changing actions to
  // be rejected safely and for the process to recover. The pool discards the
  // broken client itself; this handler only stops the default from firing.
  pool.on("error", () => undefined);
  return pool;
}

/**
 * Runs `work` inside one transaction, so that a domain change and its event
 * commit together (`docs/EVENTS.md` §9).
 */
export async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
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
