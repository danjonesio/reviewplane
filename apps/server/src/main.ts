/** Entry point: validate configuration, migrate, listen. */

import { join } from "node:path";

import { buildApp } from "./app.ts";
import { ConfigurationError, loadServerConfig } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { createPool } from "./db/pool.ts";

const MIGRATIONS_DIRECTORY = join(import.meta.dirname, "..", "migrations");

async function main(): Promise<void> {
  const config = loadServerConfig();
  const pool = createPool(config.databaseUrl);
  const migrations = await migrate(pool, MIGRATIONS_DIRECTORY);
  process.stdout.write(
    `${JSON.stringify({
      level: "info",
      service: "server",
      message: "migrations applied",
      applied: migrations.applied.length,
    })}\n`,
  );

  const { app } = await buildApp({ config, pool, logger: true });
  await app.listen({ host: config.listenAddress, port: config.port });

  const stop = (): void => {
    void app.close().then(
      () => pool.end().then(() => process.exit(0)),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `${JSON.stringify({ level: "error", service: "server", message: "startup failed", detail })}\n`,
  );
  process.exit(error instanceof ConfigurationError ? 78 : 1);
});
