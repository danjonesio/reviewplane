/**
 * Agent credentials (`docs/SECURITY.md` section 6.3, `docs/ARCHITECTURE.md`
 * section 11).
 *
 * An agent credential is short-lived, bound to an organisation and to a set of
 * projects, capability scoped, and **distinct from a human session**. The last
 * property is the one that needs code rather than a comment, so it is enforced
 * in three separate places:
 *
 *   1. the token carries the `rpa_` prefix, and `requireAdministrator` in
 *      `auth.ts` refuses anything with it before it looks anything up;
 *   2. this store resolves nothing that is not in `agent_credentials`, so a
 *      viewer-session token or the bootstrap token is not an agent credential
 *      here;
 *   3. `viewer-sessions.ts` resolves nothing that is not in `viewer_sessions`,
 *      so an agent token is not a human session there.
 *
 * Only the digest of a token is stored, as for viewer sessions: a dump of this
 * table is not a set of usable credentials (`docs/SECURITY.md` section 6.1).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Pool } from "pg";

import { AGENT_CAPABILITY_VALUES } from "@reviewplane/protocol/mcp";

import { ApiError } from "../../errors.ts";
import { newId } from "../../ids.ts";

/**
 * Prefix every agent token carries.
 *
 * It is not a secret and it is not an identifier: it is a marker that lets an
 * administrative endpoint refuse an agent token by construction, without a
 * database round trip and without having to know whether the token is currently
 * valid. A refusal that depends on a lookup is a refusal that fails open when
 * the lookup does.
 */
export const AGENT_TOKEN_PREFIX = "rpa_";

/**
 * Capabilities a credential may carry.
 *
 * It **is** the schema's vocabulary, read from `packages/protocol` rather than
 * restated here. A copy stood in this file and said it was the schema's; it was
 * the schema's on the day it was written, and nothing would have failed if a
 * capability had been added to one list and not the other — the API would have
 * refused to issue a credential for a capability its own tools required
 * (`docs/DEVELOPMENT.md` §3).
 */
export const AGENT_CAPABILITIES: readonly string[] = AGENT_CAPABILITY_VALUES;

/** `docs/SECURITY.md` section 6.3: short-lived. One coding session. */
export const AGENT_CREDENTIAL_TTL_SECONDS = 3600;

/** The database refuses more; the API refuses it earlier and more clearly. */
export const AGENT_CREDENTIAL_MAX_TTL_SECONDS = 24 * 60 * 60;

export interface AgentCredential {
  readonly id: string;
  readonly organisationId: string;
  /** Projects the credential may act in. More than one is legal and ambiguous. */
  readonly projectIds: readonly string[];
  readonly capabilities: readonly string[];
  readonly label: string;
  readonly expiresAt: Date;
}

export interface IssuedAgentCredential extends AgentCredential {
  /** The raw token. Returned once, never stored, never logged. */
  readonly token: string;
}

/**
 * What a credential was at the moment it was revoked.
 *
 * Revocation is a permission change and `docs/SECURITY.md` section 16 requires
 * an audit record for one, which has to name the projects the credential
 * reached. Those are gone from the caller's view once the row is revoked, so
 * they are reported by the revocation rather than looked up after it.
 */
export interface RevokedAgentCredential {
  readonly id: string;
  readonly organisationId: string;
  readonly projectIds: readonly string[];
  readonly label: string;
}

interface RevokedRow {
  id: string;
  organisation_id: string;
  project_ids: string[];
  label: string;
}

function toRevoked(row: RevokedRow): RevokedAgentCredential {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    projectIds: row.project_ids,
    label: row.label,
  };
}

function digest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function digestMatches(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Whether a presented bearer token is shaped like an agent credential. */
export function looksLikeAgentToken(token: string): boolean {
  return token.startsWith(AGENT_TOKEN_PREFIX);
}

export class AgentCredentialStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * Issues a credential. The token is returned exactly once.
   *
   * Every argument is validated here rather than only by the table, because the
   * caller is an administrator making a security decision and deserves to be
   * told which part of it was wrong.
   */
  async issue(input: {
    readonly organisationId: string;
    readonly projectIds: readonly string[];
    readonly capabilities: readonly string[];
    readonly label: string;
    readonly issuedToClient?: string;
    readonly ttlSeconds?: number;
  }): Promise<IssuedAgentCredential> {
    if (input.projectIds.length === 0) {
      throw new ApiError(
        "UNSUPPORTED_CAPABILITY",
        "An agent credential must be bound to at least one project (docs/SECURITY.md section 6.3).",
        { field: "project_ids" },
      );
    }
    if (input.capabilities.length === 0) {
      throw new ApiError(
        "UNSUPPORTED_CAPABILITY",
        "An agent credential must be capability scoped; an empty set grants nothing and is refused rather than treated as everything.",
        { field: "capabilities" },
      );
    }
    for (const capability of input.capabilities) {
      if (!AGENT_CAPABILITIES.includes(capability)) {
        throw new ApiError("UNSUPPORTED_CAPABILITY", `Unknown agent capability ${capability}.`, {
          field: "capabilities",
        });
      }
    }
    const ttl = input.ttlSeconds ?? AGENT_CREDENTIAL_TTL_SECONDS;
    if (ttl < 1 || ttl > AGENT_CREDENTIAL_MAX_TTL_SECONDS) {
      throw new ApiError(
        "POLICY_DENIED",
        `An agent credential lives at most ${String(AGENT_CREDENTIAL_MAX_TTL_SECONDS)} seconds.`,
        { field: "ttl_seconds" },
      );
    }

    const rows = await this.#pool.query<{ id: string }>(
      "SELECT id FROM projects WHERE id = ANY($1) AND organisation_id = $2",
      [[...input.projectIds], input.organisationId],
    );
    if (rows.rows.length !== input.projectIds.length) {
      // A credential naming a project of another organisation would be a
      // cross-tenant grant, so the mismatch is refused rather than filtered.
      throw new ApiError(
        "PROJECT_CONTEXT_MISMATCH",
        "Every project must belong to the organisation the credential is issued for.",
        { field: "project_ids" },
      );
    }

    const token = `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const id = newId("agc_");
    const expiresAt = new Date(Date.now() + ttl * 1000);
    await this.#pool.query(
      `INSERT INTO agent_credentials
         (id, token_sha256, organisation_id, project_ids, capabilities, label, issued_to_client, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        digest(token),
        input.organisationId,
        [...input.projectIds],
        [...input.capabilities],
        input.label,
        input.issuedToClient ?? null,
        expiresAt.toISOString(),
      ],
    );
    return {
      id,
      token,
      organisationId: input.organisationId,
      projectIds: [...input.projectIds],
      capabilities: [...input.capabilities],
      label: input.label,
      expiresAt,
    };
  }

  /**
   * Resolves a presented token.
   *
   * Returns null for anything that is not a live, unexpired, unrevoked
   * credential. The caller must not distinguish the reasons to an
   * unauthenticated client (`docs/SECURITY.md` section 5): an expired token and
   * an invented one both produce `AUTHENTICATION_REQUIRED`.
   */
  async resolve(token: string | null): Promise<AgentCredential | null> {
    if (token === null || token === "" || !looksLikeAgentToken(token)) return null;
    const presented = digest(token);
    const rows = await this.#pool.query<{
      id: string;
      token_sha256: string;
      organisation_id: string;
      project_ids: string[];
      capabilities: string[];
      label: string;
      expires_at: Date;
    }>(
      `SELECT id, token_sha256, organisation_id, project_ids, capabilities, label, expires_at
         FROM agent_credentials
        WHERE token_sha256 = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [presented],
    );
    const row = rows.rows[0];
    if (row === undefined) return null;
    if (!digestMatches(row.token_sha256, presented)) return null;
    await this.#pool.query("UPDATE agent_credentials SET last_used_at = now() WHERE id = $1", [
      row.id,
    ]);
    return {
      id: row.id,
      organisationId: row.organisation_id,
      projectIds: row.project_ids,
      capabilities: row.capabilities,
      label: row.label,
      expiresAt: row.expires_at,
    };
  }

  /**
   * Revokes one credential, reporting what it was so the caller can audit it.
   *
   * `null` means there was nothing live to revoke, and a second call therefore
   * produces no second event.
   */
  async revoke(credentialId: string): Promise<RevokedAgentCredential | null> {
    const rows = await this.#pool.query<RevokedRow>(
      `UPDATE agent_credentials SET revoked_at = now()
        WHERE id = $1 AND revoked_at IS NULL
        RETURNING id, organisation_id, project_ids, label`,
      [credentialId],
    );
    const row = rows.rows[0];
    return row === undefined ? null : toRevoked(row);
  }

  /**
   * Revokes every live credential one client was issued.
   *
   * `issued_to_client` holds the connector identifier for a credential the
   * bridge exchange minted (ADR-0023), so this is how revoking a connector
   * identity reaches the credentials that identity produced. ADR-0023 accepts
   * that a compromised connector can mint agent credentials "for as long as its
   * identity is valid" precisely because revocation closes them; until this
   * existed, it did not.
   *
   * It is one statement rather than a loop over {@link revoke}, because the set
   * has to be closed at a single instant: a credential minted between two
   * iterations would survive the revocation that was meant to include it.
   *
   * A credential that has already expired is left alone. {@link resolve}
   * refuses it now and would go on refusing it, so revoking it would add an
   * audit record for a permission that had already ended and would inflate the
   * count `connector.revoked` reports as work the revocation did.
   */
  async revokeIssuedToClient(clientId: string): Promise<readonly RevokedAgentCredential[]> {
    const rows = await this.#pool.query<RevokedRow>(
      `UPDATE agent_credentials SET revoked_at = now()
        WHERE issued_to_client = $1 AND revoked_at IS NULL AND expires_at > now()
        RETURNING id, organisation_id, project_ids, label`,
      [clientId],
    );
    return rows.rows.map(toRevoked);
  }

  /**
   * Expires a credential immediately, without revoking it.
   *
   * The two are different refusals to reason about and the fault-injection
   * matrix of `docs/TESTING.md` section 11 asks specifically about expiry
   * mid-session, so a test must be able to produce it without waiting. Both
   * timestamps move, because the table refuses an expiry before creation.
   */
  async expireNow(credentialId: string): Promise<void> {
    await this.#pool.query(
      `UPDATE agent_credentials
          SET created_at = now() - interval '2 seconds',
              expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [credentialId],
    );
  }
}
