/**
 * Published-service events.
 *
 * `docs/EVENTS.md` section 7 names them. The writer itself is the one shared
 * append-only writer in `src/events/append.ts`: section 9 requires the state
 * change and its event to commit in one transaction, and a second writer would
 * be a second place for that rule to be got wrong.
 *
 * Payload rules are section 8: stable identifiers, previous and new state,
 * reason codes for denial, and no raw secrets or sensitive headers. A
 * capability value never appears — the identifier does, which is what
 * revocation and audit actually need.
 */

/** The published-service events of `docs/EVENTS.md` section 7. */
export const PUBLISHED_SERVICE_EVENTS = [
  "published_service.requested",
  "published_service.ready",
  "published_service.failed",
  "published_service.expired",
  "published_service.revoked",
] as const;

export type PublishedServiceEvent = (typeof PUBLISHED_SERVICE_EVENTS)[number];

export type { ActorType, EventActor, EventCorrelation } from "../../events/append.ts";
