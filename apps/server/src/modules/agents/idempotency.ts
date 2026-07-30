/**
 * Idempotency for state-changing agent tools (`docs/MCP_SPEC.md` section 10).
 *
 * The specification is two sentences: the key is scoped to actor, tool and
 * project, and reusing a key with different input returns
 * `IDEMPOTENCY_CONFLICT`. Both are load-bearing, and the second is the one that
 * needs a stored digest rather than a stored key.
 *
 * `docs/TESTING.md` section 11 adds the property this exists for: a duplicate
 * verification request must produce **one** verification record. So the key is
 * claimed in its own transaction *before* the operation runs, and the operation
 * only runs for the caller that won the claim. A retry after a successful call
 * replays the stored response and writes nothing; a retry that arrives while
 * the first call is still in flight is told to wait rather than allowed to run
 * the operation concurrently.
 */

import { createHash } from "node:crypto";

import type { Pool } from "pg";

import { ApiError } from "../../errors.ts";
import type { ActorType } from "../../events/append.ts";

/** How long a key is remembered. A retry loop is minutes, not days. */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** How long a caller is asked to wait for an in-flight duplicate. */
const IN_FLIGHT_RETRY_AFTER_MS = 500;

export interface IdempotencyScope {
  readonly projectId: string;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly tool: string;
  readonly key: string;
}

export type IdempotencyOutcome =
  | { readonly replayed: true; readonly response: unknown }
  | { readonly replayed: false };

/**
 * Canonical digest of the arguments a key was used with.
 *
 * Keys are sorted so that `{a, b}` and `{b, a}` are the same request: an agent
 * that rebuilt its argument object between retries has not made a different
 * request, and telling it that it had would make idempotency useless.
 */
export function requestDigest(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${stableJson(member)}`).join(",")}}`;
}

export class IdempotencyStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * Claims a key, or reports what the first use of it produced.
   *
   * Returns `{replayed: true}` with the stored response when the same key was
   * used with the same arguments and the call finished. Throws
   * `IDEMPOTENCY_CONFLICT` when the arguments differ. Returns
   * `{replayed: false}` when this caller now owns the key and must run the
   * operation.
   */
  async claim(scope: IdempotencyScope, digest: string): Promise<IdempotencyOutcome> {
    const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_SECONDS * 1000).toISOString();
    const inserted = await this.#pool.query(
      `INSERT INTO idempotency_keys
         (project_id, actor_type, actor_id, tool, key, request_sha256, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (project_id, actor_type, actor_id, tool, key) DO NOTHING`,
      [scope.projectId, scope.actorType, scope.actorId, scope.tool, scope.key, digest, expiresAt],
    );
    if (inserted.rowCount === 1) return { replayed: false };

    const existing = await this.#pool.query<{ request_sha256: string; response: unknown }>(
      `SELECT request_sha256, response FROM idempotency_keys
        WHERE project_id = $1 AND actor_type = $2 AND actor_id = $3 AND tool = $4 AND key = $5`,
      [scope.projectId, scope.actorType, scope.actorId, scope.tool, scope.key],
    );
    const row = existing.rows[0];
    if (row === undefined) {
      // The row vanished between the insert and the read, which means an expiry
      // sweep removed it. Treat it as a fresh claim rather than as a conflict.
      return this.claim(scope, digest);
    }
    if (row.request_sha256 !== digest) {
      throw new ApiError(
        "IDEMPOTENCY_CONFLICT",
        `The idempotency key ${scope.key} was already used for ${scope.tool} with different arguments. Choose a new key, or repeat the original request exactly.`,
        { field: "idempotency_key" },
      );
    }
    if (row.response === null) {
      throw new ApiError(
        "RATE_LIMITED",
        "The first call with this idempotency key has not finished. Retry shortly; it will not run twice.",
        { retry_after_ms: IN_FLIGHT_RETRY_AFTER_MS },
      );
    }
    return { replayed: true, response: row.response };
  }

  /** Records the response a claimed key produced. */
  async complete(scope: IdempotencyScope, response: unknown): Promise<void> {
    await this.#pool.query(
      `UPDATE idempotency_keys
          SET response = $6::jsonb, completed_at = now()
        WHERE project_id = $1 AND actor_type = $2 AND actor_id = $3 AND tool = $4 AND key = $5`,
      [
        scope.projectId,
        scope.actorType,
        scope.actorId,
        scope.tool,
        scope.key,
        JSON.stringify(response),
      ],
    );
  }

  /**
   * Releases a claimed key after a failed operation.
   *
   * A refusal is not a result to replay: an agent that fixes its arguments and
   * retries with the same key would otherwise be handed the refusal for ever.
   * Removing the row is safe because nothing was written.
   */
  async release(scope: IdempotencyScope): Promise<void> {
    await this.#pool.query(
      `DELETE FROM idempotency_keys
        WHERE project_id = $1 AND actor_type = $2 AND actor_id = $3 AND tool = $4 AND key = $5
          AND response IS NULL`,
      [scope.projectId, scope.actorType, scope.actorId, scope.tool, scope.key],
    );
  }
}
