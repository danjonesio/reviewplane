/**
 * Stage 0 administrator authentication.
 *
 * `docs/ARCHITECTURE.md` §11 permits an "optional bootstrap administrator
 * token" while local accounts and OIDC are not yet built. It protects the
 * administrative API surface only, is compared in constant time, and is never
 * logged (`docs/SECURITY.md` §18).
 *
 * A connector credential must never work here: `docs/TESTING.md` §10 requires
 * that a connector token cannot become a human session, so the only accepted
 * value is the bootstrap token itself.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

/** Compares two secrets without leaking their length or a prefix match. */
export function credentialsMatch(presented: string, expected: string): boolean {
  const presentedDigest = createHash("sha256").update(presented, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

export function extractBearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer[ ]+(?<token>[\x21-\x7e]+)$/.exec(header);
  return match?.groups?.["token"] ?? null;
}

/**
 * Builds the pre-handler that guards administrative routes. The rejection body
 * carries a stable code and no detail about why the credential failed.
 */
export function requireBootstrapAdministrator(expectedToken: string) {
  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const presented = extractBearerToken(request.headers.authorization);
    if (presented === null || !credentialsMatch(presented, expectedToken)) {
      request.log.warn({ route: request.url }, "administrative request rejected");
      await reply.code(401).send({
        error: {
          code: "UNAUTHORISED",
          message: "A bootstrap administrator token is required for this endpoint.",
        },
        meta: { request_id: request.id },
      });
    }
  };
}
