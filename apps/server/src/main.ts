/**
 * Server entry point: load configuration, apply migrations, build the app,
 * listen, and shut down cleanly on a signal.
 */

import { buildApp } from "./app.ts";
import { ConfigurationError, loadServerConfig } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { createPool } from "./db/pool.ts";

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
  const built = await buildApp({ config, pool });
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

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    built.app.log.info({ signal }, "shutting down");
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
