-- Artefact metadata (docs/DOMAIN_MODEL.md section 20, docs/API.md section 15,
-- ADR-0012).
--
-- PostgreSQL is authoritative for availability: an artefact is available only
-- after the server has verified the stored bytes against the declared size and
-- digest. `state` is therefore part of the record rather than something
-- inferred from the presence of a file.

CREATE TABLE artefacts (
    id                      text        PRIMARY KEY,
    organisation_id         text        NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
    project_id              text        NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
    kind                    text        NOT NULL,
    state                   text        NOT NULL DEFAULT 'pending',
    storage_key             text,
    content_type            text        NOT NULL,
    declared_size_bytes     bigint      NOT NULL,
    declared_sha256         text        NOT NULL,
    size_bytes              bigint,
    sha256                  text,
    redaction_state         text        NOT NULL DEFAULT 'not_applied',
    retention_class         text        NOT NULL,
    browser_session_id      text        REFERENCES browser_sessions (id) ON DELETE SET NULL,
    created_by_actor_type   text        NOT NULL,
    created_by_actor_id     text,
    created_at              timestamptz NOT NULL DEFAULT now(),
    available_at            timestamptz,
    expires_at              timestamptz,
    CONSTRAINT artefacts_state_known CHECK (state IN ('pending', 'uploaded', 'available', 'failed')),
    CONSTRAINT artefacts_kind_known CHECK (
        kind IN ('screenshot', 'thumbnail', 'trace', 'har', 'video',
                 'dom_snapshot', 'accessibility_snapshot', 'console_log',
                 'network_log', 'review_export')
    ),
    CONSTRAINT artefacts_declared_digest_shape CHECK (declared_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT artefacts_verified_digest_shape CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
    -- An available artefact has been verified: it has a key, a size and a
    -- digest, and they are the ones that were declared.
    CONSTRAINT artefacts_available_is_verified CHECK (
        state <> 'available'
        OR (storage_key IS NOT NULL
            AND sha256 IS NOT NULL
            AND size_bytes IS NOT NULL
            AND sha256 = declared_sha256
            AND size_bytes = declared_size_bytes
            AND available_at IS NOT NULL)
    )
);

CREATE INDEX artefacts_project_idx ON artefacts (project_id, created_at DESC);
CREATE INDEX artefacts_session_idx ON artefacts (browser_session_id);
