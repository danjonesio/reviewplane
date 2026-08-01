/**
 * Browser-worker liveness and reconciliation settings (ADR-0027).
 *
 * These live with the module rather than in `src/config.ts`, which holds only
 * settings the whole server shares (`src/config.ts` header). The shape mirrors
 * `modules/connectors/config.ts` deliberately: one concept of liveness in the
 * product, with the same interval / degraded / lost triple and the same
 * cross-validation, so an operator who has read one has read both.
 */

import { ConfigurationError, readInteger, type Environment } from "../../config.ts";

export interface BrowserWorkerConfig {
  /** How often a worker must heartbeat. Advertised to the worker on registration. */
  readonly heartbeatIntervalSeconds: number;
  /** Silence after which a worker is degraded and stops counting as capacity. */
  readonly degradedAfterSeconds: number;
  /** Silence after which a worker is lost: its sessions are no longer credible. */
  readonly lostAfterSeconds: number;
  /** How often the liveness sweep and the session reconciler run. */
  readonly monitorIntervalSeconds: number;
}

export const DEFAULT_BROWSER_WORKER_CONFIG: BrowserWorkerConfig = {
  heartbeatIntervalSeconds: 15,
  // Three missed heartbeats, the same margin a connector is given before it is
  // degraded (`REVIEWPLANE_CONNECTOR_DEGRADED_AFTER_SECONDS`). It is also the
  // value `reviewplane status` has used since RVP-15; that command now reads
  // this setting rather than holding a second copy of the number, because a
  // report and a reaper that disagree are worse than either alone.
  degradedAfterSeconds: 45,
  lostAfterSeconds: 90,
  monitorIntervalSeconds: 5,
};

export function loadBrowserWorkerConfig(environment: Environment): BrowserWorkerConfig {
  const heartbeatIntervalSeconds = readInteger(
    environment,
    "REVIEWPLANE_BROWSER_WORKER_HEARTBEAT_INTERVAL_SECONDS",
    DEFAULT_BROWSER_WORKER_CONFIG.heartbeatIntervalSeconds,
    { minimum: 5, maximum: 300 },
  );
  const degradedAfterSeconds = readInteger(
    environment,
    "REVIEWPLANE_BROWSER_WORKER_DEGRADED_AFTER_SECONDS",
    DEFAULT_BROWSER_WORKER_CONFIG.degradedAfterSeconds,
    { minimum: 1, maximum: 86400 },
  );
  const lostAfterSeconds = readInteger(
    environment,
    "REVIEWPLANE_BROWSER_WORKER_LOST_AFTER_SECONDS",
    DEFAULT_BROWSER_WORKER_CONFIG.lostAfterSeconds,
    { minimum: 1, maximum: 86400 },
  );
  const monitorIntervalSeconds = readInteger(
    environment,
    "REVIEWPLANE_BROWSER_WORKER_MONITOR_INTERVAL_SECONDS",
    DEFAULT_BROWSER_WORKER_CONFIG.monitorIntervalSeconds,
    { minimum: 1, maximum: 3600 },
  );

  if (lostAfterSeconds <= degradedAfterSeconds) {
    throw new ConfigurationError(
      "REVIEWPLANE_BROWSER_WORKER_LOST_AFTER_SECONDS must be greater than REVIEWPLANE_BROWSER_WORKER_DEGRADED_AFTER_SECONDS, or a worker would be lost before it was ever degraded.",
    );
  }
  if (degradedAfterSeconds <= heartbeatIntervalSeconds) {
    throw new ConfigurationError(
      "REVIEWPLANE_BROWSER_WORKER_DEGRADED_AFTER_SECONDS must be greater than REVIEWPLANE_BROWSER_WORKER_HEARTBEAT_INTERVAL_SECONDS, or a worker heartbeating exactly on time would be degraded between two heartbeats.",
    );
  }

  return {
    heartbeatIntervalSeconds,
    degradedAfterSeconds,
    lostAfterSeconds,
    monitorIntervalSeconds,
  };
}
