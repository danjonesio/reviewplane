/**
 * The connectors module: enrolment tokens, device identity, the mutually
 * authenticated control channel and the heartbeat state machine.
 *
 * The connector listener is a separate Fastify instance on its own port,
 * because it terminates mutual TLS and the human API does not. Keeping them
 * apart is what makes "a connector credential cannot become a human session"
 * (`docs/TESTING.md` §10) a property of the topology rather than of a check
 * someone must remember to write.
 */

import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";

import type { Pool } from "../../db/pool.ts";
import type { LogDestination, LogLevel } from "../../config.ts";
import { ensureCertificateAuthority, ensureListenerCertificate, type TlsMaterial } from "./certificate-authority.ts";
import { MAX_INBOUND_MESSAGE_BYTES, registerConnectorChannels } from "./channel.ts";
import { loadConnectorModuleConfig, type ConnectorModuleConfig } from "./config.ts";
import { ControlChannelRegistry } from "./publication.ts";
import { startHeartbeatMonitor, type HeartbeatMonitor } from "./monitor.ts";
import { ensureOrganisation } from "./repository.ts";
import { registerConnectorRoutes } from "./routes.ts";

export { loadConnectorModuleConfig } from "./config.ts";
export type { ConnectorModuleConfig } from "./config.ts";
export { ControlChannelRegistry } from "./publication.ts";

export interface ConnectorModule {
  readonly config: ConnectorModuleConfig;
  readonly authority: TlsMaterial;
  readonly listener: FastifyInstance;
  /**
   * The live control channels, which route publication sends through
   * (`docs/CONNECTOR_PROTOCOL.md` §11).
   */
  readonly channels: ControlChannelRegistry;
  /** The address the connector listener bound to, once started. */
  listenerAddress(): string | null;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ConnectorModuleOptions {
  readonly pool: Pool;
  readonly bootstrapToken: string;
  readonly logLevel: LogLevel;
  readonly config?: ConnectorModuleConfig;
  readonly logDestination?: LogDestination;
}

/**
 * Registers the human-facing connector API on the main app and builds the
 * connector listener.
 */
export async function createConnectorModule(
  app: FastifyInstance,
  options: ConnectorModuleOptions,
): Promise<ConnectorModule> {
  const config = options.config ?? loadConnectorModuleConfig();
  await ensureOrganisation(options.pool, config.organisationId, config.organisationName);

  const authority = await ensureCertificateAuthority(options.pool);
  const listenerCertificate = await ensureListenerCertificate(options.pool, config, authority);

  registerConnectorRoutes(app, {
    pool: options.pool,
    config,
    authority,
    bootstrapToken: options.bootstrapToken,
  });

  const listener = Fastify({
    logger: {
      level: options.logLevel,
      ...(options.logDestination === undefined ? {} : { stream: options.logDestination }),
      redact: { paths: ["req.headers.authorization", "req.headers.cookie"], remove: true },
    },
    https: {
      cert: listenerCertificate.certificatePem,
      key: listenerCertificate.privateKeyPem,
      // The enrolment endpoint has no client certificate yet and the control
      // endpoint requires one, so the listener requests a certificate and each
      // route decides. `socket.authorized` is the verified-chain flag the
      // control route checks.
      requestCert: true,
      rejectUnauthorized: false,
      ca: authority.certificatePem,
      minVersion: "TLSv1.2",
    },
  });
  await listener.register(websocket, { options: { maxPayload: MAX_INBOUND_MESSAGE_BYTES } });

  // Work started by a channel that must finish before shutdown, so that a
  // connector disconnecting as the server stops still records its event.
  const inFlight = new Set<Promise<unknown>>();
  const channels = new ControlChannelRegistry();
  registerConnectorChannels(listener, {
    pool: options.pool,
    config,
    authority,
    channels,
    track: (work) => {
      inFlight.add(work);
      void work.finally(() => inFlight.delete(work));
    },
  });

  let monitor: HeartbeatMonitor | null = null;

  return {
    config,
    authority,
    listener,
    channels,
    listenerAddress(): string | null {
      const address = listener.server.address();
      if (address === null || typeof address === "string") return null;
      const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
      return `${host}:${String(address.port)}`;
    },
    async start(): Promise<void> {
      await listener.listen({ host: config.listenHost, port: config.listenPort });
      monitor = startHeartbeatMonitor(options.pool, config, listener.log);
    },
    async stop(): Promise<void> {
      monitor?.stop();
      monitor = null;
      channels.stop();
      await listener.close();
      await Promise.allSettled([...inFlight]);
    },
  };
}
