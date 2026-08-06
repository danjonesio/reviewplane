/**
 * Human sessions (ADR-0016, extended by RVP-12).
 *
 * ADR-0016 introduced this record for a deployment whose only human credential
 * was the bootstrap administrator token: the token is exchanged, over an
 * ordinary authenticated request, for a short-lived session whose token lives
 * in an HTTP-only cookie. Its follow-up said local accounts would replace the
 * exchange and that "the viewer-session record and its project scope are the
 * part that survives". They are the part that survived: a password login issues
 * a row in this table, with the same cookie, the same digest-only storage and
 * the same project scope, so the live channel, the artefact grants and every
 * project-scoped read authorise a real account today without learning a second
 * session kind.
 *
 * Four properties are load-bearing:
 *
 *   * the database stores only a digest of the session token, so a dump of
 *     this table is not a set of usable credentials;
 *   * a session carries an explicit project scope. The administrator's session
 *     is organisation-wide; a project-scoped session can be minted for one
 *     project and is refused on every other. That is the mechanism the live
 *     channel authorises against, so "a viewer from another project is
 *     refused" is enforcement rather than an assertion about a future feature;
 *   * a session issued to a user carries a CSRF token, stored as a digest and
 *     returned once so that it can travel in a readable cookie. A session
 *     without one cannot satisfy the check, so the ADR-0016 exchange stays a
 *     read-only credential rather than being admitted by a null comparison;
 *   * rotation is a first-class transition: the replacement names the session
 *     it replaced, and the replaced row is revoked with reason `rotated`, so an
 *     auditor reading the pair sees one event and not two unrelated ones.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Pool } from "pg";

import { newId } from "../../ids.ts";

/** Cookie the viewer session travels in. */
export const VIEWER_SESSION_COOKIE = "reviewplane_viewer";

/** `docs/CONFIGURATION.md` section 2: `authentication.session_ttl: 12h`. */
export const VIEWER_SESSION_TTL_SECONDS = 12 * 60 * 60;

export interface ViewerPrincipal {
  readonly type: "human_viewer";
  readonly viewerSessionId: string;
  /** The account behind the session, or null for the ADR-0016 exchange. */
  readonly userId: string | null;
  readonly organisationId: string | null;
  /** Null means every project; a set means exactly those projects. */
  readonly projectIds: ReadonlySet<string> | null;
  readonly display: string;
  /**
   * How the request authenticated. A cookie is replayable by another origin's
   * markup, so a state-changing request that arrives on one must also carry the
   * CSRF token (`docs/API.md` section 4); a bearer token is not sent by a
   * browser on a cross-site request and needs no second factor.
   */
  readonly credential: "cookie" | "bootstrap_token";
  /** Digest of the session's CSRF token, or null when it has none. */
  readonly csrfTokenDigest: string | null;
  readonly expiresAt: Date | null;
}

export interface IssuedViewerSession {
  readonly id: string;
  /** The raw token. Returned once, to be set as a cookie, and never stored. */
  readonly token: string;
  /**
   * The raw CSRF token, when the session was issued with one. Returned once and
   * stored only as a digest, exactly as the session token is.
   */
  readonly csrfToken: string | null;
  readonly expiresAt: Date;
  readonly projectIds: readonly string[] | null;
  readonly userId: string | null;
}

/** `docs/EVENTS.md` section 7: why a session stopped being usable. */
export type SessionRevocationReason =
  | "sign_out"
  | "rotated"
  | "revoked_by_user"
  | "revoked_by_administrator";

/** A session that was revoked, named so its event can be written. */
export interface RevokedSession {
  readonly id: string;
  readonly userId: string | null;
  readonly organisationId: string | null;
}

function digest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison of two digests. */
function digestMatches(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export class ViewerSessionStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * Issues a session. `projectIds` of `null` is organisation-wide; a list
   * scopes the session to exactly those projects.
   *
   * A session bound to a user is issued with a CSRF token; the ADR-0016
   * exchange is not, which is what keeps it a read-only credential.
   */
  async issue(input: {
    readonly organisationId: string | null;
    readonly projectIds: readonly string[] | null;
    readonly display: string;
    readonly ttlSeconds?: number;
    readonly userId?: string | null;
    /** Set to mint a CSRF token for this session. */
    readonly withCsrfToken?: boolean;
    /** The session this one replaces, for a rotation. */
    readonly rotatedFromSessionId?: string | null;
  }): Promise<IssuedViewerSession> {
    const token = randomBytes(32).toString("base64url");
    const userId = input.userId ?? null;
    const csrfToken = input.withCsrfToken === true ? randomBytes(32).toString("base64url") : null;
    const id = newId("vwr_");
    const ttl = input.ttlSeconds ?? VIEWER_SESSION_TTL_SECONDS;
    const expiresAt = new Date(Date.now() + ttl * 1000);
    await this.#pool.query(
      `INSERT INTO viewer_sessions
         (id, token_sha256, organisation_id, project_ids, display, expires_at,
          user_id, csrf_token_sha256, rotated_from_session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        digest(token),
        input.organisationId,
        input.projectIds === null ? null : [...input.projectIds],
        input.display,
        expiresAt.toISOString(),
        userId,
        csrfToken === null ? null : digest(csrfToken),
        input.rotatedFromSessionId ?? null,
      ],
    );
    return { id, token, csrfToken, expiresAt, projectIds: input.projectIds, userId };
  }

  /**
   * Resolves a presented token. Returns null for anything that is not a live,
   * unexpired, unrevoked session — the caller must not distinguish the reasons
   * to an unauthenticated client (`docs/SECURITY.md` section 5, safe failure).
   */
  async resolve(token: string | null): Promise<ViewerPrincipal | null> {
    if (token === null || token === "") return null;
    const presented = digest(token);
    const rows = await this.#pool.query<{
      id: string;
      token_sha256: string;
      organisation_id: string | null;
      project_ids: string[] | null;
      display: string;
      user_id: string | null;
      csrf_token_sha256: string | null;
      expires_at: Date;
      user_status: string | null;
    }>(
      `SELECT viewer_sessions.id,
              viewer_sessions.token_sha256,
              viewer_sessions.organisation_id,
              viewer_sessions.project_ids,
              viewer_sessions.display,
              viewer_sessions.user_id,
              viewer_sessions.csrf_token_sha256,
              viewer_sessions.expires_at,
              users.status AS user_status
         FROM viewer_sessions
         LEFT JOIN users ON users.id = viewer_sessions.user_id
        WHERE viewer_sessions.token_sha256 = $1
          AND viewer_sessions.revoked_at IS NULL
          AND viewer_sessions.expires_at > now()`,
      [presented],
    );
    const row = rows.rows[0];
    if (row === undefined) return null;
    // A suspended account stops working on its next request rather than when
    // its session happens to expire (`docs/SECURITY.md` section 7: current
    // session state is an authorisation input).
    if (row.user_id !== null && row.user_status !== "active") return null;
    // The lookup is by digest, so this comparison is belt and braces; it is
    // constant time because the value is still credential-derived.
    if (!digestMatches(row.token_sha256, presented)) return null;
    await this.#pool.query("UPDATE viewer_sessions SET last_seen_at = now() WHERE id = $1", [
      row.id,
    ]);
    return {
      type: "human_viewer",
      viewerSessionId: row.id,
      userId: row.user_id,
      organisationId: row.organisation_id,
      projectIds: row.project_ids === null ? null : new Set(row.project_ids),
      display: row.display,
      credential: "cookie",
      csrfTokenDigest: row.csrf_token_sha256,
      expiresAt: row.expires_at,
    };
  }

  /**
   * Revokes one session and reports what it was, so the caller can write the
   * `session.revoked` event for it. A session that was already revoked answers
   * null: the event is written once.
   */
  async revoke(
    viewerSessionId: string,
    reason: SessionRevocationReason = "sign_out",
  ): Promise<RevokedSession | null> {
    const revoked = await this.#pool.query<{
      id: string;
      user_id: string | null;
      organisation_id: string | null;
    }>(
      `UPDATE viewer_sessions
          SET revoked_at = now(), revocation_reason = $2
        WHERE id = $1 AND revoked_at IS NULL
        RETURNING id, user_id, organisation_id`,
      [viewerSessionId, reason],
    );
    const row = revoked.rows[0];
    if (row === undefined) return null;
    return { id: row.id, userId: row.user_id, organisationId: row.organisation_id };
  }

  /**
   * Revokes every live session a user holds, optionally sparing one.
   *
   * It is what "sessions can be revoked" means for an account rather than for a
   * cookie, and it is the same statement rotation uses: a privilege change
   * takes every session the change might have been made under.
   */
  async revokeAllForUser(
    userId: string,
    reason: SessionRevocationReason,
    exceptSessionId?: string,
  ): Promise<readonly RevokedSession[]> {
    const revoked = await this.#pool.query<{
      id: string;
      user_id: string | null;
      organisation_id: string | null;
    }>(
      `UPDATE viewer_sessions
          SET revoked_at = now(), revocation_reason = $2
        WHERE user_id = $1 AND revoked_at IS NULL AND ($3::text IS NULL OR id <> $3)
        RETURNING id, user_id, organisation_id`,
      [userId, reason, exceptSessionId ?? null],
    );
    return revoked.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      organisationId: row.organisation_id,
    }));
  }
}

/**
 * Whether a principal's **project scope** admits a project.
 *
 * Half an authorisation answer, and named so that it cannot be mistaken for
 * the whole one. `projectIds === null` means "not narrowed to a list", so this
 * returns true for every organisation-wide principal — which is every real
 * sign-in. The organisation is the other half and this function does not know
 * it; the one caller, the live channel in `live/routes.ts`, compares
 * `principal.organisationId` against the record's before it asks this.
 *
 * A `requireProject(principal, projectId)` helper stood beside this and threw
 * `PROJECT_CONTEXT_MISMATCH` on the project term alone. It had no callers, and
 * it was the exact shape of RVP-91 and RVP-92 kept in a helper with an
 * inviting name: importing it would have looked like adopting the house
 * pattern while dropping the organisation. Anything needing a scoped read
 * should call `resolveProject` in `modules/identity/authorisation.ts`, which
 * puts the identifier, the project scope and the organisation in one predicate
 * and answers `RESOURCE_NOT_FOUND` rather than a distinguishable refusal.
 */
export function authorisedForProject(principal: ViewerPrincipal, projectId: string): boolean {
  return principal.projectIds === null || principal.projectIds.has(projectId);
}

/** Reads one cookie from a request header without pulling in a parser. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    return value === "" ? null : decodeURIComponent(value);
  }
  return null;
}

/**
 * The cookie attributes. `SameSite=Strict` is what stops another origin
 * opening this WebSocket with the user's credentials, and browsers apply it to
 * the handshake as they do to any other request; the explicit origin check on
 * the upgrade is the second line.
 */
export function viewerCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  const attributes = [
    `${VIEWER_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${String(maxAgeSeconds)}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearedViewerCookie(secure: boolean): string {
  return viewerCookie("", 0, secure);
}

/** Cookie the CSRF token travels in, and the header that must echo it. */
export const CSRF_COOKIE = "reviewplane_csrf";
export const CSRF_HEADER = "x-csrf-token";

/**
 * The CSRF cookie.
 *
 * Deliberately **not** `HttpOnly`: the application has to read it to put the
 * value in a request header, and that is the whole mechanism. It is not a
 * second credential — on its own it authenticates nothing, and the session
 * cookie it accompanies is unreadable to script.
 *
 * `SameSite=Strict` again, so another origin's markup cannot cause either
 * cookie to be sent; the header requirement is what covers the cases
 * `SameSite` does not, such as a browser that ignores it or a redirect chain
 * that a future feature introduces.
 */
export function csrfCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  const attributes = [
    `${CSRF_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "SameSite=Strict",
    `Max-Age=${String(maxAgeSeconds)}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearedCsrfCookie(secure: boolean): string {
  return csrfCookie("", 0, secure);
}

/** SHA-256 of a CSRF token, for comparison against the stored digest. */
export function csrfDigest(token: string): string {
  return digest(token);
}

/** Constant-time comparison of a presented CSRF token against a stored digest. */
export function csrfTokenMatches(presented: string | undefined, storedDigest: string | null): boolean {
  if (presented === undefined || presented === "" || storedDigest === null) return false;
  return digestMatches(digest(presented), storedDigest);
}
