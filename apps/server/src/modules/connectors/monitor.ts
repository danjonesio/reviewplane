/**
 * The heartbeat state machine of `docs/DOMAIN_MODEL.md` §8.
 *
 * `docs/CONNECTOR_PROTOCOL.md` §8 gives the rule: missing a small number of
 * heartbeats means delayed, and exceeding the disconnect threshold means
 * disconnected. This monitor is what draws those conclusions — a connector
 * never reports `DEGRADED` or `DISCONNECTED` about itself, because a silent
 * connector cannot report anything.
 *
 * Every transition produces an event, so a connector that goes quiet leaves an
 * audit trail rather than simply ceasing to appear.
 */

import type { FastifyBaseLogger } from "fastify";

import type { Pool } from "../../db/pool.ts";
import type { ConnectorModuleConfig } from "./config.ts";
import { findStaleConnectors, transitionConnector } from "./repository.ts";

export interface SweepResult {
  readonly degraded: readonly string[];
  readonly disconnected: readonly string[];
}

/**
 * One pass of the state machine. Disconnection is evaluated first, so that a
 * connector silent for longer than the disconnect threshold lands in
 * `DISCONNECTED` rather than being moved to `DEGRADED` and only caught on the
 * next sweep.
 */
export async function sweepConnectorHealth(
  pool: Pool,
  config: ConnectorModuleConfig,
  log?: FastifyBaseLogger,
): Promise<SweepResult> {
  const disconnected: string[] = [];
  for (const connector of await findStaleConnectors(
    pool,
    ["ACTIVE", "DEGRADED"],
    config.disconnectedAfterSeconds,
  )) {
    const event = await transitionConnector(pool, {
      connectorId: connector.id,
      from: ["ACTIVE", "DEGRADED"],
      to: "DISCONNECTED",
      eventType: "connector.disconnected",
      payload: {
        trigger: "heartbeat_timeout",
        silent_for_seconds_at_least: config.disconnectedAfterSeconds,
      },
    });
    if (event !== null) {
      disconnected.push(connector.id);
      log?.warn({ connector_id: connector.id }, "connector disconnected after heartbeat loss");
    }
  }

  const degraded: string[] = [];
  for (const connector of await findStaleConnectors(pool, ["ACTIVE"], config.degradedAfterSeconds)) {
    const event = await transitionConnector(pool, {
      connectorId: connector.id,
      from: ["ACTIVE"],
      to: "DEGRADED",
      eventType: "connector.degraded",
      payload: {
        trigger: "heartbeat_delay",
        silent_for_seconds_at_least: config.degradedAfterSeconds,
      },
    });
    if (event !== null) {
      degraded.push(connector.id);
      log?.warn({ connector_id: connector.id }, "connector degraded after missed heartbeats");
    }
  }

  return { degraded, disconnected };
}

export interface HeartbeatMonitor {
  stop(): void;
}

/** Starts the periodic sweep. The timer is unref'd so it never holds the process open. */
export function startHeartbeatMonitor(
  pool: Pool,
  config: ConnectorModuleConfig,
  log: FastifyBaseLogger,
): HeartbeatMonitor {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void sweepConnectorHealth(pool, config, log)
      .catch((error: unknown) => {
        log.error({ err: error }, "the connector heartbeat sweep failed");
      })
      .finally(() => {
        running = false;
      });
  }, config.monitorIntervalSeconds * 1000);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
