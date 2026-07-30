-- Organisations and projects (docs/DOMAIN_MODEL.md sections 4 and 6).
--
-- This is the single canonical definition. Several Stage 0 branches introduced
-- these two tables independently, guarded by "if not exists", which would have
-- made the columns depend on which migration a database happened to apply
-- first; the union of what those branches declared is here.
--
-- Only the columns Stage 0 reads are declared. Repository identity, settings
-- and policy arrive with the issues that use them.
--
-- A project is deleted with RESTRICT rather than CASCADE: reviews, findings and
-- events hang off a project, and removing one because its organisation row went
-- away is not a decision a foreign key should be making.

create table if not exists organisations (
  id          text        primary key,
  name        text        not null,
  slug        text        not null unique,
  status      text        not null default 'active',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists projects (
  id               text        primary key,
  organisation_id  text        not null references organisations (id) on delete restrict,
  name             text        not null,
  slug             text        not null,
  status           text        not null default 'active',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint projects_slug_unique_per_organisation unique (organisation_id, slug)
);

create index if not exists projects_organisation_index on projects (organisation_id);
