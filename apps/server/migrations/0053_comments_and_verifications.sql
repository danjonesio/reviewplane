-- Comments and verifications (docs/DOMAIN_MODEL.md sections 18 and 19).
--
-- A verification is "a submitted claim with evidence that a finding is
-- resolved". Two constraints hold that sentence to its meaning.
--
-- `status` starts at `submitted` and the transitions to `accepted` and
-- `rejected` are human decisions. Nothing in the MCP layer can write them,
-- because the tool argument enumeration has no way to name them; the check
-- constraint here is what stops any other writer inventing one.
--
-- `verification_artefacts` is a separate table rather than an array column
-- because each link has a role — before or after — and because the foreign key
-- to `artefacts` is what makes "evidence from another project" impossible to
-- store rather than merely refused at the boundary. Deletion is restricted for
-- the same reason `findings.screenshot_artefact_id` restricts it: a claim
-- whose evidence has been removed is an opinion.

CREATE TABLE comments (
    id                        text        PRIMARY KEY,
    organisation_id           text        NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
    project_id                text        NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
    review_id                 text        NOT NULL REFERENCES reviews (id) ON DELETE CASCADE,
    finding_id                text        REFERENCES findings (id) ON DELETE CASCADE,
    body                      text        NOT NULL,
    revision                  integer     NOT NULL DEFAULT 1,
    created_by_actor_type     text        NOT NULL,
    created_by_actor_id       text,
    created_by_actor_display  text,
    created_at                timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT comments_actor_type_known CHECK (
        created_by_actor_type IN ('human_user', 'agent_session', 'connector',
                                  'browser_worker', 'system', 'integration')
    ),
    CONSTRAINT comments_body_non_empty CHECK (length(btrim(body)) > 0),
    CONSTRAINT comments_revision_positive CHECK (revision >= 1)
);

CREATE INDEX comments_finding_idx ON comments (finding_id, created_at);
CREATE INDEX comments_review_idx ON comments (review_id, created_at);

CREATE TABLE verifications (
    id                          text        PRIMARY KEY,
    organisation_id             text        NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
    project_id                  text        NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
    review_id                   text        NOT NULL REFERENCES reviews (id) ON DELETE CASCADE,
    finding_id                  text        NOT NULL REFERENCES findings (id) ON DELETE CASCADE,
    status                      text        NOT NULL DEFAULT 'submitted',
    summary                     text        NOT NULL,
    branch                      text        NOT NULL,
    commit_sha                  text        NOT NULL,
    tested_viewports            jsonb       NOT NULL,
    checks                      jsonb       NOT NULL,
    submitted_by_actor_type     text        NOT NULL,
    submitted_by_actor_id       text,
    submitted_by_actor_display  text,
    submitted_at                timestamptz NOT NULL DEFAULT now(),
    reviewed_at                 timestamptz,
    reviewed_by_actor_type      text,
    reviewed_by_actor_id        text,
    CONSTRAINT verifications_status_known CHECK (
        status IN ('submitted', 'accepted', 'rejected', 'superseded')
    ),
    CONSTRAINT verifications_actor_type_known CHECK (
        submitted_by_actor_type IN ('human_user', 'agent_session', 'connector',
                                    'browser_worker', 'system', 'integration')
    ),
    CONSTRAINT verifications_commit_shape CHECK (commit_sha ~ '^[0-9a-f]{7,64}$'),
    -- Only a human decides. An agent-submitted verification that had somehow
    -- been marked accepted would have to name a human reviewer, and the MCP
    -- layer has no way to supply one.
    CONSTRAINT verifications_decision_has_a_reviewer CHECK (
        status IN ('submitted', 'superseded')
        OR (reviewed_at IS NOT NULL AND reviewed_by_actor_type = 'human_user')
    ),
    CONSTRAINT verifications_viewports_are_a_list CHECK (
        jsonb_typeof(tested_viewports) = 'array' AND jsonb_array_length(tested_viewports) >= 1
    ),
    CONSTRAINT verifications_checks_are_an_object CHECK (jsonb_typeof(checks) = 'object')
);

CREATE INDEX verifications_finding_idx ON verifications (finding_id, submitted_at DESC);
CREATE INDEX verifications_project_status_idx ON verifications (project_id, status);

CREATE TABLE verification_artefacts (
    verification_id  text        NOT NULL REFERENCES verifications (id) ON DELETE CASCADE,
    artefact_id      text        NOT NULL REFERENCES artefacts (id) ON DELETE RESTRICT,
    role             text        NOT NULL,
    position         integer     NOT NULL,
    PRIMARY KEY (verification_id, artefact_id),
    CONSTRAINT verification_artefacts_role_known CHECK (role IN ('before', 'after', 'supporting')),
    CONSTRAINT verification_artefacts_position_non_negative CHECK (position >= 0)
);

CREATE INDEX verification_artefacts_artefact_idx ON verification_artefacts (artefact_id);
