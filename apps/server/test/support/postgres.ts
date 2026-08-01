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

import pg from "pg";

import { migrate } from "../../src/db/migrate.ts";
import { createPool } from "../../src/db/pool.ts";
import type { Pool } from "../../src/db/pool.ts";

const execFileAsync = promisify(execFile);

// Every docker invocation is bounded.
//
// The readiness wait used to be a loop of `docker exec` calls with no timeout
// on any of them, which made its own 120-second deadline unenforceable: the
// deadline is only read between attempts, so one docker call that never
// returned meant the wait never returned either, and a test run that should
// have failed in seconds stalled until continuous integration killed the job
// (RVP-62). A bound on the invocation is what makes the bound on the wait real.
const DOCKER_TIMEOUT_MS = 60_000;

async function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, { timeout: DOCKER_TIMEOUT_MS });
}

/** The pinned image. `docs/SECURITY.md` §19 requires pinned base images. */
export const POSTGRES_IMAGE = "postgres:18-alpine";

// Every test file that needs a database starts its own, and two of them also
// build and run the Go connector. This bound still allows for a slow image pull
// on a first run.
const READINESS_TIMEOUT_MS = 120_000;
const READINESS_POLL_MS = 250;
// A readiness probe that cannot connect within this is retried rather than
// waited on, so that a container which is up but not listening does not consume
// the whole budget in one attempt.
const READINESS_CONNECT_TIMEOUT_MS = 5_000;

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

const FIXTURE_TABLES = `idempotency_keys, review_exports, jobs, verification_artefacts, verifications, comments,
              inbox_items, annotations, findings, reviews, artefact_access_grants, artefacts,
              control_leases, browser_sessions, browser_worker_projects,
              browser_workers, agent_sessions, agent_credentials, workspaces,
              viewer_sessions, route_capabilities, published_services, connectors,
              connector_enrolment_tokens, environments, event_streams, events,
              event_outbox, authentication_attempt_limits, install_tokens,
              users, projects, organisations`;

// PostgreSQL error codes for the two ways a reset can lose a race for its locks.
const DEADLOCK_DETECTED = "40P01";
const LOCK_NOT_AVAILABLE = "55P03";

const QUIET_TIMEOUT_MS = 10_000;
const QUIET_POLL_MS = 5;
const TRUNCATE_ATTEMPTS = 100;
const TRUNCATE_BACKOFF_MS = 10;

/**
 * Waits until no other session on this database is running a statement.
 *
 * A component under test stops when its `stop()` resolves, and that is not the
 * same instant as when the last statement it started finishes: an audit write
 * or an event insert can still be in flight on a connection the fixture shares.
 * `TRUNCATE` then asks for `ACCESS EXCLUSIVE` on twenty-six tables while that
 * statement holds `ROW EXCLUSIVE` on one of them and waits for another the
 * truncation already holds, and PostgreSQL reports a deadlock (RVP-62).
 *
 * Waiting for quiet is what makes the reset usually uncontended. It is not what
 * makes it safe — a statement can always start in the gap between this check
 * and the lock, and a check that were relied on for correctness would be a race
 * of its own. Safety is the `NOWAIT` below; this is only what keeps the backoff
 * from being the normal path.
 */
async function waitForQuietBackends(pool: Pool): Promise<void> {
  const deadline = Date.now() + QUIET_TIMEOUT_MS;
  for (;;) {
    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text as count
         from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and state in ('active', 'idle in transaction', 'idle in transaction (aborted)')`,
    );
    if (rows[0]?.count === "0") return;
    if (Date.now() >= deadline) {
      // Not a failure. Some suites deliberately hold a connection open, and the
      // truncation below is bounded and retried, so proceeding is safe; it is
      // the silent unbounded wait that would not be.
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, QUIET_POLL_MS));
  }
}

function isLockContention(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === DEADLOCK_DETECTED || code === LOCK_NOT_AVAILABLE;
}

/**
 * Removes every row the tests create.
 *
 * `connector_tls_material` is deliberately left alone: the certificate
 * authority is created once when the app is built, and dropping it between
 * tests would leave the connector module without the identity it already
 * issued from.
 *
 * The reset waits for the database to go quiet, then takes every lock it needs
 * with `NOWAIT` so that it can never wait for one and therefore can never be
 * part of a deadlock cycle, and backs off a bounded number of times if a lock
 * is held. A fixture reset that hangs or deadlocks fails the test that was
 * about to run rather than the one that caused it, which makes it the hardest
 * kind of failure to read.
 *
 * The event tables are listed in the writer's lock order — `event_streams`,
 * then `events`, then `event_outbox`, matching `appendEvent` (RVP-9). Under
 * `NOWAIT` the order no longer determines safety, but matching the writer
 * keeps the backoff off the common path when a write is still in flight.
 */
export async function truncateAll(pool: Pool): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TRUNCATE_ATTEMPTS; attempt++) {
    await waitForQuietBackends(pool);
    const client = await pool.connect();
    try {
      await client.query("begin");
      // NOWAIT is what makes a deadlock impossible rather than unlikely.
      //
      // A deadlock needs a cycle, and a cycle needs this session to wait for a
      // lock while something else waits for one this session holds. With NOWAIT
      // it never waits: it takes every table it is about to truncate, or it
      // fails with lock_not_available and rolls back, releasing whatever it had
      // taken. A writer blocked behind it then proceeds. Retrying under
      // contention is therefore a backoff, not a gamble on winning a race.
      //
      // TRUNCATE takes exactly these locks, so by the time it runs there is
      // nothing left for it to acquire and nothing left for it to wait on.
      await client.query(`LOCK TABLE ${FIXTURE_TABLES} IN ACCESS EXCLUSIVE MODE NOWAIT`);
      await client.query(`TRUNCATE ${FIXTURE_TABLES} RESTART IDENTITY CASCADE`);
      await client.query("commit");
      return;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      if (!isLockContention(error)) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, TRUNCATE_BACKOFF_MS));
    } finally {
      client.release();
    }
  }
  throw new Error(
    `the fixture reset could not take its locks in ${TRUNCATE_ATTEMPTS} attempts, so something ` +
      `under test is still writing to the database after it was stopped. Its stop() is ` +
      `returning before its last statement has finished: ${String(lastError)}`,
  );
}

/**
 * Runs `probe` until it succeeds, or gives up.
 *
 * Separated from the container so that the bound itself can be tested. "The
 * wait is bounded" is the property that failed in RVP-62 — not the probe — and
 * a property nothing exercises is a property nobody knows they have lost.
 */
export async function waitUntilReady(
  probe: () => Promise<void>,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    describe?: string;
    /** Called between attempts. Throwing from it abandons the wait immediately. */
    stillViable?: () => Promise<void>;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? READINESS_TIMEOUT_MS;
  const pollMs = options.pollMs ?? READINESS_POLL_MS;
  const subject = options.describe ?? "the test database";
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = new Error("not started");

  for (;;) {
    try {
      await probe();
      return;
    } catch (error) {
      lastError = error;
    }
    if (options.stillViable !== undefined) {
      // A container that has already exited will never become ready, and
      // spending the remaining two minutes proving that helps nobody. This
      // rethrows with the reason.
      await options.stillViable();
    }
    if (Date.now() + pollMs >= deadline) {
      throw new Error(`${subject} did not become ready within ${timeoutMs} ms: ${String(lastError)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Opens a connection the way a test will and runs one statement on it.
 *
 * The transport is the whole point. The previous probe ran `pg_isready` and
 * `psql` through `docker exec`, which reach the server over the container's
 * Unix socket — and the official image's entrypoint runs a *temporary* server on
 * that socket, with `listen_addresses` empty, while it applies `POSTGRES_DB`,
 * `POSTGRES_USER` and the init scripts. That temporary server answered the
 * probe, readiness was declared, and the caller's pool then connected over TCP
 * and was cut off mid-migration when the entrypoint stopped the temporary
 * server to start the real one: `Connection terminated unexpectedly` (RVP-62).
 *
 * Probing over TCP cannot be fooled by that, because there is nothing listening
 * on TCP until the real server is up.
 */
async function probeOverTcp(url: string): Promise<void> {
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: READINESS_CONNECT_TIMEOUT_MS,
  });
  try {
    await client.connect();
    await client.query("select 1");
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Throws with the container's own account of itself when it is no longer running. */
async function assertContainerRunning(name: string): Promise<void> {
  const { stdout } = await run("docker", ["inspect", "--format", "{{.State.Running}}", name]).catch(
    () => ({ stdout: "false", stderr: "" }),
  );
  if (stdout.trim() === "true") return;
  const logs = await run("docker", ["logs", "--tail", "40", name]).catch(() => ({ stdout: "", stderr: "" }));
  throw new Error(
    `the test database container ${name} is no longer running. Its last output was:\n` +
      `${logs.stdout}${logs.stderr}`,
  );
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
    // The URL is built before the wait rather than after it, because the wait
    // has to use it: readiness means "a test's connection works", and the only
    // way to know that is to be a test's connection.
    const url = `postgres://postgres:reviewplane@127.0.0.1:${port}/reviewplane`;
    await waitUntilReady(() => probeOverTcp(url), {
      describe: `the test database ${name}`,
      stillViable: () => assertContainerRunning(name),
    });
    return {
      url,
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
