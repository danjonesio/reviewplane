-- downgrade: not supported (forward-only; roll back by restoring the backup taken before the upgrade)
-- Local administrator accounts (docs/SECURITY.md section 6.1, RVP-12).
--
-- Stage 0 had one human credential: a long-lived token in the environment
-- (docs/ARCHITECTURE.md section 11). Stage 1 gives the deployment a real
-- account, and the account has to come from somewhere: an installation that
-- shipped with a default password would be an installation with a known
-- password.
--
-- So the credential is established through a one-time install token. The token
-- is minted by the operator command line at install, presented once, and
-- consumed exactly once to set an email address and a password. It expires
-- whether or not it is used, because a token that waits indefinitely on a
-- console scrollback is a permanent way in.
--
-- Three properties are load-bearing and are enforced here rather than in the
-- application:
--
--   * only the token's digest is stored, so a dump of this table is not a set
--     of usable tokens (the same rule the viewer-session table already follows);
--   * consumption is a conditional UPDATE, so two callers racing the same token
--     produce one winner and one refusal rather than two administrators;
--   * the failure counter is keyed by a digest of the subject rather than by
--     the subject, so throttling does not turn into a stored list of the
--     addresses people have tried to sign in as.

ALTER TABLE users
    -- The encoded password verifier: algorithm, parameters, salt and digest in
    -- one self-describing string, so the parameters can be raised later without
    -- a migration and an old row still verifies with the parameters it was
    -- written with. NULL means this user cannot authenticate locally.
    ADD COLUMN password_hash       text,
    ADD COLUMN password_updated_at timestamptz;

CREATE TABLE install_tokens (
    id                  text        PRIMARY KEY,
    organisation_id     text        NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
    -- SHA-256 of the token. The token itself is returned once, by the command
    -- that mints it, and never stored.
    token_sha256        text        NOT NULL UNIQUE,
    -- The user record the token establishes credentials for. Stage 1 has one
    -- user, so the token names it at mint time rather than creating a second.
    user_id             text        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at          timestamptz NOT NULL DEFAULT now(),
    expires_at          timestamptz NOT NULL,
    consumed_at         timestamptz,

    CONSTRAINT install_tokens_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX install_tokens_organisation_index ON install_tokens (organisation_id);
-- The lookup the consume path makes: a live token for this user.
CREATE INDEX install_tokens_live_index ON install_tokens (user_id, expires_at)
    WHERE consumed_at IS NULL;

-- Login rate limiting (docs/SECURITY.md section 6.1, docs/API.md section 19).
--
-- Not a domain record: it is throttling state, and it produces no event of its
-- own. What it does produce is the refusal that authentication.login_failed
-- records with reason `rate_limited`, which is the audit trail of the throttle
-- engaging.
--
-- `subject_sha256` is a digest of what the attempt was keyed by. Storing the
-- address itself would make this table an enumeration of who has tried to sign
-- in, which is exactly the disclosure docs/SECURITY.md section 5 tells the
-- authentication path not to make.
CREATE TABLE authentication_attempt_limits (
    subject_sha256     text        PRIMARY KEY,
    window_started_at  timestamptz NOT NULL DEFAULT now(),
    failure_count      integer     NOT NULL DEFAULT 0,
    locked_until       timestamptz,
    updated_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT authentication_attempt_limits_count_non_negative CHECK (failure_count >= 0)
);

CREATE INDEX authentication_attempt_limits_window_index
    ON authentication_attempt_limits (window_started_at);
