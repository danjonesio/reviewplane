/**
 * Process entry point for the MCP server.
 *
 * It is a separate process from `apps/server` (`docs/ARCHITECTURE.md`
 * section 4.4) with its own listener and its own route, and it holds no
 * administrator credential. It does not run migrations: the control-plane
 * server owns the schema, and two processes racing to migrate one database is
 * a failure mode with no upside.
 */

import { Pool } from "pg";

import { buildMcpApp } from "./app.ts";
import { ConfigurationError, loadMcpServerConfig } from "./config.ts";

async function main(): Promise<void> {
  const config = loadMcpServerConfig();
  const pool = new Pool({ connectionString: config.databaseUrl, max: 8 });
  const built = await buildMcpApp({ config, pool, logger: true });

  const shutdown = async (signal: string): Promise<void> => {
    built.app.log.info({ signal }, "shutting down");
    await built.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await built.app.listen({ host: config.listenAddress, port: config.port });
  built.app.log.info(
    { path: config.mcpPath },
    "MCP endpoint listening; agent credentials only, no human sessions",
  );
}

main().catch((error: unknown) => {
  if (error instanceof ConfigurationError) {
    process.stderr.write(`configuration error: ${error.message}\n`);
    process.exit(78);
  }
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
