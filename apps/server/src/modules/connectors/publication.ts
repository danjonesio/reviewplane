/**
 * Route publication over the connector control channel.
 *
 * `docs/CONNECTOR_PROTOCOL.md` §11 makes publication a request and an
 * acknowledgement on the control channel the connector already holds open. The
 * control plane decides; the connector validates independently and answers
 * `ready` with the destination it observed, or `rejected` with a stable error
 * class from §21.
 *
 * This module is the control-plane half of that exchange. It holds the live
 * channels, sends the request, and waits for the acknowledgement that names the
 * same route. Everything it can go wrong with has a stable code, because
 * `docs/UX_FLOWS.md` §18 requires an actionable cause rather than a generic
 * failure: no channel is `CONNECTOR_OFFLINE`, and a connector that never
 * answers is `CONTROL_PLANE_UNAVAILABLE` rather than an unbounded wait.
 */

import type { RoutePublish, RoutePublishAck } from "@reviewplane/protocol";
import { encodeControlFrame } from "@reviewplane/protocol";

import { ApiError } from "../../errors.ts";
import { newMessageId } from "./identifiers.ts";

/** How long the control plane waits for an acknowledgement. */
export const DEFAULT_PUBLISH_TIMEOUT_MS = 30_000;

/**
 * The socket surface this module needs. `ws` and Fastify both satisfy it.
 *
 * `close` is here because revocation has to reach a channel that is open now:
 * `docs/CONNECTOR_PROTOCOL.md` §18 requires revocation to close the control and
 * data channels, and a revocation that only wrote a row would leave the refused
 * identity serving traffic until it happened to reconnect.
 */
export interface ControlSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface PendingPublication {
  readonly routeId: string;
  resolve(ack: RoutePublishAck): void;
  reject(error: Error): void;
  readonly timer: NodeJS.Timeout;
}

/**
 * The live connector control channels.
 *
 * One connector has at most one channel. A second registration for the same
 * identity replaces the first, because a connector that reconnects after a
 * network drop must not leave a half-dead socket that a publication resolves
 * to.
 */
export class ControlChannelRegistry {
  readonly #channels = new Map<string, ControlSocket>();
  readonly #pending = new Map<string, PendingPublication>();
  readonly #timeoutMs: number;

  constructor(timeoutMs: number = DEFAULT_PUBLISH_TIMEOUT_MS) {
    this.#timeoutMs = timeoutMs;
  }

  /** Registers a connector's channel. */
  register(connectorId: string, socket: ControlSocket): void {
    this.#channels.set(connectorId, socket);
  }

  /** Drops a channel if it is still the current one for that connector. */
  unregister(connectorId: string, socket: ControlSocket): void {
    if (this.#channels.get(connectorId) === socket) {
      this.#channels.delete(connectorId);
    }
    // A publication waiting on a channel that has gone is answered now rather
    // than at its timeout: the connector is demonstrably offline.
    for (const [key, pending] of this.#pending) {
      if (key.startsWith(`${connectorId}:`)) {
        clearTimeout(pending.timer);
        this.#pending.delete(key);
        pending.reject(
          new ApiError("CONNECTOR_OFFLINE", "The connector disconnected before it answered.", {
            connector_id: connectorId,
          }),
        );
      }
    }
  }

  /** Reports whether a connector currently holds a channel. */
  connected(connectorId: string): boolean {
    return this.#channels.has(connectorId);
  }

  /**
   * Takes a connector's channel out of the registry and hands it back, without
   * closing it.
   *
   * Detaching and closing are separate steps because revocation needs the count
   * **before** it writes its audit event and the close **after** it has marked
   * the record (`docs/CONNECTOR_PROTOCOL.md` §18). Doing both at once forced
   * revocation to predict the count from `connected()` and then report a
   * different one to its caller, so the event and the response could disagree
   * about the same fact.
   *
   * Detaching first is safe on its own: a detached channel can no longer receive
   * a publication, and the connector has no reason to reconnect until its socket
   * actually closes.
   */
  detachChannel(connectorId: string): ControlSocket | null {
    const socket = this.#channels.get(connectorId);
    if (socket === undefined) return null;
    this.#channels.delete(connectorId);
    return socket;
  }

  /**
   * Closes a detached channel.
   *
   * The reason is a `docs/CONNECTOR_PROTOCOL.md` §21 error class, because §5.3
   * makes a close code and a class the whole of the refusal vocabulary at
   * version 1. `IDENTITY_REVOKED` is terminal for the connector, so it reports
   * the class and stops rather than reconnecting with a credential this control
   * plane has just refused (§18).
   */
  static closeDetached(socket: ControlSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // A socket the peer had already dropped needed no closing. It is still a
      // channel this connector held and now does not.
    }
  }

  /** Delivers an acknowledgement to whoever is waiting for it. */
  acknowledge(connectorId: string, ack: RoutePublishAck): boolean {
    const key = `${connectorId}:${ack.route_id}`;
    const pending = this.#pending.get(key);
    if (pending === undefined) return false;
    clearTimeout(pending.timer);
    this.#pending.delete(key);
    pending.resolve(ack);
    return true;
  }

  /**
   * Sends a `route.publish` and waits for its acknowledgement.
   *
   * The wait is bounded. An unanswered publication that hung would leave a
   * published-service row in `requested` for ever, and the caller with nothing
   * to report.
   */
  async publish(connectorId: string, request: RoutePublish): Promise<RoutePublishAck> {
    const socket = this.#channels.get(connectorId);
    if (socket === undefined) {
      throw new ApiError(
        "CONNECTOR_OFFLINE",
        "This connector is not connected, so its development service cannot be published.",
        { connector_id: connectorId },
      );
    }
    const key = `${connectorId}:${request.route_id}`;
    if (this.#pending.has(key)) {
      throw new ApiError("IDEMPOTENCY_CONFLICT", "This route is already being published.", {
        route_id: request.route_id,
      });
    }

    const encoded = encodeControlFrame({
      envelope: {
        protocol_version: 1,
        message_id: newMessageId(),
        type: "route.publish",
        sent_at: new Date().toISOString(),
        connector_id: connectorId,
      },
      type: "route.publish",
      payload: request,
    });

    return await new Promise<RoutePublishAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(key);
        reject(
          new ApiError(
            "CONTROL_PLANE_UNAVAILABLE",
            "The connector did not acknowledge this publication.",
            { route_id: request.route_id, timeout_ms: this.#timeoutMs },
          ),
        );
      }, this.#timeoutMs);
      // The timer must not hold the process open on shutdown.
      timer.unref();
      this.#pending.set(key, { routeId: request.route_id, resolve, reject, timer });
      try {
        socket.send(encoded);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(key);
        reject(
          new ApiError("CONNECTOR_OFFLINE", "The connector channel could not carry this publication.", {
            connector_id: connectorId,
            cause: error instanceof Error ? error.name : "unknown",
          }),
        );
      }
    });
  }

  /** Fails every wait, for shutdown. */
  stop(): void {
    for (const [key, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(key);
      pending.reject(
        new ApiError("CONTROL_PLANE_UNAVAILABLE", "The control plane is shutting down."),
      );
    }
    this.#channels.clear();
  }
}
