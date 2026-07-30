-- Workspaces (docs/DOMAIN_MODEL.md section 9).
--
-- A workspace is the checkout an agent is working in. Stage 1's connector
-- reports it; Stage 0 registers it administratively, because the MCP session
-- initialisation of docs/MCP_SPEC.md section 4 has to answer with a branch and
-- a head commit, and a value the control plane invented would be worse than an
-- absent one.
--
-- The branch and head commit are here rather than derived because they are what
-- `finding_submit_verification` checks a claimed fix against: an agent that
-- says it fixed something on a branch the workspace is not on has told the
-- control plane something it can notice.
--
-- `root_path` is what a `workspace_hint` matches on. It is a path on somebody
-- else's machine and never on this one: nothing here opens it.

CREATE TABLE workspaces (
    id               text        PRIMARY KEY,
    organisation_id  text        NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
    project_id       text        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    connector_id     text,
    root_path        text        NOT NULL,
    branch           text        NOT NULL,
    head_commit      text        NOT NULL,
    dirty            boolean     NOT NULL DEFAULT false,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    last_seen_at     timestamptz,
    CONSTRAINT workspaces_commit_shape CHECK (head_commit ~ '^[0-9a-f]{7,64}$'),
    CONSTRAINT workspaces_root_path_absolute CHECK (root_path <> ''),
    CONSTRAINT workspaces_root_unique_per_project UNIQUE (project_id, root_path)
);

CREATE INDEX workspaces_project_idx ON workspaces (project_id);
