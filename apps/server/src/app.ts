/**
 * Application composition.
 *
 * This file wires modules together and does nothing else: domain behaviour
 * lives under `src/modules/<domain>/`. Keeping composition free of logic is
 * what lets several modules land independently without competing for the same
 * file.
 */

import Fastify, { type FastifyInstance } from "fastify";

import type { LogDestination, ServerConfig } from "./config.ts";
import type { Pool } from "./db/pool.ts";
import { createConnectorModule, type ConnectorModule, type ConnectorModuleConfig } from "./modules/connectors/index.ts";

export interface BuiltApp {
  readonly app: FastifyInstance;
  readonly connectors: ConnectorModule;
  /** Starts every listener the server owns. */
  start(): Promise<void>;
  /** Stops every listener. The pool is owned by the caller. */
  stop(): Promise<void>;
}

export interface BuildAppOptions {
  readonly config: ServerConfig;
  readonly pool: Pool;
  readonly connectorConfig?: ConnectorModuleConfig;
  /**
   * Where structured logs are written. Production leaves it unset, which sends
   * them to standard output; tests supply a collector so that they can assert
   * on the records the server actually emitted.
   */
  readonly logDestination?: LogDestination;
}

export async function buildApp(options: BuildAppOptions): Promise<BuiltApp> {
  const app = Fastify({
    logger: {
      level: options.config.logLevel,
      ...(options.logDestination === undefined ? {} : { stream: options.logDestination }),
      // docs/SECURITY.md section 18: no authorisation headers or cookies in
      // logs. Removal rather than masking, so the value cannot be recovered.
      redact: { paths: ["req.headers.authorization", "req.headers.cookie"], remove: true },
    },
    // docs/ARCHITECTURE.md section 4.1: request-size limits belong on the
    // ingress path. 1 MiB is ample for the administrative JSON bodies this
    // surface accepts.
    bodyLimit: 1 << 20,
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => {
    try {
      await options.pool.query("select 1");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  const connectors = await createConnectorModule(app, {
    pool: options.pool,
    bootstrapToken: options.config.bootstrapToken,
    logLevel: options.config.logLevel,
    ...(options.connectorConfig === undefined ? {} : { config: options.connectorConfig }),
    ...(options.logDestination === undefined ? {} : { logDestination: options.logDestination }),
  });

  return {
    app,
    connectors,
    async start(): Promise<void> {
      await app.listen({ host: options.config.host, port: options.config.port });
      await connectors.start();
    },
    async stop(): Promise<void> {
      await connectors.stop();
      await app.close();
    },
  };
}
