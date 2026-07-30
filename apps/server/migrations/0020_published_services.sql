-- Published services: the temporary route from an authorised browser worker to
-- a local development service (docs/DOMAIN_MODEL.md section 10).
--
-- The columns are that section's field list. project_id and organisation_id are
-- carried on the row rather than reached through a join, because
-- docs/DOMAIN_MODEL.md section 3 requires every project-owned record to carry
-- both for defence-in-depth filtering: a query that forgets the project scope
-- should return nothing rather than another project's route.
--
-- There is deliberately no foreign key to projects, connectors or workspaces
-- yet. Those tables arrive with the issues that own them, and a forward
-- reference here would make the order in which two independent migrations land
-- significant. The columns are typed and indexed as if the keys existed, so
-- adding them later is a constraint, not a rewrite.

CREATE TABLE IF NOT EXISTS published_services (
    id                          text        PRIMARY KEY,
    organisation_id             text        NOT NULL,
    project_id                  text        NOT NULL,
    connector_id                text        NOT NULL,
    workspace_id                text        NOT NULL,

    -- The leftmost label of the internal origin. It is a DNS label, so it
    -- cannot be the identifier when that carries an underscore, and it is
    -- unique across the deployment because the origin-to-route mapping has to
    -- be injective.
    public_alias                text        NOT NULL,

    local_host                  text        NOT NULL,
    local_port                  integer     NOT NULL
                                    CHECK (local_port BETWEEN 1 AND 65535),
    protocol                    text        NOT NULL
                                    CHECK (protocol IN ('http', 'https')),

    -- Stage 0 publishes to named browser sessions only.
    scope                       text        NOT NULL DEFAULT 'browser_session'
                                    CHECK (scope IN ('browser_session')),
    allowed_browser_session_ids text[]      NOT NULL
                                    CHECK (cardinality(allowed_browser_session_ids) BETWEEN 1 AND 32),

    -- Publication always expires (docs/DOMAIN_MODEL.md section 10 invariants).
    expires_at                  timestamptz NOT NULL,

    status                      text        NOT NULL
                                    CHECK (status IN ('requested', 'ready', 'failed', 'expired', 'revoked')),
    -- The stable error class from docs/CONNECTOR_PROTOCOL.md section 21 when a
    -- publication failed. No free text: docs/SECURITY.md section 18.
    failure_class               text,
    -- The destination the connector reported it actually opened.
    observed_destination        text,

    requested_at                timestamptz NOT NULL DEFAULT now(),
    ready_at                    timestamptz,
    ended_at                    timestamptz,

    CONSTRAINT published_services_alias_unique UNIQUE (public_alias),
    CONSTRAINT published_services_failure_class_only_when_failed
        CHECK ((status = 'failed') OR (failure_class IS NULL))
);

CREATE INDEX IF NOT EXISTS published_services_project_idx
    ON published_services (project_id, status);

CREATE INDEX IF NOT EXISTS published_services_connector_idx
    ON published_services (connector_id)
    WHERE status = 'ready';

-- Supports the expiry sweep without scanning routes that have already ended.
CREATE INDEX IF NOT EXISTS published_services_expiry_idx
    ON published_services (expires_at)
    WHERE status = 'ready';
