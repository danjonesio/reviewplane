/**
 * Stable API error codes and the response envelope of `docs/API.md` section 5.
 *
 * `docs/API.md` section 2 requires stable machine-readable codes, and
 * `docs/SECURITY.md` section 18 requires codes rather than free text so that a
 * failure can be diagnosed without a log line carrying request data. The
 * vocabulary is the one `docs/MCP_SPEC.md` section 12 already defines, plus the
 * connector error classes of `docs/CONNECTOR_PROTOCOL.md` section 21 where a
 * failure originates in the tunnel; no third vocabulary is invented here.
 */

import { ERROR_CLASS_VALUES } from "@reviewplane/protocol";
import type { ErrorClass } from "@reviewplane/protocol";

/** Codes from `docs/MCP_SPEC.md` section 12 that this module answers with. */
export const API_ERROR_CODES = [
  "AUTHENTICATION_REQUIRED",
  "AUTHORISATION_DENIED",
  "RESOURCE_NOT_FOUND",
  "VALIDATION_FAILED",
  "CONNECTOR_OFFLINE",
  "PUBLISHED_SERVICE_UNAVAILABLE",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number] | ErrorClass;

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

/** Builds the success envelope of `docs/API.md` section 5. */
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
    status: number,
    code: ApiErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
