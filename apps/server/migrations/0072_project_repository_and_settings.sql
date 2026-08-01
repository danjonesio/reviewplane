-- downgrade: not supported (forward-only; roll back by restoring the backup taken before the upgrade)
-- The rest of the project record (docs/DOMAIN_MODEL.md section 6, RVP-12).
--
-- Migration 0002 declared only the columns Stage 0 read and said the repository
-- identity and the settings would arrive with the issue that uses them. This is
-- that issue.
--
--   * `repository_identity` is the provider-agnostic canonical form plus the
--     clone URLs that reduce to it. It is jsonb rather than two columns because
--     the shape is defined once, in schemas/platform/v1.schema.json, and a
--     column-per-member here would be a second definition to keep in step.
--   * `default_branch` is what a review is captured against when nothing says
--     otherwise. It defaults to `main` rather than being nullable: every
--     existing project has one in practice, and a null would make every reader
--     invent a fallback.
--   * `settings` holds the default validation viewports. The default value is
--     390x844 and 1440x900, which AGENTS.md requires browser-facing work to be
--     checked at.
--   * `version` is the optimistic-concurrency counter of docs/API.md section
--     5.2. A PATCH that carries a stale expected_version is refused rather than
--     overwriting a change the caller never saw.
--
-- Archival is a status change and not a deletion (docs/API.md section 8):
-- reviews, findings, artefacts and the audit trail all outlive it, so the
-- status is constrained and `archived_at` records when it happened.

ALTER TABLE projects
    ADD COLUMN repository_identity jsonb,
    ADD COLUMN default_branch      text        NOT NULL DEFAULT 'main',
    ADD COLUMN settings            jsonb       NOT NULL DEFAULT
        '{"default_validation_viewports": [{"width": 390, "height": 844}, {"width": 1440, "height": 900}]}'::jsonb,
    ADD COLUMN version             integer     NOT NULL DEFAULT 1,
    ADD COLUMN archived_at         timestamptz,

    ADD CONSTRAINT projects_status_known CHECK (status IN ('active', 'archived')),
    ADD CONSTRAINT projects_version_positive CHECK (version >= 1),
    ADD CONSTRAINT projects_archived_at_matches_status CHECK (
        (status = 'archived') = (archived_at IS NOT NULL)
    ),
    -- The application validates the whole shape against the schema; the
    -- database refuses the two things that would make a row unreadable to every
    -- consumer at once.
    ADD CONSTRAINT projects_repository_identity_has_canonical CHECK (
        repository_identity IS NULL
        OR jsonb_typeof(repository_identity -> 'canonical') = 'string'
    ),
    ADD CONSTRAINT projects_settings_have_viewports CHECK (
        jsonb_typeof(settings -> 'default_validation_viewports') = 'array'
        AND jsonb_array_length(settings -> 'default_validation_viewports') BETWEEN 1 AND 8
    );

-- "Which project is this checkout for?" is the question a connector asks, and
-- it asks it by canonical identity.
CREATE INDEX projects_repository_canonical_index
    ON projects ((repository_identity ->> 'canonical'))
    WHERE repository_identity IS NOT NULL;
