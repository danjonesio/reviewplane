-- Organisation and project records (docs/DOMAIN_MODEL.md sections 4 and 6).
--
-- IF NOT EXISTS because every Stage 0 branch needs a project to hang its own
-- records from; the integration step keeps one copy. Only the columns Stage 0
-- reads are declared here — repository identity, settings and policy arrive
-- with the issues that use them.

CREATE TABLE IF NOT EXISTS organisations (
    id          text        PRIMARY KEY,
    name        text        NOT NULL,
    slug        text        NOT NULL UNIQUE,
    status      text        NOT NULL DEFAULT 'active',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
    id               text        PRIMARY KEY,
    organisation_id  text        NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
    name             text        NOT NULL,
    slug             text        NOT NULL,
    status           text        NOT NULL DEFAULT 'active',
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT projects_slug_unique_per_organisation UNIQUE (organisation_id, slug)
);
