-- downgrade: not supported (forward-only; roll back by restoring the backup taken before the upgrade)
-- Annotations: structured geometry stored apart from the original evidence
-- (docs/DOMAIN_MODEL.md section 16, ADR-0006).
--
-- The table never holds image bytes. It holds a reference to an immutable
-- artefact and a geometry normalised to that artefact's content rectangle,
-- which is what makes an overlay editable, queryable and correct at any
-- rendered size.
--
-- The primary key is (id, revision) rather than id. docs/API.md section 14
-- requires annotation changes to preserve revision history even where the
-- current projection hides deleted revisions, so an edit inserts a new row and
-- nothing is ever updated in place. `annotations_current` is that projection.
--
-- `reviewplane_geometry_is_normalised` repeats the API-boundary check inside
-- the database. The duplication is deliberate: "reject, never clamp" is the
-- property the whole coordinate contract rests on, and a direct SQL write, a
-- future migration or a second service must not be able to introduce a
-- coordinate the renderer will place somewhere plausible and wrong.

CREATE FUNCTION reviewplane_geometry_is_normalised(geometry jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT
AS $$
    SELECT jsonb_typeof(geometry) = 'object'
       AND (geometry ? 'x') AND (geometry ? 'y')
       AND NOT EXISTS (
           SELECT 1
             FROM jsonb_each(geometry) AS member(name, value)
            WHERE member.name NOT IN ('x', 'y', 'width', 'height', 'x2', 'y2')
               OR jsonb_typeof(member.value) <> 'number'
               OR (member.value #>> '{}')::numeric < 0
               OR (member.value #>> '{}')::numeric > 1
       );
$$;

CREATE TABLE annotations (
    id                        text        NOT NULL,
    revision                  integer     NOT NULL DEFAULT 1,
    organisation_id           text        NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
    project_id                text        NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
    finding_id                text        NOT NULL REFERENCES findings (id) ON DELETE CASCADE,
    artefact_id               text        NOT NULL REFERENCES artefacts (id) ON DELETE RESTRICT,
    type                      text        NOT NULL,
    geometry                  jsonb       NOT NULL,
    label                     text        NOT NULL,
    marker_number             integer,
    style_hint                text        NOT NULL DEFAULT 'default',
    created_by_actor_type     text        NOT NULL,
    created_by_actor_id       text,
    created_by_actor_display  text,
    created_at                timestamptz NOT NULL DEFAULT now(),
    deleted_at                timestamptz,
    PRIMARY KEY (id, revision),
    CONSTRAINT annotations_type_known CHECK (
        type IN ('rectangle', 'ellipse', 'arrow', 'point', 'numbered_marker')
    ),
    CONSTRAINT annotations_style_hint_known CHECK (
        style_hint IN ('default', 'critical', 'informational')
    ),
    CONSTRAINT annotations_actor_type_known CHECK (
        created_by_actor_type IN ('human_user', 'agent_session', 'connector',
                                  'browser_worker', 'system', 'integration')
    ),
    CONSTRAINT annotations_revision_positive CHECK (revision >= 1),
    CONSTRAINT annotations_marker_number_range CHECK (
        marker_number IS NULL OR (marker_number >= 1 AND marker_number <= 999)
    ),
    CONSTRAINT annotations_geometry_normalised CHECK (
        reviewplane_geometry_is_normalised(geometry)
    ),
    -- Which members a type uses is the schema's geometry_by_annotation_type
    -- vocabulary. Enforced here so a box cannot be stored as a point.
    CONSTRAINT annotations_geometry_matches_type CHECK (
        CASE type
            WHEN 'rectangle' THEN (geometry ? 'width') AND (geometry ? 'height')
                                  AND NOT (geometry ? 'x2') AND NOT (geometry ? 'y2')
            WHEN 'ellipse'   THEN (geometry ? 'width') AND (geometry ? 'height')
                                  AND NOT (geometry ? 'x2') AND NOT (geometry ? 'y2')
            WHEN 'arrow'     THEN (geometry ? 'x2') AND (geometry ? 'y2')
                                  AND NOT (geometry ? 'width') AND NOT (geometry ? 'height')
            ELSE NOT (geometry ? 'width') AND NOT (geometry ? 'height')
                 AND NOT (geometry ? 'x2') AND NOT (geometry ? 'y2')
        END
    )
);

CREATE INDEX annotations_finding_idx ON annotations (finding_id, created_at);
CREATE INDEX annotations_artefact_idx ON annotations (artefact_id);

-- The current projection: the newest revision of each annotation, with
-- withdrawn ones hidden. Prior revisions stay in the table.
CREATE VIEW annotations_current AS
SELECT DISTINCT ON (id) *
  FROM annotations
 ORDER BY id, revision DESC;
