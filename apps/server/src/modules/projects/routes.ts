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

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { requireAdministrator } from "../../auth.ts";
import { inTransaction } from "../../db/pool.ts";
import { appendEvent } from "../../events.ts";
import { ApiError, notFound } from "../../errors.ts";
import { newId } from "../../ids.ts";

export interface ProjectRoutesOptions {
  readonly pool: Pool;
  readonly bootstrapToken: string;
  readonly workerCredential: string;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;

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
    const id = newId("org_");
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

    const id = newId("prj_");
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
        payload: { slug },
      });
      return { id, slug, organisation_id: organisationId };
    });
    return reply.status(201).send({ data: record, meta: { request_id: request.id } });
  });

  app.get("/api/v1/projects/:projectId", async (request, reply) => {
    requireAdministrator(request, options.bootstrapToken, options.workerCredential);
    const { projectId } = request.params as { projectId: string };
    const rows = await pool.query(
      "SELECT id, organisation_id, name, slug, status FROM projects WHERE id = $1",
      [projectId],
    );
    const row = rows.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) throw notFound("The project");
    return reply.send({ data: row, meta: { request_id: request.id } });
  });
}
