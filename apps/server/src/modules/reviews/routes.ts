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
  validateAnnotationUpdateRequest,
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
  validateVerificationCreateRequest,
  type AnnotationCreateRequest,
  type AnnotationUpdateRequest,
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
  type VerificationCreateRequest,
} from "@reviewplane/protocol/review";

import { ApiError, notFound } from "../../errors.ts";
import type { EventActor } from "../../events/append.ts";
import { IdempotencyStore, requestDigest } from "../agents/idempotency.ts";
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

/**
 * Where each scoped record is read from, and which column names its review.
 *
 * The `FROM` clause varies and the `WHERE` clause does not, which is the point:
 * every record type is reached by the same three-term predicate, so there is
 * one place a tenancy term could be forgotten rather than one per table.
 *
 * An annotation is read through `annotations_current` rather than through
 * `annotations`, because the base table holds one row per revision and a
 * lookup by identifier there would answer with as many rows as the annotation
 * has ever had. Its review comes from the finding that owns it, which is the
 * only join here and exists because an annotation carries no review column of
 * its own.
 */
const SCOPED_SOURCE = {
  reviews: { from: "reviews AS record", reviewId: "record.id" },
  findings: { from: "findings AS record", reviewId: "record.review_id" },
  comments: { from: "comments AS record", reviewId: "record.review_id" },
  annotations: {
    from: "annotations_current AS record JOIN findings AS owner ON owner.id = record.finding_id",
    reviewId: "owner.review_id",
  },
} as const;

/** What a refusal calls each record. The wording never varies by cause. */
const RECORD_NAMES = {
  reviews: "The review",
  findings: "The finding",
  comments: "The comment",
  annotations: "The annotation",
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
    table: keyof typeof SCOPED_SOURCE,
    id: string,
    intent: Intent,
  ): Promise<{ scope: Scope; actor: EventActor; row: ScopedRow }> => {
    refuseMachineCredentials(request);
    const principal = await options.viewerAuth(request);
    if (intent === "write") requireCsrfToken(request, principal);
    const source = SCOPED_SOURCE[table];
    const rows = await pool.query<ScopedRow>(
      `SELECT record.organisation_id, record.project_id, ${source.reviewId} AS review_id
         FROM ${source.from}
        WHERE record.id = $1
          AND ($2::text[] IS NULL OR record.project_id = ANY($2))
          AND ($3::text IS NULL OR record.organisation_id = $3)`,
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

  const idempotency = new IdempotencyStore(pool);

  /**
   * Runs a creation under an optional `Idempotency-Key`.
   *
   * The capture flow of `docs/UX_FLOWS.md` §9 is the reason this exists. A
   * human presses Save once; a flaky connection, a double tap or a retry can
   * make the control plane see that press twice, and two identical findings
   * with two identical screenshots is a review nobody can read. Without a key
   * there is no natural one to deduplicate on — two people may legitimately
   * report the same problem — so the client names the attempt and the server
   * honours the name.
   *
   * A replay answers `200` with the first response rather than `201`, so the
   * caller can tell that it did not create anything this time. A key reused
   * with a *different* body is refused with `IDEMPOTENCY_CONFLICT`: reusing a
   * key for another request is a client defect, and answering with the first
   * result would silently discard the second.
   *
   * The key is scoped by project, actor and tool, so one caller's key cannot
   * collide with another's, and a key learned from a log cannot be replayed by
   * a different actor.
   */
  const underIdempotencyKey = async <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    scope: Scope,
    actor: EventActor,
    tool: string,
    work: () => Promise<T>,
  ): Promise<{ replayed: true } | { replayed: false; data: T }> => {
    const header = request.headers["idempotency-key"];
    const key = typeof header === "string" && header !== "" ? header : null;
    if (key === null) return { replayed: false, data: await work() };
    const keyScope = {
      projectId: scope.projectId,
      actorType: actor.type,
      // The bootstrap administrator has no viewer-session identifier
      // (ADR-0016), and a constant is the honest stand-in: it is one actor.
      actorId: actor.id ?? "bootstrap",
      tool,
      key,
    };
    const claimed = await idempotency.claim(keyScope, requestDigest(request.body ?? null));
    if (claimed.replayed) {
      await reply.status(200).send({ data: claimed.response, meta: { request_id: request.id } });
      return { replayed: true };
    }
    try {
      const data = await work();
      await idempotency.complete(keyScope, data);
      return { replayed: false, data };
    } catch (error) {
      // A refused attempt releases the key. Holding it would make the first
      // failure permanent for a day: a caller that fixed a slug collision and
      // retried with the same key would be replayed its own refusal.
      await idempotency.release(keyScope).catch(() => undefined);
      throw error;
    }
  };

  // ---------------------------------------------------------------- reviews

  app.post("/api/v1/projects/:projectId/reviews", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { scope, actor } = await scopeForProject(request, projectId, "write");
    const body = decode<ReviewCreateRequest>(
      validateReviewCreateRequest,
      request.body,
      "the review could not be created",
    );
    const outcome = await underIdempotencyKey(
      request,
      reply,
      scope,
      actor,
      "review_create",
      async () =>
        reviews.createReview(
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
        ),
    );
    if (outcome.replayed) return reply;
    return send(reply, request, outcome.data, 201);
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
    const outcome = await underIdempotencyKey(
      request,
      reply,
      scope,
      actor,
      "finding_create",
      async () =>
        reviews.createFinding(
          scope,
          reviewId,
          {
            title: body.title,
            ...(body.description === undefined ? {} : { description: body.description }),
            severity: body.severity,
            // No `source`: the schema has no such field and the service derives
            // it from the authenticated actor, so a client cannot forge a
            // human-authored finding or relabel its own (`docs/DOMAIN_MODEL.md`
            // section 15). A body that supplies one is refused by the validator
            // as an unknown property before this handler runs.
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
        ),
    );
    if (outcome.replayed) return reply;
    return send(reply, request, outcome.data, 201);
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

  /**
   * The latest verification for a finding, or null (`docs/API.md` §13).
   *
   * The artefact viewer needs it: the before-and-after comparison of
   * `docs/UX_FLOWS.md` §17 is a pair of artefact identifiers, and this is where
   * they are recorded (`docs/DOMAIN_MODEL.md` §19). It is read-only and resolves
   * through `scopedRecord` like every other route here, so the caller's own
   * organisation is part of the lookup rather than taken from the row;
   * submitting a verification is a separate change.
   */
  app.get("/api/v1/findings/:findingId/verification", async (request, reply) => {
    const { findingId } = request.params as { findingId: string };
    const { scope } = await scopedRecord(request, "findings", findingId, "read");
    return send(reply, request, await reviews.latestVerification(scope, findingId));
  });

  /**
   * Every verification a finding has accumulated, newest first
   * (`docs/API.md` §13, `docs/DOMAIN_MODEL.md` §19).
   *
   * A superseded record is kept rather than deleted, and a finding may
   * accumulate several across reopen cycles. The comparison UI needs the
   * current one; anybody judging *whether the same thing has been claimed
   * before* needs the rest, and a route that served only the latest would make
   * a repeatedly-reopened finding look like a first attempt every time.
   */
  app.get("/api/v1/findings/:findingId/verifications", async (request, reply) => {
    const { findingId } = request.params as { findingId: string };
    const { scope } = await scopedRecord(request, "findings", findingId, "read");
    return send(reply, request, await reviews.listVerifications(scope, findingId));
  });

  /**
   * Submits a verification: a claim with evidence, never a resolution
   * (`docs/API.md` §13, `docs/MCP_SPEC.md` §7.7, `docs/DOMAIN_MODEL.md` §19).
   *
   * The body has **no `submitted_by` and no `status`**. Both are derived: the
   * submitter is the authenticated actor and the status is always `submitted`,
   * so a caller cannot forge an attribution and cannot record the human
   * decision that a verification is accepted. A body supplying either is
   * refused as an unknown property by the generated validator, before any
   * handler runs.
   *
   * The route is on the human API, which refuses an agent credential at the
   * transport by token shape (`docs/SECURITY.md` §6.3). A human submitting
   * verification for work they did themselves is an ordinary act and is what
   * this route is for; the agent's path is `finding_submit_verification` on
   * `/mcp/v1`, and both reach the same domain method with the same checks.
   */
  app.post("/api/v1/findings/:findingId/verifications", async (request, reply) => {
    const { findingId } = request.params as { findingId: string };
    const { scope, actor } = await scopedRecord(request, "findings", findingId, "write");
    const body = decode<VerificationCreateRequest>(
      validateVerificationCreateRequest,
      request.body,
      "the verification could not be submitted",
    );
    const submitted = await reviews.submitVerification(
      scope,
      findingId,
      {
        summary: body.summary,
        branch: body.branch,
        commit: body.commit,
        testedViewports: body.tested_viewports,
        checks: body.checks,
        artefactIds: body.artefact_ids,
        // No workspace is resolved on the human API: a person submitting from a
        // browser has no registered workspace to corroborate a branch against,
        // so the branch is recorded uncorroborated rather than checked against
        // something that is not there (`docs/MCP_SPEC.md` §7.7).
        workspaceBranch: null,
        ...(body.expected_version === undefined
          ? {}
          : { expectedVersion: body.expected_version }),
      },
      actor,
    );
    return send(reply, request, submitted.verification, 201);
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

  /**
   * Edits one annotation (`docs/API.md` §14).
   *
   * The edit appends a revision and retains the one it supersedes. Nothing
   * here touches the screenshot: the original artefact bytes are immutable
   * evidence and the overlay is a separate record (ADR-0006), so an annotation
   * can be redrawn a dozen times without the picture underneath changing at
   * all.
   *
   * The body carries no `type` and no `artefact_id`, so there is no field a
   * caller could use to point an annotation's history at a different mark or a
   * different screenshot. Geometry is validated against the annotation's own
   * stored type rather than against one the request named, which is the same
   * rule as everywhere else here: an authority input is never read out of the
   * record being authorised, and a shape input is never read out of the
   * request being validated.
   */
  app.patch("/api/v1/annotations/:annotationId", async (request, reply) => {
    const { annotationId } = request.params as { annotationId: string };
    const { scope, actor } = await scopedRecord(request, "annotations", annotationId, "write");
    const body = decode<AnnotationUpdateRequest>(
      validateAnnotationUpdateRequest,
      request.body,
      "the annotation could not be edited",
    );
    const annotation = await reviews.updateAnnotation(
      scope,
      annotationId,
      {
        expectedRevision: body.expected_revision,
        ...(body.geometry === undefined
          ? {}
          : { geometry: body.geometry as unknown as Record<string, unknown> }),
        ...(body.label === undefined ? {} : { label: body.label }),
        ...(body.marker_number === undefined ? {} : { markerNumber: body.marker_number }),
        ...(body.style_hint === undefined ? {} : { styleHint: body.style_hint }),
      },
      actor,
    );
    return send(reply, request, annotation);
  });

  /**
   * Withdraws one annotation (`docs/API.md` §14).
   *
   * It records a revision carrying `deleted_at` rather than issuing a `DELETE`.
   * The current projection hides the mark and `?revisions=all` still shows
   * every revision it had, because a reader asking why a finding was raised
   * has to be able to see the mark that was on the screen when somebody raised
   * it — including one its author later thought better of.
   *
   * The expected revision travels in the query string rather than in a body,
   * because a `DELETE` with a body is not reliably carried by intermediaries.
   * Withdrawing an already-withdrawn annotation answers with the withdrawal
   * rather than refusing: the caller asked for a state the record is already
   * in.
   */
  app.delete("/api/v1/annotations/:annotationId", async (request, reply) => {
    const { annotationId } = request.params as { annotationId: string };
    const { scope, actor } = await scopedRecord(request, "annotations", annotationId, "write");
    const query = request.query as { expected_revision?: string };
    const expected = Number(query.expected_revision);
    if (!Number.isInteger(expected) || expected < 1) {
      throw new ApiError(
        "VALIDATION_FAILED",
        "expected_revision is required on a withdrawal and must be the revision the caller read, so a concurrent edit is refused rather than silently withdrawn.",
        { field: "expected_revision" },
      );
    }
    const annotation = await reviews.withdrawAnnotation(scope, annotationId, expected, actor);
    return send(reply, request, annotation);
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
