-- Reviews: the durable system of record (docs/DOMAIN_MODEL.md section 14,
-- ADR-0004).
--
-- The review outlives the browser session it was captured from, so
-- `source_browser_session_id` is a reference and never an owner: terminating
-- the session must not take the review with it. The captured branch, commit
-- and workspace are stored on the row rather than derived, because the point
-- of the review is to still mean something after the code has moved on.
--
-- `organisation_id` and `project_id` are on the row itself for defence in
-- depth (docs/DOMAIN_MODEL.md section 3). They are derivable through the
-- project, but every query filters on them directly, so a missing join
-- condition cannot silently widen a read to another tenant.

CREATE TABLE reviews (
    id                        text        PRIMARY KEY,
    organisation_id           text        NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
    project_id                text        NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
    slug                      text        NOT NULL,
    title                     text        NOT NULL,
    description               text,
    status                    text        NOT NULL DEFAULT 'DRAFT',
    priority                  text,
    version                   integer     NOT NULL DEFAULT 1,
    created_by_actor_type     text        NOT NULL,
    created_by_actor_id       text,
    created_by_actor_display  text,
    assigned_user_id          text,
    assigned_agent_session_id text,
    captured_branch           text        NOT NULL,
    captured_commit           text        NOT NULL,
    captured_workspace_id     text        NOT NULL,
    source_browser_session_id text        REFERENCES browser_sessions (id) ON DELETE SET NULL,
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),
    closed_at                 timestamptz,
    CONSTRAINT reviews_status_known CHECK (
        status IN ('DRAFT', 'READY', 'ASSIGNED', 'IN_PROGRESS', 'AWAITING_HUMAN_REVIEW',
                   'CHANGES_REQUESTED', 'ACCEPTED', 'CANCELLED', 'ARCHIVED')
    ),
    CONSTRAINT reviews_actor_type_known CHECK (
        created_by_actor_type IN ('human_user', 'agent_session', 'connector',
                                  'browser_worker', 'system', 'integration')
    ),
    CONSTRAINT reviews_version_positive CHECK (version >= 1),
    CONSTRAINT reviews_slug_shape CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' AND length(slug) <= 64),
    CONSTRAINT reviews_commit_shape CHECK (captured_commit ~ '^[0-9a-f]{7,64}$')
);

-- The invariant of docs/DOMAIN_MODEL.md section 14: a slug is unique within
-- *active* reviews of one project, and not across projects. A withdrawn review
-- releases its name; an accepted one does not, because an agent told to work
-- on "bugs-on-homepage" must never face two candidates.
CREATE UNIQUE INDEX reviews_active_slug_unique
    ON reviews (project_id, slug)
    WHERE status NOT IN ('CANCELLED', 'ARCHIVED');

CREATE INDEX reviews_project_idx ON reviews (project_id, created_at DESC);
CREATE INDEX reviews_session_idx ON reviews (source_browser_session_id);
