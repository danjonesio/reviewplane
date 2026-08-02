-- downgrade: not supported (forward-only; roll back by restoring the backup taken before the upgrade)
-- The database backstop governs the status as well as the actor
-- (docs/SECURITY.md section 18, docs/DOMAIN_MODEL.md section 15, RVP-68 item 2).
--
-- `findings_disposition_is_human` (migration 0100) constrains
-- `resolved_by_actor_type`, which is what makes raw SQL setting it to
-- `agent_session` fail. It says nothing about `status`, so a future code path
-- that set `status = 'RESOLVED'` and left the disposition columns alone would
-- pass the backstop untouched. No such path exists today; every disposition in
-- the service writes both together. The gap is that the guarantee rested on a
-- convention the constraint did not enforce, and enforcing conventions is the
-- entire job of a backstop.
--
-- These two constraints close it from the other side: a terminal status cannot
-- exist without a disposition actor, and the existing constraints already
-- require that actor to be a human. Together they say that a finding is
-- RESOLVED only because a human resolved it, in the one place no caller can be
-- routed around.
--
-- This is deliberately not a backfill. A row in a terminal status with no
-- recorded decider is an audit defect, and inventing a `human_user` for it
-- would replace a visible defect with an invisible falsehood. The migration
-- fails on such a row, and the operator is told which one.

DO $$
DECLARE
    offending text;
BEGIN
    SELECT string_agg(id, ', ' ORDER BY id) INTO offending
      FROM findings
     WHERE status IN ('RESOLVED', 'WONT_FIX', 'DUPLICATE')
       AND resolved_by_actor_type IS NULL;
    IF offending IS NOT NULL THEN
        RAISE EXCEPTION
            'findings in a terminal status with no recorded human decider: %. '
            'This is an audit defect and cannot be repaired by a migration; '
            'restore the backup taken before the upgrade and report it.', offending;
    END IF;

    SELECT string_agg(id, ', ' ORDER BY id) INTO offending
      FROM reviews
     WHERE status = 'ACCEPTED'
       AND accepted_by_actor_type IS NULL;
    IF offending IS NOT NULL THEN
        RAISE EXCEPTION
            'reviews accepted with no recorded human decider: %. '
            'This is an audit defect and cannot be repaired by a migration; '
            'restore the backup taken before the upgrade and report it.', offending;
    END IF;
END
$$;

ALTER TABLE findings
    ADD CONSTRAINT findings_terminal_status_has_a_decider CHECK (
        status NOT IN ('RESOLVED', 'WONT_FIX', 'DUPLICATE')
        OR resolved_by_actor_type IS NOT NULL
    );

ALTER TABLE reviews
    ADD CONSTRAINT reviews_accepted_status_has_a_decider CHECK (
        status <> 'ACCEPTED' OR accepted_by_actor_type IS NOT NULL
    );
