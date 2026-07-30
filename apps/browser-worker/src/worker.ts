/**
 * Worker composition: configuration in, running worker out.
 *
 * Nothing here contains domain logic. It wires the control-plane client, the
 * session manager and the internal listener together, registers the worker,
 * and keeps a heartbeat running so the control plane can tell a live worker
 * from a crashed one (`docs/ARCHITECTURE.md` section 14).
 */

import type { Server } from "node:http";

import { ControlPlaneClient } from "./control-plane.ts";
import type { WorkerConfig } from "./config.ts";
import { createWorkerServer } from "./http-server.ts";
import { createLogger, type Logger } from "./logging.ts";
import { SessionManager } from "./session/manager.ts";

export const WORKER_VERSION = "0.1.0";

export interface RunningWorker {
  readonly manager: SessionManager;
  readonly controlPlane: ControlPlaneClient;
  readonly server: Server;
  readonly port: number;
  stop(): Promise<void>;
}

export interface StartWorkerOptions {
  readonly config: WorkerConfig;
  readonly logger?: Logger;
  readonly fetchImplementation?: typeof fetch;
}

export async function startWorker(options: StartWorkerOptions): Promise<RunningWorker> {
  const { config } = options;
  const logger = options.logger ?? createLogger({ service: "browser-worker" });

  if (config.sandbox !== "required") {
    // docs/SECURITY.md section 10: disabling the Chromium sandbox is an
    // unsupported, high-risk configuration and must say so out loud.
    logger.warn(
      "HIGH RISK: the Chromium sandbox is disabled for this worker; untrusted page content runs with only container isolation",
      { sandbox: config.sandbox },
    );
  }

  const controlPlane = new ControlPlaneClient({
    baseUrl: config.controlPlaneUrl,
    credential: config.controlPlaneCredential,
    workerName: config.name,
    ...(options.fetchImplementation === undefined
      ? {}
      : { fetchImplementation: options.fetchImplementation }),
  });

  const manager = new SessionManager({
    config,
    artefacts: controlPlane,
    logger,
    observer: {
      onStatus: (session, report) => {
        logger.info("browser session status", {
          browser_session_id: session.id,
          project_id: session.projectId,
          status: report.status,
          previous_status: report.previous_status ?? "",
        });
        void controlPlane.reportStatus(session.id, report).catch((error: unknown) => {
          logger.error("could not report browser session status", {
            browser_session_id: session.id,
            detail: error instanceof Error ? error.message : String(error),
          });
        });
      },
    },
  });

  let heartbeat: NodeJS.Timeout | null = null;
  if (config.registerOnStart) {
    const registration = await controlPlane.register({
      workerVersion: WORKER_VERSION,
      // The browser build is not known until a context is launched; the
      // control plane records the authoritative value from the first
      // allocation, and this is the build the worker package pins.
      browserVersion: "chromium-bundled",
      capacity: config.capacity,
      labels: config.labels,
      sandboxEnabled: config.sandbox === "required",
      startedAt: new Date(),
    });
    manager.setAssignedProjects(registration.ack.assigned_projects);
    logger.info("worker registered", {
      worker_id: registration.workerId,
      projects: String(registration.ack.assigned_projects.length),
    });
    const interval = registration.ack.heartbeat_interval_seconds * 1000;
    heartbeat = setInterval(() => {
      void controlPlane
        .heartbeat({
          activeSessions: manager.activeSessions,
          capacity: config.capacity,
          residentMemoryMb: Math.round(process.memoryUsage.rss() / (1024 * 1024)),
        })
        .catch(() => undefined);
    }, interval);
    heartbeat.unref();
  }

  const server = createWorkerServer({
    config,
    manager,
    logger,
    workerId: () => controlPlane.workerId,
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.listenAddress, () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : config.port);
    });
  });
  logger.info("browser worker listening", {
    address: config.listenAddress,
    port: String(port),
    capacity: String(config.capacity),
    sandbox: config.sandbox,
  });

  return {
    manager,
    controlPlane,
    server,
    port,
    async stop() {
      if (heartbeat !== null) clearInterval(heartbeat);
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await manager.shutdown();
    },
  };
}
