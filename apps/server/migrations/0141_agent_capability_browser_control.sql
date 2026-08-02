-- downgrade: not supported (forward-only; roll back by restoring the backup taken before the upgrade)
-- Adds `browser:control` to the agent capability vocabulary.
--
-- The browser lifecycle and interaction tools of docs/MCP_SPEC.md sections 7.3
-- and 7.4 start, pause, resume and end a central Chromium session and operate
-- the page inside it. That is a different authority from `browser:capture`,
-- which reads what is on screen and cannot change it, so it is a capability of
-- its own: docs/SECURITY.md section 6.3 requires an agent credential to be
-- capability scoped, and a credential issued to read evidence must not gain the
-- ability to drive a browser because a release shipped.
--
-- Migration 0121 records why this list is duplicated in SQL and why that is
-- deliberate: PostgreSQL cannot import a TypeScript constant, and dropping the
-- check to avoid the duplication would remove the only guard that survives a
-- bug in the application layer. A capability added to `packages/protocol` and
-- not here produces a credential the database refuses to store, loudly, at the
-- moment it is issued — which is how this migration came to be written.

ALTER TABLE agent_credentials
    DROP CONSTRAINT agent_credentials_capabilities_known;

ALTER TABLE agent_credentials
    ADD CONSTRAINT agent_credentials_capabilities_known CHECK (
        capabilities <@ ARRAY[
            'project:read', 'review:read', 'review:write', 'finding:read',
            'finding:write', 'verification:submit', 'browser:capture',
            'service:publish', 'browser:control'
        ]::text[]
    );
