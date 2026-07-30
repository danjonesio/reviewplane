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
 * Authorisation is the viewer session of ADR-0016. Every route resolves the
 * owning project before it reads anything, and every query below it carries
 * both the organisation and the project (`docs/DOMAIN_MODEL.md` section 3).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import {
  validateAnnotationCreateRequest,
  validateFindingCreateRequest,
  validateFindingUpdateRequest,
  validateReviewCreateRequest,
  validateReviewUpdateRequest,
  type AnnotationCreateRequest,
  type FindingCreateRequest,
  type FindingUpdateRequest,
  type ReviewCreateRequest,
  type ReviewUpdateRequest,
  type SchemaViolation,
} from "@reviewplane/protocol/review";

import { ApiError, notFound } from "../../errors.ts";
import type { EventActor } from "../../events/append.ts";
import {
  authorisedForProject,
  type ViewerPrincipal,
} from "../live/viewer-sessions.ts";
import type { CreateAnnotationInput, Scope } from "./service.ts";
import type { ReviewService } from "./service.ts";

export interface ReviewRoutesOptions {
  readonly pool: Pool;
  readonly reviews: ReviewService;
  readonly viewerAuth: (request: FastifyRequest) => Promise<ViewerPrincipal>;
}

type Validator = (value: unknown, path: string, out: SchemaViolation[]) => void;

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

  /** The scope a viewer may act in for one project. */
  const scopeForProject = async (
    request: FastifyRequest,
    projectId: string,
  ): Promise<{ scope: Scope; actor: EventActor }> => {
    const principal = await options.viewerAuth(request);
    if (!authorisedForProject(principal, projectId)) {
      throw new ApiError(
        "PROJECT_CONTEXT_MISMATCH",
        "This viewer session is not authorised for that project.",
      );
    }
    const rows = await pool.query<{ organisation_id: string }>(
      "SELECT organisation_id FROM projects WHERE id = $1",
      [projectId],
    );
    const row = rows.rows[0];
    if (row === undefined) throw notFound("The project");
    return {
      scope: { organisationId: row.organisation_id, projectId },
      actor: humanActor(principal),
    };
  };

  /**
   * The scope for a record reached by its own identifier.
   *
   * The owning project is read first and the viewer is authorised against it
   * before any field of the record is returned, so a cross-project identifier
   * yields a refusal rather than data.
   */
  const scopeForRecord = async (
    request: FastifyRequest,
    table: "reviews" | "findings",
    id: string,
  ): Promise<{ scope: Scope; actor: EventActor }> => {
    const rows = await pool.query<{ organisation_id: string; project_id: string }>(
      `SELECT organisation_id, project_id FROM ${table} WHERE id = $1`,
      [id],
    );
    const row = rows.rows[0];
    if (row === undefined) throw notFound(table === "reviews" ? "The review" : "The finding");
    const principal = await options.viewerAuth(request);
    if (!authorisedForProject(principal, row.project_id)) {
      throw new ApiError(
        "PROJECT_CONTEXT_MISMATCH",
        "This viewer session is not authorised for the project that owns this record.",
      );
    }
    return {
      scope: { organisationId: row.organisation_id, projectId: row.project_id },
      actor: humanActor(principal),
    };
  };

  const send = (reply: FastifyReply, request: FastifyRequest, data: unknown, status = 200) =>
    reply.status(status).send({ data, meta: { request_id: request.id } });

  // ---------------------------------------------------------------- reviews

  app.post("/api/v1/projects/:projectId/reviews", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { scope, actor } = await scopeForProject(request, projectId);
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
    const { scope } = await scopeForProject(request, projectId);
    const query = request.query as { slug?: string };
    if (query.slug !== undefined) {
      return send(reply, request, [await reviews.getReviewBySlug(scope, query.slug)]);
    }
    return send(reply, request, await reviews.listReviews(scope));
  });

  app.get("/api/v1/reviews/:reviewId", async (request, reply) => {
    const { reviewId } = request.params as { reviewId: string };
    const { scope } = await scopeForRecord(request, "reviews", reviewId);
    return send(reply, request, await reviews.getReview(scope, reviewId));
  });

  app.patch("/api/v1/reviews/:reviewId", async (request, reply) => {
    const { reviewId } = request.params as { reviewId: string };
    const { scope, actor } = await scopeForRecord(request, "reviews", reviewId);
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
      },
      actor,
    );
    return send(reply, request, review);
  });

  // --------------------------------------------------------------- findings

  app.post("/api/v1/reviews/:reviewId/findings", async (request, reply) => {
    const { reviewId } = request.params as { reviewId: string };
    const { scope, actor } = await scopeForRecord(request, "reviews", reviewId);
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
        source: body.source,
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
    const { scope } = await scopeForRecord(request, "reviews", reviewId);
    return send(reply, request, await reviews.listFindings(scope, reviewId));
  });

  app.get("/api/v1/findings/:findingId", async (request, reply) => {
    const { findingId } = request.params as { findingId: string };
    const { scope } = await scopeForRecord(request, "findings", findingId);
    return send(reply, request, await reviews.getFinding(scope, findingId));
  });

  app.patch("/api/v1/findings/:findingId", async (request, reply) => {
    const { findingId } = request.params as { findingId: string };
    const { scope, actor } = await scopeForRecord(request, "findings", findingId);
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

  // ------------------------------------------------------------ annotations

  app.post("/api/v1/findings/:findingId/annotations", async (request, reply) => {
    const { findingId } = request.params as { findingId: string };
    const { scope, actor } = await scopeForRecord(request, "findings", findingId);
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
    const { scope } = await scopeForRecord(request, "findings", findingId);
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
