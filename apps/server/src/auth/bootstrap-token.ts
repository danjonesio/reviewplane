/**
 * Stage 0 administrator authentication.
 *
 * `docs/ARCHITECTURE.md` §11 lists an optional bootstrap administrator token
 * alongside local accounts, and `docs/SECURITY.md` §6.1 requires administrator
 * bootstrap through a one-time token. Local accounts, session cookies and CSRF
 * belong to the issue that introduces human authentication; until then this is
 * the only human credential the API accepts, and it is deliberately the
 * smallest thing that can be replaced without touching a handler.
 *
 * A machine credential must never work here: `docs/SECURITY.md` §6.3 and
 * `docs/TESTING.md` §10 require that a connector or worker token cannot become
 * a human session, so the only accepted value is the bootstrap token itself.
 *
 * The comparison is constant time, and the token never reaches a log line, an
 * error body or a metric label (`docs/SECURITY.md` §18).
 */

import { createHash, timingSafeEqual } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

import { apiError } from "../errors.ts";

/**
 * Compares two secrets without leaking their length or a prefix match.
 *
 * Both sides are hashed first, so the comparison is over two equal-length
 * digests and an early return cannot reveal how much of the credential was
 * right.
 */
export function credentialMatches(presented: string, expected: string): boolean {
  const presentedDigest = createHash("sha256").update(presented, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

export function extractBearerToken(header: string | undefined): string | null {
  const match = header === undefined ? null : /^Bearer[ ]+(?<token>[!-~]+)$/u.exec(header);
  return match?.groups?.["token"] ?? null;
}

/**
 * Builds the pre-handler that guards administrative routes.
 *
 * It answers `AUTHENTICATION_REQUIRED` for both an absent and a wrong
 * credential: telling the two apart confirms to a caller that a token exists.
 * The body carries a stable code and no detail about why the credential failed.
 */
export function requireBootstrapAdministrator(expectedToken: string) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const presented = extractBearerToken(request.headers.authorization);
    if (presented === null || !credentialMatches(presented, expectedToken)) {
      request.log.warn({ route: request.url }, "administrative request rejected");
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
