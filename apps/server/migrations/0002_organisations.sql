-- Organisations and projects (docs/DOMAIN_MODEL.md sections 4 and 6).
--
-- Stage 0 needs only enough of these aggregates to scope an enrolment token and
-- a connector. They are created with "if not exists" because several Stage 0
-- branches need them; the branch that owns projects fills in the rest.

create table if not exists organisations (
  id          text        primary key,
  name        text        not null,
  created_at  timestamptz not null default now()
);

create table if not exists projects (
  id               text        primary key,
  organisation_id  text        not null references organisations (id) on delete cascade,
  name             text        not null,
  slug             text        not null,
  created_at       timestamptz not null default now(),

  constraint projects_slug_unique_per_organisation unique (organisation_id, slug)
);

create index if not exists projects_organisation_index on projects (organisation_id);
