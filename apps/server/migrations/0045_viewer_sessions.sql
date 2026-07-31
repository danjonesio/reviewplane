-- downgrade: not supported (forward-only; roll back by restoring the backup taken before the upgrade)
-- Human viewer sessions (docs/API.md section 4, docs/SECURITY.md section 6.1,
-- ADR-0016).
--
-- A browser cannot set an Authorization header on a WebSocket handshake, and
-- docs/SECURITY.md section 18 forbids a credential in a URL, so the live
-- channel authenticates from a cookie. The cookie carries an opaque token; the
-- database stores only its digest, so a copy of this table is not a set of
-- usable credentials.
--
-- `project_ids` is the authorisation scope. NULL means every project in the
-- organisation, which is what the bootstrap administrator gets. A
-- project-scoped session is the mechanism a real membership will use, and it
-- is what the cross-project refusal test exercises today.

CREATE TABLE viewer_sessions (
    id               text        PRIMARY KEY,
    token_sha256     text        NOT NULL UNIQUE,
    organisation_id  text        REFERENCES organisations (id) ON DELETE CASCADE,
    project_ids      text[],
    display          text        NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz NOT NULL,
    last_seen_at     timestamptz,
    revoked_at       timestamptz,
    CONSTRAINT viewer_sessions_scope_non_empty CHECK (
        project_ids IS NULL OR array_length(project_ids, 1) > 0
    ),
    CONSTRAINT viewer_sessions_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX viewer_sessions_expiry_idx ON viewer_sessions (expires_at)
    WHERE revoked_at IS NULL;
