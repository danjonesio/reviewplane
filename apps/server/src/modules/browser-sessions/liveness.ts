/**
 * Browser-worker liveness: one definition, used by every path that decides
 * something (ADR-0027, RVP-70).
 *
 * The rule has two halves and both are needed.
 *
 * A **background transition** is what makes the stored state honest: a worker
 * that stops heartbeating is moved `active → degraded → lost`, and each move
 * emits its event, so an operator reading `browser_workers` or the timeline
 * sees a worker that is gone rather than one that is merely quiet. That is
 * `monitor.ts`.
 *
 * A **liveness term in the query** is what makes the decision safe. A worker
 * can die between two sweeps, and a scheduler that trusted `status = 'active'`
 * alone would dispatch a session to a container that no longer exists. The
 * caller would then see a session that never becomes ready, rather than
 * `BROWSER_CAPACITY_EXHAUSTED`, which is the diagnosable answer
 * `docs/UX_FLOWS.md` section 18 promises.
 *
 * Both halves read {@link WORKER_LIVE_PREDICATE}, and so does `reviewplane
 * status` and the session reconciler. Before RVP-70 the reporting layer held
 * the only copy of this expression and nothing else applied it at all; a second
 * and third copy would have been worse than one, so it lives here and every
 * reader imports it.
 */

/**
 * The SQL a live worker satisfies, as a fragment over a `browser_workers` row.
 *
 * `$N` is the silence budget in seconds. `greatest` ignores nulls, so a worker
 * that has registered and not yet reached its first heartbeat counts from its
 * registration: without that, a freshly started deployment would report no
 * capacity for the first heartbeat interval, which is a false alarm in exactly
 * the minute an operator is watching the installation come up.
 *
 * It is a function of the parameter index rather than a constant string because
 * callers place it in queries with different parameter counts, and a fragment
 * that silently assumed `$1` would be wrong in the only interesting cases.
 */
export function workerLivePredicate(parameterIndex: number): string {
  return `greatest(last_heartbeat_at, registered_at) > now() - make_interval(secs => $${String(parameterIndex)}::double precision)`;
}

/** The same expression at `$1`, for the common single-parameter query. */
export const WORKER_LIVE_PREDICATE = workerLivePredicate(1);

/**
 * Worker statuses that may still be scheduled onto or counted as capacity.
 *
 * `degraded` is here: a worker that missed a heartbeat has not necessarily
 * gone, and removing it from the pool the instant it is late would make a
 * momentary delay indistinguishable from a crash. What excludes it in practice
 * is the liveness term above, which a degraded worker fails by definition —
 * the status is the audit record and the term is the decision. `lost` and
 * `revoked` are excluded outright: those are conclusions, not suspicions.
 */
export const SCHEDULABLE_WORKER_STATUSES: readonly string[] = ["active", "degraded"];

/** Worker lifecycle statuses, as `browser_workers.status` stores them. */
export type WorkerStatus = "active" | "degraded" | "lost" | "revoked";
