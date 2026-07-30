-- Append-only domain and audit events (docs/EVENTS.md, docs/ARCHITECTURE.md
-- section 10). Current state stays in normalised tables; this table is the
-- audit history, session timeline and realtime source.
--
-- Created with "if not exists" because several Stage 0 branches introduce the
-- same table independently. The definition here is the one the events module
-- writes; a branch that needs another column adds it in its own migration.

create table if not exists event_streams (
  -- A project where one exists, the organisation otherwise. docs/EVENTS.md
  -- section 3 makes sequence monotonic within a project stream; an event that
  -- precedes any project association is ordered within its organisation.
  stream_key     text   primary key,
  last_sequence  bigint not null
);

create table if not exists events (
  id              text        primary key,
  schema_version  integer     not null,
  stream_key      text        not null,
  sequence        bigint      not null,
  type            text        not null,
  occurred_at     timestamptz not null,
  recorded_at     timestamptz not null default now(),
  organisation_id text        not null,
  project_id      text,
  actor_type      text        not null,
  actor_id        text,
  actor_display   text,
  correlation     jsonb       not null default '{}'::jsonb,
  payload         jsonb       not null default '{}'::jsonb,

  constraint events_stream_sequence_unique unique (stream_key, sequence),
  constraint events_actor_type_known check (
    actor_type in ('human_user', 'agent_session', 'connector', 'browser_worker', 'system', 'integration')
  )
);

create index if not exists events_stream_sequence_index on events (stream_key, sequence);
create index if not exists events_type_index on events (type, occurred_at);
create index if not exists events_organisation_index on events (organisation_id, occurred_at);
