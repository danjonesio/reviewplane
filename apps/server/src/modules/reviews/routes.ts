/**
 * Review, finding and annotation endpoints (`docs/API.md` sections 12 to 14).
 *
 * Every request body is validated by the generated validator from
 * `packages/protocol/schemas/review/v1.schema.json` before any domain code
 * runs. That is not a convenience: the normalised-geometry bound lives in the
 * schema, so "a coordinate outside 0 to 1 is refused, never clamped" is
 * enforced by the same artefact that documents it, in the same way for the
 * HTTP API today and for the MCP tools that will call this domain next.
 *
 * Authorisation is the human session of ADR-0016, extended by RVP-12. Every
 * route resolves the owning project before it reads anything, and every query
 * below it carries both the organisation and the project
 * (`docs/DOMAIN_MODEL.md` section 3).
 *
 * A route that changes state says so, by asking for a write scope rather than a
 * read one. That is not decoration: a cookie is attached by the browser to a
 * request another origin caused, so a state-changing request arriving on one
 * must also echo the session's CSRF token (`docs/API.md` section 4.0). The
 * review is the system of record, and a forged retitling or a forged
 * `DRAFT -> READY` is indistinguishable in the audit trail from a genuine one —
 * which is exactly what the RVP-12 review demonstrated against these routes
 * before the guard existed. Making the intent an argument means a new route
 * cannot acquire a scope without stating which kind it needs.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import {
  validateAnnotationCreateRequest,
  validateCommentCreateRequest,
  validateCommentUpdateRequest,
  validateFindingClaimRequest,
  validateFindingCreateRequest,
  validateFindingTransitionRequest,
  validateFindingUpdateRequest,
  validateReviewAssignRequest,
  validateReviewCreateRequest,
  validateReviewTransitionRequest,
  validateReviewUpdateRequest,
  type AnnotationCreateRequest,
  type CommentCreateRequest,
  type CommentUpdateRequest,
  type FindingClaimRequest,
  type FindingCreateRequest,
  type FindingTransitionRequest,
  type FindingUpdateRequest,
  type ReviewAssignRequest,
  type ReviewCreateRequest,
  type ReviewTransitionRequest,
  type ReviewUpdateRequest,
  type SchemaViolation,
} from "@reviewplane/protocol/review";

import { ApiError, notFound } from "../../errors.ts";
import type { EventActor } from "../../events/append.ts";
import { buildPage, pageMeta, readPageRequest } from "../../http/pagination.ts";
import {
  actorOf,
  requireCsrfToken,
  resolveProject,
  scopeParameter,
} from "../identity/authorisation.ts";
import type { ViewerPrincipal } from "../live/viewer-sessions.ts";
import type { CreateAnnotationInput, Scope } from "./service.ts";
import type { ReviewService } from "./service.ts";

export interface ReviewRoutesOptions {
  readonly pool: Pool;
  readonly reviews: ReviewService;
  readonly viewerAuth: (request: FastifyRequest) => Promise<ViewerPrincipal>;
}

type Validator = (value: unknown, path: string, out: SchemaViolation[]) => void;

/**
 * What a handler intends to do with the scope it is asking for.
 *
 * `write` additionally requires the CSRF token when the request authenticated
 * by cookie, and it is required at every call site so that adding a route is a
 * decision about which it is rather than a silent default.
 */
type Intent = "read" | "write";

/** What a scoped lookup returns: the tenant of the row, and its review. */
interface ScopedRow {
  readonly organisation_id: string;
  readonly project_id: string;
  readonly review_id: string;
}

/** Which column names the owning review, per table. */
const SCOPED_REVIEW_COLUMN = {
  reviews: "id",
  findings: "review_id",
  comments: "review_id",
} as const;

/** What a refusal calls each record. The wording never varies by cause. */
const RECORD_NAMES = {
  reviews: "The review",
  findings: "The finding",
  comments: "The comment",
} as const;

/**
 * Runs a generated validator over a request body.
 *
 * The refusal names the first offending path, because a caller that sent
 * geometry in CSS pixels needs to be told which field was wrong rather than
 * that "the body did not validate".
 */
function decode<T>(validate: Validator, body: unknown, what: string): T {
  const violations: SchemaViolation[] = [];
  validate(body, "$", violations);
  if (violations.length === 0) return body as T;
  const first = violations[0] as SchemaViolation;
  throw new ApiError(
    "UNSUPPORTED_CAPABILITY",
    `${what}: ${first.path} ${first.message}`,
    { field: first.path },
  );
}

export async function registerReviewRoutes(
  app: FastifyInstance,
  options: ReviewRoutesOptions,
): Promise<void> {
  const { pool, reviews } = options;

  /**
   * Refuses a machine credential on these human routes, by token shape and
   * before any lookup (`docs/SECURITY.md` sections 6.3 and 7).
   *
   * It matters most for `POST /api/v1/findings/:findingId/accept`. An agent
   * credential must not reach the acceptance decision through any interface,
   * and answering "sign in" there would report the request as unauthenticated
   * when it authenticated perfectly well and is simply not allowed. The domain
   * layer refuses the same act again for an `agent_session` actor arriving
   * through MCP, and records `finding.status_change_denied` when it does; this
   * is the transport half of the same rule.
   */
  const refuseMachineCredentials = (request: FastifyRequest): void => {
    const actor = actorOf(request);
    if (actor.type !== "agent" && actor.type !== "browser_worker") return;
    request.log.warn(
      { route: request.url, actor: actor.type },
      "review route refused a machine credential",
    );
    throw new ApiError(
      "AUTHORISATION_DENIED",
      actor.type === "agent"
        ? "An agent credential is not a human session and cannot call the review API (docs/SECURITY.md section 6.3). Agents act through /mcp/v1, where the acceptance authority rule is enforced again in the domain layer."
        : "A browser-worker credential is not a human session and cannot call the review API.",
      { reason: "machine_credential_on_human_route" },
    );
  };

  /**
   * The scope a viewer may act in for one project.
   *
   * `resolveProject` is the shared predicate of
   * `modules/identity/authorisation.ts`: the identifier, the session's project
   * scope and the session's **organisation** in one `WHERE` clause. This handler
   * used to read `SELECT organisation_id FROM projects WHERE id = $1` and build
   * the scope from whatever came back, which meant the organisation term existed
   * on the row and was never compared to the caller's — an organisation-wide
   * session, which is what every real sign-in issues, reached another
   * organisation's project.
   */
  const scopeForProject = async (
    request: FastifyRequest,
    projectId: string,
    intent: Intent,
  ): Promise<{ scope: Scope; actor: EventActor }> => {
    refuseMachineCredentials(request);
    const principal = await options.viewerAuth(request);
    // Before the project is resolved and before the body is decoded, so a
    // forged request is refused rather than answered with a validation error.
    if (intent === "write") requireCsrfToken(request, principal);
    const project = await resolveProject(pool, principal, projectId);
    return {
      scope: { organisationId: project.organisationId, projectId: project.id },
      actor: humanActor(principal),
    };
  };

  /**
   * The scope for a record reached by its own identifier, resolved in **one**
   * query that carries the identifier, the session's project scope and the
   * session's organisation together.
   *
   * This is the pattern `docs/SECURITY.md` section 7 requires, and it is now the
   * **only** way a route here reaches a record by identifier. There used to be a
   * second helper that read the row first and compared the project afterwards,
   * and it had two defects that a second helper will always eventually have:
   *
   *   * it answered `PROJECT_CONTEXT_MISMATCH` for a foreign identifier where an
   *     unknown one got `RESOURCE_NOT_FOUND`, which is an existence oracle for
   *     another tenant's identifiers (RVP-67); and
   *   * it built the scope from **the row's own** `organisation_id` rather than
   *     the caller's, so the organisation term was present and vacuous. Every
   *     real sign-in issues an organisation-wide session (`projectIds: null`),
   *     for which the project check also passes unconditionally — so a signed-in
   *     user of one organisation could read *and write* another's reviews,
   *     findings and annotations. That was proved live against two
   *     organisations (RVP-66 criterion 4).
   *
   * The organisation comes from the authenticated principal and never from the
   * record. A null organisation means the ADR-0016 bootstrap administrator,
   * which is deployment-wide by construction; every account session carries a
   * real one. A row that fails any part of the predicate is simply not returned,
   * so foreign and unknown produce the same refusal byte for byte.
   *
   * The CSRF guard runs before the lookup and before any body is decoded, so a
   * forged request is refused without touching the record it named.
   */
  const scopedRecord = async (
    request: FastifyRequest,
    table: "reviews" | "findings" | "comments",
    id: string,
    intent: Intent,
  ): Promise<{ scope: Scope; actor: EventActor; row: ScopedRow }> => {
    refuseMachineCredentials(request);
    const principal = await options.viewerAuth(request);
    if (intent === "write") requireCsrfToken(request, principal);
    const rows = await pool.query<ScopedRow>(
      `SELECT organisation_id, project_id, ${SCOPED_REVIEW_COLUMN[table]} AS review_id
         FROM ${table}
        WHERE id = $1
          AND ($2::text[] IS NULL OR project_id = ANY($2))
          AND ($3::text IS NULL OR organisation_id = $3)`,
      [id, scopeParameter(principal), principal.organisationId],
    );
    const row = rows.rows[0];
    // One refusal for "unknown" and for "another project's", so the pair
    // discloses nothing (`docs/SECURITY.md` section 7).
    if (row === undefined) throw notFound(RECORD_NAMES[table]);
    return {
      scope: { organisationId: row.organisation_id, projectId: row.project_id },
      actor: humanActor(principal),
      row,
    };
  };

  const send = (reply: FastifyReply, request: FastifyRequest, data: unknown, status = 200) =>
    reply.status(status).send({ data, meta: { request_id: request.id } });

  // ---------------------------------------------------------------- reviews

  app.post("/api/v1/projects/:projectId/reviews", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { scope, actor } = await scopeForProject(request, projectId, "write");
    const body = decode<ReviewCreateRequest>(
      validateReviewCreateRequest,
      request.body,
      "the review could not be created",
    );
    const review = await reviews.createReview(
      scope,
      {
        slug: body.slug,
        title: body.title,
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.status === undefined ? {} : { status: body.status }),
        ...(body.priority === undefined ? {} : { priority: body.priority }),
        capturedBranch: body.captured_branch,
        capturedCommit: body.captured_commit,
        capturedWorkspaceId: body.captured_workspace_id,
        sourceBrowserSessionId: body.source_browser_session_id,
      },
      actor,
    );
    return send(reply, request, review, 201);
  });

  app.get("/api/v1/projects/:projectId/reviews", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { scope } = await scopeForProject(request, projectId, "read");
    const query = request.query as { slug?: string };
    if (query.slug !== undefined) {
      // The named lookup an agent uses. It searches active reviews only, so a
      // cancelled review's released name never shadows the live one.
      return send(reply, request, [await reviews.getReviewBySlug(scope, query.slug)]);
    }
    const page = readPageRequest(request.query);
    // One extra row is read so that `next_cursor` is absent on the last page
    // rather than present and pointing at nothing (`docs/API.md` section 6).
    const rows = await reviews.listReviewsPage(scope, {
      limit: page.limit + 1,
      after: page.after,
    });
    const built = buildPage([...rows.items], page, (review) => ({
      sortKey: review.created_at,
      id: review.id,
    }));
    return reply
      .status(200)
      .send({ data: built.items, meta: pageMeta(request.id, built.nextCursor) });
  });

  app.get("/api/v1/reviews/:reviewId", async (request, reply) => {
    const { reviewId } = request.params as { reviewId: string };
    const { scope } = await scopedRecord(request, "reviews", reviewId, "read");
    return send(reply, request, await reviews.getReview(scope, reviewId));
  });

  app.patch("/api/v1/reviews/:reviewId", async (request, reply) => {
    const { reviewId } = request.params as { reviewId: string };
    const { scope, actor } = await scopedRecord(request, "reviews", reviewId, "write");
    const body = decode<ReviewUpdateRequest>(
      validateReviewUpdateRequest,
      request.body,
      "the review could not be updated",
    );
    const review = await reviews.updateReview(
      scope,
      reviewId,
      {
        expectedVersion: body.expected_version,
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.slug === undefined ? {} : { slug: body.slug }),
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.status === undefined ? {} : { status: body.status }),
        ...(body.priority === undefined ? {} : { priority: body.priority }),
      },
      actor,
    );
    return send(reply, request, review);
  });

  app.post("/api/v1/reviews/:reviewId/assign", async (request, reply) => {
    const { reviewId } = request.params as { reviewId: string };
    const { scope, actor } = await scopedRecord(request, "reviews", reviewId, "write");
    const body = decode<ReviewAssignRequest>(
      validateReviewAssignRequest,
      request.body,
      "the review could not be assigned",
    );
    const review = await reviews.assignReview(
      scope,
      reviewId,
      {
        expectedVersion: body.expected_version,
        ...(body.assigned_user_id === undefined
          ? {}
          : { assignedUserId: body.assigned_user_id }),
        ...(body.assigned_agent_session_id === undefined
          ? {}
          : { assignedAgentSessionId: body.assigned_agent_session_id }),
        ...(body.reason === undefined ? {} : { reason: body.reason }),
      },
      actor,
    );
    return send(reply, request, review);
  });

  /**
   * The four lifecycle routes. Each fixes its own target status, so a caller
   * cannot ask one route for another's transition, and each goes through the
   * one domain path that checks version, legality and authority in that order.
   */
  const lifecycleRoute = (
    path: string,
    apply: (
      scope: Scope,
      reviewId: string,
      input: { expectedVersion: number; reason?: string },
      actor: EventActor,
    ) => Promise<unknown>,
    what: string,
  ): void => {
    app.post(path, async (request, reply) => {
      const { reviewId } = request.params as { reviewId: string };
      const { scope, actor } = await scopedRecord(request, "reviews", reviewId, "write");
      const body = decode<ReviewTransitionRequest>(
        validateReviewTransitionRequest,
        request.body,
        what,
      );
      const review = await apply(
        scope,
        reviewId,
        {
          expectedVersion: body.expected_version,
          ...(body.reason === undefined ? {} : { reason: body.reason }),
        },
        actor,
      );
      return send(reply, request, review);
    });
  };

  lifecycleRoute(
    "/api/v1/reviews/:reviewId/request-review",
    (scope, id, input, actor) => reviews.requestHumanReview(scope, id, input, actor),
    "the review could not be submitted for human review",
  );
  lifecycleRoute(
    "/api/v1/reviews/:reviewId/accept",
    (scope, id, input, actor) => reviews.acceptReview(scope, id, input, actor),
    "the review could not be accepted",
  );
  lifecycleRoute(
    "/api/v1/reviews/:reviewId/reopen",
    (scope, id, input, actor) => reviews.reopenReview(scope, id, input, actor),
    "the review could not be reopened",
  );
  lifecycleRoute(
    "/api/v1/reviews/:reviewId/archive",
    (scope, id, input, actor) => reviews.archiveReview(scope, id, input, actor),
    "the review could not be archived",
  );

  /**
   * Requests an export and reports the current one
   * (`docs/API.md` section 12, `docs/REVIEW_FORMAT.md`).
   *
   * `GET` is the documented shape, and it changes state the first time it is
   * called, so it applies the write guard: the export is a durable job that
   * produces a stored artefact, and a route that queues work is a route another
   * origin must not be able to make a browser call. A second call while a run is
   * in flight joins that run rather than queueing another.
   */
  app.get("/api/v1/reviews/:reviewId/export", async (request, reply) => {
    const { reviewId } = request.params as { reviewId: string };
    const { scope, actor } = await scopedRecord(request, "reviews", reviewId, "write");
    const existing = await reviews.latestExport(scope, reviewId);
    if (existing !== null && existing.status !== "failed") {
      return send(reply, request, existing);
    }
    return send(reply, request, await reviews.requestExport(scope, reviewId, actor), 202);
  });

  // -------------------------------------------------------- review comments

  app.post("/api/v1/reviews/:reviewId/comments", async (request, reply) => {
    const { reviewId } = request.params as { reviewId: string };
    const { scope, actor } = await scopedRecord(request, "reviews", reviewId, "write");
    const body = decode<CommentCreateRequest>(
      validateCommentCreateRequest,
      request.body,
      "the comment could not be added",
    );
    return send(
      reply,
      request,
      await reviews.addReviewComment(scope, reviewId, body.body, actor),
      201,
    );
  });

  app.get("/api/v1/reviews/:reviewId/comments", async (request, reply) => {
    const { reviewId } = request.params as { reviewId: string };
    const { scope } = await scopedRecord(request, "reviews", reviewId, "read");
    const query = request.query as { revisions?: string };
    return send(
      reply,
      request,
      await reviews.listCommentsFor(
        scope,
        { reviewId },
        { revisions: query.revisions === "all" ? "all" : "current" },
      ),
    );
  });

  app.patch("/api/v1/comments/:commentId", async (request, reply) => {
    const { commentId } = request.params as { commentId: string };
    const { scope, actor } = await scopedRecord(request, "comments", commentId, "write");
    const body = decode<CommentUpdateRequest>(
      validateCommentUpdateRequest,
      request.body,
      "the comment could not be edited",
    );
    return send(reply, request, await reviews.editComment(scope, commentId, body.body, actor));
  });

  // --------------------------------------------------------------- findings

  app.post("/api/v1/reviews/:reviewId/findings", async (request, reply) => {
    const { reviewId } = request.params as { reviewId: string };
    const { scope, actor } = await scopedRecord(request, "reviews", reviewId, "write");
    const body = decode<FindingCreateRequest>(
      validateFindingCreateRequest,
      request.body,
      "the finding could not be created",
    );
    const created = await reviews.createFinding(
      scope,
      reviewId,
      {
        title: body.title,
        ...(body.description === undefined ? {} : { description: body.description }),
        severity: body.severity,
        // No `source`: the schema has no such field and the service derives it
        // from the authenticated actor, so a client cannot forge a
        // human-authored finding or relabel its own (`docs/DOMAIN_MODEL.md`
        // section 15). A body that supplies one is refused by the validator as
        // an unknown property before this handler runs.
        url: body.url,
        viewport: body.viewport as unknown as Record<string, unknown>,
        scrollPosition: body.scroll_position as unknown as Record<string, unknown>,
        capturedCommit: body.captured_commit,
        screenshotArtefactId: body.screenshot_artefact_id,
        ...(body.element_context === undefined
          ? {}
          : { elementContext: body.element_context as unknown as Record<string, unknown> }),
        ...(body.acceptance_criteria === undefined
          ? {}
          : { acceptanceCriteria: body.acceptance_criteria }),
        ...(body.annotations === undefined
          ? {}
          : { annotations: body.annotations.map(toAnnotationInput) }),
      },
      actor,
    );
    return send(reply, request, created, 201);
  });

  app.get("/api/v1/reviews/:reviewId/findings", async (request, reply) => {
    const { reviewId } = request.params as { reviewId: string };
    const { scope } = await scopedRecord(request, "reviews", reviewId, "read");
    return send(reply, request, await reviews.listFindings(scope, reviewId));
  });

  app.get("/api/v1/findings/:findingId", async (request, reply) => {
    const { findingId } = request.params as { findingId: string };
    const { scope } = await scopedRecord(request, "findings", findingId, "read");
    return send(reply, request, await reviews.getFinding(scope, findingId));
  });

  app.patch("/api/v1/findings/:findingId", async (request, reply) => {
    const { findingId } = request.params as { findingId: string };
    const { scope, actor } = await scopedRecord(request, "findings", findingId, "write");
    const body = decode<FindingUpdateRequest>(
      validateFindingUpdateRequest,
      request.body,
      "the finding could not be updated",
    );
    const finding = await reviews.updateFinding(
      scope,
      findingId,
      {
        expectedVersion: body.expected_version,
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.severity === undefined ? {} : { severity: body.severity }),
        ...(body.status === undefined ? {} : { status: body.status }),
        ...(body.acceptance_criteria === undefined
          ? {}
          : { acceptanceCriteria: body.acceptance_criteria }),
        ...(body.resolution_note === undefined
          ? {}
          : { resolutionNote: body.resolution_note }),
      },
      actor,
    );
    return send(reply, request, finding);
  });

  app.post("/api/v1/findings/:findingId/claim", async (request, reply) => {
    const { findingId } = request.params as { findingId: string };
    const { scope, actor } = await scopedRecord(request, "findings", findingId, "write");
    const body = decode<FindingClaimRequest>(
      validateFindingClaimRequest,
      request.body,
      "the finding could not be claimed",
    );
    return send(
      reply,
      request,
      await reviews.claimFinding(scope, findingId, body.expected_version, actor),
    );
  });

  /**
   * The three human-only dispositions of `docs/API.md` section 13.
   *
   * Nothing about these handlers enforces "human only". The refusal is in
   * `assertActorMayMoveFinding`, below the transport, so an agent credential
   * reaching the same command through MCP or a future internal job is refused
   * by the same rule and audited the same way. A check placed here would be a
   * property of this route rather than of the domain, which is exactly what
   * this issue's exit criterion forbids.
   */
  const dispositionRoute = (
    path: string,
    apply: (
      scope: Scope,
      findingId: string,
      body: FindingTransitionRequest,
      actor: EventActor,
    ) => Promise<unknown>,
    what: string,
  ): void => {
    app.post(path, async (request, reply) => {
      const { findingId } = request.params as { findingId: string };
      const { scope, actor } = await scopedRecord(request, "findings", findingId, "write");
      const body = decode<FindingTransitionRequest>(
        validateFindingTransitionRequest,
        request.body,
        what,
      );
      return send(reply, request, await apply(scope, findingId, body, actor));
    });
  };

  dispositionRoute(
    "/api/v1/findings/:findingId/accept",
    (scope, id, body, actor) =>
      reviews.disposeFinding(
        scope,
        id,
        "RESOLVED",
        {
          expectedVersion: body.expected_version,
          ...(body.reason === undefined ? {} : { reason: body.reason }),
        },
        actor,
      ),
    "the finding could not be accepted",
  );

  dispositionRoute(
    "/api/v1/findings/:findingId/wont-fix",
    (scope, id, body, actor) =>
      reviews.disposeFinding(
        scope,
        id,
        body.duplicate_of_finding_id === undefined ? "WONT_FIX" : "DUPLICATE",
        {
          expectedVersion: body.expected_version,
          ...(body.reason === undefined ? {} : { reason: body.reason }),
          ...(body.duplicate_of_finding_id === undefined
            ? {}
            : { duplicateOfFindingId: body.duplicate_of_finding_id }),
        },
        actor,
      ),
    "the finding could not be waived",
  );

  dispositionRoute(
    "/api/v1/findings/:findingId/reopen",
    (scope, id, body, actor) =>
      reviews.reopenFinding(
        scope,
        id,
        {
          expectedVersion: body.expected_version,
          ...(body.reason === undefined ? {} : { reason: body.reason }),
        },
        actor,
      ),
    "the finding could not be reopened",
  );

  app.post("/api/v1/findings/:findingId/comments", async (request, reply) => {
    const { findingId } = request.params as { findingId: string };
    const { scope, actor } = await scopedRecord(request, "findings", findingId, "write");
    const body = decode<CommentCreateRequest>(
      validateCommentCreateRequest,
      request.body,
      "the comment could not be added",
    );
    return send(reply, request, await reviews.addComment(scope, findingId, body.body, actor), 201);
  });

  app.get("/api/v1/findings/:findingId/comments", async (request, reply) => {
    const { scope, row } = await scopedRecord(
      request,
      "findings",
      (request.params as { findingId: string }).findingId,
      "read",
    );
    const query = request.query as { revisions?: string };
    return send(
      reply,
      request,
      await reviews.listCommentsFor(
        scope,
        { reviewId: row.review_id, findingId: (request.params as { findingId: string }).findingId },
        { revisions: query.revisions === "all" ? "all" : "current" },
      ),
    );
  });

  // ------------------------------------------------------------ annotations

  app.post("/api/v1/findings/:findingId/annotations", async (request, reply) => {
    const { findingId } = request.params as { findingId: string };
    const { scope, actor } = await scopedRecord(request, "findings", findingId, "write");
    const body = decode<AnnotationCreateRequest>(
      validateAnnotationCreateRequest,
      request.body,
      "the annotation could not be created",
    );
    const annotation = await reviews.createAnnotation(
      scope,
      findingId,
      toAnnotationInput(body),
      actor,
    );
    return send(reply, request, annotation, 201);
  });

  app.get("/api/v1/findings/:findingId/annotations", async (request, reply) => {
    const { findingId } = request.params as { findingId: string };
    const { scope } = await scopedRecord(request, "findings", findingId, "read");
    const query = request.query as { revisions?: string };
    const list =
      query.revisions === "all"
        ? await reviews.listAnnotationRevisions(scope, findingId)
        : await reviews.listAnnotations(scope, findingId);
    return send(reply, request, list);
  });
}

function toAnnotationInput(body: AnnotationCreateRequest): CreateAnnotationInput {
  return {
    artefactId: body.artefact_id,
    type: body.type,
    geometry: body.geometry as unknown as Record<string, unknown>,
    label: body.label,
    ...(body.marker_number === undefined ? {} : { markerNumber: body.marker_number }),
    ...(body.style_hint === undefined ? {} : { styleHint: body.style_hint }),
  };
}

/** The human behind a viewer session (`docs/EVENTS.md` section 5). */
function humanActor(principal: ViewerPrincipal): EventActor {
  return { type: "human_user", id: principal.viewerSessionId, display: principal.display };
}
