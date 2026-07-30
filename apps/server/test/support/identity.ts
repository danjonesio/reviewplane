/**
 * Seeding and cookie handling for the human-authentication suites.
 *
 * `truncateAll` removes the organisation and user that migration 0055 seeds —
 * it has to, or one suite's projects would be visible to the next — so a test
 * that needs an account creates one here. The rows are written directly rather
 * than through an API, because no API creates a user: Stage 1 has exactly one,
 * and it arrives with the schema.
 */

import assert from "node:assert/strict";

import { newEntityId } from "@reviewplane/protocol/platform";

import type { Pool } from "../../src/db/pool.ts";

export interface SeededAccount {
  readonly organisationId: string;
  readonly userId: string;
  readonly email: string;
}

/** An organisation and its single, credential-less user. */
export async function seedAccount(
  pool: Pool,
  options: { readonly email?: string; readonly slug?: string } = {},
): Promise<SeededAccount> {
  const organisationId = newEntityId("organisation");
  const userId = newEntityId("user");
  const email = options.email ?? "administrator@localhost";
  const slug = options.slug ?? `org-${organisationId.slice(4, 14)}`;
  await pool.query("INSERT INTO organisations (id, name, slug) VALUES ($1, $2, $3)", [
    organisationId,
    "ReviewPlane",
    slug,
  ]);
  await pool.query(
    "INSERT INTO users (id, organisation_id, email, display_name) VALUES ($1, $2, $3, $4)",
    [userId, organisationId, email, "Administrator"],
  );
  return { organisationId, userId, email };
}

export interface SessionCookies {
  /** The `Cookie` header value carrying both cookies. */
  readonly header: string;
  /** The CSRF token, as the application would read it from its own cookie. */
  readonly csrfToken: string;
  /** Headers for a state-changing request: cookie plus the CSRF header. */
  readonly writeHeaders: Readonly<Record<string, string>>;
  /** Headers for a read: cookie alone, which is all a read needs. */
  readonly readHeaders: Readonly<Record<string, string>>;
}

interface InjectedCookie {
  readonly name: string;
  readonly value: string;
  readonly httpOnly?: boolean;
  readonly sameSite?: string;
  readonly secure?: boolean;
  readonly maxAge?: number;
}

/** Reads the cookie pair a sign-in set, and asserts the attributes on it. */
export function readSessionCookies(response: {
  readonly cookies: readonly unknown[];
}): SessionCookies {
  const cookies = response.cookies as readonly InjectedCookie[];
  const session = cookies.find((cookie) => cookie.name === "reviewplane_viewer");
  const csrf = cookies.find((cookie) => cookie.name === "reviewplane_csrf");
  assert.ok(session !== undefined, "the response set no session cookie");
  assert.ok(csrf !== undefined, "the response set no CSRF cookie");
  const header = `reviewplane_viewer=${session.value}; reviewplane_csrf=${csrf.value}`;
  return {
    header,
    csrfToken: decodeURIComponent(csrf.value),
    writeHeaders: { cookie: header, "x-csrf-token": decodeURIComponent(csrf.value) },
    readHeaders: { cookie: header },
  };
}

/** The events a stream holds, newest last. */
export async function eventsOfType(
  pool: Pool,
  streamKey: string,
  type: string,
): Promise<{ payload: Record<string, unknown>; actor_type: string }[]> {
  const rows = await pool.query<{ payload: Record<string, unknown>; actor_type: string }>(
    `SELECT payload, actor_type FROM events WHERE stream_key = $1 AND type = $2 ORDER BY sequence ASC`,
    [streamKey, type],
  );
  return rows.rows;
}
