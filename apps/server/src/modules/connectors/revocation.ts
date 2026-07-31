/**
 * Connector revocation (`docs/CONNECTOR_PROTOCOL.md` §18,
 * `docs/DOMAIN_MODEL.md` §8).
 *
 * Revocation is six things at once, and a revocation that did only the first
 * of them would be a revocation in name:
 *
 * 1. the identity is invalidated;
 * 2. the control and data channels are closed;
 * 3. active routes are revoked;
 * 4. associated browser sessions are marked degraded;
 * 5. the agent credentials the identity minted are revoked;
 * 6. an audit event records all of it.
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
 *
 * Step 5 exists because the connector mints credentials of its own (ADR-0023).
 * Refusing the exchange to a revoked identity closes the *next* credential; the
 * ones already handed out live for the rest of their hour unless something
 * revokes them, and ADR-0023 names connector revocation as that something.
 */

import type { FastifyBaseLogger } from "fastify";

import type { Pool } from "../../db/pool.ts";
import { inTransaction } from "../../db/pool.ts";
import { ApiError } from "../../errors.ts";
import { appendEvent } from "../../events/append.ts";
import type { AgentCredentialStore } from "../agents/credentials.ts";
import { ControlChannelRegistry } from "./publication.ts";
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
  readonly agentCredentialsRevoked: number;
  /** False when the connector was already revoked, so nothing changed. */
  readonly changed: boolean;
}

export interface RevocationContext {
  readonly pool: Pool;
  readonly channels: ControlChannelRegistry;
  readonly effects: RevocationEffects | undefined;
  /**
   * Where the credentials this identity minted are revoked.
   *
   * It is held directly rather than behind {@link RevocationEffects} because
   * the connectors module already owns this store: `agent-credentials.ts`
   * issues through it on the connector listener. Routes and browser sessions
   * are another module's records and reach this one through an interface;
   * credentials are this one's own, like the channel registry beside them.
   */
  readonly credentials: AgentCredentialStore;
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

  // The agent credentials this identity minted (ADR-0023). `issued_to_client`
  // carries the connector's identifier, which is what makes the set findable at
  // all; without this the exchange refused a revoked connector's *next*
  // request while every credential it had already handed out kept `review:write`
  // and `finding:write` until it expired.
  //
  // Swept before the record flips, for the reason the routes are: the count the
  // audit event reports is then a count of rows this revocation closed.
  //
  // That ordering leaves a window, and this comment says so rather than
  // claiming otherwise. The exchange refuses a revoked connector because it
  // resolves the record on every request — but the record does not say
  // `REVOKED` until further down, so a credential minted between this sweep and
  // that flip survives a revocation that was meant to end it. It is
  // milliseconds wide and needs a concurrent exchange on the same identity.
  //
  // It is not closed here because the obvious fix trades one inconsistency for
  // another: a second sweep after the flip would catch the race, but
  // `connector.revoked` is written atomically with the flip, so its count would
  // then be a lower bound while the API response reported the total — two
  // numbers for one fact, which is the defect this module's channel counting
  // was repaired for. Closing it properly means the flip and the sweep sharing
  // a transaction, which is a change to `transitionConnector`'s contract rather
  // than a line here. Tracked as a follow-up; the accurate-count argument that
  // justifies ending routes before the flip is about reporting and does not
  // carry to a security sweep, so this is a gap rather than a decision.
  const swept = await context.credentials.revokeIssuedToClient(connector.id);
  const actor =
    input.actor.id === undefined
      ? { type: input.actor.type }
      : { type: input.actor.type, id: input.actor.id };

  for (const credential of swept) {
    // One record per project the credential reached, which is the shape
    // `DELETE /api/v1/agent-credentials/:credentialId` already writes for an
    // administrative revocation: an auditor asking what a project's agent
    // credentials did reads one event type whichever path ended them. The
    // reason distinguishes the two.
    for (const projectId of credential.projectIds) {
      await inTransaction(context.pool, async (client) => {
        await appendEvent(client, {
          type: "session.revoked",
          organisationId: credential.organisationId,
          projectId,
          actor,
          correlation: { request_id: input.requestId, connector_id: connector.id },
          payload: {
            credential_id: credential.id,
            label: credential.label,
            reason: "connector_revoked",
          },
        });
      });
    }
  }

  // Detach, then record, then close. The channel leaves the registry first so
  // that the count in the audit event is the number of channels this revocation
  // actually took — not a prediction from `connected()` that the close could
  // then contradict, which would leave the event and the response disagreeing
  // about the same fact. The socket is closed only after the record says
  // `REVOKED`, so a connector that races the close and reconnects meets a
  // record that already refuses it.
  const detached = context.channels.detachChannel(connector.id);
  const channelsClosed = detached === null ? 0 : 1;

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
      channels_closed: channelsClosed,
      agent_credentials_revoked: swept.length,
    },
  });

  if (detached !== null) {
    ControlChannelRegistry.closeDetached(detached, CLOSE_POLICY_VIOLATION, "IDENTITY_REVOKED");
  }

  context.log.warn(
    {
      connector_id: connector.id,
      environment_id: connector.environmentId,
      routes_revoked: effects.routesRevoked,
      sessions_disconnected: effects.sessionsDisconnected,
      channels_closed: channelsClosed,
      agent_credentials_revoked: swept.length,
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
    agentCredentialsRevoked: swept.length,
    changed: event !== null,
  };
}
