/**
 * The human-facing connector endpoints of `docs/API.md` §9.
 *
 * Stage 0 implements the enrolment-token issuance endpoint, the connector
 * listings, and one addition: exporting the connector CA certificate, which the
 * tunnel gateway needs as a trust anchor to verify the same connector
 * certificates (ADR-0014). The revoke endpoint is Stage 1.
 */

import { X509Certificate } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { requireBootstrapAdministrator } from "../../auth/bootstrap-token.ts";
import type { Pool } from "../../db/pool.ts";
import type { TlsMaterial } from "./certificate-authority.ts";
import { ENROLMENT_PATH, type ConnectorModuleConfig } from "./config.ts";
import { hashEnrolmentToken, newEnrolmentToken, newEnrolmentTokenId } from "./identifiers.ts";
import { createEnrolmentToken, findConnectorById, listConnectors } from "./repository.ts";
import { certificateFingerprint } from "./x509.ts";

/** Bounds on the issuance request body. */
const MAX_USES_LIMIT = 32;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 604_800;
const MAX_LABELS = 16;
const LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

interface IssueTokenBody {
  readonly project_id?: unknown;
  readonly expires_in_seconds?: unknown;
  readonly max_uses?: unknown;
  readonly environment_labels?: unknown;
}

class RequestError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "RequestError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function readLabels(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new RequestError(400, "INVALID_REQUEST", "environment_labels must be an array of labels.");
  }
  if (value.length > MAX_LABELS) {
    throw new RequestError(400, "INVALID_REQUEST", `environment_labels must list at most ${MAX_LABELS} labels.`);
  }
  const labels = value.map((entry) => {
    if (typeof entry !== "string" || !LABEL_PATTERN.test(entry)) {
      throw new RequestError(
        400,
        "INVALID_REQUEST",
        "Each environment label must match ^[a-z0-9][a-z0-9._-]*$.",
      );
    }
    return entry;
  });
  if (new Set(labels).size !== labels.length) {
    throw new RequestError(400, "INVALID_REQUEST", "environment_labels must not repeat a label.");
  }
  return labels;
}

function readBoundedInteger(value: unknown, name: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new RequestError(400, "INVALID_REQUEST", `${name} must be an integer.`);
  }
  if (value < minimum || value > maximum) {
    throw new RequestError(400, "INVALID_REQUEST", `${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

export interface ConnectorRoutesContext {
  readonly pool: Pool;
  readonly config: ConnectorModuleConfig;
  readonly authority: TlsMaterial;
  readonly bootstrapToken: string;
}

export function registerConnectorRoutes(app: FastifyInstance, context: ConnectorRoutesContext): void {
  const administrator = requireBootstrapAdministrator(context.bootstrapToken);

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof RequestError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message },
        meta: { request_id: request.id },
      });
    }
    request.log.error({ err: error }, "request failed");
    return reply.code(500).send({
      error: { code: "INTERNAL_ERROR", message: "The request could not be completed." },
      meta: { request_id: request.id },
    });
  });

  /**
   * `POST /api/v1/connectors/enrolment-tokens` — creates a one-time enrolment
   * token (`docs/CONNECTOR_PROTOCOL.md` §4.1). The token value appears in this
   * response and nowhere else, ever: only its hash is stored.
   */
  app.post<{ Body: IssueTokenBody }>(
    "/api/v1/connectors/enrolment-tokens",
    { preHandler: administrator },
    async (request, reply) => {
      const body = request.body ?? {};
      const projectId = body.project_id === undefined || body.project_id === null ? null : body.project_id;
      if (projectId !== null && typeof projectId !== "string") {
        throw new RequestError(400, "INVALID_REQUEST", "project_id must be a string.");
      }
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
        organisationId: context.config.organisationId,
        projectId,
        tokenHash: hashEnrolmentToken(token),
        environmentLabels: labels,
        maxUses,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
        createdBy: "bootstrap_administrator",
      });

      // The identifier is logged; the token is not.
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
  app.get(
    "/api/v1/connectors/certificate-authority",
    { preHandler: administrator },
    async (request, reply) => {
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
    },
  );

  /** `GET /api/v1/connectors` */
  app.get("/api/v1/connectors", { preHandler: administrator }, async (request, reply) => {
    const connectors = await listConnectors(context.pool, context.config.organisationId);
    return reply.send({
      data: connectors.map((connector) => ({
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
      })),
      meta: { request_id: request.id },
    });
  });

  /** `GET /api/v1/connectors/:connectorId` */
  app.get<{ Params: { connectorId: string } }>(
    "/api/v1/connectors/:connectorId",
    { preHandler: administrator },
    async (request, reply) => {
      const connector = await findConnectorById(context.pool, request.params.connectorId);
      if (connector === null || connector.organisationId !== context.config.organisationId) {
        // Defence in depth: a connector outside this organisation is reported
        // as absent rather than as forbidden (docs/TESTING.md section 10,
        // "Organisation A cannot enumerate organisation B IDs").
        return reply.code(404).send({
          error: { code: "NOT_FOUND", message: "No such connector." },
          meta: { request_id: request.id },
        });
      }
      return reply.send({
        data: {
          id: connector.id,
          environment_id: connector.environmentId,
          project_id: connector.projectId,
          certificate_fingerprint: connector.certificateFingerprint,
          certificate_not_after: connector.certificateNotAfter.toISOString(),
          version: connector.version,
          capabilities: connector.capabilities,
          status: connector.status,
          connected_at: connector.connectedAt?.toISOString() ?? null,
          last_heartbeat_at: connector.lastHeartbeatAt?.toISOString() ?? null,
          revoked_at: connector.revokedAt?.toISOString() ?? null,
        },
        meta: { request_id: request.id },
      });
    },
  );
}
