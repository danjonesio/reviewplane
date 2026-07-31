-- downgrade: not supported (forward-only; roll back by restoring the backup taken before the upgrade)
-- Workspace Git context reported by a connector (RVP-20).
--
-- docs/DOMAIN_MODEL.md section 9 lists a workspace's fields as `path_hash`,
-- `display_path`, `repository_identity`, `branch`, `head_commit`, `dirty` and
-- `last_observed_at`, and says the control plane "should avoid storing
-- unnecessary full filesystem paths when a display label and stable local hash
-- are sufficient". Stage 0 stored `root_path` because the only way a workspace
-- came into existence was an operator or an agent session naming one; a
-- connector reporting a checkout (docs/CONNECTOR_PROTOCOL.md section 9,
-- ADR-0022) reports the digest and the directory's own name instead, and this
-- migration is what lets both kinds of workspace live in one table.
--
-- `root_path` therefore becomes nullable rather than being dropped. An
-- administratively registered workspace still carries one, because
-- `workspace_hint` on an MCP session initialisation matches against it
-- (docs/MCP_SPEC.md section 4) and removing it would break that resolution. A
-- connector-reported workspace carries none: the path never leaves the
-- development machine.

ALTER TABLE workspaces
    ADD COLUMN environment_id      text REFERENCES environments (id) ON DELETE SET NULL,
    ADD COLUMN path_hash           text,
    ADD COLUMN display_path        text,
    ADD COLUMN repository_identity text,
    ADD COLUMN last_observed_at    timestamptz,
    -- How the workspace came to be known. Broad filesystem scanning is disabled
    -- by default and this build performs none, so there is no value for it: a
    -- vocabulary that named a discovery mode nothing can reach would describe a
    -- product that does not exist.
    ADD COLUMN source              text NOT NULL DEFAULT 'administrative_registration';

-- Backfill before the constraints, so an existing deployment migrates rather
-- than failing. The digest is over the stored absolute path, which is the same
-- value the connector hashes, so a checkout registered administratively and
-- later reported by a connector resolves to one row rather than two.
UPDATE workspaces
   SET path_hash    = 'sha256:' || encode(sha256(root_path::bytea), 'hex'),
       display_path = coalesce(nullif(regexp_replace(root_path, '^.*/', ''), ''), 'workspace')
 WHERE path_hash IS NULL;

ALTER TABLE workspaces
    ALTER COLUMN path_hash    SET NOT NULL,
    ALTER COLUMN display_path SET NOT NULL,
    ALTER COLUMN root_path    DROP NOT NULL;

-- The old check forbade an empty path; it must now also admit an absent one.
ALTER TABLE workspaces
    DROP CONSTRAINT workspaces_root_path_absolute;

ALTER TABLE workspaces
    ADD CONSTRAINT workspaces_root_path_present_or_absent
        CHECK (root_path IS NULL OR root_path <> ''),
    -- The shapes are the ones packages/protocol/schemas/platform/v1.schema.json
    -- declares. They are repeated here because the database is the last place a
    -- value can be refused, and a row that no encoder could ever emit should not
    -- be storable either.
    ADD CONSTRAINT workspaces_path_hash_shape
        CHECK (path_hash ~ '^sha256:[0-9a-f]{64}$'),
    -- A display label is the checkout directory's own name. Refusing path
    -- separators here is what stops a full filesystem path being smuggled into
    -- the field that exists precisely so that one is not stored.
    ADD CONSTRAINT workspaces_display_path_is_a_label
        CHECK (display_path <> '' AND display_path !~ '[/\\]' AND display_path !~ '[\x00-\x1f\x7f]'),
    ADD CONSTRAINT workspaces_source_known
        CHECK (source IN ('connector_report', 'administrative_registration')),
    -- One row per checkout per project. Superseded by migration 0081, which
    -- puts the environment in the key: this constraint made two development
    -- machines with the same checkout path share one row and overwrite each
    -- other. It is created here and dropped there rather than being rewritten
    -- in place, because a deployment that has already applied this file will
    -- never re-read it.
    ADD CONSTRAINT workspaces_path_hash_unique_per_project UNIQUE (project_id, path_hash);

-- The connector reference was an unconstrained text column. A connector record
-- can be deleted with its organisation, and a workspace pointing at an
-- identifier that no longer resolves is a row nothing can interpret.
UPDATE workspaces
   SET connector_id = NULL
 WHERE connector_id IS NOT NULL
   AND connector_id NOT IN (SELECT id FROM connectors);

ALTER TABLE workspaces
    ADD CONSTRAINT workspaces_connector_fk
        FOREIGN KEY (connector_id) REFERENCES connectors (id) ON DELETE SET NULL;

CREATE INDEX workspaces_environment_idx ON workspaces (environment_id);
