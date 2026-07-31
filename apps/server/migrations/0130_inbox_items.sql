-- Inbox items (docs/DOMAIN_MODEL.md section 21, docs/API.md section 16,
-- docs/MCP_SPEC.md section 9, RVP-49).
--
-- A durable work notification. Before this table an agent learned what a human
-- wanted changed by being told a review's name out of band, which is not a
-- delivery anybody can audit: nothing recorded that the work was handed over,
-- and nothing recorded whether it was received. Four choices here are
-- load-bearing.
--
--   * `status` separates `acknowledged` from `completed`. Section 21 says
--     acknowledgement does not imply task completion, and a single "seen" flag
--     would make that rule unenforceable rather than merely unenforced: there
--     would be no column in which the difference could be stored.
--   * `recipient_type` and `recipient_id` are a polymorphic pair rather than
--     two nullable foreign keys, because the two recipients have different
--     lifetimes. An agent session is transient and its rows are cleaned up; a
--     user is not. `ON DELETE CASCADE` from either would delete the record of a
--     delivery that really happened, so the reference is checked on write and
--     the row survives the principal.
--   * The unique index on `(project_id, type, review_id, recipient_type,
--     recipient_id)` for live items is what makes re-assigning a review to the
--     same recipient idempotent. Without it, a human clicking assign twice
--     would deliver the same work twice and an agent would work it twice.
--   * `expires_at` is nullable and nothing sweeps it yet. The column exists
--     because section 21 lists `expired` as a status and a status no column can
--     produce is a status that does not exist; the sweep arrives with the
--     retention work of Stage 2.
--
-- The project is on the row and every read carries it. An inbox item never
-- crosses a project: that is the same scoping rule the reviews it references
-- obey, and it is expressed here so a query cannot forget it.

CREATE TABLE inbox_items (
    id               text        PRIMARY KEY,
    organisation_id  text        NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
    project_id       text        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,

    recipient_type   text        NOT NULL,
    -- Deliberately not a foreign key. See the note above: a delivery that
    -- happened must stay recorded after the agent session that received it has
    -- gone, and an agent session is a short-lived row.
    recipient_id     text,

    type             text        NOT NULL,
    title            text        NOT NULL,
    -- Everything the item names beyond the columns below: the review slug, the
    -- finding count and the priority at the moment of delivery. It is a
    -- snapshot on purpose — an inbox item says what was handed over, not what
    -- the review looks like now.
    payload          jsonb       NOT NULL DEFAULT '{}'::jsonb,

    review_id        text        REFERENCES reviews (id) ON DELETE CASCADE,
    finding_id       text        REFERENCES findings (id) ON DELETE CASCADE,

    status           text        NOT NULL DEFAULT 'pending',

    created_by_actor_type    text,
    created_by_actor_id      text,
    created_by_actor_display text,

    created_at       timestamptz NOT NULL DEFAULT now(),
    acknowledged_at  timestamptz,
    completed_at     timestamptz,
    expires_at       timestamptz,

    CONSTRAINT inbox_items_recipient_known CHECK (
        recipient_type IN ('human_user', 'agent_session')
    ),
    CONSTRAINT inbox_items_type_known CHECK (
        type IN ('review_assigned', 'finding_reopened')
    ),
    CONSTRAINT inbox_items_status_known CHECK (
        status IN ('pending', 'acknowledged', 'completed', 'dismissed', 'expired')
    ),
    -- A timestamp is the evidence for a status. A row claiming to be
    -- acknowledged with no acknowledgement time would be a claim with nothing
    -- behind it, and the UI of docs/UX_FLOWS.md section 11 shows the time.
    CONSTRAINT inbox_items_acknowledged_has_time CHECK (
        status <> 'acknowledged' OR acknowledged_at IS NOT NULL
    ),
    CONSTRAINT inbox_items_completed_has_time CHECK (
        status <> 'completed' OR completed_at IS NOT NULL
    ),
    -- Each type names the work it delivers, and the column it names it in is
    -- the one the live-delivery index is keyed on. An item that named nothing
    -- would give a recipient nothing to act on; one that named the wrong thing
    -- would escape the uniqueness that makes delivery idempotent.
    CONSTRAINT inbox_items_names_work CHECK (
        (type = 'review_assigned' AND review_id IS NOT NULL)
        OR (type = 'finding_reopened' AND finding_id IS NOT NULL)
    )
);

-- The list query: this project, these statuses, oldest first. Ordering by
-- `(created_at, id)` rather than by `created_at` alone is what makes the cursor
-- stable when two items are created in the same transaction, which is exactly
-- what assigning a review with several findings does.
CREATE INDEX inbox_items_project_idx
    ON inbox_items (project_id, status, created_at, id);

CREATE INDEX inbox_items_recipient_idx
    ON inbox_items (recipient_type, recipient_id, status, created_at);

CREATE INDEX inbox_items_review_idx ON inbox_items (review_id);

-- One live delivery of one piece of work to one recipient. A repeat assignment
-- of the same review to the same recipient creates nothing, so the agent sees
-- one item. Completed, dismissed and expired items are excluded, so the same
-- review can be assigned again after the first delivery was worked.
--
-- The two indexes are keyed on different columns because the two item types
-- name different work: a review assignment is one per review, and a reopen is
-- one per finding. Keying both on the review would collapse two findings
-- reopened in one review into a single delivery, and the second finding would
-- never be delivered at all.
CREATE UNIQUE INDEX inbox_items_live_review_delivery_idx
    ON inbox_items (project_id, review_id, recipient_type, coalesce(recipient_id, ''))
    WHERE status IN ('pending', 'acknowledged') AND type = 'review_assigned';

CREATE UNIQUE INDEX inbox_items_live_finding_delivery_idx
    ON inbox_items (project_id, finding_id, recipient_type, coalesce(recipient_id, ''))
    WHERE status IN ('pending', 'acknowledged') AND type = 'finding_reopened';
