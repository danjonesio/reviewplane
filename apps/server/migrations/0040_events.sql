-- Append-only domain and audit event stream (docs/EVENTS.md, docs/ARCHITECTURE.md section 10).
--
-- IF NOT EXISTS because several Stage 0 branches introduce this same table
-- independently; the integration step keeps one copy. The shape is the
-- docs/EVENTS.md section 2 envelope.
--
-- `sequence` is monotonic within a project stream (section 3), not globally,
-- so a consumer can resume from its last acknowledged project sequence.

CREATE TABLE IF NOT EXISTS events (
    id                  text        PRIMARY KEY,
    schema_version      integer     NOT NULL DEFAULT 1,
    project_id          text        NOT NULL,
    organisation_id     text        NOT NULL,
    sequence            bigint      NOT NULL,
    type                text        NOT NULL,
    occurred_at         timestamptz NOT NULL,
    recorded_at         timestamptz NOT NULL DEFAULT now(),
    actor_type          text        NOT NULL,
    actor_id            text,
    actor_display       text,
    correlation         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    payload             jsonb       NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT events_project_sequence_unique UNIQUE (project_id, sequence),
    CONSTRAINT events_actor_type_known CHECK (
        actor_type IN ('human_user', 'agent_session', 'connector', 'browser_worker', 'system', 'integration')
    )
);

CREATE INDEX IF NOT EXISTS events_project_sequence_idx ON events (project_id, sequence DESC);
CREATE INDEX IF NOT EXISTS events_type_idx ON events (type);
