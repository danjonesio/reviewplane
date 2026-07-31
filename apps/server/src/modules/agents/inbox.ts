/**
 * The agent and human inbox (`docs/DOMAIN_MODEL.md` section 21,
 * `docs/MCP_SPEC.md` section 9, `docs/API.md` section 16).
 *
 * An inbox item is how a human hands work over and how the handover becomes a
 * fact rather than a conversation. Two properties of section 21 decide the
 * shape of everything here.
 *
 * **Retrieval must be idempotent.** Listing changes nothing: no row is stamped,
 * no status moves, no event is written. An agent may poll at every checkpoint
 * of `docs/MCP_SPEC.md` section 9 without the act of looking altering what it
 * is looking at, and two agents reading the same inbox see the same inbox.
 *
 * **Acknowledgement does not imply task completion.** They are different
 * statuses, different timestamps and different events, and no agent-facing
 * operation can reach `completed` at all: completion is recorded by the human
 * API when the work is judged done. A single "seen" flag would have made the
 * distinction unrepresentable, which is why it is two columns rather than one.
 *
 * Creation is transactional with the act that caused it. `create` takes a
 * client, never a pool, so an assignment that committed always has its delivery
 * beside it and a rolled-back assignment delivers nothing (`docs/EVENTS.md`
 * section 9).
 *
 * Every read carries the project **and** the caller's organisation. The scope
 * comes from the authenticated principal and never from the row being read, so
 * an identifier belonging to another tenant produces the same refusal as one
 * that never existed.
 */

import type { Pool, PoolClient } from "pg";

import { ApiError, notFound } from "../../errors.ts";
import { appendEvent, type EventActor } from "../../events/append.ts";
import { inTransaction } from "../../db/pool.ts";
import { newId } from "../../ids.ts";

export type InboxItemStatus = "pending" | "acknowledged" | "completed" | "dismissed" | "expired";
export type InboxItemType = "review_assigned" | "finding_reopened";
export type InboxRecipientType = "human_user" | "agent_session";

/** The statuses that still represent work in hand. */
export const LIVE_INBOX_STATUSES: readonly InboxItemStatus[] = ["pending", "acknowledged"];

export interface InboxItemRecord {
  readonly id: string;
  readonly organisation_id: string;
  readonly project_id: string;
  readonly recipient_type: InboxRecipientType;
  readonly recipient_id: string | null;
  readonly type: InboxItemType;
  readonly title: string;
  readonly status: InboxItemStatus;
  readonly review_id: string | null;
  readonly review_slug: string | null;
  readonly finding_id: string | null;
  readonly priority: string | null;
  readonly finding_count: number | null;
  readonly assigned_by: { type: string; id?: string; display?: string } | null;
  readonly created_at: string;
  readonly acknowledged_at: string | null;
  readonly completed_at: string | null;
  readonly expires_at: string | null;
}

export interface InboxScope {
  readonly organisationId: string;
  readonly projectId: string;
}

export interface CreateInboxItemInput {
  readonly organisationId: string;
  readonly projectId: string;
  readonly recipientType: InboxRecipientType;
  readonly recipientId: string | null;
  readonly type: InboxItemType;
  readonly title: string;
  readonly reviewId?: string | null;
  readonly findingId?: string | null;
  readonly reviewSlug?: string | null;
  readonly priority?: string | null;
  readonly findingCount?: number | null;
}

export interface InboxPage {
  readonly items: readonly InboxItemRecord[];
  readonly nextCursor: { readonly sortKey: string; readonly id: string } | null;
  readonly pendingCount: number;
}

interface Row {
  id: string;
  organisation_id: string;
  project_id: string;
  recipient_type: InboxRecipientType;
  recipient_id: string | null;
  type: InboxItemType;
  title: string;
  status: InboxItemStatus;
  review_id: string | null;
  finding_id: string | null;
  payload: Record<string, unknown>;
  created_by_actor_type: string | null;
  created_by_actor_id: string | null;
  created_by_actor_display: string | null;
  created_at: Date;
  acknowledged_at: Date | null;
  completed_at: Date | null;
  expires_at: Date | null;
}

const COLUMNS = `id, organisation_id, project_id, recipient_type, recipient_id, type, title,
                 status, review_id, finding_id, payload, created_by_actor_type,
                 created_by_actor_id, created_by_actor_display, created_at,
                 acknowledged_at, completed_at, expires_at`;

function toRecord(row: Row): InboxItemRecord {
  const payload = row.payload ?? {};
  const slug = payload["review_slug"];
  const priority = payload["priority"];
  const count = payload["finding_count"];
  return {
    id: row.id,
    organisation_id: row.organisation_id,
    project_id: row.project_id,
    recipient_type: row.recipient_type,
    recipient_id: row.recipient_id,
    type: row.type,
    title: row.title,
    status: row.status,
    review_id: row.review_id,
    review_slug: typeof slug === "string" ? slug : null,
    finding_id: row.finding_id,
    priority: typeof priority === "string" ? priority : null,
    finding_count: typeof count === "number" ? count : null,
    assigned_by:
      row.created_by_actor_type === null
        ? null
        : {
            type: row.created_by_actor_type,
            ...(row.created_by_actor_id === null ? {} : { id: row.created_by_actor_id }),
            ...(row.created_by_actor_display === null
              ? {}
              : { display: row.created_by_actor_display }),
          },
    created_at: row.created_at.toISOString(),
    acknowledged_at: row.acknowledged_at?.toISOString() ?? null,
    completed_at: row.completed_at?.toISOString() ?? null,
    expires_at: row.expires_at?.toISOString() ?? null,
  };
}

/** The transitions an inbox item may make, and from where. */
const TRANSITIONS: Readonly<Record<Exclude<InboxItemStatus, "pending">, readonly InboxItemStatus[]>> = {
  acknowledged: ["pending"],
  // Completion is reachable from an unacknowledged item too: work can be done
  // by somebody who never acknowledged it, and refusing that would make the
  // record less true rather than more disciplined.
  completed: ["pending", "acknowledged"],
  dismissed: ["pending", "acknowledged"],
  expired: ["pending", "acknowledged"],
};

const EVENT_FOR: Readonly<Record<Exclude<InboxItemStatus, "pending">, string>> = {
  acknowledged: "inbox_item.acknowledged",
  completed: "inbox_item.completed",
  dismissed: "inbox_item.dismissed",
  expired: "inbox_item.expired",
};

export class InboxStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * Records a delivery, inside the caller's transaction.
   *
   * A repeated delivery of the same work to the same recipient is not an error
   * and is not a second item: the partial unique index makes the insert a
   * no-op, and the existing item is returned. A human who clicks assign twice
   * has assigned once.
   */
  static async create(
    client: PoolClient,
    input: CreateInboxItemInput,
    actor: EventActor,
  ): Promise<InboxItemRecord> {
    const id = newId("inb_");
    const payload = {
      ...(input.reviewSlug === undefined || input.reviewSlug === null
        ? {}
        : { review_slug: input.reviewSlug }),
      ...(input.priority === undefined || input.priority === null
        ? {}
        : { priority: input.priority }),
      ...(input.findingCount === undefined || input.findingCount === null
        ? {}
        : { finding_count: input.findingCount }),
    };
    const inserted = await client.query<Row>(
      `INSERT INTO inbox_items
         (id, organisation_id, project_id, recipient_type, recipient_id, type, title,
          payload, review_id, finding_id, created_by_actor_type, created_by_actor_id,
          created_by_actor_display)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13)
       ON CONFLICT DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        id,
        input.organisationId,
        input.projectId,
        input.recipientType,
        input.recipientId,
        input.type,
        input.title,
        JSON.stringify(payload),
        input.reviewId ?? null,
        input.findingId ?? null,
        actor.type,
        actor.id ?? null,
        actor.display ?? null,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) {
      // The live-delivery index refused a duplicate. Return the item that
      // already carries this work rather than inventing a second one.
      const existing = await client.query<Row>(
        `SELECT ${COLUMNS} FROM inbox_items
          WHERE project_id = $1 AND type = $2 AND recipient_type = $3
            AND coalesce(recipient_id, '') = coalesce($4, '')
            AND status IN ('pending', 'acknowledged')
            AND (($5::text IS NULL) OR review_id = $5)
            AND (($6::text IS NULL) OR finding_id = $6)
          ORDER BY created_at DESC
          LIMIT 1`,
        [
          input.projectId,
          input.type,
          input.recipientType,
          input.recipientId,
          input.type === "review_assigned" ? (input.reviewId ?? null) : null,
          input.type === "finding_reopened" ? (input.findingId ?? null) : null,
        ],
      );
      const current = existing.rows[0];
      if (current === undefined) {
        throw new ApiError("INTERNAL_ERROR", "The inbox item could not be recorded.");
      }
      return toRecord(current);
    }

    const record = toRecord(row);
    await appendEvent(client, {
      type: "inbox_item.created",
      organisationId: record.organisation_id,
      projectId: record.project_id,
      actor,
      correlation: {
        ...(record.review_id === null ? {} : { review_id: record.review_id }),
        ...(record.finding_id === null ? {} : { finding_id: record.finding_id }),
        ...(record.recipient_type === "agent_session" && record.recipient_id !== null
          ? { agent_session_id: record.recipient_id }
          : {}),
      },
      payload: {
        inbox_item_id: record.id,
        recipient_type: record.recipient_type,
        ...(record.recipient_id === null ? {} : { recipient_id: record.recipient_id }),
        type: record.type,
        status: record.status,
        ...(record.review_id === null ? {} : { review_id: record.review_id }),
        ...(record.finding_id === null ? {} : { finding_id: record.finding_id }),
        ...(record.finding_count === null ? {} : { finding_count: record.finding_count }),
        ...(record.priority === null ? {} : { priority: record.priority }),
      },
    });
    return record;
  }

  /**
   * One bounded page, **oldest first**.
   *
   * Oldest first because the order a human recorded the work in is the order it
   * should be worked in; newest-first would hand an agent the most recent
   * request and leave the first one at the bottom of a page it may never reach.
   *
   * Nothing is written. `docs/DOMAIN_MODEL.md` section 21 requires retrieval to
   * be idempotent, and the strongest form of that is a method that issues no
   * `UPDATE` at all.
   */
  async list(
    scope: InboxScope,
    options: {
      readonly statuses?: readonly InboxItemStatus[];
      readonly recipient?: { readonly type: InboxRecipientType; readonly id: string | null };
      readonly limit?: number;
      readonly after?: { readonly sortKey: string; readonly id: string } | null;
    } = {},
  ): Promise<InboxPage> {
    const statuses = options.statuses ?? LIVE_INBOX_STATUSES;
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
    const recipientType = options.recipient?.type ?? null;
    const recipientId = options.recipient?.id ?? null;

    const rows = await this.#pool.query<Row>(
      `SELECT ${COLUMNS} FROM inbox_items
        WHERE organisation_id = $1 AND project_id = $2
          AND status = ANY($3)
          AND ($4::text IS NULL OR recipient_type = $4)
          AND ($5::text IS NULL OR recipient_id = $5 OR recipient_id IS NULL)
          AND ($6::timestamptz IS NULL OR (created_at, id) > ($6::timestamptz, $7::text))
        ORDER BY created_at ASC, id ASC
        LIMIT $8`,
      [
        scope.organisationId,
        scope.projectId,
        [...statuses],
        recipientType,
        recipientId,
        options.after?.sortKey ?? null,
        options.after?.id ?? null,
        limit + 1,
      ],
    );
    const all = rows.rows.map(toRecord);
    const items = all.slice(0, limit);
    const last = items[items.length - 1];
    const pending = await this.#pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM inbox_items
        WHERE organisation_id = $1 AND project_id = $2 AND status = 'pending'
          AND ($3::text IS NULL OR recipient_type = $3)
          AND ($4::text IS NULL OR recipient_id = $4 OR recipient_id IS NULL)`,
      [scope.organisationId, scope.projectId, recipientType, recipientId],
    );
    return {
      items,
      nextCursor:
        all.length > limit && last !== undefined
          ? { sortKey: last.created_at, id: last.id }
          : null,
      pendingCount: Number(pending.rows[0]?.count ?? 0),
    };
  }

  /** Items still pending for one recipient, as a count rather than as rows. */
  async pendingCount(
    scope: InboxScope,
    recipient: { readonly type: InboxRecipientType; readonly id: string | null },
  ): Promise<number> {
    const rows = await this.#pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM inbox_items
        WHERE organisation_id = $1 AND project_id = $2 AND status = 'pending'
          AND recipient_type = $3
          AND ($4::text IS NULL OR recipient_id = $4 OR recipient_id IS NULL)`,
      [scope.organisationId, scope.projectId, recipient.type, recipient.id],
    );
    return Number(rows.rows[0]?.count ?? 0);
  }

  /**
   * One item, scoped.
   *
   * The identifier, the project and the caller's organisation are all in the
   * same `WHERE` clause, so a foreign identifier and an unknown one are
   * answered identically. A lookup that read the row first and compared the
   * project afterwards would be an existence oracle for another tenant's
   * identifiers (`docs/SECURITY.md` section 7).
   */
  async get(scope: InboxScope, itemId: string): Promise<InboxItemRecord> {
    const rows = await this.#pool.query<Row>(
      `SELECT ${COLUMNS} FROM inbox_items
        WHERE id = $1 AND organisation_id = $2 AND project_id = $3`,
      [itemId, scope.organisationId, scope.projectId],
    );
    const row = rows.rows[0];
    if (row === undefined) throw notFound("The inbox item");
    return toRecord(row);
  }

  /**
   * Moves an item and records the move.
   *
   * The previous status is read under the lock that changes it, so the event
   * names the status the row was actually in rather than the set the transition
   * was willing to accept (`docs/EVENTS.md` section 7).
   *
   * An item already in the target status is returned unchanged and writes no
   * second event. That is what makes a retried acknowledgement acknowledge
   * once even without an idempotency key in front of it.
   */
  async transition(
    scope: InboxScope,
    itemId: string,
    to: Exclude<InboxItemStatus, "pending">,
    actor: EventActor,
    options: { readonly reason?: string; readonly recipient?: { readonly type: InboxRecipientType; readonly id: string | null } } = {},
  ): Promise<{ item: InboxItemRecord; previousStatus: InboxItemStatus }> {
    return inTransaction(this.#pool, async (client) => {
      const locked = await client.query<Row>(
        `SELECT ${COLUMNS} FROM inbox_items
          WHERE id = $1 AND organisation_id = $2 AND project_id = $3
          FOR UPDATE`,
        [itemId, scope.organisationId, scope.projectId],
      );
      const row = locked.rows[0];
      if (row === undefined) throw notFound("The inbox item");
      const current = toRecord(row);

      // The recipient check is an authorisation check and not a filter: an
      // agent session must not be able to acknowledge work delivered to another
      // session. It answers not-found rather than forbidden, so possession of
      // an identifier tells the caller nothing it did not already know.
      const recipient = options.recipient;
      if (recipient !== undefined) {
        const addressedToCaller =
          current.recipient_type === recipient.type &&
          (current.recipient_id === null || current.recipient_id === recipient.id);
        if (!addressedToCaller) throw notFound("The inbox item");
      }

      if (current.status === to) return { item: current, previousStatus: current.status };
      if (!TRANSITIONS[to].includes(current.status)) {
        throw new ApiError(
          "POLICY_DENIED",
          `An inbox item that is ${current.status} cannot become ${to}.`,
          { field: "status" },
        );
      }

      const updated = await client.query<Row>(
        `UPDATE inbox_items
            SET status = $4,
                acknowledged_at = CASE WHEN $4 = 'acknowledged' THEN now()
                                       ELSE acknowledged_at END,
                completed_at = CASE WHEN $4 = 'completed' THEN now() ELSE completed_at END
          WHERE id = $1 AND organisation_id = $2 AND project_id = $3
          RETURNING ${COLUMNS}`,
        [itemId, scope.organisationId, scope.projectId, to],
      );
      const item = toRecord(updated.rows[0] as Row);
      await appendEvent(client, {
        type: EVENT_FOR[to],
        organisationId: scope.organisationId,
        projectId: scope.projectId,
        actor,
        correlation: {
          ...(item.review_id === null ? {} : { review_id: item.review_id }),
          ...(item.finding_id === null ? {} : { finding_id: item.finding_id }),
        },
        payload: {
          inbox_item_id: item.id,
          previous_status: current.status,
          ...(item.review_id === null ? {} : { review_id: item.review_id }),
          ...(to === "dismissed" && options.reason !== undefined
            ? { reason: options.reason }
            : {}),
        },
      });
      return { item, previousStatus: current.status };
    });
  }
}
