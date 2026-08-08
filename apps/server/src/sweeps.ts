/**
 * The background sweeps a running control plane owes the rest of the system.
 *
 * They live here rather than in an entry point because there are two entry
 * points and only one of them had them. `node dist/main.js` started all four;
 * `reviewplane serve` started none — and `reviewplane serve` is what the
 * shipped Compose deployment runs (`deploy/compose/compose.yaml`, the `api`
 * service's `command`). So a deployment an operator installs by following
 * `docs/DEPLOYMENT.md` §8 ran a control plane that:
 *
 *   * never finished a route the MCP endpoint requested, so an agent's
 *     `development_service_publish` stayed `requested` until its call gave up
 *     (ADR-0021) — which is the whole of what RVP-90 grants an agent;
 *   * never finished a browser-session allocation the MCP endpoint requested,
 *     for the same reason one layer down (ADR-0037);
 *   * never expired a published service, so a route outlived its `expires_at`;
 *   * never failed an allocation past its deadline, so a `REQUESTED` row with
 *     no `ended_at` went on counting against worker capacity for ever.
 *
 * Every one of those is a promise made in a document and kept only by the
 * development entry point. Starting them from one function that both entry
 * points call is what keeps the two from drifting again; the alternative —
 * starting them inside `buildApp` — would run them under every test that builds
 * an app, where a sweep completing a route a test means to observe as
 * `requested` is a race rather than a fix.
 */

import type { BuiltApp } from "./app.ts";
import type { ServerConfig } from "./config.ts";
import { ALLOCATION_GRACE_MS } from "./domain.ts";

/** How often published-service expiry is enforced. */
export const SWEEP_INTERVAL_MS = 30_000;

/**
 * How often routes another process requested are finished (ADR-0021).
 *
 * It is much shorter than the expiry sweep because somebody is waiting on it:
 * an agent that called `development_service_publish` is holding an MCP call
 * open until the route is `ready` or `failed`. The query is a partial index
 * scan over the handful of rows still in `requested`, so a second is cheap; a
 * connector's startup grace is ten seconds, and this must not be what dominates
 * the wait.
 */
export const PENDING_INTERVAL_MS = 1_000;

/**
 * How long a route may sit `requested` before the sweep takes it over.
 *
 * The API publishes inline, so a route it is working on is milliseconds old.
 * Waiting two seconds before the sweep touches one keeps the two paths from
 * asking the same connector to open the same destination twice.
 */
export const PENDING_GRACE_MS = 2_000;

/**
 * Starts every background sweep and returns the function that stops them.
 *
 * Each interval is `unref`ed, so none of them holds the process open at
 * shutdown; the returned function clears them anyway, so a caller that keeps
 * running after stopping the app is not still sweeping on its behalf.
 */
export function startBackgroundSweeps(built: BuiltApp, config: ServerConfig): () => void {
  const expiry = setInterval(() => {
    built.publishedServices.expireDue().catch((error: unknown) => {
      built.app.log.error({ err: error }, "published-service expiry sweep failed");
    });
  }, SWEEP_INTERVAL_MS);
  expiry.unref();

  // The connector's control channel terminates in this process, so this is the
  // only process that can finish a publication (ADR-0021). A deployment that
  // runs several `api` replicas runs several of these; `markReady` and
  // `markFailed` both refuse a record whose status has already moved, so the
  // duplicate is a wasted acknowledgement rather than a second route.
  const pending = setInterval(() => {
    built.publishedServices
      .completePending({ olderThanMs: PENDING_GRACE_MS })
      .catch((error: unknown) => {
        built.app.log.error({ err: error }, "published-service completion sweep failed");
      });
  }, PENDING_INTERVAL_MS);
  pending.unref();

  // The same split, for the same reason, one layer down (ADR-0037). Admitting a
  // browser session to a route mints a session-scoped capability, the signing
  // key is read by this process alone, and the MCP endpoint is deliberately
  // built without one. So the endpoint records the request and this sweep
  // completes it — and a second sweep ends any reservation nothing completed,
  // because a `REQUESTED` row with `ended_at IS NULL` is exactly what the worker
  // capacity query counts.
  const allocations = setInterval(() => {
    built.sessions
      .completePendingAllocations({ olderThanMs: ALLOCATION_GRACE_MS })
      .catch((error: unknown) => {
        built.app.log.error({ err: error }, "browser-session allocation sweep failed");
      });
  }, PENDING_INTERVAL_MS);
  allocations.unref();

  const overdue = setInterval(() => {
    built.sessions
      .failOverdueAllocations({ deadlineMs: config.allocationDeadlineSeconds * 1000 })
      .catch((error: unknown) => {
        built.app.log.error({ err: error }, "browser-session allocation deadline sweep failed");
      });
  }, SWEEP_INTERVAL_MS);
  overdue.unref();

  return () => {
    clearInterval(expiry);
    clearInterval(pending);
    clearInterval(allocations);
    clearInterval(overdue);
  };
}
