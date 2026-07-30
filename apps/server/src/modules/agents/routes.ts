/**
 * Agent-credential issuance and workspace registration (`docs/API.md`
 * sections 8 and 9, `docs/SECURITY.md` section 6.3).
 *
 * These are administrative endpoints and they stay administrative. Issuing an
 * agent credential is granting an agent the ability to act inside a project, so
 * it is a decision only an administrator makes — and, in particular, one an
 * agent cannot make for itself. `requireAdministrator` refuses an agent token
 * here as it refuses a worker credential, which is the boundary
 * `docs/SECURITY.md` section 6.3 states and `docs/TESTING.md` section 10 tests.
 *
 * The token is returned exactly once, in the response body of the call that
 * created it. It is never stored in the clear, never logged and never available
 * from a later read: an endpoint that could re-show a credential would make the
 * digest-only storage pointless.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import { requireAdministrator } from "../../auth.ts";
import { inTransaction } from "../../db/pool.ts";
import { ApiError, notFound } from "../../errors.ts";
import { appendEvent } from "../../events/append.ts";
import {
  AGENT_CAPABILITIES,
  AGENT_CREDENTIAL_TTL_SECONDS,
  type AgentCredentialStore,
} from "./credentials.ts";
import type { WorkspaceStore } from "./workspaces.ts";
import type { ViewerPrincipal } from "../live/viewer-sessions.ts";

export interface AgentRoutesOptions {
  readonly pool: Pool;
  readonly credentials: AgentCredentialStore;
  readonly workspaces: WorkspaceStore;
  readonly bootstrapToken: string;
  readonly workerCredential: string;
  readonly viewerAuth?: (request: FastifyRequest) => Promise<ViewerPrincipal>;
}

/** The shortest life an operator may ask for through the API. */
const MINIMUM_ISSUED_TTL_SECONDS = 60;

export async function registerAgentRoutes(
  app: FastifyInstance,
  options: AgentRoutesOptions,
): Promise<void> {
  const admin = (request: FastifyRequest): void => {
    requireAdministrator(request, options.bootstrapToken, options.workerCredential);
  };

  app.post("/api/v1/organisations/:organisationId/agent-credentials", async (request, reply) => {
    admin(request);
    const { organisationId } = request.params as { organisationId: string };
    const body = request.body as {
      project_ids?: string[];
      capabilities?: string[];
      label?: string;
      issued_to_client?: string;
      ttl_seconds?: number;
    };
    const ttl = body.ttl_seconds ?? AGENT_CREDENTIAL_TTL_SECONDS;
    if (ttl < MINIMUM_ISSUED_TTL_SECONDS) {
      throw new ApiError(
        "POLICY_DENIED",
        `An issued agent credential must live at least ${String(MINIMUM_ISSUED_TTL_SECONDS)} seconds.`,
        { field: "ttl_seconds" },
      );
    }
    const organisation = await options.pool.query("SELECT id FROM organisations WHERE id = $1", [
      organisationId,
    ]);
    if (organisation.rows.length === 0) throw notFound("The organisation");

    const issued = await options.credentials.issue({
      organisationId,
      projectIds: body.project_ids ?? [],
      capabilities: body.capabilities ?? [...AGENT_CAPABILITIES],
      label: body.label ?? "agent",
      ...(body.issued_to_client === undefined ? {} : { issuedToClient: body.issued_to_client }),
      ttlSeconds: ttl,
    });

    // Issuing a credential is a permission change, which docs/SECURITY.md
    // section 16 requires an audit record for. The event names the projects and
    // capabilities granted and never the token.
    for (const projectId of issued.projectIds) {
      await inTransaction(options.pool, async (client) => {
        await appendEvent(client, {
          type: "agent_credential.issued",
          organisationId,
          projectId,
          actor: { type: "human_user", display: "bootstrap administrator" },
          payload: {
            credential_id: issued.id,
            label: issued.label,
            capabilities: [...issued.capabilities],
            project_ids: [...issued.projectIds],
            expires_at: issued.expiresAt.toISOString(),
          },
        });
      });
    }

    return reply.status(201).send({
      data: {
        credential_id: issued.id,
        // Returned once. There is no route that shows it again.
        token: issued.token,
        organisation_id: issued.organisationId,
        project_ids: issued.projectIds,
        capabilities: issued.capabilities,
        expires_at: issued.expiresAt.toISOString(),
        expires_in_seconds: ttl,
      },
      meta: { request_id: request.id },
    });
  });

  app.delete("/api/v1/agent-credentials/:credentialId", async (request, reply) => {
    admin(request);
    const { credentialId } = request.params as { credentialId: string };
    const revoked = await options.credentials.revoke(credentialId);
    // Revocation is a permission change, which `docs/SECURITY.md` section 16
    // requires an audit record for, per project the credential reached. A
    // repeated revocation revokes nothing and therefore records nothing, so the
    // route stays idempotent without producing a second event.
    if (revoked !== null) {
      for (const projectId of revoked.projectIds) {
        await inTransaction(options.pool, async (client) => {
          await appendEvent(client, {
            type: "session.revoked",
            organisationId: revoked.organisationId,
            projectId,
            actor: { type: "human_user", display: "bootstrap administrator" },
            payload: { credential_id: credentialId, label: revoked.label, reason: "administrator_revoked" },
          });
        });
      }
    }
    return reply.status(204).send();
  });

  app.put("/api/v1/projects/:projectId/workspaces", async (request, reply) => {
    admin(request);
    const { projectId } = request.params as { projectId: string };
    const body = request.body as {
      root_path?: string;
      branch?: string;
      head_commit?: string;
      dirty?: boolean;
      connector_id?: string;
    };
    const rows = await options.pool.query<{ organisation_id: string }>(
      "SELECT organisation_id FROM projects WHERE id = $1",
      [projectId],
    );
    const project = rows.rows[0];
    if (project === undefined) throw notFound("The project");

    const workspace = await options.workspaces.register({
      organisationId: project.organisation_id,
      projectId,
      rootPath: body.root_path ?? "",
      branch: body.branch ?? "",
      headCommit: body.head_commit ?? "",
      ...(body.dirty === undefined ? {} : { dirty: body.dirty }),
      ...(body.connector_id === undefined ? {} : { connectorId: body.connector_id }),
    });
    return reply.send({ data: workspace, meta: { request_id: request.id } });
  });

  app.get("/api/v1/projects/:projectId/workspaces", async (request, reply) => {
    if (options.viewerAuth === undefined) {
      admin(request);
    } else {
      const principal = await options.viewerAuth(request);
      if (principal.projectIds !== null && !principal.projectIds.has(projectIdOf(request))) {
        throw new ApiError(
          "PROJECT_CONTEXT_MISMATCH",
          "This viewer session is not authorised for that project.",
        );
      }
    }
    return reply.send({
      data: await options.workspaces.listForProject(projectIdOf(request)),
      meta: { request_id: request.id },
    });
  });
}

function projectIdOf(request: FastifyRequest): string {
  return (request.params as { projectId: string }).projectId;
}
