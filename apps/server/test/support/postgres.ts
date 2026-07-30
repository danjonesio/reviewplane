/**
 * A disposable PostgreSQL for component and integration tests
 * (`docs/TESTING.md` §2: "API handlers with real database").
 *
 * A real database is the point: the migrations, the constraints and the
 * per-stream event sequence are where several of this server's invariants
 * actually live, and none of them is exercised by a fake.
 *
 * Each caller gets its own container on an ephemeral host port. The container
 * is removed when the caller stops it and again on process exit, so an
 * interrupted run does not leave one behind. Set `REVIEWPLANE_TEST_DATABASE_URL`
 * to run against an existing database instead.
 */

import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { migrate } from "../../src/db/migrate.ts";
import { createPool } from "../../src/db/pool.ts";
import type { Pool } from "../../src/db/pool.ts";

const run = promisify(execFile);

/** The pinned image. `docs/SECURITY.md` §19 requires pinned base images. */
export const POSTGRES_IMAGE = "postgres:18-alpine";

// Every test file that needs a database starts its own, and two of them also
// build and run the Go connector. The suite therefore runs one file at a time
// (`--test-concurrency=1` in package.json); this bound still allows for a slow
// image pull on a first run.
const READINESS_TIMEOUT_MS = 120_000;
const READINESS_POLL_MS = 250;

const liveContainers = new Set<string>();
let exitHookInstalled = false;

/**
 * A killed or crashed test process never reaches its cleanup hook, and a
 * container that outlives its run holds a port and a few hundred megabytes until
 * someone notices. The exit handler must be synchronous, because nothing
 * asynchronous runs after `exit` is emitted.
 */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const name of liveContainers) {
      try {
        execFileSync("docker", ["rm", "--force", "--volumes", name], { stdio: "ignore" });
      } catch {
        // The container is already gone, which is the outcome we wanted.
      }
    }
  });
}

export interface TestDatabase {
  readonly url: string;
  readonly containerName: string;
  stop(): Promise<void>;
}

/** A started database with the migrations applied and a pool open on it. */
export interface MigratedDatabase extends TestDatabase {
  readonly pool: Pool;
}

/**
 * Starts a database, applies every committed migration and opens a pool.
 *
 * Tests that only need somewhere to write use this; tests that build their own
 * pool, or that assert on the runner itself, use {@link startPostgres}.
 */
export async function startMigratedDatabase(): Promise<MigratedDatabase> {
  const database = await startPostgres();
  const pool = createPool(database.url);
  try {
    await migrate(pool);
  } catch (error) {
    await pool.end().catch(() => undefined);
    await database.stop();
    throw error;
  }
  return {
    url: database.url,
    containerName: database.containerName,
    pool,
    async stop(): Promise<void> {
      await pool.end().catch(() => undefined);
      await database.stop();
    },
  };
}

/**
 * Removes every row the tests create.
 *
 * `connector_tls_material` is deliberately left alone: the certificate
 * authority is created once when the app is built, and dropping it between
 * tests would leave the connector module without the identity it already
 * issued from.
 */
export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(
    `TRUNCATE idempotency_keys, jobs, verification_artefacts, verifications, comments,
              annotations, findings, reviews, artefact_access_grants, artefacts,
              control_leases, browser_sessions, browser_worker_projects,
              browser_workers, agent_sessions, agent_credentials, workspaces,
              viewer_sessions, route_capabilities, published_services, connectors,
              connector_enrolment_tokens, environments, event_outbox, events,
              event_streams, users, projects, organisations
     RESTART IDENTITY CASCADE`,
  );
}

async function waitForReadiness(name: string): Promise<void> {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  let lastError = "not started";
  while (Date.now() < deadline) {
    try {
      await run("docker", ["exec", name, "pg_isready", "--username", "postgres", "--dbname", "postgres"]);
      // pg_isready reports the socket, which can accept before the server is
      // finished initialising, so a real query is the readiness signal.
      await run("docker", [
        "exec",
        name,
        "psql",
        "--username",
        "postgres",
        "--dbname",
        "postgres",
        "--command",
        "select 1",
      ]);
      return;
    } catch (error) {
      lastError = String(error);
      await new Promise((resolve) => setTimeout(resolve, READINESS_POLL_MS));
    }
  }
  throw new Error(`the test database did not become ready within ${READINESS_TIMEOUT_MS} ms: ${lastError}`);
}

export async function startPostgres(): Promise<TestDatabase> {
  const existing = process.env["REVIEWPLANE_TEST_DATABASE_URL"];
  if (existing !== undefined && existing !== "") {
    return { url: existing, containerName: "", stop: () => Promise.resolve() };
  }

  installExitHook();
  const name = `reviewplane-test-${randomUUID().slice(0, 8)}`;
  await run("docker", [
    "run",
    "--detach",
    "--name",
    name,
    "--env",
    "POSTGRES_PASSWORD=reviewplane",
    "--env",
    "POSTGRES_USER=postgres",
    "--env",
    "POSTGRES_DB=reviewplane",
    "--publish",
    "127.0.0.1::5432",
    // A tmpfs data directory keeps the container fast and leaves nothing on
    // the host when it is removed. PostgreSQL 18 images place their data under
    // a major-version subdirectory of /var/lib/postgresql, so the mount goes at
    // that level rather than at the older /var/lib/postgresql/data.
    "--tmpfs",
    "/var/lib/postgresql",
    POSTGRES_IMAGE,
    // fsync off: this database is thrown away, and the durability it would buy
    // is not a property any test asserts.
    "-c",
    "fsync=off",
  ]);
  liveContainers.add(name);

  try {
    const { stdout } = await run("docker", ["port", name, "5432/tcp"]);
    const mapping = stdout.trim().split("\n")[0];
    const port = mapping?.slice(mapping.lastIndexOf(":") + 1);
    if (port === undefined || port === "") throw new Error(`could not read the mapped port from ${stdout}`);
    await waitForReadiness(name);
    return {
      url: `postgres://postgres:reviewplane@127.0.0.1:${port}/reviewplane`,
      containerName: name,
      async stop(): Promise<void> {
        liveContainers.delete(name);
        await run("docker", ["rm", "--force", "--volumes", name]).catch(() => undefined);
      },
    };
  } catch (error) {
    liveContainers.delete(name);
    await run("docker", ["rm", "--force", "--volumes", name]).catch(() => undefined);
    throw error;
  }
}
