/**
 * Reviews, findings and annotations: the durable half of the product loop
 * (`docs/ARCHITECTURE.md` section 9, ADR-0004, ADR-0006).
 *
 * Three properties shape every method here.
 *
 * **Every query is filtered by organisation and project.** The identifiers are
 * on each row (`docs/DOMAIN_MODEL.md` section 3) and the `WHERE` clauses use
 * them even when the primary key alone would be unique. A lookup by identifier
 * that happens to succeed across a tenant boundary is the failure mode that
 * defence in depth exists for.
 *
 * **A command and its event commit together.** `docs/EVENTS.md` section 9
 * requires it, so everything that changes state runs inside `inTransaction`
 * and calls `appendEvent` on the same client. A state change with no audit
 * record is not an acceptable partial success.
 *
 * **Originals and overlays are separate.** An annotation row holds geometry
 * and a reference to an immutable artefact; nothing here writes image bytes,
 * and nothing draws into one.
 */

import type { Pool, PoolClient } from "pg";

import {
  type Annotation,
  type AnnotationType,
  type Comment,
  type Finding,
  type FindingSource,
  type FindingStatus,
  type Review,
  type ReviewPriority,
  type ReviewStatus,
  type VerificationChecks,
  type VerificationReference,
  type Viewport,
  isFinalDisposition,
  mayActorMoveFinding,
} from "@reviewplane/protocol/review";

import type { CompletionResult } from "@reviewplane/protocol/mcp";
import type { ProjectSettings } from "@reviewplane/protocol/platform";

import { inTransaction } from "../../db/pool.ts";
import { ApiError, notFound } from "../../errors.ts";
import { appendEvent, type EventActor } from "../../events/append.ts";
import { newId } from "../../ids.ts";
import { enqueueJob } from "../../jobs/runner.ts";
import { InboxStore } from "../agents/inbox.ts";
import type { ArtefactService } from "../artefacts/service.ts";
import {
  completionRequirementsFor,
  findingCompletionState,
  missingEvidence,
  type CompletionRequirements,
  type EvidenceUnderReview,
  type FindingCompletionState,
} from "./completion.ts";
import {
  ACTIVE_REVIEW_STATUSES,
  assertActorMayMoveFinding,
  assertActorMayMoveReview,
  assertCapturedContext,
  assertCompletionEvidence,
  assertExpectedVersion,
  assertFindingTransition,
  assertGeometry,
  assertReviewAcceptable,
  assertReviewMutable,
  assertActorMayCloseReview,
  assertActorMayDispose,
  assertReviewTransition,
  assertVerificationCommitContext,
} from "./domain.ts";

/** A verification record, as `docs/DOMAIN_MODEL.md` section 19 defines it. */
export type Verification = VerificationReference;

export interface SubmitVerificationInput {
  readonly summary: string;
  readonly branch: string;
  readonly commit: string;
  readonly testedViewports: readonly Viewport[];
  readonly checks: VerificationChecks;
  readonly artefactIds: readonly string[];
  /**
   * Branch the control plane believes the workspace is on, or null when no
   * workspace is registered. The caller supplies it because resolving the
   * workspace is the agent layer's job; the rule about what to do with it is
   * the domain's.
   */
  readonly workspaceBranch: string | null;
  /**
   * Version the caller last read, where it wants the submission refused if the
   * finding moved.
   *
   * It is checked **inside** the transaction that writes the new version, under
   * the same row lock (RVP-69 item 3). The MCP layer used to check it
   * beforehand with a separate read, which left a window in which a concurrent
   * human edit could be told its version conflicted with one this submission
   * had not yet published. A check outside the transaction whose write it
   * guards is not a check.
   */
  readonly expectedVersion?: number;
}

/** The tenant a caller is confined to. Every read and write takes one. */
export interface Scope {
  readonly organisationId: string;
  readonly projectId: string;
}

export interface CreateReviewInput {
  readonly slug: string;
  readonly title: string;
  readonly description?: string;
  readonly status?: ReviewStatus;
  readonly priority?: ReviewPriority;
  readonly capturedBranch: string;
  readonly capturedCommit: string;
  readonly capturedWorkspaceId: string;
  readonly sourceBrowserSessionId: string;
}

export interface UpdateReviewInput {
  readonly expectedVersion: number;
  readonly title?: string;
  readonly slug?: string;
  readonly description?: string;
  readonly status?: ReviewStatus;
  readonly priority?: ReviewPriority;
  /** Recorded on the events the change produces, never on the record. */
  readonly reason?: string;
}

/** Who a review is assigned to. Naming neither clears the assignment. */
export interface AssignReviewInput {
  readonly expectedVersion: number;
  readonly assignedUserId?: string;
  readonly assignedAgentSessionId?: string;
  readonly reason?: string;
}

/** The lifecycle routes of `docs/API.md` section 12 all carry this much. */
export interface ReviewTransitionInput {
  readonly expectedVersion: number;
  readonly reason?: string;
}

/** A human's final decision about one finding. */
export interface DisposeFindingInput {
  readonly expectedVersion: number;
  readonly reason?: string;
  readonly duplicateOfFindingId?: string;
}

/** One page of a keyset-paginated collection. */
export interface RepositoryPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: { readonly sortKey: string; readonly id: string } | null;
}

/** The position after the last row a caller has seen. */
/** Which part of a review a search matched (`docs/MCP_SPEC.md` section 7.6). */
export type ReviewSearchField = "title" | "slug" | "description" | "finding";

/**
 * Narrowing applied to a review listing.
 *
 * Every member narrows within the scope the caller already holds. None of them
 * names a project or an organisation, so no filter can widen a listing beyond
 * the scope its caller was authenticated for.
 */
export interface ReviewListFilter {
  readonly statuses?: readonly ReviewStatus[];
  readonly assignedAgentSessionId?: string;
  readonly slugPrefix?: string;
  readonly updatedSince?: string;
}

export interface PageCursor {
  readonly limit: number;
  readonly after: { readonly sortKey: string; readonly id: string } | null;
}

/** A review export, as `docs/API.md` section 12 answers it. */
export interface ReviewExport {
  readonly id: string;
  readonly review_id: string;
  readonly status: "pending" | "ready" | "failed";
  readonly privacy_mode: string;
  readonly artefact_id: string | null;
  readonly sha256: string | null;
  readonly size_bytes: number | null;
  readonly failure_reason: string | null;
  readonly created_at: string;
  readonly completed_at: string | null;
}

export interface CreateAnnotationInput {
  readonly artefactId: string;
  readonly type: AnnotationType;
  readonly geometry: Record<string, unknown>;
  readonly label: string;
  readonly markerNumber?: number;
  readonly styleHint?: "default" | "critical" | "informational";
}

export interface CreateFindingInput {
  readonly title: string;
  readonly description?: string;
  readonly severity: Finding["severity"];
  readonly url: string;
  readonly viewport: Record<string, unknown>;
  readonly scrollPosition: Record<string, unknown>;
  readonly capturedCommit: string;
  readonly screenshotArtefactId: string;
  readonly elementContext?: Record<string, unknown>;
  readonly acceptanceCriteria?: string;
  readonly annotations?: readonly CreateAnnotationInput[];
}

export interface UpdateFindingInput {
  readonly expectedVersion: number;
  readonly title?: string;
  readonly description?: string;
  readonly severity?: Finding["severity"];
  readonly status?: FindingStatus;
  readonly acceptanceCriteria?: string;
  readonly resolutionNote?: string;
  /** Recorded with a final disposition or a reopen, and on their events. */
  readonly reason?: string;
  readonly duplicateOfFindingId?: string;
}

function timestamp(value: unknown): string {
  return (value as Date).toISOString();
}

function actorOf(
  row: Record<string, unknown>,
  prefix: "created_by" | "claimed_by" | "submitted_by",
): EventActor | undefined {
  const type = row[`${prefix}_actor_type`] as string | null;
  if (type === null || type === undefined) return undefined;
  const id = row[`${prefix}_actor_id`] as string | null;
  const display = row[`${prefix}_actor_display`] as string | null;
  return {
    type: type as EventActor["type"],
    ...(id === null ? {} : { id }),
    ...(display === null ? {} : { display }),
  };
}

function toReview(row: Record<string, unknown>, findingCount?: number): Review {
  const createdBy = actorOf(row, "created_by");
  return {
    id: row["id"] as string,
    organisation_id: row["organisation_id"] as string,
    project_id: row["project_id"] as string,
    slug: row["slug"] as string,
    title: row["title"] as string,
    ...(row["description"] === null ? {} : { description: row["description"] as string }),
    status: row["status"] as ReviewStatus,
    ...(row["priority"] === null || row["priority"] === undefined
      ? {}
      : { priority: row["priority"] as ReviewPriority }),
    version: Number(row["version"]),
    created_by: createdBy ?? { type: "system" },
    ...(row["assigned_user_id"] === null || row["assigned_user_id"] === undefined
      ? {}
      : { assigned_user_id: row["assigned_user_id"] as string }),
    ...(row["assigned_agent_session_id"] === null ||
    row["assigned_agent_session_id"] === undefined
      ? {}
      : { assigned_agent_session_id: row["assigned_agent_session_id"] as string }),
    ...(row["reopen_count"] === undefined
      ? {}
      : { reopen_count: Number(row["reopen_count"]) }),
    captured_branch: row["captured_branch"] as string,
    captured_commit: row["captured_commit"] as string,
    captured_workspace_id: row["captured_workspace_id"] as string,
    source_browser_session_id: (row["source_browser_session_id"] as string | null) ?? "",
    ...(findingCount === undefined ? {} : { finding_count: findingCount }),
    created_at: timestamp(row["created_at"]),
    updated_at: timestamp(row["updated_at"]),
    ...(row["closed_at"] === null ? {} : { closed_at: timestamp(row["closed_at"]) }),
  };
}

function toFinding(row: Record<string, unknown>, annotationCount?: number): Finding {
  const createdBy = actorOf(row, "created_by");
  const claimedBy = actorOf(row, "claimed_by");
  return {
    id: row["id"] as string,
    organisation_id: row["organisation_id"] as string,
    project_id: row["project_id"] as string,
    review_id: row["review_id"] as string,
    title: row["title"] as string,
    ...(row["description"] === null ? {} : { description: row["description"] as string }),
    severity: row["severity"] as Finding["severity"],
    status: row["status"] as FindingStatus,
    source: row["source"] as FindingSource,
    version: Number(row["version"]),
    created_by: createdBy ?? { type: "system" },
    url: row["url"] as string,
    viewport: row["viewport"] as Finding["viewport"],
    scroll_position: row["scroll_position"] as Finding["scroll_position"],
    captured_commit: row["captured_commit"] as string,
    screenshot_artefact_id: row["screenshot_artefact_id"] as string,
    ...(row["element_context"] === null || row["element_context"] === undefined
      ? {}
      : { element_context: row["element_context"] as NonNullable<Finding["element_context"]> }),
    ...(row["acceptance_criteria"] === null
      ? {}
      : { acceptance_criteria: row["acceptance_criteria"] as string }),
    ...(claimedBy === undefined ? {} : { claimed_by: claimedBy }),
    ...(annotationCount === undefined ? {} : { annotation_count: annotationCount }),
    created_at: timestamp(row["created_at"]),
    updated_at: timestamp(row["updated_at"]),
  };
}

function toAnnotation(row: Record<string, unknown>): Annotation {
  const createdBy = actorOf(row, "created_by");
  return {
    id: row["id"] as string,
    organisation_id: row["organisation_id"] as string,
    project_id: row["project_id"] as string,
    finding_id: row["finding_id"] as string,
    artefact_id: row["artefact_id"] as string,
    type: row["type"] as AnnotationType,
    geometry: row["geometry"] as Annotation["geometry"],
    label: row["label"] as string,
    ...(row["marker_number"] === null ? {} : { marker_number: Number(row["marker_number"]) }),
    style_hint: row["style_hint"] as NonNullable<Annotation["style_hint"]>,
    revision: Number(row["revision"]),
    created_by: createdBy ?? { type: "system" },
    created_at: timestamp(row["created_at"]),
    ...(row["deleted_at"] === null ? {} : { deleted_at: timestamp(row["deleted_at"]) }),
  };
}

function toComment(row: Record<string, unknown>): Comment {
  const createdBy = actorOf(row, "created_by");
  return {
    id: row["id"] as string,
    organisation_id: row["organisation_id"] as string,
    project_id: row["project_id"] as string,
    review_id: row["review_id"] as string,
    // Absent rather than null for a comment on the review itself: a consumer
    // testing for the key gets the same answer whichever writer produced it.
    ...(row["finding_id"] === null || row["finding_id"] === undefined
      ? {}
      : { finding_id: row["finding_id"] as string }),
    body: row["body"] as string,
    created_by: createdBy ?? { type: "system" },
    revision: Number(row["revision"]),
    ...(row["supersedes_comment_id"] === null || row["supersedes_comment_id"] === undefined
      ? {}
      : { supersedes_comment_id: row["supersedes_comment_id"] as string }),
    ...(row["superseded_at"] === null || row["superseded_at"] === undefined
      ? {}
      : { superseded_at: timestamp(row["superseded_at"]) }),
    created_at: timestamp(row["created_at"]),
  };
}

function toReviewExport(row: Record<string, unknown>): ReviewExport {
  return {
    id: row["id"] as string,
    review_id: row["review_id"] as string,
    status: row["status"] as ReviewExport["status"],
    privacy_mode: row["privacy_mode"] as string,
    artefact_id: (row["artefact_id"] as string | null) ?? null,
    sha256: (row["sha256"] as string | null) ?? null,
    size_bytes: row["size_bytes"] === null ? null : Number(row["size_bytes"]),
    failure_reason: (row["failure_reason"] as string | null) ?? null,
    created_at: timestamp(row["created_at"]),
    completed_at: row["completed_at"] === null ? null : timestamp(row["completed_at"]),
  };
}

function toVerification(
  row: Record<string, unknown>,
  artefactIds: readonly string[],
  beforeArtefactId: string | null,
  afterArtefactId: string | null,
): Verification {
  const submittedBy = actorOf(row, "submitted_by");
  return {
    verification_id: row["id"] as string,
    finding_id: row["finding_id"] as string,
    status: row["status"] as Verification["status"],
    submitted_by: submittedBy ?? { type: "system" },
    summary: row["summary"] as string,
    branch: row["branch"] as string,
    commit: row["commit_sha"] as string,
    ...(beforeArtefactId === null ? {} : { before_artefact_id: beforeArtefactId }),
    ...(afterArtefactId === null ? {} : { after_artefact_id: afterArtefactId }),
    tested_viewports: row["tested_viewports"] as readonly Viewport[],
    checks: row["checks"] as VerificationChecks,
    artefact_ids: [...artefactIds],
    submitted_at: timestamp(row["submitted_at"]),
    ...(row["reviewed_at"] === null || row["reviewed_at"] === undefined
      ? {}
      : { reviewed_at: timestamp(row["reviewed_at"]) }),
    ...(row["supersedes_verification_id"] === null || row["supersedes_verification_id"] === undefined
      ? {}
      : { supersedes_verification_id: row["supersedes_verification_id"] as string }),
    ...(row["superseded_by_verification_id"] === null ||
    row["superseded_by_verification_id"] === undefined
      ? {}
      : { superseded_by_verification_id: row["superseded_by_verification_id"] as string }),
    ...(row["superseded_at"] === null || row["superseded_at"] === undefined
      ? {}
      : { superseded_at: timestamp(row["superseded_at"]) }),
  };
}

/** PostgreSQL's unique-violation class. */
const UNIQUE_VIOLATION = "23505";

/**
 * A refusal that has to be audited after the transaction it happened in has
 * rolled back (`docs/EVENTS.md` section 7).
 *
 * A denied transition writes no state, so it cannot ride along with one. The
 * event still has to exist: the Stage 1 exit criterion is that an agent cannot
 * finally accept a human-authored finding **and that the attempt is audited**,
 * and an attempt with no record is indistinguishable from one that never
 * happened.
 */
interface PendingDenial {
  readonly type: "review.status_change_denied" | "finding.status_change_denied";
  readonly correlation: Record<string, string>;
  readonly payload: Record<string, unknown>;
}

/**
 * An actor as an event payload carries it (`docs/EVENTS.md` section 5).
 *
 * Absent members are dropped rather than written as null, so a consumer testing
 * for `id` gets the same answer whichever writer produced the event.
 */
function eventActor(actor: EventActor): Record<string, unknown> {
  return {
    type: actor.type,
    ...(actor.id === undefined ? {} : { id: actor.id }),
    ...(actor.display === undefined ? {} : { display: actor.display }),
  };
}

/**
 * The source of a finding, derived from the authenticated actor.
 *
 * `docs/DOMAIN_MODEL.md` section 15 decides the acceptance authority rule on
 * this value, so it is computed here and is not a field any request body can
 * carry. A client able to set it could forge a human-authored finding, or
 * relabel its own as an agent's to slip a final disposition past the rule that
 * a human decides. Everything that is not an agent session is recorded as
 * `human`, which is the conservative direction: a finding wrongly labelled
 * human requires a human to close it, and a finding wrongly labelled agent
 * would not.
 */
export function sourceForActor(actorType: EventActor["type"]): FindingSource {
  return actorType === "agent_session" ? "agent" : "human";
}

/**
 * Somewhere to report an audit write this service could not complete.
 *
 * It is the minimum surface Fastify's logger already satisfies, so the server
 * passes `app.log` and nothing has to learn a second logging interface.
 */
export interface ReviewServiceLogger {
  error(fields: Record<string, unknown>, message: string): void;
  /**
   * Optional, because the failures this records are refusals rather than
   * faults. The store detail behind an `ARTEFACT_STORE_UNAVAILABLE` goes here
   * and never into the response: an absolute path or a bucket endpoint in a
   * refusal is deployment data a caller must not receive
   * (`docs/SECURITY.md` section 18).
   */
  warn?(fields: Record<string, unknown>, message: string): void;
}

export class ReviewService {
  readonly #pool: Pool;
  readonly #artefacts: ArtefactService;
  readonly #logger: ReviewServiceLogger | undefined;

  constructor(pool: Pool, artefacts: ArtefactService, logger?: ReviewServiceLogger) {
    this.#pool = pool;
    this.#artefacts = artefacts;
    this.#logger = logger;
  }

  // -----------------------------------------------------------------------
  // Reviews
  // -----------------------------------------------------------------------

  /**
   * Creates a named review.
   *
   * Slug uniqueness is enforced by a partial unique index over active reviews
   * of one project, not by a read-then-write here: two concurrent creations
   * would both see a free name. The index is the enforcement and this is the
   * translation of its refusal into a stable code.
   */
  async createReview(
    scope: Scope,
    input: CreateReviewInput,
    actor: EventActor,
  ): Promise<Review> {
    const status = input.status ?? "DRAFT";
    if (status !== "DRAFT" && status !== "READY") {
      throw new ApiError(
        "POLICY_DENIED",
        "A review is created as DRAFT or READY; every other status is reached by a transition.",
        { field: "status" },
      );
    }
    await this.#requireSessionInProject(scope, input.sourceBrowserSessionId);

    const id = newId("rev_");
    try {
      return await inTransaction(this.#pool, async (client) => {
        const inserted = await client.query(
          `INSERT INTO reviews (
              id, organisation_id, project_id, slug, title, description, status, priority,
              created_by_actor_type, created_by_actor_id, created_by_actor_display,
              captured_branch, captured_commit, captured_workspace_id,
              source_browser_session_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING *`,
          [
            id,
            scope.organisationId,
            scope.projectId,
            input.slug,
            input.title,
            input.description ?? null,
            status,
            input.priority ?? "medium",
            actor.type,
            actor.id ?? null,
            actor.display ?? null,
            input.capturedBranch,
            input.capturedCommit,
            input.capturedWorkspaceId,
            input.sourceBrowserSessionId,
          ],
        );
        const review = toReview(inserted.rows[0] as Record<string, unknown>, 0);
        await appendEvent(client, {
          type: "review.created",
          organisationId: scope.organisationId,
          projectId: scope.projectId,
          actor,
          correlation: {
            review_id: review.id,
            browser_session_id: input.sourceBrowserSessionId,
          },
          payload: { review },
        });
        // Naming is its own event: the slug is the handle an agent is given on
        // a command line, and its history has to be readable.
        await appendEvent(client, {
          type: "review.named",
          organisationId: scope.organisationId,
          projectId: scope.projectId,
          actor,
          correlation: { review_id: review.id },
          payload: { review_id: review.id, slug: review.slug, title: review.title },
        });
        return review;
      });
    } catch (error) {
      throw this.#translateSlugConflict(error, input.slug);
    }
  }

  async getReview(scope: Scope, reviewId: string): Promise<Review> {
    const rows = await this.#pool.query(
      `SELECT r.*, (SELECT count(*) FROM findings f WHERE f.review_id = r.id) AS finding_count
         FROM reviews r
        WHERE r.id = $1 AND r.organisation_id = $2 AND r.project_id = $3`,
      [reviewId, scope.organisationId, scope.projectId],
    );
    const row = rows.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) throw notFound("The review");
    return toReview(row, Number(row["finding_count"]));
  }

  /** Named lookup, which is how an agent reaches `bugs-on-homepage`. */
  async getReviewBySlug(scope: Scope, slug: string): Promise<Review> {
    const rows = await this.#pool.query(
      `SELECT r.*, (SELECT count(*) FROM findings f WHERE f.review_id = r.id) AS finding_count
         FROM reviews r
        WHERE r.slug = $1 AND r.organisation_id = $2 AND r.project_id = $3
          AND r.status = ANY($4)`,
      [slug, scope.organisationId, scope.projectId, [...ACTIVE_REVIEW_STATUSES]],
    );
    const row = rows.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) throw notFound("The review");
    return toReview(row, Number(row["finding_count"]));
  }

  async listReviews(scope: Scope, limit = 50): Promise<Review[]> {
    const page = await this.listReviewsPage(scope, {
      limit: Math.min(Math.max(limit, 1), 200),
      after: null,
    });
    return [...page.items];
  }

  /**
   * One keyset page of reviews, newest first (`docs/API.md` section 6).
   *
   * Newest first because a reviewer opening a project wants what was just
   * captured. The cursor is the previous page's last `(created_at, id)`, which
   * is stable under insertion: a review created while somebody is paging
   * appears at the front rather than shifting the page boundaries and losing a
   * row, which is what an offset would do.
   */
  async listReviewsPage(
    scope: Scope,
    page: PageCursor,
    filter: ReviewListFilter = {},
  ): Promise<RepositoryPage<Review>> {
    const rows = await this.#pool.query(
      `SELECT r.*, (SELECT count(*) FROM findings f WHERE f.review_id = r.id) AS finding_count
         FROM reviews r
        WHERE r.organisation_id = $1 AND r.project_id = $2
          AND ($3::timestamptz IS NULL
               OR (date_trunc('milliseconds', r.created_at), r.id) < ($3::timestamptz, $4::text))
          AND ($6::text[] IS NULL OR r.status = ANY($6))
          AND ($7::text IS NULL OR r.assigned_agent_session_id = $7)
          AND ($8::text IS NULL OR r.slug LIKE $8 || '%')
          AND ($9::timestamptz IS NULL OR r.updated_at >= $9::timestamptz)
        ORDER BY date_trunc('milliseconds', r.created_at) DESC, r.id DESC
        LIMIT $5`,
      [
        scope.organisationId,
        scope.projectId,
        page.after?.sortKey ?? null,
        page.after?.id ?? null,
        page.limit + 1,
        filter.statuses === undefined ? null : [...filter.statuses],
        filter.assignedAgentSessionId ?? null,
        filter.slugPrefix ?? null,
        filter.updatedSince ?? null,
      ],
    );
    const all = rows.rows.map((row) =>
      toReview(
        row as Record<string, unknown>,
        Number((row as Record<string, unknown>)["finding_count"]),
      ),
    );
    const items = all.slice(0, page.limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        all.length > page.limit && last !== undefined
          ? { sortKey: last.created_at, id: last.id }
          : null,
    };
  }

  /**
   * Reviews of **one project** whose title, slug, description or finding text
   * contains a term (`docs/MCP_SPEC.md` section 7.6, `docs/UX_FLOWS.md`
   * section 16).
   *
   * The organisation and the project are the first two terms of the `WHERE`
   * clause and are not derived from anything the caller sent. There is no
   * parameter that could widen the search, which is the form
   * "`review_search` MUST NOT perform cross-project search" has to take: a
   * filter applied after the rows are read is one edit away from being
   * forgotten, and a search is precisely the operation whose whole job is to
   * find rows the caller could not name.
   *
   * The term is matched literally. `%` and `_` in the query are escaped, so a
   * caller cannot turn a search into a scan of everything by sending one
   * character — which would be an unbounded response as well as a surprise.
   *
   * The finding text is matched but never returned: an excerpt would carry
   * page-derived bytes into a list response, and `review_search` answers with
   * which part matched rather than with the matching text.
   */
  async searchReviews(
    scope: Scope,
    query: string,
    limit = 10,
  ): Promise<readonly { review: Review; matched: readonly ReviewSearchField[] }[]> {
    const pattern = `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const rows = await this.#pool.query(
      `SELECT r.*,
              (SELECT count(*) FROM findings f WHERE f.review_id = r.id) AS finding_count,
              (r.title ILIKE $3) AS matched_title,
              (r.slug ILIKE $3) AS matched_slug,
              (r.description IS NOT NULL AND r.description ILIKE $3) AS matched_description,
              EXISTS (
                SELECT 1 FROM findings f
                 WHERE f.review_id = r.id
                   AND (f.title ILIKE $3 OR f.description ILIKE $3)
              ) AS matched_finding
         FROM reviews r
        WHERE r.organisation_id = $1 AND r.project_id = $2
          AND (
            r.title ILIKE $3 OR r.slug ILIKE $3 OR r.description ILIKE $3
            OR EXISTS (
              SELECT 1 FROM findings f
               WHERE f.review_id = r.id
                 AND (f.title ILIKE $3 OR f.description ILIKE $3)
            )
          )
        ORDER BY r.updated_at DESC, r.id DESC
        LIMIT $4`,
      [scope.organisationId, scope.projectId, pattern, Math.min(Math.max(limit, 1), 25)],
    );
    return rows.rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      const matched: ReviewSearchField[] = [];
      if (row["matched_title"] === true) matched.push("title");
      if (row["matched_slug"] === true) matched.push("slug");
      if (row["matched_description"] === true) matched.push("description");
      if (row["matched_finding"] === true) matched.push("finding");
      return {
        review: toReview(row, Number(row["finding_count"])),
        // The predicate above guarantees at least one match, but a row that
        // somehow reported none would violate the result schema's minItems
        // rather than be quietly returned with an empty list.
        matched: matched.length === 0 ? (["title"] as ReviewSearchField[]) : matched,
      };
    });
  }

  async updateReview(
    scope: Scope,
    reviewId: string,
    input: UpdateReviewInput,
    actor: EventActor,
  ): Promise<Review> {
    const fields = (["title", "slug", "description", "priority"] as const).filter(
      (field) => input[field] !== undefined,
    );
    let denied: PendingDenial | null = null;
    try {
      return await inTransaction(this.#pool, async (client) => {
        const current = await this.#lockReview(client, scope, reviewId);
        assertExpectedVersion(current.version, input.expectedVersion, "review");
        assertReviewMutable(current.status, {
          ...(input.status === undefined ? {} : { status: input.status }),
          fields,
        });
        const nextStatus = input.status ?? current.status;
        const changing = nextStatus !== current.status;
        if (changing) {
          // Remembered before any check is raised, for the reason
          // `updateFinding` states: a rolled-back transaction records nothing,
          // and a refusal captured only after the legality check leaves the
          // majority of refusals — `IN_PROGRESS -> ACCEPTED` by an agent among
          // them — with no trail at all.
          denied = {
            type: "review.status_change_denied",
            correlation: { review_id: reviewId },
            payload: {
              review_id: reviewId,
              from: current.status,
              requested: nextStatus,
            },
          };
          // Closing a review is a human decision from any status, so it is
          // refused before the lifecycle is consulted (`docs/API.md` section 12).
          assertActorMayCloseReview(actor.type, nextStatus);
          assertReviewTransition(current.status, nextStatus);
          assertActorMayMoveReview(actor.type, current.status, nextStatus);
          denied = null;
        }

        // Acceptance is the one transition with a precondition beyond the
        // table: `docs/API.md` section 12 requires every human-authored finding
        // to be resolved or explicitly waived first. It is checked here, inside
        // the transaction that holds the review's row lock, so a finding
        // reopened concurrently cannot slip past between the check and the
        // write.
        const accepting = changing && nextStatus === "ACCEPTED";
        const counts = accepting
          ? await this.#assertFindingsPermitAcceptance(client, scope, reviewId)
          : null;
        const reopening = changing && current.status === "ACCEPTED";

        const closed =
          nextStatus === "ACCEPTED" || nextStatus === "CANCELLED" || nextStatus === "ARCHIVED";
        const updated = await client.query(
          `UPDATE reviews
              SET title = COALESCE($4, title),
                  slug = COALESCE($5, slug),
                  description = COALESCE($6, description),
                  priority = COALESCE($9, priority),
                  status = $7,
                  version = version + 1,
                  updated_at = now(),
                  closed_at = CASE WHEN $8 THEN COALESCE(closed_at, now())
                                   WHEN $10 THEN NULL ELSE closed_at END,
                  reopen_count = reopen_count + CASE WHEN $10 THEN 1 ELSE 0 END,
                  accepted_at = CASE WHEN $11 THEN now() WHEN $10 THEN NULL ELSE accepted_at END,
                  accepted_by_actor_type = CASE WHEN $11 THEN $12 WHEN $10 THEN NULL
                                                ELSE accepted_by_actor_type END,
                  accepted_by_actor_id = CASE WHEN $11 THEN $13 WHEN $10 THEN NULL
                                              ELSE accepted_by_actor_id END,
                  accepted_by_actor_display = CASE WHEN $11 THEN $14 WHEN $10 THEN NULL
                                                   ELSE accepted_by_actor_display END
            WHERE id = $1 AND organisation_id = $2 AND project_id = $3
            RETURNING *`,
          [
            reviewId,
            scope.organisationId,
            scope.projectId,
            input.title ?? null,
            input.slug ?? null,
            input.description ?? null,
            nextStatus,
            closed,
            input.priority ?? null,
            reopening,
            accepting,
            accepting ? actor.type : null,
            accepting ? (actor.id ?? null) : null,
            accepting ? (actor.display ?? null) : null,
          ],
        );
        const review = toReview(updated.rows[0] as Record<string, unknown>);
        if (input.slug !== undefined || input.title !== undefined) {
          await appendEvent(client, {
            type: "review.named",
            organisationId: scope.organisationId,
            projectId: scope.projectId,
            actor,
            correlation: { review_id: reviewId },
            payload: {
              review_id: reviewId,
              slug: review.slug,
              title: review.title,
              ...(input.slug === undefined || input.slug === current.slug
                ? {}
                : { previous_slug: current.slug }),
            },
          });
        }
        if (changing) {
          await appendEvent(client, {
            type: "review.status_changed",
            organisationId: scope.organisationId,
            projectId: scope.projectId,
            actor,
            correlation: { review_id: reviewId },
            payload: {
              review_id: reviewId,
              from: current.status,
              to: nextStatus,
              version: review.version,
              ...(input.reason === undefined ? {} : { reason: input.reason }),
            },
          });
        }
        // The decision events sit beside the status change rather than instead
        // of it. A timeline reader needs the movement; an auditor asking who
        // crossed the authority boundary of `AGENTS.md` needs the decision, and
        // a status alone does not carry it (`docs/EVENTS.md` section 7).
        if (accepting && counts !== null) {
          await appendEvent(client, {
            type: "review.accepted",
            organisationId: scope.organisationId,
            projectId: scope.projectId,
            actor,
            correlation: { review_id: reviewId },
            payload: {
              review_id: reviewId,
              accepted_by: eventActor(actor),
              version: review.version,
              finding_count: counts.total,
              human_finding_count: counts.human,
              ...(input.reason === undefined ? {} : { reason: input.reason }),
            },
          });
        }
        if (reopening) {
          await appendEvent(client, {
            type: "review.reopened",
            organisationId: scope.organisationId,
            projectId: scope.projectId,
            actor,
            correlation: { review_id: reviewId },
            payload: {
              review_id: reviewId,
              from: current.status,
              to: nextStatus,
              version: review.version,
              reopen_count: review.reopen_count ?? 1,
              ...(input.reason === undefined ? {} : { reason: input.reason }),
            },
          });
        }
        if (changing && nextStatus === "ARCHIVED") {
          await appendEvent(client, {
            type: "review.archived",
            organisationId: scope.organisationId,
            projectId: scope.projectId,
            actor,
            correlation: { review_id: reviewId },
            payload: {
              review_id: reviewId,
              from: current.status,
              version: review.version,
              ...(input.reason === undefined ? {} : { reason: input.reason }),
            },
          });
        }
        return review;
      });
    } catch (error) {
      await this.#recordDenial(scope, actor, denied, error);
      throw this.#translateSlugConflict(error, input.slug ?? "");
    }
  }

  /**
   * Assigns a review to a human or to an agent session
   * (`docs/API.md` section 12, `docs/EVENTS.md` section 7 `review.assigned`).
   *
   * Assignment is direction, not lifecycle: it says who should do the work and
   * leaves the status saying what stage the work is at. A `READY` review
   * becomes `ASSIGNED` because that is what section 14 means by the word, and a
   * review already under way merely changes hands.
   *
   * It is separate from `review.claimed` on purpose. A human assigning work and
   * a worker taking it are different facts, and an auditor asking "was this
   * given to the agent or did it take it?" needs both recorded.
   */
  async assignReview(
    scope: Scope,
    reviewId: string,
    input: AssignReviewInput,
    actor: EventActor,
  ): Promise<Review> {
    if (input.assignedUserId !== undefined && input.assignedAgentSessionId !== undefined) {
      throw new ApiError(
        "UNSUPPORTED_CAPABILITY",
        "A review is assigned to a human or to an agent session, not to both: an assignment held by two principals does not answer the question it exists to answer.",
        { field: "assigned_agent_session_id" },
      );
    }
    if (input.assignedUserId !== undefined) {
      await this.#requireUserInOrganisation(scope, input.assignedUserId);
    }
    if (input.assignedAgentSessionId !== undefined) {
      await this.#requireAgentSessionInProject(scope, input.assignedAgentSessionId);
    }

    return inTransaction(this.#pool, async (client) => {
      const current = await this.#lockReview(client, scope, reviewId);
      assertExpectedVersion(current.version, input.expectedVersion, "review");
      assertReviewMutable(current.status, { fields: ["assigned_to"] });
      const nextStatus = current.status === "READY" ? "ASSIGNED" : current.status;
      if (nextStatus !== current.status) {
        assertReviewTransition(current.status, nextStatus);
        assertActorMayMoveReview(actor.type, current.status, nextStatus);
      }

      const updated = await client.query(
        `UPDATE reviews
            SET assigned_user_id = $4,
                assigned_agent_session_id = $5,
                status = $6,
                version = version + 1,
                updated_at = now()
          WHERE id = $1 AND organisation_id = $2 AND project_id = $3
          RETURNING *`,
        [
          reviewId,
          scope.organisationId,
          scope.projectId,
          input.assignedUserId ?? null,
          input.assignedAgentSessionId ?? null,
          nextStatus,
        ],
      );
      const review = toReview(updated.rows[0] as Record<string, unknown>);
      await appendEvent(client, {
        type: "review.assigned",
        organisationId: scope.organisationId,
        projectId: scope.projectId,
        actor,
        correlation: {
          review_id: reviewId,
          ...(input.assignedAgentSessionId === undefined
            ? {}
            : { agent_session_id: input.assignedAgentSessionId }),
        },
        payload: {
          review_id: reviewId,
          ...(input.assignedUserId === undefined
            ? {}
            : { assigned_user_id: input.assignedUserId }),
          ...(input.assignedAgentSessionId === undefined
            ? {}
            : { assigned_agent_session_id: input.assignedAgentSessionId }),
          ...(current.assignedUserId === null
            ? {}
            : { previous_assigned_user_id: current.assignedUserId }),
          ...(current.assignedAgentSessionId === null
            ? {}
            : { previous_assigned_agent_session_id: current.assignedAgentSessionId }),
          version: review.version,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
      });
      if (nextStatus !== current.status) {
        await appendEvent(client, {
          type: "review.status_changed",
          organisationId: scope.organisationId,
          projectId: scope.projectId,
          actor,
          correlation: { review_id: reviewId },
          payload: {
            review_id: reviewId,
            from: current.status,
            to: nextStatus,
            version: review.version,
            reason: "assigned",
          },
        });
      }

      // The delivery, in the same transaction as the assignment. An assignment
      // that committed without one would be work a human believes they handed
      // over and an agent has no way to discover (`docs/DOMAIN_MODEL.md`
      // section 21). Assigning to nobody delivers nothing: there is no
      // recipient to deliver to.
      const recipient =
        input.assignedAgentSessionId !== undefined
          ? ({ type: "agent_session" as const, id: input.assignedAgentSessionId })
          : input.assignedUserId !== undefined
            ? ({ type: "human_user" as const, id: input.assignedUserId })
            : null;
      if (recipient !== null) {
        const findingCount = await client.query<{ count: string }>(
          "SELECT count(*) AS count FROM findings WHERE review_id = $1",
          [reviewId],
        );
        await InboxStore.create(
          client,
          {
            organisationId: scope.organisationId,
            projectId: scope.projectId,
            recipientType: recipient.type,
            recipientId: recipient.id,
            type: "review_assigned",
            title: review.title,
            reviewId,
            reviewSlug: review.slug,
            priority: review.priority ?? null,
            findingCount: Number(findingCount.rows[0]?.count ?? 0),
          },
          actor,
        );
      }
      return review;
    });
  }

  /**
   * The four lifecycle routes of `docs/API.md` section 12.
   *
   * Each is `updateReview` with the target status fixed by the route rather
   * than named in the body, so a caller cannot ask one route for another's
   * transition — and, more importantly, so there is exactly one code path that
   * checks a version, checks legality, checks authority and writes the event.
   * A second implementation of "accept a review" is a second place for the
   * authority rule to be got wrong.
   */
  async requestHumanReview(
    scope: Scope,
    reviewId: string,
    input: ReviewTransitionInput,
    actor: EventActor,
  ): Promise<Review> {
    return this.updateReview(
      scope,
      reviewId,
      { ...input, status: "AWAITING_HUMAN_REVIEW" },
      actor,
    );
  }

  async acceptReview(
    scope: Scope,
    reviewId: string,
    input: ReviewTransitionInput,
    actor: EventActor,
  ): Promise<Review> {
    return this.updateReview(scope, reviewId, { ...input, status: "ACCEPTED" }, actor);
  }

  /**
   * Reopens a review. From `ACCEPTED` this is the explicit reopen of
   * `docs/DOMAIN_MODEL.md` section 14 and records `review.reopened`; from any
   * other status it is the ordinary move to `CHANGES_REQUESTED`.
   *
   * Nothing is discarded either way. The findings, their verifications, the
   * comments and every event stay exactly where they were; the review simply
   * becomes writable again, and `reopen_count` says how many times that has
   * happened.
   */
  async reopenReview(
    scope: Scope,
    reviewId: string,
    input: ReviewTransitionInput,
    actor: EventActor,
  ): Promise<Review> {
    return this.updateReview(
      scope,
      reviewId,
      { ...input, status: "CHANGES_REQUESTED" },
      actor,
    );
  }

  async archiveReview(
    scope: Scope,
    reviewId: string,
    input: ReviewTransitionInput,
    actor: EventActor,
  ): Promise<Review> {
    return this.updateReview(scope, reviewId, { ...input, status: "ARCHIVED" }, actor);
  }

  // -----------------------------------------------------------------------
  // Findings
  // -----------------------------------------------------------------------

  /**
   * Creates a finding, with its annotations, in one transaction.
   *
   * A finding and the geometry that explains it are written together on
   * purpose: a finding whose annotation failed to save would be a mark nobody
   * can find, and a partial success is the one outcome a human reviewer cannot
   * detect by looking.
   */
  async createFinding(
    scope: Scope,
    reviewId: string,
    input: CreateFindingInput,
    actor: EventActor,
  ): Promise<{ finding: Finding; annotations: Annotation[] }> {
    assertCapturedContext({
      url: input.url,
      viewport: input.viewport,
      scroll_position: input.scrollPosition,
      captured_commit: input.capturedCommit,
      screenshot_artefact_id: input.screenshotArtefactId,
    });
    for (const annotation of input.annotations ?? []) {
      assertGeometry(annotation.type, annotation.geometry);
    }

    const review = await this.getReview(scope, reviewId);
    assertReviewMutable(review.status, { fields: ["findings"] });
    const artefact = await this.#requireAvailableArtefact(scope, input.screenshotArtefactId);
    for (const annotation of input.annotations ?? []) {
      if (annotation.artefactId !== artefact.id) {
        throw new ApiError(
          "UNSUPPORTED_CAPABILITY",
          "An annotation must be placed on the finding's own screenshot artefact.",
          { field: "annotations" },
        );
      }
    }

    const id = newId("fin_");
    return inTransaction(this.#pool, async (client) => {
      const inserted = await client.query(
        `INSERT INTO findings (
            id, organisation_id, project_id, review_id, title, description, severity,
            source, created_by_actor_type, created_by_actor_id, created_by_actor_display,
            url, viewport, scroll_position, captured_commit, screenshot_artefact_id,
            element_context, acceptance_criteria
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING *`,
        [
          id,
          scope.organisationId,
          scope.projectId,
          reviewId,
          input.title,
          input.description ?? null,
          input.severity,
          // Never `input.source`: there is no such field, because the authority
          // rule of `docs/DOMAIN_MODEL.md` section 15 is decided on this value.
          sourceForActor(actor.type),
          actor.type,
          actor.id ?? null,
          actor.display ?? null,
          input.url,
          JSON.stringify(input.viewport),
          JSON.stringify(input.scrollPosition),
          input.capturedCommit,
          input.screenshotArtefactId,
          input.elementContext === undefined ? null : JSON.stringify(input.elementContext),
          input.acceptanceCriteria ?? null,
        ],
      );
      const annotations: Annotation[] = [];
      for (const request of input.annotations ?? []) {
        annotations.push(await this.#insertAnnotation(client, scope, id, request, actor));
      }
      const finding = toFinding(
        inserted.rows[0] as Record<string, unknown>,
        annotations.length,
      );
      await appendEvent(client, {
        type: "finding.created",
        organisationId: scope.organisationId,
        projectId: scope.projectId,
        actor,
        correlation: {
          review_id: reviewId,
          finding_id: finding.id,
          artefact_id: input.screenshotArtefactId,
        },
        payload: { finding },
      });
      for (const annotation of annotations) {
        await appendEvent(client, {
          type: "finding.annotated",
          organisationId: scope.organisationId,
          projectId: scope.projectId,
          actor,
          correlation: {
            review_id: reviewId,
            finding_id: finding.id,
            annotation_id: annotation.id,
            artefact_id: annotation.artefact_id,
          },
          payload: { annotation },
        });
      }
      return { finding, annotations };
    });
  }

  async getFinding(scope: Scope, findingId: string): Promise<Finding> {
    const rows = await this.#pool.query(
      `SELECT f.*, (SELECT count(*) FROM annotations_current a
                     WHERE a.finding_id = f.id AND a.deleted_at IS NULL) AS annotation_count
         FROM findings f
        WHERE f.id = $1 AND f.organisation_id = $2 AND f.project_id = $3`,
      [findingId, scope.organisationId, scope.projectId],
    );
    const row = rows.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) throw notFound("The finding");
    return toFinding(row, Number(row["annotation_count"]));
  }

  async listFindings(scope: Scope, reviewId: string): Promise<Finding[]> {
    // The review lookup is what applies the tenant filter to the list.
    await this.getReview(scope, reviewId);
    const rows = await this.#pool.query(
      `SELECT f.*, (SELECT count(*) FROM annotations_current a
                     WHERE a.finding_id = f.id AND a.deleted_at IS NULL) AS annotation_count
         FROM findings f
        WHERE f.review_id = $1 AND f.organisation_id = $2 AND f.project_id = $3
        ORDER BY f.created_at`,
      [reviewId, scope.organisationId, scope.projectId],
    );
    return rows.rows.map((row) =>
      toFinding(row as Record<string, unknown>, Number((row as Record<string, unknown>)["annotation_count"])),
    );
  }

  /**
   * Updates a finding, including its status.
   *
   * The order is the point: version, then transition legality, then who is
   * allowed to make it, then whether a completion claim carries evidence.
   * Nothing is written until all four agree.
   */
  async updateFinding(
    scope: Scope,
    findingId: string,
    input: UpdateFindingInput,
    actor: EventActor,
  ): Promise<Finding> {
    let denied: PendingDenial | null = null;
    try {
      return await inTransaction(this.#pool, async (client) => {
      const current = await this.#lockFinding(client, scope, findingId);
      assertExpectedVersion(current.version, input.expectedVersion, "finding");
      const nextStatus = input.status ?? current.status;
      if (nextStatus !== current.status) {
        // Remembered before **any** check is raised, because every refusal of a
        // requested transition is a fact worth auditing and the transaction
        // that would have carried the event is about to roll back. Capturing it
        // after the legality check — as this did until the RVP-37 review — left
        // the majority of refusals unrecorded, including the one that matters
        // most: an agent that had actually claimed the work asking to resolve
        // it. The payload carries the refusal's own code, so it says which
        // class of refusal it was rather than needing one flag per class.
        denied = {
          type: "finding.status_change_denied",
          correlation: { review_id: current.review_id, finding_id: findingId },
          payload: {
            finding_id: findingId,
            review_id: current.review_id,
            from: current.status,
            requested: nextStatus,
            source: current.source,
          },
        };
        // The order is the rule (`docs/API.md` section 13). A final disposition
        // is a human decision from any status, so it is refused before the
        // lifecycle is consulted: otherwise the answer would depend on where the
        // finding happened to be, and an agent asking to resolve a finding it
        // had claimed would be told the move was impossible rather than that the
        // decision was not its to make.
        assertActorMayDispose(actor.type, current.source, nextStatus);
        assertFindingTransition(current.status, nextStatus);
        assertActorMayMoveFinding(actor.type, current.source, current.status, nextStatus);
        denied = null;
        // The evidence gate runs last, as `docs/API.md` section 13 orders the
        // checks: version, disposition authority, transition legality, actor
        // authority, then completion evidence. `missing` is computed only for
        // the transition that needs it — an extra read on every claim and every
        // block would be paid for nothing.
        const missing =
          nextStatus === "AWAITING_HUMAN_REVIEW" && actor.type === "agent_session"
            ? await this.#missingEvidenceOn(client, scope, findingId)
            : undefined;
        // `denied` is re-armed for the evidence refusal: this is a refused
        // transition like any other, and `docs/DOMAIN_MODEL.md` section 15 says
        // **every** refusal is audited, not only the authority ones. Leaving it
        // null here would have made the one refusal this issue adds the one
        // refusal nothing recorded — the exact defect the reserved-status audit
        // path was built to close.
        if (missing !== undefined && missing.length > 0) {
          denied = {
            type: "finding.status_change_denied",
            correlation: { review_id: current.review_id, finding_id: findingId },
            payload: {
              finding_id: findingId,
              review_id: current.review_id,
              from: current.status,
              requested: nextStatus,
              source: current.source,
            },
          };
        }
        assertCompletionEvidence(nextStatus, {
          resolutionNote: input.resolutionNote ?? current.resolution_note ?? undefined,
          actorType: actor.type,
          ...(missing === undefined ? {} : { missing }),
        });
        denied = null;
      }

      const claiming = nextStatus === "CLAIMED" && current.status !== "CLAIMED";
      const disposing = nextStatus !== current.status && isFinalDisposition(nextStatus);
      const reopening = nextStatus === "REOPENED" && current.status !== "REOPENED";
      if (input.duplicateOfFindingId !== undefined) {
        await this.#requireFindingInProject(scope, input.duplicateOfFindingId, findingId);
      }
      const verificationCount = reopening
        ? await this.#countVerificationsOn(client, scope, findingId)
        : 0;

      const updated = await client.query(
        `UPDATE findings
            SET title = COALESCE($4, title),
                description = COALESCE($5, description),
                severity = COALESCE($6, severity),
                acceptance_criteria = COALESCE($7, acceptance_criteria),
                resolution_note = COALESCE($8, resolution_note),
                status = $9,
                version = version + 1,
                updated_at = now(),
                claimed_by_actor_type = CASE WHEN $10 THEN $11 ELSE claimed_by_actor_type END,
                claimed_by_actor_id = CASE WHEN $10 THEN $12 ELSE claimed_by_actor_id END,
                claimed_by_actor_display = CASE WHEN $10 THEN $13 ELSE claimed_by_actor_display END,
                resolved_at = CASE WHEN $14 THEN now() WHEN $15 THEN NULL ELSE resolved_at END,
                resolved_by_actor_type = CASE WHEN $14 THEN $11 WHEN $15 THEN NULL
                                              ELSE resolved_by_actor_type END,
                resolved_by_actor_id = CASE WHEN $14 THEN $12 WHEN $15 THEN NULL
                                            ELSE resolved_by_actor_id END,
                resolved_by_actor_display = CASE WHEN $14 THEN $13 WHEN $15 THEN NULL
                                                 ELSE resolved_by_actor_display END,
                disposition_reason = CASE WHEN $14 THEN $16 WHEN $15 THEN NULL
                                          ELSE disposition_reason END,
                duplicate_of_finding_id = CASE WHEN $14 THEN $17 WHEN $15 THEN NULL
                                               ELSE duplicate_of_finding_id END,
                reopen_count = reopen_count + CASE WHEN $15 THEN 1 ELSE 0 END
          WHERE id = $1 AND organisation_id = $2 AND project_id = $3
          RETURNING *`,
        [
          findingId,
          scope.organisationId,
          scope.projectId,
          input.title ?? null,
          input.description ?? null,
          input.severity ?? null,
          input.acceptanceCriteria ?? null,
          input.resolutionNote ?? null,
          nextStatus,
          claiming,
          actor.type,
          actor.id ?? null,
          actor.display ?? null,
          disposing,
          reopening,
          input.reason ?? null,
          input.duplicateOfFindingId ?? null,
        ],
      );
      const finding = toFinding(updated.rows[0] as Record<string, unknown>);
      if (claiming) {
        // Separate from the status change: a claim says *who* is working, and
        // the status says what stage the work is at. A human reading the
        // timeline needs both facts and they are not the same fact.
        await appendEvent(client, {
          type: "finding.claimed",
          organisationId: scope.organisationId,
          projectId: scope.projectId,
          actor,
          correlation: { review_id: finding.review_id, finding_id: findingId },
          payload: {
            finding_id: findingId,
            review_id: finding.review_id,
            claimed_by: eventActor(actor),
            version: finding.version,
          },
        });
      }
      if (nextStatus !== current.status) {
        await appendEvent(client, {
          type: "finding.status_changed",
          organisationId: scope.organisationId,
          projectId: scope.projectId,
          actor,
          correlation: { review_id: finding.review_id, finding_id: findingId },
          payload: {
            finding_id: findingId,
            review_id: finding.review_id,
            from: current.status,
            to: nextStatus,
            version: finding.version,
            source: current.source,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          },
        });
      }
      // The decision events. `finding.status_changed` says the finding moved;
      // these say a human decided, and `docs/EVENTS.md` section 7 lists them
      // separately because an auditor looking for the authority boundary of
      // `AGENTS.md` should not have to match on a status value to find it.
      if (disposing) {
        await appendEvent(client, {
          type: "finding.resolved",
          organisationId: scope.organisationId,
          projectId: scope.projectId,
          actor,
          correlation: { review_id: finding.review_id, finding_id: findingId },
          payload: {
            finding_id: findingId,
            review_id: finding.review_id,
            disposition: nextStatus,
            source: current.source,
            decided_by: eventActor(actor),
            version: finding.version,
            ...(input.duplicateOfFindingId === undefined
              ? {}
              : { duplicate_of_finding_id: input.duplicateOfFindingId }),
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          },
        });
      }
      if (reopening) {
        await appendEvent(client, {
          type: "finding.reopened",
          organisationId: scope.organisationId,
          projectId: scope.projectId,
          actor,
          correlation: { review_id: finding.review_id, finding_id: findingId },
          payload: {
            finding_id: findingId,
            review_id: finding.review_id,
            from: current.status,
            version: finding.version,
            // Reopening preserves prior verification history rather than
            // discarding it (`docs/DOMAIN_MODEL.md` section 15). The count says
            // what was kept, so a reader is not left to assume a fresh start.
            verification_count: verificationCount,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          },
        });
        // A reopen is new work for whoever holds the review, and it is
        // delivered in the same transaction as the reopen itself
        // (`docs/UX_FLOWS.md` section 13, `docs/DOMAIN_MODEL.md` section 21).
        // Where nobody holds it the item is addressed to the project's agents
        // with no recipient identifier, so the next session to look finds it
        // rather than the work waiting for a session that never returns.
        const review = await client.query<{
          title: string;
          slug: string;
          priority: string | null;
          assigned_user_id: string | null;
          assigned_agent_session_id: string | null;
        }>(
          `SELECT title, slug, priority, assigned_user_id, assigned_agent_session_id
             FROM reviews WHERE id = $1 AND organisation_id = $2 AND project_id = $3`,
          [finding.review_id, scope.organisationId, scope.projectId],
        );
        const holder = review.rows[0];
        if (holder !== undefined) {
          await InboxStore.create(
            client,
            {
              organisationId: scope.organisationId,
              projectId: scope.projectId,
              recipientType:
                holder.assigned_user_id !== null && holder.assigned_agent_session_id === null
                  ? "human_user"
                  : "agent_session",
              recipientId:
                holder.assigned_agent_session_id ?? holder.assigned_user_id ?? null,
              type: "finding_reopened",
              title: finding.title,
              reviewId: finding.review_id,
              findingId,
              reviewSlug: holder.slug,
              priority: holder.priority,
              // The title above is this finding's title, so who authored the
              // finding decides how a response carrying it may be labelled.
              findingSource: finding.source,
            },
            actor,
          );
        }
      }
      return finding;
      });
    } catch (error) {
      await this.#recordDenial(scope, actor, denied, error);
      throw error;
    }
  }

  /**
   * Claims one finding (`docs/API.md` section 13,
   * `docs/MCP_SPEC.md` section 7.7).
   *
   * The claim is an ordinary optimistic-concurrency write, which is the point:
   * a human and an agent claiming the same finding at once produce one claim
   * and one `VERSION_CONFLICT` carrying the version the record actually holds,
   * rather than two writes where the second silently wins.
   */
  async claimFinding(
    scope: Scope,
    findingId: string,
    expectedVersion: number,
    actor: EventActor,
  ): Promise<Finding> {
    return this.updateFinding(scope, findingId, { expectedVersion, status: "CLAIMED" }, actor);
  }

  /**
   * A human's final decision about one finding: accept it as resolved, waive it
   * as `WONT_FIX`, or mark it a duplicate (`docs/API.md` section 13).
   *
   * The authority check is not here. It is in `assertActorMayMoveFinding`,
   * which `updateFinding` calls, so an agent credential reaching this method by
   * any route — HTTP, MCP or a future internal job — is refused by the same
   * rule. Putting the check on this method instead would make the refusal a
   * property of the entry point rather than of the domain.
   */
  async disposeFinding(
    scope: Scope,
    findingId: string,
    disposition: FindingStatus,
    input: DisposeFindingInput,
    actor: EventActor,
  ): Promise<Finding> {
    if (disposition === "WONT_FIX" && (input.reason ?? "").trim() === "") {
      throw new ApiError(
        "EVIDENCE_REQUIRED",
        "Waiving a reported problem requires a reason: a decision nobody can read later is not one anybody can review.",
        { field: "reason", required_evidence: ["reason"] },
      );
    }
    if (disposition === "DUPLICATE" && input.duplicateOfFindingId === undefined) {
      throw new ApiError(
        "UNSUPPORTED_CAPABILITY",
        "A duplicate must name the finding it duplicates.",
        { field: "duplicate_of_finding_id" },
      );
    }
    return this.updateFinding(
      scope,
      findingId,
      {
        expectedVersion: input.expectedVersion,
        status: disposition,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.duplicateOfFindingId === undefined
          ? {}
          : { duplicateOfFindingId: input.duplicateOfFindingId }),
      },
      actor,
    );
  }

  /** Reopens a finding. Prior verification history is retained, not cleared. */
  async reopenFinding(
    scope: Scope,
    findingId: string,
    input: ReviewTransitionInput,
    actor: EventActor,
  ): Promise<Finding> {
    return this.updateFinding(
      scope,
      findingId,
      {
        expectedVersion: input.expectedVersion,
        status: "REOPENED",
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      },
      actor,
    );
  }

  /**
   * Claims a review for an actor (`docs/MCP_SPEC.md` section 7.6,
   * `docs/EVENTS.md` section 7 `review.claimed`).
   *
   * A claim is assignment, not a lifecycle change: a READY review becomes
   * ASSIGNED because that is what "somebody is on it" means in
   * `docs/DOMAIN_MODEL.md` section 14, and a review already in progress keeps
   * its status and merely changes hands.
   */
  async claimReview(
    scope: Scope,
    reviewId: string,
    expectedVersion: number,
    actor: EventActor,
  ): Promise<Review> {
    return inTransaction(this.#pool, async (client) => {
      const current = await this.#lockReview(client, scope, reviewId);
      assertExpectedVersion(current.version, expectedVersion, "review");
      assertReviewMutable(current.status, { fields: ["claimed_by"] });
      const nextStatus = current.status === "READY" ? "ASSIGNED" : current.status;
      if (nextStatus !== current.status) {
        assertReviewTransition(current.status, nextStatus);
        // Authority as well as legality. A claim moves the review, and a move
        // an actor may not make is not made lawful by the route it arrived on
        // (ADR-0024). It is permitted today only because `READY -> ASSIGNED`
        // names `agent_session` in the table, which is exactly the fact this
        // call checks rather than assumes.
        assertActorMayMoveReview(actor.type, current.status, nextStatus);
      }

      const updated = await client.query(
        `UPDATE reviews
            SET assigned_agent_session_id = $4,
                status = $5,
                version = version + 1,
                updated_at = now()
          WHERE id = $1 AND organisation_id = $2 AND project_id = $3
          RETURNING *`,
        [
          reviewId,
          scope.organisationId,
          scope.projectId,
          actor.type === "agent_session" ? (actor.id ?? null) : null,
          nextStatus,
        ],
      );
      const review = toReview(updated.rows[0] as Record<string, unknown>);
      await appendEvent(client, {
        type: "review.claimed",
        organisationId: scope.organisationId,
        projectId: scope.projectId,
        actor,
        correlation: {
          review_id: reviewId,
          ...(actor.type === "agent_session" && actor.id !== undefined
            ? { agent_session_id: actor.id }
            : {}),
        },
        payload: {
          review_id: reviewId,
          claimed_by: {
            type: actor.type,
            ...(actor.id === undefined ? {} : { id: actor.id }),
            ...(actor.display === undefined ? {} : { display: actor.display }),
          },
          version: review.version,
        },
      });
      if (nextStatus !== current.status) {
        await appendEvent(client, {
          type: "review.status_changed",
          organisationId: scope.organisationId,
          projectId: scope.projectId,
          actor,
          correlation: { review_id: reviewId },
          payload: {
            review_id: reviewId,
            from: current.status,
            to: nextStatus,
            version: review.version,
          },
        });
      }
      return review;
    });
  }

  /**
   * One bounded page of findings, oldest first (`docs/MCP_SPEC.md` section 13).
   *
   * Oldest first because a human recorded them in an order and an agent should
   * work them in it. The cursor is the previous page's last `(created_at, id)`,
   * which is stable under insertion: a finding added while an agent is paging
   * appears at the end rather than shifting the page boundaries.
   */
  async listFindingsPage(
    scope: Scope,
    reviewId: string,
    page: { readonly limit: number; readonly cursor?: { createdAt: string; id: string } },
  ): Promise<{ findings: Finding[]; nextCursor: { createdAt: string; id: string } | null }> {
    await this.getReview(scope, reviewId);
    const limit = Math.min(Math.max(page.limit, 1), 50);
    const rows = await this.#pool.query(
      `SELECT f.*, (SELECT count(*) FROM annotations_current a
                     WHERE a.finding_id = f.id AND a.deleted_at IS NULL) AS annotation_count
         FROM findings f
        WHERE f.review_id = $1 AND f.organisation_id = $2 AND f.project_id = $3
          AND ($4::timestamptz IS NULL
               OR (date_trunc('milliseconds', f.created_at), f.id) > ($4::timestamptz, $5::text))
        ORDER BY date_trunc('milliseconds', f.created_at), f.id
        LIMIT $6`,
      [
        reviewId,
        scope.organisationId,
        scope.projectId,
        page.cursor?.createdAt ?? null,
        page.cursor?.id ?? null,
        limit + 1,
      ],
    );
    const all = rows.rows.map((row) =>
      toFinding(
        row as Record<string, unknown>,
        Number((row as Record<string, unknown>)["annotation_count"]),
      ),
    );
    const findings = all.slice(0, limit);
    const last = findings[findings.length - 1];
    return {
      findings,
      nextCursor:
        all.length > limit && last !== undefined
          ? { createdAt: last.created_at, id: last.id }
          : null,
    };
  }

  // -----------------------------------------------------------------------
  // Comments and verification
  // -----------------------------------------------------------------------

  /**
   * Appends a comment to a finding (`docs/DOMAIN_MODEL.md` section 18).
   *
   * Comments are append-only and the actor type is always explicit, so a reader
   * can tell an agent's note from a human's without reading the wording.
   */
  async addComment(
    scope: Scope,
    findingId: string,
    body: string,
    actor: EventActor,
  ): Promise<Comment> {
    const finding = await this.getFinding(scope, findingId);
    return this.#insertComment(scope, finding.review_id, findingId, body, null, actor);
  }

  /**
   * Appends a comment to the review itself
   * (`docs/DOMAIN_MODEL.md` section 18, `docs/API.md` section 12).
   *
   * A closed review still takes comments. Section 14 makes an accepted review
   * immutable "except for archival metadata and comments", and the exception is
   * the point: discussion of a decision has to outlive the decision, or the
   * only way to say something about an accepted review is to reopen it.
   */
  async addReviewComment(
    scope: Scope,
    reviewId: string,
    body: string,
    actor: EventActor,
  ): Promise<Comment> {
    await this.getReview(scope, reviewId);
    return this.#insertComment(scope, reviewId, null, body, null, actor);
  }

  /**
   * Edits a comment (`docs/DOMAIN_MODEL.md` section 18: "Comments are
   * append-only. Editing creates a new revision and retains history").
   *
   * The edit inserts a new row carrying `supersedes_comment_id` and stamps the
   * row it replaces with `superseded_at`. Nothing overwrites a body, so the
   * text a reader acted on is still readable after the author changed their
   * mind — which matters most for the comments that are instructions.
   *
   * Only the author may edit, and only the current revision may be edited. The
   * first rule is what stops attribution being laundered: an edit by somebody
   * else would appear over the original author's name. The second is what stops
   * the history forking, and it is enforced by a unique index as well, so two
   * concurrent edits produce one revision and one refusal.
   */
  async editComment(
    scope: Scope,
    commentId: string,
    body: string,
    actor: EventActor,
  ): Promise<Comment> {
    const existing = await this.#pool.query<Record<string, unknown>>(
      `SELECT * FROM comments
        WHERE id = $1 AND organisation_id = $2 AND project_id = $3`,
      [commentId, scope.organisationId, scope.projectId],
    );
    const row = existing.rows[0];
    if (row === undefined) throw notFound("The comment");
    const current = toComment(row);
    if (current.superseded_at !== undefined) {
      throw new ApiError(
        "VERSION_CONFLICT",
        "This revision has already been superseded. Edit the current revision.",
        { current_version: current.revision + 1 },
      );
    }
    if (
      current.created_by.type !== actor.type ||
      (current.created_by.id ?? null) !== (actor.id ?? null)
    ) {
      // Attribution is non-forgeable, and an edit by another actor over the
      // original author's name is exactly the forgery this prevents.
      throw new ApiError(
        "AUTHORISATION_DENIED",
        "A comment may only be edited by the actor that wrote it.",
        { field: "body" },
      );
    }
    return this.#insertComment(
      scope,
      current.review_id,
      current.finding_id ?? null,
      body,
      current,
      actor,
    );
  }

  /** The current revision of every comment on a finding, oldest first. */
  async listComments(scope: Scope, findingId: string, limit = 20): Promise<Comment[]> {
    await this.getFinding(scope, findingId);
    const rows = await this.#pool.query(
      `SELECT * FROM comments
        WHERE finding_id = $1 AND organisation_id = $2 AND project_id = $3
          AND superseded_at IS NULL
        ORDER BY created_at, id
        LIMIT $4`,
      [findingId, scope.organisationId, scope.projectId, Math.min(Math.max(limit, 1), 20)],
    );
    return rows.rows.map((row) => toComment(row as Record<string, unknown>));
  }

  /**
   * One keyset page of the current comments on a review or a finding, oldest
   * first (`docs/API.md` section 6, `docs/MCP_SPEC.md` section 13).
   *
   * `listComments` and `listCommentsFor` both cap a page and neither offers a
   * way to reach the next one, which is a bound rather than pagination: an
   * agent handed the first twenty comments of a long discussion had no way to
   * read the twenty-first. The cursor is `(created_at, id)` for the reason the
   * review listing gives — it is stable under insertion, and a comment added
   * while somebody is paging appears at the end rather than shifting the page
   * boundaries.
   *
   * Superseded revisions are excluded, so the page is the current text. The
   * history is still readable through `listCommentsFor` with
   * `revisions: "all"`, which is where a reader judging a changed instruction
   * goes.
   */
  async listCommentsPage(
    scope: Scope,
    target: { readonly reviewId: string; readonly findingId?: string },
    page: { readonly limit?: number; readonly cursor?: { createdAt: string; id: string } } = {},
  ): Promise<{ comments: readonly Comment[]; nextCursor: { createdAt: string; id: string } | null }> {
    const limit = Math.min(Math.max(page.limit ?? 20, 1), 50);
    const rows = await this.#pool.query(
      `SELECT * FROM comments
        WHERE organisation_id = $1 AND project_id = $2 AND review_id = $3
          AND ($4::text IS NULL OR finding_id = $4)
          AND ($4::text IS NOT NULL OR finding_id IS NULL)
          AND superseded_at IS NULL
          AND ($5::timestamptz IS NULL
               OR (date_trunc('milliseconds', created_at), id) > ($5::timestamptz, $6::text))
        ORDER BY date_trunc('milliseconds', created_at), id
        LIMIT $7`,
      [
        scope.organisationId,
        scope.projectId,
        target.reviewId,
        target.findingId ?? null,
        page.cursor?.createdAt ?? null,
        page.cursor?.id ?? null,
        limit + 1,
      ],
    );
    const all = rows.rows.map((row) => toComment(row as Record<string, unknown>));
    const comments = all.slice(0, limit);
    const last = comments[comments.length - 1];
    return {
      comments,
      nextCursor:
        all.length > limit && last !== undefined
          ? { createdAt: last.created_at, id: last.id }
          : null,
    };
  }

  /**
   * Comments on a review or a finding, current projection or full history.
   *
   * `revisions: "all"` returns superseded revisions too, because the history is
   * retained rather than overwritten and a reader judging a changed instruction
   * needs what it said before.
   */
  async listCommentsFor(
    scope: Scope,
    target: { readonly reviewId: string; readonly findingId?: string },
    options: { readonly limit?: number; readonly revisions?: "current" | "all" } = {},
  ): Promise<Comment[]> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const rows = await this.#pool.query(
      `SELECT * FROM comments
        WHERE organisation_id = $1 AND project_id = $2 AND review_id = $3
          AND ($4::text IS NULL OR finding_id = $4)
          AND ($4::text IS NOT NULL OR finding_id IS NULL)
          AND ($5::boolean OR superseded_at IS NULL)
        ORDER BY created_at, id
        LIMIT $6`,
      [
        scope.organisationId,
        scope.projectId,
        target.reviewId,
        target.findingId ?? null,
        options.revisions === "all",
        limit,
      ],
    );
    return rows.rows.map((row) => toComment(row as Record<string, unknown>));
  }

  /**
   * Writes one comment revision and its event, in one transaction.
   *
   * `previous` is the revision this one replaces, or null for an original. The
   * two cases share a path because they are the same write: an edit is an
   * append with a back-reference, not a different kind of operation.
   */
  async #insertComment(
    scope: Scope,
    reviewId: string,
    findingId: string | null,
    body: string,
    previous: Comment | null,
    actor: EventActor,
  ): Promise<Comment> {
    const id = newId("cmt_");
    return inTransaction(this.#pool, async (client) => {
      if (previous !== null) {
        const superseded = await client.query(
          `UPDATE comments SET superseded_at = now()
            WHERE id = $1 AND organisation_id = $2 AND project_id = $3
              AND superseded_at IS NULL`,
          [previous.id, scope.organisationId, scope.projectId],
        );
        if (superseded.rowCount === 0) {
          throw new ApiError(
            "VERSION_CONFLICT",
            "This revision has already been superseded. Edit the current revision.",
            { current_version: previous.revision + 1 },
          );
        }
      }
      const inserted = await client.query(
        `INSERT INTO comments
           (id, organisation_id, project_id, review_id, finding_id, body, revision,
            supersedes_comment_id,
            created_by_actor_type, created_by_actor_id, created_by_actor_display)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          id,
          scope.organisationId,
          scope.projectId,
          reviewId,
          findingId,
          body,
          previous === null ? 1 : previous.revision + 1,
          previous === null ? null : previous.id,
          // Attribution is derived from the authenticated actor, never from the
          // request: `docs/DOMAIN_MODEL.md` section 18 requires the actor type
          // to be explicit, and a caller able to state it could make an agent's
          // note read as a human's.
          actor.type,
          actor.id ?? null,
          actor.display ?? null,
        ],
      );
      const comment = toComment(inserted.rows[0] as Record<string, unknown>);
      await appendEvent(client, {
        type: findingId === null ? "review.comment_added" : "finding.comment_added",
        organisationId: scope.organisationId,
        projectId: scope.projectId,
        actor,
        correlation: {
          review_id: reviewId,
          ...(findingId === null ? {} : { finding_id: findingId }),
        },
        payload: { comment },
      });
      return comment;
    });
  }

  /**
   * Records a verification: a claim with evidence, never a resolution
   * (`docs/DOMAIN_MODEL.md` section 19, `docs/MCP_SPEC.md` section 7.7).
   *
   * The order of the checks is the point.
   *
   * 1. **Evidence ownership.** Every artefact must exist, be verified, belong
   *    to this project, and — where it came from a browser session — have come
   *    from a browser session of this project. An artefact from another project
   *    is refused as not found rather than as forbidden, because telling a
   *    caller that somebody else's identifier exists is itself a disclosure
   *    (`docs/TESTING.md` section 10).
   * 2. **At least one after screenshot.** A verification with no screenshot is
   *    a completion claim without evidence, which `AGENTS.md` forbids.
   * 3. **Commit context.** Checked by the domain rule above.
   * 4. Only then is anything written, and the finding moves to
   *    `FIXED_UNVERIFIED` in the same transaction. It stops there: reaching
   *    `AWAITING_HUMAN_REVIEW` is a separate, deliberate act by the agent, and
   *    reaching anything beyond it is not available to an agent at all.
   */
  async submitVerification(
    scope: Scope,
    findingId: string,
    input: SubmitVerificationInput,
    actor: EventActor,
  ): Promise<{ verification: Verification; finding: Finding; branchCorroborated: boolean }> {
    const finding = await this.getFinding(scope, findingId);
    const review = await this.getReview(scope, finding.review_id);
    assertReviewMutable(review.status, { fields: ["verification"] });

    const evidence = await this.#requireOwnedEvidence(scope, input.artefactIds, findingId);
    const screenshots = evidence.filter((artefact) => artefact.kind === "screenshot");
    if (screenshots.length === 0) {
      throw new ApiError(
        "EVIDENCE_REQUIRED",
        "A verification must carry at least one verified screenshot showing the state after the change.",
        { field: "artefact_ids", required_evidence: ["after_screenshot_artefact"] },
      );
    }
    const { branchCorroborated } = assertVerificationCommitContext({
      capturedCommit: finding.captured_commit,
      commit: input.commit,
      branch: input.branch,
      workspaceBranch: input.workspaceBranch,
    });

    // The store has to be reachable before a claim resting on it is recorded
    // (`docs/ARCHITECTURE.md` section 14: "Keep finding verification
    // incomplete"). The artefact rows say the bytes were verified once; they
    // do not say the bytes can be reached now, and a verification recorded
    // against a store that has gone away is a completion claim whose evidence
    // nobody can open. The refusal is ARTEFACT_STORE_UNAVAILABLE and not
    // ARTEFACT_UPLOAD_INCOMPLETE, because the two call for opposite responses:
    // this one says retry the same submission unchanged, and the other says the
    // artefact is not evidence and must be produced again
    // (`docs/MCP_SPEC.md` section 12).
    await this.#requireReachableEvidence(evidence);

    const id = newId("ver_");
    const afterArtefactId = screenshots[screenshots.length - 1]?.id ?? null;
    const result = await inTransaction(this.#pool, async (client) => {
      // Locked first, so the version check, the supersession and the status
      // move all see one consistent row and a concurrent submission on the same
      // finding waits rather than racing. The partial unique index of migration
      // 0150 is the backstop for the path this lock does not cover.
      const locked = await this.#lockFinding(client, scope, findingId);
      if (input.expectedVersion !== undefined) {
        assertExpectedVersion(locked.version, input.expectedVersion, "finding");
      }
      const superseded = await this.#supersedeCurrentVerification(client, scope, findingId, id);

      const inserted = await client.query(
        `INSERT INTO verifications
           (id, organisation_id, project_id, review_id, finding_id, status, summary,
            branch, commit_sha, tested_viewports, checks,
            submitted_by_actor_type, submitted_by_actor_id, submitted_by_actor_display,
            supersedes_verification_id)
         VALUES ($1,$2,$3,$4,$5,'submitted',$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14)
         RETURNING *`,
        [
          id,
          scope.organisationId,
          scope.projectId,
          finding.review_id,
          findingId,
          input.summary,
          input.branch,
          input.commit,
          JSON.stringify(input.testedViewports),
          JSON.stringify(input.checks),
          actor.type,
          actor.id ?? null,
          actor.display ?? null,
          superseded,
        ],
      );
      let position = 0;
      for (const artefact of evidence) {
        const role =
          artefact.id === finding.screenshot_artefact_id
            ? "before"
            : artefact.id === afterArtefactId
              ? "after"
              : "supporting";
        await client.query(
          "INSERT INTO verification_artefacts (verification_id, artefact_id, role, position) VALUES ($1,$2,$3,$4)",
          [id, artefact.id, role, position],
        );
        position += 1;
      }

      // Where the submission may advance the finding, derived from the
      // transition table rather than restated (ADR-0024). Writing
      // `CASE WHEN status = 'IN_PROGRESS' THEN 'FIXED_UNVERIFIED'` in SQL, as
      // this did until the RVP-37 review, is a second copy of a rule the
      // protocol already holds — and a copy in a dialect nothing typechecks.
      // Read from the locked row rather than the pre-transaction one: the
      // status this submission advances from must be the status the row holds
      // under the lock, or a concurrent transition could be silently reverted.
      const advances =
        mayActorMoveFinding(actor.type, locked.status, "FIXED_UNVERIFIED") &&
        !isFinalDisposition(locked.status);
      const advanced: FindingStatus = advances ? "FIXED_UNVERIFIED" : locked.status;

      // The summary is the resolution note. Recording it on the finding is what
      // lets assertCompletionEvidence pass for FIXED_UNVERIFIED without the
      // agent having to say the same thing twice.
      const updated = await client.query(
        `UPDATE findings
            SET resolution_note = $4,
                status = $5,
                version = version + 1,
                updated_at = now()
          WHERE id = $1 AND organisation_id = $2 AND project_id = $3
          RETURNING *`,
        [findingId, scope.organisationId, scope.projectId, input.summary, advanced],
      );
      const moved = toFinding(updated.rows[0] as Record<string, unknown>);
      const verification = toVerification(
        inserted.rows[0] as Record<string, unknown>,
        evidence.map((artefact) => artefact.id),
        finding.screenshot_artefact_id,
        afterArtefactId,
      );
      await appendEvent(client, {
        type: "finding.verification_submitted",
        organisationId: scope.organisationId,
        projectId: scope.projectId,
        actor,
        correlation: {
          review_id: finding.review_id,
          finding_id: findingId,
          ...(afterArtefactId === null ? {} : { artefact_id: afterArtefactId }),
          ...(actor.type === "agent_session" && actor.id !== undefined
            ? { agent_session_id: actor.id }
            : {}),
        },
        payload: {
          verification,
          // Repeated at the top level so a consumer filtering one finding's
          // timeline need not open the claim, and carrying the version the
          // finding holds after the submission so a reader can order this
          // against the status changes around it (`docs/EVENTS.md` section 7).
          finding_id: findingId,
          review_id: finding.review_id,
          version: moved.version,
          // Supersession is recorded on the submission that caused it rather
          // than as an event of its own: one act, one occurrence.
          ...(superseded === null ? {} : { supersedes_verification_id: superseded }),
        },
      });
      if (moved.status !== locked.status) {
        await appendEvent(client, {
          type: "finding.status_changed",
          organisationId: scope.organisationId,
          projectId: scope.projectId,
          actor,
          correlation: { review_id: finding.review_id, finding_id: findingId },
          payload: {
            finding_id: findingId,
            review_id: finding.review_id,
            from: locked.status,
            to: moved.status,
            version: moved.version,
            source: locked.source,
            reason: "Verification submitted with evidence.",
          },
        });
      }
      return { verification, finding: moved };
    });
    return { ...result, branchCorroborated };
  }

  /**
   * Marks the finding's current claim superseded and returns its identifier.
   *
   * A second submission **supersedes** rather than replaces: the earlier row
   * keeps its summary, its viewports, its checks and its artefact links, and
   * gains a forward pointer to the claim that took over
   * (`docs/DOMAIN_MODEL.md` section 19, ADR-0030). A reopen cycle therefore
   * accumulates history rather than starting again, which is what
   * `finding.reopened`'s verification count has always promised and what
   * nothing until now delivered.
   *
   * It runs under the finding's row lock, and the partial unique index of
   * migration 0150 is the backstop: two submissions that somehow reached this
   * point together produce one current claim and one unique violation.
   */
  async #supersedeCurrentVerification(
    client: PoolClient,
    scope: Scope,
    findingId: string,
    replacementId: string,
  ): Promise<string | null> {
    const superseded = await client.query<{ id: string }>(
      `UPDATE verifications
          SET status = 'superseded',
              superseded_at = now(),
              superseded_by_verification_id = $4
        WHERE finding_id = $1 AND organisation_id = $2 AND project_id = $3
          AND status = 'submitted'
        RETURNING id`,
      [findingId, scope.organisationId, scope.projectId, replacementId],
    );
    return superseded.rows[0]?.id ?? null;
  }

  /**
   * Proves the evidence can still be read before a claim is recorded against
   * it (`docs/ARCHITECTURE.md` section 14 "Artefact upload failure": "Keep
   * finding verification incomplete").
   *
   * The artefact rows say the bytes were verified when they arrived. They do
   * not say the store is reachable now, and a verification written while the
   * store is down is a completion claim whose before-and-after pair cannot be
   * opened — which is the one thing this record exists to make possible. So the
   * submission is refused and **nothing is written**: the finding keeps its
   * status, no verification row appears, and the same call succeeds unchanged
   * once the store returns.
   *
   * The code is deliberately `ARTEFACT_STORE_UNAVAILABLE` and not
   * `ARTEFACT_UPLOAD_INCOMPLETE`. The first says retry this submission; the
   * second says the artefact is not evidence and must be captured again. An
   * agent told the second by a transient outage would recapture a screenshot
   * that was already perfectly good, and an operator would go looking for an
   * upload fault that never happened (`docs/MCP_SPEC.md` section 12).
   */
  async #requireReachableEvidence(evidence: readonly { id: string }[]): Promise<void> {
    const status = await this.#artefacts.storeStatus();
    if (status.available) return;
    this.#logger?.warn?.(
      { artefact_ids: evidence.map((artefact) => artefact.id), detail: status.detail },
      "verification refused: the artefact store is unreachable",
    );
    throw new ApiError(
      "ARTEFACT_STORE_UNAVAILABLE",
      "The artefact store cannot be reached, so this verification was not recorded. Retry the same submission unchanged.",
      { reason: "artefact_store_unavailable", retryable: true },
    );
  }

  /**
   * The finding's current claim, if it has one.
   *
   * "Current" is the row whose status is `submitted`, which migration 0150
   * makes unique per finding. It used to be "the newest row", which is a
   * different question with the same answer only while nothing supersedes
   * anything.
   */
  async latestVerification(scope: Scope, findingId: string): Promise<Verification | null> {
    const rows = await this.#pool.query(
      `SELECT v.*,
              (SELECT array_agg(va.artefact_id ORDER BY va.position)
                 FROM verification_artefacts va WHERE va.verification_id = v.id) AS artefact_ids,
              (SELECT va.artefact_id FROM verification_artefacts va
                WHERE va.verification_id = v.id AND va.role = 'before' LIMIT 1) AS before_artefact_id,
              (SELECT va.artefact_id FROM verification_artefacts va
                WHERE va.verification_id = v.id AND va.role = 'after' LIMIT 1) AS after_artefact_id
         FROM verifications v
        WHERE v.finding_id = $1 AND v.organisation_id = $2 AND v.project_id = $3
        ORDER BY (v.status = 'submitted') DESC, v.submitted_at DESC
        LIMIT 1`,
      [findingId, scope.organisationId, scope.projectId],
    );
    const row = rows.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return toVerification(
      row,
      (row["artefact_ids"] as string[] | null) ?? [],
      (row["before_artefact_id"] as string | null) ?? null,
      (row["after_artefact_id"] as string | null) ?? null,
    );
  }

  /** Every verification for a finding, newest first, superseded ones included. */
  async listVerifications(scope: Scope, findingId: string): Promise<Verification[]> {
    const rows = await this.#pool.query(
      `SELECT v.*,
              (SELECT array_agg(va.artefact_id ORDER BY va.position)
                 FROM verification_artefacts va WHERE va.verification_id = v.id) AS artefact_ids,
              (SELECT va.artefact_id FROM verification_artefacts va
                WHERE va.verification_id = v.id AND va.role = 'before' LIMIT 1) AS before_artefact_id,
              (SELECT va.artefact_id FROM verification_artefacts va
                WHERE va.verification_id = v.id AND va.role = 'after' LIMIT 1) AS after_artefact_id
         FROM verifications v
        WHERE v.finding_id = $1 AND v.organisation_id = $2 AND v.project_id = $3
        ORDER BY v.submitted_at DESC, v.id DESC
        LIMIT 100`,
      [findingId, scope.organisationId, scope.projectId],
    );
    return rows.rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return toVerification(
        row,
        (row["artefact_ids"] as string[] | null) ?? [],
        (row["before_artefact_id"] as string | null) ?? null,
        (row["after_artefact_id"] as string | null) ?? null,
      );
    });
  }

  /**
   * The project's completion requirements (`docs/MCP_SPEC.md` section 7.8).
   *
   * Read from the project row rather than from a constant, so a project that
   * changes its validation viewports changes what the gate demands. A constant
   * here would be a second copy of a configurable rule, and `STAGE_1_POLICY`
   * holding one is precisely how `project_current` came to advertise viewports
   * a project had not chosen.
   */
  async completionRequirements(scope: Scope): Promise<{
    readonly settings: ProjectSettings;
    readonly requirements: CompletionRequirements;
  }> {
    const rows = await this.#pool.query<{ settings: ProjectSettings }>(
      "SELECT settings FROM projects WHERE id = $1 AND organisation_id = $2",
      [scope.projectId, scope.organisationId],
    );
    const row = rows.rows[0];
    if (row === undefined) throw notFound("The project");
    const settings = row.settings;
    return { settings, requirements: completionRequirementsFor(settings) };
  }

  /**
   * One finding's standing against the requirements, with the evidence that
   * decides it.
   *
   * `branch_corroborated` is derived here rather than stored: a workspace can
   * move after a submission, and the honest question at read time is whether
   * the branch the claim names is the branch a workspace is on **now**. Where
   * no workspace is registered the answer is no, which is what the
   * `verification_branch_uncorroborated` warning has always said.
   */
  async completionEvidenceFor(
    scope: Scope,
    findingId: string,
    workspaceBranch: string | null,
  ): Promise<EvidenceUnderReview | null> {
    const verification = await this.latestVerification(scope, findingId);
    if (verification === null || verification.status !== "submitted") return null;
    return {
      verification_id: verification.verification_id,
      tested_viewports: verification.tested_viewports ?? [],
      checks: verification.checks ?? {
        reproduced_before: false,
        console_errors_reviewed: false,
        network_failures_reviewed: false,
      },
      after_artefact_id: verification.after_artefact_id ?? null,
      branch_corroborated:
        workspaceBranch !== null && verification.branch === workspaceBranch,
      submitted_by: verification.submitted_by,
    };
  }

  /**
   * Evaluates the completion gate over a review, or one finding of it.
   *
   * It reads and records nothing. `task_complete` records its own evaluation as
   * an event; this is the shared calculation both completion tools and the
   * evidence-gated transition use, so all three answer the same question the
   * same way.
   */
  async evaluateCompletion(
    scope: Scope,
    input: {
      readonly reviewId: string;
      readonly findingId?: string;
      readonly workspaceBranch: string | null;
    },
  ): Promise<{
    readonly settings: ProjectSettings;
    readonly requirements: CompletionRequirements;
    readonly states: readonly FindingCompletionState[];
  }> {
    const { settings, requirements } = await this.completionRequirements(scope);
    const findings = await this.listFindings(scope, input.reviewId);
    const subject =
      input.findingId === undefined
        ? findings
        : findings.filter((finding) => finding.id === input.findingId);
    if (input.findingId !== undefined && subject.length === 0) {
      // A finding of another review, or of another project, is answered exactly
      // as an unknown one is: the identifier must not become an oracle.
      throw notFound("The finding");
    }

    const states: FindingCompletionState[] = [];
    for (const finding of subject.slice(0, 50)) {
      const evidence = await this.completionEvidenceFor(scope, finding.id, input.workspaceBranch);
      const verificationCount = await this.countVerifications(scope, finding.id);
      states.push(
        findingCompletionState({
          findingId: finding.id,
          status: finding.status,
          settings,
          requirements,
          evidence,
          verificationCount,
        }),
      );
    }
    return { settings, requirements, states };
  }

  /**
   * Records that the completion gate was consulted (`docs/EVENTS.md` section 7,
   * `docs/MCP_SPEC.md` section 7.8).
   *
   * It writes an event and nothing else. No review, finding or verification
   * moves because an agent asked whether it had finished — the gate reports,
   * and `task_complete` is a question rather than an assertion. What makes the
   * record worth keeping is the other half: the moment an agent believed it was
   * done, and what it was told, is exactly the moment an auditor wants to
   * reconstruct when the work turns out not to have been done.
   *
   * The agent's `summary` is stored inert beside the control plane's answer. It
   * is a claim, it did not affect the result, and it is never rendered as
   * markup (ADR-0010, `docs/SECURITY.md` section 18).
   */
  async recordCompletionEvaluation(
    scope: Scope,
    input: {
      readonly reviewId: string;
      readonly findingId?: string;
      readonly result: CompletionResult;
      readonly missing: readonly string[];
      readonly findingCount?: number;
      readonly summary?: string;
    },
    actor: EventActor,
  ): Promise<void> {
    await inTransaction(this.#pool, async (client) => {
      await appendEvent(client, {
        type: "review.completion_evaluated",
        organisationId: scope.organisationId,
        projectId: scope.projectId,
        actor,
        correlation: {
          review_id: input.reviewId,
          ...(input.findingId === undefined ? {} : { finding_id: input.findingId }),
          ...(actor.type === "agent_session" && actor.id !== undefined
            ? { agent_session_id: actor.id }
            : {}),
        },
        payload: {
          review_id: input.reviewId,
          ...(input.findingId === undefined ? {} : { finding_id: input.findingId }),
          result: input.result,
          missing: [...input.missing],
          finding_count: input.findingCount ?? 0,
          ...(input.summary === undefined ? {} : { summary: input.summary }),
        },
      });
    });
  }

  /** Every verification for a finding, newest first. */
  async countVerifications(scope: Scope, findingId: string): Promise<number> {
    const rows = await this.#pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM verifications
        WHERE finding_id = $1 AND organisation_id = $2 AND project_id = $3`,
      [findingId, scope.organisationId, scope.projectId],
    );
    return Number(rows.rows[0]?.count ?? 0);
  }

  // -----------------------------------------------------------------------
  // Annotations
  // -----------------------------------------------------------------------

  async createAnnotation(
    scope: Scope,
    findingId: string,
    input: CreateAnnotationInput,
    actor: EventActor,
  ): Promise<Annotation> {
    assertGeometry(input.type, input.geometry);
    const finding = await this.getFinding(scope, findingId);
    if (input.artefactId !== finding.screenshot_artefact_id) {
      throw new ApiError(
        "UNSUPPORTED_CAPABILITY",
        "An annotation must be placed on the finding's own screenshot artefact.",
        { field: "artefact_id" },
      );
    }
    await this.#requireAvailableArtefact(scope, input.artefactId);

    return inTransaction(this.#pool, async (client) => {
      const annotation = await this.#insertAnnotation(client, scope, findingId, input, actor);
      await appendEvent(client, {
        type: "finding.annotated",
        organisationId: scope.organisationId,
        projectId: scope.projectId,
        actor,
        correlation: {
          review_id: finding.review_id,
          finding_id: findingId,
          annotation_id: annotation.id,
          artefact_id: annotation.artefact_id,
        },
        payload: { annotation },
      });
      return annotation;
    });
  }

  /** The current projection: newest revision of each annotation, undeleted. */
  async listAnnotations(scope: Scope, findingId: string): Promise<Annotation[]> {
    await this.getFinding(scope, findingId);
    const rows = await this.#pool.query(
      `SELECT * FROM annotations_current
        WHERE finding_id = $1 AND organisation_id = $2 AND project_id = $3
          AND deleted_at IS NULL
        ORDER BY created_at, id`,
      [findingId, scope.organisationId, scope.projectId],
    );
    return rows.rows.map((row) => toAnnotation(row as Record<string, unknown>));
  }

  /** Every revision, including withdrawn ones (`docs/API.md` section 14). */
  async listAnnotationRevisions(scope: Scope, findingId: string): Promise<Annotation[]> {
    await this.getFinding(scope, findingId);
    const rows = await this.#pool.query(
      `SELECT * FROM annotations
        WHERE finding_id = $1 AND organisation_id = $2 AND project_id = $3
        ORDER BY id, revision`,
      [findingId, scope.organisationId, scope.projectId],
    );
    return rows.rows.map((row) => toAnnotation(row as Record<string, unknown>));
  }

  // -----------------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------------

  /**
   * Requests a review export (`docs/API.md` section 12,
   * `docs/REVIEW_FORMAT.md`).
   *
   * The export is a durable job rather than work done inside the request. A
   * review with a hundred findings and their evidence manifests is not
   * something to build while a caller holds a socket open, and a job survives
   * the control-plane restart that a long request would not.
   *
   * Asking twice while a run is in flight joins the first run. That is enforced
   * by a partial unique index rather than by a read followed by a write: two
   * concurrent requests would both find no pending export and both queue one,
   * which is how a caller ends up with two artefacts and no way to say which is
   * the export.
   */
  async requestExport(
    scope: Scope,
    reviewId: string,
    actor: EventActor,
  ): Promise<ReviewExport> {
    await this.getReview(scope, reviewId);
    const id = newId("rex_");
    try {
      return await inTransaction(this.#pool, async (client) => {
        const job = await enqueueJob(client, {
          organisationId: scope.organisationId,
          projectId: scope.projectId,
          kind: "review_export",
          payload: { review_export_id: id, review_id: reviewId },
          idempotencyKey: `review_export:${id}`,
        });
        const inserted = await client.query(
          `INSERT INTO review_exports
             (id, organisation_id, project_id, review_id, job_id, status, privacy_mode,
              requested_by_actor_type, requested_by_actor_id, requested_by_actor_display)
           VALUES ($1,$2,$3,$4,$5,'pending','metadata_only',$6,$7,$8)
           RETURNING *`,
          [
            id,
            scope.organisationId,
            scope.projectId,
            reviewId,
            job.id,
            actor.type,
            actor.id ?? null,
            actor.display ?? null,
          ],
        );
        return toReviewExport(inserted.rows[0] as Record<string, unknown>);
      });
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        const pending = await this.latestExport(scope, reviewId);
        if (pending !== null) return pending;
      }
      throw error;
    }
  }

  /** The most recent export of a review, or null. */
  async latestExport(scope: Scope, reviewId: string): Promise<ReviewExport | null> {
    const rows = await this.#pool.query(
      `SELECT * FROM review_exports
        WHERE review_id = $1 AND organisation_id = $2 AND project_id = $3
        ORDER BY created_at DESC
        LIMIT 1`,
      [reviewId, scope.organisationId, scope.projectId],
    );
    const row = rows.rows[0] as Record<string, unknown> | undefined;
    return row === undefined ? null : toReviewExport(row);
  }

  /**
   * The portable review document of `docs/REVIEW_FORMAT.md` section 3.
   *
   * Stage 1 exports in the metadata-only privacy mode of section 8: the review,
   * its findings, its comments and an artefact manifest of digests, with no
   * bytes embedded. That is the mode a self-hosted deployment can produce
   * without a second decision about who may read the evidence, and the manifest
   * still carries the hashes section 7 requires for integrity.
   */
  async buildExportDocument(
    scope: Scope,
    reviewId: string,
  ): Promise<Record<string, unknown>> {
    const review = await this.getReview(scope, reviewId);
    const findings = await this.listFindings(scope, reviewId);
    const comments = await this.#pool.query(
      `SELECT * FROM comments
        WHERE review_id = $1 AND organisation_id = $2 AND project_id = $3
        ORDER BY created_at, id`,
      [reviewId, scope.organisationId, scope.projectId],
    );
    const artefacts = await this.#pool.query<{
      id: string;
      kind: string;
      content_type: string;
      size_bytes: string | null;
      sha256: string | null;
      redaction_state: string | null;
    }>(
      `SELECT DISTINCT a.id, a.kind, a.content_type, a.size_bytes, a.sha256, a.redaction_state
         FROM artefacts a
        WHERE a.project_id = $2 AND a.organisation_id = $3
          AND a.id IN (SELECT screenshot_artefact_id FROM findings WHERE review_id = $1)
        ORDER BY a.id`,
      [reviewId, scope.projectId, scope.organisationId],
    );
    const project = await this.#pool.query<{ name: string; repository_identity: unknown }>(
      "SELECT name, repository_identity FROM projects WHERE id = $1 AND organisation_id = $2",
      [scope.projectId, scope.organisationId],
    );
    const projectRow = project.rows[0];

    return {
      format: "reviewplane-review",
      version: 1,
      privacy_mode: "metadata_only",
      exported_at: new Date().toISOString(),
      review: {
        id: review.id,
        slug: review.slug,
        title: review.title,
        ...(review.description === undefined ? {} : { description: review.description }),
        status: review.status,
        ...(review.priority === undefined ? {} : { priority: review.priority }),
        project: {
          name: projectRow?.name ?? "",
          ...(projectRow?.repository_identity === null ||
          projectRow?.repository_identity === undefined
            ? {}
            : { repository_identity: projectRow.repository_identity }),
        },
        source: { branch: review.captured_branch, commit: review.captured_commit },
        created_at: review.created_at,
        ...(review.closed_at === undefined ? {} : { closed_at: review.closed_at }),
      },
      findings: findings.map((finding) => ({
        id: finding.id,
        title: finding.title,
        ...(finding.description === undefined ? {} : { description: finding.description }),
        severity: finding.severity,
        status: finding.status,
        source: finding.source,
        url: finding.url,
        viewport: finding.viewport,
        scroll_position: finding.scroll_position,
        captured_commit: finding.captured_commit,
        ...(finding.element_context === undefined
          ? {}
          : { element_context: finding.element_context }),
        ...(finding.acceptance_criteria === undefined
          ? {}
          : { acceptance_criteria: finding.acceptance_criteria }),
        evidence: { screenshot_artefact_id: finding.screenshot_artefact_id },
        created_at: finding.created_at,
      })),
      comments: comments.rows.map((row) => toComment(row as Record<string, unknown>)),
      artefacts: artefacts.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        content_type: row.content_type,
        ...(row.size_bytes === null ? {} : { size_bytes: Number(row.size_bytes) }),
        ...(row.sha256 === null ? {} : { sha256: row.sha256 }),
        ...(row.redaction_state === null ? {} : { redaction_state: row.redaction_state }),
      })),
    };
  }

  /**
   * Records that an export succeeded, with the artefact it produced.
   *
   * The row moves to `ready` and gains its artefact in the same statement, so
   * the constraint that a ready export has an artefact, a digest and a size is
   * satisfied or the write fails. There is no window in which an export reports
   * itself complete and has nothing behind it — which is what
   * `docs/TESTING.md` section 11 asks of a failed export run.
   */
  async completeExport(
    exportId: string,
    result: { readonly artefactId: string; readonly sha256: string; readonly sizeBytes: number },
    client: PoolClient,
  ): Promise<void> {
    await client.query(
      `UPDATE review_exports
          SET status = 'ready', artefact_id = $2, sha256 = $3, size_bytes = $4,
              failure_reason = NULL, completed_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [exportId, result.artefactId, result.sha256, result.sizeBytes],
    );
  }

  /** Records that an export attempt failed, leaving no artefact behind. */
  async failExport(exportId: string, reason: string): Promise<void> {
    await this.#pool.query(
      `UPDATE review_exports
          SET status = 'failed', failure_reason = $2, completed_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [exportId, reason.slice(0, 500)],
    );
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * The acceptance precondition of `docs/API.md` section 12.
   *
   * It reads the findings inside the caller's transaction, which already holds
   * the review's row lock, so a finding cannot be reopened between the check
   * and the write.
   */
  async #assertFindingsPermitAcceptance(
    client: PoolClient,
    scope: Scope,
    reviewId: string,
  ): Promise<{ total: number; human: number }> {
    const rows = await client.query<{ id: string; source: FindingSource; status: FindingStatus }>(
      `SELECT id, source, status FROM findings
        WHERE review_id = $1 AND organisation_id = $2 AND project_id = $3
        ORDER BY created_at, id`,
      [reviewId, scope.organisationId, scope.projectId],
    );
    assertReviewAcceptable(rows.rows);
    return {
      total: rows.rows.length,
      human: rows.rows.filter((finding) => finding.source === "human").length,
    };
  }

  /**
   * Writes the audit record for a refused transition, in its own transaction.
   *
   * Its own, because the transaction that raised the refusal has rolled back
   * and everything written inside it went with the refusal. Writing the denial
   * afterwards is the only way it survives, and it is safe to write: nothing
   * about it depends on the state the refused write would have produced.
   *
   * A failure to record the denial never masks the denial: the caller is
   * refused either way, and turning "we could not write the audit line" into a
   * different refusal would tell an attacker something about the audit trail
   * rather than about their request. But it is **logged**, with enough context
   * to reconstruct the attempt. A discarded failure would make a lost audit
   * record invisible, which is the one outcome worse than a noisy one: an
   * operator asking whether an agent tried to accept a finding would read an
   * empty result and conclude that nothing happened.
   */
  async #recordDenial(
    scope: Scope,
    actor: EventActor,
    denied: PendingDenial | null,
    error: unknown,
  ): Promise<void> {
    if (denied === null || !(error instanceof ApiError)) return;
    try {
      await inTransaction(this.#pool, async (client) => {
        await appendEvent(client, {
          type: denied.type,
          organisationId: scope.organisationId,
          projectId: scope.projectId,
          actor,
          correlation: denied.correlation,
          payload: {
            ...denied.payload,
            code: error.code,
            // The refusal's own message, never the request: a payload is not a
            // place to echo caller-supplied text (`docs/EVENTS.md` section 8).
            reason: error.message.slice(0, 500),
          },
        });
      });
    } catch (failure) {
      // The refusal still stands; what is lost is the record of it, and that
      // loss is itself an operational fact. The fields are the attempt, not the
      // request: no body, no credential (`docs/SECURITY.md` section 18).
      this.#logger?.error(
        {
          event_type: denied.type,
          organisation_id: scope.organisationId,
          project_id: scope.projectId,
          actor_type: actor.type,
          actor_id: actor.id ?? null,
          refusal_code: error.code,
          ...denied.payload,
          err: failure instanceof Error ? failure.message : String(failure),
        },
        "the audit record for a refused transition could not be written",
      );
    }
  }

  /**
   * Records a transition a caller asked for and was refused **before this
   * service was reached at all**.
   *
   * `docs/DOMAIN_MODEL.md` section 15 requires **every** refused transition to
   * be audited, and states why in terms this method exists to satisfy: "an
   * attempt with no record is indistinguishable from one that never happened,
   * and the Stage 1 exit criterion is that the attempt leaves a trail".
   *
   * `#recordDenial` covers the refusals this service raises. It cannot cover
   * the one that matters most. The agent-facing tool schemas do not contain
   * `RESOLVED`, `WONT_FIX`, `DUPLICATE` or `ACCEPTED` at all (ADR-0020), so an
   * agent asking for one is refused by the generated validator before any
   * domain code runs — which meant the single attempt an auditor would go
   * looking for, *did an agent try to accept a human's finding*, was precisely
   * the one that left no trace. The structural denial is the stronger control
   * and stays; what it cannot do is write the record, so the layer that saw the
   * attempt hands it here.
   *
   * The current status is read rather than supplied, so `from` is what the row
   * actually holds and not what a caller claimed. The read carries the scope,
   * so an attempt against a record the caller cannot see records nothing: it
   * is not an attempt on that record, and writing one would let a caller append
   * to another project's audit trail by guessing identifiers.
   *
   * A failure to write is logged and never raised. The refusal has already
   * happened and stands; losing its record is an operational fact rather than a
   * reason to answer the caller differently.
   */
  async recordTransitionDenied(
    scope: Scope,
    input: {
      readonly kind: "review" | "finding";
      readonly id: string;
      readonly requested: string;
      readonly code: string;
      readonly reason: string;
    },
    actor: EventActor,
  ): Promise<boolean> {
    try {
      const current =
        input.kind === "review"
          ? await this.getReview(scope, input.id).catch(() => null)
          : await this.getFinding(scope, input.id).catch(() => null);
      if (current === null) return false;
      const isReview = input.kind === "review";
      await inTransaction(this.#pool, async (client) => {
        await appendEvent(client, {
          type: isReview ? "review.status_change_denied" : "finding.status_change_denied",
          organisationId: scope.organisationId,
          projectId: scope.projectId,
          actor,
          correlation: isReview
            ? { review_id: input.id }
            : { review_id: (current as Finding).review_id, finding_id: input.id },
          payload: {
            ...(isReview
              ? { review_id: input.id }
              : { finding_id: input.id, review_id: (current as Finding).review_id }),
            from: current.status,
            requested: input.requested,
            ...(isReview ? {} : { source: (current as Finding).source }),
            code: input.code,
            // The refusal's own message, never the request.
            reason: input.reason.slice(0, 500),
          },
        });
      });
      return true;
    } catch (failure) {
      this.#logger?.error(
        {
          event_type:
            input.kind === "review"
              ? "review.status_change_denied"
              : "finding.status_change_denied",
          organisation_id: scope.organisationId,
          project_id: scope.projectId,
          actor_type: actor.type,
          actor_id: actor.id ?? null,
          record_id: input.id,
          requested: input.requested,
          refusal_code: input.code,
          err: failure instanceof Error ? failure.message : String(failure),
        },
        "the audit record for a refused transition could not be written",
      );
      return false;
    }
  }

  async #countVerificationsOn(
    client: PoolClient,
    scope: Scope,
    findingId: string,
  ): Promise<number> {
    const rows = await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM verifications
        WHERE finding_id = $1 AND organisation_id = $2 AND project_id = $3`,
      [findingId, scope.organisationId, scope.projectId],
    );
    return Number(rows.rows[0]?.count ?? 0);
  }

  /**
   * A user the caller may assign to.
   *
   * The organisation is in the predicate rather than compared afterwards, and a
   * user outside it is answered not-found: `docs/SECURITY.md` section 7 requires
   * that a foreign identifier be indistinguishable from an unknown one, or the
   * pair is an existence oracle.
   */
  async #requireUserInOrganisation(scope: Scope, userId: string): Promise<void> {
    const rows = await this.#pool.query<{ id: string }>(
      "SELECT id FROM users WHERE id = $1 AND organisation_id = $2",
      [userId, scope.organisationId],
    );
    if (rows.rows[0] === undefined) throw notFound("The user");
  }

  async #requireAgentSessionInProject(scope: Scope, agentSessionId: string): Promise<void> {
    const rows = await this.#pool.query<{ id: string }>(
      `SELECT id FROM agent_sessions
        WHERE id = $1 AND project_id = $2 AND organisation_id = $3`,
      [agentSessionId, scope.projectId, scope.organisationId],
    );
    if (rows.rows[0] === undefined) throw notFound("The agent session");
  }

  /** The finding a duplicate points at: same project, and not itself. */
  async #requireFindingInProject(
    scope: Scope,
    findingId: string,
    notThisOne: string,
  ): Promise<void> {
    if (findingId === notThisOne) {
      throw new ApiError("UNSUPPORTED_CAPABILITY", "A finding cannot duplicate itself.", {
        field: "duplicate_of_finding_id",
      });
    }
    const rows = await this.#pool.query<{ id: string }>(
      `SELECT id FROM findings
        WHERE id = $1 AND organisation_id = $2 AND project_id = $3`,
      [findingId, scope.organisationId, scope.projectId],
    );
    if (rows.rows[0] === undefined) throw notFound("The duplicated finding");
  }

  async #insertAnnotation(
    client: PoolClient,
    scope: Scope,
    findingId: string,
    input: CreateAnnotationInput,
    actor: EventActor,
  ): Promise<Annotation> {
    const id = newId("ann_");
    const inserted = await client.query(
      `INSERT INTO annotations (
          id, revision, organisation_id, project_id, finding_id, artefact_id, type,
          geometry, label, marker_number, style_hint,
          created_by_actor_type, created_by_actor_id, created_by_actor_display
       ) VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        id,
        scope.organisationId,
        scope.projectId,
        findingId,
        input.artefactId,
        input.type,
        JSON.stringify(input.geometry),
        input.label,
        input.markerNumber ?? null,
        input.styleHint ?? "default",
        actor.type,
        actor.id ?? null,
        actor.display ?? null,
      ],
    );
    return toAnnotation(inserted.rows[0] as Record<string, unknown>);
  }

  /**
   * Reads a review for update. `FOR UPDATE` is what makes the version check
   * meaningful: without it two callers could both read version 4, both find it
   * equal to their expectation, and both write version 5.
   */
  async #lockReview(
    client: PoolClient,
    scope: Scope,
    reviewId: string,
  ): Promise<{
    version: number;
    status: ReviewStatus;
    slug: string;
    assignedUserId: string | null;
    assignedAgentSessionId: string | null;
  }> {
    const rows = await client.query<{
      version: number;
      status: ReviewStatus;
      slug: string;
      assigned_user_id: string | null;
      assigned_agent_session_id: string | null;
    }>(
      `SELECT version, status, slug, assigned_user_id, assigned_agent_session_id FROM reviews
        WHERE id = $1 AND organisation_id = $2 AND project_id = $3
        FOR UPDATE`,
      [reviewId, scope.organisationId, scope.projectId],
    );
    const row = rows.rows[0];
    if (row === undefined) throw notFound("The review");
    return {
      version: Number(row.version),
      status: row.status,
      slug: row.slug,
      assignedUserId: row.assigned_user_id,
      assignedAgentSessionId: row.assigned_agent_session_id,
    };
  }

  /**
   * What the finding's current claim is still short of, read on the
   * transaction's own client.
   *
   * It uses `client` rather than the pool deliberately. A read on a second
   * connection while this transaction holds the finding's row lock would see a
   * different snapshot and, under load, could wait on a pool that this
   * transaction is itself occupying. The verification row is not written by
   * this transaction, so the client's snapshot is the right one to ask.
   */
  async #missingEvidenceOn(
    client: PoolClient,
    scope: Scope,
    findingId: string,
  ): Promise<string[]> {
    const settingsRow = await client.query<{ settings: ProjectSettings }>(
      "SELECT settings FROM projects WHERE id = $1 AND organisation_id = $2",
      [scope.projectId, scope.organisationId],
    );
    const settings = settingsRow.rows[0]?.settings;
    if (settings === undefined) throw notFound("The project");
    const requirements = completionRequirementsFor(settings);

    const rows = await client.query<{
      id: string;
      tested_viewports: readonly Viewport[];
      checks: VerificationChecks;
      after_artefact_id: string | null;
    }>(
      `SELECT v.id, v.tested_viewports, v.checks,
              (SELECT va.artefact_id FROM verification_artefacts va
                WHERE va.verification_id = v.id AND va.role = 'after' LIMIT 1) AS after_artefact_id
         FROM verifications v
        WHERE v.finding_id = $1 AND v.organisation_id = $2 AND v.project_id = $3
          AND v.status = 'submitted'
        LIMIT 1`,
      [findingId, scope.organisationId, scope.projectId],
    );
    const row = rows.rows[0];
    if (row === undefined) return missingEvidence(settings, requirements, null);
    return missingEvidence(settings, requirements, {
      verification_id: row.id,
      tested_viewports: row.tested_viewports,
      checks: row.checks,
      after_artefact_id: row.after_artefact_id,
      // Corroboration is not part of the gate: an uncorroborated branch is a
      // warning on an otherwise complete claim (`docs/MCP_SPEC.md` section 7.7),
      // and refusing the hand-over for it would discard a verified screenshot
      // over a fact the control plane could not check either way.
      branch_corroborated: true,
      submitted_by: { type: "agent_session" },
    });
  }

  async #lockFinding(
    client: PoolClient,
    scope: Scope,
    findingId: string,
  ): Promise<{
    version: number;
    status: FindingStatus;
    source: FindingSource;
    resolution_note: string | null;
    review_id: string;
  }> {
    const rows = await client.query<{
      version: number;
      status: FindingStatus;
      source: FindingSource;
      resolution_note: string | null;
      review_id: string;
    }>(
      `SELECT version, status, source, resolution_note, review_id FROM findings
        WHERE id = $1 AND organisation_id = $2 AND project_id = $3
        FOR UPDATE`,
      [findingId, scope.organisationId, scope.projectId],
    );
    const row = rows.rows[0];
    if (row === undefined) throw notFound("The finding");
    return { ...row, version: Number(row.version) };
  }

  /**
   * A finding may only reference evidence that exists, belongs to the same
   * project and has been verified. An unverified artefact is not evidence
   * (`docs/API.md` section 15), so a finding must not be able to claim one.
   */
  async #requireAvailableArtefact(
    scope: Scope,
    artefactId: string,
  ): Promise<{ id: string; contentWidthPx: number | null; contentHeightPx: number | null }> {
    // The identifier, the project and the organisation are all in the
    // predicate, so a foreign artefact is not returned and then rejected: it is
    // answered exactly as an unknown identifier is.
    const artefact = await this.#artefacts
      .getInScope(artefactId, {
        organisationId: scope.organisationId,
        projectIds: [scope.projectId],
      })
      .catch(() => null);
    if (artefact === null) throw notFound("The screenshot artefact");
    if (artefact.state !== "available") {
      throw new ApiError(
        "ARTEFACT_UPLOAD_INCOMPLETE",
        "The screenshot has not been verified, so it cannot yet be used as evidence.",
        { field: "screenshot_artefact_id" },
      );
    }
    return {
      id: artefact.id,
      contentWidthPx: artefact.content_width_px,
      contentHeightPx: artefact.content_height_px,
    };
  }

  /**
   * Evidence ownership (`docs/MCP_SPEC.md` section 7.7 design note).
   *
   * Every artefact must be available, in this project, and — where it came from
   * a browser session — from a browser session of this project. The last check
   * is the "browser-session lineage" one: an artefact uploaded against a
   * session belonging to another project would otherwise be reachable by
   * identifier alone.
   *
   * An artefact from another project is reported as not found, not as
   * forbidden. `docs/TESTING.md` section 10 requires that identifiers from
   * another tenant are not enumerable, and a distinct refusal for "exists but
   * is not yours" is exactly the oracle that would make them so.
   */
  async #requireOwnedEvidence(
    scope: Scope,
    artefactIds: readonly string[],
    forFindingId?: string,
  ): Promise<{ id: string; kind: string }[]> {
    const unique = [...new Set(artefactIds)];
    const rows = await this.#pool.query<{
      id: string;
      kind: string;
      state: string;
      browser_session_id: string | null;
      session_project_id: string | null;
      original_of_finding_id: string | null;
    }>(
      // The tenant terms are in the predicate rather than compared afterwards.
      // Comparing after the read is the shape that produced a live
      // cross-organisation breach on the review routes (RVP-66): it leaves a
      // foreign row loaded and relies on every later branch remembering to
      // reject it. Here a row from another project or organisation is simply
      // not returned, so it cannot be reached by forgetting a comparison.
      `SELECT a.id, a.kind, a.state, a.browser_session_id,
              b.project_id AS session_project_id,
              (SELECT f.id FROM findings f
                WHERE f.screenshot_artefact_id = a.id
                  AND f.organisation_id = a.organisation_id
                  AND f.project_id = a.project_id
                LIMIT 1) AS original_of_finding_id
         FROM artefacts a
         LEFT JOIN browser_sessions b ON b.id = a.browser_session_id
        WHERE a.id = ANY($1) AND a.project_id = $2 AND a.organisation_id = $3`,
      [unique, scope.projectId, scope.organisationId],
    );
    const found = new Map(rows.rows.map((row) => [row.id, row]));
    const evidence: { id: string; kind: string }[] = [];
    for (const artefactId of unique) {
      const row = found.get(artefactId);
      if (row === undefined) {
        throw notFound(`The evidence artefact ${artefactId}`);
      }
      if (row.browser_session_id !== null && row.session_project_id !== scope.projectId) {
        throw notFound(`The evidence artefact ${artefactId}`);
      }
      if (row.state !== "available") {
        throw new ApiError(
          "ARTEFACT_UPLOAD_INCOMPLETE",
          `Artefact ${artefactId} has not been verified, so it cannot be submitted as evidence.`,
          { field: "artefact_ids" },
        );
      }
      // Another finding's original annotated screenshot is not this finding's
      // evidence. The project check above does not catch it — both findings are
      // in the same project, so the artefact is legitimately reachable — and
      // without this a submission could present the recorded *before* state of
      // somebody else's defect as the *after* state of its own, which is a
      // completion claim resting on a picture of a different problem.
      //
      // This one is refused as a policy denial rather than as not found. The
      // enumeration argument that makes a foreign project's artefact "not
      // found" does not apply: the caller can already list this project's
      // findings and their screenshots, so a distinct refusal discloses
      // nothing it did not already have, and telling it plainly is more useful
      // than pretending the identifier does not exist.
      if (
        forFindingId !== undefined &&
        row.original_of_finding_id !== null &&
        row.original_of_finding_id !== forFindingId
      ) {
        throw new ApiError(
          "POLICY_DENIED",
          `Artefact ${artefactId} is the original screenshot of finding ${row.original_of_finding_id} and cannot be submitted as evidence for another finding.`,
          { field: "artefact_ids" },
        );
      }
      evidence.push({ id: row.id, kind: row.kind });
    }
    return evidence;
  }

  async #requireSessionInProject(scope: Scope, browserSessionId: string): Promise<void> {
    const rows = await this.#pool.query<{ project_id: string }>(
      "SELECT project_id FROM browser_sessions WHERE id = $1",
      [browserSessionId],
    );
    const row = rows.rows[0];
    if (row === undefined) throw notFound("The source browser session");
    if (row.project_id !== scope.projectId) {
      throw new ApiError(
        "PROJECT_CONTEXT_MISMATCH",
        "The source browser session belongs to another project.",
        { field: "source_browser_session_id" },
      );
    }
  }

  /** Turns the partial unique index's refusal into a stable code. */
  #translateSlugConflict(error: unknown, slug: string): unknown {
    const code = (error as { code?: string }).code;
    const constraint = (error as { constraint?: string }).constraint;
    if (code === UNIQUE_VIOLATION && constraint === "reviews_active_slug_unique") {
      return new ApiError(
        "IDEMPOTENCY_CONFLICT",
        `An active review with the slug ${slug} already exists in this project.`,
        { field: "slug" },
      );
    }
    return error;
  }
}
