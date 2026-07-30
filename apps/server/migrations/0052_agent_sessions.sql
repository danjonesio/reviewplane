-- Agent sessions (docs/DOMAIN_MODEL.md section 11).
--
-- A bounded agent execution context. One MCP connection is one row, and every
-- write an agent makes is attributed to it, which is what makes "an agent did
-- this" a fact in the event stream rather than an inference from a token.
--
-- `project_id` is NOT NULL. There is no representation of an agent session
-- without a project, so the ambiguous case of docs/MCP_SPEC.md section 4 cannot
-- produce a half-resolved session that later tools have to defend against: the
-- session is refused before it exists.
--
-- `capabilities` is copied from the credential at session start rather than
-- read through it on every call. The credential is the grant; the session is
-- what was granted at the moment it opened, so revoking a credential cannot
-- retroactively change what an audit record says the session was allowed to do.

CREATE TABLE agent_sessions (
    id                   text        PRIMARY KEY,
    organisation_id      text        NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
    project_id           text        NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
    credential_id        text        NOT NULL REFERENCES agent_credentials (id) ON DELETE RESTRICT,
    workspace_id         text        REFERENCES workspaces (id) ON DELETE SET NULL,
    agent_type           text        NOT NULL,
    agent_version        text        NOT NULL,
    capabilities         text[]      NOT NULL,
    client_capabilities  jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- The MCP transport session identifier. It is how a second HTTP request on
    -- the same connection finds this row, and it is checked against the
    -- credential on every request so one agent cannot resume another's session.
    transport_session_id text        UNIQUE,
    branch               text,
    head_commit          text,
    status               text        NOT NULL DEFAULT 'STARTING',
    started_at           timestamptz NOT NULL DEFAULT now(),
    last_seen_at         timestamptz,
    ended_at             timestamptz,
    CONSTRAINT agent_sessions_status_known CHECK (
        status IN ('STARTING', 'ACTIVE', 'WAITING', 'BLOCKED', 'DISCONNECTED',
                   'COMPLETED', 'FAILED', 'CANCELLED')
    ),
    CONSTRAINT agent_sessions_capabilities_non_empty CHECK (array_length(capabilities, 1) > 0),
    CONSTRAINT agent_sessions_commit_shape CHECK (
        head_commit IS NULL OR head_commit ~ '^[0-9a-f]{7,64}$'
    )
);

CREATE INDEX agent_sessions_project_idx ON agent_sessions (project_id, started_at DESC);
CREATE INDEX agent_sessions_credential_idx ON agent_sessions (credential_id);

-- Browser sessions already carry `agent_session_id`; make it a real reference
-- now that the table it names exists. ON DELETE SET NULL because the browser
-- session is evidence of what happened and must outlive the agent that asked
-- for it.
ALTER TABLE browser_sessions
    ADD CONSTRAINT browser_sessions_agent_session_fk
    FOREIGN KEY (agent_session_id) REFERENCES agent_sessions (id) ON DELETE SET NULL;
