/**
 * The control-plane server entry point.
 *
 * It loads configuration, applies migrations, starts the HTTP API and runs the
 * background sweep that expires published services. Everything it does is
 * delegated: composition is `app.ts`, and each domain owns a directory under
 * `src/modules/`.
 */

import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createPool, migrateDatabase } from "./db/pool.ts";

/** How often published-service expiry is enforced. */
const SWEEP_INTERVAL_MS = 30_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const { app, publishedServices } = buildApp({ config, pool });

  const migrations = await migrateDatabase(pool);
  app.log.info({ applied: migrations.applied }, "migrations applied");

  const sweep = setInterval(() => {
    publishedServices.expireDue().catch((error: unknown) => {
      app.log.error({ err: error }, "published-service expiry sweep failed");
    });
  }, SWEEP_INTERVAL_MS);
  // The sweep must not hold the process open on shutdown.
  sweep.unref();

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, "shutting down");
    clearInterval(sweep);
    void app
      .close()
      .then(() => pool.end())
      .then(() => {
        process.exit(0);
      });
  };
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  process.stderr.write(`control-plane server failed to start: ${String(error)}\n`);
  process.exit(1);
});
