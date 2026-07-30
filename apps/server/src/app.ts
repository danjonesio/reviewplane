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

import { requireBootstrapAdministrator } from "./auth/bootstrap-token.ts";
import type { LogDestination, ServerConfig } from "./config.ts";
import type { Pool } from "./db/pool.ts";
import { renderError } from "./errors.ts";
import { createConnectorModule } from "./modules/connectors/index.ts";
import type { ConnectorModule, ConnectorModuleConfig } from "./modules/connectors/index.ts";
import { STAGE_0_DESTINATION_POLICY } from "./modules/published-services/destination-policy.ts";
import type { DestinationPolicy } from "./modules/published-services/destination-policy.ts";
import { HttpTunnelGateway } from "./modules/published-services/gateway-client.ts";
import type { TunnelGateway } from "./modules/published-services/gateway-client.ts";
import { registerPublishedServiceRoutes } from "./modules/published-services/routes.ts";
import { DirectRoutePublisher, PublishedServiceService } from "./modules/published-services/service.ts";
import type { RoutePublisher } from "./modules/published-services/service.ts";

export interface BuiltApp {
  readonly app: FastifyInstance;
  readonly connectors: ConnectorModule;
  readonly publishedServices: PublishedServiceService;
  /** Starts every listener the server owns. */
  start(): Promise<void>;
  /** Stops every listener. The pool is owned by the caller. */
  stop(): Promise<void>;
}

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
  readonly now?: () => Date;
  /**
   * Where structured logs are written. Production leaves it unset, which sends
   * them to standard output; tests supply a collector so that they can assert
   * on the records the server actually emitted.
   */
  readonly logDestination?: LogDestination;
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
    // ingress path. 1 MiB is ample for the administrative JSON bodies this
    // surface accepts.
    bodyLimit: 1 << 20,
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
    options.publisher ?? new DirectRoutePublisher(),
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

  return {
    app,
    connectors,
    publishedServices,
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
