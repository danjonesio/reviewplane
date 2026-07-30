/**
 * Human viewer sessions (ADR-0016).
 *
 * Stage 0 has one human: the holder of the bootstrap administrator token
 * (`docs/ARCHITECTURE.md` section 11). That token is a long-lived credential
 * and must not travel to a browser, and a browser cannot present a bearer
 * header on a WebSocket handshake in any case. So the token is exchanged once,
 * over an ordinary authenticated request, for a short-lived session whose
 * token lives in an HTTP-only cookie — which is precisely the shape
 * `docs/API.md` section 4 already specifies for the human API.
 *
 * Two properties are load-bearing:
 *
 *   * the database stores only a digest of the session token, so a dump of
 *     this table is not a set of usable credentials;
 *   * a session carries an explicit project scope. The administrator's session
 *     is organisation-wide; a project-scoped session can be minted for one
 *     project and is refused on every other. That is the mechanism the live
 *     channel authorises against, so "a viewer from another project is
 *     refused" is enforcement rather than an assertion about a future feature.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Pool } from "pg";

import { ApiError } from "../../errors.ts";
import { newId } from "../../ids.ts";

/** Cookie the viewer session travels in. */
export const VIEWER_SESSION_COOKIE = "reviewplane_viewer";

/** `docs/CONFIGURATION.md` section 2: `authentication.session_ttl: 12h`. */
export const VIEWER_SESSION_TTL_SECONDS = 12 * 60 * 60;

export interface ViewerPrincipal {
  readonly type: "human_viewer";
  readonly viewerSessionId: string;
  readonly organisationId: string | null;
  /** Null means every project; a set means exactly those projects. */
  readonly projectIds: ReadonlySet<string> | null;
  readonly display: string;
}

export interface IssuedViewerSession {
  readonly id: string;
  /** The raw token. Returned once, to be set as a cookie, and never stored. */
  readonly token: string;
  readonly expiresAt: Date;
  readonly projectIds: readonly string[] | null;
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
   */
  async issue(input: {
    readonly organisationId: string | null;
    readonly projectIds: readonly string[] | null;
    readonly display: string;
    readonly ttlSeconds?: number;
  }): Promise<IssuedViewerSession> {
    const token = randomBytes(32).toString("base64url");
    const id = newId("vwr_");
    const ttl = input.ttlSeconds ?? VIEWER_SESSION_TTL_SECONDS;
    const expiresAt = new Date(Date.now() + ttl * 1000);
    await this.#pool.query(
      `INSERT INTO viewer_sessions (id, token_sha256, organisation_id, project_ids, display, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        digest(token),
        input.organisationId,
        input.projectIds === null ? null : [...input.projectIds],
        input.display,
        expiresAt.toISOString(),
      ],
    );
    return { id, token, expiresAt, projectIds: input.projectIds };
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
    }>(
      `SELECT id, token_sha256, organisation_id, project_ids, display
         FROM viewer_sessions
        WHERE token_sha256 = $1
          AND revoked_at IS NULL
          AND expires_at > now()`,
      [presented],
    );
    const row = rows.rows[0];
    if (row === undefined) return null;
    // The lookup is by digest, so this comparison is belt and braces; it is
    // constant time because the value is still credential-derived.
    if (!digestMatches(row.token_sha256, presented)) return null;
    await this.#pool.query("UPDATE viewer_sessions SET last_seen_at = now() WHERE id = $1", [
      row.id,
    ]);
    return {
      type: "human_viewer",
      viewerSessionId: row.id,
      organisationId: row.organisation_id,
      projectIds: row.project_ids === null ? null : new Set(row.project_ids),
      display: row.display,
    };
  }

  async revoke(viewerSessionId: string): Promise<void> {
    await this.#pool.query(
      "UPDATE viewer_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
      [viewerSessionId],
    );
  }
}

/** Whether a principal may view a project's resources. */
export function authorisedForProject(principal: ViewerPrincipal, projectId: string): boolean {
  return principal.projectIds === null || principal.projectIds.has(projectId);
}

/** Throws the refusal a project-scope failure must report. */
export function requireProject(principal: ViewerPrincipal, projectId: string): void {
  if (!authorisedForProject(principal, projectId)) {
    throw new ApiError(
      "PROJECT_CONTEXT_MISMATCH",
      "This viewer session is not authorised for the project that owns this resource.",
    );
  }
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
