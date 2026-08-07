-- downgrade: not supported (forward-only; roll back by restoring the backup taken before the upgrade)
-- A decided verification records when it was decided, not only by whom
-- (docs/DOMAIN_MODEL.md section 19, docs/UX_FLOWS.md section 13, ADR-0035).
--
-- Migration 0053 already refuses a verification that leaves `submitted` or
-- `superseded` without a `human_user` in `reviewed_by_actor_type`, so an
-- `accepted` row with no decider is refused today. What 0053 does **not**
-- govern is the reverse direction: a row that is still `submitted` — or
-- `superseded` — while carrying a `reviewed_at`. That is a decision time
-- recorded against a claim nobody decided, and nothing refuses it.
--
-- `docs/UX_FLOWS.md` section 13 requires accept to record human identity **and
-- timestamp**. The identity half is enforced; this constraint states the
-- timestamp half in both directions, so the two columns cannot disagree about
-- whether the row was decided at all.
--
-- The forward direction — `accepted` or `rejected` implies `reviewed_at` — is
-- therefore belt to 0053's braces rather than a new guarantee on its own, and
-- it is stated anyway because an equality a reader can check in one line is
-- worth more than two constraints they have to compose. It is also what makes
-- the mutation legible: a service that sets the status and forgets the time is
-- refused by name here rather than by a constraint about actors.
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
