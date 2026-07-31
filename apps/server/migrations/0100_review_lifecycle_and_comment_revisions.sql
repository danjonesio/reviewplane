-- The rest of the review aggregate (docs/DOMAIN_MODEL.md sections 14, 15, 18
-- and 24, RVP-37).
--
-- Migrations 0046, 0047 and 0053 stored the shape the Stage 0 proof needed:
-- enough of a review to retrieve `bugs-on-homepage`, and enough of a finding to
-- annotate one. This migration completes the aggregate the durable product loop
-- runs on, and four choices in it are load-bearing.
--
--   * `priority` was declared in 0046 and never constrained. An unconstrained
--     text column is not a vocabulary: it admits every misspelling, and a queue
--     ordered by it would silently order by nothing. It is constrained here and
--     defaulted to `medium`, because an absent priority in a queue is worse
--     than a stated ordinary one.
--   * `assigned_user_id` and `assigned_agent_session_id` were declared as plain
--     text. They now reference the rows they name. An assignment to a user that
--     does not exist is not an assignment, and a review that outlives the agent
--     session that held it must lose the claim rather than the review — so the
--     session reference is ON DELETE SET NULL while the user reference
--     restricts, matching the direction each record's lifetime runs in.
--   * Comment history is a chain rather than a mutable row. An edit inserts a
--     new comment carrying `supersedes_comment_id`, and the row it replaces is
--     stamped `superseded_at`. Nothing overwrites a body. docs/DOMAIN_MODEL.md
--     section 18 says comments are append-only and that editing creates a new
--     revision; a single unique index on `supersedes_comment_id` is what makes
--     "at most one successor" true under concurrency rather than by convention.
--   * A finding's final disposition records who decided it and why. The
--     authority rule of section 15 reserves that decision to a human, and an
--     audit trail that recorded only the status would say what was decided
--     without saying by whom — which is the half that matters when the question
--     is whether an agent crossed the boundary.
--
-- Staleness (section 24) needs no column here. `captured_branch`,
-- `captured_commit` and `captured_workspace_id` are already on `reviews` and
-- `captured_commit` is already on `findings`, so the Stage 2 calculation is a
-- read rather than a migration.

ALTER TABLE reviews
    ALTER COLUMN priority SET DEFAULT 'medium',
    ADD COLUMN reopen_count             integer     NOT NULL DEFAULT 0,
    ADD COLUMN accepted_at              timestamptz,
    ADD COLUMN accepted_by_actor_type   text,
    ADD COLUMN accepted_by_actor_id     text,
    ADD COLUMN accepted_by_actor_display text,

    ADD CONSTRAINT reviews_priority_known CHECK (
        priority IS NULL OR priority IN ('critical', 'high', 'medium', 'low')
    ),
    ADD CONSTRAINT reviews_reopen_count_non_negative CHECK (reopen_count >= 0),
    -- Only a human accepts. The domain layer refuses an agent before the write
    -- and the MCP layer cannot express the request (ADR-0020); this is the
    -- third statement of the same rule, in the one place no code path can go
    -- around. A row asserting that something else accepted a review is not
    -- storable.
    ADD CONSTRAINT reviews_acceptance_is_human CHECK (
        accepted_by_actor_type IS NULL OR accepted_by_actor_type = 'human_user'
    ),
    ADD CONSTRAINT reviews_acceptance_is_complete CHECK (
        (accepted_at IS NULL) = (accepted_by_actor_type IS NULL)
    ),
    ADD CONSTRAINT reviews_assigned_user_fk
        FOREIGN KEY (assigned_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    ADD CONSTRAINT reviews_assigned_agent_session_fk
        FOREIGN KEY (assigned_agent_session_id) REFERENCES agent_sessions (id) ON DELETE SET NULL;

UPDATE reviews SET priority = 'medium' WHERE priority IS NULL;

CREATE INDEX reviews_assigned_user_idx ON reviews (assigned_user_id)
    WHERE assigned_user_id IS NOT NULL;
CREATE INDEX reviews_assigned_agent_session_idx ON reviews (assigned_agent_session_id)
    WHERE assigned_agent_session_id IS NOT NULL;

ALTER TABLE findings
    ADD COLUMN resolved_at               timestamptz,
    ADD COLUMN resolved_by_actor_type    text,
    ADD COLUMN resolved_by_actor_id      text,
    ADD COLUMN resolved_by_actor_display text,
    ADD COLUMN disposition_reason        text,
    ADD COLUMN duplicate_of_finding_id   text,
    ADD COLUMN reopen_count              integer     NOT NULL DEFAULT 0,

    ADD CONSTRAINT findings_reopen_count_non_negative CHECK (reopen_count >= 0),
    -- The central authority invariant of AGENTS.md, expressed where no caller
    -- can be routed around it: a final disposition is a human decision.
    ADD CONSTRAINT findings_disposition_is_human CHECK (
        resolved_by_actor_type IS NULL OR resolved_by_actor_type = 'human_user'
    ),
    ADD CONSTRAINT findings_disposition_is_complete CHECK (
        (resolved_at IS NULL) = (resolved_by_actor_type IS NULL)
    ),
    -- A duplicate names what it duplicates, and never itself.
    ADD CONSTRAINT findings_duplicate_is_another_finding CHECK (
        duplicate_of_finding_id IS NULL OR duplicate_of_finding_id <> id
    ),
    ADD CONSTRAINT findings_duplicate_fk
        FOREIGN KEY (duplicate_of_finding_id) REFERENCES findings (id) ON DELETE SET NULL;

CREATE INDEX findings_duplicate_of_idx ON findings (duplicate_of_finding_id)
    WHERE duplicate_of_finding_id IS NOT NULL;

ALTER TABLE comments
    ADD COLUMN supersedes_comment_id text,
    ADD COLUMN superseded_at         timestamptz,

    ADD CONSTRAINT comments_supersedes_fk
        FOREIGN KEY (supersedes_comment_id) REFERENCES comments (id) ON DELETE RESTRICT,
    ADD CONSTRAINT comments_supersedes_is_another_comment CHECK (
        supersedes_comment_id IS NULL OR supersedes_comment_id <> id
    ),
    -- Revision 1 is an original and every later revision replaces exactly one
    -- earlier row. The pair is what makes the chain readable in either
    -- direction without a recursive query for the common case.
    ADD CONSTRAINT comments_first_revision_supersedes_nothing CHECK (
        (revision = 1) = (supersedes_comment_id IS NULL)
    );

-- One successor per revision. Without it, two concurrent edits of the same
-- comment would both insert revision 2 and the history would fork, which is not
-- a history anybody can read.
CREATE UNIQUE INDEX comments_one_successor_per_revision
    ON comments (supersedes_comment_id)
    WHERE supersedes_comment_id IS NOT NULL;

-- The current projection: the newest revision of each comment thread.
CREATE INDEX comments_current_review_idx ON comments (review_id, created_at)
    WHERE superseded_at IS NULL;
CREATE INDEX comments_current_finding_idx ON comments (finding_id, created_at)
    WHERE superseded_at IS NULL AND finding_id IS NOT NULL;

-- A review export is a rendering of the review itself, so it keeps the review's
-- retention rather than the evidence's: docs/SECURITY.md section 14 retains
-- findings and comments until project deletion.
ALTER TABLE artefacts
    DROP CONSTRAINT artefacts_retention_class_known,
    ADD CONSTRAINT artefacts_retention_class_known CHECK (
        retention_class IN ('action_screenshots', 'browser_traces', 'session_video',
                            'console_and_network_logs', 'verification_evidence',
                            'review_export')
    );

-- Review export (docs/API.md section 12, docs/REVIEW_FORMAT.md).
--
-- An export is a durable job that produces one artefact, so the request, the
-- job and the artefact have to be joined by something. This is that something,
-- and it exists rather than a column on `jobs` for two reasons: a job row is
-- machinery an operator reads, not a domain record a project owns; and the
-- artefact reference has to be restricted, so that retention cannot remove the
-- bytes of an export a caller still holds a link to.
--
-- `artefact_id` is NULL until the job succeeds, and the state constraint is
-- what stops a failed run leaving a half-written export that looks complete.
CREATE TABLE review_exports (
    id                        text        PRIMARY KEY,
    organisation_id           text        NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
    project_id                text        NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
    review_id                 text        NOT NULL REFERENCES reviews (id) ON DELETE CASCADE,
    job_id                    text        REFERENCES jobs (id) ON DELETE SET NULL,
    status                    text        NOT NULL DEFAULT 'pending',
    privacy_mode              text        NOT NULL DEFAULT 'metadata_only',
    artefact_id               text        REFERENCES artefacts (id) ON DELETE RESTRICT,
    sha256                    text,
    size_bytes                bigint,
    failure_reason            text,
    requested_by_actor_type   text        NOT NULL,
    requested_by_actor_id     text,
    requested_by_actor_display text,
    created_at                timestamptz NOT NULL DEFAULT now(),
    completed_at              timestamptz,
    CONSTRAINT review_exports_status_known CHECK (status IN ('pending', 'ready', 'failed')),
    CONSTRAINT review_exports_privacy_mode_known CHECK (
        privacy_mode IN ('metadata_only', 'redacted_evidence', 'full_evidence')
    ),
    CONSTRAINT review_exports_actor_type_known CHECK (
        requested_by_actor_type IN ('human_user', 'agent_session', 'connector',
                                    'browser_worker', 'system', 'integration')
    ),
    -- A ready export has its artefact and its digest; a pending or failed one
    -- has neither. A partial artefact is never reported as an export.
    CONSTRAINT review_exports_ready_is_complete CHECK (
        status <> 'ready'
        OR (artefact_id IS NOT NULL AND sha256 IS NOT NULL AND size_bytes IS NOT NULL
            AND completed_at IS NOT NULL)
    ),
    CONSTRAINT review_exports_unready_has_no_artefact CHECK (
        status = 'ready' OR artefact_id IS NULL
    ),
    CONSTRAINT review_exports_digest_shape CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT review_exports_size_non_negative CHECK (size_bytes IS NULL OR size_bytes >= 0)
);

CREATE INDEX review_exports_review_idx ON review_exports (review_id, created_at DESC);

-- One live export per review at a time. A caller that asks twice while the
-- first run is in flight joins it rather than queueing a second run over the
-- same rows.
CREATE UNIQUE INDEX review_exports_one_pending_per_review
    ON review_exports (review_id)
    WHERE status = 'pending';
