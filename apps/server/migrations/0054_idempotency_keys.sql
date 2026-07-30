-- Idempotency keys for state-changing MCP tools (docs/MCP_SPEC.md section 10).
--
-- The primary key is the scope the specification states: actor, tool and
-- project. It is a composite key rather than a unique index on the key alone,
-- so two agents working the same project cannot collide on a key one of them
-- chose, and one agent cannot reach another's stored response by guessing.
--
-- `request_sha256` is what makes the two outcomes of section 10 distinguishable.
-- The same key with the same arguments returns `response`, and the operation
-- runs once — which is the single-record guarantee docs/TESTING.md section 11
-- asks for on a duplicate verification. The same key with different arguments
-- is IDEMPOTENCY_CONFLICT, because the caller has reused a key for a different
-- request and the only safe answer is to refuse both interpretations.
--
-- `response` is NULL while the operation is in flight. A concurrent duplicate
-- that finds a claimed-but-unfinished row is told to retry rather than allowed
-- to run the operation a second time.

CREATE TABLE idempotency_keys (
    project_id      text        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    actor_type      text        NOT NULL,
    actor_id        text        NOT NULL,
    tool            text        NOT NULL,
    key             text        NOT NULL,
    request_sha256  text        NOT NULL,
    response        jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz,
    expires_at      timestamptz NOT NULL,
    PRIMARY KEY (project_id, actor_type, actor_id, tool, key),
    CONSTRAINT idempotency_actor_type_known CHECK (
        actor_type IN ('human_user', 'agent_session', 'connector',
                       'browser_worker', 'system', 'integration')
    ),
    CONSTRAINT idempotency_digest_shape CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT idempotency_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);
