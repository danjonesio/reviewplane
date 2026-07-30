/**
 * Composition only. Every decision lives in a module; this file wires them.
 */

import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";

import type { ServerConfig } from "./config.ts";
import { errorHandler } from "./errors.ts";
import { registerArtefactRoutes } from "./modules/artefacts/routes.ts";
import { ArtefactService } from "./modules/artefacts/service.ts";
import { FilesystemArtefactStore, type ArtefactStore } from "./modules/artefacts/store.ts";
import { registerBrowserSessionRoutes } from "./modules/browser-sessions/routes.ts";
import { BrowserSessionService } from "./modules/browser-sessions/service.ts";
import { BrowserWorkerClient } from "./modules/browser-sessions/worker-client.ts";
import { WorkerRegistry } from "./modules/browser-sessions/workers.ts";
import { registerProjectRoutes } from "./modules/projects/routes.ts";

export interface BuildAppOptions {
  readonly config: ServerConfig;
  readonly pool: Pool;
  /** Injected by tests; the filesystem driver is the default (ADR-0012). */
  readonly artefactStore?: ArtefactStore;
  /** Injected by tests so the worker channel can be driven in-process. */
  readonly workerFetch?: typeof fetch;
  readonly logger?: boolean;
}

export interface BuiltApp {
  readonly app: FastifyInstance;
  readonly artefacts: ArtefactService;
  readonly sessions: BrowserSessionService;
  readonly workers: WorkerRegistry;
}

export async function buildApp(options: BuildAppOptions): Promise<BuiltApp> {
  const { config, pool } = options;
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: config.artefactMaxBytes + 65536,
  });
  app.setErrorHandler(errorHandler);

  const store = options.artefactStore ?? new FilesystemArtefactStore(config.artefactPath);
  const artefacts = new ArtefactService(pool, store, config.artefactMaxBytes);
  const workers = new WorkerRegistry(pool, config.workerCredential);
  const workerClient = new BrowserWorkerClient({
    endpoint: config.workerEndpoint,
    credential: config.workerCommandCredential,
    timeoutMs: config.workerRequestTimeoutMs,
    ...(options.workerFetch === undefined ? {} : { fetchImplementation: options.workerFetch }),
  });
  const sessions = new BrowserSessionService(pool, workers, workerClient);

  app.get("/health", async () => ({ status: "ok" }));

  await registerProjectRoutes(app, {
    pool,
    bootstrapToken: config.bootstrapToken,
    workerCredential: config.workerCredential,
  });
  await registerArtefactRoutes(app, {
    pool,
    artefacts,
    workers,
    bootstrapToken: config.bootstrapToken,
    workerCredential: config.workerCredential,
    maxBytes: config.artefactMaxBytes,
  });
  await registerBrowserSessionRoutes(app, {
    sessions,
    workers,
    bootstrapToken: config.bootstrapToken,
    workerCredential: config.workerCredential,
  });

  return { app, artefacts, sessions, workers };
}
