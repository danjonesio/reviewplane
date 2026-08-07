-- downgrade: not supported (forward-only; roll back by restoring the backup taken before the upgrade)
-- A browser-session reservation records the route it is *asking* to be admitted
-- to, separately from the route it *is* bound to (ADR-0037).
--
-- Binding mints a session-scoped route capability, the control plane is the
-- minting authority (docs/ARCHITECTURE.md section 7.3), and the signing key is
-- read by the `api` process alone — the MCP endpoint is deliberately built
-- without one, because a process that cannot mint cannot leak a minting key
-- (ADR-0020, ADR-0021). So an agent's allocation is two phases: the MCP process
-- records the request here and touches nothing outside PostgreSQL, and the
-- process holding the key claims it, authorises it, mints and allocates.
--
-- `published_service_id` is not overloaded for this. That column is what the
-- agent-facing view calls "published service this session may reach", and a
-- session that has asked to reach one and not yet been authorised may reach
-- nothing: writing the request into it would make the view's own description
-- untrue for exactly the window in which the authorisation has not run.
--
-- `allocation_requested_at` is the second column and it is not decoration. The
-- deadline that ends a reservation nothing completes has to be measured from
-- when allocation was asked for, never from when the session was reserved: an
-- agent reserves a session, publishes a route naming it — which can take as long
-- as a connector takes to answer — and only then allocates, so a deadline
-- measured from `created_at` would fail the allocation of every reservation that
-- spent longer than the grace being made useful. `published_services` records
-- `requested_at` for the same sweep and for the same reason.

ALTER TABLE browser_sessions
    ADD COLUMN requested_published_service_id text
        REFERENCES published_services (id) ON DELETE SET NULL,
    ADD COLUMN allocation_requested_at timestamptz;

-- The two are written together and read together, so a row carrying one without
-- the other is a state no code produces and no reader can interpret. The
-- constraint is the backstop: the sweep selects on the timestamp and the claim
-- selects on the route, and a row with a route and no timestamp would be
-- invisible to the sweep for ever while still counting against the worker's
-- capacity.
ALTER TABLE browser_sessions
    ADD CONSTRAINT browser_sessions_requested_route_has_a_time CHECK (
        (requested_published_service_id IS NULL) = (allocation_requested_at IS NULL)
    );

-- The completion sweep's query: reservations carrying a requested route, oldest
-- first. It is a partial index because the rows it selects are a handful at any
-- instant and the table is dominated by sessions that never asked for one — a
-- reservation made with `allocate: false` and no route is somebody's in-progress
-- work and the sweep must not touch it.
CREATE INDEX browser_sessions_allocation_pending_idx
    ON browser_sessions (allocation_requested_at)
    WHERE requested_published_service_id IS NOT NULL AND ended_at IS NULL;
