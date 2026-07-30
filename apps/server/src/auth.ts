/**
 * Principal resolution.
 *
 * Stage 0 has three machine principals and one human one:
 *
 * * `administrator` — the bootstrap token of `docs/ARCHITECTURE.md` §11;
 * * `browser_worker` — a worker credential, scoped to the projects that worker
 *   is assigned to (`docs/SECURITY.md` §6.4);
 * * `agent_session` — an agent credential, resolved by
 *   `modules/agents/credentials.ts` and accepted only on the MCP endpoint
 *   (`docs/SECURITY.md` §6.3);
 * * human sessions, which arrive with the web UI as viewer sessions (ADR-0016).
 *
 * The separation is the point: `docs/SECURITY.md` §6.3 requires that a
 * non-human credential cannot reach an administrative API, and the same rule
 * applies to a worker and to an agent. `requireAdministrator` accepts only the
 * bootstrap token, and it is a superset of nothing.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import type { FastifyRequest } from "fastify";

import { ApiError } from "./errors.ts";
import { looksLikeAgentToken } from "./modules/agents/credentials.ts";

export interface AdministratorPrincipal {
  readonly type: "administrator";
}

export interface WorkerPrincipal {
  readonly type: "browser_worker";
  readonly workerId: string;
  readonly name: string;
  readonly assignedProjects: ReadonlySet<string>;
}

export type Principal = AdministratorPrincipal | WorkerPrincipal;

/** Constant-time comparison. Neither operand is ever logged. */
export function credentialMatches(presented: string, expected: string): boolean {
  const left = Buffer.from(presented, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) {
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function credentialDigest(credential: string): string {
  return createHash("sha256").update(credential, "utf8").digest("hex");
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer +([!-~]+)$/u.exec(header);
  return match === null ? null : (match[1] as string);
}

export function requireBearer(request: FastifyRequest): string {
  const token = bearerToken(request);
  if (token === null) {
    throw new ApiError("AUTHENTICATION_REQUIRED", "A bearer credential is required.");
  }
  return token;
}

/**
 * Requires the administrator bootstrap token. A worker or agent credential
 * presented here is refused with `AUTHORISATION_DENIED` rather than
 * `AUTHENTICATION_REQUIRED`, so the caller learns that it authenticated but
 * may not act, which is the distinction the security tests assert.
 *
 * The agent refusal is by token shape and not by lookup, deliberately. A
 * refusal that depended on resolving the credential would fail open exactly
 * when the database is unavailable — and `docs/SECURITY.md` §6.3 is not a rule
 * that may hold only while PostgreSQL is up. The prefix cannot cause an
 * admission, only a refusal, so getting it wrong is safe in the one direction
 * that matters.
 */
export function requireAdministrator(
  request: FastifyRequest,
  bootstrapToken: string,
  workerCredential: string,
): AdministratorPrincipal {
  const token = requireBearer(request);
  if (credentialMatches(token, bootstrapToken)) return { type: "administrator" };
  if (credentialMatches(token, workerCredential)) {
    throw new ApiError(
      "AUTHORISATION_DENIED",
      "A browser-worker credential cannot call the administrative API.",
    );
  }
  if (looksLikeAgentToken(token)) {
    throw new ApiError(
      "AUTHORISATION_DENIED",
      "An agent credential cannot call the administrative API (docs/SECURITY.md section 6.3).",
    );
  }
  throw new ApiError("AUTHENTICATION_REQUIRED", "The bearer credential was not recognised.");
}
