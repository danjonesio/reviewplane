/**
 * Application composition.
 *
 * This file wires modules together and does nothing else: no domain rule, no
 * query and no authorisation arithmetic lives here. Each domain owns a
 * directory under `src/modules/`, and adding one is a registration call here
 * rather than an edit to shared code.
 */

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

import { requireBootstrapToken } from "./auth/bootstrap-token.ts";
import type { Database } from "./db/pool.ts";
import { STAGE_0_DESTINATION_POLICY } from "./modules/published-services/destination-policy.ts";
import type { DestinationPolicy } from "./modules/published-services/destination-policy.ts";
import { HttpTunnelGateway } from "./modules/published-services/gateway-client.ts";
import type { TunnelGateway } from "./modules/published-services/gateway-client.ts";
import {
  registerPublishedServiceRoutes,
  renderError,
} from "./modules/published-services/routes.ts";
import {
  DirectRoutePublisher,
  PublishedServiceService,
} from "./modules/published-services/service.ts";
import type { RoutePublisher } from "./modules/published-services/service.ts";
import type { ServerConfig } from "./config.ts";

export interface BuildAppOptions {
  readonly config: ServerConfig;
  readonly pool: Database;
  /** Substituted in tests; defaults to the HTTP client. */
  readonly gateway?: TunnelGateway;
  /** Substituted when the connector control channel exists. */
  readonly publisher?: RoutePublisher;
  readonly destinationPolicy?: DestinationPolicy;
  readonly now?: () => Date;
}

export interface BuiltApp {
  readonly app: FastifyInstance;
  readonly publishedServices: PublishedServiceService;
}

export function buildApp(options: BuildAppOptions): BuiltApp {
  const { config, pool } = options;
  const app = Fastify({
    logger: { level: config.logLevel },
    // The request identifier is a correlation ID (docs/ARCHITECTURE.md section
    // 15) and appears in every response envelope.
    requestIdHeader: "x-request-id",
    genReqId: () => `req_${Math.random().toString(36).slice(2, 14)}`,
    // A caller must not be able to make the server allocate an unbounded body.
    bodyLimit: 1 << 20,
    // Trusting a proxy header would let a caller choose the address the server
    // attributes a request to. Nothing here needs the client address.
    trustProxy: false,
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
      // Organisations arrive with the issue that introduces them. Stage 0 is a
      // single organisation, named explicitly rather than left null so that
      // every row already carries the column docs/DOMAIN_MODEL.md section 3
      // requires for defence-in-depth filtering.
      organisationId: "org_stage0",
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

  app.setErrorHandler(renderError);
  app.get("/healthz", async (_request, reply) => reply.send({ data: { status: "ok" } }));
  registerPublishedServiceRoutes(app, {
    service: publishedServices,
    authenticate: requireBootstrapToken(config.bootstrapToken),
  });

  return { app, publishedServices };
}
