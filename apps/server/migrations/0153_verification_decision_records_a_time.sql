-- downgrade: not supported (forward-only; roll back by restoring the backup taken before the upgrade)
-- A decided verification records when it was decided, not only by whom
-- (docs/DOMAIN_MODEL.md section 19, docs/UX_FLOWS.md section 13, ADR-0035).
--
-- Migration 0053 already refuses a verification that leaves `submitted` or
-- `superseded` without a `human_user` in `reviewed_by_actor_type`. That governs
-- the actor and says nothing about the time, so a code path that recorded the
-- decider and left `reviewed_at` null would satisfy the backstop while leaving
-- an acceptance that cannot be placed in a timeline.
--
-- `docs/UX_FLOWS.md` section 13 requires accept to record human identity **and
-- timestamp**. Half of that was enforced by the database and half by the
-- service, which is the same asymmetry migration 0151 closed for findings: a
-- guarantee resting on a convention the constraint does not enforce is a
-- convention, not a guarantee.
--
-- The equality is stated in both directions deliberately. A `submitted` row
-- carrying a review time would be a decision recorded without a decider, which
-- the 0053 constraint would not catch either.
--
-- As in 0151 this is not a backfill. A decided row with no time is an audit
-- defect, and inventing one would replace a visible defect with an invisible
-- falsehood. The migration fails on such a row and names it.

DO $$
DECLARE
    offending text;
BEGIN
    SELECT string_agg(id, ', ' ORDER BY id) INTO offending
      FROM verifications
     WHERE (status IN ('accepted', 'rejected')) <> (reviewed_at IS NOT NULL);

    IF offending IS NOT NULL THEN
        RAISE EXCEPTION
            'verifications rows disagree about whether they were decided: %. A row whose status is accepted or rejected must carry reviewed_at, and a row that carries reviewed_at must be accepted or rejected. Repair these rows before upgrading.',
            offending;
    END IF;
END
$$;

ALTER TABLE verifications
    ADD CONSTRAINT verifications_decision_records_a_time CHECK (
        (status IN ('accepted', 'rejected')) = (reviewed_at IS NOT NULL)
    );

COMMENT ON CONSTRAINT verifications_decision_records_a_time ON verifications IS
    'A human decision on a verification records when it was taken. docs/UX_FLOWS.md section 13 requires identity and timestamp; 0053 governs the identity and this governs the time.';
