/**
 * Published-service commands.
 *
 * This is the control plane's half of the Stage 0 publication loop: validate,
 * persist, tell the gateway, record the event. The gateway enforces; this
 * decides.
 *
 * The connector's own `route.publish` exchange of `docs/CONNECTOR_PROTOCOL.md`
 * section 11 travels on the control channel, which `services/connector` and the
 * connector-enrolment work own. It is reached through {@link RoutePublisher} so
 * that it can be plugged in without touching this file: today the default
 * implementation reports the destination as published, and the connector's own
 * validation still applies at the far end because
 * `datachannel.ValidatePublication` runs there.
 */

import { randomUUID } from "node:crypto";

import { mintCapability } from "@reviewplane/protocol";

import type { Pool, PoolClient } from "../../db/pool.ts";
import { inTransaction } from "../../db/pool.ts";
import { evaluateDestination } from "./destination-policy.ts";
import type { DestinationPolicy } from "./destination-policy.ts";
import { ApiError } from "../../errors.ts";
import { appendEvent } from "../../events/append.ts";
import type { EventActor } from "./events.ts";
import type { GatewayRouteView, TunnelGateway } from "./gateway-client.ts";
import * as repository from "./repository.ts";
import type { PublishedService } from "./repository.ts";

/**
 * The connector-facing publication step.
 *
 * It answers with the destination the connector reported it opened, or refuses
 * with a stable class from `docs/CONNECTOR_PROTOCOL.md` section 21.
 */
export interface RoutePublisher {
  publish(input: {
    readonly routeId: string;
    readonly projectId: string;
    readonly connectorId: string;
    readonly workspaceId: string;
    readonly localHost: string;
    readonly localPort: number;
    readonly protocol: string;
    readonly expiresAt: Date;
    readonly allowedBrowserSessionIds: readonly string[];
  }): Promise<{ readonly observedDestination: string }>;
}

/**
 * The Stage 0 publisher.
 *
 * The control channel that carries `route.publish` to a connector is built by
 * the connector-enrolment work. Until it exists, the destination the control
 * plane authorised is the destination of record, and the connector still
 * refuses anything its own policy forbids when a stream arrives. Substituting
 * the real publisher is a constructor argument, not a change here.
 */
export class DirectRoutePublisher implements RoutePublisher {
  publish(input: {
    readonly localHost: string;
    readonly localPort: number;
  }): Promise<{ readonly observedDestination: string }> {
    const host = input.localHost.includes(":") ? `[${input.localHost}]` : input.localHost;
    return Promise.resolve({ observedDestination: `${host}:${String(input.localPort)}` });
  }
}

export interface PublishedServiceConfig {
  readonly organisationId: string;
  readonly destinationPolicy: DestinationPolicy;
  readonly internalSuffix: string;
  readonly routeTtlMaxSeconds: number;
  readonly maxRoutesPerConnector: number;
  readonly capabilityKeyId: string;
  readonly capabilityKey: Uint8Array;
  readonly capabilityTtlSeconds: number;
}

export interface CreatePublishedServiceInput {
  readonly projectId: string;
  readonly connectorId: string;
  readonly workspaceId: string;
  readonly localHost: string;
  readonly localPort: number;
  readonly protocol: string;
  readonly ttlSeconds: number;
  readonly allowedBrowserSessionIds: readonly string[];
}

export interface PublishedServiceView {
  readonly id: string;
  readonly project_id: string;
  readonly connector_id: string;
  readonly workspace_id: string;
  readonly local_host: string;
  readonly local_port: number;
  readonly protocol: string;
  readonly public_alias: string;
  readonly internal_origin: string;
  readonly scope: string;
  readonly allowed_browser_session_ids: readonly string[];
  readonly expires_at: string;
  readonly status: string;
  readonly failure_class: string | null;
  readonly observed_destination: string | null;
}

export interface MintedCapability {
  readonly capability_id: string;
  readonly capability: string;
  readonly browser_session_id: string;
  readonly internal_origin: string;
  readonly expires_at: string;
}

export class PublishedServiceService {
  readonly #pool: Pool;
  readonly #gateway: TunnelGateway;
  readonly #publisher: RoutePublisher;
  readonly #config: PublishedServiceConfig;
  readonly #now: () => Date;

  constructor(
    pool: Pool,
    gateway: TunnelGateway,
    publisher: RoutePublisher,
    config: PublishedServiceConfig,
    now: () => Date = () => new Date(),
  ) {
    this.#pool = pool;
    this.#gateway = gateway;
    this.#publisher = publisher;
    this.#config = config;
    this.#now = now;
  }

  view(service: PublishedService): PublishedServiceView {
    return {
      id: service.id,
      project_id: service.project_id,
      connector_id: service.connector_id,
      workspace_id: service.workspace_id,
      local_host: service.local_host,
      local_port: service.local_port,
      protocol: service.protocol,
      public_alias: service.public_alias,
      internal_origin: this.#origin(service.public_alias),
      scope: service.scope,
      allowed_browser_session_ids: service.allowed_browser_session_ids,
      expires_at: service.expires_at.toISOString(),
      status: service.status,
      failure_class: service.failure_class,
      observed_destination: service.observed_destination,
    };
  }

  #origin(alias: string): string {
    return `https://${alias}.${this.#config.internalSuffix}/`;
  }

  /**
   * Creates a published service.
   *
   * The order matters. The destination policy runs first, so a refused
   * destination never reaches a row, an event or the gateway. The record is
   * then written as `requested` and only becomes `ready` once the gateway has
   * accepted it, so a route the gateway will not carry is never advertised as
   * usable.
   */
  async create(
    input: CreatePublishedServiceInput,
    actor: EventActor,
    requestId: string,
  ): Promise<PublishedServiceView> {
    if (input.allowedBrowserSessionIds.length === 0) {
      // docs/CONNECTOR_PROTOCOL.md section 11: a route no session may use is
      // not published.
      throw new ApiError("VALIDATION_FAILED",
        "A published service must authorise at least one browser session.",
        { field: "allowed_browser_session_ids" },
      );
    }
    if (input.allowedBrowserSessionIds.length > 32) {
      throw new ApiError("VALIDATION_FAILED",
        "A published service may authorise at most 32 browser sessions.",
        { field: "allowed_browser_session_ids" },
      );
    }
    if (input.ttlSeconds <= 0 || input.ttlSeconds > this.#config.routeTtlMaxSeconds) {
      // The lifetime is refused before the route exists, so this is a rejected
      // request rather than a conflict with an existing route: the class stays
      // ROUTE_EXPIRED, the status is the one for an unacceptable body.
      throw new ApiError(
        "ROUTE_EXPIRED",
        "The requested route lifetime is not permitted.",
        { max_ttl_seconds: this.#config.routeTtlMaxSeconds },
        422,
      );
    }
    const rejection = evaluateDestination(this.#config.destinationPolicy, {
      host: input.localHost,
      port: input.localPort,
      protocol: input.protocol,
    });
    if (rejection !== null) {
      throw new ApiError("DESTINATION_NOT_ALLOWED",
        "That local destination may not be published.",
        { reason: rejection },
      );
    }

    const id = `svc_${randomUUID().replaceAll("-", "")}`;
    // The alias is the internal origin's leftmost label, so it must be a DNS
    // label. It is derived from a fresh identifier rather than from the route
    // identifier, which conventionally carries an underscore, and rather than
    // from anything the caller supplied.
    const publicAlias = `svc-${randomUUID().replaceAll("-", "")}`;
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);

    await inTransaction(this.#pool, async (client) => {
      const carried = await repository.countReadyForConnector(client, input.connectorId);
      if (carried >= this.#config.maxRoutesPerConnector) {
        throw new ApiError("ROUTE_LIMIT_EXCEEDED",
          "This connector already carries the maximum number of routes.",
          { max_routes: this.#config.maxRoutesPerConnector },
        );
      }
      await repository.insertRequested(client, {
        id,
        organisationId: this.#config.organisationId,
        projectId: input.projectId,
        connectorId: input.connectorId,
        workspaceId: input.workspaceId,
        publicAlias,
        localHost: input.localHost,
        localPort: input.localPort,
        protocol: input.protocol,
        allowedBrowserSessionIds: input.allowedBrowserSessionIds,
        expiresAt,
      });
      await appendEvent(client, {
        type: "published_service.requested",
        organisationId: this.#config.organisationId,
        projectId: input.projectId,
        actor,
        correlation: { request_id: requestId, published_service_id: id, connector_id: input.connectorId },
        payload: {
          published_service_id: id,
          connector_id: input.connectorId,
          workspace_id: input.workspaceId,
          local_host: input.localHost,
          local_port: input.localPort,
          protocol: input.protocol,
          public_alias: publicAlias,
          expires_at: expiresAt.toISOString(),
          allowed_browser_session_ids: input.allowedBrowserSessionIds,
          new_status: "requested",
        },
        occurredAt: now,
      });
    });

    try {
      const { observedDestination } = await this.#publisher.publish({
        routeId: id,
        projectId: input.projectId,
        connectorId: input.connectorId,
        workspaceId: input.workspaceId,
        localHost: input.localHost,
        localPort: input.localPort,
        protocol: input.protocol,
        expiresAt,
        allowedBrowserSessionIds: input.allowedBrowserSessionIds,
      });
      const registered: GatewayRouteView = await this.#gateway.register({
        route_id: id,
        project_id: input.projectId,
        connector_id: input.connectorId,
        workspace_id: input.workspaceId,
        public_alias: publicAlias,
        local_host: input.localHost,
        local_port: input.localPort,
        protocol: input.protocol,
        scope: "browser_session",
        expires_at: expiresAt.toISOString(),
        allowed_browser_session_ids: input.allowedBrowserSessionIds,
        observed_destination: observedDestination,
      });

      return await inTransaction(this.#pool, async (client) => {
        const ready = await repository.markReady(client, id, registered.observed_destination);
        if (ready === null) {
          throw new ApiError("PUBLISHED_SERVICE_UNAVAILABLE", "This route is no longer pending.");
        }
        await appendEvent(client, {
          type: "published_service.ready",
          organisationId: this.#config.organisationId,
          projectId: input.projectId,
          actor,
          correlation: { request_id: requestId, published_service_id: id, connector_id: input.connectorId },
          payload: {
            published_service_id: id,
            previous_status: "requested",
            new_status: "ready",
            observed_destination: registered.observed_destination,
            internal_origin: registered.internal_origin,
            connector_connected: registered.connector_connected,
          },
          occurredAt: this.#now(),
        });
        return this.view(ready);
      });
    } catch (error) {
      const failureClass = error instanceof ApiError && typeof error.code === "string"
        ? error.code
        : "CONTROL_PLANE_UNAVAILABLE";
      await inTransaction(this.#pool, async (client) => {
        const failed = await repository.markFailed(client, id, failureClass);
        if (failed === null) return;
        await appendEvent(client, {
          type: "published_service.failed",
          organisationId: this.#config.organisationId,
          projectId: input.projectId,
          actor,
          correlation: { request_id: requestId, published_service_id: id },
          payload: {
            published_service_id: id,
            previous_status: "requested",
            new_status: "failed",
            // Reason codes for failure, per docs/EVENTS.md section 8. No free
            // text: the class is the diagnosis.
            error_class: failureClass,
          },
          occurredAt: this.#now(),
        });
      });
      throw error;
    }
  }

  async list(projectId: string, limit: number): Promise<PublishedServiceView[]> {
    const client = await this.#pool.connect();
    try {
      const records = await repository.listForProject(client, projectId, limit);
      return records.map((record) => this.view(record));
    } finally {
      client.release();
    }
  }

  /**
   * Revokes a route immediately.
   *
   * The gateway is told first. Marking the record revoked while the gateway
   * still carried the route would leave the tunnel open with the control plane
   * believing it closed, which is the one ordering that turns a revocation into
   * a lie.
   */
  async revoke(serviceId: string, actor: EventActor, requestId: string): Promise<PublishedServiceView> {
    const existing = await this.#read(serviceId);
    await this.#gateway.revokeRoute(serviceId);
    return await inTransaction(this.#pool, async (client) => {
      const ended = await repository.markEnded(client, serviceId, "revoked");
      if (ended === null) {
        // Already ended. Revocation is idempotent and produces no second event.
        return this.view(existing);
      }
      const revokedCapabilities = await repository.revokeCapabilitiesForService(client, serviceId);
      await appendEvent(client, {
        type: "published_service.revoked",
        organisationId: this.#config.organisationId,
        projectId: ended.project_id,
        actor,
        correlation: {
          request_id: requestId,
          published_service_id: serviceId,
          connector_id: ended.connector_id,
        },
        payload: {
          published_service_id: serviceId,
          previous_status: existing.status,
          new_status: "revoked",
          revoked_capability_ids: revokedCapabilities,
        },
        occurredAt: this.#now(),
      });
      return this.view(ended);
    });
  }

  /**
   * Expires every route whose lifetime has run out.
   *
   * The gateway expires independently from the same `expires_at`, so a route is
   * unreachable at its expiry instant whether or not this sweep has run. This
   * is what makes the record agree with reality and produces the
   * `published_service.expired` event.
   */
  async expireDue(limit = 100): Promise<PublishedServiceView[]> {
    const now = this.#now();
    const client = await this.#pool.connect();
    let due: PublishedService[];
    try {
      due = await repository.findDueForExpiry(client, now, limit);
    } finally {
      client.release();
    }

    const expired: PublishedServiceView[] = [];
    for (const service of due) {
      await this.#gateway.revokeRoute(service.id);
      const view = await inTransaction(this.#pool, async (transaction) => {
        const ended = await repository.markEnded(transaction, service.id, "expired");
        if (ended === null) return null;
        await repository.revokeCapabilitiesForService(transaction, service.id);
        await appendEvent(transaction, {
          type: "published_service.expired",
          organisationId: this.#config.organisationId,
          projectId: ended.project_id,
          actor: { type: "system" },
          correlation: { published_service_id: service.id, connector_id: ended.connector_id },
          payload: {
            published_service_id: service.id,
            previous_status: "ready",
            new_status: "expired",
            expires_at: ended.expires_at.toISOString(),
          },
          occurredAt: now,
        });
        return this.view(ended);
      });
      if (view !== null) expired.push(view);
    }
    return expired;
  }

  /**
   * Mints a session-scoped capability for a route.
   *
   * The control plane is the minting authority and the gateway is the verifier,
   * so this is the only place a capability comes into existence. It is bound to
   * the route, the project and one browser session, and it expires; all three
   * bindings are inside the signature, which is what lets the gateway refuse a
   * cross-project or cross-session presentation without a lookup.
   */
  async mint(
    serviceId: string,
    browserSessionId: string,
    ttlSeconds: number | undefined,
    actor: EventActor,
    requestId: string,
  ): Promise<MintedCapability> {
    const service = await this.#read(serviceId);
    if (service.status !== "ready") {
      throw new ApiError("PUBLISHED_SERVICE_UNAVAILABLE",
        "This published service is not carrying traffic.",
        { status: service.status },
      );
    }
    if (!service.allowed_browser_session_ids.includes(browserSessionId)) {
      // The route names the sessions it authorises. Minting for another one
      // would produce a capability the gateway must then refuse, which is a
      // rejection the control plane should have made itself.
      throw new ApiError("AUTHORISATION_DENIED",
        "That browser session is not authorised for this published service.",
      );
    }
    const now = this.#now();
    const requested = ttlSeconds ?? this.#config.capabilityTtlSeconds;
    if (requested <= 0 || requested > this.#config.capabilityTtlSeconds) {
      throw new ApiError("VALIDATION_FAILED", "The requested capability lifetime is not permitted.", {
        max_ttl_seconds: this.#config.capabilityTtlSeconds,
      });
    }
    // A capability may not outlive the route it authorises.
    const expiresAt = new Date(
      Math.min(now.getTime() + requested * 1000, service.expires_at.getTime()),
    );
    if (expiresAt <= now) {
      throw new ApiError("ROUTE_EXPIRED", "This published service has expired.");
    }

    const capabilityId = `cap_${randomUUID().replaceAll("-", "")}`;
    const token = mintCapability(this.#config.capabilityKey, {
      keyId: this.#config.capabilityKeyId,
      capabilityId,
      routeId: service.id,
      projectId: service.project_id,
      browserSessionId,
      issuedAt: Math.floor(now.getTime() / 1000),
      expiresAt: Math.floor(expiresAt.getTime() / 1000),
    });

    await inTransaction(this.#pool, async (client) => {
      await repository.insertCapability(client, {
        id: capabilityId,
        organisationId: this.#config.organisationId,
        projectId: service.project_id,
        publishedServiceId: service.id,
        browserSessionId,
        keyId: this.#config.capabilityKeyId,
        issuedAt: now,
        expiresAt,
      });
      await appendEvent(client, {
        type: "published_service.ready",
        organisationId: this.#config.organisationId,
        projectId: service.project_id,
        actor,
        correlation: {
          request_id: requestId,
          published_service_id: service.id,
          browser_session_id: browserSessionId,
        },
        payload: {
          published_service_id: service.id,
          // The identifier, never the token. docs/EVENTS.md section 8 excludes
          // raw secrets, and the identifier is what revocation and audit need.
          capability_id: capabilityId,
          browser_session_id: browserSessionId,
          key_id: this.#config.capabilityKeyId,
          expires_at: expiresAt.toISOString(),
        },
        occurredAt: now,
      });
    });

    return {
      capability_id: capabilityId,
      // reveal() is called exactly here, at the boundary where the credential
      // is handed to its bearer. Everywhere else the value is redacted.
      capability: token.reveal(),
      browser_session_id: browserSessionId,
      internal_origin: this.#origin(service.public_alias),
      expires_at: expiresAt.toISOString(),
    };
  }

  async #read(serviceId: string): Promise<PublishedService> {
    const client: PoolClient = await this.#pool.connect();
    try {
      const service = await repository.findById(client, serviceId);
      if (service === null) {
        throw new ApiError("RESOURCE_NOT_FOUND", "No such published service.");
      }
      return service;
    } finally {
      client.release();
    }
  }
}
