-- downgrade: not supported (forward-only; roll back by restoring the backup taken before the upgrade)
-- Verification supersession (docs/DOMAIN_MODEL.md section 19, ADR-0030, RVP-53).
--
-- A finding may accumulate several verifications across reopen cycles, and
-- exactly one of them is current. Before this migration a second submission
-- simply added a row, so "the latest verification" was whichever
-- `submitted_at DESC LIMIT 1` happened to return and there was no stored fact
-- saying which claim the finding stood on. Three things here are load-bearing.
--
--   * A superseded record is **kept**. Deleting the previous claim would
--     destroy the evidence of what was asserted before, which is precisely the
--     history a reopen cycle exists to preserve (`docs/DOMAIN_MODEL.md`
--     section 15: "Reopening preserves prior verification history"). The
--     earlier row moves to `superseded` and gains a forward pointer.
--
--   * The forward pointer is `RESTRICT`, like every other evidence reference
--     in this schema. A chain whose links can vanish is not a history.
--
--   * `verifications_one_current_per_finding` is a partial unique index over
--     `finding_id` where the status is `submitted`. It is what makes "exactly
--     one current" a property of the database rather than a convention the
--     service is trusted to keep: two concurrent submissions on one finding
--     produce one current claim and one unique violation, not two rows that
--     each believe they are the latest. The service takes a row lock on the
--     finding first, so the ordinary path never reaches the index; the index is
--     there for the path nobody thought of.
--
-- `superseded_at` is separate from the status because a reader asking when a
-- claim stopped being current should not have to go looking for the submission
-- that replaced it.

ALTER TABLE verifications
    ADD COLUMN superseded_at                 timestamptz,
    ADD COLUMN superseded_by_verification_id text,
    ADD COLUMN supersedes_verification_id    text,

    ADD CONSTRAINT verifications_supersession_is_complete CHECK (
        (superseded_at IS NULL) = (superseded_by_verification_id IS NULL)
    ),
    -- A record that names a successor is superseded, and one that is superseded
    -- names its successor. Without this the status and the columns could
    -- disagree, and the status is what every read path filters on.
    ADD CONSTRAINT verifications_superseded_status_agrees CHECK (
        (status = 'superseded') = (superseded_by_verification_id IS NOT NULL)
    ),
    ADD CONSTRAINT verifications_supersedes_is_another_verification CHECK (
        supersedes_verification_id IS NULL OR supersedes_verification_id <> id
    ),
    ADD CONSTRAINT verifications_superseded_by_is_another_verification CHECK (
        superseded_by_verification_id IS NULL OR superseded_by_verification_id <> id
    ),
    ADD CONSTRAINT verifications_superseded_by_fk
        FOREIGN KEY (superseded_by_verification_id) REFERENCES verifications (id) ON DELETE RESTRICT,
    ADD CONSTRAINT verifications_supersedes_fk
        FOREIGN KEY (supersedes_verification_id) REFERENCES verifications (id) ON DELETE RESTRICT;

-- Existing rows: where a finding already carries more than one submission, the
-- newest keeps `submitted` and every older one becomes `superseded` pointing at
-- the row that replaced it. Doing this before the index is created is the point
-- — an installation upgraded from Stage 0 may hold exactly the shape the index
-- forbids, and an upgrade that failed on its own history would be an outage.
WITH ordered AS (
    SELECT id,
           finding_id,
           submitted_at,
           lag(id) OVER (PARTITION BY finding_id ORDER BY submitted_at DESC, id DESC) AS newer_id
      FROM verifications
     WHERE status = 'submitted'
)
UPDATE verifications v
   SET status                        = 'superseded',
       superseded_at                 = v.submitted_at,
       superseded_by_verification_id = ordered.newer_id
  FROM ordered
 WHERE v.id = ordered.id
   AND ordered.newer_id IS NOT NULL;

UPDATE verifications v
   SET supersedes_verification_id = older.id
  FROM verifications older
 WHERE older.superseded_by_verification_id = v.id;

CREATE UNIQUE INDEX verifications_one_current_per_finding
    ON verifications (finding_id)
    WHERE status = 'submitted';

CREATE INDEX verifications_superseded_by_idx ON verifications (superseded_by_verification_id)
    WHERE superseded_by_verification_id IS NOT NULL;
