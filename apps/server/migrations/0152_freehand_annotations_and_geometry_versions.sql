-- downgrade: not supported (forward-only; roll back by restoring the backup taken before the upgrade)
-- The sixth annotation type of docs/DOMAIN_MODEL.md section 16, the rotation a
-- box may carry, and the per-type geometry version every annotation now
-- records (ADR-0032).
--
-- Migration 0048 stated the reason this validation is repeated inside the
-- database rather than trusted to the API boundary, and it has not changed:
-- "reject, never clamp" is the property the whole coordinate contract rests
-- on, and a direct SQL write, a future migration or a second service must not
-- be able to introduce a coordinate the renderer will place somewhere
-- plausible and wrong. Adding two members and a type without extending these
-- constraints would have left exactly that hole, because
-- `reviewplane_geometry_is_normalised` refuses any member it does not know:
-- a freehand path would have been rejected by the database after the API
-- accepted it.

-- The normalisation check now understands the two shapes a member may take: a
-- scalar coordinate, and the sampled path of a freehand stroke. Every point of
-- a path obeys the same 0-to-1 bound as every scalar, and the point count is
-- bounded here as it is in the schema, so a stroke that would cost more than
-- the finding it belongs to cannot be written by any route.
CREATE OR REPLACE FUNCTION reviewplane_geometry_is_normalised(geometry jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT
AS $$
    SELECT jsonb_typeof(geometry) = 'object'
       AND (geometry ? 'x') AND (geometry ? 'y')
       -- Scalar members: known name, numeric, within 0 to 1 inclusive.
       AND NOT EXISTS (
           SELECT 1
             FROM jsonb_each(geometry) AS member(name, value)
            WHERE member.name NOT IN ('x', 'y', 'width', 'height', 'x2', 'y2', 'rotation', 'path')
               OR (member.name <> 'path'
                   AND (jsonb_typeof(member.value) <> 'number'
                        OR (member.value #>> '{}')::numeric < 0
                        OR (member.value #>> '{}')::numeric > 1))
       )
       -- The path, when present, is an array of between 2 and 128 points, each
       -- an object of exactly x and y, each normalised.
       AND (
           NOT (geometry ? 'path')
           OR (
               jsonb_typeof(geometry -> 'path') = 'array'
               AND jsonb_array_length(geometry -> 'path') BETWEEN 2 AND 128
               AND NOT EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements(geometry -> 'path') AS point(value)
                    WHERE jsonb_typeof(point.value) <> 'object'
                       OR NOT (point.value ? 'x') OR NOT (point.value ? 'y')
                       OR EXISTS (
                           SELECT 1
                             FROM jsonb_each(point.value) AS coordinate(name, value)
                            WHERE coordinate.name NOT IN ('x', 'y')
                               OR jsonb_typeof(coordinate.value) <> 'number'
                               OR (coordinate.value #>> '{}')::numeric < 0
                               OR (coordinate.value #>> '{}')::numeric > 1
                       )
               )
           )
       );
$$;

ALTER TABLE annotations DROP CONSTRAINT annotations_type_known;
ALTER TABLE annotations ADD CONSTRAINT annotations_type_known CHECK (
    type IN ('rectangle', 'ellipse', 'arrow', 'point', 'numbered_marker', 'freehand')
);

-- Which members a type uses is still the schema's geometry_by_annotation_type
-- vocabulary. A rectangle and an ellipse may now be turned, which nothing else
-- may be: a point has no orientation and an arrow's direction is its two
-- points. A freehand mark carries its own bounding box as well as its path, so
-- that a reader which cannot draw the stroke still knows the region it covers.
ALTER TABLE annotations DROP CONSTRAINT annotations_geometry_matches_type;
ALTER TABLE annotations ADD CONSTRAINT annotations_geometry_matches_type CHECK (
    CASE type
        WHEN 'rectangle' THEN (geometry ? 'width') AND (geometry ? 'height')
                              AND NOT (geometry ? 'x2') AND NOT (geometry ? 'y2')
                              AND NOT (geometry ? 'path')
        WHEN 'ellipse'   THEN (geometry ? 'width') AND (geometry ? 'height')
                              AND NOT (geometry ? 'x2') AND NOT (geometry ? 'y2')
                              AND NOT (geometry ? 'path')
        WHEN 'arrow'     THEN (geometry ? 'x2') AND (geometry ? 'y2')
                              AND NOT (geometry ? 'width') AND NOT (geometry ? 'height')
                              AND NOT (geometry ? 'rotation') AND NOT (geometry ? 'path')
        WHEN 'freehand'  THEN (geometry ? 'width') AND (geometry ? 'height')
                              AND (geometry ? 'path')
                              AND NOT (geometry ? 'x2') AND NOT (geometry ? 'y2')
                              AND NOT (geometry ? 'rotation')
        ELSE NOT (geometry ? 'width') AND NOT (geometry ? 'height')
             AND NOT (geometry ? 'x2') AND NOT (geometry ? 'y2')
             AND NOT (geometry ? 'rotation') AND NOT (geometry ? 'path')
    END
);

-- The version of the member list a stored geometry was written against. It is
-- derived by the control plane from the annotation's type and is never
-- supplied by a caller, so it records which rule a row obeyed rather than
-- which rule its writer claimed to obey. Existing rows were written against
-- version 1 of their type, which is what the default backfills.
ALTER TABLE annotations ADD COLUMN geometry_version integer NOT NULL DEFAULT 1;
ALTER TABLE annotations ADD CONSTRAINT annotations_geometry_version_positive CHECK (
    geometry_version >= 1
);

-- `annotations_current` is recreated because a view records the columns that
-- existed when it was defined: without this the new column would be invisible
-- through the projection every read path uses, and an annotation would report
-- no geometry version through the API while carrying one in the table.
DROP VIEW annotations_current;
CREATE VIEW annotations_current AS
SELECT DISTINCT ON (id) *
  FROM annotations
 ORDER BY id, revision DESC;
