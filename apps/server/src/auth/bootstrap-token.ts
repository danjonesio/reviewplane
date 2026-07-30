/**
 * Stage 0 administrator authentication.
 *
 * `docs/ARCHITECTURE.md` section 11 lists an optional bootstrap administrator
 * token alongside local accounts, and `docs/SECURITY.md` section 6.1 requires
 * administrator bootstrap through a one-time token. Local accounts, session
 * cookies and CSRF belong to the issue that introduces human authentication;
 * until then this is the only credential the API accepts, and it is deliberately
 * the smallest thing that can be replaced without touching a handler.
 *
 * The comparison is constant time, and the token never reaches a log line, an
 * error body or a metric label (`docs/SECURITY.md` section 18).
 */

import { timingSafeEqual } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

import { apiError } from "../modules/published-services/errors.ts";

const BEARER = "Bearer ";

/** Compares a presented credential with the expected one, in constant time. */
export function credentialMatches(presented: string, expected: string): boolean {
  const presentedBytes = Buffer.from(presented, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (presentedBytes.length !== expectedBytes.length) {
    // timingSafeEqual requires equal lengths. Comparing against a digest of
    // each would hide the length, but the length of a fixed-length deployment
    // token is not the secret; its value is.
    return false;
  }
  return timingSafeEqual(presentedBytes, expectedBytes);
}

/**
 * Builds the Fastify pre-handler that requires the bootstrap token.
 *
 * It answers `AUTHENTICATION_REQUIRED` for both an absent and a wrong
 * credential: telling the two apart confirms to a caller that a token exists.
 */
export function requireBootstrapToken(token: string) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    const presented = typeof header === "string" && header.startsWith(BEARER)
      ? header.slice(BEARER.length)
      : "";
    if (presented === "" || !credentialMatches(presented, token)) {
      await reply
        .code(401)
        .send(
          apiError(
            "AUTHENTICATION_REQUIRED",
            "This endpoint requires the administrator token.",
            request.id,
          ),
        );
    }
  };
}
