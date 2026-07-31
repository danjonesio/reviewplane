/**
 * The connector's agent-credential exchange (ADR-0023,
 * `docs/CONNECTOR_PROTOCOL.md` section 14, `docs/MCP_SPEC.md` section 3.1).
 *
 * `reviewplane-connector mcp` presents its X.509 device identity and receives a
 * short-lived agent credential bound to **one** project — the project of the
 * workspace the agent is working in. That is what lets the local stdio bridge
 * exist without a long-lived agent token on a development machine, which
 * section 14 forbids.
 *
 * It is served on the connector listener rather than on the human API because
 * the credential it authenticates with is a device identity. Keeping the two
 * listeners apart is what makes "a connector credential cannot become a human
 * session" (`docs/TESTING.md` section 10) a property of the topology rather
 * than of a check somebody has to remember.
 *
 * Three rules are enforced here and each one narrows the result.
 *
 * **The peer is the authority.** The connector is resolved from the verified
 * client certificate's fingerprint and never from anything in the body. A body
 * that named a connector would be a request to act as one.
 *
 * **The workspace decides the project, inside what the enrolment allows.** The
 * workspace is resolved by its path hash **and** the connector's own
 * environment **and** the connector's organisation **and** the project the
 * identity was enrolled for, in one query. A workspace this connector has never
 * reported is not found, and so is one belonging to another environment or to a
 * project outside the enrolment: they all answer identically, so the set
 * discloses nothing.
 *
 * The enrolled-project term repeats the rule `workspaces.ts` applies to an
 * observation, and it is here for the reason that module gives for keeping it in
 * the predicate: ADR-0023 says a connector "can mint a credential for a project
 * it already carries traffic for, and for no other", and a claim of that kind
 * should be true of this statement rather than true only while a different
 * module maintains the invariant it depends on. An organisation-scoped enrolment
 * carries no project, and the term is inert for it — exactly as it is there.
 *
 * **The credential is as narrow as the request.** One project, one hour, and
 * the read and write capabilities of `docs/MCP_SPEC.md` section 14.1. There is
 * no administrative capability in the vocabulary, so the rule that the bridge
 * "must not grant the agent connector-administrator privileges" holds because
 * no capability could express it.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { TLSSocket } from "node:tls";

import type { Pool } from "../../db/pool.ts";
import { inTransaction } from "../../db/pool.ts";
import { ApiError, notFound } from "../../errors.ts";
import { appendEvent } from "../../events/append.ts";
import type { AgentCredentialStore } from "../agents/credentials.ts";
import { certificateFingerprint } from "./x509.ts";
import { findConnectorByFingerprint } from "./repository.ts";

/**
 * How long a bridge credential lives.
 *
 * An hour, well inside the 24-hour maximum the `agent_credentials` table
 * enforces. A working session longer than that requests a new one, which is the
 * property `docs/CONNECTOR_PROTOCOL.md` section 14 asks for: the bridge stores
 * nothing, so re-requesting is the only thing it can do.
 */
export const BRIDGE_CREDENTIAL_TTL_SECONDS = 3600;

/**
 * What a bridge credential may do.
 *
 * The workflow capabilities and nothing else. `browser:capture` is absent
 * because the bridge does not drive a browser; a session that needs one is
 * started through the control plane, which is where that authority belongs.
 */
export const BRIDGE_CAPABILITIES: readonly string[] = [
  "project:read",
  "review:read",
  "review:write",
  "finding:read",
  "finding:write",
  "verification:submit",
];

export interface ConnectorAgentCredentialOptions {
  readonly pool: Pool;
  readonly credentials: AgentCredentialStore;
}

/** The verified peer identity of a request on the connector listener. */
function peerFingerprint(request: FastifyRequest): string | null {
  const socket = request.raw.socket as TLSSocket;
  if (typeof socket.getPeerCertificate !== "function") return null;
  if (socket.authorized !== true) return null;
  const certificate = socket.getPeerCertificate();
  if (certificate === null || certificate.raw === undefined) return null;
  return certificateFingerprint(Buffer.from(certificate.raw));
}

interface WorkspaceRow {
  id: string;
  project_id: string;
  project_slug: string;
  branch: string | null;
  head_commit: string | null;
}

export function registerConnectorAgentCredentialRoute(
  listener: FastifyInstance,
  options: ConnectorAgentCredentialOptions,
): void {
  listener.post("/connector/v1/agent-credentials", async (request, reply) => {
    const fingerprint = peerFingerprint(request);
    if (fingerprint === null) {
      throw new ApiError(
        "AUTHENTICATION_REQUIRED",
        "This endpoint requires the connector's client certificate.",
      );
    }
    const connector = await findConnectorByFingerprint(options.pool, fingerprint);
    if (connector === null || connector.revokedAt !== null) {
      // A revoked identity and an unknown one answer identically. A revoked
      // connector must not be able to mint anything, and a distinct refusal
      // would tell a caller which of the two it holds.
      throw new ApiError("AUTHENTICATION_REQUIRED", "This connector identity is not current.");
    }

    const body = (request.body ?? {}) as { workspace_path_hash?: unknown };
    const hash = body.workspace_path_hash;
    if (typeof hash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(hash)) {
      throw new ApiError(
        "UNSUPPORTED_CAPABILITY",
        "workspace_path_hash must be the sha256: digest of the checkout's absolute path.",
        { field: "workspace_path_hash" },
      );
    }

    // Identifier, environment, organisation and enrolled project scope in one
    // predicate. A workspace this connector's environment does not hold is
    // simply not returned, and neither is one carrying a project the identity
    // was not enrolled for, so both answer as an unknown workspace does.
    const rows = await options.pool.query<WorkspaceRow>(
      `SELECT w.id, w.project_id, p.slug AS project_slug, w.branch, w.head_commit
         FROM workspaces w
         JOIN projects p ON p.id = w.project_id
        WHERE w.path_hash = $1
          AND w.environment_id = $2
          AND w.organisation_id = $3
          AND ($4::text IS NULL OR w.project_id = $4)
          AND p.status = 'active'`,
      [hash, connector.environmentId, connector.organisationId, connector.projectId],
    );
    const workspace = rows.rows[0];
    if (workspace === undefined) throw notFound("The workspace");

    const issued = await options.credentials.issue({
      organisationId: connector.organisationId,
      // Exactly one project, decided by the workspace. A credential bound to
      // everything the connector can see would be wider than the session that
      // asked for it, and the session it opens would then have to resolve an
      // ambiguous project (ADR-0020).
      projectIds: [workspace.project_id],
      capabilities: [...BRIDGE_CAPABILITIES],
      label: `local mcp bridge on ${connector.id}`,
      issuedToClient: connector.id,
      ttlSeconds: BRIDGE_CREDENTIAL_TTL_SECONDS,
    });

    // Issuing a credential is a permission change (`docs/SECURITY.md`
    // section 16). The actor is the connector, so the trail distinguishes a
    // credential a development machine minted for itself from one an
    // administrator granted. The event names no token.
    await inTransaction(options.pool, async (client) => {
      await appendEvent(client, {
        type: "agent_credential.issued",
        organisationId: connector.organisationId,
        projectId: workspace.project_id,
        actor: { type: "connector", id: connector.id },
        correlation: { connector_id: connector.id, workspace_id: workspace.id },
        payload: {
          credential_id: issued.id,
          label: issued.label,
          capabilities: [...issued.capabilities],
          project_ids: [...issued.projectIds],
          expires_at: issued.expiresAt.toISOString(),
          issued_for: "local_mcp_bridge",
        },
      });
    });

    // What the bridge reports as a local notification
    // (`docs/CONNECTOR_PROTOCOL.md` section 16). It is the project's pending
    // agent work, bounded, and it names the review's slug and its shape — never
    // a finding's text, which can carry page-derived content, and never a title
    // a human wrote at length. The bridge has no other way to learn it: the
    // human inbox API refuses an agent credential, and reading it through the
    // MCP tool would require a session the bridge has not opened yet.
    const pending = await options.pool.query<{
      type: string;
      review_slug: string | null;
      finding_count: number | null;
      priority: string | null;
    }>(
      `SELECT type,
              payload ->> 'review_slug' AS review_slug,
              (payload ->> 'finding_count')::int AS finding_count,
              payload ->> 'priority' AS priority
         FROM inbox_items
        WHERE organisation_id = $1 AND project_id = $2
          AND recipient_type = 'agent_session' AND status = 'pending'
        ORDER BY created_at ASC, id ASC
        LIMIT 5`,
      [connector.organisationId, workspace.project_id],
    );

    return reply.status(201).send({
      data: {
        pending_work: pending.rows.map((row) => ({
          type: row.type,
          ...(row.review_slug === null ? {} : { review_slug: row.review_slug }),
          ...(row.finding_count === null ? {} : { finding_count: row.finding_count }),
          ...(row.priority === null ? {} : { priority: row.priority }),
        })),
        // Returned once, held in the bridge process's memory, never written to
        // disk (ADR-0023).
        token: issued.token,
        credential_id: issued.id,
        organisation_id: issued.organisationId,
        project_id: workspace.project_id,
        project_slug: workspace.project_slug,
        workspace_id: workspace.id,
        ...(workspace.branch === null ? {} : { branch: workspace.branch }),
        ...(workspace.head_commit === null ? {} : { head_commit: workspace.head_commit }),
        capabilities: issued.capabilities,
        expires_at: issued.expiresAt.toISOString(),
        expires_in_seconds: BRIDGE_CREDENTIAL_TTL_SECONDS,
      },
      meta: { request_id: request.id },
    });
  });
}
