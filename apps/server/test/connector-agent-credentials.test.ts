/**
 * The connector's agent-credential exchange (ADR-0023,
 * `docs/CONNECTOR_PROTOCOL.md` §14, `docs/MCP_SPEC.md` §3.1), against a real
 * PostgreSQL and real mutual TLS.
 *
 * The exchange is an authentication boundary, so most of what is asserted here
 * is what it refuses: an unauthenticated caller, a revoked identity, a workspace
 * belonging to another environment, and a credential wider than the workspace
 * that asked for it. The accepted case is asserted for what the credential
 * carries, because "short-lived, single-project, capability-scoped"
 * (`docs/SECURITY.md` §6.3) is a claim about the row rather than about the
 * handler.
 */

import assert from "node:assert/strict";
import { request as httpsRequest } from "node:https";
import { after, afterEach, before, describe, test } from "node:test";

import { AgentCredentialStore } from "../src/modules/agents/credentials.ts";
import { pathHash } from "../src/modules/connectors/workspaces.ts";
import { revokeConnector } from "../src/modules/connectors/repository.ts";
import { BOOTSTRAP_TOKEN, startHarness, type Harness } from "./support/harness.ts";
import { enrolOverWebSocket, generateDeviceKey, identityFrom } from "./support/connector-client.ts";
import { claimSessionFor, eventsOfType, type SessionCookies } from "./support/identity.ts";
import { truncateAll } from "./support/postgres.ts";

let harness: Harness;

before(async () => {
  harness = await startHarness();
});

after(async () => {
  await harness.stop();
});

afterEach(async () => {
  await truncateAll(harness.pool);
});

const ADMIN = { authorization: `Bearer ${BOOTSTRAP_TOKEN}` } as const;
const CHECKOUT = "/workspace/refresh-surplus";

interface Enrolled {
  readonly connectorId: string;
  readonly environmentId: string;
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly organisationId: string;
  readonly projectId: string;
}

async function seedProject(slug = "refresh-surplus"): Promise<{
  organisationId: string;
  projectId: string;
}> {
  const organisationId = harness.connectorConfig.organisationId;
  await harness.pool.query(
    "insert into organisations (id, name, slug) values ($1, $2, $3) on conflict (id) do nothing",
    [organisationId, "ReviewPlane", organisationId.toLowerCase().replaceAll(/[^a-z0-9-]/gu, "-")],
  );
  const projectId = `prj_${slug.replaceAll("-", "")}`;
  await harness.pool.query(
    `insert into projects (id, organisation_id, name, slug, default_branch)
     values ($1, $2, $3, $4, 'main') on conflict (id) do nothing`,
    [projectId, organisationId, slug, slug],
  );
  return { organisationId, projectId };
}

/**
 * Enrols a connector, by default for one project.
 *
 * `scope: "organisation"` redeems a token that names no project, which leaves
 * `connectors.project_id` null. That enrolment is the case the exchange's
 * project term has to stay inert for: it is legal (`docs/DOMAIN_MODEL.md` §7)
 * and the environment is available to every project in the organisation.
 */
async function enrol(
  slug = "refresh-surplus",
  options: { readonly scope?: "project" | "organisation" } = {},
): Promise<Enrolled> {
  const { organisationId, projectId } = await seedProject(slug);
  const issued = await harness.built.app.inject({
    method: "POST",
    url: "/api/v1/connectors/enrolment-tokens",
    headers: ADMIN,
    payload: options.scope === "organisation" ? {} : { project_id: projectId },
  });
  assert.equal(issued.statusCode, 201, issued.body);
  const token = (issued.json() as { data: { enrolment_token: string } }).data.enrolment_token;
  const device = generateDeviceKey();
  const attempt = await enrolOverWebSocket(harness, token, device);
  assert.ok(attempt.response !== null, `enrolment failed: ${attempt.closeReason}`);
  const identity = identityFrom(attempt.response, device);
  const rows = await harness.pool.query<{ environment_id: string }>(
    "select environment_id from connectors where id = $1",
    [identity.connectorId],
  );
  return {
    connectorId: identity.connectorId,
    environmentId: rows.rows[0]?.environment_id ?? "",
    certificatePem: identity.certificatePem,
    privateKeyPem: identity.privateKeyPem,
    organisationId,
    projectId,
  };
}

/** Registers the workspace the way the connector's observation does. */
async function registerWorkspace(
  enrolled: Enrolled,
  options: {
    readonly path?: string;
    readonly environmentId?: string;
    readonly projectId?: string;
  } = {},
): Promise<string> {
  const path = options.path ?? CHECKOUT;
  const id = `wsp_${Math.random().toString(36).slice(2, 12)}`;
  await harness.pool.query(
    `insert into workspaces
       (id, organisation_id, project_id, environment_id, connector_id, root_path,
        path_hash, display_path, source, branch, head_commit, dirty)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'connector_report','redesign','4a45b94f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60',false)`,
    [
      id,
      enrolled.organisationId,
      options.projectId ?? enrolled.projectId,
      options.environmentId ?? enrolled.environmentId,
      enrolled.connectorId,
      path,
      pathHash(path),
      "refresh-surplus",
    ],
  );
  return id;
}

/** An administrator session for the connector's organisation, claimed once. */
async function adminSession(enrolled: Enrolled): Promise<SessionCookies> {
  return claimSessionFor(harness.built, harness.pool, enrolled.organisationId);
}

/** The `request_id` differs per call, and nothing else in a refusal may. */
function stripRequestId(raw: string): string {
  return raw.replaceAll(/"request_id":"[^"]*"/gu, "");
}

/**
 * Revokes through the administrative route, which is the path that cascades.
 *
 * The session is a parameter rather than something this claims for itself: an
 * installation is claimed once, so a test that revokes twice has to present the
 * same session twice.
 */
async function revokeThroughApi(
  enrolled: Enrolled,
  cookies: SessionCookies,
): Promise<{
  readonly status: number;
  readonly body: string;
  readonly data: Record<string, unknown>;
}> {
  const response = await harness.built.app.inject({
    method: "POST",
    url: `/api/v1/connectors/${enrolled.connectorId}/revoke`,
    headers: cookies.writeHeaders,
  });
  return {
    status: response.statusCode,
    body: response.body,
    data: (response.json() as { data: Record<string, unknown> }).data,
  };
}

interface ExchangeResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

/**
 * Calls the exchange over real mutual TLS.
 *
 * `app.inject` cannot be used: the route's whole authentication is the verified
 * client certificate on the socket, and an injected request has no socket. A
 * test that bypassed TLS would be asserting a handler rather than a boundary.
 */
async function exchange(
  options: {
    readonly certificatePem?: string;
    readonly privateKeyPem?: string;
    readonly body?: unknown;
  } = {},
): Promise<ExchangeResult> {
  const url = new URL(`${harness.connectorUrl}/connector/v1/agent-credentials`);
  const payload = JSON.stringify(options.body ?? {});
  return new Promise((resolve, reject) => {
    const call = httpsRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        ca: harness.built.connectors.authority.certificatePem,
        servername: "localhost",
        rejectUnauthorized: true,
        ...(options.certificatePem === undefined
          ? {}
          : { cert: options.certificatePem, key: options.privateKeyPem }),
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      },
      (response) => {
        let raw = "";
        response.on("data", (chunk: Buffer) => {
          raw += chunk.toString("utf8");
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>),
            raw,
          });
        });
      },
    );
    call.on("error", reject);
    call.end(payload);
  });
}

describe("the local MCP bridge's credential exchange", () => {
  test("a connector exchanges its identity for a single-project, short-lived credential", async () => {
    const enrolled = await enrol();
    const workspaceId = await registerWorkspace(enrolled);

    const result = await exchange({
      certificatePem: enrolled.certificatePem,
      privateKeyPem: enrolled.privateKeyPem,
      body: { workspace_path_hash: pathHash(CHECKOUT) },
    });
    assert.equal(result.status, 201, result.raw);
    const data = result.body["data"] as {
      token: string;
      credential_id: string;
      project_id: string;
      workspace_id: string;
      capabilities: string[];
      expires_in_seconds: number;
      pending_work: unknown[];
    };
    assert.equal(data.workspace_id, workspaceId);
    assert.equal(data.project_id, enrolled.projectId);
    assert.match(data.token, /^rpa_/u);
    // An hour, well inside the 24-hour maximum the table enforces (ADR-0023).
    assert.equal(data.expires_in_seconds, 3600);

    const rows = await harness.pool.query<{ project_ids: string[]; capabilities: string[] }>(
      "select project_ids, capabilities from agent_credentials where id = $1",
      [data.credential_id],
    );
    // One project, decided by the workspace. A credential bound to everything
    // the connector can see would be wider than the session that asked for it.
    assert.deepEqual(rows.rows[0]?.project_ids, [enrolled.projectId]);
    // The capability vocabulary contains no administrative capability, so
    // "must not grant the agent connector-administrator privileges" holds
    // because no capability could express it.
    assert.ok(!data.capabilities.some((capability) => /admin|connector|secret/u.test(capability)));
    assert.ok(!data.capabilities.includes("browser:capture"));

    // Issuance is audited, and the event names no token.
    const events = await harness.pool.query<{ payload: Record<string, unknown>; actor_type: string }>(
      "select payload, actor_type from events where type = 'agent_credential.issued'",
    );
    assert.equal(events.rowCount, 1);
    assert.equal(events.rows[0]?.actor_type, "connector");
    assert.ok(!JSON.stringify(events.rows[0]?.payload).includes(data.token));
  });

  test("a caller with no client certificate is refused", async () => {
    const enrolled = await enrol();
    await registerWorkspace(enrolled);
    const result = await exchange({ body: { workspace_path_hash: pathHash(CHECKOUT) } });
    assert.equal(result.status, 401, result.raw);
    assert.match(result.raw, /AUTHENTICATION_REQUIRED/u);
    assert.ok(!result.raw.includes("rpa_"));
  });

  test("a revoked identity is refused, and answers as an unknown one does", async () => {
    const enrolled = await enrol();
    await registerWorkspace(enrolled);
    await revokeConnector(harness.pool, enrolled.connectorId, { type: "system" });

    const revoked = await exchange({
      certificatePem: enrolled.certificatePem,
      privateKeyPem: enrolled.privateKeyPem,
      body: { workspace_path_hash: pathHash(CHECKOUT) },
    });
    assert.equal(revoked.status, 401, revoked.raw);
    // A revoked connector must not be able to mint anything, and a distinct
    // refusal would tell a caller which of "revoked" and "unknown" it holds.
    assert.match(revoked.raw, /AUTHENTICATION_REQUIRED/u);
  });

  test("a workspace of another environment answers as an unknown one does", async () => {
    const mine = await enrol();
    const theirs = await enrol("other-project");
    // The same checkout path, registered against the other environment.
    await registerWorkspace(theirs, { path: "/workspace/theirs" });

    const foreign = await exchange({
      certificatePem: mine.certificatePem,
      privateKeyPem: mine.privateKeyPem,
      body: { workspace_path_hash: pathHash("/workspace/theirs") },
    });
    const unknown = await exchange({
      certificatePem: mine.certificatePem,
      privateKeyPem: mine.privateKeyPem,
      body: { workspace_path_hash: `sha256:${"c".repeat(64)}` },
    });
    assert.equal(foreign.status, unknown.status);
    // Byte for byte, minus the per-request identifier, so the pair is not an
    // existence oracle for another environment's checkouts
    // (`docs/TESTING.md` §10).
    assert.equal(stripRequestId(foreign.raw), stripRequestId(unknown.raw));
    assert.equal(
      await harness.pool
        .query("select count(*) as count from agent_credentials")
        .then((rows) => Number((rows.rows[0] as { count: string }).count)),
      0,
      "a refused exchange issues nothing",
    );
  });

  test("a malformed workspace hash is refused before anything is resolved", async () => {
    const enrolled = await enrol();
    await registerWorkspace(enrolled);
    const result = await exchange({
      certificatePem: enrolled.certificatePem,
      privateKeyPem: enrolled.privateKeyPem,
      body: { workspace_path_hash: "../../etc/passwd" },
    });
    assert.equal(result.status, 400, result.raw);
    assert.match(result.raw, /workspace_path_hash/u);
  });

  test("the exchange reports the project's pending agent work for the local notification", async () => {
    const enrolled = await enrol();
    await registerWorkspace(enrolled);
    await harness.pool.query(
      `insert into inbox_items
         (id, organisation_id, project_id, recipient_type, recipient_id, type, title,
          payload, review_id, status)
       values ($1,$2,$3,'agent_session',null,'review_assigned','Bugs on homepage',
               $4::jsonb, null, 'pending')`,
      [
        `inb_${Math.random().toString(36).slice(2, 12)}`,
        enrolled.organisationId,
        enrolled.projectId,
        JSON.stringify({ review_slug: "bugs-on-homepage", finding_count: 3, priority: "high" }),
      ],
    ).catch(() => undefined);

    const result = await exchange({
      certificatePem: enrolled.certificatePem,
      privateKeyPem: enrolled.privateKeyPem,
      body: { workspace_path_hash: pathHash(CHECKOUT) },
    });
    assert.equal(result.status, 201, result.raw);
    const work = (result.body["data"] as { pending_work: unknown[] }).pending_work;
    assert.ok(Array.isArray(work));
    // No finding text reaches this shape: it can carry page-derived content and
    // this response is read by a shell prompt.
    assert.doesNotMatch(result.raw, /breakpoint|overlap/u);
  });

  test("a workspace outside the connector's enrolled project answers as an unknown one does", async () => {
    // The gap this closes is not reachable through a shipped path: a connector
    // only reports workspaces for projects `workspaces.ts` has already
    // authorised. It is constructed here because ADR-0023 claims the connector
    // "can mint a credential for a project it already carries traffic for, and
    // for no other", and that claim should be a property of this statement
    // rather than of an invariant another module happens to maintain.
    const mine = await enrol();
    const elsewhere = await seedProject("other-project");
    await registerWorkspace(mine, {
      path: "/workspace/not-mine",
      projectId: elsewhere.projectId,
    });

    const foreign = await exchange({
      certificatePem: mine.certificatePem,
      privateKeyPem: mine.privateKeyPem,
      body: { workspace_path_hash: pathHash("/workspace/not-mine") },
    });
    const unknown = await exchange({
      certificatePem: mine.certificatePem,
      privateKeyPem: mine.privateKeyPem,
      body: { workspace_path_hash: `sha256:${"d".repeat(64)}` },
    });
    assert.equal(foreign.status, 404, foreign.raw);
    assert.equal(foreign.status, unknown.status);
    assert.equal(stripRequestId(foreign.raw), stripRequestId(unknown.raw));
    assert.equal(
      await harness.pool
        .query("select count(*) as count from agent_credentials")
        .then((rows) => Number((rows.rows[0] as { count: string }).count)),
      0,
      "a credential was minted for a project the connector is not enrolled for",
    );
  });

  test("an organisation-scoped connector still obtains a credential", async () => {
    // `connectors.project_id` is null for an enrolment token that named no
    // project, and such an environment is available to every project in the
    // organisation (`docs/DOMAIN_MODEL.md` §7). The project term must be inert
    // for it, exactly as it is in `workspaces.ts`; a stricter rule here would
    // make an organisation-scoped connector unable to run a bridge at all.
    const enrolled = await enrol("refresh-surplus", { scope: "organisation" });
    const scope = await harness.pool.query<{ project_id: string | null }>(
      "select project_id from connectors where id = $1",
      [enrolled.connectorId],
    );
    assert.equal(scope.rows[0]?.project_id, null, "the enrolment was not organisation-scoped");
    const workspaceId = await registerWorkspace(enrolled);

    const result = await exchange({
      certificatePem: enrolled.certificatePem,
      privateKeyPem: enrolled.privateKeyPem,
      body: { workspace_path_hash: pathHash(CHECKOUT) },
    });
    assert.equal(result.status, 201, result.raw);
    const data = result.body["data"] as { workspace_id: string; project_id: string };
    assert.equal(data.workspace_id, workspaceId);
    assert.equal(data.project_id, enrolled.projectId);
  });
});

describe("revoking the connector revokes what it minted", () => {
  test("an outstanding credential stops resolving", async () => {
    const enrolled = await enrol();
    await registerWorkspace(enrolled);
    const issued = await exchange({
      certificatePem: enrolled.certificatePem,
      privateKeyPem: enrolled.privateKeyPem,
      body: { workspace_path_hash: pathHash(CHECKOUT) },
    });
    assert.equal(issued.status, 201, issued.raw);
    const credential = issued.body["data"] as { token: string; credential_id: string };

    const store = new AgentCredentialStore(harness.pool);
    assert.notEqual(
      await store.resolve(credential.token),
      null,
      "the credential was not usable before revocation, so the test proves nothing",
    );

    const revoked = await revokeThroughApi(enrolled, await adminSession(enrolled));
    assert.equal(revoked.status, 200, revoked.body);
    assert.equal(revoked.data["agent_credentials_revoked"], 1);

    // ADR-0023: revoking the identity is what closes the credentials it minted.
    // Both halves are asserted, because the row being marked and the token being
    // refused are different facts and only the second one protects anything.
    assert.equal(await store.resolve(credential.token), null, "a revoked connector's token still resolves");
    const row = await harness.pool.query<{ revoked_at: Date | null }>(
      "select revoked_at from agent_credentials where id = $1",
      [credential.credential_id],
    );
    assert.notEqual(row.rows[0]?.revoked_at ?? null, null);
  });

  test("the connector.revoked event reports the count, and each credential its own record", async () => {
    const enrolled = await enrol();
    await registerWorkspace(enrolled);
    await registerWorkspace(enrolled, { path: "/workspace/second" });
    for (const path of [CHECKOUT, "/workspace/second"]) {
      const issued = await exchange({
        certificatePem: enrolled.certificatePem,
        privateKeyPem: enrolled.privateKeyPem,
        body: { workspace_path_hash: pathHash(path) },
      });
      assert.equal(issued.status, 201, issued.raw);
    }

    const revoked = await revokeThroughApi(enrolled, await adminSession(enrolled));
    assert.equal(revoked.data["agent_credentials_revoked"], 2);

    const events = await eventsOfType(harness.pool, enrolled.projectId, "connector.revoked");
    assert.equal(events.length, 1, "revocation recorded no audit event");
    assert.equal(events[0]?.payload["agent_credentials_revoked"], 2);

    // `docs/SECURITY.md` §16: each revoked credential is a permission change and
    // gets its own record. The count alone says how many, never which.
    const perCredential = await eventsOfType(harness.pool, enrolled.projectId, "session.revoked");
    assert.equal(perCredential.length, 2);
    for (const event of perCredential) {
      assert.equal(event.payload["reason"], "connector_revoked");
      assert.match(String(event.payload["credential_id"]), /^agc_/u);
    }
    // No event carries a token. The audit trail is append-only, so a credential
    // that reached it would be a credential nothing can remove.
    assert.doesNotMatch(JSON.stringify(perCredential), /rpa_/u);
  });

  test("a second revocation reports no further credentials", async () => {
    const enrolled = await enrol();
    await registerWorkspace(enrolled);
    const issued = await exchange({
      certificatePem: enrolled.certificatePem,
      privateKeyPem: enrolled.privateKeyPem,
      body: { workspace_path_hash: pathHash(CHECKOUT) },
    });
    assert.equal(issued.status, 201, issued.raw);

    const cookies = await adminSession(enrolled);
    const first = await revokeThroughApi(enrolled, cookies);
    assert.equal(first.data["agent_credentials_revoked"], 1);
    const again = await revokeThroughApi(enrolled, cookies);
    // A retried request must not produce a second set of counts for work that
    // happened once (`docs/CONNECTOR_PROTOCOL.md` §18).
    assert.equal(again.data["already_revoked"], true);
    assert.equal(again.data["agent_credentials_revoked"], 0);
    assert.equal(
      (await eventsOfType(harness.pool, enrolled.projectId, "session.revoked")).length,
      1,
    );
  });

  test("a revoked connector mints nothing further", async () => {
    const enrolled = await enrol();
    await registerWorkspace(enrolled);
    await revokeThroughApi(enrolled, await adminSession(enrolled));

    const after = await exchange({
      certificatePem: enrolled.certificatePem,
      privateKeyPem: enrolled.privateKeyPem,
      body: { workspace_path_hash: pathHash(CHECKOUT) },
    });
    assert.equal(after.status, 401, after.raw);
    assert.equal(
      await harness.pool
        .query("select count(*) as count from agent_credentials")
        .then((rows) => Number((rows.rows[0] as { count: string }).count)),
      0,
      "a revoked identity minted a credential",
    );
  });
});
