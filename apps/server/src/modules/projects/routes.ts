/**
 * Minimal organisation and project endpoints (`docs/API.md` sections 7 and 8).
 *
 * Only what browser sessions and artefacts need to exist: a project to own
 * them and an organisation to own the project. Membership, repository identity
 * and settings arrive with the issues that use them.
 *
 * Both routes are administrative, so a worker credential is refused here even
 * though it authenticates successfully elsewhere (`docs/SECURITY.md` §6.3).
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import { requireAdministrator } from "../../auth.ts";
import { inTransaction } from "../../db/pool.ts";
import { appendEvent } from "../../events/append.ts";
import { EventStreamReader } from "../../events/stream.ts";
import { ApiError, notFound } from "../../errors.ts";
import { buildPage, pageMeta, readPageRequest } from "../../http/pagination.ts";
import { newEntityId } from "../../ids.ts";
import type { ViewerPrincipal } from "../live/viewer-sessions.ts";

export interface ProjectRoutesOptions {
  readonly pool: Pool;
  readonly bootstrapToken: string;
  readonly workerCredential: string;
  /**
   * Resolves a human viewer (ADR-0016). Reads are available to a viewer
   * session; writes stay administrative.
   */
  readonly viewerAuth?: (request: FastifyRequest) => Promise<ViewerPrincipal>;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;

interface ProjectListRow {
  readonly id: string;
  readonly organisation_id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly created_at: Date;
}

export async function registerProjectRoutes(
  app: FastifyInstance,
  options: ProjectRoutesOptions,
): Promise<void> {
  const { pool } = options;

  app.post("/api/v1/organisations", async (request, reply) => {
    requireAdministrator(request, options.bootstrapToken, options.workerCredential);
    const body = request.body as { name?: string; slug?: string };
    const slug = body.slug ?? "";
    if (!SLUG_PATTERN.test(slug)) {
      throw new ApiError("UNSUPPORTED_CAPABILITY", "slug must be lowercase, alphanumeric or hyphens.");
    }
    const id = newEntityId("organisation");
    await pool.query("INSERT INTO organisations (id, name, slug) VALUES ($1, $2, $3)", [
      id,
      body.name ?? slug,
      slug,
    ]);
    return reply.status(201).send({ data: { id, slug }, meta: { request_id: request.id } });
  });

  app.post("/api/v1/organisations/:organisationId/projects", async (request, reply) => {
    requireAdministrator(request, options.bootstrapToken, options.workerCredential);
    const { organisationId } = request.params as { organisationId: string };
    const body = request.body as { name?: string; slug?: string };
    const slug = body.slug ?? "";
    if (!SLUG_PATTERN.test(slug)) {
      throw new ApiError("UNSUPPORTED_CAPABILITY", "slug must be lowercase, alphanumeric or hyphens.");
    }
    const organisation = await pool.query("SELECT id FROM organisations WHERE id = $1", [
      organisationId,
    ]);
    if (organisation.rows.length === 0) throw notFound("The organisation");

    const id = newEntityId("project");
    const record = await inTransaction(pool, async (client) => {
      await client.query(
        "INSERT INTO projects (id, organisation_id, name, slug) VALUES ($1, $2, $3, $4)",
        [id, organisationId, body.name ?? slug, slug],
      );
      await appendEvent(client, {
        type: "project.created",
        organisationId,
        projectId: id,
        actor: { type: "human_user", display: "bootstrap administrator" },
        payload: { slug, name: body.name ?? slug },
      });
      return { id, slug, organisation_id: organisationId };
    });
    return reply.status(201).send({ data: record, meta: { request_id: request.id } });
  });

  /**
   * Projects the caller may see (`docs/API.md` section 8).
   *
   * A project-scoped viewer session sees exactly its own projects, which is
   * what stops the web application listing another project's browser sessions
   * merely because it asked.
   */
  app.get("/api/v1/projects", async (request, reply) => {
    const principal = await requireViewer(request);
    const scoped = principal.projectIds === null ? null : [...principal.projectIds];
    const page = readPageRequest(request.query);
    // Keyset pagination, ordered by the same pair the cursor carries. Reading
    // `limit + 1` rows is how the endpoint knows whether another page exists
    // without a second count query (`docs/API.md` section 6).
    const rows = await pool.query<ProjectListRow>(
      `SELECT id, organisation_id, name, slug, status, created_at
         FROM projects
        WHERE ($1::text[] IS NULL OR id = ANY($1))
          AND ($2::text IS NULL OR (created_at, id) < ($2::timestamptz, $3::text))
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [scoped, page.after?.sortKey ?? null, page.after?.id ?? null, page.limit + 1],
    );
    const built = buildPage(rows.rows, page, (row) => ({
      sortKey: row.created_at.toISOString(),
      id: row.id,
    }));
    return reply.send({
      data: built.items.map(({ created_at: _createdAt, ...project }) => project),
      meta: pageMeta(request.id, built.nextCursor),
    });
  });

  /**
   * The project activity timeline (`docs/API.md` section 8, `docs/EVENTS.md`
   * section 1).
   *
   * The same events the WebSocket channel of section 18.1 delivers live, read
   * as pages. A client that has been away longer than the replay window, or
   * that has just been told to refresh, refetches here and then resumes the
   * socket from the newest sequence it received.
   *
   * The project is resolved inside the viewer's scope, so a project the viewer
   * may not see answers exactly as an unknown identifier does — the API never
   * confirms that another organisation's project exists.
   */
  app.get("/api/v1/projects/:projectId/activity", async (request, reply) => {
    const principal = await requireViewer(request);
    const { projectId } = request.params as { projectId: string };
    const scoped = principal.projectIds === null ? null : [...principal.projectIds];
    const found = await pool.query<{ id: string; organisation_id: string }>(
      `SELECT id, organisation_id FROM projects
        WHERE id = $1 AND ($2::text[] IS NULL OR id = ANY($2))`,
      [projectId, scoped],
    );
    const project = found.rows[0];
    if (project === undefined) throw notFound("The project");
    if (principal.organisationId !== null && principal.organisationId !== project.organisation_id) {
      throw notFound("The project");
    }

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

  app.get("/api/v1/projects/:projectId", async (request, reply) => {
    const principal = await requireViewer(request);
    const { projectId } = request.params as { projectId: string };
    if (principal.projectIds !== null && !principal.projectIds.has(projectId)) {
      throw new ApiError(
        "PROJECT_CONTEXT_MISMATCH",
        "This viewer session is not authorised for that project.",
      );
    }
    const rows = await pool.query(
      "SELECT id, organisation_id, name, slug, status FROM projects WHERE id = $1",
      [projectId],
    );
    const row = rows.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) throw notFound("The project");
    return reply.send({ data: row, meta: { request_id: request.id } });
  });

  /** Administrator token or viewer session; nothing else reaches a read. */
  async function requireViewer(request: FastifyRequest): Promise<ViewerPrincipal> {
    if (options.viewerAuth !== undefined) return options.viewerAuth(request);
    requireAdministrator(request, options.bootstrapToken, options.workerCredential);
    return {
      type: "human_viewer",
      viewerSessionId: "bootstrap",
      organisationId: null,
      projectIds: null,
      display: "bootstrap administrator",
    };
  }
}
