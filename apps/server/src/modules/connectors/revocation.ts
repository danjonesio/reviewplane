/**
 * Connector revocation (`docs/CONNECTOR_PROTOCOL.md` §18,
 * `docs/DOMAIN_MODEL.md` §8).
 *
 * Revocation is five things at once, and a revocation that did only the first
 * of them would be a revocation in name:
 *
 * 1. the identity is invalidated;
 * 2. the control and data channels are closed;
 * 3. active routes are revoked;
 * 4. associated browser sessions are marked degraded;
 * 5. an audit event records all of it.
 *
 * The ordering is deliberate. The record is marked `REVOKED` **first**, because
 * that is what the pre-upgrade guard on the control channel reads: a connector
 * that reconnected in the gap between closing its socket and marking its row
 * would be admitted again. Closing the channel afterwards makes the refusal
 * immediate rather than merely eventual.
 *
 * Step 4 says *degraded*, not *terminated*. `docs/DOMAIN_MODEL.md` §12 has no
 * `DISCONNECTED` browser-session status and forbids `TERMINATED` and `FAILED`
 * for a session that lost its connector: the session and its metadata are
 * retained and remain diagnosable. `DEGRADED` is that state, and it is what
 * "marks associated sessions disconnected" means in this implementation.
 */

import type { FastifyBaseLogger } from "fastify";

import type { Pool } from "../../db/pool.ts";
import { ApiError } from "../../errors.ts";
import type { ControlChannelRegistry } from "./publication.ts";
import { findConnectorInScope, transitionConnector, type ConnectorRecord } from "./repository.ts";

/** WebSocket close code for a policy refusal (RFC 6455 §7.4.1). */
const CLOSE_POLICY_VIOLATION = 1008;

/**
 * What the module that owns routes must do when an identity is revoked.
 *
 * It is an interface for the same reason `ConnectorReconciler` is one: the
 * connector module authenticates and decides, and the published-service module
 * owns routes, the gateway and their events.
 */
export interface RevocationEffects {
  revokeConnectorRoutes(input: {
    readonly connectorId: string;
    readonly requestId: string;
    readonly actor: { readonly type: "human_user" | "system"; readonly id?: string };
  }): Promise<{ readonly routesRevoked: number; readonly sessionsDisconnected: number }>;
}

export interface RevocationOutcome {
  readonly connector: ConnectorRecord;
  readonly revokedAt: Date;
  readonly routesRevoked: number;
  readonly sessionsDisconnected: number;
  readonly channelsClosed: number;
  /** False when the connector was already revoked, so nothing changed. */
  readonly changed: boolean;
}

export interface RevocationContext {
  readonly pool: Pool;
  readonly channels: ControlChannelRegistry;
  readonly effects: RevocationEffects | undefined;
  readonly log: FastifyBaseLogger;
}

/**
 * Revokes one connector identity inside the caller's scope.
 *
 * The lookup carries the identifier, the organisation and the caller's project
 * scope in one predicate, so a connector in another organisation is reported as
 * absent rather than as forbidden and the two are indistinguishable to a caller
 * probing for identifiers (`docs/API.md` §5).
 */
export async function revokeConnectorIdentity(
  context: RevocationContext,
  input: {
    readonly connectorId: string;
    readonly organisationId: string;
    readonly projectIds: readonly string[] | null;
    readonly requestId: string;
    readonly actor: { readonly type: "human_user" | "system"; readonly id?: string };
  },
): Promise<RevocationOutcome> {
  const connector = await findConnectorInScope(context.pool, {
    connectorId: input.connectorId,
    organisationId: input.organisationId,
    projectIds: input.projectIds,
  });
  if (connector === null) {
    throw new ApiError("RESOURCE_NOT_FOUND", "No such connector.");
  }

  // Routes and sessions are ended before the identity flips, so that the two
  // counts the event reports are counts of work that actually happened. A
  // failure here therefore leaves the connector usable rather than leaving it
  // revoked with its routes still carried, which is the direction that is safe
  // to be wrong in.
  const effects = (await context.effects?.revokeConnectorRoutes({
    connectorId: connector.id,
    requestId: input.requestId,
    actor: input.actor,
  })) ?? { routesRevoked: 0, sessionsDisconnected: 0 };

  const event = await transitionConnector(context.pool, {
    connectorId: connector.id,
    from: ["PENDING_ENROLMENT", "ACTIVE", "DEGRADED", "DISCONNECTED"],
    to: "REVOKED",
    eventType: "connector.revoked",
    touchRevokedAt: true,
    actor: input.actor,
    payload: {
      routes_revoked: effects.routesRevoked,
      sessions_disconnected: effects.sessionsDisconnected,
      channels_closed: context.channels.connected(connector.id) ? 1 : 0,
    },
  });

  // The channel is closed after the row says REVOKED, so a connector that races
  // the close and reconnects meets a record that already refuses it.
  const channelsClosed = context.channels.closeChannel(
    connector.id,
    CLOSE_POLICY_VIOLATION,
    "IDENTITY_REVOKED",
  );

  context.log.warn(
    {
      connector_id: connector.id,
      environment_id: connector.environmentId,
      routes_revoked: effects.routesRevoked,
      sessions_disconnected: effects.sessionsDisconnected,
      channels_closed: channelsClosed,
      already_revoked: event === null,
    },
    "connector identity revoked",
  );

  const refreshed = await findConnectorInScope(context.pool, {
    connectorId: connector.id,
    organisationId: input.organisationId,
    projectIds: input.projectIds,
  });
  return {
    connector: refreshed ?? connector,
    revokedAt: refreshed?.revokedAt ?? connector.revokedAt ?? new Date(),
    routesRevoked: effects.routesRevoked,
    sessionsDisconnected: effects.sessionsDisconnected,
    channelsClosed,
    changed: event !== null,
  };
}
