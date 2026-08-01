-- downgrade: not supported (forward-only; roll back by restoring the backup taken before the upgrade)
-- Widens the expiry index so the sweep can reach a route that never completed.
--
-- The sweep selected `status = 'ready'` only, so a publication that was asked
-- for and never finished — the connector never answered, or the process that
-- would have completed it went away — sat in `requested` past its expiry for
-- ever. It held a slot against the per-connector route limit the whole time,
-- and `docs/DOMAIN_MODEL.md` section 10's "nothing may leave a route in it
-- indefinitely" was true only while a one-second completion sweep happened to
-- be running in some replica.
--
-- The predicate now matches the query: both live statuses, ordered by expiry.
-- Recreating the index rather than adding a second one keeps a single answer to
-- "which routes are due", which is what the sweep asks.

DROP INDEX IF EXISTS published_services_expiry_idx;

CREATE INDEX IF NOT EXISTS published_services_expiry_idx
    ON published_services (expires_at)
    WHERE status IN ('requested', 'ready');
