-- downgrade: not supported (forward-only; roll back by restoring the backup taken before the upgrade)
-- Human sessions: the ADR-0016 viewer session grows a user, a CSRF token and a
-- rotation lineage (docs/SECURITY.md section 6.1, docs/API.md section 4).
--
-- ADR-0016 said the viewer-session record and its project scope are the part
-- that survives local accounts, and this is that migration: the same table, the
-- same cookie and the same scope, with the account bound to it. Nothing else in
-- the server has to learn a second session kind, which is why the live channel,
-- the artefact grants and every project-scoped read authorise a password
-- session today without being changed.
--
-- `csrf_token_sha256` is the second half of the CSRF defence docs/API.md
-- section 4 requires. The raw value travels in a readable cookie so the
-- application can echo it in a header, and only its digest is stored: a
-- database dump is not a set of usable CSRF tokens either. A session with no
-- digest (the ADR-0016 bootstrap exchange, a Stage 0 row) cannot satisfy the
-- check, so a state-changing browser request is refused rather than admitted by
-- a NULL comparison.
--
-- `rotated_from_session_id` records that a session replaced another, which is
-- what "session rotation on privilege change" leaves behind: the old row is
-- revoked with reason `rotated` and the new one names it, so an auditor reading
-- the pair sees a rotation rather than a revocation followed by an unrelated
-- login.

ALTER TABLE viewer_sessions
    ADD COLUMN user_id                 text REFERENCES users (id) ON DELETE RESTRICT,
    ADD COLUMN csrf_token_sha256       text,
    ADD COLUMN rotated_from_session_id text REFERENCES viewer_sessions (id) ON DELETE SET NULL,
    -- Why the session ended, mirroring session_revocation_reason in
    -- schemas/platform/v1.schema.json. NULL while the session is live.
    ADD COLUMN revocation_reason       text,

    ADD CONSTRAINT viewer_sessions_revocation_reason_known CHECK (
        revocation_reason IS NULL
        OR revocation_reason IN ('sign_out', 'rotated', 'revoked_by_user', 'revoked_by_administrator')
    ),
    -- A reason without a revocation, or a revocation of a session that is
    -- somehow still live, would make the audit trail disagree with the table.
    ADD CONSTRAINT viewer_sessions_revocation_consistent CHECK (
        revocation_reason IS NULL OR revoked_at IS NOT NULL
    );

CREATE INDEX viewer_sessions_user_index ON viewer_sessions (user_id)
    WHERE revoked_at IS NULL;
