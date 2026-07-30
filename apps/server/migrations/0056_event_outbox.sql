-- Post-commit fan-out for committed events (docs/EVENTS.md section 9,
-- docs/ARCHITECTURE.md section 10).
--
-- The event row and the state change it describes commit in one transaction.
-- Delivery cannot: a WebSocket write inside that transaction would either block
-- the commit or deliver an event that then rolled back. So the writer enqueues
-- an outbox row in the same transaction, and a dispatcher reads it after commit.
-- The row is therefore the durable record that fan-out is owed; a process that
-- dies between commit and delivery loses nothing, because the row survives it.
--
-- The dispatcher claims with FOR UPDATE SKIP LOCKED, which is the same
-- row-locking mechanism docs/ARCHITECTURE.md section 4.8 permits for durable
-- jobs. No broker is introduced.
--
-- Delivered rows are pruned rather than kept: the audit history is `events`, and
-- a second permanent copy of it would be a second thing to retain, redact and
-- erase under docs/EVENTS.md section 12.

CREATE TABLE event_outbox (
    event_id      text        PRIMARY KEY REFERENCES events (id) ON DELETE CASCADE,
    -- Denormalised so the dispatcher can order and scope a batch without joining
    -- the events table on every poll.
    stream_key    text        NOT NULL,
    sequence      bigint      NOT NULL,
    enqueued_at   timestamptz NOT NULL DEFAULT now(),
    -- NULL while the row is owed. Set when the dispatcher has fanned it out.
    dispatched_at timestamptz,
    attempts      integer     NOT NULL DEFAULT 0,

    CONSTRAINT event_outbox_attempts_bounded CHECK (attempts >= 0 AND attempts <= 1000)
);

-- The claim query's index: pending rows in stream order, so a batch is delivered
-- in the order the events were committed within each stream.
CREATE INDEX event_outbox_pending_index
    ON event_outbox (stream_key, sequence)
    WHERE dispatched_at IS NULL;

CREATE INDEX event_outbox_dispatched_index ON event_outbox (dispatched_at);
