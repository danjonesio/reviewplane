-- downgrade: not supported (forward-only; roll back by restoring the backup taken before the upgrade)
-- Browser-worker liveness (RVP-70, ADR-0027).
--
-- `browser_workers.status` has admitted 'degraded' and 'lost' since 0042 and
-- nothing ever wrote either: `last_heartbeat_at` was written on every heartbeat
-- and then read by nothing. A worker whose container had stopped stayed
-- 'active' for ever, so capacity accounting and the scheduler both counted a
-- worker that was gone, and a session dispatched to it never became ready
-- instead of being refused with BROWSER_CAPACITY_EXHAUSTED.
--
-- This adds what a transition needs to be auditable rather than inferred, and
-- the index the liveness predicate reads.

ALTER TABLE browser_workers
    ADD COLUMN degraded_at timestamptz,
    ADD COLUMN lost_at     timestamptz;

COMMENT ON COLUMN browser_workers.degraded_at IS
    'When the worker was last moved to degraded by the liveness sweep. Cleared on the heartbeat that recovers it.';
COMMENT ON COLUMN browser_workers.lost_at IS
    'When the worker was last moved to lost by the liveness sweep. Cleared on the heartbeat that recovers it.';

-- The sweep and every decision path filter on the same expression:
--   greatest(last_heartbeat_at, registered_at) > now() - interval
-- `greatest` ignores nulls, so a worker that has registered and not yet reached
-- its first heartbeat counts from its registration rather than reading as dead
-- during the first interval of an installation coming up.
CREATE INDEX browser_workers_liveness_idx
    ON browser_workers (status, last_heartbeat_at, registered_at);
