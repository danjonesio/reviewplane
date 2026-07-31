-- downgrade: not supported (forward-only; roll back by restoring the backup taken before the upgrade)
-- A workspace record is owned by the environment that reported it (RVP-20).
--
-- Migration 0080 made `(project_id, path_hash)` unique, which was wrong in both
-- directions once more than one development machine serves a project:
--
--   * Two environments with the same checkout path in one project — and
--     `/home/dev/app` is not exotic — collided into one row and then fought over
--     it every observation interval, each rewriting the other's branch and head
--     commit. They are different checkouts on different machines and are two
--     records.
--   * The uniqueness said nothing about ownership, so the row-locating query in
--     `modules/connectors/workspaces.ts` could reach a row belonging to another
--     environment and update it in place. ADR-0022 point 8 claims an identifier
--     already held elsewhere is refused; it was only refused on the INSERT path,
--     which a matching row never reaches.
--
-- The identity of a connector-reported workspace is therefore
-- `(project_id, environment_id, path_hash)`, and the identity of an
-- administratively registered one — which belongs to no environment — stays
-- `(project_id, path_hash)`. Two partial unique indexes rather than one
-- expression, because a NULL `environment_id` is not distinct from another NULL
-- to a person reading the schema and it is to PostgreSQL.

ALTER TABLE workspaces
    DROP CONSTRAINT workspaces_path_hash_unique_per_project;

-- One record per checkout per environment, for a workspace a connector reports.
CREATE UNIQUE INDEX workspaces_reported_path_unique
    ON workspaces (project_id, environment_id, path_hash)
 WHERE environment_id IS NOT NULL;

-- One record per checkout, for a workspace an operator or agent session named.
-- It has no environment, because nothing observed it.
CREATE UNIQUE INDEX workspaces_registered_path_unique
    ON workspaces (project_id, path_hash)
 WHERE environment_id IS NULL;
