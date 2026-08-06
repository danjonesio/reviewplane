/**
 * Human viewer authentication and the live-frame WebSocket
 * (`docs/API.md` sections 4, 18.2 and 19).
 *
 * The order of work on an upgrade is the point of this file:
 *
 *   1. the origin is checked, so another site cannot open this socket with the
 *      user's cookie;
 *   2. the viewer session is resolved from the cookie;
 *   3. the browser session is loaded and the viewer's project scope is checked
 *      against it;
 *   4. the live-viewer limits of section 19 are taken;
 *   5. only then is the socket accepted and the relay attached.
 *
 * Every refusal happens at the HTTP handshake, before a WebSocket exists, so
 * "no frame is transmitted to an unauthenticated or wrong-project viewer" is a
 * consequence of the sequence rather than of a check inside the send path.
 */

import websocketPlugin from "@fastify/websocket";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import {
  LIVE_MODE_VALUES,
  decodeLiveViewFrame,
  encodeLiveViewFrame,
  type LiveMode,
} from "@reviewplane/protocol/live-view";

import { requireAdministrator } from "../../auth.ts";
import { inTransaction } from "../../db/pool.ts";
import { ApiError } from "../../errors.ts";
import { appendEvent, recordStateChange } from "../../events/append.ts";
import { newId } from "../../ids.ts";
import type { BrowserSessionRecord, BrowserSessionService } from "../browser-sessions/service.ts";
import { requireCsrfTokenWhenSessionCarriesOne } from "../identity/authorisation.ts";
import { OrganisationStore } from "../identity/organisations.ts";
import {
  LiveViewerLimits,
  MAX_CLIENT_MESSAGE_BYTES,
  QUALITY_REQUEST_INTERVAL_MS,
} from "./limits.ts";
import type { LiveRelay, LiveViewer, LiveViewerSocket } from "./relay.ts";
import {
  VIEWER_SESSION_COOKIE,
  VIEWER_SESSION_TTL_SECONDS,
  authorisedForProject,
  clearedCsrfCookie,
  clearedViewerCookie,
  readCookie,
  viewerCookie,
  type ViewerPrincipal,
  type ViewerSessionStore,
} from "./viewer-sessions.ts";

export interface LiveRoutesOptions {
  readonly pool: Pool;
  readonly sessions: BrowserSessionService;
  readonly relay: LiveRelay;
  readonly viewers: ViewerSessionStore;
  readonly bootstrapToken: string;
  readonly workerCredential: string;
  /** Origins a browser may open the live socket from. */
  readonly allowedOrigins: readonly string[];
  /** Whether to mark the session cookie `Secure`. */
  readonly secureCookies: boolean;
  readonly limits?: LiveViewerLimits;
}

/**
 * Resolves the human principal for a request.
 *
 * The administrator bootstrap token is accepted directly so that an operator
 * with `curl` can exercise the same read endpoints the web application uses;
 * it maps to an organisation-wide principal, which is exactly what a
 * bootstrap administrator is.
 */
export async function resolveViewer(
  request: FastifyRequest,
  options: { readonly viewers: ViewerSessionStore; readonly bootstrapToken: string },
): Promise<ViewerPrincipal> {
  const header = request.headers.authorization;
  if (typeof header === "string") {
    const match = /^Bearer +([!-~]+)$/u.exec(header);
    if (match !== null && match[1] === options.bootstrapToken) {
      return {
        type: "human_viewer",
        viewerSessionId: "bootstrap",
        userId: null,
        organisationId: null,
        projectIds: null,
        display: "bootstrap administrator",
        // A bearer token is never sent by a browser on a cross-site request,
        // so this principal needs no CSRF token and has none to check.
        credential: "bootstrap_token",
        csrfTokenDigest: null,
        expiresAt: null,
      };
    }
  }
  const cookie = readCookie(request.headers.cookie, VIEWER_SESSION_COOKIE);
  const principal = await options.viewers.resolve(cookie);
  if (principal === null) {
    throw new ApiError(
      "AUTHENTICATION_REQUIRED",
      "A viewer session is required. Sign in with the bootstrap administrator token.",
    );
  }
  return principal;
}

export async function registerLiveRoutes(
  app: FastifyInstance,
  options: LiveRoutesOptions,
): Promise<void> {
  const limits = options.limits ?? new LiveViewerLimits();
  const organisations = new OrganisationStore(options.pool);
  const sweeper = setInterval(() => {
    limits.sweep();
  }, 60000);
  sweeper.unref();
  app.addHook("onClose", async () => {
    clearInterval(sweeper);
    options.relay.closeAll("server shutting down");
  });

  await app.register(websocketPlugin, {
    options: {
      // The protocol's own message bound, applied by the socket itself so an
      // oversized message is refused before it is buffered.
      maxPayload: MAX_CLIENT_MESSAGE_BYTES,
      // Frame payloads are already JPEG; compressing them again costs CPU on
      // the control plane for no gain.
      perMessageDeflate: false,
    },
  });

  // -----------------------------------------------------------------------
  // Viewer sessions
  // -----------------------------------------------------------------------

  app.post("/api/v1/auth/viewer-sessions", async (request, reply) => {
    // The bootstrap token arrives in a header, never in a cookie, so this
    // exchange cannot be performed by another site on the user's behalf.
    requireAdministrator(request, options.bootstrapToken, options.workerCredential);
    const issued = await options.viewers.issue({
      organisationId: null,
      projectIds: null,
      display: "bootstrap administrator",
    });
    return reply
      .header(
        "set-cookie",
        viewerCookie(issued.token, VIEWER_SESSION_TTL_SECONDS, options.secureCookies),
      )
      .status(201)
      .send({
        data: {
          viewer_session_id: issued.id,
          expires_at: issued.expiresAt.toISOString(),
          project_ids: null,
        },
        meta: { request_id: request.id },
      });
  });

  app.get("/api/v1/auth/viewer-sessions/current", async (request, reply) => {
    const principal = await resolveViewer(request, options);
    return reply.send({
      data: {
        viewer_session_id: principal.viewerSessionId,
        display: principal.display,
        project_ids: principal.projectIds === null ? null : [...principal.projectIds],
      },
      meta: { request_id: request.id },
    });
  });

  /**
   * Ends the session the cookie names (ADR-0016).
   *
   * Two rules that RVP-12 made apply to this route as much as to its own
   * sign-out, and which it originally missed:
   *
   *   * **A session that carries a CSRF token must present it.** The cookie
   *     this route resolves may belong to a password-authenticated account —
   *     the ADR-0016 exchange and a local account share one session record —
   *     and ending one on a cookie alone would let another origin's markup sign
   *     a person out (`docs/API.md` section 4.0). The exchange's own sessions
   *     carry no CSRF token and may still end themselves, because a session
   *     that cannot end is worse than one whose sign-out can be forged.
   *
   *     What that costs is bounded by the strict guard everywhere else, and
   *     only by it. A token-less session is not read-only by nature: until the
   *     strict guard reached the review routes, one could retitle a review and
   *     move it from `DRAFT` to `READY` on a cookie alone, because those routes
   *     applied no guard at all. They apply it now, so the whole of what a forged
   *     request can achieve against a token-less session is to end it — no
   *     domain record moves, and the operator obtains another session by
   *     presenting the bootstrap token again. That is a denial of the caller's
   *     own session, not a write to the system of record.
   *   * **It records `session.revoked`.** `AGENTS.md` requires an audit record
   *     for every meaningful state change, and a session ending is one. This
   *     route revoking silently was the one gap in the authentication trail.
   */
  app.delete("/api/v1/auth/viewer-sessions/current", async (request, reply) => {
    const clear = (): FastifyReply =>
      reply.header("set-cookie", [
        clearedViewerCookie(options.secureCookies),
        clearedCsrfCookie(options.secureCookies),
      ]);

    const cookie = readCookie(request.headers.cookie, VIEWER_SESSION_COOKIE);
    const principal = await options.viewers.resolve(cookie);
    if (principal === null) {
      // Nothing to revoke. Clearing is still right: a browser holding an
      // expired or unknown session should stop sending it.
      return clear().status(204).send();
    }

    requireCsrfTokenWhenSessionCarriesOne(request, principal);
    const revoked = await options.viewers.revoke(principal.viewerSessionId, "sign_out");
    if (revoked !== null) {
      // The organisation is the event's stream. An ADR-0016 administrator
      // session is organisation-wide and names none, so the deployment's own
      // organisation is used: an event with nowhere to go would be the audit
      // gap this exists to close.
      const organisationId = revoked.organisationId ?? (await organisations.primary())?.id ?? null;
      if (organisationId !== null) {
        await recordStateChange(
          options.pool,
          {
            type: "session.revoked",
            organisationId,
            actor: {
              type: "human_user",
              ...(principal.userId === null ? {} : { id: principal.userId }),
              display: principal.display,
            },
            correlation: { request_id: request.id },
            payload: {
              session_id: revoked.id,
              ...(revoked.userId === null ? {} : { user_id: revoked.userId }),
              reason: "sign_out",
            },
          },
          async () => undefined,
        );
      }
    }
    return clear().status(204).send();
  });

  /**
   * Mints a viewer session scoped to one project. An administrator action
   * today; the same record is what a project membership will produce.
   */
  app.post("/api/v1/projects/:projectId/viewer-sessions", async (request, reply) => {
    requireAdministrator(request, options.bootstrapToken, options.workerCredential);
    const { projectId } = request.params as { projectId: string };
    const rows = await options.pool.query<{ organisation_id: string }>(
      "SELECT organisation_id FROM projects WHERE id = $1",
      [projectId],
    );
    const row = rows.rows[0];
    if (row === undefined) throw new ApiError("RESOURCE_NOT_FOUND", "The project was not found.");
    const issued = await options.viewers.issue({
      organisationId: row.organisation_id,
      projectIds: [projectId],
      display: `project viewer ${projectId}`,
    });
    return reply.status(201).send({
      data: {
        viewer_session_id: issued.id,
        // Returned once. It is a credential, so it is never logged and never
        // readable again from the control plane.
        token: issued.token,
        expires_at: issued.expiresAt.toISOString(),
        project_ids: [projectId],
      },
      meta: { request_id: request.id },
    });
  });

  // -----------------------------------------------------------------------
  // Live stream
  // -----------------------------------------------------------------------

  interface UpgradeContext {
    readonly principal: ViewerPrincipal;
    readonly session: BrowserSessionRecord;
    readonly mode: LiveMode;
  }

  const contexts = new WeakMap<FastifyRequest, UpgradeContext>();

  const authoriseUpgrade = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const origin = request.headers.origin;
    if (typeof origin === "string" && !options.allowedOrigins.includes(origin)) {
      // Cross-site WebSocket hijacking: the cookie is SameSite=Strict, and
      // this is the second line rather than the only one.
      await reply.status(403).send({
        error: {
          code: "AUTHORISATION_DENIED",
          message: "This origin may not open a live stream.",
        },
        meta: { request_id: request.id },
      });
      return;
    }

    const principal = await resolveViewer(request, options);
    const { sessionId } = request.params as { sessionId: string };
    const session = await options.sessions.get(sessionId);
    // Both terms, and not one.
    //
    // `authorisedForProject` answers the project question only: a principal
    // with `projectIds === null` is authorised for every project it is asked
    // about, because the null means "not narrowed to a list" rather than
    // "narrowed to nothing". That is correct for the bootstrap administrator,
    // whose organisation is null as well, and it is not a complete answer for
    // any principal that names an organisation — for that one the project list
    // is vacuous and the organisation is the only boundary left.
    //
    // `docs/EVENTS.md` section 10 and `docs/API.md` section 18.2 require this
    // channel to authorise by organisation, project and session; the project
    // event channel already applies both terms, and a live channel applying one
    // of them would hand an organisation-wide viewer of one tenant the frames
    // of another. The session's own organisation is the comparison, because the
    // session is what is being authorised.
    const organisationDiffers =
      principal.organisationId !== null && principal.organisationId !== session.organisation_id;
    if (organisationDiffers || !authorisedForProject(principal, session.project_id)) {
      throw new ApiError(
        "PROJECT_CONTEXT_MISMATCH",
        "This viewer session is not authorised for the project that owns this browser session.",
      );
    }
    if (session.status === "TERMINATED" || session.status === "FAILED") {
      // `browser_session_status` and not `status`: it is the member name
      // `error_details` declares in the protocol schema, and one route
      // answering `BROWSER_SESSION_NOT_ACTIVE` with a different member name
      // from every other route is a client that learns the name in one place
      // and cannot find it in the next.
      throw new ApiError(
        "BROWSER_SESSION_NOT_ACTIVE",
        `The browser session is ${session.status}.`,
        { browser_session_status: session.status },
      );
    }

    const attach = limits.attaches.take(principal.viewerSessionId);
    if (!attach.allowed) {
      throw new ApiError(
        "RATE_LIMITED",
        "Too many live-view attachments from this viewer session.",
        { retry_after_ms: attach.retryAfterMs },
      );
    }
    if (!limits.perSession.acquire(session.id)) {
      throw new ApiError("RATE_LIMITED", "This browser session already has its maximum viewers.", {
        retry_after_ms: 5000,
      });
    }
    if (!limits.perViewerSession.acquire(principal.viewerSessionId)) {
      limits.perSession.release(session.id);
      throw new ApiError("RATE_LIMITED", "This viewer session already holds its maximum streams.", {
        retry_after_ms: 5000,
      });
    }

    const query = request.query as { mode?: string };
    const requestedMode = query.mode ?? "session_room";
    const mode = ((LIVE_MODE_VALUES as readonly string[]).includes(requestedMode)
      ? requestedMode
      : "session_room") as LiveMode;

    contexts.set(request, { principal, session, mode });
  };

  app.get(
    "/ws/v1/browser-sessions/:sessionId/live",
    { websocket: true, preValidation: authoriseUpgrade },
    (socket, request) => {
      const context = contexts.get(request);
      if (context === undefined) {
        socket.close(1011, "authorisation context missing");
        return;
      }
      void runViewer(socket as unknown as RawSocket, request, context);
    },
  );

  interface RawSocket {
    readonly bufferedAmount: number;
    readyState: number;
    send(data: string | Uint8Array, options?: { binary?: boolean }): void;
    close(code?: number, reason?: string): void;
    on(event: string, listener: (...args: never[]) => void): void;
  }

  const OPEN = 1;

  async function runViewer(
    socket: RawSocket,
    request: FastifyRequest,
    context: UpgradeContext,
  ): Promise<void> {
    const { principal, session, mode } = context;
    const viewerId = newId("lvw_");
    const wrapper: LiveViewerSocket = {
      get bufferedAmount(): number {
        return socket.bufferedAmount;
      },
      get open(): boolean {
        return socket.readyState === OPEN;
      },
      sendText(payload: string): void {
        if (socket.readyState === OPEN) socket.send(payload);
      },
      sendBinary(payload: Uint8Array): void {
        if (socket.readyState === OPEN) socket.send(payload, { binary: true });
      },
      close(code: number, reason: string): void {
        socket.close(code, reason);
      },
    };
    const viewer: LiveViewer = {
      id: viewerId,
      socket: wrapper,
      viewerSessionId: principal.viewerSessionId,
      framesSent: 0,
      framesDropped: 0,
      droppedBefore: 0,
    };

    let released = false;
    const release = (reason: string): void => {
      if (released) return;
      released = true;
      limits.perSession.release(session.id);
      limits.perViewerSession.release(principal.viewerSessionId);
      options.relay.detach(session.id, viewerId);
      void recordEvent(session, "browser.live_view_stopped", principal, {
        reason,
        frames_sent: viewer.framesSent,
        frames_dropped: viewer.framesDropped,
      });
    };

    socket.on("close", () => {
      release("viewer disconnected");
    });
    socket.on("error", () => {
      release("viewer socket error");
    });

    // The inbound listener is attached before anything is sent. A viewer that
    // answers the first message immediately would otherwise race the rest of
    // this function, and `ws` drops an event that has no listener.
    let lastQualityRequest = 0;
    socket.on("message", (raw: never) => {
      void handleClientMessage(raw as unknown as Buffer);
    });

    // The session's own state goes first, so a viewer whose stream never
    // produces a frame still knows what it is looking at.
    wrapper.sendText(
      encodeLiveViewFrame({
        envelope: envelope("live.session_state", session.id, session.id),
        type: "live.session_state",
        payload: {
          status: session.status,
          ...(session.service_origin === null ? {} : { url: session.service_origin }),
          viewport: session.viewport,
          control_epoch: session.control_epoch,
          live_capture: true,
          observed_at: new Date().toISOString(),
        },
      }),
    );

    try {
      await options.relay.attach(session, viewer, mode);
    } catch (error) {
      wrapper.sendText(
        encodeLiveViewFrame({
          envelope: envelope("live.error", session.id),
          type: "live.error",
          payload: {
            code: "BROWSER_SESSION_NOT_ACTIVE",
            state: "live_capture_unavailable",
            message:
              error instanceof ApiError
                ? error.message
                : "Live capture is unavailable for this browser session.",
            retryable: true,
          },
        }),
      );
      release("live capture unavailable");
      socket.close(1011, "live capture unavailable");
      return;
    }

    wrapper.sendText(
      encodeLiveViewFrame({
        envelope: envelope("live.attached", session.id, session.id),
        type: "live.attached",
        payload: {
          project_id: session.project_id,
          mode,
          format: "image/jpeg",
          retention: "never",
          max_frame_bytes: 4194304,
          attached_at: new Date().toISOString(),
        },
      }),
    );

    await recordEvent(session, "browser.live_view_started", principal, { mode });

    async function handleClientMessage(raw: Buffer): Promise<void> {
      const decision = limits.clientMessages.take(viewerId);
      if (!decision.allowed) {
        wrapper.sendText(
          encodeLiveViewFrame({
            envelope: envelope("live.error", session.id),
            type: "live.error",
            payload: {
              code: "RATE_LIMITED",
              state: "viewer_rate_limited",
              message: "Too many messages from this viewer.",
              retryable: true,
              retry_after_ms: decision.retryAfterMs,
            },
          }),
        );
        socket.close(1013, "rate limited");
        return;
      }
      const decoded = decodeLiveViewFrame(new Uint8Array(raw));
      if (!decoded.ok) {
        socket.close(1003, "unsupported message");
        return;
      }
      if (decoded.value.type === "live.viewer_heartbeat") return;
      if (decoded.value.type !== "live.quality_request") {
        // Only a viewer-originated message type may arrive here; anything else
        // is a client sending server messages back.
        socket.close(1003, "unsupported message");
        return;
      }
      const now = Date.now();
      if (now - lastQualityRequest < QUALITY_REQUEST_INTERVAL_MS) return;
      lastQualityRequest = now;
      await options.relay
        .requestQuality(session.id, decoded.value.payload)
        .catch(() => undefined);
    }

    request.log.info(
      { browser_session_id: session.id, viewer_session_id: principal.viewerSessionId },
      "live viewer attached",
    );
  }

  function envelope(
    type: "live.session_state" | "live.attached" | "live.error",
    browserSessionId: string,
    streamId?: string,
  ): {
    protocol_version: 1;
    message_id: string;
    type: typeof type;
    sent_at: string;
    browser_session_id: string;
    stream_id?: string;
  } {
    return {
      protocol_version: 1,
      message_id: newId("msg_"),
      type,
      sent_at: new Date().toISOString(),
      browser_session_id: browserSessionId,
      ...(streamId === undefined ? {} : { stream_id: streamId }),
    };
  }

  /**
   * Records that a human watched, or stopped watching, a browser session.
   *
   * `AGENTS.md` requires every meaningful state change to produce an audit
   * record, and live frames are the most sensitive data the product handles
   * (`docs/SECURITY.md` section 14). The event records that a viewer attached
   * and what it observed; it never records a frame.
   */
  async function recordEvent(
    session: BrowserSessionRecord,
    type: "browser.live_view_started" | "browser.live_view_stopped",
    principal: ViewerPrincipal,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await inTransaction(options.pool, async (client) => {
      await appendEvent(client, {
        type,
        organisationId: session.organisation_id,
        projectId: session.project_id,
        actor: {
          type: "human_user",
          id: principal.viewerSessionId,
          display: principal.display,
        },
        correlation: { browser_session_id: session.id },
        payload,
      });
    }).catch(() => undefined);
  }
}
