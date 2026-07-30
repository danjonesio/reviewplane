#!/usr/bin/env node
/**
 * `reviewplane` — the operator command line.
 *
 * `docs/DEPLOYMENT.md` section 11 requires the application to expose a
 * migration command, and `docs/ARCHITECTURE.md` section 4.2 names the process
 * roles one codebase may run. Both are here rather than in a shell script,
 * because a migration that runs from the application image is a migration that
 * cannot be applied by a build of the schema that does not match the code.
 *
 * ```text
 * reviewplane migrate           apply every pending migration
 * reviewplane migrate --status  report the schema version and what is pending
 * reviewplane serve             the api role: HTTP API, connector listener
 * reviewplane jobs              the jobs role: durable background work
 * reviewplane version           the build this image carries
 * ```
 *
 * Exit codes are the operator interface: 0 success, 1 failure, 2 a
 * configuration error the process cannot start with, and 3 for
 * `migrate --status` when migrations are pending — so a deployment script can
 * branch on "needs migrating" without parsing output.
 */

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp } from "./app.ts";
import { ConfigurationError, loadServerConfig } from "./config.ts";
import { migrate, migrationState } from "./db/migrate.ts";
import { createPool, type Pool } from "./db/pool.ts";
import { readBuildInfo } from "./health.ts";
import { JobRunner } from "./jobs/runner.ts";

/** Exit code for `migrate --status` when the schema is behind the code. */
export const EXIT_MIGRATIONS_PENDING = 3;

const USAGE = `reviewplane <command>

  migrate [--status]   apply pending database migrations, or report them
  serve                run the api role
  jobs [--once]        run the jobs role
  version              print the build information

Configuration is read from the environment; see docs/CONFIGURATION.md.
`;

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function runMigrate(pool: Pool, statusOnly: boolean): Promise<number> {
  if (statusOnly) {
    const state = await migrationState(pool);
    write(`schema version: ${state.schemaVersion ?? "(none applied)"}`);
    write(`applied:        ${String(state.applied.length)}`);
    write(`pending:        ${String(state.pending.length)}`);
    for (const file of state.pending) write(`  pending  ${file}`);
    return state.pending.length === 0 ? 0 : EXIT_MIGRATIONS_PENDING;
  }

  const before = await migrationState(pool);
  if (before.pending.length === 0) {
    write(`schema version: ${before.schemaVersion ?? "(none applied)"}`);
    write("nothing to apply");
    return 0;
  }
  write(`applying ${String(before.pending.length)} migration(s)`);
  const result = await migrate(pool);
  for (const file of result.applied) write(`  applied  ${file}`);
  const after = await migrationState(pool);
  write(`schema version: ${after.schemaVersion ?? "(none applied)"}`);
  if (after.pending.length > 0) {
    process.stderr.write(
      `migrate finished with ${String(after.pending.length)} migration(s) still pending\n`,
    );
    return 1;
  }
  return 0;
}

async function runServe(pool: Pool): Promise<number> {
  const config = loadServerConfig();
  // Migrations run before the listener opens. A process that served requests
  // while its schema was behind its code would fail request by request, which
  // is worse than not starting; `/health/ready` reports the same condition for
  // a deployment that migrates separately.
  const migration = await migrate(pool);
  const built = await buildApp({ config, pool, runJobs: true });
  built.app.log.info(
    { applied: migration.applied.length, already_applied: migration.alreadyApplied.length },
    "migrations complete",
  );
  await built.start();
  await waitForSignal(async () => {
    await built.stop();
  });
  return 0;
}

async function runJobs(pool: Pool, once: boolean): Promise<number> {
  const state = await migrationState(pool);
  if (state.pending.length > 0) {
    process.stderr.write(
      `the jobs role will not start against a schema with ${String(state.pending.length)} pending migration(s); run reviewplane migrate first\n`,
    );
    return 1;
  }
  const runner = new JobRunner({
    pool,
    handlers: {},
    logger: {
      info: (fields, message) => {
        write(`${message} ${JSON.stringify(fields)}`);
      },
      error: (fields, message) => {
        process.stderr.write(`${message} ${JSON.stringify(fields)}\n`);
      },
    },
  });
  if (once) {
    const done = await runner.drain();
    write(`ran ${String(done)} job(s)`);
    return 0;
  }
  runner.start();
  write(`jobs role running as ${runner.runnerId}`);
  await waitForSignal(async () => {
    await runner.stop();
  });
  return 0;
}

/** Resolves when the process is asked to stop, after running `shutdown`. */
async function waitForSignal(shutdown: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (signal: string): void => {
      if (stopping) return;
      stopping = true;
      write(`shutting down on ${signal}`);
      void shutdown()
        .catch(() => undefined)
        .then(() => {
          resolve();
        });
    };
    process.on("SIGINT", () => {
      stop("SIGINT");
    });
    process.on("SIGTERM", () => {
      stop("SIGTERM");
    });
  });
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "help" || command === "--help") {
    write(USAGE);
    return command === undefined ? 1 : 0;
  }

  if (command === "version") {
    const build = readBuildInfo();
    write(`reviewplane ${build.version}`);
    write(`revision ${build.revision}`);
    write(`built at ${build.builtAt}`);
    return 0;
  }

  const databaseUrl = requireDatabaseUrl();
  const pool = createPool(databaseUrl);
  try {
    switch (command) {
      case "migrate":
        return await runMigrate(pool, rest.includes("--status"));
      case "serve":
        return await runServe(pool);
      case "jobs":
        return await runJobs(pool, rest.includes("--once"));
      default:
        process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
        return 1;
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/**
 * The one setting every command needs.
 *
 * `migrate` must run without the rest of the server's configuration — an
 * operator applying a schema has no gateway, no worker and no capability key —
 * so it reads the database URL directly rather than loading the whole
 * `ServerConfig`.
 */
function requireDatabaseUrl(): string {
  const direct = process.env["REVIEWPLANE_DATABASE_URL"];
  if (direct !== undefined && direct !== "") return direct;
  const file = process.env["REVIEWPLANE_DATABASE_URL_FILE"];
  if (file !== undefined && file !== "") return readFileSync(file, "utf8").trim();
  throw new ConfigurationError(
    "REVIEWPLANE_DATABASE_URL or REVIEWPLANE_DATABASE_URL_FILE must be set.",
  );
}

async function runCli(): Promise<void> {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof ConfigurationError) {
      process.stderr.write(`configuration error: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  }
}

// Run only when invoked as the process entry point, so that the test suite can
// import `main` and exercise the commands without the module exiting for it.
if (
  process.argv[1] !== undefined &&
  resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await runCli();
}
