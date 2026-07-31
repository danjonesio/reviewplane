/**
 * The control-plane server entry point.
 *
 * It loads configuration, applies migrations, starts the HTTP API and the
 * connector listener, runs the background sweep that expires published
 * services, and shuts down cleanly on a signal. Everything it does is
 * delegated: composition is `app.ts`, and each domain owns a directory under
 * `src/modules/`.
 */

import { buildApp } from "./app.ts";
import { ConfigurationError, loadServerConfig } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { createPool } from "./db/pool.ts";

/** How often published-service expiry is enforced. */
const SWEEP_INTERVAL_MS = 30_000;

/**
 * How often routes another process requested are finished (ADR-0021).
 *
 * It is much shorter than the expiry sweep because somebody is waiting on it:
 * an agent that called `development_service_publish` is holding an MCP call
 * open until the route is `ready` or `failed`. The query is a partial index
 * scan over the handful of rows still in `requested`, so a second is cheap; a
 * connector's startup grace is ten seconds, and this must not be what dominates
 * the wait.
 */
const PENDING_INTERVAL_MS = 1_000;

/**
 * How long a route may sit `requested` before the sweep takes it over.
 *
 * The API publishes inline, so a route it is working on is milliseconds old.
 * Waiting two seconds before the sweep touches one keeps the two paths from
 * asking the same connector to open the same destination twice.
 */
const PENDING_GRACE_MS = 2_000;

async function main(): Promise<void> {
  let config;
  try {
    config = loadServerConfig();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      process.stderr.write(`configuration error: ${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }

  const pool = createPool(config.databaseUrl);
  const migration = await migrate(pool);
  // `docs/ARCHITECTURE.md` section 4.2 allows one codebase to run several
  // process roles, and the Compose deployment is a single container: this
  // process is `api` and `jobs`. A deployment that separates them runs
  // `reviewplane jobs` and starts this one with the role disabled.
  const built = await buildApp({ config, pool, runJobs: true });
  built.app.log.info(
    { applied: migration.applied.length, already_applied: migration.alreadyApplied.length },
    "migrations complete",
  );

  await built.start();
  built.app.log.info(
    {
      connector_listener: built.connectors.listenerAddress(),
      connector_public_url: built.connectors.config.publicUrl,
    },
    "connector listener started",
  );

  const sweep = setInterval(() => {
    built.publishedServices.expireDue().catch((error: unknown) => {
      built.app.log.error({ err: error }, "published-service expiry sweep failed");
    });
  }, SWEEP_INTERVAL_MS);
  // The sweep must not hold the process open on shutdown.
  sweep.unref();

  // The connector's control channel terminates in this process, so this is the
  // only process that can finish a publication (ADR-0021). A deployment that
  // runs several `api` replicas runs several of these; `markReady` and
  // `markFailed` both refuse a record whose status has already moved, so the
  // duplicate is a wasted acknowledgement rather than a second route.
  const pending = setInterval(() => {
    built.publishedServices
      .completePending({ olderThanMs: PENDING_GRACE_MS })
      .catch((error: unknown) => {
        built.app.log.error({ err: error }, "published-service completion sweep failed");
      });
  }, PENDING_INTERVAL_MS);
  pending.unref();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    built.app.log.info({ signal }, "shutting down");
    clearInterval(sweep);
    clearInterval(pending);
    void built
      .stop()
      .then(async () => pool.end())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        built.app.log.error({ err: error }, "shutdown failed");
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

await main();
