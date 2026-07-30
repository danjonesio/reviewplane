/**
 * Human authentication (`docs/API.md` section 4, `docs/SECURITY.md` section
 * 6.1).
 *
 * ```text
 * GET    /api/v1/auth/bootstrap          is this installation still unclaimed?
 * POST   /api/v1/auth/bootstrap          consume the install token, set the account
 * POST   /api/v1/auth/sessions           sign in with email and password
 * GET    /api/v1/auth/sessions/current   who am I, and what may I reach?
 * DELETE /api/v1/auth/sessions/current   sign out
 * DELETE /api/v1/auth/sessions           revoke every session this account holds
 * ```
 *
 * The ADR-0016 `/api/v1/auth/viewer-sessions` exchange stays where it is. It is
 * how a machine caller and the Stage 0 harnesses obtain a read-only session,
 * and removing it would break them for no security gain: it carries no CSRF
 * token, so it cannot reach any of the state-changing routes this issue
 * introduced.
 *
 * Five rules run through every handler here:
 *
 *   1. **A refusal says as little as it can.** An unknown address and a wrong
 *      password are the same answer, after the same work, because the
 *      difference is an account-enumeration oracle (`docs/SECURITY.md` section
 *      5). The audit event records which it was; the caller does not learn.
 *   2. **Nothing derived from a credential is logged, returned or evented.**
 *      Not the password, not the token, and not the address that was typed
 *      beside them (`docs/SECURITY.md` section 18).
 *   3. **Sessions rotate.** Signing in replaces any session the request
 *      arrived with, and claiming the installation replaces every session the
 *      account held: a privilege change never leaves an earlier session usable.
 *   4. **Rate limiting is per subject and survives a restart**, because it
 *      lives in the database.
 *   5. **Every outcome is audited** — success, failure and revocation —
 *      through the events of `docs/EVENTS.md` section 7.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { HumanSession } from "@reviewplane/protocol/platform";

import { inTransaction } from "../../db/pool.ts";
import type { Pool } from "../../db/pool.ts";
import { ApiError } from "../../errors.ts";
import { appendEvent, recordStateChange } from "../../events/append.ts";
import type { AppendEventInput, EventPublisher } from "../../events/append.ts";
import {
  VIEWER_SESSION_TTL_SECONDS,
  clearedCsrfCookie,
  clearedViewerCookie,
  csrfCookie,
  viewerCookie,
} from "../live/viewer-sessions.ts";
import type {
  IssuedViewerSession,
  SessionRevocationReason,
  ViewerPrincipal,
  ViewerSessionStore,
} from "../live/viewer-sessions.ts";
import { actorOf, requireCsrfToken, requireHuman } from "./authorisation.ts";
import type { InstallTokenStore } from "./install-tokens.ts";
import type { LoginRateLimiter } from "./rate-limit.ts";
import type { OrganisationStore } from "./organisations.ts";
import { checkPasswordPolicy, hashPassword, verifyPassword } from "./passwords.ts";
import { userView } from "./users.ts";
import type { UserRecord, UserStore } from "./users.ts";

export interface IdentityRoutesOptions {
  readonly pool: Pool;
  readonly users: UserStore;
  readonly organisations: OrganisationStore;
  readonly installTokens: InstallTokenStore;
  readonly sessions: ViewerSessionStore;
  readonly rateLimiter: LoginRateLimiter;
  readonly secureCookies: boolean;
  /** Origins a browser may sign in from. Empty means the same-origin deployment. */
  readonly allowedOrigins: readonly string[];
  readonly events?: EventPublisher;
  readonly sessionTtlSeconds?: number;
}

/** The address pattern of `schemas/platform/v1.schema.json`. */
// eslint-disable-next-line no-control-regex -- the class exists to exclude them
const EMAIL_PATTERN = /^[^\s@\u0000-\u001f]+@[^\s@\u0000-\u001f]+$/u;

/** Bounds on a presented token, before anything is hashed. */
const MIN_TOKEN_LENGTH = 8;
const MAX_TOKEN_LENGTH = 512;

type LoginFailureReason =
  | "unknown_user"
  | "invalid_password"
  | "password_not_set"
  | "user_suspended"
  | "rate_limited"
  | "install_token_invalid"
  | "install_token_expired"
  | "install_token_consumed";

export async function registerIdentityRoutes(
  app: FastifyInstance,
  options: IdentityRoutesOptions,
): Promise<void> {
  const ttl = options.sessionTtlSeconds ?? VIEWER_SESSION_TTL_SECONDS;

  /** Writes an event that accompanies no state change of its own. */
  const emit = async (event: AppendEventInput): Promise<void> => {
    await recordStateChange(options.pool, event, async () => undefined, options.events);
  };

  /**
   * Refuses a cross-origin sign-in when the deployment names its origins.
   *
   * A login carries no session yet, so it cannot carry a CSRF token; the
   * `SameSite=Strict` cookie is what stops a forged sign-in being useful, and
   * this is the second line for a deployment that has said which origins are
   * legitimate. A request with no `Origin` is a non-browser client, which is
   * the reading `docs/API.md` section 18.2 already applies.
   */
  const assertOriginAllowed = (request: FastifyRequest): void => {
    const origin = request.headers.origin;
    if (typeof origin !== "string" || options.allowedOrigins.length === 0) return;
    if (!options.allowedOrigins.includes(origin)) {
      throw new ApiError("AUTHORISATION_DENIED", "This origin may not sign in to this deployment.");
    }
  };

  /**
   * Sets the pair of cookies a session travels in.
   *
   * The session token is `HttpOnly` so no script can read it; the CSRF token is
   * readable, because the application has to echo it in a header, and on its
   * own it authenticates nothing.
   */
  const setSessionCookies = (reply: FastifyReply, issued: IssuedViewerSession): void => {
    const maxAge = Math.max(Math.floor((issued.expiresAt.getTime() - Date.now()) / 1000), 1);
    const cookies = [viewerCookie(issued.token, maxAge, options.secureCookies)];
    if (issued.csrfToken !== null) {
      cookies.push(csrfCookie(issued.csrfToken, maxAge, options.secureCookies));
    }
    void reply.header("set-cookie", cookies);
  };

  const clearSessionCookies = (reply: FastifyReply): void => {
    void reply.header("set-cookie", [
      clearedViewerCookie(options.secureCookies),
      clearedCsrfCookie(options.secureCookies),
    ]);
  };

  /** Revokes every session an account holds and records each revocation. */
  const revokeAndAudit = async (
    user: { readonly id: string; readonly organisationId: string },
    reason: SessionRevocationReason,
    exceptSessionId?: string,
  ): Promise<void> => {
    const revoked = await options.sessions.revokeAllForUser(user.id, reason, exceptSessionId);
    for (const session of revoked) {
      await emit({
        type: "session.revoked",
        organisationId: session.organisationId ?? user.organisationId,
        actor: { type: "human_user", id: user.id },
        payload: { session_id: session.id, user_id: user.id, reason },
      });
    }
  };

  /**
   * Is this installation still waiting to be claimed?
   *
   * Unauthenticated by necessity: it is the question the first screen asks
   * before anybody can sign in. It discloses whether the deployment has an
   * administrator yet and the organisation's display name — what a first-run
   * page needs, and nothing about who the administrator is.
   */
  app.get("/api/v1/auth/bootstrap", async (request, reply) => {
    const organisation = await options.organisations.primary();
    if (organisation === null) {
      return reply.send({
        data: { bootstrap_required: false, organisation: null, install_token_outstanding: false },
        meta: { request_id: request.id },
      });
    }
    const user = await options.users.sole(organisation.id);
    const required = user === null || user.passwordHash === null;
    // Whether a token is outstanding is only reported while the installation is
    // unclaimed, where it is what the screen needs to say. On a claimed
    // deployment it would tell an unauthenticated caller that a password reset
    // is in flight, which is not their business.
    const outstanding = required && (await options.installTokens.liveTokenExists(organisation.id));
    return reply.send({
      data: {
        bootstrap_required: required,
        organisation: { id: organisation.id, name: organisation.name, slug: organisation.slug },
        install_token_outstanding: outstanding,
      },
      meta: { request_id: request.id },
    });
  });

  /**
   * Claims the installation: consume the one-time token, set the address and
   * the password, and sign in.
   *
   * Consumption and the credential change commit together. A token marked used
   * beside a password that was never set would lock the installation out of
   * itself, and the two statements are far enough apart in time for that to
   * happen for real.
   */
  app.post("/api/v1/auth/bootstrap", async (request, reply) => {
    assertOriginAllowed(request);
    const body = (request.body ?? {}) as { token?: unknown; email?: unknown; password?: unknown };

    const organisation = await options.organisations.primary();
    if (organisation === null) {
      throw new ApiError(
        "RESOURCE_NOT_FOUND",
        "This deployment has no organisation. Run reviewplane migrate before claiming it.",
      );
    }

    const token = readToken(body.token);
    const email = readEmail(body.email);
    const policy = checkPasswordPolicy(body.password);
    if (!policy.ok) {
      throw new ApiError("VALIDATION_FAILED", policy.message, {
        field: "password",
        reason: policy.reason,
      });
    }
    const password = body.password as string;

    // Brute-forcing the install token is the attack this throttles, so the
    // subject is the route rather than an address: the token is what is being
    // guessed.
    const limitSubject = "bootstrap";
    const decision = await options.rateLimiter.check(limitSubject);
    if (!decision.allowed) {
      await emit(loginFailed(organisation.id, "rate_limited", "install_token"));
      throw new ApiError("RATE_LIMITED", "Too many attempts. Try again shortly.", {
        retry_after_ms: decision.retryAfterMs,
      });
    }

    const passwordHash = await hashPassword(password);
    let user: UserRecord;
    try {
      user = await claimInstallation({
        pool: options.pool,
        installTokens: options.installTokens,
        token,
        email,
        passwordHash,
        requestId: request.id,
      });
    } catch (error) {
      if (!(error instanceof InstallTokenRefused)) throw error;
      await options.rateLimiter.recordFailure(limitSubject);
      await emit(loginFailed(organisation.id, error.reason, "install_token"));
      throw new ApiError(
        "AUTHENTICATION_REQUIRED",
        "That installation token cannot be used. Mint a new one with reviewplane install-token.",
        { reason: error.reason },
      );
    }
    await options.rateLimiter.recordSuccess(limitSubject);

    // The account just gained a credential, which is a privilege change: every
    // session it held before now belongs to a different set of powers.
    await revokeAndAudit({ id: user.id, organisationId: user.organisationId }, "rotated");

    const issued = await options.sessions.issue({
      organisationId: user.organisationId,
      projectIds: null,
      display: user.displayName,
      userId: user.id,
      withCsrfToken: true,
      ttlSeconds: ttl,
    });
    await emit({
      type: "authentication.login_succeeded",
      organisationId: user.organisationId,
      actor: { type: "human_user", id: user.id, display: user.displayName },
      correlation: { request_id: request.id },
      payload: { session_id: issued.id, user_id: user.id, method: "install_token" },
    });

    setSessionCookies(reply, issued);
    return reply.status(201).send({
      data: { session: sessionView(issued, user), user: userView(user) },
      meta: { request_id: request.id },
    });
  });

  /** Signs in with email and password. */
  app.post("/api/v1/auth/sessions", async (request, reply) => {
    assertOriginAllowed(request);
    const body = (request.body ?? {}) as { email?: unknown; password?: unknown };

    const organisation = await options.organisations.primary();
    if (organisation === null) {
      throw new ApiError("RESOURCE_NOT_FOUND", "This deployment has no organisation.");
    }

    const email = readEmail(body.email);
    if (typeof body.password !== "string" || body.password === "") {
      throw new ApiError("VALIDATION_FAILED", "A password is required.", { field: "password" });
    }
    const password = body.password;

    const subject = `password:${email.toLowerCase()}`;
    const decision = await options.rateLimiter.check(subject);
    if (!decision.allowed) {
      await emit(loginFailed(organisation.id, "rate_limited", "password"));
      throw new ApiError("RATE_LIMITED", "Too many sign-in attempts. Try again shortly.", {
        retry_after_ms: decision.retryAfterMs,
      });
    }

    /**
     * Builds the one refusal every failed sign-in produces.
     *
     * One message and one code for every cause. Which cause it was goes to the
     * audit trail, where it informs an operator rather than an attacker.
     */
    const refusal = async (reason: LoginFailureReason, userId?: string): Promise<ApiError> => {
      const failure = await options.rateLimiter.recordFailure(subject);
      await emit(loginFailed(organisation.id, reason, "password", userId));
      return new ApiError(
        "AUTHENTICATION_REQUIRED",
        "That email address and password do not match an account.",
        failure.allowed ? undefined : { retry_after_ms: failure.retryAfterMs },
      );
    };

    const user = await options.users.byEmail(organisation.id, email);
    if (user === null) {
      // The work happens anyway, so an unknown address costs what a known one
      // costs and the difference is not measurable from outside.
      await verifyPassword(password, DUMMY_VERIFIER);
      throw await refusal("unknown_user");
    }
    if (user.passwordHash === null) {
      await verifyPassword(password, DUMMY_VERIFIER);
      throw await refusal("password_not_set", user.id);
    }
    if (user.status !== "active") {
      await verifyPassword(password, DUMMY_VERIFIER);
      throw await refusal("user_suspended", user.id);
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      throw await refusal("invalid_password", user.id);
    }

    await options.rateLimiter.recordSuccess(subject);

    // Rotation: whatever session the request arrived with is replaced, so a
    // session identifier fixed by an attacker cannot survive an authentication.
    const arriving = actorOf(request);
    const replacing =
      arriving.type === "human" && arriving.principal.viewerSessionId !== "bootstrap"
        ? arriving.principal.viewerSessionId
        : null;
    if (replacing !== null) {
      const revoked = await options.sessions.revoke(replacing, "rotated");
      if (revoked !== null) {
        await emit({
          type: "session.revoked",
          organisationId: revoked.organisationId ?? user.organisationId,
          actor: { type: "human_user", id: user.id },
          payload: {
            session_id: revoked.id,
            ...(revoked.userId === null ? {} : { user_id: revoked.userId }),
            reason: "rotated",
          },
        });
      }
    }

    const issued = await options.sessions.issue({
      organisationId: user.organisationId,
      projectIds: null,
      display: user.displayName,
      userId: user.id,
      withCsrfToken: true,
      ttlSeconds: ttl,
      ...(replacing === null ? {} : { rotatedFromSessionId: replacing }),
    });
    await emit({
      type: "authentication.login_succeeded",
      organisationId: user.organisationId,
      actor: { type: "human_user", id: user.id, display: user.displayName },
      correlation: { request_id: request.id },
      payload: { session_id: issued.id, user_id: user.id, method: "password" },
    });

    setSessionCookies(reply, issued);
    return reply.status(201).send({
      data: { session: sessionView(issued, user), user: userView(user) },
      meta: { request_id: request.id },
    });
  });

  /** The current session, as the application shell needs it. */
  app.get("/api/v1/auth/sessions/current", async (request, reply) => {
    const principal = requireHuman(request);
    const user = principal.userId === null ? null : await options.users.byId(principal.userId);
    return reply.send({
      data: {
        session: principalView(principal, user),
        user: user === null ? null : userView(user),
      },
      meta: { request_id: request.id },
    });
  });

  /** Signs out: the session is revoked, not merely forgotten by the browser. */
  app.delete("/api/v1/auth/sessions/current", async (request, reply) => {
    const principal = requireHuman(request);
    requireCsrfToken(request, principal);
    if (principal.viewerSessionId !== "bootstrap") {
      const revoked = await options.sessions.revoke(principal.viewerSessionId, "sign_out");
      if (revoked !== null && revoked.organisationId !== null) {
        await emit({
          type: "session.revoked",
          organisationId: revoked.organisationId,
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
        });
      }
    }
    clearSessionCookies(reply);
    return reply.status(204).send();
  });

  /**
   * Revokes every session this account holds, including this one.
   *
   * It is the answer to "somebody else may have my cookie", and it is why
   * revocation belongs to the account rather than to the browser that asks.
   */
  app.delete("/api/v1/auth/sessions", async (request, reply) => {
    const principal = requireHuman(request);
    requireCsrfToken(request, principal);
    if (principal.userId === null || principal.organisationId === null) {
      throw new ApiError(
        "AUTHORISATION_DENIED",
        "This session is not bound to an account, so it holds no account sessions to revoke.",
      );
    }
    await revokeAndAudit(
      { id: principal.userId, organisationId: principal.organisationId },
      "revoked_by_user",
    );
    clearSessionCookies(reply);
    return reply.status(204).send();
  });

  /** The organisation this deployment is (`docs/API.md` section 7). */
  app.get("/api/v1/organisation", async (request, reply) => {
    const principal = requireHuman(request);
    const organisation =
      principal.organisationId === null
        ? await options.organisations.primary()
        : await options.organisations.byId(principal.organisationId);
    if (organisation === null) throw new ApiError("RESOURCE_NOT_FOUND", "No organisation exists.");
    return reply.send({
      data: {
        id: organisation.id,
        name: organisation.name,
        slug: organisation.slug,
        status: organisation.status,
        created_at: organisation.createdAt.toISOString(),
        updated_at: organisation.updatedAt.toISOString(),
      },
      meta: { request_id: request.id },
    });
  });
}

/**
 * A verifier no password matches, so that an unknown address costs the same
 * work as a known one. Its parameters are the current ones, so the two paths
 * stay comparable when the parameters are raised. A test asserts that it parses
 * — a malformed value here would be rejected without doing the work, which is
 * exactly the timing difference it exists to remove.
 */
export const DUMMY_VERIFIER = `scrypt$N=32768,r=8,p=1$${"A".repeat(22)}$${"A".repeat(43)}`;

/** Raised when an install token cannot be used, with the reason for the audit. */
class InstallTokenRefused extends Error {
  readonly reason: "install_token_invalid" | "install_token_expired" | "install_token_consumed";

  constructor(reason: "install_token_invalid" | "install_token_expired" | "install_token_consumed") {
    super(reason);
    this.name = "InstallTokenRefused";
    this.reason = reason;
  }
}

/**
 * Consumes the token and writes the credential in one transaction.
 *
 * The atomicity is the point, which is why it is one function and not two
 * calls a handler makes in order: a caller that could do half of it would be
 * able to produce the state that locks an installation out of itself.
 */
async function claimInstallation(input: {
  readonly pool: Pool;
  readonly installTokens: InstallTokenStore;
  readonly token: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly requestId: string;
}): Promise<UserRecord> {
  return inTransaction(input.pool, async (client) => {
    const consumed = await input.installTokens.consume(client, input.token);
    if (!consumed.ok) throw new InstallTokenRefused(consumed.reason);

    const updated = await client.query<{
      id: string;
      organisation_id: string;
      email: string;
      display_name: string;
      status: string;
      password_hash: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `UPDATE users
          SET email = $2, password_hash = $3, password_updated_at = now(), updated_at = now()
        WHERE id = $1
    RETURNING id, organisation_id, email, display_name, status, password_hash, created_at, updated_at`,
      [consumed.userId, input.email, input.passwordHash],
    );
    const row = updated.rows[0];
    if (row === undefined) {
      throw new ApiError("RESOURCE_NOT_FOUND", "The account this token names no longer exists.");
    }

    await appendEvent(client, {
      type: "user.credentials_set",
      organisationId: row.organisation_id,
      actor: { type: "human_user", id: row.id, display: row.display_name },
      correlation: { request_id: input.requestId },
      payload: { user_id: row.id, method: "install_token" },
    });

    return {
      id: row.id,
      organisationId: row.organisation_id,
      email: row.email,
      displayName: row.display_name,
      status: row.status === "suspended" ? ("suspended" as const) : ("active" as const),
      passwordHash: row.password_hash,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

function loginFailed(
  organisationId: string,
  reason: LoginFailureReason,
  method: "password" | "install_token",
  userId?: string,
): AppendEventInput {
  return {
    type: "authentication.login_failed",
    organisationId,
    // An unauthenticated attempt has not established who made it, so the actor
    // is the system and the payload names a user only when the attempt reached
    // one that exists (`docs/EVENTS.md` section 5).
    actor: { type: "system" },
    payload: { reason, method, ...(userId === undefined ? {} : { user_id: userId }) },
  };
}

function readEmail(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError("VALIDATION_FAILED", "An email address is required.", { field: "email" });
  }
  const email = value.trim();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new ApiError("VALIDATION_FAILED", "That is not an email address.", { field: "email" });
  }
  return email;
}

function readToken(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError("VALIDATION_FAILED", "An installation token is required.", { field: "token" });
  }
  const token = value.trim();
  if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) {
    throw new ApiError("VALIDATION_FAILED", "That is not an installation token.", { field: "token" });
  }
  return token;
}

/** The freshly issued session, as its own holder sees it. */
function sessionView(issued: IssuedViewerSession, user: UserRecord): HumanSession {
  return {
    session_id: issued.id,
    user_id: user.id,
    organisation_id: user.organisationId,
    email: user.email,
    display: user.displayName,
    expires_at: issued.expiresAt.toISOString(),
  };
}

/** An established session, as its own holder sees it. */
function principalView(principal: ViewerPrincipal, user: UserRecord | null): HumanSession {
  return {
    session_id: principal.viewerSessionId,
    ...(principal.userId === null ? {} : { user_id: principal.userId }),
    ...(principal.organisationId === null ? {} : { organisation_id: principal.organisationId }),
    ...(user === null ? {} : { email: user.email }),
    display: principal.display,
    ...(principal.projectIds === null ? {} : { project_ids: [...principal.projectIds] }),
    // A bootstrap-token principal has no row and therefore no expiry of its
    // own: it stops working when the operator rotates the token.
    expires_at: (
      principal.expiresAt ?? new Date(Date.now() + VIEWER_SESSION_TTL_SECONDS * 1000)
    ).toISOString(),
  };
}
