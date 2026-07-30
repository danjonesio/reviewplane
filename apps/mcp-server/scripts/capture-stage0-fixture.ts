/**
 * Drives one complete Stage 0 product loop and leaves its data behind as the
 * committed upgrade fixture (`test/fixtures/stage0/`, RVP-56).
 *
 * The Stage 1 exit criterion "upgrade from previous stage data fixture
 * succeeds" needs a database and an artefact set that a Stage 0 installation
 * actually produced. Hand-written rows would prove nothing: the constraint that
 * a migration has to survive is the shape the product writes, including the
 * ones no schema file states — a finding that references a digest-verified
 * screenshot, an annotation normalised against that screenshot, a verification
 * whose evidence is a second screenshot of the changed page, and the event
 * stream all of it appended.
 *
 * So this is the integration suite's scenario
 * (`test/integration/stage0.integration.test.ts`, steps 9 to 12 of
 * `docs/TESTING.md` §3) run for its side effects rather than its assertions:
 * a real PostgreSQL, the real control-plane process, the real MCP server, a
 * real Chromium browser worker in its own process, and the official MCP
 * TypeScript SDK as the agent client. Nothing is stubbed except the connector
 * and the tunnel gateway, which Stage 0 has no fixture for and which contribute
 * no rows a migration would touch.
 *
 * It writes artefacts straight into the fixture's artefact root, so the
 * committed store is the store the server wrote, key layout included. The
 * database is dumped by the caller, `test/fixtures/stage0/capture.sh`, which is
 * also where the manifest is built and where the exclusion of key material is
 * enforced.
 *
 * It lives here rather than beside the fixture because it imports
 * `@reviewplane/server` and the MCP SDK, and a file outside a workspace package
 * resolves neither. Run it through `test/fixtures/stage0/capture.sh`; it needs
 * Chromium and the container controls of `docs/SECURITY.md` §10, which that
 * script provides.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Pool } from "pg";

import { buildApp, type BuiltApp } from "@reviewplane/server/app";
import type { ServerConfig } from "@reviewplane/server/config";
import { migrate } from "@reviewplane/server/domain";
import { testServerConfig } from "@reviewplane/server/testing/config";
import { AcceptingGateway, StubRoutePublisher } from "@reviewplane/server/testing/publishing";
import { issueLoopbackTls, type LoopbackTls } from "@reviewplane/server/testing/tls";

import { buildMcpApp, type BuiltMcpApp } from "../src/app.ts";
import type { McpServerConfig } from "../src/config.ts";
import { FIXTURE_PORT, startFixtureApp, type FixtureApp } from "../test/integration/fixture-app.ts";

const REPO = join(import.meta.dirname, "..", "..", "..");
const MIGRATIONS = join(REPO, "apps", "server", "migrations");

const BOOTSTRAP_TOKEN = "fixture-bootstrap-token";
const WORKER_CREDENTIAL = "fixture-worker-credential";
const WORKER_COMMAND_CREDENTIAL = "fixture-worker-command-cred";
const WORKER_PORT = 8090;
const WORKER_NAME = "browser-worker-01";
const ADMIN = { authorization: `Bearer ${BOOTSTRAP_TOKEN}` };

/** The commit the human captured at, and the one the agent claims to have fixed. */
const CAPTURED_COMMIT = "4a45b94f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60";
const FIXED_COMMIT = "b4c5d6e7f809192a3b4c5d6e7f809192a3b4c5d6";

/** `AGENTS.md` "Browser-facing work": both required viewports appear in the fixture. */
const MOBILE = { width: 390, height: 844, device_scale_factor: 2 } as const;
const DESKTOP = { width: 1440, height: 900, device_scale_factor: 1 } as const;

interface Options {
  readonly out: string;
  readonly databaseUrl: string;
}

function options(): Options {
  const out = process.env["REVIEWPLANE_FIXTURE_OUT"];
  const databaseUrl = process.env["REVIEWPLANE_TEST_DATABASE_URL"];
  if (out === undefined || out === "") {
    throw new Error("REVIEWPLANE_FIXTURE_OUT is required; run test/fixtures/stage0/capture.sh");
  }
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error(
      "REVIEWPLANE_TEST_DATABASE_URL is required; run test/fixtures/stage0/capture.sh",
    );
  }
  return { out, databaseUrl };
}

function step(what: string, detail?: unknown): void {
  process.stdout.write(
    detail === undefined ? `[fixture] ${what}\n` : `[fixture] ${what}: ${JSON.stringify(detail)}\n`,
  );
}

async function waitFor(what: string, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await probe().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${what} did not become ready within 60 seconds`);
}

let pool: Pool;
let control: BuiltApp;
let mcp: BuiltMcpApp;
let worker: ChildProcess | null = null;
let fixture: FixtureApp;
let fixtureTls: LoopbackTls;
let controlOrigin: string;
let mcpOrigin: string;
let sessionRoot: string;

/** Data the manifest records about what the loop produced. */
interface Summary {
  readonly organisation: { id: string; slug: string };
  readonly project: { id: string; slug: string };
  readonly review: { id: string; slug: string; status: string };
  readonly findings: { id: string; status: string; severity: string; annotations: number }[];
  readonly verification: { id: string; status: string; after_artefact_id: string };
  readonly artefacts: {
    id: string;
    kind: string;
    sha256: string;
    size_bytes: number;
    storage_key: string;
  }[];
  readonly row_counts: Record<string, number>;
  readonly migration_head: string;
  readonly migrations: string[];
}

async function main(): Promise<void> {
  const { out, databaseUrl } = options();
  const artefactRoot = join(out, "artefacts");
  await rm(artefactRoot, { recursive: true, force: true });
  await mkdir(artefactRoot, { recursive: true });
  sessionRoot = await mkdtemp(join(tmpdir(), "reviewplane-fixture-sessions-"));

  pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const applied = await migrate(pool, MIGRATIONS);
  step("migrations applied", { count: applied.applied.length, head: applied.applied.at(-1) });

  // ADR-0015: a browser session reaches a development service only at its
  // internal origin, by resolver rule and public-key pin, so the fixture
  // application has to be a TLS listener the pin names.
  fixtureTls = issueLoopbackTls(["127.0.0.1", "localhost"]);
  fixture = await startFixtureApp(fixtureTls);

  const serverConfig: ServerConfig = testServerConfig({
    host: "127.0.0.1",
    port: 0,
    databaseUrl,
    bootstrapToken: BOOTSTRAP_TOKEN,
    workerCredential: WORKER_CREDENTIAL,
    workerCommandCredential: WORKER_COMMAND_CREDENTIAL,
    workerEndpoint: `http://127.0.0.1:${String(WORKER_PORT)}`,
    artefactPath: artefactRoot,
    workerRequestTimeoutMs: 60_000,
  });
  // Publication needs a connector and a tunnel gateway. Stage 0 has neither in
  // a fixture — the connector's own end-to-end proof is `pnpm test:e2e` — and
  // the rows they would add are session-scoped route state, not review history.
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
    databaseUrl,
    workerCommandCredential: WORKER_COMMAND_CREDENTIAL,
    workerEndpoint: `http://127.0.0.1:${String(WORKER_PORT)}`,
    workerRequestTimeoutMs: 60_000,
    artefactPath: artefactRoot,
    artefactMaxBytes: 20_971_520,
    apiPathPrefix: "/api/v1",
    mcpPath: "/mcp/v1",
  };
  mcp = await buildMcpApp({ config: mcpConfig, pool });
  mcpOrigin = await mcp.app.listen({ host: "127.0.0.1", port: 0 });

  const summary = await captureLoop(artefactRoot);
  await writeFile(join(out, ".summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  step("wrote .summary.json");
}

/**
 * Starts the real browser worker as its own process.
 *
 * `AGENTS.md` keeps the worker out of the control-plane process, and a capture
 * that ran them together would produce evidence the product cannot produce. It
 * starts after the project is assigned to the worker identity, because the
 * worker reads its assignment at registration (`docs/SECURITY.md` §6.4).
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
        REVIEWPLANE_WORKER_CAPACITY: "3",
        REVIEWPLANE_WORKER_SANDBOX: "required",
        REVIEWPLANE_WORKER_SESSION_ROOT: sessionRoot,
        REVIEWPLANE_CONTROL_PLANE_URL: controlOrigin,
        REVIEWPLANE_WORKER_CREDENTIAL: WORKER_CREDENTIAL,
        REVIEWPLANE_WORKER_COMMAND_CREDENTIAL: WORKER_COMMAND_CREDENTIAL,
        REVIEWPLANE_WORKER_SESSION_DURATION_SECONDS: "900",
        // The deployed mechanism minus the gateway hop: Chromium resolves the
        // internal name to the fixture's own loopback listener and trusts that
        // one public key (ADR-0015).
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

interface OpenSession {
  readonly id: string;
  readonly control_epoch: number;
  readonly service_origin: string;
}

/**
 * Reserves a browser session, publishes the fixture to it, and allocates it.
 *
 * This is the `docs/API.md` §11 order: the route names the sessions it admits,
 * so the session identifier exists first, and the session learns its origin
 * from the route rather than from its caller.
 */
async function openSession(
  projectId: string,
  organisationId: string,
  viewport: Readonly<{ width: number; height: number; device_scale_factor: number }>,
  extra: Readonly<Record<string, unknown>> = {},
): Promise<OpenSession> {
  const app = control.app;
  const reserved = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/browser-sessions`,
    headers: ADMIN,
    payload: {
      organisation_id: organisationId,
      viewport,
      retention_class: "verification_evidence",
      allocate: false,
      ...extra,
    },
  });
  assert.equal(reserved.statusCode, 201, reserved.body);
  const sessionId = (reserved.json() as { data: { id: string } }).data.id;

  const published = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/published-services`,
    headers: ADMIN,
    payload: {
      connector_id: "con_fixture",
      workspace_id: "wsp_fixture",
      local_host: "127.0.0.1",
      local_port: FIXTURE_PORT,
      protocol: "http",
      ttl_seconds: 900,
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
  const record = (
    allocated.json() as {
      data: { id: string; control_epoch: number; service_origin: string; status: string };
    }
  ).data;
  assert.equal(record.status, "READY", allocated.body);
  return {
    id: record.id,
    control_epoch: record.control_epoch,
    service_origin: record.service_origin,
  };
}

/** Navigates a session and persists an original screenshot of the page. */
async function captureOriginal(
  session: OpenSession,
  path: string,
): Promise<{ artefact_id: string; sha256: string }> {
  const navigate = await control.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${session.id}/commands`,
    headers: ADMIN,
    payload: {
      control_epoch: session.control_epoch,
      command: { command: "navigate", timeout_ms: 30_000, navigate: { url: path, wait_until: "load" } },
    },
  });
  assert.equal(navigate.statusCode, 200, navigate.body);

  const captured = await control.app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${session.id}/commands`,
    headers: ADMIN,
    payload: {
      control_epoch: session.control_epoch,
      command: {
        command: "take_screenshot",
        timeout_ms: 30_000,
        take_screenshot: { full_page: false, persist: true, purpose: "annotation" },
      },
    },
  });
  const result = (
    captured.json() as {
      data: { ok: boolean; screenshot?: { artefact_id: string; sha256: string } };
    }
  ).data;
  assert.equal(result.ok, true, JSON.stringify(result));
  const screenshot = result.screenshot;
  assert.ok(screenshot !== undefined, "the capture produced verified evidence");
  return screenshot;
}

async function captureLoop(artefactRoot: string): Promise<Summary> {
  const app = control.app;

  // ---- the human's half of the loop, through the control-plane API ---------
  const organisationId = (
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/organisations",
        headers: ADMIN,
        payload: { name: "Refresh", slug: "refresh" },
      })
    ).json() as { data: { id: string } }
  ).data.id;
  const projectId = (
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/organisations/${organisationId}/projects`,
        headers: ADMIN,
        payload: { name: "Refresh Surplus", slug: "refresh-surplus" },
      })
    ).json() as { data: { id: string } }
  ).data.id;
  step("project", { organisationId, projectId });

  const registered = await control.workers.register(WORKER_CREDENTIAL, {
    worker_name: WORKER_NAME,
    worker_version: "0.1.0",
    browser_type: "chromium",
    browser_version: "143.0.7499.4",
    capacity: 3,
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
          root_path: "/workspace/refresh-surplus",
          branch: "redesign",
          head_commit: CAPTURED_COMMIT,
          dirty: false,
        },
      })
    ).json() as { data: { id: string } }
  ).data.id;

  // Two human sessions, one per required viewport, so the fixture carries a
  // finding captured at each and a migration cannot be written against one
  // shape of viewport metadata.
  const mobileSession = await openSession(projectId, organisationId, MOBILE);
  const mobileShot = await captureOriginal(mobileSession, "/");
  step("before screenshot (390x844)", mobileShot);

  const desktopSession = await openSession(projectId, organisationId, DESKTOP);
  const desktopShot = await captureOriginal(desktopSession, "/");
  step("before screenshot (1440x900)", desktopShot);

  const reviewId = (
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/reviews`,
        headers: ADMIN,
        payload: {
          slug: "bugs-on-homepage",
          title: "Bugs on homepage",
          description:
            "Two layout problems a customer reported on the homepage of the redesign branch.",
          status: "READY",
          captured_branch: "redesign",
          captured_commit: CAPTURED_COMMIT,
          captured_workspace_id: workspaceId,
          source_browser_session_id: mobileSession.id,
        },
      })
    ).json() as { data: { id: string } }
  ).data.id;
  step("review", { reviewId, slug: "bugs-on-homepage" });

  // Finding one: the defect the agent resolves. Two annotations, one box and
  // one arrow, so both geometry vocabularies of `docs/DOMAIN_MODEL.md` §16 are
  // in the fixture.
  const overlapFindingId = (
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/reviews/${reviewId}/findings`,
        headers: ADMIN,
        payload: {
          title: "Hero heading overlaps the navigation below 900px",
          description:
            "The collapse breakpoint is 768px but the navigation still wraps at 880px, so the heading is drawn on top of the links.",
          severity: "high",
          source: "human",
          url: `${mobileSession.service_origin}/`,
          viewport: MOBILE,
          scroll_position: { x: 0, y: 0 },
          captured_commit: CAPTURED_COMMIT,
          screenshot_artefact_id: mobileShot.artefact_id,
          acceptance_criteria: "No overlap between 768px and 1024px.",
          annotations: [
            {
              artefact_id: mobileShot.artefact_id,
              type: "rectangle",
              geometry: { x: 0.05, y: 0.02, width: 0.9, height: 0.2 },
              label: "Heading text sits on top of the navigation links",
              marker_number: 1,
              style_hint: "critical",
            },
            {
              artefact_id: mobileShot.artefact_id,
              type: "arrow",
              geometry: { x: 0.62, y: 0.28, x2: 0.34, y2: 0.09 },
              label: "The Checkout link the heading covers",
            },
          ],
        },
      })
    ).json() as { data: { finding: { id: string } } }
  ).data.finding.id;

  // Finding two stays open: a fixture whose every finding is resolved would not
  // exercise an unclaimed finding across the upgrade.
  const spacingFindingId = (
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/reviews/${reviewId}/findings`,
        headers: ADMIN,
        payload: {
          title: "Header padding is uneven at 1440px",
          description:
            "The header keeps its mobile padding on a wide viewport, so the wordmark sits closer to the top edge than to the navigation.",
          severity: "medium",
          source: "human",
          url: `${desktopSession.service_origin}/`,
          viewport: DESKTOP,
          scroll_position: { x: 0, y: 0 },
          captured_commit: CAPTURED_COMMIT,
          screenshot_artefact_id: desktopShot.artefact_id,
          acceptance_criteria: "Equal padding above and below the wordmark at 1440px.",
          annotations: [
            {
              artefact_id: desktopShot.artefact_id,
              type: "numbered_marker",
              geometry: { x: 0.04, y: 0.03 },
              label: "Padding above the wordmark",
              marker_number: 2,
              style_hint: "informational",
            },
          ],
        },
      })
    ).json() as { data: { finding: { id: string } } }
  ).data.finding.id;
  step("findings", { overlapFindingId, spacingFindingId });

  const credential = (
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/organisations/${organisationId}/agent-credentials`,
        headers: ADMIN,
        payload: { project_ids: [projectId], label: "claude-code on dev-ai-03" },
      })
    ).json() as { data: { token: string } }
  ).data;

  // ---- the agent's half of the loop, through the MCP endpoint --------------
  const client = new Client({ name: "claude-code", version: "stage0-fixture" });
  const transport = new StreamableHTTPClientTransport(new URL(`${mcpOrigin}/mcp/v1`), {
    requestInit: { headers: { authorization: `Bearer ${credential.token}` } },
  });
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const content = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text?: string }[];
    };
    const text = content.content.find((block) => block.type === "text")?.text;
    assert.ok(text !== undefined, `${name} returned no text block`);
    const envelope = JSON.parse(text) as Record<string, unknown>;
    assert.equal(envelope["ok"], true, `${name}: ${text}`);
    step(name, { ok: envelope["ok"], trust: envelope["trust"] });
    return envelope;
  };

  await callTool("project_current", {});
  const review = await callTool("review_get", { review: "bugs-on-homepage" });
  const reviewData = review["data"] as {
    review: { id: string; version: number; slug: string };
    findings: { id: string; version: number }[];
  };
  assert.equal(reviewData.review.id, reviewId);

  await callTool("review_claim", {
    review_id: reviewId,
    expected_version: reviewData.review.version,
    idempotency_key: "fixture-claim-review",
  });
  const claimedFinding = reviewData.findings.find((finding) => finding.id === overlapFindingId);
  assert.ok(claimedFinding !== undefined, "review_get returned the finding the agent claims");
  const claimed = await callTool("finding_claim", {
    finding_id: overlapFindingId,
    expected_version: claimedFinding.version,
    idempotency_key: "fixture-claim-finding",
  });
  await callTool("finding_update_status", {
    finding_id: overlapFindingId,
    expected_version: (claimed["data"] as { finding: { version: number } }).finding.version,
    status: "IN_PROGRESS",
    idempotency_key: "fixture-in-progress",
  });

  // The agent changes the application: the collapse breakpoint is now 900px.
  fixture.state = "after";

  const agentSessionId = (
    (await callTool("agent_session_status", {}))["data"] as { agent_session_id: string }
  ).agent_session_id;
  const agentSession = await openSession(projectId, organisationId, MOBILE, {
    agent_session_id: agentSessionId,
    controller: { type: "agent", id: agentSessionId },
  });
  const navigated = await app.inject({
    method: "POST",
    url: `/api/v1/browser-sessions/${agentSession.id}/commands`,
    headers: ADMIN,
    payload: {
      control_epoch: agentSession.control_epoch,
      command: { command: "navigate", timeout_ms: 30_000, navigate: { url: "/", wait_until: "load" } },
    },
  });
  assert.equal(navigated.statusCode, 200, navigated.body);

  const shot = await callTool("browser_take_screenshot", {
    browser_session_id: agentSession.id,
    control_epoch: agentSession.control_epoch,
    purpose: "verification",
    idempotency_key: "fixture-after-shot",
  });
  const afterArtefact = (shot["data"] as { artefact: { artefact_id: string; sha256: string } })
    .artefact;
  assert.notEqual(
    afterArtefact.sha256,
    mobileShot.sha256,
    "the after screenshot shows a different page from the before one",
  );
  step("after screenshot", afterArtefact);

  await callTool("finding_add_comment", {
    finding_id: overlapFindingId,
    body: "Raised the navigation collapse breakpoint to 900px in the header stylesheet.",
    idempotency_key: "fixture-comment",
  });

  const submitted = await callTool("finding_submit_verification", {
    finding_id: overlapFindingId,
    summary:
      "Raised the navigation collapse breakpoint to 900px so the heading no longer overlaps the links.",
    branch: "redesign",
    commit: FIXED_COMMIT,
    tested_viewports: [MOBILE, DESKTOP],
    checks: {
      reproduced_before: true,
      console_errors_reviewed: true,
      network_failures_reviewed: true,
      accessibility_checked: true,
    },
    artefact_ids: [afterArtefact.artefact_id],
    idempotency_key: "fixture-verify",
  });
  const verification = submitted["data"] as {
    verification: { verification_id: string; status: string };
    finding: { status: string; version: number };
  };

  await callTool("finding_update_status", {
    finding_id: overlapFindingId,
    expected_version: verification.finding.version,
    status: "AWAITING_HUMAN_REVIEW",
    idempotency_key: "fixture-awaiting",
  });

  // The review reaches the same place. It goes through IN_PROGRESS because
  // `docs/DOMAIN_MODEL.md` §14 has no edge from ASSIGNED straight to
  // AWAITING_HUMAN_REVIEW.
  const reviewNow = await callTool("review_get", { review: "bugs-on-homepage" });
  const working = await callTool("review_update_status", {
    review_id: reviewId,
    expected_version: (reviewNow["data"] as { review: { version: number } }).review.version,
    status: "IN_PROGRESS",
    idempotency_key: "fixture-review-in-progress",
  });
  await callTool("review_update_status", {
    review_id: reviewId,
    expected_version: (working["data"] as { review: { version: number } }).review.version,
    status: "AWAITING_HUMAN_REVIEW",
    idempotency_key: "fixture-review-awaiting",
  });

  await client.close();

  // An installation is backed up at rest, so the sessions are closed rather
  // than left ACTIVE against a worker the restored installation will not have.
  // The review is what outlives them, which is the point of ADR-0004.
  for (const session of [mobileSession, desktopSession, agentSession]) {
    const terminated = await app.inject({
      method: "POST",
      url: `/api/v1/browser-sessions/${session.id}/terminate`,
      headers: ADMIN,
    });
    assert.equal(terminated.statusCode, 200, terminated.body);
  }

  // The human's decision is deliberately absent: Stage 0 has no acceptance
  // surface, and a fixture that invented one would not be Stage 0 data.
  return await summarise({
    artefactRoot,
    organisationId,
    projectId,
    reviewId,
    findingIds: [overlapFindingId, spacingFindingId],
    verificationId: verification.verification.verification_id,
    afterArtefactId: afterArtefact.artefact_id,
  });
}

/** Reads back what was written, so the manifest describes the database and not the script. */
async function summarise(input: {
  artefactRoot: string;
  organisationId: string;
  projectId: string;
  reviewId: string;
  findingIds: string[];
  verificationId: string;
  afterArtefactId: string;
}): Promise<Summary> {
  const organisation = await pool.query<{ id: string; slug: string }>(
    "SELECT id, slug FROM organisations WHERE id = $1",
    [input.organisationId],
  );
  const project = await pool.query<{ id: string; slug: string }>(
    "SELECT id, slug FROM projects WHERE id = $1",
    [input.projectId],
  );
  const review = await pool.query<{ id: string; slug: string; status: string }>(
    "SELECT id, slug, status FROM reviews WHERE id = $1",
    [input.reviewId],
  );
  const findings = await pool.query<{
    id: string;
    status: string;
    severity: string;
    annotations: string;
  }>(
    `SELECT f.id, f.status, f.severity,
            (SELECT count(*) FROM annotations_current a WHERE a.finding_id = f.id) AS annotations
       FROM findings f
      WHERE f.review_id = $1
      ORDER BY f.created_at`,
    [input.reviewId],
  );
  const verification = await pool.query<{ id: string; status: string }>(
    "SELECT id, status FROM verifications WHERE id = $1",
    [input.verificationId],
  );
  const artefacts = await pool.query<{
    id: string;
    kind: string;
    sha256: string;
    size_bytes: string;
    storage_key: string;
  }>("SELECT id, kind, sha256, size_bytes, storage_key FROM artefacts ORDER BY created_at");

  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  const rowCounts: Record<string, number> = {};
  for (const { table_name: table } of tables.rows) {
    const counted = await pool.query<{ count: string }>(`SELECT count(*) AS count FROM "${table}"`);
    rowCounts[table] = Number(counted.rows[0]?.count ?? "0");
  }

  const migrations = await pool.query<{ filename: string }>(
    "SELECT filename FROM schema_migrations ORDER BY filename",
  );
  const files = migrations.rows.map((row) => row.filename);
  const head = files.at(-1);
  assert.ok(head !== undefined, "the fixture database has migrations applied");

  assert.equal(review.rows[0]?.slug, "bugs-on-homepage");
  assert.equal(findings.rows.length, input.findingIds.length);
  assert.equal(verification.rows[0]?.status, "submitted");

  return {
    organisation: { id: organisation.rows[0]?.id ?? "", slug: organisation.rows[0]?.slug ?? "" },
    project: { id: project.rows[0]?.id ?? "", slug: project.rows[0]?.slug ?? "" },
    review: {
      id: review.rows[0]?.id ?? "",
      slug: review.rows[0]?.slug ?? "",
      status: review.rows[0]?.status ?? "",
    },
    findings: findings.rows.map((row) => ({
      id: row.id,
      status: row.status,
      severity: row.severity,
      annotations: Number(row.annotations),
    })),
    verification: {
      id: verification.rows[0]?.id ?? "",
      status: verification.rows[0]?.status ?? "",
      after_artefact_id: input.afterArtefactId,
    },
    artefacts: artefacts.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      sha256: row.sha256,
      size_bytes: Number(row.size_bytes),
      storage_key: row.storage_key,
    })),
    row_counts: rowCounts,
    migration_head: head,
    migrations: files,
  };
}

async function shutdown(): Promise<void> {
  worker?.kill("SIGTERM");
  await mcp?.close().catch(() => undefined);
  await control?.app.close().catch(() => undefined);
  await fixture?.stop().catch(() => undefined);
  await pool?.end().catch(() => undefined);
  if (sessionRoot !== undefined) await rm(sessionRoot, { recursive: true, force: true });
}

try {
  await main();
  await shutdown();
  step("capture complete");
} catch (error) {
  await shutdown();
  process.stderr.write(`[fixture] failed: ${String(error)}\n`);
  process.exitCode = 1;
}
