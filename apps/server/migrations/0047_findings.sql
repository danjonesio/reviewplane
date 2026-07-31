-- downgrade: not supported (forward-only; roll back by restoring the backup taken before the upgrade)
-- Findings: one actionable unit inside a review (docs/DOMAIN_MODEL.md
-- section 15) with the captured context of docs/UX_FLOWS.md section 9.
--
-- Two column choices are load-bearing rather than incidental.
--
-- `source` records whether a human or an agent authored the finding, on the
-- first row and for the life of the finding. The authority rule "a
-- human-authored finding cannot be finally accepted by an agent" is decided on
-- this column, so deriving it later from an actor table would make the rule
-- depend on a join that could go missing.
--
-- `screenshot_artefact_id` is NOT NULL and restricts deletion of the artefact.
-- A finding is a claim about something that was seen; without the original
-- evidence it is an opinion. The restriction means retention cannot quietly
-- remove the evidence out from under a live finding.

CREATE TABLE findings (
    id                          text        PRIMARY KEY,
    organisation_id             text        NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
    project_id                  text        NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
    review_id                   text        NOT NULL REFERENCES reviews (id) ON DELETE CASCADE,
    title                       text        NOT NULL,
    description                 text,
    severity                    text        NOT NULL,
    status                      text        NOT NULL DEFAULT 'OPEN',
    source                      text        NOT NULL,
    version                     integer     NOT NULL DEFAULT 1,
    created_by_actor_type       text        NOT NULL,
    created_by_actor_id         text,
    created_by_actor_display    text,
    claimed_by_actor_type       text,
    claimed_by_actor_id         text,
    claimed_by_actor_display    text,
    url                         text        NOT NULL,
    viewport                    jsonb       NOT NULL,
    scroll_position             jsonb       NOT NULL,
    captured_commit             text        NOT NULL,
    screenshot_artefact_id      text        NOT NULL REFERENCES artefacts (id) ON DELETE RESTRICT,
    element_context             jsonb,
    acceptance_criteria         text,
    resolution_note             text,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT findings_severity_known CHECK (
        severity IN ('critical', 'high', 'medium', 'low', 'suggestion')
    ),
    CONSTRAINT findings_status_known CHECK (
        status IN ('OPEN', 'CLAIMED', 'IN_PROGRESS', 'BLOCKED', 'FIXED_UNVERIFIED',
                   'AWAITING_HUMAN_REVIEW', 'RESOLVED', 'REOPENED', 'WONT_FIX', 'DUPLICATE')
    ),
    CONSTRAINT findings_source_known CHECK (source IN ('human', 'agent')),
    CONSTRAINT findings_actor_type_known CHECK (
        created_by_actor_type IN ('human_user', 'agent_session', 'connector',
                                  'browser_worker', 'system', 'integration')
    ),
    CONSTRAINT findings_version_positive CHECK (version >= 1),
    CONSTRAINT findings_commit_shape CHECK (captured_commit ~ '^[0-9a-f]{7,64}$'),
    -- The captured context is not optional. A finding whose viewport or scroll
    -- position is absent cannot be reproduced at the state it was seen in, so
    -- the shape is checked here as well as at the API boundary.
    CONSTRAINT findings_viewport_shape CHECK (
        jsonb_typeof(viewport) = 'object'
        AND jsonb_typeof(viewport -> 'width') = 'number'
        AND jsonb_typeof(viewport -> 'height') = 'number'
        AND jsonb_typeof(viewport -> 'device_scale_factor') = 'number'
    ),
    CONSTRAINT findings_scroll_shape CHECK (
        jsonb_typeof(scroll_position) = 'object'
        AND jsonb_typeof(scroll_position -> 'x') = 'number'
        AND jsonb_typeof(scroll_position -> 'y') = 'number'
    )
);

CREATE INDEX findings_review_idx ON findings (review_id, created_at);
CREATE INDEX findings_project_status_idx ON findings (project_id, status);
CREATE INDEX findings_artefact_idx ON findings (screenshot_artefact_id);
