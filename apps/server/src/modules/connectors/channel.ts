/**
 * The connector-facing WebSocket endpoints.
 *
 * Two routes on one mutually authenticated listener:
 *
 * - `/connector/v1/enrol` carries the registration exchange. No client
 *   certificate exists yet, so none is required; the enrolment token is the
 *   credential, and it is used exactly here and nowhere else.
 * - `/connector/v1/control` carries the `control` and `heartbeat` channels.
 *   It requires a client certificate issued by the control-plane CA, so an
 *   unauthenticated or wrong-identity connection is refused before the upgrade
 *   (`docs/CONNECTOR_PROTOCOL.md` §5, `docs/SECURITY.md` §6.2).
 *
 * A refusal is signalled by closing with WebSocket code 1008 and a reason equal
 * to a `docs/CONNECTOR_PROTOCOL.md` §21 error class. That keeps the refusal
 * vocabulary identical on both sides without inventing a message type the
 * version 1 schema does not define.
 */

import type { TLSSocket } from "node:tls";

import { decodeControlFrame, encodeControlFrame, MESSAGE_DIRECTIONS } from "@reviewplane/protocol";
import type { ReconnectRequest, ReconnectResponse } from "@reviewplane/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "@fastify/websocket";

import type { Pool } from "../../db/pool.ts";
import type { TlsMaterial } from "./certificate-authority.ts";
import { newMessageId } from "./identifiers.ts";
import type { ControlChannelRegistry } from "./publication.ts";
import type { ConnectorReconciler } from "./reconciliation.ts";
import { CONTROL_PATH, ENROLMENT_PATH, type ConnectorModuleConfig } from "./config.ts";
import { enrol, EnrolmentRefused } from "./enrolment.ts";
import { certificateFingerprint } from "./x509.ts";
import {
  findConnectorByFingerprint,
  recordHeartbeat,
  transitionConnector,
  type ConnectorRecord,
} from "./repository.ts";

/** WebSocket close codes used here (RFC 6455 §7.4.1). */
const CLOSE = {
  normal: 1000,
  invalidPayload: 1007,
  policyViolation: 1008,
  messageTooBig: 1009,
  internalError: 1011,
} as const;

/**
 * Hard bound on an inbound WebSocket message, applied by the WebSocket layer
 * before the protocol decoder sees it. The protocol's own 65 536-byte
 * control-frame bound is enforced by `decodeControlFrame`; this larger bound
 * exists so that a frame between the two is still refused by our own code with
 * its own reason, rather than being silently dropped by the transport.
 */
export const MAX_INBOUND_MESSAGE_BYTES = 1 << 20;

/** Maps a protocol refusal reason onto a close code. */
function closeCodeForReason(reason: string): number {
  switch (reason) {
    case "frame_too_large":
    case "payload_too_large":
      return CLOSE.messageTooBig;
    case "unsupported_protocol_version":
    case "unknown_message_type":
      return CLOSE.policyViolation;
    default:
      return CLOSE.invalidPayload;
  }
}

export interface ChannelContext {
  readonly pool: Pool;
  readonly config: ConnectorModuleConfig;
  readonly authority: TlsMaterial;
  /**
   * Registers work that must finish before the module shuts down. A control
   * socket writes its `connector.disconnected` event after the socket closes,
   * and dropping that write on shutdown would lose an audit record that
   * `AGENTS.md` requires.
   */
  readonly track?: (work: Promise<unknown>) => void;
  /**
   * Where a live control channel is registered so that route publication can
   * reach it (`docs/CONNECTOR_PROTOCOL.md` §11).
   */
  readonly channels?: ControlChannelRegistry;
  /**
   * Reconnect reconciliation (`docs/CONNECTOR_PROTOCOL.md` §17). A channel
   * without one answers every reconnect by continuing nothing, which is the
   * safe default: a route this control plane cannot vouch for is not one the
   * connector may keep serving.
   */
  readonly reconciler?: ConnectorReconciler | undefined;
}

/** The verified peer identity of a control connection, or null. */
function peerFingerprint(request: FastifyRequest): string | null {
  const socket = request.raw.socket as TLSSocket;
  if (typeof socket.getPeerCertificate !== "function") return null;
  if (socket.authorized !== true) return null;
  const certificate = socket.getPeerCertificate();
  if (certificate === null || certificate.raw === undefined) return null;
  return certificateFingerprint(Buffer.from(certificate.raw));
}

function messageBuffer(payload: unknown): Buffer {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof ArrayBuffer) return Buffer.from(payload);
  if (Array.isArray(payload)) return Buffer.concat(payload.map((part) => Buffer.from(part as Buffer)));
  return Buffer.from(String(payload), "utf8");
}

/**
 * Buffers frames that arrive before the handler is ready, and then delivers
 * them one at a time.
 *
 * Identifying the peer takes a database round trip, and a connector may send
 * its first heartbeat as soon as the socket opens. Without this queue that
 * frame is emitted before any listener exists and is silently lost — which is
 * precisely what `docs/CONNECTOR_PROTOCOL.md` §7 forbids: a frame is refused or
 * handled, never dropped. Serial delivery additionally keeps one connector's
 * frames in order and bounds how much work a burst can start at once.
 */
class FrameQueue {
  /** Frames buffered before the consumer exists. A burst beyond this is refused. */
  static readonly MAX_PENDING = 32;

  readonly #pending: Buffer[] = [];
  #consumer: ((raw: Buffer) => Promise<void>) | null = null;
  #draining = false;
  #overflowed = false;

  /** Reports whether the queue overflowed while waiting for a consumer. */
  get overflowed(): boolean {
    return this.#overflowed;
  }

  push(raw: Buffer): void {
    if (this.#pending.length >= FrameQueue.MAX_PENDING) {
      this.#overflowed = true;
      return;
    }
    this.#pending.push(raw);
    void this.#drain();
  }

  setConsumer(consumer: (raw: Buffer) => Promise<void>): void {
    this.#consumer = consumer;
    void this.#drain();
  }

  async #drain(): Promise<void> {
    if (this.#draining || this.#consumer === null) return;
    this.#draining = true;
    try {
      for (let next = this.#pending.shift(); next !== undefined; next = this.#pending.shift()) {
        await this.#consumer(next);
      }
    } finally {
      this.#draining = false;
    }
  }
}

/** Where the pre-upgrade guard leaves the identity it authenticated. */
const AUTHENTICATED = Symbol("reviewplane.connector");

interface AuthenticatedRequest extends FastifyRequest {
  [AUTHENTICATED]?: { connector: ConnectorRecord; fingerprint: string };
}

export function registerConnectorChannels(app: FastifyInstance, context: ChannelContext): void {
  app.get(ENROLMENT_PATH, { websocket: true }, (socket, request) => {
    handleEnrolmentSocket(socket, request, context);
  });

  app.get(
    CONTROL_PATH,
    {
      websocket: true,
      // The identity is checked before the upgrade, so an unauthenticated or
      // wrong-identity connection never becomes a WebSocket
      // (docs/CONNECTOR_PROTOCOL.md section 5.2). The refusal body is the
      // stable error class, which is the same vocabulary a close would carry.
      preValidation: async (request: FastifyRequest, reply) => {
        const fingerprint = peerFingerprint(request);
        if (fingerprint === null) {
          request.log.warn("refusing a control connection with no verified client certificate");
          await reply.code(401).type("text/plain").send("IDENTITY_REVOKED");
          return;
        }
        const connector = await findConnectorByFingerprint(context.pool, fingerprint);
        if (connector === null || connector.revokedAt !== null || connector.status === "REVOKED") {
          // Fail closed: an identity the control plane cannot vouch for is
          // refused, and the connector must not retry with it
          // (docs/CONNECTOR_PROTOCOL.md section 18).
          request.log.warn(
            { certificate_fingerprint: fingerprint },
            "refusing a revoked or unknown connector identity",
          );
          await reply.code(401).type("text/plain").send("IDENTITY_REVOKED");
          return;
        }
        (request as AuthenticatedRequest)[AUTHENTICATED] = { connector, fingerprint };
      },
    },
    (socket, request) => {
      // Both listeners are attached synchronously, before any await, so neither
      // a frame nor a close can be missed while the channel is set up.
      const queue = new FrameQueue();
      socket.on("message", (data: unknown) => {
        queue.push(messageBuffer(data));
      });
      const closed = new Promise<void>((resolveClosed) => {
        socket.on("close", () => {
          resolveClosed();
        });
      });
      const work = handleControlSocket(socket, request, context, queue, closed);
      context.track?.(work);
      void work;
    },
  );
}

function handleEnrolmentSocket(socket: WebSocket, request: FastifyRequest, context: ChannelContext): void {
  let handled = false;
  const log = request.log.child({ connector_channel: "enrol" });

  socket.on("message", (data: unknown) => {
    if (handled) {
      socket.close(CLOSE.policyViolation, "PROTOCOL_UNSUPPORTED");
      return;
    }
    handled = true;
    const work = (async () => {
      const raw = messageBuffer(data);
      if (raw.length > MAX_INBOUND_MESSAGE_BYTES) {
        log.warn({ bytes: raw.length }, "refusing an oversized enrolment frame");
        socket.close(CLOSE.messageTooBig, "");
        return;
      }
      const decoded = decodeControlFrame(raw);
      if (!decoded.ok) {
        log.warn({ reason: decoded.error.reason }, "refusing an enrolment frame");
        socket.close(closeCodeForReason(decoded.error.reason), decoded.error.errorClass ?? "");
        return;
      }
      if (decoded.value.type !== "connector.registration.request") {
        log.warn({ message_type: decoded.value.type }, "refusing a non-registration frame on the enrolment channel");
        socket.close(CLOSE.policyViolation, "PROTOCOL_UNSUPPORTED");
        return;
      }
      try {
        const outcome = await enrol(context, decoded.value.payload, { requestId: request.id });
        log.info(
          {
            connector_id: outcome.connectorId,
            environment_id: outcome.environmentId,
            certificate_fingerprint: outcome.certificateFingerprint,
          },
          "connector enrolled",
        );
        socket.send(outcome.frame);
        socket.close(CLOSE.normal, "");
      } catch (error) {
        if (error instanceof EnrolmentRefused) {
          // The reason is logged; the connector receives the stable class only.
          log.warn({ error_class: error.errorClass, reason: error.reason }, "enrolment refused");
          socket.close(CLOSE.policyViolation, error.errorClass);
          return;
        }
        log.error({ err: error }, "enrolment failed");
        socket.close(CLOSE.internalError, "");
      }
    })();
    context.track?.(work);
    void work;
  });

  socket.on("error", (error: Error) => {
    log.warn({ err: error }, "enrolment socket error");
  });
}

async function handleControlSocket(
  socket: WebSocket,
  request: FastifyRequest,
  context: ChannelContext,
  queue: FrameQueue,
  closed: Promise<void>,
): Promise<void> {
  const authenticated = (request as AuthenticatedRequest)[AUTHENTICATED];
  if (authenticated === undefined) {
    // Unreachable while the guard above runs, and a refusal rather than an
    // assumption if it ever does not.
    request.log.error("a control socket opened without an authenticated identity");
    socket.close(CLOSE.policyViolation, "IDENTITY_REVOKED");
    return;
  }
  const { connector, fingerprint } = authenticated;

  const log = request.log.child({
    connector_id: connector.id,
    environment_id: connector.environmentId,
    connector_channel: "control",
  });

  await markConnected(context, connector, log);
  log.info({ certificate_fingerprint: fingerprint }, "connector control channel established");

  // The channel becomes publishable only once the identity is confirmed, so a
  // publication can never be sent down a socket whose peer is unknown.
  context.channels?.register(connector.id, socket);
  void closed.then(() => {
    context.channels?.unregister(connector.id, socket);
  });

  if (queue.overflowed) {
    log.warn("refusing a connector that sent more frames than the channel will buffer");
    socket.close(CLOSE.messageTooBig, "");
    return;
  }

  queue.setConsumer(async (raw) => {
    if (raw.length > MAX_INBOUND_MESSAGE_BYTES) {
      log.warn({ bytes: raw.length }, "refusing an oversized control frame");
      socket.close(CLOSE.messageTooBig, "");
      return;
    }
    const decoded = decodeControlFrame(raw);
    if (!decoded.ok) {
      // Refused, never best-effort parsed
      // (docs/CONNECTOR_PROTOCOL.md section 7 "Rejection"). The untrusted
      // frame body is not echoed into the log.
      log.warn({ reason: decoded.error.reason, bytes: raw.length }, "refusing a control frame");
      socket.close(closeCodeForReason(decoded.error.reason), decoded.error.errorClass ?? "");
      return;
    }
    const frame = decoded.value;
    if (MESSAGE_DIRECTIONS[frame.type] !== "connector_to_control_plane") {
      log.warn({ message_type: frame.type }, "refusing a frame sent in the wrong direction");
      socket.close(CLOSE.policyViolation, "PROTOCOL_UNSUPPORTED");
      return;
    }
    // Defence in depth: the envelope must name the identity the TLS handshake
    // authenticated.
    if (frame.envelope.connector_id !== connector.id) {
      log.warn(
        { claimed_connector_id: frame.envelope.connector_id },
        "refusing a frame attributed to another connector",
      );
      socket.close(CLOSE.policyViolation, "IDENTITY_REVOKED");
      return;
    }

    switch (frame.type) {
      case "heartbeat": {
        await recordHeartbeat(context.pool, connector.id);
        const recovered = await transitionConnector(context.pool, {
          connectorId: connector.id,
          from: ["PENDING_ENROLMENT", "DEGRADED", "DISCONNECTED"],
          to: "ACTIVE",
          eventType: "connector.connected",
          touchConnectedAt: true,
          payload: { trigger: "heartbeat" },
        });
        log.debug(
          {
            status: frame.payload.status,
            uptime_seconds: frame.payload.uptime_seconds,
            active_routes: frame.payload.active_routes,
            active_streams: frame.payload.active_streams,
            recovered: recovered !== null,
          },
          "heartbeat received",
        );
        break;
      }
      case "connector.reconnect.request": {
        await handleReconnect(context, socket, connector, frame.envelope.message_id, frame.payload, log);
        break;
      }
      case "route.publish.ack": {
        // The acknowledgement carries a stable class and no free text, so it
        // is safe to log whole (docs/SECURITY.md section 18).
        const delivered = context.channels?.acknowledge(connector.id, frame.payload) ?? false;
        log.info(
          {
            route_id: frame.payload.route_id,
            status: frame.payload.status,
            error_class: frame.payload.error_class ?? null,
            observed_destination: frame.payload.observed_destination ?? null,
            matched_a_publication: delivered,
          },
          "route acknowledgement",
        );
        break;
      }
      default:
        log.warn({ message_type: frame.type }, "no handler for message type");
        socket.close(CLOSE.policyViolation, "PROTOCOL_UNSUPPORTED");
    }
  });

  socket.on("error", (error: Error) => {
    log.warn({ err: error }, "control socket error");
  });

  await closed;
  const event = await transitionConnector(context.pool, {
    connectorId: connector.id,
    from: ["PENDING_ENROLMENT", "ACTIVE", "DEGRADED"],
    to: "DISCONNECTED",
    eventType: "connector.disconnected",
    payload: { trigger: "channel_closed" },
  });
  // `docs/ARCHITECTURE.md` §14: the routes become unavailable, the affected
  // browser sessions are paused rather than terminated, and their metadata is
  // retained. The route records are deliberately left alone — an unexpired,
  // still authorised route resumes under the same identifier on reconnect.
  try {
    await context.reconciler?.handleDisconnect({
      connectorId: connector.id,
      requestId: String(request.id),
    });
  } catch (error) {
    log.error({ err: error }, "could not record the effect of a connector disconnect");
  }
  log.info({ event_recorded: event !== null }, "connector control channel closed");
}

/**
 * Answers a reconnect with the control plane's authoritative desired state
 * (`docs/CONNECTOR_PROTOCOL.md` §17).
 *
 * The reply is correlated to the request, because the connector accepts a
 * desired state only as the answer to the one it sent. A control plane with no
 * reconciler continues nothing, which is the fail-closed answer: the connector
 * has already withdrawn every route by the time it asks, so a response that
 * names none leaves none being served.
 */
async function handleReconnect(
  context: ChannelContext,
  socket: WebSocket,
  connector: ConnectorRecord,
  messageId: string,
  payload: ReconnectRequest,
  log: FastifyRequest["log"],
): Promise<void> {
  let response: ReconnectResponse;
  if (context.reconciler === undefined) {
    response = {
      reconciled_at: new Date().toISOString(),
      upgrade: "compatible",
      routes: [],
      sessions: [],
    };
  } else {
    try {
      response = await context.reconciler.reconcile({
        connectorId: connector.id,
        request: payload,
        requestId: messageId,
      });
    } catch (error) {
      // A reconciliation that failed must not become a reconciliation that
      // continued everything. The connector is left with no route and retries.
      log.error({ err: error, connector_id: connector.id }, "reconciliation failed");
      socket.close(CLOSE.internalError, "");
      return;
    }
  }
  socket.send(
    encodeControlFrame({
      envelope: {
        protocol_version: 1,
        message_id: newMessageId(),
        type: "connector.reconnect.response",
        sent_at: new Date().toISOString(),
        connector_id: connector.id,
        correlation_id: messageId,
      },
      type: "connector.reconnect.response",
      payload: response,
    }),
  );
}

async function markConnected(
  context: ChannelContext,
  connector: ConnectorRecord,
  log: FastifyRequest["log"],
): Promise<void> {
  const event = await transitionConnector(context.pool, {
    connectorId: connector.id,
    from: ["PENDING_ENROLMENT", "ACTIVE", "DEGRADED", "DISCONNECTED"],
    to: "ACTIVE",
    eventType: "connector.connected",
    touchConnectedAt: true,
    payload: { trigger: "channel_opened" },
  });
  if (event === null) {
    log.warn("the connector could not be marked active");
  }
  await recordHeartbeat(context.pool, connector.id);
}
