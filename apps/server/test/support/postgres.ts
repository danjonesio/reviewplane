/**
 * A disposable PostgreSQL for component and integration tests
 * (`docs/TESTING.md` §2: "API handlers with real database").
 *
 * Each caller gets its own container on an ephemeral host port. The container
 * is removed on test completion and again on process exit, so an interrupted
 * run does not leave one behind.
 */

import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The pinned image. `docs/SECURITY.md` §19 requires pinned base images. */
export const POSTGRES_IMAGE = "postgres:18-alpine";

const READINESS_TIMEOUT_MS = 60_000;
const READINESS_POLL_MS = 250;

const liveContainers = new Set<string>();
let exitHookInstalled = false;

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
