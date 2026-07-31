-- Stage 1 artefact store: the remaining docs/DOMAIN_MODEL.md section 20 fields,
-- derived artefacts, and deletion (RVP-33, ADR-0012, ADR-0006).
--
-- Four additions, each with a reason it is a column rather than something a
-- reader infers.
--
-- `encryption_key_reference` is the docs/SECURITY.md section 15 requirement
-- that key identifiers are stored separately from ciphertext. Stage 1 encrypts
-- nothing and writes nothing into it. That is the point of having it: a null
-- value states that the bytes are not application-encrypted, so an operator
-- relying on volume encryption can see which of the two protections an artefact
-- actually has instead of assuming.
--
-- `source_artefact_id` and `thumbnail_state` carry derivation. A thumbnail is a
-- separate artefact with its own digest and its own verification, because
-- ADR-0006 forbids rewriting an original to carry something derived from it.
-- The state is recorded rather than inferred from the absence of a thumbnail
-- row, because that absence is ambiguous between "not yet", "not possible" and
-- "failed", and docs/UX_FLOWS.md section 18 forbids a viewer that cannot say
-- which.
--
-- `deleted_at` retains the metadata row. The identifier appears in events, in
-- exports and in MCP responses, and an audit trail whose identifiers stop
-- resolving is a worse outcome than a row that says the bytes are gone. Every
-- read path treats a deleted artefact as absent.
--
-- `expires_at` already exists and is now written from the retention class at
-- intent. Stage 1 runs no deletion: the column says when retention becomes
-- due, not that anything happened.

ALTER TABLE artefacts
    ADD COLUMN encryption_key_reference text,
    ADD COLUMN source_artefact_id       text REFERENCES artefacts (id) ON DELETE SET NULL,
    ADD COLUMN thumbnail_state          text NOT NULL DEFAULT 'not_requested',
    ADD COLUMN thumbnail_artefact_id    text REFERENCES artefacts (id) ON DELETE SET NULL,
    ADD COLUMN deleted_at               timestamptz,
    ADD COLUMN deleted_reason           text;

ALTER TABLE artefacts
    ADD CONSTRAINT artefacts_thumbnail_state_known CHECK (
        thumbnail_state IN ('not_requested', 'pending', 'generated', 'unsupported', 'failed')
    ),
    -- A generated thumbnail names the artefact it produced. Recording the state
    -- without the artefact would leave a viewer told that a thumbnail exists
    -- and unable to reach it.
    ADD CONSTRAINT artefacts_generated_thumbnail_is_named CHECK (
        thumbnail_state <> 'generated' OR thumbnail_artefact_id IS NOT NULL
    ),
    -- The reference is a key identifier and never key material
    -- (docs/SECURITY.md section 15). The bound is what a reference needs; a
    -- value long enough to be a key does not belong in this column.
    ADD CONSTRAINT artefacts_encryption_key_reference_shape CHECK (
        encryption_key_reference IS NULL
        OR encryption_key_reference ~ '^[A-Za-z0-9:._/-]{1,256}$'
    ),
    -- An artefact is not its own source, and a deleted artefact keeps the
    -- verified metadata that says what was removed.
    ADD CONSTRAINT artefacts_source_is_another_artefact CHECK (source_artefact_id <> id),
    ADD CONSTRAINT artefacts_thumbnail_is_another_artefact CHECK (thumbnail_artefact_id <> id);

CREATE INDEX artefacts_source_idx ON artefacts (source_artefact_id)
    WHERE source_artefact_id IS NOT NULL;

-- Deleting one artefact must not remove bytes another still references. Keys
-- are content-addressed (ADR-0012), so two artefacts holding identical bytes
-- are one stored object; the delete path asks this index whether any live
-- artefact still points at the key before it removes anything.
CREATE INDEX artefacts_live_storage_key_idx ON artefacts (storage_key)
    WHERE storage_key IS NOT NULL AND deleted_at IS NULL;

-- Reading an artefact for one project is the common query and it is always
-- scoped: identifier, project and organisation appear together in the
-- predicate so that a row belonging to another tenant is not returned and then
-- rejected (docs/SECURITY.md section 7).
CREATE INDEX artefacts_scope_idx ON artefacts (organisation_id, project_id, id);
