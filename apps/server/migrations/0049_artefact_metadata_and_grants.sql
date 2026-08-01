-- downgrade: not supported (forward-only; roll back by restoring the backup taken before the upgrade)
-- Artefact metadata the review domain needs, and the short-lived grants that
-- are the only way to read artefact bytes back (docs/DOMAIN_MODEL.md
-- section 20, docs/SECURITY.md section 13, ADR-0012, ADR-0019).
--
-- The content rectangle is the reason the first half exists. Annotation
-- geometry is normalised against the intrinsic pixel extent of the stored
-- image (docs/DOMAIN_MODEL.md section 16), so that extent has to be a recorded
-- property of the artefact rather than something a renderer infers from bytes
-- it may not have finished downloading. It is measured by the server from the
-- stored bytes during verification, never taken from the uploader.
--
-- `filename_label` is display metadata and nothing else. It never reaches the
-- storage key, which is content-addressed (ADR-0012), so traversal through it
-- is structurally impossible; the constraint refuses the attempt anyway,
-- because a stored `../../etc/passwd` would still be a value some future
-- exporter might join to a path.

ALTER TABLE artefacts
    ADD COLUMN content_width_px  integer,
    ADD COLUMN content_height_px integer,
    ADD COLUMN filename_label    text;

ALTER TABLE artefacts
    ADD CONSTRAINT artefacts_content_rectangle_positive CHECK (
        (content_width_px IS NULL AND content_height_px IS NULL)
        OR (content_width_px > 0 AND content_height_px > 0
            AND content_width_px <= 32767 AND content_height_px <= 32767)
    ),
    ADD CONSTRAINT artefacts_redaction_state_known CHECK (
        redaction_state IN ('not_applied', 'pending', 'applied', 'failed')
    ),
    ADD CONSTRAINT artefacts_retention_class_known CHECK (
        retention_class IN ('action_screenshots', 'browser_traces', 'session_video',
                            'console_and_network_logs', 'verification_evidence')
    ),
    ADD CONSTRAINT artefacts_filename_label_is_a_name CHECK (
        filename_label IS NULL
        OR (filename_label ~ '^[A-Za-z0-9._-]{1,128}$' AND filename_label !~ '[.][.]')
    ),
    -- An available image artefact has been measured. The content rectangle is
    -- part of what verification produces, not an optional decoration.
    ADD CONSTRAINT artefacts_available_image_is_measured CHECK (
        state <> 'available'
        OR content_type NOT IN ('image/png', 'image/jpeg')
        OR (content_width_px IS NOT NULL AND content_height_px IS NOT NULL)
    );

-- Reading evidence back.
--
-- There is no path that serves artefact bytes from an artefact identifier. A
-- caller mints a grant for one artefact, and the grant is bound to the subject
-- that minted it: the identifier travels in the URL, which is what an <img>
-- can carry, while the credential stays in the cookie or the Authorization
-- header, which is what docs/SECURITY.md section 18 requires. Neither half is
-- sufficient alone.
CREATE TABLE artefact_access_grants (
    id               text        PRIMARY KEY,
    artefact_id      text        NOT NULL REFERENCES artefacts (id) ON DELETE CASCADE,
    organisation_id  text        NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
    project_id       text        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    subject_type     text        NOT NULL,
    subject_id       text        NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz NOT NULL,
    revoked_at       timestamptz,
    last_used_at     timestamptz,
    use_count        integer     NOT NULL DEFAULT 0,
    CONSTRAINT artefact_grants_subject_type_known CHECK (
        subject_type IN ('human_user', 'agent_session', 'browser_worker', 'system')
    ),
    CONSTRAINT artefact_grants_expiry_after_creation CHECK (expires_at > created_at),
    CONSTRAINT artefact_grants_use_count_non_negative CHECK (use_count >= 0)
);

CREATE INDEX artefact_grants_artefact_idx ON artefact_access_grants (artefact_id);
CREATE INDEX artefact_grants_expiry_idx ON artefact_access_grants (expires_at)
    WHERE revoked_at IS NULL;
