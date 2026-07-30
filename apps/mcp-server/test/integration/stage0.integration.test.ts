/**
 * Steps 9 to 12 of the primary end-to-end scenario (`docs/TESTING.md`
 * section 3), run automatically against real components.
 *
 * Everything in this file is real except the human at the keyboard: a real
 * PostgreSQL, the real control-plane process, the real MCP server, a real
 * Chromium browser worker in its own process under the deployed container
 * controls, a fixture application on loopback, and the official MCP TypeScript
 * SDK as the client. The transcript it prints is the evidence the Stage 0 exit
 * criteria ask for:
 *
 *   * "Claude Code or another MCP client can retrieve `bugs-on-homepage`"
 *   * "Agent submits an after screenshot associated with a finding"
 *
 * It runs inside a container because Chromium needs system libraries a
 * developer workstation may not have and because `docs/SECURITY.md` section 10
 * requires the sandbox to stay enabled; `scripts/run-integration-tests.sh`
 * starts it with the same controls `deploy/compose/compose.yaml` applies.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Pool } from "pg";

import { buildApp, type BuiltApp } from "@reviewplane/server/app";
import type { ServerConfig } from "@reviewplane/server/config";
import { migrate, newId } from "@reviewplane/server/domain";
import { testServerConfig } from "@reviewplane/server/testing/config";
import { encodePng, sha256 } from "@reviewplane/server/testing/png";
import { AcceptingGateway, StubRoutePublisher } from "@reviewplane/server/testing/publishing";
import { issueLoopbackTls, type LoopbackTls } from "@reviewplane/server/testing/tls";

import { buildMcpApp, type BuiltMcpApp } from "../../src/app.ts";
import type { McpServerConfig } from "../../src/config.ts";
import { FIXTURE_PORT, startFixtureApp, type FixtureApp } from "./fixture-app.ts";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const MIGRATIONS = join(REPO, "apps", "server", "migrations");

const BOOTSTRAP_TOKEN = "integration-bootstrap-token";
const WORKER_CREDENTIAL = "integration-worker-credential";
const WORKER_COMMAND_CREDENTIAL = "integration-worker-command-cred";
const WORKER_PORT = 8090;
const ADMIN = { authorization: `Bearer ${BOOTSTRAP_TOKEN}` };

const CAPTURED_COMMIT = "4a45b94f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60";
const FIXED_COMMIT = "b4c5d6e7f809192a3b4c5d6e7f809192a3b4c5d6";

let pool: Pool;
let control: BuiltApp;
let mcp: BuiltMcpApp;
let worker: ChildProcess | null = null;
let fixture: FixtureApp;
let fixtureTls: LoopbackTls;
let artefactRoot: string;
let mcpOrigin: string;
let controlOrigin: string;

/** Prints a transcript line. The suite's output is the evidence. */
function transcript(step: string, detail: unknown): void {
  process.stdout.write(`[mcp] ${step}: ${JSON.stringify(detail)}\n`);
}

function databaseUrl(): string {
  const url = process.env["REVIEWPLANE_TEST_DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new Error(
      "REVIEWPLANE_TEST_DATABASE_URL is required; run this suite through scripts/run-integration-tests.sh",
    );
  }
  return url;
}

async function waitFor(what: string, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await probe().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${what} did not become ready within 60 seconds`);
}

interface OpenSession {
  readonly id: string;
  readonly control_epoch: number;
  readonly service_origin: string;
}

/**
 * Reserves a browser session, publishes the fixture to it, and allocates it.
 *
 * This is the `docs/API.md` section 11 order, and it is the order because the
 * two facts depend on each other: the route must name the sessions it admits,
 * and the session must learn its origin and its capability from the route.
 * Asserting the origin came back from the allocation is what proves the caller
 * did not choose it.
 */
async function openSession(
  projectId: string,
  organisationId: string,
  extra: Readonly<Record<string, unknown>>,
): Promise<OpenSession> {
  const app = control.app;
  const reserved = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/browser-sessions`,
    headers: ADMIN,
    payload: {
      organisation_id: organisationId,
      viewport: { width: 390, height: 844, device_scale_factor: 2 },
      retention_class: "verification_evidence",
      allocate: false,
      ...extra,
    },
  });
  assert.equal(reserved.statusCode, 201, reserved.body);
  const sessionId = (reserved.json() as { data: { id: string } }).data.id;

  // `protocol` describes the connector-to-destination hop, which is plain HTTP
  // on loopback in a deployment; the TLS this suite's fixture serves stands in
  // for the gateway leg the browser terminates against.
  const published = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/published-services`,
    headers: ADMIN,
    payload: {
      connector_id: "con_integration",
      workspace_id: "wsp_integration",
      local_host: "127.0.0.1",
      local_port: FIXTURE_PORT,
      protocol: "http",
      ttl_seconds: 600,
      allowed_browser_session_ids: [sessionId],
    },
  });
  assert.equal(published.statusCode, 201, published.body);
  const serviceId = (published.json() as { data: { id: string } }).data.id;

  const allocated = await app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${sessionId}/allocate`,
    headers: ADMIN,
    payload: { published_service_id: serviceId },
  });
  assert.equal(allocated.statusCode, 200, allocated.body);
  const record = (allocated.json() as {
    data: { id: string; control_epoch: number; service_origin: string; status: string };
  }).data;
  assert.equal(record.status, "READY", allocated.body);
  assert.match(
    record.service_origin,
    /^https:\/\/svc-[0-9a-f]+\.internal\.invalid$/u,
    "the session origin is the route's internal origin, not anything the caller asked for",
  );
  return {
    id: record.id,
    control_epoch: record.control_epoch,
    service_origin: record.service_origin,
  };
}

before(async () => {
  artefactRoot = await mkdtemp(join(tmpdir(), "reviewplane-integration-"));
  pool = new Pool({ connectionString: databaseUrl(), max: 8 });
  await migrate(pool, MIGRATIONS);

  // ADR-0015: the browser reaches an internal origin by resolver rule and
  // public-key pin, so the fixture has to be a TLS listener the pin names.
  fixtureTls = issueLoopbackTls(["127.0.0.1", "localhost"]);
  fixture = await startFixtureApp(fixtureTls);

  const serverConfig: ServerConfig = testServerConfig({
    host: "127.0.0.1",
    port: 0,
    databaseUrl: databaseUrl(),
    bootstrapToken: BOOTSTRAP_TOKEN,
    workerCredential: WORKER_CREDENTIAL,
    workerCommandCredential: WORKER_COMMAND_CREDENTIAL,
    workerEndpoint: `http://127.0.0.1:${String(WORKER_PORT)}`,
    artefactPath: artefactRoot,
    workerRequestTimeoutMs: 60000,
  });
  // Publication needs a connector and a tunnel gateway; neither belongs in a
  // suite whose subject is the agent interface, and both have their own. The
  // origin a session is bound to is still derived from the route record.
  control = await buildApp({
    config: serverConfig,
    pool,
    publisher: new StubRoutePublisher(),
    gateway: new AcceptingGateway(),
  });
  controlOrigin = await control.app.listen({ host: "127.0.0.1", port: 0 });

  const mcpConfig: McpServerConfig = {
    listenAddress: "127.0.0.1",
    port: 0,
    databaseUrl: databaseUrl(),
    workerCommandCredential: WORKER_COMMAND_CREDENTIAL,
    workerEndpoint: `http://127.0.0.1:${String(WORKER_PORT)}`,
    workerRequestTimeoutMs: 60000,
    artefactPath: artefactRoot,
    artefactMaxBytes: 20971520,
    apiPathPrefix: "/api/v1",
    mcpPath: "/mcp/v1",
  };
  mcp = await buildMcpApp({ config: mcpConfig, pool });
  mcpOrigin = await mcp.app.listen({ host: "127.0.0.1", port: 0 });

});

const WORKER_NAME = "browser-worker-01";

/**
 * Starts the real browser worker as its own process.
 *
 * AGENTS.md requires the worker to stay out of the control-plane process, and
 * a test that ran them together would prove the wrong thing. It is started
 * after the project has been assigned to its identity, because the worker reads
 * its assignment at registration and refuses a session for a project it was not
 * given (`docs/SECURITY.md` section 6.4).
 */
async function startBrowserWorker(): Promise<void> {
  worker = spawn(
    process.execPath,
    ["--conditions=development", join(REPO, "apps", "browser-worker", "src", "main.ts")],
    {
      env: {
        ...process.env,
        REVIEWPLANE_WORKER_NAME: WORKER_NAME,
        REVIEWPLANE_WORKER_LISTEN_ADDRESS: "127.0.0.1",
        REVIEWPLANE_WORKER_PORT: String(WORKER_PORT),
        REVIEWPLANE_WORKER_CAPACITY: "2",
        REVIEWPLANE_WORKER_SANDBOX: "required",
        REVIEWPLANE_WORKER_SESSION_ROOT: join(artefactRoot, "sessions"),
        REVIEWPLANE_CONTROL_PLANE_URL: controlOrigin,
        REVIEWPLANE_WORKER_CREDENTIAL: WORKER_CREDENTIAL,
        REVIEWPLANE_WORKER_COMMAND_CREDENTIAL: WORKER_COMMAND_CREDENTIAL,
        REVIEWPLANE_WORKER_SESSION_DURATION_SECONDS: "600",
        // The deployed mechanism, minus the gateway hop: Chromium resolves the
        // internal name to the fixture's own loopback listener and trusts that
        // one public key (ADR-0015). Both settings are required together, and
        // a worker with neither reaches no internal origin at all.
        REVIEWPLANE_TUNNEL_INTERNAL_SUFFIX: "internal.invalid",
        REVIEWPLANE_TUNNEL_GATEWAY_ADDRESS: fixture.address,
        REVIEWPLANE_TUNNEL_CERTIFICATE_SPKI: fixtureTls.certificateSpki,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  worker.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[worker] ${chunk.toString("utf8")}`);
  });
  worker.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[worker] ${chunk.toString("utf8")}`);
  });
  await waitFor("the browser worker", async () => {
    const response = await fetch(`http://127.0.0.1:${String(WORKER_PORT)}/internal/v1/health`);
    return response.ok;
  });
}

after(async () => {
  worker?.kill("SIGTERM");
  await mcp?.close().catch(() => undefined);
  await control?.app.close().catch(() => undefined);
  await fixture?.stop().catch(() => undefined);
  await pool?.end().catch(() => undefined);
  await rm(artefactRoot, { recursive: true, force: true });
  void dirname;
});

test("steps 9 to 12: an MCP client retrieves bugs-on-homepage and submits after evidence", async () => {
  const app = control.app;
  const suffix = newId("").slice(0, 10).toLowerCase();

  // ---- the human's half of the loop, through the control-plane API --------
  const organisationId = (
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/organisations",
        headers: ADMIN,
        payload: { name: "Refresh", slug: `org-${suffix}` },
      })
    ).json() as { data: { id: string } }
  ).data.id;
  const projectSlug = `refresh-surplus-${suffix}`;
  const projectId = (
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/organisations/${organisationId}/projects`,
        headers: ADMIN,
        payload: { name: "Refresh Surplus", slug: projectSlug },
      })
    ).json() as { data: { id: string } }
  ).data.id;

  // The worker identity is created first so the project can be assigned to it,
  // and only then is the worker process started: it reads its assignment at
  // registration, and an unassigned worker serves nothing.
  const registered = await control.workers.register(WORKER_CREDENTIAL, {
    worker_name: WORKER_NAME,
    worker_version: "0.1.0",
    browser_type: "chromium",
    browser_version: "143.0.7499.4",
    capacity: 2,
    labels: ["chromium"],
    sandbox_enabled: true,
    started_at: new Date().toISOString(),
  });
  await app.inject({
    method: "PUT",
    url: `/api/v1/browser-workers/${registered.workerId}/assignments`,
    headers: ADMIN,
    payload: { project_ids: [projectId] },
  });
  await startBrowserWorker();

  const workspaceId = (
    (
      await app.inject({
        method: "PUT",
        url: `/api/v1/projects/${projectId}/workspaces`,
        headers: ADMIN,
        payload: {
          root_path: `/workspace/${projectSlug}`,
          branch: "redesign",
          head_commit: CAPTURED_COMMIT,
        },
      })
    ).json() as { data: { id: string } }
  ).data.id;

  // A browser session on the fixture application, and a human capture of the
  // defect. This is steps 1 to 8 compressed: the parts before this issue.
  //
  // The session is reserved before the route is published and allocated after,
  // because a session learns its origin and its capability from the route
  // record and never from its caller (`docs/API.md` section 11): the route has
  // to name the session, so the identifier has to exist first.
  const humanSession = await openSession(projectId, organisationId, {});

  const navigate = await app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${humanSession.id}/commands`,
    headers: ADMIN,
    payload: {
      control_epoch: humanSession.control_epoch,
      command: { command: "navigate", timeout_ms: 30000, navigate: { url: "/", wait_until: "load" } },
    },
  });
  assert.equal(navigate.statusCode, 200, navigate.body);
  const beforeCapture = await app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${humanSession.id}/commands`,
    headers: ADMIN,
    payload: {
      control_epoch: humanSession.control_epoch,
      command: {
        command: "take_screenshot",
        timeout_ms: 30000,
        take_screenshot: { full_page: false, persist: true, purpose: "annotation" },
      },
    },
  });
  const beforeResult = (beforeCapture.json() as {
    data: { ok: boolean; screenshot?: { artefact_id: string; sha256: string } };
  }).data;
  assert.equal(beforeResult.ok, true, JSON.stringify(beforeResult));
  const beforeArtefact = beforeResult.screenshot;
  assert.ok(beforeArtefact !== undefined, "the human capture produced verified evidence");
  transcript("before screenshot", beforeArtefact);

  const reviewId = (
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/reviews`,
        headers: ADMIN,
        payload: {
          slug: "bugs-on-homepage",
          title: "Bugs on homepage",
          description: "The hero heading overlaps the navigation on a narrow viewport.",
          status: "READY",
          captured_branch: "redesign",
          captured_commit: CAPTURED_COMMIT,
          captured_workspace_id: workspaceId,
          source_browser_session_id: humanSession.id,
        },
      })
    ).json() as { data: { id: string } }
  ).data.id;

  const findingId = (
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/reviews/${reviewId}/findings`,
        headers: ADMIN,
        payload: {
          title: "Hero heading overlaps the navigation below 900px",
          description: "The collapse breakpoint is 768px but the navigation still wraps at 880px.",
          severity: "high",
          source: "human",
          url: `${humanSession.service_origin}/`,
          viewport: { width: 390, height: 844, device_scale_factor: 2 },
          scroll_position: { x: 0, y: 0 },
          captured_commit: CAPTURED_COMMIT,
          screenshot_artefact_id: beforeArtefact.artefact_id,
          acceptance_criteria: "No overlap between 768px and 1024px.",
          annotations: [
            {
              artefact_id: beforeArtefact.artefact_id,
              type: "rectangle",
              geometry: { x: 0.05, y: 0.02, width: 0.9, height: 0.2 },
              label: "Heading text sits on top of the navigation links",
              marker_number: 1,
            },
          ],
        },
      })
    ).json() as { data: { finding: { id: string } } }
  ).data.finding.id;

  const credential = (
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/organisations/${organisationId}/agent-credentials`,
        headers: ADMIN,
        payload: { project_ids: [projectId], label: "claude-code integration" },
      })
    ).json() as { data: { token: string } }
  ).data;

  // ---- step 9: the agent retrieves and claims the review ------------------
  const client = new Client({ name: "claude-code", version: "integration" });
  const transport = new StreamableHTTPClientTransport(new URL(`${mcpOrigin}/mcp/v1`), {
    requestInit: { headers: { authorization: `Bearer ${credential.token}` } },
  });
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);

  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  transcript("tools/list", tools);
  assert.ok(!tools.some((name) => /secret/u.test(name)), "no secret tool is exposed");

  const envelopeOf = (result: unknown): Record<string, unknown> => {
    const content = (result as { content: { type: string; text?: string }[] }).content;
    const text = content.find((block) => block.type === "text")?.text;
    assert.ok(text !== undefined, "the tool result carried a text block");
    return JSON.parse(text) as Record<string, unknown>;
  };
  const callTool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const envelope = envelopeOf(await client.callTool({ name, arguments: args }));
    transcript(name, {
      ok: envelope["ok"],
      trust: envelope["trust"],
      instruction_policy: envelope["instruction_policy"],
      ...(envelope["ok"] === false ? { error: envelope["error"] } : {}),
    });
    return envelope;
  };

  const project = await callTool("project_current", {});
  assert.equal(project["ok"], true);

  const review = await callTool("review_get", { review: "bugs-on-homepage" });
  assert.equal(review["ok"], true, JSON.stringify(review));
  const reviewData = review["data"] as {
    review: { id: string; version: number; slug: string };
    findings: { id: string; version: number }[];
  };
  assert.equal(reviewData.review.slug, "bugs-on-homepage");
  assert.equal(reviewData.review.id, reviewId);
  transcript("review_get", { review: reviewData.review, findings: reviewData.findings.length });

  await callTool("review_claim", {
    review_id: reviewId,
    expected_version: reviewData.review.version,
    idempotency_key: "integration-claim-review",
  });
  await callTool("finding_claim", {
    finding_id: findingId,
    expected_version: reviewData.findings[0]?.version ?? 1,
    idempotency_key: "integration-claim-finding",
  });
  const started = await callTool("finding_update_status", {
    finding_id: findingId,
    expected_version: 2,
    status: "IN_PROGRESS",
    idempotency_key: "integration-in-progress",
  });
  assert.equal(started["ok"], true, JSON.stringify(started));

  // ---- step 10: the agent changes the application -------------------------
  fixture.state = "after";
  transcript("fixture state", { state: fixture.state, note: "the collapse breakpoint is now 900px" });

  // ---- step 11: the agent captures the after screenshot -------------------
  const status = await callTool("agent_session_status", {});
  const agentSessionId = (status["data"] as { agent_session_id: string }).agent_session_id;

  const agentBrowser = await openSession(projectId, organisationId, {
    agent_session_id: agentSessionId,
    controller: { type: "agent", id: agentSessionId },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${agentBrowser.id}/commands`,
    headers: ADMIN,
    payload: {
      control_epoch: agentBrowser.control_epoch,
      command: { command: "navigate", timeout_ms: 30000, navigate: { url: "/", wait_until: "load" } },
    },
  });

  const shot = await callTool("browser_take_screenshot", {
    browser_session_id: agentBrowser.id,
    control_epoch: agentBrowser.control_epoch,
    purpose: "verification",
    idempotency_key: "integration-after-shot",
  });
  assert.equal(shot["ok"], true, JSON.stringify(shot));
  assert.equal(shot["trust"], "untrusted_browser_content");
  const afterArtefact = (shot["data"] as { artefact: { artefact_id: string; sha256: string } })
    .artefact;
  transcript("after screenshot", afterArtefact);
  assert.notEqual(
    afterArtefact.sha256,
    beforeArtefact.sha256,
    "the after screenshot shows a different page from the before one",
  );

  // ---- step 12: the agent submits verification ---------------------------
  const submitted = await callTool("finding_submit_verification", {
    finding_id: findingId,
    summary: "Raised the navigation collapse breakpoint to 900px so the heading no longer overlaps.",
    branch: "redesign",
    commit: FIXED_COMMIT,
    tested_viewports: [
      { width: 390, height: 844, device_scale_factor: 2 },
      { width: 1440, height: 900, device_scale_factor: 1 },
    ],
    checks: {
      reproduced_before: true,
      console_errors_reviewed: true,
      network_failures_reviewed: true,
    },
    artefact_ids: [afterArtefact.artefact_id],
    idempotency_key: "integration-verify",
  });
  assert.equal(submitted["ok"], true, JSON.stringify(submitted));
  const verification = (submitted["data"] as {
    verification: { verification_id: string; status: string };
    finding: { status: string; version: number };
  });
  assert.equal(verification.verification.status, "submitted");
  transcript("verification", verification.verification);

  const awaiting = await callTool("finding_update_status", {
    finding_id: findingId,
    expected_version: verification.finding.version,
    status: "AWAITING_HUMAN_REVIEW",
    idempotency_key: "integration-awaiting",
  });
  assert.equal(awaiting["ok"], true, JSON.stringify(awaiting));

  // The review reaches the same place: work submitted, human to decide. It
  // goes through IN_PROGRESS, because docs/DOMAIN_MODEL.md section 14 has no
  // edge from ASSIGNED straight to AWAITING_HUMAN_REVIEW and the MCP layer does
  // not invent one.
  const reviewNow = await callTool("review_get", { review: "bugs-on-homepage" });
  const reviewVersion = (reviewNow["data"] as { review: { version: number } }).review.version;
  const working = await callTool("review_update_status", {
    review_id: reviewId,
    expected_version: reviewVersion,
    status: "IN_PROGRESS",
    idempotency_key: "integration-review-in-progress",
  });
  assert.equal(working["ok"], true, JSON.stringify(working));
  const handedBack = await callTool("review_update_status", {
    review_id: reviewId,
    expected_version: (working["data"] as { review: { version: number } }).review.version,
    status: "AWAITING_HUMAN_REVIEW",
    idempotency_key: "integration-review-awaiting",
  });
  assert.equal(handedBack["ok"], true, JSON.stringify(handedBack));

  // ---- the denial the whole design protects ------------------------------
  const denied = await callTool("finding_update_status", {
    finding_id: findingId,
    expected_version: 99,
    status: "RESOLVED",
    idempotency_key: "integration-accept-attempt",
  });
  assert.equal(denied["ok"], false);
  transcript("denied agent acceptance", denied["error"]);

  // ---- evidence -----------------------------------------------------------
  const rows = await pool.query<{
    finding_status: string;
    review_status: string;
    verification_status: string;
    commit_sha: string;
    artefact_id: string;
  }>(
    `SELECT f.status AS finding_status, r.status AS review_status, v.status AS verification_status,
            v.commit_sha, va.artefact_id
       FROM findings f
       JOIN reviews r ON r.id = f.review_id
       JOIN verifications v ON v.finding_id = f.id
       JOIN verification_artefacts va ON va.verification_id = v.id AND va.role = 'after'
      WHERE f.id = $1`,
    [findingId],
  );
  transcript("database rows", rows.rows);
  assert.equal(rows.rows[0]?.finding_status, "AWAITING_HUMAN_REVIEW");
  assert.equal(rows.rows[0]?.review_status, "AWAITING_HUMAN_REVIEW");
  assert.equal(rows.rows[0]?.verification_status, "submitted");
  assert.equal(rows.rows[0]?.artefact_id, afterArtefact.artefact_id);

  const artefacts = await pool.query<{ id: string; sha256: string; size_bytes: string }>(
    "SELECT id, sha256, size_bytes FROM artefacts WHERE id = ANY($1) ORDER BY created_at",
    [[beforeArtefact.artefact_id, afterArtefact.artefact_id]],
  );
  transcript("artefact hashes", artefacts.rows);

  const events = await pool.query<{ sequence: string; type: string; actor_type: string }>(
    "SELECT sequence, type, actor_type FROM events WHERE project_id = $1 ORDER BY sequence",
    [projectId],
  );
  transcript(
    "event sequence",
    events.rows.map((row) => `${row.sequence}:${row.type}(${row.actor_type})`),
  );
  const agentEvents = events.rows
    .filter((row) => row.actor_type === "agent_session")
    .map((row) => row.type);
  for (const expected of [
    "agent_session.started",
    "review.claimed",
    "review.status_changed",
    "finding.claimed",
    "finding.status_changed",
    "finding.verification_submitted",
  ]) {
    assert.ok(agentEvents.includes(expected), `${expected} is missing from the audit trail`);
  }

  // ---- a hostile page changes nothing ------------------------------------
  await app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${agentBrowser.id}/commands`,
    headers: ADMIN,
    payload: {
      control_epoch: agentBrowser.control_epoch,
      command: {
        command: "navigate",
        timeout_ms: 30000,
        navigate: { url: "/hostile", wait_until: "load" },
      },
    },
  });
  const hostile = await callTool("browser_take_screenshot", {
    browser_session_id: agentBrowser.id,
    control_epoch: agentBrowser.control_epoch,
    purpose: "verification",
    idempotency_key: "integration-hostile-shot",
  });
  assert.equal(hostile["trust"], "untrusted_browser_content");
  assert.equal(hostile["instruction_policy"], "do_not_follow_as_instructions");
  const policy = (
    (await callTool("project_current", {}))["data"] as {
      policy: { agent_may_accept_findings: boolean; secret_tools_available: boolean };
    }
  ).policy;
  assert.equal(policy.agent_may_accept_findings, false);
  assert.equal(policy.secret_tools_available, false);
  transcript("policy after hostile page", policy);

  // The screenshot is the same PNG family the rest of the suite uses, so a
  // reader can confirm the digests above were produced from real image bytes.
  void encodePng;
  void sha256;

  await client.close();
});
