-- downgrade: not supported (forward-only; roll back by restoring the backup taken before the upgrade)
-- Browser-worker identity and project assignment
-- (docs/ARCHITECTURE.md section 11, docs/SECURITY.md section 6.4).
--
-- The credential is stored only as a SHA-256 digest: the control plane needs
-- to recognise a presented credential, never to reproduce one
-- (docs/SECURITY.md section 12).

CREATE TABLE browser_workers (
    id                  text        PRIMARY KEY,
    name                text        NOT NULL UNIQUE,
    credential_sha256   text        NOT NULL UNIQUE,
    worker_version      text        NOT NULL,
    browser_type        text        NOT NULL,
    browser_version     text        NOT NULL,
    capacity            integer     NOT NULL,
    labels              jsonb       NOT NULL DEFAULT '[]'::jsonb,
    sandbox_enabled     boolean     NOT NULL,
    status              text        NOT NULL DEFAULT 'active',
    registered_at       timestamptz NOT NULL DEFAULT now(),
    last_heartbeat_at   timestamptz,
    active_sessions     integer     NOT NULL DEFAULT 0,
    CONSTRAINT browser_workers_capacity_positive CHECK (capacity BETWEEN 1 AND 64),
    CONSTRAINT browser_workers_status_known CHECK (status IN ('active', 'degraded', 'lost', 'revoked'))
);

-- A worker may only receive sessions for a project it is assigned to. There is
-- no wildcard row: an unassigned worker serves nothing.
CREATE TABLE browser_worker_projects (
    worker_id   text        NOT NULL REFERENCES browser_workers (id) ON DELETE CASCADE,
    project_id  text        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    assigned_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (worker_id, project_id)
);
