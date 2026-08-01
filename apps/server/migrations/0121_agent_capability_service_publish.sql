-- Adds `service:publish` to the agent capability vocabulary.
--
-- The published-service tools of docs/MCP_SPEC.md section 7.2 publish and
-- revoke a route into a development machine, so they require a capability of
-- their own rather than riding on `project:read`: docs/SECURITY.md section 6.3
-- requires an agent credential to be capability scoped, and an existing
-- credential must not gain the ability to open a tunnel because a release
-- shipped.
--
-- The vocabulary lives in three places by necessity and in one place by choice.
-- `packages/protocol` declares it, `apps/server` reads it from there rather
-- than restating it, and this constraint is the third: PostgreSQL cannot import
-- a TypeScript constant, and dropping the check to avoid the duplication would
-- remove the only guard that survives a bug in the application layer. So the
-- duplication is deliberate, and it is a migration rather than a comment: a
-- capability added to the schema and not to this list produces a credential the
-- database refuses to store, loudly, at the moment it is issued.

ALTER TABLE agent_credentials
    DROP CONSTRAINT agent_credentials_capabilities_known;

ALTER TABLE agent_credentials
    ADD CONSTRAINT agent_credentials_capabilities_known CHECK (
        capabilities <@ ARRAY[
            'project:read', 'review:read', 'review:write', 'finding:read',
            'finding:write', 'verification:submit', 'browser:capture',
            'service:publish'
        ]::text[]
    );
