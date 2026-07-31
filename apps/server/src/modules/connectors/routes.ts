/**
 * The human-facing connector and environment endpoints of `docs/API.md` §9.
 *
 * Two things about this surface are load-bearing.
 *
 * **Who may call it.** Stage 0 accepted only the bootstrap administrator token,
 * because no human session existed. Enrolling an environment from the web
 * application is what this slice delivers, so these routes now resolve the
 * organisation administrator of `modules/identity/authorisation.ts` — which the
 * bootstrap token still maps to, so an operator's `Authorization: Bearer`
 * continues to work unchanged. A browser-worker, agent or connector credential
 * reaches none of them (`docs/SECURITY.md` §6.3).
 *
 * **CSRF.** The moment a cookie can authenticate a state-changing route, a
 * forged cross-origin write becomes possible: the browser attaches the cookie
 * to a request another origin caused, and a bearer token is not attached that
 * way. Every state-changing route here therefore applies the strict
 * `requireCsrfToken`, in a `preHandler` so that it runs **before the body is
 * decoded** — a refusal that happened after parsing would still have spent the
 * work an attacker asked for. Minting an enrolment token is exactly the shape
 * that must not be forgeable: it is a credential that enrols a machine.
 *
 * **Scope.** Every lookup carries the identifier, the organisation and the
 * session's project scope in one SQL predicate. A connector or environment
 * outside the caller's scope produces no row, so a foreign identifier and an
 * unknown one answer `RESOURCE_NOT_FOUND` byte-identically and neither can be
 * used to enumerate the other (`docs/API.md` §5).
 */

import { X509Certificate } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { Pool } from "../../db/pool.ts";
import { ApiError } from "../../errors.ts";
import {
  requireCsrfToken,
  requireOrganisationAdministrator,
  resolveProject,
  scopeParameter,
} from "../identity/authorisation.ts";
import type { ViewerPrincipal } from "../live/viewer-sessions.ts";
import type { AgentCredentialStore } from "../agents/credentials.ts";
import type { TlsMaterial } from "./certificate-authority.ts";
import { ENROLMENT_PATH, type ConnectorModuleConfig } from "./config.ts";
import { hashEnrolmentToken, newEnrolmentToken, newEnrolmentTokenId } from "./identifiers.ts";
import type { ControlChannelRegistry } from "./publication.ts";
import {
  createEnrolmentToken,
  findConnectorInScope,
  findEnvironmentInScope,
  listConnectors,
  listConnectorsForEnvironments,
  listEnvironmentsForProject,
  type ConnectorRecord,
  type EnvironmentRecord,
} from "./repository.ts";
import { revokeConnectorIdentity, type RevocationEffects } from "./revocation.ts";
import { listWorkspacesForEnvironments, type WorkspaceRow } from "./workspaces.ts";
import { certificateFingerprint } from "./x509.ts";

/** Bounds on the issuance request body. */
const MAX_USES_LIMIT = 32;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 604_800;
const MAX_LABELS = 16;
const LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

interface IssueTokenBody {
  readonly project_id?: unknown;
  readonly expires_in_seconds?: unknown;
  readonly max_uses?: unknown;
  readonly environment_labels?: unknown;
}

function readLabels(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ApiError("VALIDATION_FAILED", "environment_labels must be an array of labels.");
  }
  if (value.length > MAX_LABELS) {
    throw new ApiError("VALIDATION_FAILED", `environment_labels must list at most ${MAX_LABELS} labels.`);
  }
  const labels = value.map((entry) => {
    if (typeof entry !== "string" || !LABEL_PATTERN.test(entry)) {
      throw new ApiError("VALIDATION_FAILED", "Each environment label must match ^[a-z0-9][a-z0-9._-]*$.");
    }
    return entry;
  });
  if (new Set(labels).size !== labels.length) {
    throw new ApiError("VALIDATION_FAILED", "environment_labels must not repeat a label.");
  }
  return labels;
}

function readBoundedInteger(
  value: unknown,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ApiError("VALIDATION_FAILED", `${name} must be an integer.`);
  }
  if (value < minimum || value > maximum) {
    throw new ApiError("VALIDATION_FAILED", `${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

export interface ConnectorRoutesContext {
  readonly pool: Pool;
  readonly config: ConnectorModuleConfig;
  readonly authority: TlsMaterial;
  readonly channels: ControlChannelRegistry;
  /** The store revocation closes the identity's own credentials through. */
  readonly credentials: AgentCredentialStore;
  /** Supplied after composition, like the reconciler, for the same reason. */
  revocationEffects(): RevocationEffects | undefined;
}

function connectorSummary(connector: ConnectorRecord): Record<string, unknown> {
  return {
    id: connector.id,
    environment_id: connector.environmentId,
    project_id: connector.projectId,
    certificate_fingerprint: connector.certificateFingerprint,
    version: connector.version,
    capabilities: connector.capabilities,
    status: connector.status,
    connected_at: connector.connectedAt?.toISOString() ?? null,
    last_heartbeat_at: connector.lastHeartbeatAt?.toISOString() ?? null,
    revoked_at: connector.revokedAt?.toISOString() ?? null,
  };
}

function workspaceSummary(workspace: WorkspaceRow): Record<string, unknown> {
  return {
    id: workspace.id,
    project_id: workspace.project_id,
    path_hash: workspace.path_hash,
    display_path: workspace.display_path,
    repository_identity: workspace.repository_identity,
    branch: workspace.branch,
    head_commit: workspace.head_commit,
    dirty: workspace.dirty,
    source: workspace.source,
    last_observed_at: workspace.last_observed_at?.toISOString() ?? null,
  };
}

function environmentView(
  environment: EnvironmentRecord,
  connectors: readonly ConnectorRecord[],
  workspaces: readonly WorkspaceRow[],
): Record<string, unknown> {
  return {
    id: environment.id,
    organisation_id: environment.organisationId,
    project_id: environment.projectId,
    name: environment.name,
    platform: environment.platform,
    architecture: environment.architecture,
    labels: environment.labels,
    trust_level: environment.trustLevel,
    status: environment.status,
    last_seen_at: environment.lastSeenAt?.toISOString() ?? null,
    created_at: environment.createdAt.toISOString(),
    connectors: connectors
      .filter((connector) => connector.environmentId === environment.id)
      .map(connectorSummary),
    workspaces: workspaces
      .filter((workspace) => workspace.environment_id === environment.id)
      .map(workspaceSummary),
  };
}

export function registerConnectorRoutes(app: FastifyInstance, context: ConnectorRoutesContext): void {
  // Errors are rendered by the one hook `src/app.ts` installs. A second error
  // handler here would replace it for the whole instance, so the module raises
  // ApiError and leaves rendering to composition.

  /**
   * The guard every state-changing route on this surface uses.
   *
   * It runs as a `preHandler`, which Fastify invokes after routing and before
   * the handler, and it refuses on the credential alone: nothing in the body is
   * read to decide it. A cookie session must present its CSRF token; a bearer
   * credential carries none and needs none, because a browser does not attach
   * one to a cross-origin request.
   */
  const administratorWrite = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const principal = requireOrganisationAdministrator(request);
    requireCsrfToken(request, principal);
    await Promise.resolve();
  };

  const administratorRead = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    requireOrganisationAdministrator(request);
    await Promise.resolve();
  };

  /** The organisation a request acts in, defaulting to this deployment's. */
  function organisationOf(principal: ViewerPrincipal): string {
    return principal.organisationId ?? context.config.organisationId;
  }

  /**
   * `POST /api/v1/connectors/enrolment-tokens` — creates a one-time enrolment
   * token (`docs/CONNECTOR_PROTOCOL.md` §4.1). The token value appears in this
   * response and nowhere else, ever: only its hash is stored.
   */
  app.post<{ Body: IssueTokenBody }>(
    "/api/v1/connectors/enrolment-tokens",
    { preHandler: administratorWrite },
    async (request, reply) => {
      const principal = requireOrganisationAdministrator(request);
      const scopedOrganisation = organisationOf(principal);
      const body = request.body ?? {};
      const rawProjectId = body.project_id === undefined || body.project_id === null ? null : body.project_id;
      if (rawProjectId !== null && typeof rawProjectId !== "string") {
        throw new ApiError("VALIDATION_FAILED", "project_id must be a string.");
      }
      // A token scoped to a project the caller cannot reach is refused as an
      // absent project rather than as a forbidden one, and the resolution is a
      // single scoped query rather than a lookup followed by a comparison.
      //
      // The organisation comes from the **resolved project** whenever one is
      // named, rather than from the caller's own scope. The two can differ: the
      // bootstrap principal carries no organisation, so `resolveProject` applies
      // no organisation filter for it, and deriving the organisation from the
      // deployment default instead would store a token whose `organisation_id`
      // and `project_id` name different organisations. Nothing downstream would
      // honour it — enrolment refuses a token scoped to another organisation —
      // but it is a row no reader can interpret, and it is the shape RVP-66
      // records: an organisation taken from somewhere other than the record it
      // is stored beside.
      const project = rawProjectId === null ? null : await resolveProject(context.pool, principal, rawProjectId);
      const projectId = project?.id ?? null;
      const organisationId = project?.organisationId ?? scopedOrganisation;

      const maxUses = readBoundedInteger(body.max_uses, "max_uses", 1, 1, MAX_USES_LIMIT);
      const ttlSeconds = readBoundedInteger(
        body.expires_in_seconds,
        "expires_in_seconds",
        context.config.defaultTokenTtlSeconds,
        MIN_TTL_SECONDS,
        MAX_TTL_SECONDS,
      );
      const labels = readLabels(body.environment_labels);

      const token = newEnrolmentToken();
      const record = await createEnrolmentToken(context.pool, {
        id: newEnrolmentTokenId(),
        organisationId,
        projectId,
        tokenHash: hashEnrolmentToken(token),
        environmentLabels: labels,
        maxUses,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
        createdBy: principal.userId ?? principal.credential,
      });

      // The identifier is logged; the token is not (`docs/SECURITY.md` §18).
      request.log.info(
        { enrolment_token_id: record.id, max_uses: record.maxUses, expires_at: record.expiresAt },
        "enrolment token issued",
      );

      return reply.code(201).send({
        data: {
          id: record.id,
          organisation_id: record.organisationId,
          project_id: record.projectId,
          environment_labels: record.environmentLabels,
          max_uses: record.maxUses,
          expires_at: record.expiresAt.toISOString(),
          enrolment_token: token,
          enrolment_endpoint: `${context.config.publicUrl}${ENROLMENT_PATH}`,
          control_plane_url: context.config.publicUrl,
          // The exact command `docs/UX_FLOWS.md` §5 asks the enrolment screen to
          // display. It reads the token from a file rather than from the command
          // line, because a command line is in the process table and in shell
          // history and `docs/CONNECTOR_PROTOCOL.md` §20 says so.
          connector_command: enrolmentCommand(context.config.publicUrl),
        },
        meta: { request_id: request.id },
      });
    },
  );

  /**
   * `GET /api/v1/connectors/certificate-authority` — the connector CA
   * certificate, for an operator configuring the tunnel gateway's trust anchor.
   * The CA private key is never part of this response.
   */
  app.get("/api/v1/connectors/certificate-authority", { preHandler: administratorRead }, async (request, reply) => {
    const parsed = new X509Certificate(context.authority.certificatePem);
    return reply.send({
      data: {
        certificate_pem: context.authority.certificatePem,
        fingerprint: certificateFingerprint(Buffer.from(parsed.raw)),
        subject: parsed.subject.replaceAll("\n", ", "),
        not_after: context.authority.notAfter.toISOString(),
      },
      meta: { request_id: request.id },
    });
  });

  /** `GET /api/v1/connectors` */
  app.get("/api/v1/connectors", { preHandler: administratorRead }, async (request, reply) => {
    const principal = requireOrganisationAdministrator(request);
    const connectors = await listConnectors(
      context.pool,
      organisationOf(principal),
      scopeParameter(principal),
    );
    return reply.send({
      data: connectors.map(connectorSummary),
      meta: { request_id: request.id },
    });
  });

  /** `GET /api/v1/connectors/:connectorId` */
  app.get<{ Params: { connectorId: string } }>(
    "/api/v1/connectors/:connectorId",
    { preHandler: administratorRead },
    async (request, reply) => {
      const principal = requireOrganisationAdministrator(request);
      const organisationId = organisationOf(principal);
      const connector = await findConnectorInScope(context.pool, {
        connectorId: request.params.connectorId,
        organisationId,
        projectIds: scopeParameter(principal),
      });
      if (connector === null) throw new ApiError("RESOURCE_NOT_FOUND", "No such connector.");

      const environment = await findEnvironmentInScope(context.pool, {
        environmentId: connector.environmentId,
        organisationId,
        projectIds: scopeParameter(principal),
      });
      const workspaces =
        environment === null ? [] : await listWorkspacesForEnvironments(context.pool, [environment.id]);
      return reply.send({
        data: {
          ...connectorSummary(connector),
          certificate_not_after: connector.certificateNotAfter.toISOString(),
          environment: environment === null ? null : environmentView(environment, [connector], workspaces),
        },
        meta: { request_id: request.id },
      });
    },
  );

  /**
   * `POST /api/v1/connectors/:connectorId/revoke` — invalidates an identity
   * (`docs/CONNECTOR_PROTOCOL.md` §18).
   *
   * It is a state-changing route reachable by a session cookie, so it carries
   * the strict CSRF guard. It is also irreversible: re-enrolment creates a new
   * connector identity, and the response says what the revocation reached so
   * that the screen can report it rather than implying more or less than
   * happened.
   */
  app.post<{ Params: { connectorId: string } }>(
    "/api/v1/connectors/:connectorId/revoke",
    { preHandler: administratorWrite },
    async (request, reply) => {
      const principal = requireOrganisationAdministrator(request);
      const outcome = await revokeConnectorIdentity(
        {
          pool: context.pool,
          channels: context.channels,
          effects: context.revocationEffects(),
          credentials: context.credentials,
          log: request.log,
        },
        {
          connectorId: request.params.connectorId,
          organisationId: organisationOf(principal),
          projectIds: scopeParameter(principal),
          requestId: String(request.id),
          actor:
            principal.userId === null
              ? { type: "human_user" }
              : { type: "human_user", id: principal.userId },
        },
      );
      return reply.send({
        data: {
          id: outcome.connector.id,
          status: outcome.connector.status,
          revoked_at: outcome.revokedAt.toISOString(),
          routes_revoked: outcome.routesRevoked,
          sessions_disconnected: outcome.sessionsDisconnected,
          channels_closed: outcome.channelsClosed,
          agent_credentials_revoked: outcome.agentCredentialsRevoked,
          already_revoked: !outcome.changed,
        },
        meta: { request_id: request.id },
      });
    },
  );

  /** `GET /api/v1/projects/:projectId/environments` */
  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/environments",
    { preHandler: administratorRead },
    async (request, reply) => {
      const principal = requireOrganisationAdministrator(request);
      const project = await resolveProject(context.pool, principal, request.params.projectId);
      const environments = await listEnvironmentsForProject(context.pool, {
        organisationId: project.organisationId,
        projectId: project.id,
      });
      const ids = environments.map((environment) => environment.id);
      const [connectors, workspaces] = await Promise.all([
        listConnectorsForEnvironments(context.pool, ids),
        listWorkspacesForEnvironments(context.pool, ids),
      ]);
      return reply.send({
        data: environments.map((environment) =>
          environmentView(
            environment,
            connectors,
            workspaces.filter((workspace) => workspace.project_id === project.id),
          ),
        ),
        meta: { request_id: request.id },
      });
    },
  );

  /** `GET /api/v1/environments/:environmentId` */
  app.get<{ Params: { environmentId: string } }>(
    "/api/v1/environments/:environmentId",
    { preHandler: administratorRead },
    async (request, reply) => {
      const principal = requireOrganisationAdministrator(request);
      const environment = await findEnvironmentInScope(context.pool, {
        environmentId: request.params.environmentId,
        organisationId: organisationOf(principal),
        projectIds: scopeParameter(principal),
      });
      if (environment === null) throw new ApiError("RESOURCE_NOT_FOUND", "No such environment.");
      const [connectors, workspaces] = await Promise.all([
        listConnectorsForEnvironments(context.pool, [environment.id]),
        listWorkspacesForEnvironments(context.pool, [environment.id]),
      ]);
      return reply.send({
        data: environmentView(environment, connectors, workspaces),
        meta: { request_id: request.id },
      });
    },
  );
}

/**
 * The one-time command an operator runs on the development VM
 * (`docs/UX_FLOWS.md` §5, `docs/DEPLOYMENT.md` §13).
 *
 * The connector dials the control plane over `wss`, and an operator types an
 * `https` base URL, so the advertised `wss://` origin is rendered back as the
 * `https://` one `--control-plane` accepts.
 */
export function enrolmentCommand(publicUrl: string): string {
  const controlPlane = publicUrl.replace(/^wss:\/\//u, "https://").replace(/\/+$/u, "");
  return [
    "sudo reviewplane-connector enrol \\",
    `  --control-plane ${controlPlane} \\`,
    "  --token-file /root/reviewplane-enrolment-token",
  ].join("\n");
}
