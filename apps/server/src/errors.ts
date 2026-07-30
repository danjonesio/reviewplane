/**
 * Stable error codes and the HTTP shape they are reported in.
 *
 * The codes are the `docs/MCP_SPEC.md` section 12 enumeration, so a refusal
 * that starts at the worker reaches the agent without being renamed on the
 * way. `docs/API.md` section 5 fixes the response envelope.
 */

import type { FastifyReply, FastifyRequest } from "fastify";

export type ErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "AUTHORISATION_DENIED"
  | "PROJECT_CONTEXT_MISMATCH"
  | "RESOURCE_NOT_FOUND"
  | "RESOURCE_STALE"
  | "VERSION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "BROWSER_CAPACITY_EXHAUSTED"
  | "BROWSER_SESSION_NOT_ACTIVE"
  | "CONTROL_NOT_OWNED"
  | "CONTROL_EPOCH_STALE"
  | "BROWSER_COMMAND_TIMEOUT"
  | "POLICY_DENIED"
  | "EVIDENCE_REQUIRED"
  | "ARTEFACT_UPLOAD_INCOMPLETE"
  | "UNSUPPORTED_CAPABILITY"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

const STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  AUTHENTICATION_REQUIRED: 401,
  AUTHORISATION_DENIED: 403,
  PROJECT_CONTEXT_MISMATCH: 403,
  RESOURCE_NOT_FOUND: 404,
  RESOURCE_STALE: 409,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  BROWSER_CAPACITY_EXHAUSTED: 503,
  BROWSER_SESSION_NOT_ACTIVE: 409,
  CONTROL_NOT_OWNED: 409,
  CONTROL_EPOCH_STALE: 409,
  BROWSER_COMMAND_TIMEOUT: 504,
  POLICY_DENIED: 403,
  EVIDENCE_REQUIRED: 422,
  ARTEFACT_UPLOAD_INCOMPLETE: 409,
  UNSUPPORTED_CAPABILITY: 400,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }
}

export function notFound(what: string): ApiError {
  return new ApiError("RESOURCE_NOT_FOUND", `${what} was not found.`);
}

/** Renders an error in the `docs/API.md` section 5 envelope. */
export function errorHandler(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const requestId = request.id;
  if (error instanceof ApiError) {
    void reply.status(error.status).send({
      error: {
        code: error.code,
        message: error.message,
        ...(Object.keys(error.details).length === 0 ? {} : { details: error.details }),
      },
      meta: { request_id: requestId },
    });
    return;
  }
  const validation = (error as { validation?: unknown }).validation;
  if (validation !== undefined) {
    void reply.status(400).send({
      error: {
        code: "UNSUPPORTED_CAPABILITY",
        message: "The request body does not match the schema for this endpoint.",
      },
      meta: { request_id: requestId },
    });
    return;
  }
  request.log.error({ err: error }, "unhandled request failure");
  void reply.status(500).send({
    error: { code: "INTERNAL_ERROR", message: "The request could not be completed." },
    meta: { request_id: requestId },
  });
}
