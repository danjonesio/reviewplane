/**
 * The project event stream (`docs/API.md` section 18.1, `docs/EVENTS.md`
 * section 10).
 *
 * ```text
 * /ws/v1/projects/:projectId/events
 * ```
 *
 * The order of work on an upgrade is the point of this file, and it mirrors the
 * live-frame channel deliberately:
 *
 *   1. the origin is checked, so another site cannot open this socket with the
 *      user's cookie;
 *   2. the viewer session is resolved from the cookie or the administrator
 *      token;
 *   3. the project is resolved **within the viewer's scope**, so a project the
 *      viewer may not see is indistinguishable from one that does not exist;
 *   4. only then is the socket accepted.
 *
 * Step 3 is a security decision rather than an ergonomic one. `RVP-9` and
 * `docs/SECURITY.md` require that a refusal must not disclose the existence of
 * a resource in another project: a foreign project identifier answers
 * `RESOURCE_NOT_FOUND`, never `AUTHORISATION_DENIED`, because the second answer
 * confirms the project exists.
 *
 * After the upgrade the subscriber sends `stream.subscribe` with the last
 * sequence it applied. The server attaches to the live bus *before* it replays,
 * buffering what arrives meanwhile, so the handover from history to live
 * delivery loses nothing; and it discards buffered events at or below the last
 * replayed sequence, so it duplicates nothing.
 */

import websocketPlugin from "@fastify/websocket";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import {
  decodeStreamMessage,
  encodeStreamMessage,
  type StreamRefreshRequiredReason,
} from "@reviewplane/protocol/platform";

import { ApiError, notFound } from "../errors.ts";
import type { ViewerPrincipal } from "../modules/live/viewer-sessions.ts";
import { EventStreamReader, type EventBus, type StoredEvent } from "./stream.ts";

/** Largest replay this server will perform before telling a client to refresh. */
export const MAX_REPLAY_EVENTS = 1000;

/** How often a quiet stream is reminded that the socket is alive. */
const HEARTBEAT_INTERVAL_MS = 25_000;

/** Bound on a client message. A subscribe frame is a few hundred bytes. */
const MAX_CLIENT_MESSAGE_BYTES = 4096;

/**
 * Largest number of live events buffered while a replay is in flight.
 *
 * A subscriber that cannot keep up is told to refresh rather than allowed to
 * grow the server's memory: the durable record is `events`, and refetching from
 * it is always available.
 */
const MAX_LIVE_BUFFER = 2000;

export interface EventStreamRoutesOptions {
  readonly pool: Pool;
  readonly bus: EventBus;
  readonly viewerAuth: (request: FastifyRequest) => Promise<ViewerPrincipal>;
  readonly allowedOrigins: readonly string[];
  readonly heartbeatIntervalMs?: number;
}

interface ProjectRow {
  readonly id: string;
  readonly organisation_id: string;
}

export async function registerEventStreamRoutes(
  app: FastifyInstance,
  options: EventStreamRoutesOptions,
): Promise<void> {
  const reader = new EventStreamReader(options.pool);
  const heartbeatMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;

  // The live-frame channel may have registered the plugin already; Fastify
  // treats a second registration of the same plugin as an error, and both
  // channels want the same socket options anyway.
  if (!app.hasDecorator("websocketServer")) {
    await app.register(websocketPlugin, {
      options: { maxPayload: MAX_CLIENT_MESSAGE_BYTES, perMessageDeflate: false },
    });
  }

  interface UpgradeContext {
    readonly principal: ViewerPrincipal;
    readonly project: ProjectRow;
  }

  const contexts = new WeakMap<FastifyRequest, UpgradeContext>();

  const authoriseUpgrade = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const origin = request.headers.origin;
    if (typeof origin === "string" && !options.allowedOrigins.includes(origin)) {
      await reply.status(403).send({
        error: { code: "AUTHORISATION_DENIED", message: "This origin may not open an event stream." },
        meta: { request_id: request.id },
      });
      return;
    }

    const principal = await options.viewerAuth(request);
    const { projectId } = request.params as { projectId: string };

    // Scope is applied in the query, not after it. A project outside the
    // viewer's scope produces no row, and the refusal is therefore the same one
    // an unknown identifier produces — which is what stops the API confirming
    // that another organisation's project exists.
    const rows =
      principal.projectIds === null
        ? await options.pool.query<ProjectRow>(
            "select id, organisation_id from projects where id = $1",
            [projectId],
          )
        : await options.pool.query<ProjectRow>(
            "select id, organisation_id from projects where id = $1 and id = any($2)",
            [projectId, [...principal.projectIds]],
          );
    const project = rows.rows[0];
    if (project === undefined) throw notFound("The project");
    if (
      principal.organisationId !== null &&
      principal.organisationId !== project.organisation_id
    ) {
      throw notFound("The project");
    }

    contexts.set(request, { principal, project });
  };

  interface RawSocket {
    readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    on(event: string, listener: (...args: never[]) => void): void;
  }

  const OPEN = 1;

  app.get(
    "/ws/v1/projects/:projectId/events",
    { websocket: true, preValidation: authoriseUpgrade },
    (socket, request) => {
      const context = contexts.get(request);
      if (context === undefined) {
        socket.close(1011, "authorisation context missing");
        return;
      }
      runSubscriber(socket as unknown as RawSocket, request, context);
    },
  );

  function runSubscriber(
    socket: RawSocket,
    request: FastifyRequest,
    context: UpgradeContext,
  ): void {
    const streamKey = context.project.id;
    let unsubscribe: (() => void) | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    let subscribed = false;
    let closed = false;
    /** Events that arrived live while a replay was still running. */
    let buffer: StoredEvent[] | null = null;
    let delivered = 0;

    const send = (payload: string): void => {
      if (socket.readyState === OPEN) socket.send(payload);
    };

    const sendEvent = (event: StoredEvent): void => {
      send(JSON.stringify(event));
      delivered = Math.max(delivered, event.sequence);
    };

    const refuse = (code: string, message: string, retryable: boolean): void => {
      send(
        encodeStreamMessage({
          type: "stream.error",
          code: code as "INTERNAL_ERROR",
          message,
          retryable,
        }),
      );
    };

    const instructRefresh = (
      reason: StreamRefreshRequiredReason,
      currentSequence: number,
      earliestAvailableSequence: number,
    ): void => {
      send(
        encodeStreamMessage({
          type: "stream.refresh_required",
          reason,
          current_sequence: currentSequence,
          earliest_available_sequence: earliestAvailableSequence,
        }),
      );
    };

    const close = (): void => {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      unsubscribe = null;
      if (heartbeat !== null) clearInterval(heartbeat);
      heartbeat = null;
    };

    socket.on("close", close as never);
    socket.on("error", close as never);

    socket.on("message", ((raw: Buffer) => {
      void handleMessage(raw);
    }) as never);

    async function handleMessage(raw: Buffer): Promise<void> {
      const decoded = decodeStreamMessage(new Uint8Array(raw));
      if (!decoded.ok) {
        refuse(decoded.error.errorClass ?? "VALIDATION_FAILED", decoded.error.message, false);
        socket.close(1008, decoded.error.reason);
        return;
      }
      if (decoded.value.type !== "stream.subscribe") {
        refuse(
          "UNSUPPORTED_CAPABILITY",
          "Only stream.subscribe may be sent by a subscriber on this channel.",
          false,
        );
        socket.close(1008, "unexpected message");
        return;
      }
      if (subscribed) {
        refuse("UNSUPPORTED_CAPABILITY", "This subscription is already established.", false);
        return;
      }
      subscribed = true;
      await establish(decoded.value.last_sequence, decoded.value.max_replay ?? MAX_REPLAY_EVENTS);
    }

    async function establish(lastSequence: number, maxReplay: number): Promise<void> {
      let position;
      try {
        position = await reader.position(streamKey);
      } catch (error) {
        request.log.error({ err: error }, "event stream could not read its position");
        refuse("INTERNAL_ERROR", "The event stream is unavailable.", true);
        socket.close(1011, "stream unavailable");
        return;
      }

      // Attach before replaying. Anything committed between the replay's read
      // and the attachment would otherwise fall in the gap between the two.
      buffer = [];
      unsubscribe = options.bus.subscribe(streamKey, (event) => {
        if (buffer !== null) {
          if (buffer.length >= MAX_LIVE_BUFFER) return;
          buffer.push(event);
          return;
        }
        if (event.sequence <= delivered) return;
        sendEvent(event);
      });

      const gap = position.currentSequence - lastSequence;
      const aheadOfStream = lastSequence > position.currentSequence;
      const belowWindow =
        position.earliestAvailableSequence > 0 &&
        lastSequence > 0 &&
        lastSequence < position.earliestAvailableSequence - 1;
      const overLimit = gap > Math.min(maxReplay, MAX_REPLAY_EVENTS);

      let replaying = !aheadOfStream && !belowWindow && !overLimit && gap > 0;
      send(
        encodeStreamMessage({
          type: "stream.subscribed",
          project_id: streamKey,
          current_sequence: position.currentSequence,
          earliest_available_sequence: position.earliestAvailableSequence,
          replaying,
        }),
      );

      if (aheadOfStream || belowWindow || overLimit) {
        const reason: StreamRefreshRequiredReason = aheadOfStream
          ? "sequence_ahead_of_stream"
          : belowWindow
            ? "replay_window_exceeded"
            : "replay_limit_exceeded";
        instructRefresh(reason, position.currentSequence, position.earliestAvailableSequence);
        // The client refetches state and resumes from `current_sequence`, so
        // live delivery starts there rather than from where it asked.
        delivered = position.currentSequence;
        replaying = false;
      } else if (replaying) {
        try {
          const history = await reader.replay(streamKey, lastSequence, MAX_REPLAY_EVENTS);
          for (const event of history) sendEvent(event);
        } catch (error) {
          request.log.error({ err: error }, "event stream replay failed");
          refuse("INTERNAL_ERROR", "The event stream could not be replayed.", true);
          socket.close(1011, "replay failed");
          return;
        }
      } else {
        delivered = Math.max(delivered, lastSequence);
      }

      // Drain what arrived while replaying, dropping anything already sent.
      const pending = buffer ?? [];
      buffer = null;
      for (const event of pending) {
        if (event.sequence <= delivered) continue;
        sendEvent(event);
      }

      heartbeat = setInterval(() => {
        void (async () => {
          try {
            const now = await reader.position(streamKey);
            send(
              encodeStreamMessage({
                type: "stream.heartbeat",
                current_sequence: now.currentSequence,
                sent_at: new Date().toISOString(),
              }),
            );
          } catch {
            // A heartbeat that cannot read the position says nothing useful;
            // the next one will, or the socket will close.
          }
        })();
      }, heartbeatMs);
      heartbeat.unref();
    }
  }

  app.addHook("onClose", async () => {
    await Promise.resolve();
  });
}

/** Re-exported so a caller does not need to know which module owns the error. */
export { ApiError };
