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

import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";

import type { Pool } from "../../db/pool.ts";
import type { LogDestination, LogLevel } from "../../config.ts";
import { AgentCredentialStore } from "../agents/credentials.ts";
import { registerConnectorAgentCredentialRoute } from "./agent-credentials.ts";
import { ensureCertificateAuthority, ensureListenerCertificate, type TlsMaterial } from "./certificate-authority.ts";
import { MAX_INBOUND_MESSAGE_BYTES, registerConnectorChannels } from "./channel.ts";
import { loadConnectorModuleConfig, type ConnectorModuleConfig } from "./config.ts";
import { ControlChannelRegistry } from "./publication.ts";
import type { ConnectorReconciler } from "./reconciliation.ts";
import type { RevocationEffects } from "./revocation.ts";
import { startHeartbeatMonitor, type HeartbeatMonitor } from "./monitor.ts";
import { ensureOrganisation } from "./repository.ts";
import { registerConnectorRoutes } from "./routes.ts";

export { loadConnectorModuleConfig } from "./config.ts";
export type { ConnectorModuleConfig } from "./config.ts";
export { ControlChannelRegistry } from "./publication.ts";
export type { ConnectorReconciler } from "./reconciliation.ts";
export type { RevocationEffects } from "./revocation.ts";

export interface ConnectorModule {
  readonly config: ConnectorModuleConfig;
  readonly authority: TlsMaterial;
  readonly listener: FastifyInstance;
  /**
   * The live control channels, which route publication sends through
   * (`docs/CONNECTOR_PROTOCOL.md` §11).
   */
  readonly channels: ControlChannelRegistry;
  /**
   * Supplies the reconnect reconciler (`docs/CONNECTOR_PROTOCOL.md` §17).
   *
   * It arrives after the module is built because reconciliation decides the
   * fate of published services, and the published-service module needs the
   * connector channels to exist first. Until it is supplied the channel
   * continues no route, which is the fail-closed answer rather than an
   * unreconciled one.
   */
  useReconciler(reconciler: ConnectorReconciler): void;
  /**
   * Supplies what revocation must reach beyond the connector record
   * (`docs/CONNECTOR_PROTOCOL.md` §18): the routes and the browser sessions.
   * It arrives after composition for the same reason the reconciler does, and
   * until it does a revocation still invalidates the identity and closes the
   * channel — the parts this module owns — and reports having revoked no route.
   */
  useRevocationEffects(effects: RevocationEffects): void;
  /** The address the connector listener bound to, once started. */
  listenerAddress(): string | null;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ConnectorModuleOptions {
  readonly pool: Pool;
  readonly logLevel: LogLevel;
  readonly config?: ConnectorModuleConfig;
  readonly logDestination?: LogDestination;
}

/**
 * Publishes the connector authority's certificate where the tunnel gateway can
 * read it (ADR-0014).
 *
 * The authority is created by this process on first start and lives in the
 * database, so nothing an installer runs beforehand can produce the file; the
 * tunnel gateway reads one at startup and refuses to start without it. Writing
 * it here is what lets `docker compose up -d` bring up a complete stack rather
 * than one where an operator must fetch a certificate through the API and
 * restart a container — which is what `deploy/compose/e2e/run.sh` had to do,
 * and what an installation following `docs/DEPLOYMENT.md` section 8 had no way
 * of doing at all.
 *
 * It writes the certificate and never the key. The write is atomic — a
 * temporary file and a rename — because the gateway may read it at any moment,
 * and a half-written PEM is a gateway that trusts nothing.
 */
async function exportCertificateAuthority(
  path: string | undefined,
  certificatePem: string,
): Promise<void> {
  if (path === undefined || path === "") return;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, certificatePem, { mode: 0o644 });
  await rename(temporary, path);
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
  await exportCertificateAuthority(config.certificateAuthorityExportFile, authority.certificatePem);

  const channels = new ControlChannelRegistry();
  const revocationHolder: { current: RevocationEffects | undefined } = { current: undefined };

  // One store for both halves of the credential's life: the listener's exchange
  // issues through it (ADR-0023) and the human API's revocation closes what that
  // issued (`docs/CONNECTOR_PROTOCOL.md` §18). Two stores would work, and would
  // make it possible to change how one of them writes the row.
  const credentials = new AgentCredentialStore(options.pool);

  registerConnectorRoutes(app, {
    pool: options.pool,
    config,
    authority,
    channels,
    credentials,
    revocationEffects: () => revocationHolder.current,
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

  // The local MCP bridge's credential exchange (ADR-0023). It is on this
  // listener because it authenticates with the connector's device identity, and
  // this is the only listener that terminates client certificates.
  registerConnectorAgentCredentialRoute(listener, { pool: options.pool, credentials });

  // Work started by a channel that must finish before shutdown, so that a
  // connector disconnecting as the server stops still records its event.
  const inFlight = new Set<Promise<unknown>>();
  const reconcilerHolder: { current: ConnectorReconciler | undefined } = { current: undefined };
  registerConnectorChannels(listener, {
    pool: options.pool,
    config,
    authority,
    channels,
    get reconciler(): ConnectorReconciler | undefined {
      return reconcilerHolder.current;
    },
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
    useReconciler(reconciler: ConnectorReconciler): void {
      reconcilerHolder.current = reconciler;
    },
    useRevocationEffects(effects: RevocationEffects): void {
      revocationHolder.current = effects;
    },
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
