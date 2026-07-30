/**
 * A disposable PostgreSQL for the tests that need one.
 *
 * `docs/TESTING.md` "Integration" wants the real database rather than a
 * substitute, and `docs/DEVELOPMENT.md` section 4 already runs data services
 * in containers. One container is started per test process and removed
 * afterwards, and each test file gets its own schema-migrated database so the
 * files do not have to agree about cleanup order.
 *
 * If Docker is unavailable this fails loudly. A silently skipped test that
 * covers artefact verification would be worse than a red run.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { Pool } from "pg";

import { migrate } from "../../src/db/migrate.ts";

const run = promisify(execFile);

export const MIGRATIONS_DIRECTORY = join(import.meta.dirname, "..", "..", "migrations");

const IMAGE = "postgres:17-alpine";
const PASSWORD = "reviewplane-test";

export interface DisposablePostgres {
  readonly url: string;
  readonly pool: Pool;
  stop(): Promise<void>;
}

async function docker(args: readonly string[]): Promise<string> {
  const { stdout } = await run("docker", [...args], { encoding: "utf8" });
  return stdout.trim();
}

/**
 * Waits for a connection that actually completes a query. `pg_isready` reports
 * the temporary server the PostgreSQL entrypoint runs during initialisation,
 * which then restarts and resets any connection made to it.
 */
async function waitForQueries(url: string): Promise<void> {
  const deadline = Date.now() + 90000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    const probe = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 2000 });
    try {
      await probe.query("SELECT 1");
      await probe.end();
      return;
    } catch (error) {
      lastError = error;
      await probe.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(
    `PostgreSQL did not accept queries within 90 seconds: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/**
 * Starts a PostgreSQL container, applies the migrations and returns a pool.
 * The caller must call `stop()`; every test file does so from `after`.
 */
export async function startPostgres(): Promise<DisposablePostgres> {
  try {
    await docker(["version", "--format", "{{.Server.Version}}"]);
  } catch (error) {
    throw new Error(
      `Docker is required for the server test suite (docs/DEVELOPMENT.md section 4): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const name = `reviewplane-test-${randomBytes(6).toString("hex")}`;
  await docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "--env",
    `POSTGRES_PASSWORD=${PASSWORD}`,
    "--publish",
    "127.0.0.1:0:5432",
    IMAGE,
  ]);

  let url: string;
  try {
    const mapping = await docker(["port", name, "5432/tcp"]);
    const port = mapping.split("\n")[0]?.split(":").pop();
    if (port === undefined) throw new Error(`could not read the mapped port from ${mapping}`);
    url = `postgres://postgres:${PASSWORD}@127.0.0.1:${port}/postgres`;
    await waitForQueries(url);
  } catch (error) {
    await docker(["rm", "--force", name]).catch(() => "");
    throw error;
  }

  const pool = new Pool({ connectionString: url, max: 8 });
  try {
    await migrate(pool, MIGRATIONS_DIRECTORY);
  } catch (error) {
    await pool.end().catch(() => undefined);
    await docker(["rm", "--force", name]).catch(() => "");
    throw error;
  }

  return {
    url,
    pool,
    async stop() {
      await pool.end().catch(() => undefined);
      await docker(["rm", "--force", name]).catch(() => "");
    },
  };
}

/** Removes every row the tests create, in dependency order. */
export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(
    "TRUNCATE annotations, findings, reviews, artefact_access_grants, artefacts, control_leases, browser_sessions, browser_worker_projects, browser_workers, events, viewer_sessions, projects, organisations RESTART IDENTITY CASCADE",
  );
}
