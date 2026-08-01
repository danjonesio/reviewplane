-- downgrade: not supported (forward-only; roll back by restoring the backup taken before the upgrade)
-- Append-only domain and audit events (docs/EVENTS.md, docs/ARCHITECTURE.md
-- section 10). Current state stays in normalised tables; this table is the
-- audit history, session timeline and realtime source.
--
-- This is the single canonical events migration. Several Stage 0 branches
-- introduced one independently; they are unified here so that the shape cannot
-- depend on which migration a database happened to apply first. Anything the
-- envelope of docs/EVENTS.md section 2 does not name belongs in `payload`.
--
-- The table is append-only by policy (section 4: corrections are new events).
-- No UPDATE or DELETE path exists in the server, and retention deletion, when
-- it arrives, is a documented operation rather than an ordinary write.

-- Allocates the next sequence for a stream. A sequence row that this statement
-- locks and increments keeps docs/EVENTS.md section 3's per-stream monotonicity
-- exact under concurrency, which a max()+1 read would not.
--
-- A stream is a project where one exists and the organisation otherwise, which
-- is what lets a connector event that precedes any project association still be
-- ordered and resumed.
create table if not exists event_streams (
  stream_key     text   primary key,
  last_sequence  bigint not null
);

create table if not exists events (
  id              text        primary key,
  schema_version  integer     not null default 1,
  stream_key      text        not null,
  -- Monotonic within a stream. Global ordering across projects is not
  -- guaranteed (docs/EVENTS.md section 3).
  sequence        bigint      not null,
  type            text        not null,
  occurred_at     timestamptz not null,
  recorded_at     timestamptz not null default now(),
  organisation_id text        not null,
  project_id      text,
  actor_type      text        not null,
  actor_id        text,
  actor_display   text,
  -- Correlation identifiers of docs/EVENTS.md section 2 and
  -- docs/ARCHITECTURE.md section 15.
  correlation     jsonb       not null default '{}'::jsonb,
  -- Payloads exclude raw secrets and sensitive headers
  -- (docs/EVENTS.md section 8).
  payload         jsonb       not null default '{}'::jsonb,

  constraint events_stream_sequence_unique unique (stream_key, sequence),
  constraint events_actor_type_known check (
    actor_type in ('human_user', 'agent_session', 'connector', 'browser_worker', 'system', 'integration')
  )
);

create index if not exists events_stream_sequence_index on events (stream_key, sequence desc);
create index if not exists events_project_sequence_index on events (project_id, sequence desc);
create index if not exists events_type_index on events (type, recorded_at desc);
create index if not exists events_organisation_index on events (organisation_id, occurred_at);
