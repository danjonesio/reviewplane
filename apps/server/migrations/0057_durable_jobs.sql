-- Durable background work (docs/ARCHITECTURE.md sections 4.8 and 5.1).
--
-- "Initial durable jobs may use PostgreSQL row locking. A separate message
-- broker is deferred until measured load requires it." This table is that
-- decision made concrete: a claim is SELECT ... FOR UPDATE SKIP LOCKED inside a
-- transaction, so two runners never take the same row and a runner that dies
-- releases its claim when its transaction is rolled back by the server.
--
-- `locked_until` exists because a lost connection is not always noticed
-- promptly: a claim also carries a lease, and a job whose lease has expired is
-- claimable again even if the database still believes the old session lives.
-- The two together mean a crashed runner costs a delay rather than a stuck job,
-- which is what "recover durable jobs" in docs/ARCHITECTURE.md section 14 asks
-- of a control-plane restart.
--
-- Every job carries organisation_id and project_id even in a single-organisation
-- deployment, for the defence-in-depth filtering docs/DOMAIN_MODEL.md section 3
-- requires of every project-owned record.

CREATE TABLE jobs (
    id               text        PRIMARY KEY,
    organisation_id  text        NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
    project_id       text        REFERENCES projects (id) ON DELETE CASCADE,
    kind             text        NOT NULL,
    -- Job input. It is a payload, not a credential store: docs/EVENTS.md section
    -- 8 and docs/SECURITY.md section 18 forbid a secret here as they do in an
    -- event payload, and a handler that needs one reads it from configuration.
    payload          jsonb       NOT NULL DEFAULT '{}'::jsonb,
    status           text        NOT NULL DEFAULT 'pending',
    -- Earliest instant a runner may claim the job. Backoff moves it forward.
    run_after        timestamptz NOT NULL DEFAULT now(),
    attempts         integer     NOT NULL DEFAULT 0,
    max_attempts     integer     NOT NULL DEFAULT 5,
    -- Lease held by the runner that claimed the job.
    locked_until     timestamptz,
    locked_by        text,
    last_error       text,
    -- Deduplicates work that is scheduled repeatedly: an expiry sweep enqueued
    -- twice for one route is one job.
    idempotency_key  text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    completed_at     timestamptz,

    CONSTRAINT jobs_status_known CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    CONSTRAINT jobs_attempts_bounded CHECK (attempts >= 0 AND attempts <= max_attempts),
    CONSTRAINT jobs_max_attempts_positive CHECK (max_attempts >= 1 AND max_attempts <= 1000)
);

-- The claim query's index: claimable jobs in due order.
CREATE INDEX jobs_claimable_index
    ON jobs (run_after, created_at)
    WHERE status = 'pending';

CREATE INDEX jobs_organisation_index ON jobs (organisation_id, created_at DESC);
CREATE INDEX jobs_project_index ON jobs (project_id, created_at DESC);

-- One live job per deduplication key. A completed or failed job releases the
-- key, so the same sweep can be scheduled again tomorrow.
CREATE UNIQUE INDEX jobs_idempotency_key_unique
    ON jobs (kind, idempotency_key)
    WHERE idempotency_key IS NOT NULL AND status IN ('pending', 'running');
