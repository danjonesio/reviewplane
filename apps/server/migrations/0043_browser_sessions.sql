-- downgrade: not supported (forward-only; roll back by restoring the backup taken before the upgrade)
-- Browser sessions and control leases
-- (docs/DOMAIN_MODEL.md sections 12 and 13, ADR-0007).

CREATE TABLE browser_sessions (
    id                      text        PRIMARY KEY,
    organisation_id         text        NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
    project_id              text        NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
    worker_id               text        REFERENCES browser_workers (id) ON DELETE SET NULL,
    agent_session_id        text,
    published_service_id    text,
    service_origin          text,
    browser_type            text        NOT NULL DEFAULT 'chromium',
    browser_version         text,
    status                  text        NOT NULL,
    current_controller_type text,
    current_controller_id   text,
    control_epoch           integer     NOT NULL DEFAULT 0,
    last_sequence           bigint      NOT NULL DEFAULT -1,
    viewport                jsonb       NOT NULL,
    limits                  jsonb       NOT NULL,
    retention_policy        text        NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    ended_at                timestamptz,
    CONSTRAINT browser_sessions_status_known CHECK (
        status IN ('REQUESTED', 'ALLOCATING', 'READY', 'ACTIVE', 'PAUSED',
                   'DEGRADED', 'TERMINATING', 'TERMINATED', 'FAILED')
    ),
    CONSTRAINT browser_sessions_controller_known CHECK (
        current_controller_type IS NULL OR current_controller_type IN ('agent', 'human', 'system')
    ),
    CONSTRAINT browser_sessions_epoch_non_negative CHECK (control_epoch >= 0)
);

CREATE INDEX browser_sessions_project_idx ON browser_sessions (project_id, created_at DESC);
CREATE INDEX browser_sessions_worker_idx ON browser_sessions (worker_id) WHERE ended_at IS NULL;

-- Only one non-revoked interactive lease may exist for the current epoch
-- (docs/DOMAIN_MODEL.md section 13). The partial unique index is the
-- enforcement, not a convention.
CREATE TABLE control_leases (
    id                  text        PRIMARY KEY,
    browser_session_id  text        NOT NULL REFERENCES browser_sessions (id) ON DELETE CASCADE,
    controller_type     text        NOT NULL,
    controller_id       text        NOT NULL,
    epoch               integer     NOT NULL,
    issued_at           timestamptz NOT NULL DEFAULT now(),
    expires_at          timestamptz NOT NULL,
    revoked_at          timestamptz,
    reason              text,
    CONSTRAINT control_leases_controller_known CHECK (controller_type IN ('agent', 'human', 'system')),
    CONSTRAINT control_leases_epoch_non_negative CHECK (epoch >= 0)
);

CREATE UNIQUE INDEX control_leases_one_active_interactive
    ON control_leases (browser_session_id)
    WHERE revoked_at IS NULL AND controller_type <> 'system';

CREATE UNIQUE INDEX control_leases_epoch_unique
    ON control_leases (browser_session_id, epoch);
