/**
 * The one-time administrator bootstrap token (`docs/SECURITY.md` section 6.1:
 * "administrator bootstrap through a one-time token").
 *
 * An installation cannot ship with a password, and it cannot ask a human to
 * invent one before the software exists to ask. So the operator mints a token
 * at the console — `reviewplane install-token` — and the first-run screen
 * exchanges it for an email address and a password.
 *
 * Single-use and expiring are both enforced in SQL rather than in a handler:
 *
 *   * consumption is `UPDATE … WHERE consumed_at IS NULL AND expires_at > now()
 *     RETURNING`, so two callers racing the same token produce exactly one
 *     winner. A read-then-write would let both through under concurrency, which
 *     is the difference between one administrator and two;
 *   * the expiry is part of the same predicate, so a token that has been on a
 *     console scrollback for a week is refused by the statement that would
 *     otherwise consume it, rather than by a check somebody has to remember.
 *
 * Only the digest is stored, so a copy of the table is not a set of usable
 * tokens, and the raw value is returned exactly once by the command that mints
 * it.
 */

import { createHash, randomBytes } from "node:crypto";

import { newEntityId } from "@reviewplane/protocol/platform";

import type { Pool, PoolClient } from "../../db/pool.ts";
import { recordStateChange } from "../../events/append.ts";
import type { EventPublisher } from "../../events/append.ts";

/** How long a freshly minted install token lives, when nothing says otherwise. */
export const INSTALL_TOKEN_TTL_SECONDS = 24 * 60 * 60;

/** Bounds an operator may choose between. */
export const MINIMUM_INSTALL_TOKEN_TTL_SECONDS = 60;
export const MAXIMUM_INSTALL_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Prefix, so an operator who finds one in a terminal knows what it is, and so
 * that a token presented on the wrong endpoint is recognisable as the wrong
 * kind of credential rather than merely wrong.
 */
const TOKEN_PREFIX = "rpi_";

export interface IssuedInstallToken {
  readonly id: string;
  /** The raw token. Returned once, printed once, never stored. */
  readonly token: string;
  readonly userId: string;
  readonly expiresAt: Date;
}

export type InstallTokenFailure = "install_token_invalid" | "install_token_expired" | "install_token_consumed";

export type ConsumeResult =
  | { readonly ok: true; readonly tokenId: string; readonly userId: string }
  | { readonly ok: false; readonly reason: InstallTokenFailure };

function digest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** True when a value has the shape of an install token. */
export function looksLikeInstallToken(candidate: string): boolean {
  return candidate.startsWith(TOKEN_PREFIX);
}

export class InstallTokenStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * Mints a token for a user and records that a way in now exists.
   *
   * `user.invited` is the catalogued event for exactly this: a one-time
   * credential-establishing grant. It names the user and when the grant closes
   * and never the token itself (`docs/EVENTS.md` section 7).
   */
  async issue(
    input: {
      readonly organisationId: string;
      readonly userId: string;
      readonly ttlSeconds?: number;
      readonly actorDisplay?: string;
    },
    publisher?: EventPublisher,
  ): Promise<IssuedInstallToken> {
    const ttl = Math.min(
      Math.max(input.ttlSeconds ?? INSTALL_TOKEN_TTL_SECONDS, MINIMUM_INSTALL_TOKEN_TTL_SECONDS),
      MAXIMUM_INSTALL_TOKEN_TTL_SECONDS,
    );
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const id = newEntityId("install_token");
    const expiresAt = new Date(Date.now() + ttl * 1000);

    await recordStateChange(
      this.#pool,
      {
        type: "user.invited",
        organisationId: input.organisationId,
        actor: { type: "system", display: input.actorDisplay ?? "reviewplane install-token" },
        payload: {
          user_id: input.userId,
          method: "install_token",
          expires_at: expiresAt.toISOString(),
        },
      },
      async (client: PoolClient) => {
        await client.query(
          `INSERT INTO install_tokens (id, organisation_id, token_sha256, user_id, expires_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, input.organisationId, digest(token), input.userId, expiresAt.toISOString()],
        );
      },
      publisher,
    );

    return { id, token, userId: input.userId, expiresAt };
  }

  /**
   * Consumes a token inside a caller's transaction.
   *
   * It takes a client rather than the pool because consumption and the
   * credential change it authorises must commit together: a token marked used
   * beside a password that was never set would lock the installation out of
   * itself.
   *
   * The refusal distinguishes expired from consumed from unknown, because that
   * distinction is useful to an operator and discloses nothing: the caller
   * already holds a token, and learning that it is stale tells them only what
   * they can find out by looking at the clock.
   */
  async consume(client: PoolClient, token: string): Promise<ConsumeResult> {
    const presented = digest(token);
    const claimed = await client.query<{ id: string; user_id: string }>(
      `UPDATE install_tokens
          SET consumed_at = now()
        WHERE token_sha256 = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING id, user_id`,
      [presented],
    );
    const row = claimed.rows[0];
    if (row !== undefined) return { ok: true, tokenId: row.id, userId: row.user_id };

    const existing = await client.query<{ consumed_at: Date | null; expired: boolean }>(
      `SELECT consumed_at, (expires_at <= now()) AS expired
         FROM install_tokens WHERE token_sha256 = $1`,
      [presented],
    );
    const found = existing.rows[0];
    if (found === undefined) return { ok: false, reason: "install_token_invalid" };
    if (found.consumed_at !== null) return { ok: false, reason: "install_token_consumed" };
    return { ok: false, reason: "install_token_expired" };
  }

  /** Whether the deployment still has a live, unconsumed token. */
  async liveTokenExists(organisationId: string): Promise<boolean> {
    const rows = await this.#pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM install_tokens
          WHERE organisation_id = $1 AND consumed_at IS NULL AND expires_at > now()
       ) AS exists`,
      [organisationId],
    );
    return rows.rows[0]?.exists === true;
  }
}
