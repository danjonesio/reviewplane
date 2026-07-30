/**
 * The user record (`docs/DOMAIN_MODEL.md` section 5).
 *
 * Stage 1 has one organisation and one user (migration 0055), so nothing here
 * creates a user: it reads the seeded one, and it establishes or replaces the
 * credential on it. Memberships, roles and invitations are Stage 3, and their
 * absence is the reason this file is small rather than a sign that something is
 * missing.
 *
 * The credential write and its audit event commit together, through
 * `recordStateChange`: a password that changed without leaving a record would
 * be the one permission change in the product with no audit trail
 * (`docs/SECURITY.md` section 16).
 */

import type { User } from "@reviewplane/protocol/platform";

import { recordStateChange } from "../../events/append.ts";
import type { EventPublisher } from "../../events/append.ts";
import type { Pool, PoolClient } from "../../db/pool.ts";

export interface UserRecord {
  readonly id: string;
  readonly organisationId: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: "active" | "suspended";
  /** The stored verifier, or null when the account has no local credential. */
  readonly passwordHash: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface UserRow {
  readonly id: string;
  readonly organisation_id: string;
  readonly email: string;
  readonly display_name: string;
  readonly status: string;
  readonly password_hash: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const COLUMNS = `id, organisation_id, email, display_name, status, password_hash, created_at, updated_at`;

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    email: row.email,
    displayName: row.display_name,
    status: row.status === "suspended" ? "suspended" : "active",
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The API representation. It carries no verifier and no hash — only whether one
 * exists, which is the fact a first-run screen needs.
 */
export function userView(user: UserRecord): User {
  return {
    id: user.id,
    organisation_id: user.organisationId,
    email: user.email,
    display_name: user.displayName,
    status: user.status,
    local_credential_set: user.passwordHash !== null,
    created_at: user.createdAt.toISOString(),
    updated_at: user.updatedAt.toISOString(),
  };
}

export class UserStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async byId(userId: string): Promise<UserRecord | null> {
    const rows = await this.#pool.query<UserRow>(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [
      userId,
    ]);
    const row = rows.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  /**
   * Finds a user by address.
   *
   * The comparison is case-insensitive on the address as a whole. The local
   * part of an address is case-sensitive in the standard and case-insensitive
   * at every mail provider in practice, and a sign-in screen that refused
   * `Administrator@example.com` for an account created as
   * `administrator@example.com` would be reporting a fault that is not there.
   */
  async byEmail(organisationId: string, email: string): Promise<UserRecord | null> {
    const rows = await this.#pool.query<UserRow>(
      `SELECT ${COLUMNS} FROM users WHERE organisation_id = $1 AND lower(email) = lower($2)`,
      [organisationId, email],
    );
    const row = rows.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  /** The single Stage 1 user, whatever it is called. */
  async sole(organisationId: string): Promise<UserRecord | null> {
    const rows = await this.#pool.query<UserRow>(
      `SELECT ${COLUMNS} FROM users WHERE organisation_id = $1 ORDER BY created_at ASC, id ASC LIMIT 1`,
      [organisationId],
    );
    const row = rows.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  /**
   * Sets the address and the credential, and records that it happened.
   *
   * The event carries the user and the route the credential arrived by. It
   * carries nothing derived from the password: an append-only table is the
   * worst place in the system for credential material to end up
   * (`docs/EVENTS.md` section 8).
   */
  async setCredential(
    input: {
      readonly user: UserRecord;
      readonly email: string;
      readonly passwordHash: string;
      readonly method: "password" | "install_token";
      readonly requestId?: string;
      readonly actorDisplay?: string;
    },
    publisher?: EventPublisher,
  ): Promise<UserRecord> {
    const committed = await recordStateChange(
      this.#pool,
      {
        type: "user.credentials_set",
        organisationId: input.user.organisationId,
        actor: {
          type: "human_user",
          id: input.user.id,
          display: input.actorDisplay ?? input.user.displayName,
        },
        ...(input.requestId === undefined ? {} : { correlation: { request_id: input.requestId } }),
        payload: { user_id: input.user.id, method: input.method },
      },
      async (client: PoolClient) => {
        const rows = await client.query<UserRow>(
          `UPDATE users
              SET email = $2, password_hash = $3, password_updated_at = now(), updated_at = now()
            WHERE id = $1
        RETURNING ${COLUMNS}`,
          [input.user.id, input.email, input.passwordHash],
        );
        const row = rows.rows[0];
        if (row === undefined) throw new Error("identity: the user vanished during a credential change");
        return toRecord(row);
      },
      publisher,
    );
    return committed.result;
  }
}
