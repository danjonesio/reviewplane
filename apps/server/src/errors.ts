/**
 * Stable API error codes and the response envelope of `docs/API.md` §5.
 *
 * `docs/API.md` §2 requires stable machine-readable codes, and
 * `docs/SECURITY.md` §18 requires codes rather than free text so that a failure
 * can be diagnosed without a log line carrying request data. The vocabulary is
 * the one `docs/MCP_SPEC.md` §12 already defines, plus `VALIDATION_FAILED`
 * (`docs/API.md` §5) and the connector error classes of
 * `docs/CONNECTOR_PROTOCOL.md` §21 where a failure originates in the tunnel; no
 * third vocabulary is invented here, and a failure that starts at the connector
 * or the browser worker reaches the caller under the same name it was given.
 */

import { ERROR_CLASS_VALUES } from "@reviewplane/protocol";
import type { ErrorClass } from "@reviewplane/protocol";

/** Codes from `docs/MCP_SPEC.md` §12 and `docs/API.md` §5. */
export const API_ERROR_CODES = [
  "AUTHENTICATION_REQUIRED",
  "AUTHORISATION_DENIED",
  "PROJECT_CONTEXT_AMBIGUOUS",
  "PROJECT_CONTEXT_MISMATCH",
  "RESOURCE_NOT_FOUND",
  "RESOURCE_STALE",
  "VERSION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "VALIDATION_FAILED",
  "CONNECTOR_OFFLINE",
  "PUBLISHED_SERVICE_UNAVAILABLE",
  "BROWSER_CAPACITY_EXHAUSTED",
  "BROWSER_SESSION_NOT_ACTIVE",
  "BROWSER_COMMAND_TIMEOUT",
  "CONTROL_NOT_OWNED",
  "CONTROL_EPOCH_STALE",
  "POLICY_DENIED",
  "APPROVAL_REQUIRED",
  "EVIDENCE_REQUIRED",
  "ARTEFACT_UPLOAD_INCOMPLETE",
  "UNSUPPORTED_CAPABILITY",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number] | ErrorClass;

/**
 * The name the review, agent and MCP modules use for the same vocabulary.
 *
 * One enumeration, two names: `docs/API.md` §5 and `docs/MCP_SPEC.md` §12 are
 * the same list, and an alias is cheaper than a second declaration that could
 * drift from it.
 */
export type ErrorCode = ApiErrorCode;

/**
 * The status each code is answered with unless a caller states otherwise.
 *
 * Deriving the status from the code is what stops two handlers reporting the
 * same failure differently. A handler may still override it where one code
 * covers both a malformed request and a conflicting one.
 */
const STATUS_BY_CODE: Readonly<Record<ApiErrorCode, number>> = {
  AUTHENTICATION_REQUIRED: 401,
  AUTHORISATION_DENIED: 403,
  // The caller authenticated and is authorised; it has not said enough. A
  // conflict rather than a 400, because the request is well formed and the
  // resolution is to name one of the candidates the refusal returns.
  PROJECT_CONTEXT_AMBIGUOUS: 409,
  PROJECT_CONTEXT_MISMATCH: 403,
  RESOURCE_NOT_FOUND: 404,
  RESOURCE_STALE: 409,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  VALIDATION_FAILED: 422,
  CONNECTOR_OFFLINE: 503,
  // A route the deployment does not carry, or one that is no longer pending:
  // the request conflicts with the route's state rather than reporting a
  // service that is temporarily away, which is CONNECTOR_OFFLINE's job.
  PUBLISHED_SERVICE_UNAVAILABLE: 409,
  BROWSER_CAPACITY_EXHAUSTED: 503,
  BROWSER_SESSION_NOT_ACTIVE: 409,
  BROWSER_COMMAND_TIMEOUT: 504,
  CONTROL_NOT_OWNED: 409,
  CONTROL_EPOCH_STALE: 409,
  POLICY_DENIED: 403,
  APPROVAL_REQUIRED: 403,
  EVIDENCE_REQUIRED: 422,
  ARTEFACT_UPLOAD_INCOMPLETE: 409,
  UNSUPPORTED_CAPABILITY: 400,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,

  // `docs/CONNECTOR_PROTOCOL.md` §21.
  ENROLMENT_TOKEN_INVALID: 401,
  IDENTITY_REVOKED: 403,
  PROTOCOL_UNSUPPORTED: 400,
  PROJECT_NOT_AUTHORISED: 403,
  WORKSPACE_NOT_FOUND: 404,
  DESTINATION_NOT_ALLOWED: 422,
  PORT_NOT_LISTENING: 503,
  ROUTE_LIMIT_EXCEEDED: 429,
  ROUTE_EXPIRED: 409,
  STREAM_LIMIT_EXCEEDED: 429,
  CONTROL_PLANE_UNAVAILABLE: 503,
  UPGRADE_REQUIRED: 426,
};

/** True when a code is one this API is allowed to answer with. */
export function isStableErrorCode(candidate: string): candidate is ApiErrorCode {
  return (
    (API_ERROR_CODES as readonly string[]).includes(candidate) ||
    (ERROR_CLASS_VALUES as readonly string[]).includes(candidate)
  );
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
  readonly meta: { readonly request_id: string };
}

/** Builds the error envelope. */
export function apiError(
  code: ApiErrorCode,
  message: string,
  requestId: string,
  details?: Readonly<Record<string, unknown>>,
): ApiErrorBody {
  return {
    error: details === undefined ? { code, message } : { code, message, details },
    meta: { request_id: requestId },
  };
}

/** Builds the success envelope of `docs/API.md` §5. */
export function apiData<T>(data: T, requestId: string): { data: T; meta: { request_id: string } } {
  return { data, meta: { request_id: requestId } };
}

/**
 * A failure with a stable code and an HTTP status.
 *
 * Handlers throw it and one error hook renders it, so that no handler can
 * accidentally answer with a stack trace or an unstructured message.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: ApiErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    status?: number,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status ?? STATUS_BY_CODE[code];
    this.details = details;
  }
}

export function notFound(what: string): ApiError {
  return new ApiError("RESOURCE_NOT_FOUND", `${what} was not found.`);
}

/** A minimal logger surface, so `renderError` does not depend on Fastify. */
interface ErrorLogger {
  error(details: Record<string, unknown>, message: string): void;
}

interface ErrorRequest {
  readonly id: string;
  readonly log: ErrorLogger;
}

interface ErrorReply {
  code(status: number): { send(body: unknown): unknown };
}

/**
 * Renders a failure.
 *
 * One hook renders every error so that no handler can answer with a stack trace
 * or an unstructured message, and so that an unexpected failure becomes
 * `INTERNAL_ERROR` rather than leaking what went wrong (`docs/SECURITY.md` §18).
 * A schema rejection from the HTTP framework becomes `VALIDATION_FAILED`, which
 * is the code `docs/API.md` §5 gives a body that does not satisfy its schema.
 */
export function renderError(error: unknown, request: ErrorRequest, reply: ErrorReply): void {
  if (error instanceof ApiError) {
    void reply.code(error.status).send(apiError(error.code, error.message, request.id, error.details));
    return;
  }
  if ((error as { validation?: unknown }).validation !== undefined) {
    void reply
      .code(STATUS_BY_CODE.VALIDATION_FAILED)
      .send(
        apiError(
          "VALIDATION_FAILED",
          "The request body does not match the schema for this endpoint.",
          request.id,
        ),
      );
    return;
  }
  request.log.error({ err: error, request_id: request.id }, "unhandled failure");
  void reply
    .code(500)
    .send(apiError("INTERNAL_ERROR", "The request could not be completed.", request.id));
}
