-- Supports the sweep that finishes publications another process asked for
-- (docs/CONNECTOR_PROTOCOL.md section 11, ADR-0021).
--
-- A connector dials the control plane, so its control channel lives in the
-- `api` process and nowhere else. The MCP endpoint is a separate process
-- (ADR-0020) sharing only the database, so a route it requests is finished by
-- `api` reading this predicate on a short interval. The index is partial
-- because the rows it selects are a handful at any instant and every other row
-- in the table is one the sweep must not read: an index over the whole table
-- would grow with every route the deployment has ever published, to answer a
-- question only about the ones still waiting.
--
-- It is the third partial index on this table, beside the ones for the
-- connector's live routes and the expiry sweep, and it is deliberately shaped
-- the same way: status first as the constant, then the column the sweep orders
-- by.

CREATE INDEX IF NOT EXISTS published_services_pending_idx
    ON published_services (requested_at)
    WHERE status = 'requested';
