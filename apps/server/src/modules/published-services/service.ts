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
   *
   * **Every identifier in the request is resolved inside the caller's
   * organisation and project.** The project was resolved in the caller's scope
   * before this was called, and for a while that was the only thing that was:
   * `connector_id`, `workspace_id` and `allowed_browser_session_ids` came
   * straight from a request body and were written to the row unexamined. Two
   * things followed. A caller in one organisation could name another
   * organisation's connector and fill it to its route limit, with the rows
   * invisible to the victim because the listing is project scoped. And a caller
   * could name another organisation's *browser session*, after which `mint`
   * would issue a real signed capability for it — because the only check `mint`
   * made was against this same caller-supplied list, which made
   * "session-scoped" a property the caller asserted rather than one the control
   * plane enforced. The gateway and the connector both re-check the session
   * against that list too, so all three layers agreed with the attacker.
   *
   * `apps/mcp-server/src/development-services.ts` never had either defect,
   * because the agent surface has no member for a connector or a session and
   * resolves both from the session's project. This is the same rule, applied
   * where the identifiers can be supplied.
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
      // Resolved, not trusted. Each of the three is scoped to the organisation
      // and the project the caller was already authorised for, and each answers
      // identically whether the identifier belongs to somebody else or to
      // nobody (`docs/API.md` §5).
      const connector = await repository.findPublishableConnector(client, {
        connectorId: input.connectorId,
        organisationId: input.organisationId,
        projectId: input.projectId,
      });
      if (connector === null) {
        // `findPublishableConnector` now carries `status = 'ACTIVE'` as a term
        // (RVP-81). Both publication surfaces reach this function, so the rule
        // is written once rather than twice that must agree — and it is applied
        // before a row, a `published_service.requested` event or a connector
        // exchange exists, so a revoked identity cannot reach any of them.
        //
        // The refusal is diagnosed rather than left as "not found". Only on this
        // path, and only inside the same tenancy terms: a connector in another
        // organisation is still absent, and the caller still receives the
        // refusal an unknown identifier earns.
        throw await this.#explainConnectorRefusal(client, input);
      }
      const workspace = await repository.findWorkspaceInProject(client, {
        workspaceId: input.workspaceId,
        organisationId: input.organisationId,
        projectId: input.projectId,
      });
      if (workspace === null) {
        // The class the connector protocol gives this condition (§21), so one
        // failure has one code whether it is caught here or at the far end.
        throw new ApiError("WORKSPACE_NOT_FOUND", "No such workspace in this project.", {
          field: "workspace_id",
        });
      }
      const reachable = new Set(
        await repository.findBrowserSessionsInProject(client, {
          browserSessionIds: input.allowedBrowserSessionIds,
          organisationId: input.organisationId,
          projectId: input.projectId,
        }),
      );
      // Every one of them, not at least one. A route authorising four sessions
      // of which one belongs elsewhere is a route that mints a capability for
      // that one.
      const unreachable = input.allowedBrowserSessionIds.filter((id) => !reachable.has(id));
      if (unreachable.length > 0) {
        throw new ApiError(
          "RESOURCE_NOT_FOUND",
          "A browser session named here does not belong to this project.",
          { field: "allowed_browser_session_ids" },
        );
      }

      const carried = await repository.countReadyForConnector(
        client,
        input.connectorId,
        input.organisationId,
      );
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
   * Names the condition a refused connector is in, having already been refused.
   *
   * `IDENTITY_REVOKED` and `CONNECTOR_OFFLINE` are distinguished on purpose and
   * `docs/CONNECTOR_PROTOCOL.md` §21 defines both: a revoked identity will not
   * come back and the route must be published through another connector, while a
   * connector the deployment has and cannot reach is worth waiting for. Both
   * carry `details.connector_status`, so a caller can tell `DEGRADED` from
   * `DISCONNECTED` without a second call.
   *
   * It changes no decision — the refusal stands whichever branch is taken — and
   * it is reached only after the scoped read has already refused, so it cannot
   * admit anything that read excluded.
   */
  async #explainConnectorRefusal(
    client: PoolClient,
    input: { readonly connectorId: string; readonly organisationId: string; readonly projectId: string },
  ): Promise<ApiError> {
    const known = await repository.findConnectorStatusInScope(client, {
      connectorId: input.connectorId,
      organisationId: input.organisationId,
      projectId: input.projectId,
    });
    if (known === null) {
      return new ApiError("RESOURCE_NOT_FOUND", "No such connector in this project.", {
        field: "connector_id",
      });
    }
    if (known.status === "REVOKED") {
      return new ApiError(
        "IDENTITY_REVOKED",
        "This connector's identity has been revoked, so it may not carry a route. Enrol the development machine again, or publish through another connector.",
        { field: "connector_id", connector_status: known.status },
      );
    }
    return new ApiError(
      "CONNECTOR_OFFLINE",
      "This connector is not connected, so there is nothing to publish through. It reconnects on its own; retry once it reports.",
      { field: "connector_id", connector_status: known.status },
    );
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
            // The status the record was actually in. The sweep now reaches a
            // route that expired while still `requested` as well as a live one,
            // and recording a status it was never in would be a fact an auditor
            // cannot see through (`docs/EVENTS.md` §7).
            published_service_id: service.id,
            previous_status: service.status,
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
    // And the session must actually belong to the route's project. The check
    // above compares against the list stored on the record, which `request` now
    // validates — but this is the last gate before a signed credential exists,
    // and it should not depend on a row written by an earlier release having
    // been validated by the rules of this one. A record published before that
    // validation existed is refused here rather than honoured.
    //
    // The same read returns the session's own lifetime, because the bound below
    // needs it and a second query could answer about a different session.
    const session = await this.#pool.connect().then(async (client) => {
      try {
        return await repository.findSessionLifetime(client, {
          browserSessionId,
          organisationId: service.organisation_id,
          projectId: service.project_id,
        });
      } finally {
        client.release();
      }
    });
    if (session === null) {
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
    // A capability may not outlive the route it authorises, and may not outlive
    // the browser session it was minted for (ADR-0037).
    //
    // The session bound is the control this decision actually adds, and it is
    // the one that holds without depending on anything outside the control
    // plane. A session's maximum duration is already the deployment's statement
    // of how long that browser may exist, and a credential that outlives the
    // browser it was minted for is a credential nobody is accounting for. The
    // revocation this change also performs is best effort — the gateway's
    // revocation set is in memory and does not survive a restart (RVP-76) — so
    // this bound is what stands when that fails, and it stands without the
    // gateway's cooperation.
    //
    // A session whose `limits` carry no maximum contributes no bound rather than
    // an instant expiry: the column is `jsonb` and an older row could lack the
    // member, and turning a missing bound into a zero-length credential would
    // make an upgrade look like a route failure.
    const bounds = [now.getTime() + requested * 1000, service.expires_at.getTime()];
    if (session.max_duration_seconds !== null) {
      bounds.push(session.created_at.getTime() + session.max_duration_seconds * 1000);
    }
    const expiresAt = new Date(Math.min(...bounds));
    if (expiresAt <= now) {
      // Which of the two bounds ran out is the difference between republishing
      // the route and starting a new browser session, so the refusal says.
      const sessionExhausted =
        session.max_duration_seconds !== null &&
        session.created_at.getTime() + session.max_duration_seconds * 1000 <= now.getTime();
      if (sessionExhausted) {
        throw new ApiError(
          "BROWSER_SESSION_NOT_ACTIVE",
          "This browser session has reached its maximum duration, and a route capability may not outlive the session it was minted for. Start a new session.",
        );
      }
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
      const recorded = await repository.insertCapability(client, {
        id: capabilityId,
        organisationId: service.organisation_id,
        projectId: service.project_id,
        publishedServiceId: service.id,
        browserSessionId,
        keyId: capability.keyId,
        issuedAt: now,
        expiresAt,
      });
      if (recorded === null) {
        // The session ended between the authorisation read and this insert. The
        // token exists only in this stack frame and is discarded with it: the
        // transaction rolls back, nothing is returned, and no worker is ever
        // handed a credential for a browser that has gone.
        throw new ApiError(
          "BROWSER_SESSION_NOT_ACTIVE",
          "This browser session ended before its route capability could be recorded, so none was issued.",
        );
      }
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
   * Resolves a route a browser session may be admitted to, in one query, and
   * refuses on the state it finds.
   *
   * The route identifier, the session identifier, the caller's organisation and
   * the caller's project scope are four terms of one predicate
   * ({@link repository.findBindableRoute}), so a route or a session outside the
   * caller's tenancy is **absent** and earns the refusal an unknown identifier
   * earns, byte for byte (`docs/API.md` §5). Nothing is returned and then
   * refused by a later branch for a tenancy reason.
   *
   * What *is* refused after the read is state, and each refusal names a
   * different act to take next: republish the route, wait for the connector,
   * enrol the machine again, or publish a route that names this session.
   */
  async readBindable(input: {
    readonly publishedServiceId: string;
    readonly browserSessionId: string;
    readonly scope: repository.CallerScope;
  }): Promise<repository.BindableRoute> {
    const client: PoolClient = await this.#pool.connect();
    let route: repository.BindableRoute | null;
    try {
      route = await repository.findBindableRoute(client, {
        publishedServiceId: input.publishedServiceId,
        browserSessionId: input.browserSessionId,
        organisationId: input.scope.organisationId,
        projectIds: input.scope.projectIds,
      });
    } finally {
      client.release();
    }
    if (route === null) throw new ApiError("RESOURCE_NOT_FOUND", "No such published service.");
    if (route.route_status !== "ready") {
      throw new ApiError(
        "PUBLISHED_SERVICE_UNAVAILABLE",
        "This published service is not carrying traffic.",
        { status: route.route_status, published_service_id: route.published_service_id },
      );
    }
    if (route.connector_status !== "ACTIVE") {
      // The same two classes `request` refuses a publication with, for the same
      // reason and with the same detail. A route whose connector has gone is a
      // route that carries nothing, and admitting a session to it would produce
      // a browser that reaches an origin nothing answers on — which an agent
      // reads as a fault in the application it is reviewing.
      throw route.connector_status === "REVOKED"
        ? new ApiError(
            "IDENTITY_REVOKED",
            "The connector carrying this route has had its identity revoked, so the route reaches nothing. Publish through another connector.",
            {
              connector_status: route.connector_status,
              published_service_id: route.published_service_id,
            },
          )
        : new ApiError(
            "CONNECTOR_OFFLINE",
            "The connector carrying this route is not connected, so the route reaches nothing. It reconnects on its own; retry once it reports.",
            {
              connector_status: route.connector_status,
              published_service_id: route.published_service_id,
            },
          );
    }
    if (!route.session_authorised) {
      // The allow-list is written by `request`, which validates every session
      // named in it against the route's own project. A route is never amended to
      // add one: re-registering a route identifier at the gateway resurrects
      // capabilities already revoked against it (RVP-76), and it would grant
      // reach to a credential that could not have published the route.
      throw new ApiError(
        "AUTHORISATION_DENIED",
        "That browser session is not authorised for this published service. A route names the sessions it authorises when it is published; reserve a session first and publish a route that names it.",
        { published_service_id: route.published_service_id },
      );
    }
    return route;
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

  /**
   * Withdraws every live capability minted for one browser session, and tells
   * the gateway.
   *
   * The gateway is told **first**, for the reason revocation and reconnect
   * reconciliation already give: marking a record closed while the gateway still
   * carried it turns a closure into a claim.
   *
   * **This is best effort and is described as such everywhere it is mentioned.**
   * The gateway verifies a capability from its signature without a database
   * read, and RVP-76 records that its revocation set is in memory and does not
   * survive a restart. So a revocation recorded here is durable in the control
   * plane and not necessarily at the gateway: a deployment that restarts its
   * gateway between a revocation and a capability's natural expiry has a revoked
   * capability the gateway would accept again. The TTL bound {@link mint}
   * applies is what limits that window; RVP-99 is what closes it.
   *
   * A gateway that refuses is logged and not raised. This runs on the way out of
   * a session — from `terminate`, from a failed reservation and from a
   * worker-reported failure — and a termination that failed because the gateway
   * was unreachable would leave a session running that a human asked to stop,
   * which is worse than a capability that expires on its own.
   */
  async revokeCapabilitiesForSession(browserSessionId: string): Promise<string[]> {
    const client: PoolClient = await this.#pool.connect();
    let live: string[];
    try {
      live = await repository.findLiveCapabilitiesForSession(client, browserSessionId);
    } finally {
      client.release();
    }
    if (live.length === 0) return [];
    for (const capabilityId of live) {
      await this.#gateway.revokeCapability(capabilityId).catch(() => undefined);
    }
    return inTransaction(this.#pool, async (transaction) =>
      repository.revokeCapabilitiesForSession(transaction, browserSessionId),
    );
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
