/**
 * Login rate limiting (`docs/SECURITY.md` section 6.1, `docs/API.md` section
 * 19: "apply separate limits for authentication").
 *
 * A password is the one credential in this product a human chooses, so it is
 * the one an attacker can guess. The limiter bounds guesses per subject: after
 * a run of failures the subject is locked out for a growing interval, and a
 * success clears the record.
 *
 * Two design points are deliberate.
 *
 * **It lives in the database.** An in-process counter would reset on every
 * deployment and would count separately in each replica, which turns a limit of
 * five into a limit of five times however many processes are running.
 *
 * **It stores a digest of the subject rather than the subject.** Keying by the
 * submitted address would make this table a list of the addresses people have
 * tried to sign in as — an enumeration the product otherwise refuses to produce
 * (`docs/SECURITY.md` section 5), sitting in the one place an operator would
 * never think to look for personal data.
 *
 * It writes no event of its own: the refusal it produces is recorded as
 * `authentication.login_failed` with reason `rate_limited`, which is the audit
 * trail of the throttle engaging.
 */

import { createHash } from "node:crypto";

import type { Pool } from "../../db/pool.ts";

/** Failures allowed inside a window before the subject is locked out. */
export const MAX_FAILURES_PER_WINDOW = 5;

/** How long failures accumulate before the count starts again. */
export const FAILURE_WINDOW_SECONDS = 15 * 60;

/** Base lockout. It doubles for each further failure, up to the cap. */
export const BASE_LOCKOUT_SECONDS = 30;

/** Longest lockout a run of failures can produce. */
export const MAX_LOCKOUT_SECONDS = 15 * 60;

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** How long the caller must wait, in milliseconds. Zero when allowed. */
  readonly retryAfterMs: number;
}

export class LoginRateLimiter {
  readonly #pool: Pool;
  readonly #now: () => Date;

  constructor(pool: Pool, now: () => Date = () => new Date()) {
    this.#pool = pool;
    this.#now = now;
  }

  /**
   * Whether an attempt for this subject may proceed.
   *
   * The subject is whatever the caller decides identifies the attempt — an
   * address, an address and an address family, a client address. It is hashed
   * here, so a caller cannot accidentally store the raw value by passing it.
   */
  async check(subject: string): Promise<RateLimitDecision> {
    const rows = await this.#pool.query<{ locked_until: Date | null }>(
      `SELECT locked_until FROM authentication_attempt_limits WHERE subject_sha256 = $1`,
      [digest(subject)],
    );
    const lockedUntil = rows.rows[0]?.locked_until ?? null;
    if (lockedUntil === null) return { allowed: true, retryAfterMs: 0 };
    const remaining = lockedUntil.getTime() - this.#now().getTime();
    if (remaining <= 0) return { allowed: true, retryAfterMs: 0 };
    return { allowed: false, retryAfterMs: remaining };
  }

  /**
   * Records a failure and returns the decision that now applies.
   *
   * The whole update is one statement, so two concurrent failures cannot both
   * read a count of one and both write two.
   */
  async recordFailure(subject: string): Promise<RateLimitDecision> {
    const rows = await this.#pool.query<{ failure_count: number; locked_until: Date | null }>(
      `INSERT INTO authentication_attempt_limits (subject_sha256, window_started_at, failure_count, updated_at)
            VALUES ($1, now(), 1, now())
       ON CONFLICT (subject_sha256) DO UPDATE
              SET failure_count = CASE
                    WHEN authentication_attempt_limits.window_started_at < now() - make_interval(secs => $2::double precision)
                    THEN 1
                    ELSE authentication_attempt_limits.failure_count + 1
                  END,
                  window_started_at = CASE
                    WHEN authentication_attempt_limits.window_started_at < now() - make_interval(secs => $2::double precision)
                    THEN now()
                    ELSE authentication_attempt_limits.window_started_at
                  END,
                  updated_at = now()
        RETURNING failure_count, locked_until`,
      [digest(subject), FAILURE_WINDOW_SECONDS],
    );
    const failures = rows.rows[0]?.failure_count ?? 1;
    if (failures < MAX_FAILURES_PER_WINDOW) return { allowed: true, retryAfterMs: 0 };

    const lockoutSeconds = Math.min(
      BASE_LOCKOUT_SECONDS * 2 ** (failures - MAX_FAILURES_PER_WINDOW),
      MAX_LOCKOUT_SECONDS,
    );
    const locked = await this.#pool.query<{ locked_until: Date }>(
      `UPDATE authentication_attempt_limits
          SET locked_until = now() + make_interval(secs => $2::double precision), updated_at = now()
        WHERE subject_sha256 = $1
        RETURNING locked_until`,
      [digest(subject), lockoutSeconds],
    );
    const lockedUntil = locked.rows[0]?.locked_until;
    return {
      allowed: false,
      retryAfterMs:
        lockedUntil === undefined
          ? lockoutSeconds * 1000
          : Math.max(lockedUntil.getTime() - this.#now().getTime(), 0),
    };
  }

  /** Clears the record after a success, so a correct password ends a lockout. */
  async recordSuccess(subject: string): Promise<void> {
    await this.#pool.query(`DELETE FROM authentication_attempt_limits WHERE subject_sha256 = $1`, [
      digest(subject),
    ]);
  }
}

function digest(subject: string): string {
  return createHash("sha256").update(subject, "utf8").digest("hex");
}
