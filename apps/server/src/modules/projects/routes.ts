/**
 * Organisation and project endpoints (`docs/API.md` sections 7 and 8).
 *
 * ```text
 * GET    /api/v1/projects                       projects this session may see
 * POST   /api/v1/projects                       create one
 * GET    /api/v1/projects/:projectId            read one
 * PATCH  /api/v1/projects/:projectId            change one
 * DELETE /api/v1/projects/:projectId            archive one
 * GET    /api/v1/projects/:projectId/activity   its event timeline
 * ```
 *
 * Reads are available to any human session, filtered by its scope. Writes are
 * organisation administration: an organisation-wide session performs them, a
 * project-scoped delegation does not, and no machine credential does
 * (`docs/SECURITY.md` sections 6.3 and 7). A cookie-authenticated write also
 * carries the CSRF token — that is what makes these the first state-changing
 * routes a browser session may reach, which ADR-0016 said would have to arrive
 * together with the CSRF protection.
 *
 * A project the caller may not see answers exactly as an unknown identifier
 * does. `docs/API.md` section 5 requires it: `AUTHORISATION_DENIED` would
 * confirm that the project exists, which is the enumeration the cross-project
 * test exists to prevent.
 *
 * The two `POST /api/v1/organisations…` routes below are the Stage 0
 * provisioning pair. They remain administrative — bootstrap token only — and
 * exist because the harnesses, the fixture capture and the Compose end-to-end
 * scenario seed a deployment through them.
 */

import type { FastifyInstance } from "fastify";

import { requireAdministrator } from "../../auth.ts";
import type { Pool } from "../../db/pool.ts";
import { inTransaction } from "../../db/pool.ts";
import { appendEvent } from "../../events/append.ts";
import { EventStreamReader } from "../../events/stream.ts";
import { ApiError, notFound } from "../../errors.ts";
import { buildPage, pageMeta, readPageRequest } from "../../http/pagination.ts";
import { newEntityId } from "../../ids.ts";
import {
  requireCsrfToken,
  requireHuman,
  requireOrganisationAdministrator,
  resolveProject,
  scopeParameter,
} from "../identity/authorisation.ts";
import type { OrganisationStore } from "../identity/organisations.ts";
import type { ViewerPrincipal } from "../live/viewer-sessions.ts";
import { projectView } from "./service.ts";
import type { ProjectRow, ProjectService } from "./service.ts";

export interface ProjectRoutesOptions {
  readonly pool: Pool;
  readonly projects: ProjectService;
  readonly organisations: OrganisationStore;
  readonly bootstrapToken: string;
  readonly workerCredential: string;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;

const PROJECT_COLUMNS = `id, organisation_id, name, slug, repository_identity, default_branch,
                         status, settings, version, created_at, updated_at`;

export async function registerProjectRoutes(
  app: FastifyInstance,
  options: ProjectRoutesOptions,
): Promise<void> {
  const { pool } = options;

  /** The organisation a write applies to: the session's, or the only one. */
  const writeOrganisation = async (principal: ViewerPrincipal): Promise<string> => {
    if (principal.organisationId !== null) return principal.organisationId;
    const organisation = await options.organisations.primary();
    if (organisation === null) throw notFound("The organisation");
    return organisation.id;
  };

  const actorFor = (principal: ViewerPrincipal): { type: "human_user"; id?: string; display: string } => ({
    type: "human_user",
    ...(principal.userId === null ? {} : { id: principal.userId }),
    display: principal.display,
  });

  // ------------------------------------------------- Stage 0 provisioning
  app.post("/api/v1/organisations", async (request, reply) => {
    requireAdministrator(request, options.bootstrapToken, options.workerCredential);
    const body = request.body as { name?: string; slug?: string };
    const slug = body.slug ?? "";
    if (!SLUG_PATTERN.test(slug)) {
      throw new ApiError("UNSUPPORTED_CAPABILITY", "slug must be lowercase, alphanumeric or hyphens.");
    }
    const id = newEntityId("organisation");
    await inTransaction(pool, async (client) => {
      await client.query("INSERT INTO organisations (id, name, slug) VALUES ($1, $2, $3)", [
        id,
        body.name ?? slug,
        slug,
      ]);
      await appendEvent(client, {
        type: "organisation.created",
        organisationId: id,
        actor: { type: "human_user", display: "bootstrap administrator" },
        correlation: { request_id: request.id },
        payload: { slug, name: body.name ?? slug },
      });
    });
    return reply.status(201).send({ data: { id, slug }, meta: { request_id: request.id } });
  });

  app.post("/api/v1/organisations/:organisationId/projects", async (request, reply) => {
    requireAdministrator(request, options.bootstrapToken, options.workerCredential);
    const { organisationId } = request.params as { organisationId: string };
    const body = request.body as { name?: string; slug?: string };
    const organisation = await pool.query("SELECT id FROM organisations WHERE id = $1", [
      organisationId,
    ]);
    if (organisation.rows.length === 0) throw notFound("The organisation");

    const created = await options.projects.create({
      organisationId,
      name: body.name ?? body.slug ?? "",
      slug: body.slug,
      actor: { type: "human_user", display: "bootstrap administrator" },
      requestId: request.id,
    });
    return reply.status(201).send({
      data: { id: created.id, slug: created.slug, organisation_id: created.organisation_id },
      meta: { request_id: request.id },
    });
  });

  // ------------------------------------------------------------- projects
  /**
   * Projects the caller may see (`docs/API.md` section 8).
   *
   * A project-scoped session sees exactly its own projects, which is what stops
   * the web application listing another project's work merely because it asked.
   */
  app.get("/api/v1/projects", async (request, reply) => {
    const principal = requireHuman(request);
    const scoped = scopeParameter(principal);
    const page = readPageRequest(request.query);
    const includeArchived = (request.query as { include_archived?: unknown }).include_archived === "true";
    // Keyset pagination, ordered by the same pair the cursor carries. Reading
    // `limit + 1` rows is how the endpoint knows whether another page exists
    // without a second count query (`docs/API.md` section 6).
    //
    // Both the predicate and the sort truncate to milliseconds, because that is
    // the precision the cursor has: `row.created_at.toISOString()` is all a
    // JavaScript `Date` carries, while `timestamptz` stores microseconds. This
    // ordering is `DESC` with `<`, so an untruncated comparison rounds the
    // cursor *down* and excludes every row sharing its millisecond — the page
    // after a boundary silently omits them and the pager then reports no more
    // pages, which is a lost project rather than a repeated one. Truncating the
    // sort as well is not optional: if the filter compares truncated values and
    // the sort orders untruncated ones, two rows inside one millisecond can be
    // ordered one way and filtered the other, which reintroduces the gap by a
    // different route.
    const rows = await pool.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS}
         FROM projects
        WHERE ($1::text[] IS NULL OR id = ANY($1))
          AND ($2::text IS NULL OR organisation_id = $2)
          AND ($3::boolean OR status <> 'archived')
          AND ($4::text IS NULL
               OR (date_trunc('milliseconds', created_at), id) < ($4::timestamptz, $5::text))
        ORDER BY date_trunc('milliseconds', created_at) DESC, id DESC
        LIMIT $6`,
      [
        scoped,
        principal.organisationId,
        includeArchived,
        page.after?.sortKey ?? null,
        page.after?.id ?? null,
        page.limit + 1,
      ],
    );
    const built = buildPage(rows.rows, page, (row) => ({
      sortKey: row.created_at.toISOString(),
      id: row.id,
    }));
    return reply.send({
      data: built.items.map((row) => projectView(row)),
      meta: pageMeta(request.id, built.nextCursor),
    });
  });

  /** Creates a project (`docs/UX_FLOWS.md` section 4). */
  app.post("/api/v1/projects", async (request, reply) => {
    const principal = requireOrganisationAdministrator(request);
    requireCsrfToken(request, principal);
    const body = (request.body ?? {}) as {
      name?: unknown;
      slug?: unknown;
      repository_identity?: unknown;
      default_branch?: unknown;
      settings?: unknown;
    };
    const organisationId = await writeOrganisation(principal);

    const created = await options.projects.create({
      organisationId,
      name: typeof body.name === "string" ? body.name : "",
      slug: typeof body.slug === "string" ? body.slug : undefined,
      ...(body.repository_identity === undefined
        ? {}
        : { repositoryIdentity: body.repository_identity }),
      ...(typeof body.default_branch === "string" ? { defaultBranch: body.default_branch } : {}),
      ...(body.settings === undefined ? {} : { settings: body.settings }),
      actor: actorFor(principal),
      requestId: request.id,
    });
    return reply
      .status(201)
      .send({ data: projectView(created), meta: { request_id: request.id } });
  });

  app.get("/api/v1/projects/:projectId", async (request, reply) => {
    const principal = requireHuman(request);
    const { projectId } = request.params as { projectId: string };
    await resolveProject(pool, principal, projectId);
    const project = await options.projects.byId(projectId);
    if (project === null) throw notFound("The project");
    return reply.send({ data: projectView(project), meta: { request_id: request.id } });
  });

  app.patch("/api/v1/projects/:projectId", async (request, reply) => {
    const principal = requireOrganisationAdministrator(request);
    requireCsrfToken(request, principal);
    const { projectId } = request.params as { projectId: string };
    const project = await resolveProject(pool, principal, projectId);
    const body = (request.body ?? {}) as {
      name?: unknown;
      slug?: unknown;
      repository_identity?: unknown;
      default_branch?: unknown;
      settings?: unknown;
      expected_version?: unknown;
    };

    const updated = await options.projects.update({
      projectId,
      organisationId: project.organisationId,
      ...(body.expected_version === undefined
        ? {}
        : { expectedVersion: readVersion(body.expected_version) }),
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.slug === "string" ? { slug: body.slug } : {}),
      ...(body.repository_identity === undefined
        ? {}
        : { repositoryIdentity: body.repository_identity }),
      ...(typeof body.default_branch === "string" ? { defaultBranch: body.default_branch } : {}),
      ...(body.settings === undefined ? {} : { settings: body.settings }),
      actor: actorFor(principal),
      requestId: request.id,
    });
    return reply.send({ data: projectView(updated), meta: { request_id: request.id } });
  });

  /**
   * Archives a project. `docs/API.md` section 8: deletion archives, and a
   * destructive purge is a separate flow that does not exist yet — so nothing
   * here removes a review, an artefact or an event.
   */
  app.delete("/api/v1/projects/:projectId", async (request, reply) => {
    const principal = requireOrganisationAdministrator(request);
    requireCsrfToken(request, principal);
    const { projectId } = request.params as { projectId: string };
    const project = await resolveProject(pool, principal, projectId);
    const expected = (request.query as { expected_version?: unknown }).expected_version;

    const archived = await options.projects.archive({
      projectId,
      organisationId: project.organisationId,
      ...(expected === undefined ? {} : { expectedVersion: readVersion(expected) }),
      actor: actorFor(principal),
      requestId: request.id,
    });
    return reply.send({ data: projectView(archived), meta: { request_id: request.id } });
  });

  /**
   * The project activity timeline (`docs/API.md` section 8, `docs/EVENTS.md`
   * section 1).
   *
   * The same events the WebSocket channel of section 18.1 delivers live, read
   * as pages. A client that has been away longer than the replay window, or
   * that has just been told to refresh, refetches here and then resumes the
   * socket from the newest sequence it received.
   */
  app.get("/api/v1/projects/:projectId/activity", async (request, reply) => {
    const principal = requireHuman(request);
    const { projectId } = request.params as { projectId: string };
    const project = await resolveProject(pool, principal, projectId);

    const page = readPageRequest(request.query);
    const reader = new EventStreamReader(pool);
    const position = await reader.position(project.id);
    // The sort key is the sequence, rendered as fixed-width text so that a
    // string comparison in the cursor orders the same way the number does.
    const after = page.after === null ? position.currentSequence + 1 : Number(page.after.sortKey);
    const rows = await pool.query<{ sequence: string; id: string }>(
      `SELECT sequence, id FROM events
        WHERE stream_key = $1 AND sequence < $2
        ORDER BY sequence DESC
        LIMIT $3`,
      [project.id, after, page.limit + 1],
    );
    const envelopes = await reader.byIds(rows.rows.map((row) => row.id));
    const ordered = [...envelopes].sort((left, right) => right.sequence - left.sequence);
    const built = buildPage(ordered, page, (event) => ({
      sortKey: String(event.sequence),
      id: event.id,
    }));
    return reply.send({ data: built.items, meta: pageMeta(request.id, built.nextCursor) });
  });
}

function readVersion(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ApiError("VALIDATION_FAILED", "expected_version must be a positive whole number.", {
      field: "expected_version",
    });
  }
  return parsed;
}
