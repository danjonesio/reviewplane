-- downgrade: not supported (forward-only; roll back by restoring the backup taken before the upgrade)
-- Defence-in-depth scope on the idempotency table (docs/DOMAIN_MODEL.md
-- section 3).
--
-- "All project-owned records include organisation_id and project_id for
-- defence-in-depth filtering." The idempotency table was introduced in Stage 0
-- carrying only project_id, which was sufficient while the deployment had one
-- organisation and is exactly the kind of omission that stops being sufficient
-- quietly. The column is backfilled from the project the row already names, so
-- the two can never disagree.
--
-- The primary key is unchanged: the scope docs/MCP_SPEC.md section 10 defines is
-- actor, tool and project, and widening the key to include the organisation
-- would change replay semantics rather than harden them. The column is a filter,
-- not part of the identity.

ALTER TABLE idempotency_keys
    ADD COLUMN organisation_id text REFERENCES organisations (id) ON DELETE CASCADE;

UPDATE idempotency_keys
   SET organisation_id = projects.organisation_id
  FROM projects
 WHERE projects.id = idempotency_keys.project_id
   AND idempotency_keys.organisation_id IS NULL;

-- Any row that could not be attributed has no project to belong to and cannot be
-- replayed safely; there is nothing to preserve in one.
DELETE FROM idempotency_keys WHERE organisation_id IS NULL;

ALTER TABLE idempotency_keys ALTER COLUMN organisation_id SET NOT NULL;

CREATE INDEX idempotency_keys_organisation_index ON idempotency_keys (organisation_id);
