-- downgrade: not supported (forward-only; roll back by restoring the backup taken before the upgrade)
-- Agent credentials (docs/SECURITY.md section 6.3, docs/ARCHITECTURE.md
-- section 11).
--
-- Four properties of section 6.3 are columns here rather than conventions.
--
-- **Short-lived.** `expires_at` is NOT NULL and constrained to be after
-- creation. There is no "never expires" representation, so a long-lived agent
-- token cannot be produced by omitting a field.
--
-- **Bound to organisation and project.** `organisation_id` is a column and
-- `project_ids` is a non-empty array. A credential bound to more than one
-- project is legal and is exactly the case that makes project resolution
-- ambiguous: the MCP server then refuses with PROJECT_CONTEXT_AMBIGUOUS and
-- returns the candidates rather than picking one.
--
-- **Capability scoped.** `capabilities` is a non-empty array checked against
-- the vocabulary of packages/protocol/schemas/mcp/v1.schema.json. An agent
-- session cannot grant itself a capability beyond this set
-- (docs/DOMAIN_MODEL.md section 11).
--
-- **Distinct from human sessions.** This is a different table from
-- `viewer_sessions`, with a different token prefix and a different resolver. A
-- viewer cookie is not resolvable here and an agent token is not resolvable
-- there, so neither can be presented as the other.
--
-- Only the digest of the token is stored, as for viewer sessions: a copy of
-- this table is not a set of usable credentials.

CREATE TABLE agent_credentials (
    id                text        PRIMARY KEY,
    token_sha256      text        NOT NULL UNIQUE,
    organisation_id   text        NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
    project_ids       text[]      NOT NULL,
    capabilities      text[]      NOT NULL,
    label             text        NOT NULL,
    -- The connector or trusted client the credential was issued to
    -- (docs/SECURITY.md section 6.3). Stage 0 has no connector, so it is
    -- recorded when an issuer supplies it and is otherwise absent.
    issued_to_client  text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    expires_at        timestamptz NOT NULL,
    last_used_at      timestamptz,
    revoked_at        timestamptz,
    CONSTRAINT agent_credentials_scope_non_empty CHECK (array_length(project_ids, 1) > 0),
    CONSTRAINT agent_credentials_capabilities_non_empty CHECK (array_length(capabilities, 1) > 0),
    CONSTRAINT agent_credentials_capabilities_known CHECK (
        capabilities <@ ARRAY[
            'project:read', 'review:read', 'review:write', 'finding:read',
            'finding:write', 'verification:submit', 'browser:capture'
        ]::text[]
    ),
    CONSTRAINT agent_credentials_expiry_after_creation CHECK (expires_at > created_at),
    -- Short-lived is a bound and not an intention: a day is the outside edge of
    -- a coding session, and anything longer is a standing key by another name.
    CONSTRAINT agent_credentials_short_lived CHECK (expires_at <= created_at + interval '24 hours')
);

CREATE INDEX agent_credentials_expiry_idx ON agent_credentials (expires_at)
    WHERE revoked_at IS NULL;
CREATE INDEX agent_credentials_organisation_idx ON agent_credentials (organisation_id);
