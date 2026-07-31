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
import { PUBLISHED_SERVICE_FAILURE_CLASS_VALUES } from "@reviewplane/protocol/platform";
import type { PublishedServiceFailureClass } from "@reviewplane/protocol/platform";

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
 * A publisher for tests that are not exercising the connector exchange.
 *
 * It answers with the destination the control plane authorised. Production uses
 * {@link ConnectorRoutePublisher}, which sends `route.publish` down the
 * connector's control channel and waits for the acknowledgement; nothing but a
 * test should be satisfied by an answer the connector never gave.
 */
export class StubRoutePublisher implements RoutePublisher {
  publish(input: {
    readonly localHost: string;
    readonly localPort: number;
  }): Promise<{ readonly observedDestination: string }> {
    const host = input.localHost.includes(":") ? `[${input.localHost}]` : input.localHost;
    return Promise.resolve({ observedDestination: `${host}:${String(input.localPort)}` });
  }
}

export interface PublishedServiceConfig {
  // There is deliberately no `organisationId` here. One existed, and every
  // event and every capability row this service wrote was filed under the
  // deployment's default organisation rather than under the organisation of the
  // project the route belonged to. The organisation now comes from the resolved
  // project on the way in, and from the record the scoped read returned
  // everywhere else.
  readonly destinationPolicy: DestinationPolicy;
  readonly internalSuffix: string;
  readonly routeTtlMaxSeconds: number;
  readonly maxRoutesPerConnector: number;
  /**
   * The capability signing material, present only in a process that mints.
   *
   * The control plane is the minting authority (`docs/ARCHITECTURE.md` §7.3),
   * and minting is what binds a route to one browser session. The MCP endpoint
   * runs in its own process (ADR-0020) and drives no browser session itself, so
   * it holds no signing key: a process that cannot mint cannot leak a minting
   * key, and {@link PublishedServiceService.mint} refuses rather than signing
   * with a placeholder.
   */
  readonly capability?: {
    readonly keyId: string;
    readonly key: Uint8Array;
    readonly ttlSeconds: number;
  };
}

export interface CreatePublishedServiceInput {
  readonly projectId: string;
  /**
   * The organisation the **resolved project** belongs to.
   *
   * It is the project's organisation and never the deployment's default and
   * never the caller's own, because those three can differ and a row whose
   * `organisation_id` and `project_id` name different organisations is one no
   * reader can interpret. `modules/connectors/routes.ts` records the same rule
   * for enrolment tokens; this is the same defect in a different table.
   */
  readonly organisationId: string;
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

/**
 * The scope an internal caller acts in.
 *
 * `complete` and `completePending` run for the deployment rather than for a
 * principal: the record was already authorised when it was requested, and the
 * process finishing it has no session to read a scope from. It is named rather
 * than written inline so that "unscoped" is a deliberate, greppable choice
 * instead of an omission.
 */
const EVERY_SCOPE: repository.CallerScope = { organisationId: null, projectIds: null };

/**
 * The stable class a refusal is recorded under.
 *
 * `published_service_failure_class` in `packages/protocol` is a closed
 * vocabulary, so a code outside it would produce an event no consumer can
 * decode. Anything unrecognised becomes `INTERNAL_ERROR`: an honest "something
 * inside the control plane went wrong" beats an audit record that cannot be
 * read, and the caller still receives the original error.
 */
function failureClassOf(error: unknown): PublishedServiceFailureClass {
  const code = error instanceof ApiError ? error.code : null;
  if (code !== null && (PUBLISHED_SERVICE_FAILURE_CLASS_VALUES as readonly string[]).includes(code)) {
    return code as PublishedServiceFailureClass;
  }
  return "INTERNAL_ERROR";
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
    const requested = await this.request(input, actor, requestId);
    return this.complete(requested.id, actor, requestId);
  }

  /**
   * Phase one: writes the route as `requested`.
   *
   * This is everything publication can decide on its own — the browser-session
   * rule of `docs/CONNECTOR_PROTOCOL.md` §11, the lifetime bound, the
   * destination policy of `docs/SECURITY.md` §9 and the per-connector route
   * limit — and it touches nothing outside PostgreSQL. A refused destination
   * therefore never reaches a row, an event, the connector or the gateway.
   */
  async request(
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

    return await inTransaction(this.#pool, async (client) => {
      const carried = await repository.countReadyForConnector(client, input.connectorId);
      if (carried >= this.#config.maxRoutesPerConnector) {
        throw new ApiError("ROUTE_LIMIT_EXCEEDED",
          "This connector already carries the maximum number of routes.",
          { max_routes: this.#config.maxRoutesPerConnector },
        );
      }
      const record = await repository.insertRequested(client, {
        id,
        organisationId: input.organisationId,
        projectId: input.projectId,
        connectorId: input.connectorId,
        workspaceId: input.workspaceId,
        publicAlias,
        localHost: input.localHost,
        localPort: input.localPort,
        protocol: input.protocol,
        allowedBrowserSessionIds: input.allowedBrowserSessionIds,
        expiresAt,
        requestedAt: now,
      });
      await appendEvent(client, {
        type: "published_service.requested",
        organisationId: input.organisationId,
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
          allowed_browser_session_ids: [...input.allowedBrowserSessionIds],
          new_status: "requested",
        },
        occurredAt: now,
      });
      return this.view(record);
    });
  }

  /**
   * Phase two: asks the connector, registers with the gateway, marks the record
   * `ready`.
   *
   * It is separate from {@link request} because it can only run **where the
   * connector's control channel is**. A connector dials the control plane, so
   * the channel lives in the `api` process and nowhere else; the MCP endpoint
   * is a separate process (ADR-0020) sharing only the database. Splitting the
   * two lets any control-plane process ask for a route and lets the one that
   * holds the channel finish it, without a second credential and without a
   * second network path into the connector (ADR-0021).
   *
   * A refusal at any step leaves the record `failed` carrying the stable class
   * and rethrows it, so the synchronous caller and the audit trail see the same
   * code.
   */
  async complete(
    serviceId: string,
    actor: EventActor,
    requestId: string,
  ): Promise<PublishedServiceView> {
    const record = await this.#read(serviceId, EVERY_SCOPE);
    if (record.status !== "requested") {
      // Somebody else finished it, or it was revoked while it waited. Reporting
      // the record is honest; publishing it a second time would open a second
      // route for one request.
      return this.view(record);
    }
    const organisationId = record.organisation_id;
    const projectId = record.project_id;
    try {
      const { observedDestination } = await this.#publisher.publish({
        routeId: record.id,
        projectId,
        connectorId: record.connector_id,
        workspaceId: record.workspace_id,
        localHost: record.local_host,
        localPort: record.local_port,
        protocol: record.protocol,
        expiresAt: record.expires_at,
        allowedBrowserSessionIds: record.allowed_browser_session_ids,
      });
      const registered: GatewayRouteView = await this.#gateway.register({
        route_id: record.id,
        project_id: projectId,
        connector_id: record.connector_id,
        workspace_id: record.workspace_id,
        public_alias: record.public_alias,
        local_host: record.local_host,
        local_port: record.local_port,
        protocol: record.protocol,
        scope: "browser_session",
        expires_at: record.expires_at.toISOString(),
        allowed_browser_session_ids: [...record.allowed_browser_session_ids],
        observed_destination: observedDestination,
      });

      return await inTransaction(this.#pool, async (client) => {
        const ready = await repository.markReady(client, record.id, registered.observed_destination);
        if (ready === null) {
          throw new ApiError("PUBLISHED_SERVICE_UNAVAILABLE", "This route is no longer pending.");
        }
        await appendEvent(client, {
          type: "published_service.ready",
          organisationId,
          projectId,
          actor,
          correlation: {
            request_id: requestId,
            published_service_id: record.id,
            connector_id: record.connector_id,
          },
          payload: {
            published_service_id: record.id,
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
      const failureClass = failureClassOf(error);
      await inTransaction(this.#pool, async (client) => {
        const failed = await repository.markFailed(client, record.id, failureClass);
        if (failed === null) return;
        await appendEvent(client, {
          type: "published_service.failed",
          organisationId,
          projectId,
          actor,
          correlation: { request_id: requestId, published_service_id: record.id },
          payload: {
            published_service_id: record.id,
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

  /**
   * Finishes routes another process asked for.
   *
   * `docs/CONNECTOR_PROTOCOL.md` §11 requires that nothing is left `requested`
   * for ever, and a route requested by the MCP endpoint has nobody else to
   * finish it: only the process holding the connector's control channel can.
   *
   * `olderThanMs` is what keeps this from racing the synchronous path. A route
   * the API is publishing right now is a few milliseconds old, so the sweep
   * ignores it; by the time a row is older than the grace, the inline attempt
   * has either finished, failed or lost its process. `markReady` and
   * `markFailed` both refuse a record whose status has already moved, so the
   * worst a lost race costs is one wasted acknowledgement rather than two
   * routes for one request.
   */
  async completePending(
    options: { readonly olderThanMs?: number; readonly limit?: number } = {},
  ): Promise<PublishedServiceView[]> {
    const olderThan = new Date(this.#now().getTime() - (options.olderThanMs ?? 2000));
    const client = await this.#pool.connect();
    let pending: PublishedService[];
    try {
      pending = await repository.findPending(client, olderThan, options.limit ?? 50);
    } finally {
      client.release();
    }
    const finished: PublishedServiceView[] = [];
    for (const record of pending) {
      try {
        finished.push(await this.complete(record.id, { type: "system" }, `sweep_${record.id}`));
      } catch {
        // `complete` has already recorded the refusal against the record and
        // written `published_service.failed`. There is no caller to rethrow to
        // here, and a sweep that stopped at the first refusal would leave every
        // later route pending.
        const failed = await this.#pool
          .connect()
          .then(async (connection) => {
            try {
              return await repository.findInScope(connection, {
                id: record.id,
                organisationId: null,
                projectIds: null,
              });
            } finally {
              connection.release();
            }
          });
        if (failed !== null) finished.push(this.view(failed));
      }
    }
    return finished;
  }

  /**
   * Waits, bounded, for a requested route to reach a terminal answer.
   *
   * It is how a caller in a process that cannot finish a publication still gets
   * one answer rather than a record it has to poll for itself. The wait is
   * bounded and ends in the record as it stands: a route still `requested` when
   * the deadline passes is reported as such, never as ready.
   */
  async awaitOutcome(
    serviceId: string,
    scope: repository.CallerScope,
    options: { readonly timeoutMs: number; readonly pollMs?: number },
  ): Promise<PublishedServiceView> {
    const pollMs = options.pollMs ?? 100;
    const deadline = Date.now() + options.timeoutMs;
    for (;;) {
      const record = await this.#read(serviceId, scope);
      if (record.status !== "requested") return this.view(record);
      if (Date.now() >= deadline) return this.view(record);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  async list(
    projectId: string,
    scope: repository.CallerScope,
    limit: number,
  ): Promise<PublishedServiceView[]> {
    const client = await this.#pool.connect();
    try {
      const records = await repository.listInScope(client, {
        projectId,
        organisationId: scope.organisationId,
        projectIds: scope.projectIds,
        limit,
      });
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
   *
   * The scope is the caller's and is applied by the read: a route this
   * principal may not reach is absent, so nothing is sent to the gateway for it
   * and no event is written. The organisation the event is filed under is the
   * **record's**, which the scoped read has already proven the caller may act
   * in.
   */
  async revoke(
    serviceId: string,
    scope: repository.CallerScope,
    actor: EventActor,
    requestId: string,
  ): Promise<PublishedServiceView> {
    const existing = await this.#read(serviceId, scope);
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
        organisationId: ended.organisation_id,
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
          organisationId: ended.organisation_id,
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
    scope: repository.CallerScope,
    actor: EventActor,
    requestId: string,
  ): Promise<MintedCapability> {
    const capability = this.#config.capability;
    if (capability === undefined) {
      // A process with no signing key is not the minting authority. Refusing is
      // the honest answer; signing with a placeholder would produce a token the
      // gateway rejects, and the caller would read that as a route problem.
      throw new ApiError(
        "UNSUPPORTED_CAPABILITY",
        "This process holds no capability signing key and cannot mint route capabilities.",
      );
    }
    const service = await this.#read(serviceId, scope);
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
    const requested = ttlSeconds ?? capability.ttlSeconds;
    if (requested <= 0 || requested > capability.ttlSeconds) {
      throw new ApiError("VALIDATION_FAILED", "The requested capability lifetime is not permitted.", {
        max_ttl_seconds: capability.ttlSeconds,
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
    const token = mintCapability(capability.key, {
      keyId: capability.keyId,
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
        organisationId: service.organisation_id,
        projectId: service.project_id,
        publishedServiceId: service.id,
        browserSessionId,
        keyId: capability.keyId,
        issuedAt: now,
        expiresAt,
      });
      await appendEvent(client, {
        type: "published_service.ready",
        organisationId: service.organisation_id,
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
          key_id: capability.keyId,
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

  /**
   * Reads a route inside a scope, or raises `RESOURCE_NOT_FOUND`.
   *
   * There is no unscoped overload. A caller that genuinely acts for one project
   * — the browser-session binder — passes that project as its scope, and a
   * caller acting for a human passes the session's.
   */
  async read(serviceId: string, scope: repository.CallerScope): Promise<PublishedService> {
    return this.#read(serviceId, scope);
  }

  async #read(serviceId: string, scope: repository.CallerScope): Promise<PublishedService> {
    const client: PoolClient = await this.#pool.connect();
    try {
      const service = await repository.findInScope(client, {
        id: serviceId,
        organisationId: scope.organisationId,
        projectIds: scope.projectIds,
      });
      if (service === null) {
        // Byte-identical to an identifier that does not exist. docs/API.md
        // section 5: the difference between "absent" and "not yours" is the
        // enumeration a cross-organisation caller is looking for.
        throw new ApiError("RESOURCE_NOT_FOUND", "No such published service.");
      }
      return service;
    } finally {
      client.release();
    }
  }
}
