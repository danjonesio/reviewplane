/**
 * Administrator bootstrap and session authentication, against a real database
 * (`docs/TESTING.md` section 2 "Component", "Security" and "Fault injection";
 * RVP-12's mandatory negative tests).
 *
 * The security cases are the point of this file. Every one of them is a rule
 * from `docs/SECURITY.md` section 6.1 or 6.3 that would be invisible if it
 * regressed: a token that can be used twice still works the first time, a
 * missing CSRF check only shows up when somebody exploits it, and a credential
 * in an audit event is discovered years later in a backup.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { buildApp, type BuiltApp } from "../src/app.ts";
import { migrate } from "../src/db/migrate.ts";
import { createPool } from "../src/db/pool.ts";
import {
  MINIMUM_PASSWORD_LENGTH,
  SCRYPT_PARAMETERS,
  checkPasswordPolicy,
  hashPassword,
  verifyPassword,
  verifierParameters,
} from "../src/modules/identity/passwords.ts";
import { DUMMY_VERIFIER } from "../src/modules/identity/routes.ts";
import { MAX_FAILURES_PER_WINDOW } from "../src/modules/identity/rate-limit.ts";
import { TEST_BOOTSTRAP_TOKEN, TEST_WORKER_CREDENTIAL, testServerConfig } from "./support/config.ts";
import { eventsOfType, readSessionCookies, seedAccount } from "./support/identity.ts";
import {
  startMigratedDatabase,
  startPostgres,
  truncateAll,
  type MigratedDatabase,
} from "./support/postgres.ts";

const PASSWORD = "correct horse battery staple";
const ADMIN = { authorization: `Bearer ${TEST_BOOTSTRAP_TOKEN}` };

let postgres: MigratedDatabase;
let built: BuiltApp;
let artefactRoot: string;
let logs: string[];

before(async () => {
  postgres = await startMigratedDatabase();
  artefactRoot = await mkdtemp(join(tmpdir(), "reviewplane-identity-"));
});

after(async () => {
  await built?.stop();
  await postgres?.stop();
  if (artefactRoot !== undefined) await rm(artefactRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await built?.stop();
  await truncateAll(postgres.pool);
  logs = [];
  built = await buildApp({
    config: testServerConfig({ artefactPath: artefactRoot, logLevel: "info" }),
    pool: postgres.pool,
    outboxPollIntervalMs: 20,
    logDestination: {
      write(line: string) {
        logs.push(line);
      },
    },
  });
});

/** Mints an install token for the seeded account. */
async function mintInstallToken(
  account: { organisationId: string; userId: string },
  ttlSeconds?: number,
): Promise<string> {
  const issued = await built.installTokens.issue({
    organisationId: account.organisationId,
    userId: account.userId,
    ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
  });
  return issued.token;
}

/** Claims the installation and returns the account plus its session cookies. */
async function claim(email = "administrator@localhost") {
  const account = await seedAccount(postgres.pool, { email });
  const token = await mintInstallToken(account);
  const response = await built.app.inject({
    method: "POST",
    url: "/api/v1/auth/bootstrap",
    payload: { token, email, password: PASSWORD },
  });
  assert.equal(response.statusCode, 201, response.body);
  return { account, cookies: readSessionCookies(response), token };
}

async function signIn(email: string, password: string) {
  return built.app.inject({
    method: "POST",
    url: "/api/v1/auth/sessions",
    payload: { email, password },
  });
}

// ---------------------------------------------------------------------------
// Password verifiers
// ---------------------------------------------------------------------------

describe("password verifiers", () => {
  test("a verifier records the documented work factors and verifies constant-time", async () => {
    const verifier = await hashPassword(PASSWORD);
    // OWASP's current guidance for scrypt. The literal is written out rather
    // than built from the constant, so raising the cost has to be a deliberate
    // edit here as well as there.
    assert.match(verifier, /^scrypt\$N=131072,r=8,p=1\$/u);
    assert.deepEqual(verifierParameters(verifier), {
      algorithm: "scrypt",
      N: SCRYPT_PARAMETERS.N,
      r: SCRYPT_PARAMETERS.r,
      p: SCRYPT_PARAMETERS.p,
    });
    assert.equal(await verifyPassword(PASSWORD, verifier), true);
    assert.equal(await verifyPassword(`${PASSWORD} `, verifier), false);

    // Two verifiers for one password differ: the salt is per verifier, so a
    // stolen table cannot be attacked once for every account at a time.
    assert.notEqual(await hashPassword(PASSWORD), verifier);
  });

  test("a verifier whose work factors were lowered is refused rather than accepted quickly", async () => {
    const verifier = await hashPassword(PASSWORD);
    const weakened = verifier.replace("N=131072", "N=2");
    assert.equal(await verifyPassword(PASSWORD, weakened), false);
    assert.equal(verifierParameters(weakened), null);
  });

  test("the equal-work verifier used for an unknown address is a real verifier", async () => {
    // If it were malformed, verification would return early without doing the
    // work, and the timing difference this exists to remove would be back.
    assert.notEqual(verifierParameters(DUMMY_VERIFIER), null);
    assert.equal(await verifyPassword(PASSWORD, DUMMY_VERIFIER), false);
  });

  test("the password policy is length and nothing else", () => {
    assert.equal(checkPasswordPolicy("a".repeat(MINIMUM_PASSWORD_LENGTH)).ok, true);
    assert.equal(checkPasswordPolicy("a".repeat(MINIMUM_PASSWORD_LENGTH - 1)).ok, false);
    assert.equal(checkPasswordPolicy("a".repeat(1000)).ok, false);
    assert.equal(checkPasswordPolicy(42).ok, false);
    // A passphrase with spaces and punctuation is exactly what should pass.
    assert.equal(checkPasswordPolicy("a rather long passphrase!").ok, true);
  });

  test("length is measured on the form that is hashed, not the form that was typed", async () => {
    // "e" plus a combining acute accent: two code units that NFKC folds to one.
    const pair = `e${String.fromCharCode(0x0301)}`;

    // Twelve typed characters that become six. Measuring before normalisation
    // would accept this and then hash half of what the policy checked.
    const looksLongEnough = pair.repeat(6);
    assert.equal(looksLongEnough.length, 12);
    assert.equal(looksLongEnough.normalize("NFKC").length, 6);
    const refused = checkPasswordPolicy(looksLongEnough);
    assert.equal(refused.ok, false);
    assert.equal(refused.ok === false && refused.reason, "too_short");

    // A decomposed passphrase that really is long enough still passes.
    const genuinelyLong = pair.repeat(12);
    assert.equal(genuinelyLong.length, 24);
    assert.equal(genuinelyLong.normalize("NFKC").length, 12);
    assert.equal(checkPasswordPolicy(genuinelyLong).ok, true);

    // And the two spellings of one passphrase verify against each other, which
    // is what normalising before hashing is for.
    const verifier = await hashPassword(genuinelyLong);
    assert.equal(await verifyPassword(genuinelyLong.normalize("NFKC"), verifier), true);
  });
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

describe("administrator bootstrap", () => {
  test("an unclaimed installation says so, and a claimed one stops saying so", async () => {
    const account = await seedAccount(postgres.pool);
    const before = await built.app.inject({ method: "GET", url: "/api/v1/auth/bootstrap" });
    assert.equal(before.statusCode, 200);
    assert.equal((before.json() as { data: { bootstrap_required: boolean } }).data.bootstrap_required, true);

    const token = await mintInstallToken(account);
    const outstanding = await built.app.inject({ method: "GET", url: "/api/v1/auth/bootstrap" });
    assert.equal(
      (outstanding.json() as { data: { install_token_outstanding: boolean } }).data.install_token_outstanding,
      true,
    );

    const claimed = await built.app.inject({
      method: "POST",
      url: "/api/v1/auth/bootstrap",
      payload: { token, email: "dan@example.test", password: PASSWORD },
    });
    assert.equal(claimed.statusCode, 201, claimed.body);

    const after = await built.app.inject({ method: "GET", url: "/api/v1/auth/bootstrap" });
    const claimedStatus = (
      after.json() as { data: { bootstrap_required: boolean; install_token_outstanding: boolean } }
    ).data;
    assert.equal(claimedStatus.bootstrap_required, false);
    // A claimed deployment does not tell an unauthenticated caller whether a
    // reset token is in flight.
    assert.equal(claimedStatus.install_token_outstanding, false);

    // Exactly one administrator, and the address is the one just chosen.
    const users = await postgres.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM users WHERE password_hash IS NOT NULL",
    );
    assert.equal(users.rows[0]?.count, "1");
  });

  test("an install token cannot be used twice", async () => {
    const account = await seedAccount(postgres.pool);
    const token = await mintInstallToken(account);

    const first = await built.app.inject({
      method: "POST",
      url: "/api/v1/auth/bootstrap",
      payload: { token, email: "dan@example.test", password: PASSWORD },
    });
    assert.equal(first.statusCode, 201, first.body);

    const second = await built.app.inject({
      method: "POST",
      url: "/api/v1/auth/bootstrap",
      payload: { token, email: "someone-else@example.test", password: "another passphrase!" },
    });
    assert.equal(second.statusCode, 401, second.body);
    const body = second.json() as { error: { code: string; details?: { reason?: string } } };
    assert.equal(body.error.code, "AUTHENTICATION_REQUIRED");
    assert.equal(body.error.details?.reason, "install_token_consumed");
    process.stdout.write(`evidence: bootstrap reuse refused ${second.body}\n`);

    // The refused attempt changed nothing: the address is still the first one.
    const user = await postgres.pool.query<{ email: string }>(
      "SELECT email FROM users WHERE id = $1",
      [account.userId],
    );
    assert.equal(user.rows[0]?.email, "dan@example.test");

    const failures = await eventsOfType(postgres.pool, account.organisationId, "authentication.login_failed");
    assert.equal(failures.at(-1)?.payload["reason"], "install_token_consumed");
  });

  test("an expired install token is refused", async () => {
    const account = await seedAccount(postgres.pool);
    const token = await mintInstallToken(account, 60);
    // Both timestamps move: the table refuses a token that expires before it
    // was created, which is the constraint that stops a zero-life token being
    // inserted in the first place.
    await postgres.pool.query(
      `UPDATE install_tokens
          SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
        WHERE user_id = $1`,
      [account.userId],
    );

    const response = await built.app.inject({
      method: "POST",
      url: "/api/v1/auth/bootstrap",
      payload: { token, email: "dan@example.test", password: PASSWORD },
    });
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(
      (response.json() as { error: { details?: { reason?: string } } }).error.details?.reason,
      "install_token_expired",
    );
    const failures = await eventsOfType(postgres.pool, account.organisationId, "authentication.login_failed");
    assert.equal(failures.at(-1)?.payload["reason"], "install_token_expired");
  });

  test("a token that was never issued is refused, and a weak password never reaches the token", async () => {
    const account = await seedAccount(postgres.pool);
    await mintInstallToken(account);

    const unknown = await built.app.inject({
      method: "POST",
      url: "/api/v1/auth/bootstrap",
      payload: { token: "rpi_not-a-real-token", email: "dan@example.test", password: PASSWORD },
    });
    assert.equal(unknown.statusCode, 401);
    assert.equal(
      (unknown.json() as { error: { details?: { reason?: string } } }).error.details?.reason,
      "install_token_invalid",
    );

    const weak = await built.app.inject({
      method: "POST",
      url: "/api/v1/auth/bootstrap",
      payload: { token: "rpi_not-a-real-token", email: "dan@example.test", password: "short" },
    });
    assert.equal(weak.statusCode, 422);
    assert.equal((weak.json() as { error: { code: string } }).error.code, "VALIDATION_FAILED");
  });

  test("claiming the installation records the invitation, the credential and the login", async () => {
    const { account } = await claim();
    const stream = account.organisationId;
    assert.equal((await eventsOfType(postgres.pool, stream, "user.invited")).length, 1);
    const credentials = await eventsOfType(postgres.pool, stream, "user.credentials_set");
    assert.equal(credentials.length, 1);
    assert.equal(credentials[0]?.payload["method"], "install_token");
    const logins = await eventsOfType(postgres.pool, stream, "authentication.login_succeeded");
    assert.equal(logins.length, 1);
    assert.equal(logins[0]?.payload["method"], "install_token");
    assert.equal(logins[0]?.payload["user_id"], account.userId);
    process.stdout.write(
      `evidence: authentication.login_succeeded ${JSON.stringify(logins[0]?.payload)}\n`,
    );
  });
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

describe("password sessions", () => {
  test("a sign-in sets an HttpOnly SameSite session cookie and a readable CSRF cookie", async () => {
    const account = await seedAccount(postgres.pool);
    const token = await mintInstallToken(account);
    await built.app.inject({
      method: "POST",
      url: "/api/v1/auth/bootstrap",
      payload: { token, email: account.email, password: PASSWORD },
    });

    const response = await signIn(account.email, PASSWORD);
    assert.equal(response.statusCode, 201, response.body);

    const cookies = response.cookies as {
      name: string;
      value: string;
      httpOnly?: boolean;
      sameSite?: string;
    }[];
    const session = cookies.find((cookie) => cookie.name === "reviewplane_viewer");
    const csrf = cookies.find((cookie) => cookie.name === "reviewplane_csrf");
    assert.ok(session !== undefined && csrf !== undefined);
    assert.equal(session.httpOnly, true, "the session cookie is readable by script");
    assert.equal(String(session.sameSite).toLowerCase(), "strict");
    // The CSRF cookie must be readable: the application echoes it in a header.
    assert.notEqual(csrf.httpOnly, true);
    assert.equal(String(csrf.sameSite).toLowerCase(), "strict");

    // The session token itself is not in the body, and only its digest is stored.
    assert.ok(!response.body.includes(session.value));
    const stored = await postgres.pool.query<{ token_sha256: string; csrf_token_sha256: string | null }>(
      "SELECT token_sha256, csrf_token_sha256 FROM viewer_sessions WHERE user_id = $1",
      [account.userId],
    );
    for (const row of stored.rows) {
      assert.match(row.token_sha256, /^[0-9a-f]{64}$/u);
      assert.match(String(row.csrf_token_sha256), /^[0-9a-f]{64}$/u);
    }
  });

  test("a wrong password and an unknown address are the same refusal", async () => {
    const { account } = await claim();
    const wrong = await signIn(account.email, "not the passphrase");
    const unknown = await signIn("nobody@example.test", PASSWORD);

    assert.equal(wrong.statusCode, 401);
    assert.equal(unknown.statusCode, 401);
    assert.deepEqual(
      (wrong.json() as { error: { code: string; message: string } }).error,
      (unknown.json() as { error: { code: string; message: string } }).error,
    );

    const failures = await eventsOfType(postgres.pool, account.organisationId, "authentication.login_failed");
    const reasons = failures.map((failure) => failure.payload["reason"]);
    assert.ok(reasons.includes("invalid_password"), reasons.join(","));
    assert.ok(reasons.includes("unknown_user"), reasons.join(","));
    // The failure that named no account also named no address.
    const anonymous = failures.find((failure) => failure.payload["reason"] === "unknown_user");
    assert.equal(anonymous?.payload["user_id"], undefined);
    assert.equal(anonymous?.actor_type, "system");
  });

  test("signing in replaces the session the request arrived with", async () => {
    const { account, cookies } = await claim();
    const first = await built.app.inject({
      method: "GET",
      url: "/api/v1/auth/sessions/current",
      headers: cookies.readHeaders,
    });
    assert.equal(first.statusCode, 200);

    const again = await built.app.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: cookies.readHeaders,
      payload: { email: account.email, password: PASSWORD },
    });
    assert.equal(again.statusCode, 201, again.body);

    // The cookie the request arrived with no longer resolves.
    const replayed = await built.app.inject({
      method: "GET",
      url: "/api/v1/auth/sessions/current",
      headers: cookies.readHeaders,
    });
    assert.equal(replayed.statusCode, 401, "a rotated session still authenticates");

    const revocations = await eventsOfType(postgres.pool, account.organisationId, "session.revoked");
    assert.ok(revocations.some((event) => event.payload["reason"] === "rotated"));

    // The replacement names what it replaced, so the pair reads as a rotation.
    const lineage = await postgres.pool.query<{ rotated_from_session_id: string | null }>(
      "SELECT rotated_from_session_id FROM viewer_sessions WHERE revoked_at IS NULL AND user_id = $1",
      [account.userId],
    );
    assert.equal(lineage.rows.length, 1);
    assert.notEqual(lineage.rows[0]?.rotated_from_session_id, null);
  });

  test("a signed-out cookie is refused when it is replayed", async () => {
    const { account, cookies } = await claim();
    const out = await built.app.inject({
      method: "DELETE",
      url: "/api/v1/auth/sessions/current",
      headers: cookies.writeHeaders,
    });
    assert.equal(out.statusCode, 204);

    const replayed = await built.app.inject({
      method: "GET",
      url: "/api/v1/auth/sessions/current",
      headers: cookies.readHeaders,
    });
    assert.equal(replayed.statusCode, 401);

    const revocations = await eventsOfType(postgres.pool, account.organisationId, "session.revoked");
    assert.ok(revocations.some((event) => event.payload["reason"] === "sign_out"));
  });

  test("revoking every session of an account takes the one that asked", async () => {
    const { account, cookies } = await claim();
    const second = await signIn(account.email, PASSWORD);
    const secondCookies = readSessionCookies(second);

    const revoked = await built.app.inject({
      method: "DELETE",
      url: "/api/v1/auth/sessions",
      headers: secondCookies.writeHeaders,
    });
    assert.equal(revoked.statusCode, 204, revoked.body);

    for (const headers of [cookies.readHeaders, secondCookies.readHeaders]) {
      const response = await built.app.inject({
        method: "GET",
        url: "/api/v1/auth/sessions/current",
        headers,
      });
      assert.equal(response.statusCode, 401);
    }
  });

  test("a suspended account stops authenticating on its next request", async () => {
    const { account, cookies } = await claim();
    await postgres.pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [account.userId]);
    const response = await built.app.inject({
      method: "GET",
      url: "/api/v1/auth/sessions/current",
      headers: cookies.readHeaders,
    });
    assert.equal(response.statusCode, 401);
  });
});

// ---------------------------------------------------------------------------
// The mandatory negative cases
// ---------------------------------------------------------------------------

describe("security", () => {
  test("a state-changing request with a missing or wrong CSRF token is refused", async () => {
    const { cookies } = await claim();
    const payload = { name: "Refresh Surplus" };

    const missing = await built.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: cookies.readHeaders,
      payload,
    });
    assert.equal(missing.statusCode, 403, missing.body);
    assert.equal((missing.json() as { error: { code: string } }).error.code, "AUTHORISATION_DENIED");
    process.stdout.write(`evidence: CSRF rejection ${missing.body}\n`);

    const wrong = await built.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...cookies.readHeaders, "x-csrf-token": "not-the-token" },
      payload,
    });
    assert.equal(wrong.statusCode, 403, wrong.body);

    // Another session's token is no better than an invented one.
    const other = await claim("second@example.test");
    const borrowed = await built.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...cookies.readHeaders, "x-csrf-token": other.cookies.csrfToken },
      payload,
    });
    assert.equal(borrowed.statusCode, 403, borrowed.body);

    const accepted = await built.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: cookies.writeHeaders,
      payload,
    });
    assert.equal(accepted.statusCode, 201, accepted.body);
  });

  test("the ADR-0016 sign-out route cannot end an account session without the CSRF token", async () => {
    // The review's F1: this route revoked whatever the cookie resolved to,
    // including a password session, with no CSRF check and no event. Both
    // halves are asserted, because either one alone would still be a defect.
    const { account, cookies } = await claim();

    const forged = await built.app.inject({
      method: "DELETE",
      url: "/api/v1/auth/viewer-sessions/current",
      headers: cookies.readHeaders,
    });
    assert.equal(forged.statusCode, 403, forged.body);
    assert.equal((forged.json() as { error: { code: string } }).error.code, "AUTHORISATION_DENIED");

    // The session survived the attempt.
    const alive = await built.app.inject({
      method: "GET",
      url: "/api/v1/auth/sessions/current",
      headers: cookies.readHeaders,
    });
    assert.equal(alive.statusCode, 200, "a forged sign-out ended the session");

    // With the token it works, and it leaves a record.
    const signedOut = await built.app.inject({
      method: "DELETE",
      url: "/api/v1/auth/viewer-sessions/current",
      headers: cookies.writeHeaders,
    });
    assert.equal(signedOut.statusCode, 204, signedOut.body);
    const dead = await built.app.inject({
      method: "GET",
      url: "/api/v1/auth/sessions/current",
      headers: cookies.readHeaders,
    });
    assert.equal(dead.statusCode, 401);

    const revocations = await eventsOfType(
      postgres.pool,
      account.organisationId,
      "session.revoked",
    );
    assert.ok(
      revocations.some((event) => event.payload["reason"] === "sign_out"),
      "the revocation left no audit record",
    );
  });

  test("the bootstrap exchange can still end its own session, and that is audited too", async () => {
    // It carries no CSRF token, so the strict guard would leave it unable to
    // sign out at all. What it must not do is end silently.
    await seedAccount(postgres.pool);
    const exchange = await built.app.inject({
      method: "POST",
      url: "/api/v1/auth/viewer-sessions",
      headers: ADMIN,
    });
    assert.equal(exchange.statusCode, 201);
    const cookie = (exchange.cookies as { name: string; value: string }[]).find(
      (candidate) => candidate.name === "reviewplane_viewer",
    );
    assert.ok(cookie !== undefined);
    const headers = { cookie: `reviewplane_viewer=${cookie.value}` };

    const signedOut = await built.app.inject({
      method: "DELETE",
      url: "/api/v1/auth/viewer-sessions/current",
      headers,
    });
    assert.equal(signedOut.statusCode, 204, signedOut.body);

    const replayed = await built.app.inject({
      method: "GET",
      url: "/api/v1/auth/viewer-sessions/current",
      headers,
    });
    assert.equal(replayed.statusCode, 401);

    // The session named no organisation, so the event went to the deployment's
    // own; what matters is that it exists.
    const revocations = await postgres.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM events WHERE type = 'session.revoked'",
    );
    assert.equal(revocations.rows[0]?.count, "1");
  });

  test("the ADR-0016 viewer session cannot reach a state-changing route", async () => {
    // It carries no CSRF token, which is what keeps it the read-only credential
    // ADR-0016 describes now that state-changing routes accept a cookie.
    const exchange = await built.app.inject({
      method: "POST",
      url: "/api/v1/auth/viewer-sessions",
      headers: ADMIN,
    });
    assert.equal(exchange.statusCode, 201);
    const cookie = (exchange.cookies as { name: string; value: string }[]).find(
      (candidate) => candidate.name === "reviewplane_viewer",
    );
    assert.ok(cookie !== undefined);

    const response = await built.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { cookie: `reviewplane_viewer=${cookie.value}` },
      payload: { name: "Refresh Surplus" },
    });
    assert.equal(response.statusCode, 403, response.body);
  });

  test("the login rate limit engages and the refusal carries a retry hint", async () => {
    const { account } = await claim();
    let limited: Awaited<ReturnType<typeof signIn>> | null = null;
    for (let attempt = 0; attempt < MAX_FAILURES_PER_WINDOW + 1; attempt += 1) {
      const response = await signIn(account.email, `wrong ${String(attempt)} passphrase`);
      if (response.statusCode === 429) {
        limited = response;
        break;
      }
      assert.equal(response.statusCode, 401);
    }
    assert.ok(limited !== null, "the limiter never engaged");
    const body = limited.json() as { error: { code: string; details?: { retry_after_ms?: number } } };
    assert.equal(body.error.code, "RATE_LIMITED");
    assert.ok((body.error.details?.retry_after_ms ?? 0) > 0);

    // The correct password is refused too while the lockout holds: a limiter
    // that let the right password through would not be a limiter.
    const correct = await signIn(account.email, PASSWORD);
    assert.equal(correct.statusCode, 429);

    const failures = await eventsOfType(postgres.pool, account.organisationId, "authentication.login_failed");
    assert.ok(failures.some((failure) => failure.payload["reason"] === "rate_limited"));
  });

  test("a browser-worker credential cannot become a human session or administer projects", async () => {
    await claim();
    const worker = { authorization: `Bearer ${TEST_WORKER_CREDENTIAL}` };

    const session = await built.app.inject({
      method: "GET",
      url: "/api/v1/auth/sessions/current",
      headers: worker,
    });
    assert.equal(session.statusCode, 403, session.body);
    assert.equal((session.json() as { error: { code: string } }).error.code, "AUTHORISATION_DENIED");

    const create = await built.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: worker,
      payload: { name: "Refresh Surplus" },
    });
    assert.equal(create.statusCode, 403, create.body);
  });

  test("an agent credential cannot become a human session or call project administration", async () => {
    const { cookies } = await claim();
    const project = await built.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: cookies.writeHeaders,
      payload: { name: "Refresh Surplus" },
    });
    assert.equal(project.statusCode, 201, project.body);
    const projectId = (project.json() as { data: { id: string; organisation_id: string } }).data;

    const issued = await built.app.inject({
      method: "POST",
      url: `/api/v1/organisations/${projectId.organisation_id}/agent-credentials`,
      headers: ADMIN,
      payload: {
        project_ids: [projectId.id],
        capabilities: ["review:read"],
        label: "test agent",
      },
    });
    assert.equal(issued.statusCode, 201, issued.body);
    const token = (issued.json() as { data: { token: string } }).data.token;
    const agent = { authorization: `Bearer ${token}` };

    // Not a human session…
    const session = await built.app.inject({
      method: "GET",
      url: "/api/v1/auth/sessions/current",
      headers: agent,
    });
    assert.equal(session.statusCode, 403, session.body);

    // …and not an administrator, on any of the project routes.
    for (const request of [
      { method: "POST" as const, url: "/api/v1/projects", payload: { name: "Another" } },
      { method: "PATCH" as const, url: `/api/v1/projects/${projectId.id}`, payload: { name: "Renamed" } },
      { method: "DELETE" as const, url: `/api/v1/projects/${projectId.id}` },
    ]) {
      const response = await built.app.inject({ ...request, headers: agent });
      assert.equal(response.statusCode, 403, `${request.method} ${request.url}: ${response.body}`);
      assert.equal(
        (response.json() as { error: { code: string } }).error.code,
        "AUTHORISATION_DENIED",
      );
    }

    // The project is untouched by the attempt.
    const after = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId.id}`,
      headers: cookies.readHeaders,
    });
    assert.equal((after.json() as { data: { name: string; status: string } }).data.name, "Refresh Surplus");
    assert.equal((after.json() as { data: { status: string } }).data.status, "active");
  });

  test("a connector enrolment token cannot be exchanged for a human session", async () => {
    const { account } = await claim();
    const enrolment = await built.app.inject({
      method: "POST",
      url: "/api/v1/connectors/enrolment-tokens",
      headers: ADMIN,
      payload: { environment_name: "dev-vm" },
    });
    // The route exists in the connector module; if it ever moves, the test
    // still has to prove the property, so an unexpected shape fails loudly.
    assert.equal(enrolment.statusCode, 201, enrolment.body);
    const token = (enrolment.json() as { data: { enrolment_token: string } }).data.enrolment_token;

    // As a bearer credential it is not recognised at all.
    const asBearer = await built.app.inject({
      method: "GET",
      url: "/api/v1/auth/sessions/current",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(asBearer.statusCode, 401, asBearer.body);

    // As a password it is simply a wrong password.
    const asPassword = await signIn(account.email, token);
    assert.equal(asPassword.statusCode, 401, asPassword.body);

    // As an install token it is not one.
    const asInstallToken = await built.app.inject({
      method: "POST",
      url: "/api/v1/auth/bootstrap",
      payload: { token, email: account.email, password: PASSWORD },
    });
    assert.equal(asInstallToken.statusCode, 401, asInstallToken.body);

    const sessions = await postgres.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM viewer_sessions WHERE revoked_at IS NULL",
    );
    assert.equal(sessions.rows[0]?.count, "1", "an extra session was issued");
  });

  test("no credential material reaches a log line or an event payload", async () => {
    const { account, token } = await claim();
    await signIn(account.email, PASSWORD);
    await signIn(account.email, "a wrong passphrase entirely");

    const written = logs.join("\n");
    for (const secret of [PASSWORD, token, "a wrong passphrase entirely"]) {
      assert.ok(!written.includes(secret), "a credential reached the log");
    }

    const events = await postgres.pool.query<{ payload: unknown; correlation: unknown }>(
      "SELECT payload, correlation FROM events",
    );
    const serialised = JSON.stringify(events.rows);
    for (const secret of [PASSWORD, token, account.email]) {
      assert.ok(!serialised.includes(secret), `an event payload carried ${secret === token ? "a token" : "a credential or address"}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Fault injection
// ---------------------------------------------------------------------------

describe("when the database is unavailable during a sign-in", () => {
  test("the failure is clear and no session is issued", async () => {
    // A real outage rather than an unreachable address: the deployment is
    // working, an administrator exists, and then PostgreSQL goes away
    // mid-session (`docs/ARCHITECTURE.md` section 14).
    const isolated = await startPostgres();
    const pool = createPool(isolated.url);
    await migrate(pool);
    let app: BuiltApp | undefined;
    try {
      app = await buildApp({
        config: testServerConfig({ artefactPath: artefactRoot }),
        pool,
        outboxPollIntervalMs: 60_000,
      });
      const account = await seedAccount(pool, { email: "outage@example.test", slug: "outage-org" });
      const token = await app.installTokens.issue({
        organisationId: account.organisationId,
        userId: account.userId,
      });
      const claimed = await app.app.inject({
        method: "POST",
        url: "/api/v1/auth/bootstrap",
        payload: { token: token.token, email: account.email, password: PASSWORD },
      });
      assert.equal(claimed.statusCode, 201, claimed.body);

      await isolated.stop();

      const response = await app.app.inject({
        method: "POST",
        url: "/api/v1/auth/sessions",
        payload: { email: account.email, password: PASSWORD },
      });
      assert.equal(response.statusCode, 500, response.body);
      assert.equal((response.json() as { error: { code: string } }).error.code, "INTERNAL_ERROR");
      assert.equal(
        (response.cookies as { name: string }[]).length,
        0,
        "a session cookie was issued while the database was unavailable",
      );
      // The refusal says nothing about the database it could not reach.
      assert.ok(!response.body.includes(isolated.url));
    } finally {
      await app?.stop();
      await pool.end().catch(() => undefined);
      await isolated.stop().catch(() => undefined);
    }
  });
});
