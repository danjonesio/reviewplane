-- downgrade: not supported (forward-only; roll back by restoring the backup taken before the upgrade)
-- The single Stage 1 user, and the organisation that owns it
-- (docs/DOMAIN_MODEL.md section 4, docs/ARCHITECTURE.md section 11).
--
-- Stage 1 has exactly one organisation and one user. Memberships, roles and RBAC
-- are Stage 3, and OIDC is Stage 2, so this table carries identity and nothing
-- that authenticates: no password, no digest, no token. The credentials arrive
-- with the issue that introduces session authentication, and adding them later
-- is an additive migration; putting an unused credential column here now would
-- be a place for a secret to end up before anything is ready to protect it.
--
-- The seed runs only when the deployment holds no organisation at all. That is
-- what makes the Stage 0 -> Stage 1 upgrade path work: a database that already
-- carries an organisation created through the API keeps it, and a fresh one gets
-- the single organisation and user Stage 1 is defined to have. Identifiers are
-- minted here with the same shape the application mints -- a documented prefix
-- and 128 bits of randomness -- because docs/DOMAIN_MODEL.md section 3 forbids
-- an identifier that encodes anything, including "this row was seeded".

CREATE TABLE users (
    id               text        PRIMARY KEY,
    organisation_id  text        NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
    -- The address a human is known by. It is an alias, never an identity: the
    -- identifier above is what every other table references.
    email            text        NOT NULL,
    display_name     text        NOT NULL,
    status           text        NOT NULL DEFAULT 'active',
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT users_email_unique_per_organisation UNIQUE (organisation_id, email),
    CONSTRAINT users_status_known CHECK (status IN ('active', 'suspended'))
);

CREATE INDEX users_organisation_index ON users (organisation_id);

-- Seed exactly one organisation and one user, and only into an empty
-- deployment. gen_random_uuid() is in core PostgreSQL from version 13, so no
-- extension is required and the migration needs no privilege beyond its own
-- schema.
DO $seed$
DECLARE
    seeded_organisation text;
    seeded_user         text;
BEGIN
    IF EXISTS (SELECT 1 FROM organisations) THEN
        RETURN;
    END IF;

    seeded_organisation := 'org_' || replace(gen_random_uuid()::text, '-', '');
    seeded_user := 'usr_' || replace(gen_random_uuid()::text, '-', '');

    INSERT INTO organisations (id, name, slug) VALUES (seeded_organisation, 'ReviewPlane', 'reviewplane');
    INSERT INTO users (id, organisation_id, email, display_name)
    VALUES (seeded_user, seeded_organisation, 'administrator@localhost', 'Administrator');

    -- Every meaningful state change produces an event (AGENTS.md). A seed is a
    -- state change, and an organisation that appeared with no audit record would
    -- be the one gap in the trail. The stream is the organisation's own, because
    -- no project exists yet.
    INSERT INTO event_streams (stream_key, last_sequence)
    VALUES (seeded_organisation, 1)
    ON CONFLICT (stream_key) DO UPDATE SET last_sequence = event_streams.last_sequence + 1;

    INSERT INTO events (
        id, schema_version, stream_key, sequence, type, occurred_at,
        organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload
    )
    SELECT
        'evt_' || replace(gen_random_uuid()::text, '-', ''),
        1,
        seeded_organisation,
        (SELECT last_sequence FROM event_streams WHERE stream_key = seeded_organisation),
        'organisation.created',
        now(),
        seeded_organisation,
        NULL,
        'system',
        NULL,
        'reviewplane migrate',
        '{}'::jsonb,
        jsonb_build_object('slug', 'reviewplane', 'name', 'ReviewPlane');
END
$seed$;
