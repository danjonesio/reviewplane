-- The append-only event and audit table of docs/EVENTS.md section 2 and
-- docs/ARCHITECTURE.md section 10.
--
-- IF NOT EXISTS is deliberate: several Stage 0 branches introduce the first
-- surface that produces events, and each needs the table. Whichever migration
-- runs first creates it; the others confirm it. The definition is the event
-- envelope of docs/EVENTS.md section 2 and must stay identical across them.
--
-- The table is append-only by policy (section 4: corrections are new events).
-- No UPDATE or DELETE path exists in the server, and retention deletion, when
-- it arrives, is a documented operation rather than an ordinary write.

CREATE TABLE IF NOT EXISTS events (
    id                  text        PRIMARY KEY,
    schema_version      integer     NOT NULL DEFAULT 1,
    -- Monotonic within a project stream. Global ordering across projects is not
    -- guaranteed (docs/EVENTS.md section 3).
    sequence            bigint      NOT NULL,
    type                text        NOT NULL,
    occurred_at         timestamptz NOT NULL,
    recorded_at         timestamptz NOT NULL DEFAULT now(),
    organisation_id     text        NOT NULL,
    project_id          text,
    actor_type          text        NOT NULL
                            CHECK (actor_type IN (
                                'human_user', 'agent_session', 'connector',
                                'browser_worker', 'system', 'integration'
                            )),
    actor_id            text,
    actor_display       text,
    -- Correlation identifiers of docs/EVENTS.md section 2 and
    -- docs/ARCHITECTURE.md section 15.
    correlation         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- Payloads exclude raw secrets and sensitive headers
    -- (docs/EVENTS.md section 8).
    payload             jsonb       NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT events_project_sequence_unique UNIQUE (project_id, sequence)
);

CREATE INDEX IF NOT EXISTS events_project_sequence_idx
    ON events (project_id, sequence DESC);

CREATE INDEX IF NOT EXISTS events_type_idx
    ON events (type, recorded_at DESC);

-- Allocates the next sequence for a project stream. A sequence table rather
-- than a global one keeps docs/EVENTS.md section 3's per-project monotonicity
-- exact under concurrency, which a max()+1 read would not.
CREATE TABLE IF NOT EXISTS event_sequences (
    project_id      text    PRIMARY KEY,
    next_sequence   bigint  NOT NULL DEFAULT 1
);
