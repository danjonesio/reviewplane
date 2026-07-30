/**
 * Application composition.
 *
 * This file wires modules together and does nothing else: no domain rule, no
 * query and no authorisation arithmetic lives here. Each domain owns a
 * directory under `src/modules/`, and adding one is a registration call here
 * rather than an edit to shared code. Keeping composition free of logic is what
 * lets several modules land independently without competing for the same file.
 */

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

import { bearerToken, requireBootstrapAdministrator } from "./auth.ts";
import type { LogDestination, ServerConfig } from "./config.ts";
import type { Pool } from "./db/pool.ts";
import { renderError } from "./errors.ts";
import { AgentCredentialStore } from "./modules/agents/credentials.ts";
import { IdempotencyStore } from "./modules/agents/idempotency.ts";
import { registerAgentRoutes } from "./modules/agents/routes.ts";
import { AgentSessionStore } from "./modules/agents/sessions.ts";
import { WorkspaceStore } from "./modules/agents/workspaces.ts";
import type { AgentArtefactPrincipal } from "./modules/artefacts/routes.ts";
import { registerArtefactRoutes } from "./modules/artefacts/routes.ts";
import { ArtefactService } from "./modules/artefacts/service.ts";
import { FilesystemArtefactStore } from "./modules/artefacts/store.ts";
import type { ArtefactStore } from "./modules/artefacts/store.ts";
import { registerBrowserSessionRoutes } from "./modules/browser-sessions/routes.ts";
import { BrowserSessionService } from "./modules/browser-sessions/service.ts";
import { BrowserWorkerClient } from "./modules/browser-sessions/worker-client.ts";
import { WorkerRegistry } from "./modules/browser-sessions/workers.ts";
import { createConnectorModule } from "./modules/connectors/index.ts";
import type { ConnectorModule, ConnectorModuleConfig } from "./modules/connectors/index.ts";
import { LiveRelay } from "./modules/live/relay.ts";
import { registerLiveRoutes, resolveViewer } from "./modules/live/routes.ts";
import { ViewerSessionStore } from "./modules/live/viewer-sessions.ts";
import { WorkerLiveClient } from "./modules/live/worker-live-client.ts";
import { registerProjectRoutes } from "./modules/projects/routes.ts";
import { STAGE_0_DESTINATION_POLICY } from "./modules/published-services/destination-policy.ts";
import type { DestinationPolicy } from "./modules/published-services/destination-policy.ts";
import { HttpTunnelGateway } from "./modules/published-services/gateway-client.ts";
import type { TunnelGateway } from "./modules/published-services/gateway-client.ts";
import { ConnectorRoutePublisher } from "./modules/published-services/connector-publisher.ts";
import { registerPublishedServiceRoutes } from "./modules/published-services/routes.ts";
import { PublishedServiceBinder } from "./modules/published-services/session-binder.ts";
import { PublishedServiceReconciler } from "./modules/published-services/reconciliation.ts";
import { PublishedServiceService } from "./modules/published-services/service.ts";
import type { RoutePublisher } from "./modules/published-services/service.ts";
import { registerReviewRoutes } from "./modules/reviews/routes.ts";
import { ReviewService } from "./modules/reviews/service.ts";

export interface BuildAppOptions {
  readonly config: ServerConfig;
  readonly pool: Pool;
  readonly connectorConfig?: ConnectorModuleConfig;
  /** Substituted in tests; defaults to the HTTP client. */
  readonly gateway?: TunnelGateway;
  /**
   * Substituted in tests. The default publishes over the connector control
   * channel that {@link createConnectorModule} owns.
   */
  readonly publisher?: RoutePublisher;
  readonly destinationPolicy?: DestinationPolicy;
  /** Injected by tests; the filesystem driver is the default (ADR-0012). */
  readonly artefactStore?: ArtefactStore;
  /** Injected by tests so the worker channel can be driven in-process. */
  readonly workerFetch?: typeof fetch;
  readonly now?: () => Date;
  /**
   * Where structured logs are written. Production leaves it unset, which sends
   * them to standard output; tests supply a collector so that they can assert
   * on the records the server actually emitted.
   */
  readonly logDestination?: LogDestination;
}

export interface BuiltApp {
  readonly app: FastifyInstance;
  readonly connectors: ConnectorModule;
  readonly publishedServices: PublishedServiceService;
  readonly artefacts: ArtefactService;
  readonly reviews: ReviewService;
  readonly sessions: BrowserSessionService;
  readonly workers: WorkerRegistry;
  readonly viewers: ViewerSessionStore;
  readonly relay: LiveRelay;
  readonly agentCredentials: AgentCredentialStore;
  readonly agentSessions: AgentSessionStore;
  readonly workspaces: WorkspaceStore;
  readonly idempotency: IdempotencyStore;
  /** Starts every listener the server owns. */
  start(): Promise<void>;
  /** Stops every listener. The pool is owned by the caller. */
  stop(): Promise<void>;
}

export async function buildApp(options: BuildAppOptions): Promise<BuiltApp> {
  const { config, pool } = options;
  const app = Fastify({
    logger: {
      level: config.logLevel,
      ...(options.logDestination === undefined ? {} : { stream: options.logDestination }),
      // docs/SECURITY.md section 18: no authorisation headers or cookies in
      // logs. Removal rather than masking, so the value cannot be recovered.
      redact: { paths: ["req.headers.authorization", "req.headers.cookie"], remove: true },
    },
    // The request identifier is a correlation ID (docs/ARCHITECTURE.md section
    // 15) and appears in every response envelope.
    requestIdHeader: "x-request-id",
    genReqId: () => `req_${Math.random().toString(36).slice(2, 14)}`,
    // docs/ARCHITECTURE.md section 4.1: request-size limits belong on the
    // ingress path. The largest legitimate body is an artefact upload, so the
    // limit is that bound plus room for the surrounding request rather than a
    // number chosen independently of what the API accepts.
    bodyLimit: config.artefactMaxBytes + 65_536,
    // Trusting a proxy header would let a caller choose the address the server
    // attributes a request to. Nothing here needs the client address.
    trustProxy: false,
  });

  app.setErrorHandler(renderError);
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => {
    try {
      await pool.query("select 1");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  const connectors = await createConnectorModule(app, {
    pool,
    bootstrapToken: config.bootstrapToken,
    logLevel: config.logLevel,
    ...(options.connectorConfig === undefined ? {} : { config: options.connectorConfig }),
    ...(options.logDestination === undefined ? {} : { logDestination: options.logDestination }),
  });

  const gateway =
    options.gateway ??
    new HttpTunnelGateway({
      baseUrl: config.gatewayControlUrl,
      token: config.gatewayControlToken,
    });

  const publishedServices = new PublishedServiceService(
    pool,
    gateway,
    options.publisher ?? new ConnectorRoutePublisher(connectors.channels),
    {
      organisationId: connectors.config.organisationId,
      destinationPolicy: options.destinationPolicy ?? STAGE_0_DESTINATION_POLICY,
      internalSuffix: config.internalSuffix,
      routeTtlMaxSeconds: config.routeTtlMaxSeconds,
      maxRoutesPerConnector: 10,
      capabilityKeyId: config.capabilityKeyId,
      capabilityKey: config.capabilityKey,
      capabilityTtlSeconds: config.capabilityTtlSeconds,
    },
    options.now,
  );

  registerPublishedServiceRoutes(app, {
    service: publishedServices,
    authenticate: requireBootstrapAdministrator(config.bootstrapToken),
  });

  // Reconnect reconciliation (`docs/CONNECTOR_PROTOCOL.md` §17). It is supplied
  // to the connector module rather than constructed inside it, because deciding
  // the fate of a route needs the gateway and the published-service records,
  // and the connector module owns neither.
  connectors.useReconciler(
    new PublishedServiceReconciler(
      pool,
      gateway,
      {
        organisationId: connectors.config.organisationId,
        upgrade: {
          minimumVersion: connectors.config.minimumConnectorVersion,
          recommendedVersion: connectors.config.recommendedConnectorVersion,
        },
      },
      connectors.listener.log,
      options.now ?? ((): Date => new Date()),
    ),
  );

  const store = options.artefactStore ?? new FilesystemArtefactStore(config.artefactPath);
  const artefacts = new ArtefactService(pool, store, config.artefactMaxBytes);
  const reviews = new ReviewService(pool, artefacts);
  const workers = new WorkerRegistry(pool, config.workerCredential);
  const workerClient = new BrowserWorkerClient({
    endpoint: config.workerEndpoint,
    credential: config.workerCommandCredential,
    timeoutMs: config.workerRequestTimeoutMs,
    ...(options.workerFetch === undefined ? {} : { fetchImplementation: options.workerFetch }),
  });
  // A browser session learns its egress origin and its route capability from
  // the published-service record, never from its caller.
  const sessions = new BrowserSessionService(
    pool,
    workers,
    workerClient,
    new PublishedServiceBinder(publishedServices),
  );
  const viewers = new ViewerSessionStore(pool);
  const liveClient = new WorkerLiveClient({
    endpoint: config.workerEndpoint,
    credential: config.workerCommandCredential,
    ...(options.workerFetch === undefined ? {} : { fetchImplementation: options.workerFetch }),
  });
  const relay = new LiveRelay({
    client: liveClient,
    logger: {
      info: (message, fields) => {
        app.log.info(fields ?? {}, message);
      },
      warn: (message, fields) => {
        app.log.warn(fields ?? {}, message);
      },
    },
  });
  const viewerAuth = async (request: Parameters<typeof resolveViewer>[0]) =>
    resolveViewer(request, { viewers, bootstrapToken: config.bootstrapToken });

  const agentCredentials = new AgentCredentialStore(pool);
  const workspaces = new WorkspaceStore(pool);
  const agentSessions = new AgentSessionStore(pool, workspaces);
  const idempotency = new IdempotencyStore(pool);

  /**
   * Resolves an agent credential for the evidence-reading half of ADR-0019.
   *
   * It answers with the sessions the credential currently owns, so a grant
   * minted for one agent session is redeemable only by the credential that
   * opened it. Nothing else on this server accepts an agent credential.
   */
  const agentAuth = async (
    request: Parameters<typeof resolveViewer>[0],
  ): Promise<AgentArtefactPrincipal | null> => {
    const credential = await agentCredentials.resolve(bearerToken(request));
    if (credential === null) return null;
    const rows = await pool.query<{ id: string }>(
      "SELECT id FROM agent_sessions WHERE credential_id = $1 AND ended_at IS NULL",
      [credential.id],
    );
    return {
      credentialId: credential.id,
      organisationId: credential.organisationId,
      projectIds: new Set(credential.projectIds),
      sessionIds: new Set(rows.rows.map((row) => row.id)),
      display: credential.label,
    };
  };


  await registerProjectRoutes(app, {
    pool,
    bootstrapToken: config.bootstrapToken,
    workerCredential: config.workerCredential,
    viewerAuth,
  });
  await registerArtefactRoutes(app, {
    pool,
    artefacts,
    workers,
    bootstrapToken: config.bootstrapToken,
    workerCredential: config.workerCredential,
    maxBytes: config.artefactMaxBytes,
    viewerAuth,
    agentAuth,
  });
  await registerReviewRoutes(app, { pool, reviews, viewerAuth });
  await registerAgentRoutes(app, {
    pool,
    credentials: agentCredentials,
    workspaces,
    bootstrapToken: config.bootstrapToken,
    workerCredential: config.workerCredential,
    viewerAuth,
  });
  await registerBrowserSessionRoutes(app, {
    sessions,
    workers,
    bootstrapToken: config.bootstrapToken,
    workerCredential: config.workerCredential,
    viewerAuth,
  });
  await registerLiveRoutes(app, {
    pool,
    sessions,
    relay,
    viewers,
    bootstrapToken: config.bootstrapToken,
    workerCredential: config.workerCredential,
    allowedOrigins: config.allowedOrigins,
    secureCookies: config.secureCookies,
  });

  return {
    app,
    connectors,
    publishedServices,
    artefacts,
    reviews,
    sessions,
    workers,
    viewers,
    relay,
    agentCredentials,
    agentSessions,
    workspaces,
    idempotency,
    async start(): Promise<void> {
      await app.listen({ host: config.host, port: config.port });
      await connectors.start();
    },
    async stop(): Promise<void> {
      await connectors.stop();
      await app.close();
    },
  };
}
