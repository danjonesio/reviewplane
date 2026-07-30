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
  type ReviewStatus,
  type VerificationChecks,
  type VerificationReference,
  type Viewport,
} from "@reviewplane/protocol/review";

import { inTransaction } from "../../db/pool.ts";
import { ApiError, notFound } from "../../errors.ts";
import { appendEvent, type EventActor } from "../../events.ts";
import { newId } from "../../ids.ts";
import type { ArtefactService } from "../artefacts/service.ts";
import {
  ACTIVE_REVIEW_STATUSES,
  assertActorMayMoveFinding,
  assertActorMayMoveReview,
  assertCapturedContext,
  assertCompletionEvidence,
  assertExpectedVersion,
  assertFindingTransition,
  assertGeometry,
  assertReviewMutable,
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
  readonly source: FindingSource;
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
    version: Number(row["version"]),
    created_by: createdBy ?? { type: "system" },
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
    finding_id: row["finding_id"] as string,
    body: row["body"] as string,
    created_by: createdBy ?? { type: "system" },
    revision: Number(row["revision"]),
    created_at: timestamp(row["created_at"]),
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
  };
}

/** PostgreSQL's unique-violation class. */
const UNIQUE_VIOLATION = "23505";

export class ReviewService {
  readonly #pool: Pool;
  readonly #artefacts: ArtefactService;

  constructor(pool: Pool, artefacts: ArtefactService) {
    this.#pool = pool;
    this.#artefacts = artefacts;
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
              id, organisation_id, project_id, slug, title, description, status,
              created_by_actor_type, created_by_actor_id, created_by_actor_display,
              captured_branch, captured_commit, captured_workspace_id,
              source_browser_session_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           RETURNING *`,
          [
            id,
            scope.organisationId,
            scope.projectId,
            input.slug,
            input.title,
            input.description ?? null,
            status,
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
    const rows = await this.#pool.query(
      `SELECT r.*, (SELECT count(*) FROM findings f WHERE f.review_id = r.id) AS finding_count
         FROM reviews r
        WHERE r.organisation_id = $1 AND r.project_id = $2
        ORDER BY r.created_at DESC
        LIMIT $3`,
      [scope.organisationId, scope.projectId, Math.min(Math.max(limit, 1), 200)],
    );
    return rows.rows.map((row) =>
      toReview(row as Record<string, unknown>, Number((row as Record<string, unknown>)["finding_count"])),
    );
  }

  async updateReview(
    scope: Scope,
    reviewId: string,
    input: UpdateReviewInput,
    actor: EventActor,
  ): Promise<Review> {
    const fields = (["title", "slug", "description"] as const).filter(
      (field) => input[field] !== undefined,
    );
    try {
      return await inTransaction(this.#pool, async (client) => {
        const current = await this.#lockReview(client, scope, reviewId);
        assertExpectedVersion(current.version, input.expectedVersion, "review");
        assertReviewMutable(current.status, {
          ...(input.status === undefined ? {} : { status: input.status }),
          fields,
        });
        if (input.status !== undefined && input.status !== current.status) {
          assertReviewTransition(current.status, input.status);
          assertActorMayMoveReview(actor.type, input.status);
        }

        const nextStatus = input.status ?? current.status;
        const closed = nextStatus === "ACCEPTED" || nextStatus === "CANCELLED" || nextStatus === "ARCHIVED";
        const updated = await client.query(
          `UPDATE reviews
              SET title = COALESCE($4, title),
                  slug = COALESCE($5, slug),
                  description = COALESCE($6, description),
                  status = $7,
                  version = version + 1,
                  updated_at = now(),
                  closed_at = CASE WHEN $8 THEN COALESCE(closed_at, now()) ELSE closed_at END
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
    } catch (error) {
      throw this.#translateSlugConflict(error, input.slug ?? "");
    }
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
          input.source,
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
    return inTransaction(this.#pool, async (client) => {
      const current = await this.#lockFinding(client, scope, findingId);
      assertExpectedVersion(current.version, input.expectedVersion, "finding");
      const nextStatus = input.status ?? current.status;
      if (nextStatus !== current.status) {
        assertFindingTransition(current.status, nextStatus);
        assertActorMayMoveFinding(actor.type, current.source, current.status, nextStatus);
        assertCompletionEvidence(nextStatus, {
          resolutionNote: input.resolutionNote ?? current.resolution_note ?? undefined,
        });
      }

      const claiming = nextStatus === "CLAIMED" && current.status !== "CLAIMED";
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
                claimed_by_actor_display = CASE WHEN $10 THEN $13 ELSE claimed_by_actor_display END
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
            claimed_by: {
              type: actor.type,
              ...(actor.id === undefined ? {} : { id: actor.id }),
              ...(actor.display === undefined ? {} : { display: actor.display }),
            },
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
          },
        });
      }
      return finding;
    });
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
      if (nextStatus !== current.status) assertReviewTransition(current.status, nextStatus);

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
          AND ($4::timestamptz IS NULL OR (f.created_at, f.id) > ($4::timestamptz, $5::text))
        ORDER BY f.created_at, f.id
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
    const review = await this.getReview(scope, finding.review_id);
    assertReviewMutable(review.status, { fields: ["comments"] });
    const id = newId("cmt_");
    return inTransaction(this.#pool, async (client) => {
      const inserted = await client.query(
        `INSERT INTO comments
           (id, organisation_id, project_id, review_id, finding_id, body,
            created_by_actor_type, created_by_actor_id, created_by_actor_display)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          id,
          scope.organisationId,
          scope.projectId,
          finding.review_id,
          findingId,
          body,
          actor.type,
          actor.id ?? null,
          actor.display ?? null,
        ],
      );
      const comment = toComment(inserted.rows[0] as Record<string, unknown>);
      await appendEvent(client, {
        type: "finding.comment_added",
        organisationId: scope.organisationId,
        projectId: scope.projectId,
        actor,
        correlation: { review_id: finding.review_id, finding_id: findingId },
        payload: { comment },
      });
      return comment;
    });
  }

  async listComments(scope: Scope, findingId: string, limit = 20): Promise<Comment[]> {
    await this.getFinding(scope, findingId);
    const rows = await this.#pool.query(
      `SELECT * FROM comments
        WHERE finding_id = $1 AND organisation_id = $2 AND project_id = $3
        ORDER BY created_at, id
        LIMIT $4`,
      [findingId, scope.organisationId, scope.projectId, Math.min(Math.max(limit, 1), 20)],
    );
    return rows.rows.map((row) => toComment(row as Record<string, unknown>));
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

    const evidence = await this.#requireOwnedEvidence(scope, input.artefactIds);
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

    const id = newId("ver_");
    const afterArtefactId = screenshots[screenshots.length - 1]?.id ?? null;
    const result = await inTransaction(this.#pool, async (client) => {
      const inserted = await client.query(
        `INSERT INTO verifications
           (id, organisation_id, project_id, review_id, finding_id, status, summary,
            branch, commit_sha, tested_viewports, checks,
            submitted_by_actor_type, submitted_by_actor_id, submitted_by_actor_display)
         VALUES ($1,$2,$3,$4,$5,'submitted',$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13)
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

      // The summary is the resolution note. Recording it on the finding is what
      // lets assertCompletionEvidence pass for FIXED_UNVERIFIED without the
      // agent having to say the same thing twice.
      const updated = await client.query(
        `UPDATE findings
            SET resolution_note = $4,
                status = CASE WHEN status = 'IN_PROGRESS' THEN 'FIXED_UNVERIFIED' ELSE status END,
                version = version + 1,
                updated_at = now()
          WHERE id = $1 AND organisation_id = $2 AND project_id = $3
          RETURNING *`,
        [findingId, scope.organisationId, scope.projectId, input.summary],
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
        payload: { verification },
      });
      if (moved.status !== finding.status) {
        await appendEvent(client, {
          type: "finding.status_changed",
          organisationId: scope.organisationId,
          projectId: scope.projectId,
          actor,
          correlation: { review_id: finding.review_id, finding_id: findingId },
          payload: {
            finding_id: findingId,
            review_id: finding.review_id,
            from: finding.status,
            to: moved.status,
            version: moved.version,
            source: finding.source,
            reason: "Verification submitted with evidence.",
          },
        });
      }
      return { verification, finding: moved };
    });
    return { ...result, branchCorroborated };
  }

  /** The most recent verification for a finding, if any. */
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
        ORDER BY v.submitted_at DESC
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
  // Internals
  // -----------------------------------------------------------------------

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
  ): Promise<{ version: number; status: ReviewStatus; slug: string }> {
    const rows = await client.query<{ version: number; status: ReviewStatus; slug: string }>(
      `SELECT version, status, slug FROM reviews
        WHERE id = $1 AND organisation_id = $2 AND project_id = $3
        FOR UPDATE`,
      [reviewId, scope.organisationId, scope.projectId],
    );
    const row = rows.rows[0];
    if (row === undefined) throw notFound("The review");
    return { ...row, version: Number(row.version) };
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
  }> {
    const rows = await client.query<{
      version: number;
      status: FindingStatus;
      source: FindingSource;
      resolution_note: string | null;
    }>(
      `SELECT version, status, source, resolution_note FROM findings
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
    const artefact = await this.#artefacts.get(artefactId).catch(() => null);
    if (artefact === null || artefact.project_id !== scope.projectId) {
      throw notFound("The screenshot artefact");
    }
    if (artefact.organisation_id !== scope.organisationId) throw notFound("The screenshot artefact");
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
  ): Promise<{ id: string; kind: string }[]> {
    const unique = [...new Set(artefactIds)];
    const rows = await this.#pool.query<{
      id: string;
      kind: string;
      state: string;
      organisation_id: string;
      project_id: string;
      browser_session_id: string | null;
      session_project_id: string | null;
    }>(
      `SELECT a.id, a.kind, a.state, a.organisation_id, a.project_id, a.browser_session_id,
              b.project_id AS session_project_id
         FROM artefacts a
         LEFT JOIN browser_sessions b ON b.id = a.browser_session_id
        WHERE a.id = ANY($1)`,
      [unique],
    );
    const found = new Map(rows.rows.map((row) => [row.id, row]));
    const evidence: { id: string; kind: string }[] = [];
    for (const artefactId of unique) {
      const row = found.get(artefactId);
      if (
        row === undefined ||
        row.project_id !== scope.projectId ||
        row.organisation_id !== scope.organisationId
      ) {
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
