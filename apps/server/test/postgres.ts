/**
 * A disposable PostgreSQL for component tests.
 *
 * `docs/TESTING.md` section 2 puts API handlers with a real database in the
 * component layer, and a real database is the point: the migrations, the
 * constraints and the per-project event sequence are where several of the
 * invariants in this module actually live, and none of them is exercised by a
 * fake.
 *
 * The container is started once for the whole file, removed on exit even if a
 * test fails, and given `--rm` so that a killed process still leaves nothing
 * behind. Set `REVIEWPLANE_TEST_DATABASE_URL` to use an existing database
 * instead.
 */

import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import pg from "pg";

const run = promisify(execFile);

const IMAGE = "postgres:17-alpine";
const PASSWORD = "reviewplane-test";

export interface DisposablePostgres {
  readonly url: string;
  stop(): Promise<void>;
}

/** Starts a database, or returns the configured one. */
export async function startPostgres(): Promise<DisposablePostgres> {
  const existing = process.env["REVIEWPLANE_TEST_DATABASE_URL"];
  if (existing !== undefined && existing !== "") {
    return { url: existing, stop: () => Promise.resolve() };
  }

  const name = `reviewplane-test-${randomUUID().slice(0, 8)}`;
  await run("docker", [
    "run",
    "--rm",
    "--detach",
    "--name",
    name,
    "--publish",
    "127.0.0.1::5432",
    "--env",
    `POSTGRES_PASSWORD=${PASSWORD}`,
    "--env",
    "POSTGRES_DB=reviewplane",
    IMAGE,
    // fsync off: this database is thrown away, and the durability it would buy
    // is not a property any test asserts.
    "-c",
    "fsync=off",
  ]);

  const stop = async (): Promise<void> => {
    process.off("exit", removeSynchronously);
    try {
      await run("docker", ["rm", "--force", name]);
    } catch {
      // Already gone. --rm means the usual case is that it removed itself.
    }
  };

  // A killed or crashed test process never reaches its cleanup hook, and a
  // container that outlives its run holds a port and a few hundred megabytes
  // until someone notices. The exit handler must be synchronous, because
  // nothing asynchronous runs after `exit` is emitted.
  function removeSynchronously(): void {
    try {
      execFileSync("docker", ["rm", "--force", name], { stdio: "ignore" });
    } catch {
      // Nothing more can be done from an exit handler.
    }
  }
  process.once("exit", removeSynchronously);

  try {
    const { stdout } = await run("docker", ["port", name, "5432/tcp"]);
    const port = stdout.trim().split("\n")[0]?.split(":").pop();
    if (port === undefined) throw new Error("could not read the mapped port");
    const url = `postgres://postgres:${PASSWORD}@127.0.0.1:${port}/reviewplane`;
    await waitForReady(url);
    return { url, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function waitForReady(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`the test database never became ready: ${String(lastError)}`);
}
