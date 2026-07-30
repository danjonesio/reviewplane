-- Session-scoped route capabilities.
--
-- The capability itself is a signed token the gateway verifies without a
-- lookup (packages/protocol, src/capability.ts). This table is not that: it is
-- the record of which capability was minted for which browser session, so that
-- one can be revoked by identity and so that docs/SECURITY.md section 16's
-- audit of published-service lifecycle can name it.
--
-- The token is not stored. A row that held the bearer credential would turn a
-- database read into a route grant, and nothing needs it: revocation works from
-- the identifier, and verification works from the signature.

CREATE TABLE IF NOT EXISTS route_capabilities (
    id                  text        PRIMARY KEY,
    organisation_id     text        NOT NULL,
    project_id          text        NOT NULL,
    published_service_id text       NOT NULL
                            REFERENCES published_services (id) ON DELETE CASCADE,
    browser_session_id  text        NOT NULL,
    -- Which signing key was used, so that a rotation can be audited.
    key_id              text        NOT NULL,
    issued_at           timestamptz NOT NULL,
    expires_at          timestamptz NOT NULL
                            CHECK (expires_at > issued_at),
    revoked_at          timestamptz
);

CREATE INDEX IF NOT EXISTS route_capabilities_service_idx
    ON route_capabilities (published_service_id, browser_session_id);

CREATE INDEX IF NOT EXISTS route_capabilities_live_idx
    ON route_capabilities (expires_at)
    WHERE revoked_at IS NULL;
