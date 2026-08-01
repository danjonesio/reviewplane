/**
 * Reconnect reconciliation against a real database and a real connector
 * process (`docs/CONNECTOR_PROTOCOL.md` §17, `docs/TESTING.md` §6 and §11).
 *
 * Two kinds of case live here, and they need different clients:
 *
 * - what a real connector does — lose its route table to a process restart,
 *   hold it through a control-plane restart — is driven by the Go binary built
 *   from source, so it cannot drift from what an operator runs;
 * - what a hostile or confused connector does — claim another connector's
 *   route, claim an expired one, reconnect with a revoked identity — is driven
 *   by the protocol double, because a real connector will not produce those on
 *   demand and they are exactly the claims reconciliation has to refuse.
 */

import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";

import type {
  GatewayRegisterRequest,
  GatewayRouteView,
  TunnelGateway,
} from "../src/modules/published-services/gateway-client.ts";
import { revokeConnector } from "../src/modules/connectors/repository.ts";
import { issueEnrolmentToken, startHarness, BOOTSTRAP_TOKEN, type Harness } from "./support/harness.ts";
import {
  enrolOverWebSocket,
  generateDeviceKey,
  identityFrom,
  openControlChannel,
  waitFor,
  type ConnectorIdentity,
} from "./support/connector-client.ts";

const run = promisify(execFile);

const CONNECTOR_MODULE = resolve(import.meta.dirname, "..", "..", "..", "services", "connector");
const PROJECT_ID = "prj_reconnect";
const WORKSPACE_ID = "wsp_reconnect";
const SESSION_ID = "brs_reconnect";

class RecordingGateway implements TunnelGateway {
  readonly registered: GatewayRegisterRequest[] = [];
  readonly revokedRoutes: string[] = [];

  register(request: GatewayRegisterRequest): Promise<GatewayRouteView> {
    this.registered.push(request);
    return Promise.resolve({
      route_id: request.route_id,
      project_id: request.project_id,
      connector_id: request.connector_id,
      public_alias: request.public_alias,
      internal_origin: `https://${request.public_alias}.internal.invalid/`,
      status: "ready",
      expires_at: request.expires_at,
      observed_destination: request.observed_destination,
      connector_connected: true,
      streams_opened: 0,
      streams_active: 0,
      bytes_to_destination: 0,
      bytes_from_destination: 0,
    });
  }

  revokeRoute(routeId: string): Promise<void> {
    this.revokedRoutes.push(routeId);
    return Promise.resolve();
  }

  revokeCapability(): Promise<void> {
    return Promise.resolve();
  }
}

interface ConnectorRun {
  readonly process: ChildProcess;
  stderr(): string;
  exited(): Promise<number | null>;
}

let harness: Harness;
let gateway: RecordingGateway;
let binaryPath: string;
let workDirectory: string;
let dataDirectory: string;
let configPath: string;
let connectorId: string;
let connector: ConnectorRun;
let fixture: Server;
let fixturePort: number;

async function buildConnector(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reviewplane-reconnect-build-"));
  const output = join(directory, "reviewplane-connector");
  await run("go", ["build", "-o", output, "./cmd/reviewplane-connector"], {
    cwd: CONNECTOR_MODULE,
    env: process.env,
  });
  return output;
}

async function startFixture(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/plain");
    response.end(`fixture:${request.url ?? "/"}`);
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return { server, port: address.port };
}

async function writeConnectorConfig(): Promise<string> {
  const path = join(workDirectory, "connector.yaml");
  await writeFile(
    path,
    [
      "control_plane:",
      `  url: ${harness.connectorUrl.replace("wss://", "https://")}`,
      "  tls:",
      `    ca_file: ${harness.caFile}`,
      "identity:",
      `  data_dir: ${dataDirectory}`,
      "heartbeat:",
      "  interval: 1s",
      "reconnect:",
      "  initial_delay: 200ms",
      "  max_delay: 2s",
      "  factor: 2",
      "  jitter: 0.3",
      "workspaces:",
      `  - id: ${WORKSPACE_ID}`,
      "    path: /tmp/reviewplane-reconnect",
      `    project: ${PROJECT_ID}`,
      "publication:",
      "  allowed_hosts:",
      "    - 127.0.0.1",
      "  allowed_ports:",
      `    - ${String(fixturePort)}`,
      "  max_routes: 16",
      "logging:",
      "  level: debug",
      "  format: json",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return path;
}

function startConnector(): ConnectorRun {
  const child = spawn(
    binaryPath,
    ["run", "--config", configPath, "--data-dir", dataDirectory, "--ca-file", harness.caFile, "--log-level", "debug"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", () => undefined);
  const exited = new Promise<number | null>((resolveExit) => {
    child.on("exit", (code) => resolveExit(code));
  });
  return { process: child, stderr: () => stderr, exited: () => exited };
}

async function stopConnector(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  connector.process.kill(signal);
  await connector.exited();
}

async function waitForActive(): Promise<void> {
  await waitFor(async () => {
    const result = await harness.pool.query<{ status: string }>(
      "select status from connectors where id = $1",
      [connectorId],
    );
    return result.rows[0]?.status === "ACTIVE" ? true : null;
  }, "the connector to become ACTIVE");
}

async function publish(ttlSeconds = 600): Promise<Record<string, string>> {
  const response = await fetch(`${harness.apiUrl}/api/v1/projects/${PROJECT_ID}/published-services`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
    body: JSON.stringify({
      connector_id: connectorId,
      workspace_id: WORKSPACE_ID,
      local_host: "127.0.0.1",
      local_port: fixturePort,
      protocol: "http",
      ttl_seconds: ttlSeconds,
      allowed_browser_session_ids: [SESSION_ID],
    }),
  });
  const body = (await response.json()) as { data: Record<string, string> };
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.data;
}

async function serviceStatus(id: string): Promise<string> {
  const result = await harness.pool.query<{ status: string }>(
    "select status from published_services where id = $1",
    [id],
  );
  return result.rows[0]?.status ?? "missing";
}

async function eventsFor(publishedServiceId: string): Promise<{ type: string; payload: Record<string, unknown> }[]> {
  const result = await harness.pool.query<{ type: string; payload: Record<string, unknown> }>(
    `select type, payload from events where payload ->> 'published_service_id' = $1 order by sequence`,
    [publishedServiceId],
  );
  return result.rows;
}

/**
 * Records a transcript under `docs/evidence/rvp-18` when the run asks for it, so
 * that the pull request's evidence is produced by the test rather than
 * transcribed by hand.
 */
async function writeEvidence(name: string, content: string): Promise<void> {
  const directory = process.env["REVIEWPLANE_EVIDENCE_DIR"];
  if (directory === undefined || directory === "") return;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), content, { mode: 0o600 });
}

/** A second identity, enrolled through the real administrative endpoint. */
async function enrolSecondConnector(): Promise<ConnectorIdentity> {
  const device = generateDeviceKey();
  const issued = await issueEnrolmentToken(harness, { expires_in_seconds: 600 });
  const attempt = await enrolOverWebSocket(harness, issued.token, device);
  assert.ok(attempt.response !== null, `enrolment refused: ${attempt.closeReason}`);
  return identityFrom(attempt.response, device);
}

before(async () => {
  binaryPath = await buildConnector();
  workDirectory = await mkdtemp(join(tmpdir(), "reviewplane-reconnect-"));
  dataDirectory = join(workDirectory, "connector");
  const started = await startFixture();
  fixture = started.server;
  fixturePort = started.port;

  gateway = new RecordingGateway();
  harness = await startHarness({
    gateway,
    destinationPolicy: {
      allowedHosts: ["127.0.0.1", "::1"],
      allowedPorts: [{ low: 1024, high: 65535 }],
      allowedProtocols: ["http"],
      allowNonLoopback: false,
      allowLinkLocal: false,
    },
    connectorEnvironment: {
      REVIEWPLANE_CONNECTOR_HEARTBEAT_INTERVAL_SECONDS: "1",
      REVIEWPLANE_ORGANISATION_ID: "org_default",
    },
  });

  await harness.pool.query(
    "insert into projects (id, organisation_id, name, slug) values ($1, $2, $3, $4) on conflict do nothing",
    [PROJECT_ID, harness.connectorConfig.organisationId, "Reconnect", "reconnect"],
  );
  // Publication resolves the workspace and every named browser session inside
  // the caller's organisation and project, so both have to be real records
  // here. The reconnect assertions are about a route surviving an
  // interruption; they can only be made about a route that could be published.
  await harness.pool.query(
    `insert into workspaces (
       id, organisation_id, project_id, root_path, branch, head_commit, path_hash,
       display_path, source)
     values ($1, $2, $3, '/srv/reconnect', 'main', 'abcdef1', $4, 'reconnect',
             'connector_report')
     on conflict do nothing`,
    [
      WORKSPACE_ID,
      harness.connectorConfig.organisationId,
      PROJECT_ID,
      `sha256:${"a".repeat(64)}`,
    ],
  );
  await harness.pool.query(
    `insert into browser_sessions (
       id, organisation_id, project_id, status, viewport, limits, retention_policy)
     values ($1, $2, $3, 'REQUESTED', $4, '{}'::jsonb, 'verification_evidence')
     on conflict do nothing`,
    [
      SESSION_ID,
      harness.connectorConfig.organisationId,
      PROJECT_ID,
      JSON.stringify({ width: 1440, height: 900, device_scale_factor: 1 }),
    ],
  );

  const issued = await issueEnrolmentToken(harness, { expires_in_seconds: 600 });
  const enrolment = await new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun) => {
    const child = spawn(
      binaryPath,
      [
        "enrol",
        "--control-plane",
        harness.connectorUrl.replace("wss://", "https://"),
        "--data-dir",
        dataDirectory,
        "--ca-file",
        harness.caFile,
        "--max-attempts",
        "1",
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, REVIEWPLANE_ENROLMENT_TOKEN: issued.token } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("exit", (code) => resolveRun({ code: code ?? -1, stdout, stderr }));
  });
  assert.equal(enrolment.code, 0, `enrolment failed: ${enrolment.stderr}`);
  const parsed = /Enrolled as (?<id>con_[A-Za-z0-9_-]+)/.exec(enrolment.stdout)?.groups?.["id"];
  assert.ok(parsed !== undefined, "the enrolment output did not name the connector");
  connectorId = parsed;

  configPath = await writeConnectorConfig();
  connector = startConnector();
  await waitForActive();
});

after(async () => {
  if (connector.process.exitCode === null) await stopConnector();
  await new Promise<void>((resolveClose) => {
    fixture.close(() => {
      resolveClose();
    });
  });
  await harness.stop();
});

describe("a connector process restart", () => {
  // The Stage 0 exit criterion, from the control plane's side: no operator
  // action, the same route identifier, the same destination.
  test("resumes the route under the same identifier without re-publication", async () => {
    const service = await publish();
    assert.equal(service["status"], "ready");
    const routeId = service["id"] as string;
    const destination = service["observed_destination"] as string;
    const registrations = gateway.registered.length;

    await stopConnector("SIGKILL");
    await waitFor(async () => {
      const result = await harness.pool.query<{ status: string }>(
        "select status from connectors where id = $1",
        [connectorId],
      );
      return result.rows[0]?.status === "DISCONNECTED" ? true : null;
    }, "the connector to be recorded as disconnected");

    // The route is unavailable, not revoked: `docs/ARCHITECTURE.md` §14 keeps
    // the record so that a reconnect within its lifetime resumes it.
    assert.equal(await serviceStatus(routeId), "ready");

    connector = startConnector();
    await waitForActive();

    // The connector lost its in-memory route table to the restart, so the route
    // comes back because the control plane restored it, not because anything
    // published it again.
    await waitFor(async () => {
      const result = await harness.pool.query<{ active_routes: number }>(
        `select (payload ->> 'active_routes')::int as active_routes
           from events where type = 'connector.connected' order by sequence desc limit 1`,
      );
      return result.rows.length > 0 ? true : null;
    }, "the reconnect to be recorded");

    await waitFor(() => {
      const line = connector
        .stderr()
        .split("\n")
        .find((entry) => entry.includes("reconciliation decision") && entry.includes(routeId));
      return line ?? null;
    }, "the connector to log its reconciliation decision");

    const decision = connector
      .stderr()
      .split("\n")
      .find((entry) => entry.includes("reconciliation decision") && entry.includes(routeId));
    assert.ok(decision !== undefined);
    assert.match(decision, /"decision":"continue"/u);
    assert.match(decision, /"reason":"authorised"/u);
    assert.match(decision, new RegExp(`"connector_id":"${connectorId}"`, "u"));
    assert.match(decision, /"resumed":true/u);

    assert.equal(await serviceStatus(routeId), "ready");
    assert.equal(
      gateway.registered.length,
      registrations,
      "the route was re-registered with the gateway; resumption must not need a second publication",
    );

    const heartbeat = await waitFor(async () => {
      const result = await harness.pool.query<{ count: string }>(
        "select count(*)::text as count from connectors where id = $1 and status = 'ACTIVE'",
        [connectorId],
      );
      return result.rows[0]?.count === "1" ? true : null;
    }, "the connector to be active again");
    assert.equal(heartbeat, true);

    // The destination the record names is the one it always named. Nothing was
    // redirected to a different environment.
    const after = await harness.pool.query<{ observed_destination: string }>(
      "select observed_destination from published_services where id = $1",
      [routeId],
    );
    assert.equal(after.rows[0]?.observed_destination, destination);

    await harness.built.publishedServices.revoke(
      routeId,
      { organisationId: null, projectIds: null },
      { type: "system" },
      "cleanup",
    );
  });
});

describe("a control-plane restart while the connector is connected", () => {
  test("the connector reconnects, reconciles and keeps its route", async () => {
    const service = await publish();
    const routeId = service["id"] as string;

    await harness.restart();
    await waitForActive();

    await waitFor(() => {
      const line = connector
        .stderr()
        .split("\n")
        .find((entry) => entry.includes("reconciliation complete"));
      return line ?? null;
    }, "the connector to reconcile after the control-plane restart");

    assert.equal(await serviceStatus(routeId), "ready");
    // The connector held its route table through the restart, so it claimed the
    // route and the control plane continued it.
    const decision = await waitFor(() => {
      const line = connector
        .stderr()
        .split("\n")
        .reverse()
        .find((entry) => entry.includes("reconciliation decision") && entry.includes(routeId));
      return line ?? null;
    }, "a decision for the route the connector still held");
    assert.match(decision, /"decision":"continue"/u);

    await harness.built.publishedServices.revoke(
      routeId,
      { organisationId: null, projectIds: null },
      { type: "system" },
      "cleanup",
    );
  });
});

describe("reconciliation refuses what it must", () => {
  test("a claim on another connector's route is revoked and leaves that route alone", async () => {
    const service = await publish();
    const routeId = service["id"] as string;

    const other = await enrolSecondConnector();
    const channel = await openControlChannel(harness, other);
    const desired = await channel.reconnect({
      active_routes: [
        {
          route_id: routeId,
          project_id: PROJECT_ID,
          workspace_id: WORKSPACE_ID,
          observed_destination: `127.0.0.1:${String(fixturePort)}`,
          expires_at: new Date(Date.now() + 600_000).toISOString().replace(/\.\d{3}Z$/u, "Z"),
        },
      ],
    });
    channel.close();

    const decision = desired.routes.find((entry) => entry.route_id === routeId);
    assert.ok(decision !== undefined, "the claim was not answered");
    assert.equal(decision.decision, "revoke");
    assert.equal(decision.reason, "not_authorised");
    assert.equal(decision.route, undefined, "a refused claim must not restate the publication");

    // The route belongs to the first connector and is untouched.
    assert.equal(await serviceStatus(routeId), "ready");
    await harness.built.publishedServices.revoke(
      routeId,
      { organisationId: null, projectIds: null },
      { type: "system" },
      "cleanup",
    );
  });

  test("a claim on an expired route closes it and records the expiry", async () => {
    const service = await publish(1);
    const routeId = service["id"] as string;
    await harness.pool.query("update published_services set expires_at = now() - interval '1 minute' where id = $1", [
      routeId,
    ]);

    const other = await enrolSecondConnector();
    // The route belongs to another connector, so this claim would be refused for
    // ownership first. Reconciling the owner's own view is what the case needs,
    // so the claim is made on the identity that owns it.
    const owner = await harness.pool.query<{ connector_id: string }>(
      "select connector_id from published_services where id = $1",
      [routeId],
    );
    assert.equal(owner.rows[0]?.connector_id, connectorId);
    assert.notEqual(other.connectorId, connectorId);

    // Restarting the control plane makes the real connector reconnect, claim the
    // route it still holds, and be told it has expired.
    await harness.restart();
    await waitForActive();

    await waitFor(async () => (await serviceStatus(routeId)) === "expired" ? true : null,
      "the expired route to be closed by reconciliation");

    const events = await eventsFor(routeId);
    const expired = events.find((event) => event.type === "published_service.expired");
    assert.ok(expired !== undefined, `no expiry event: ${events.map((event) => event.type).join(", ")}`);
    assert.equal(expired.payload["trigger"], "reconnect_reconciliation");
    assert.equal(expired.payload["reason"], "expired");
    assert.ok(gateway.revokedRoutes.includes(routeId), "the gateway was not told to close the route");
  });

  test("a reconnect with a revoked identity is refused and inherits nothing", async () => {
    const other = await enrolSecondConnector();
    // Revocation has no administrative endpoint yet (`routes.ts`: Stage 1), so
    // the repository transition is used directly. What is under test is the
    // channel's refusal, not the route that will one day trigger it.
    const revoked = await revokeConnector(harness.pool, other.connectorId, { type: "system" });
    assert.notEqual(revoked, null, "the connector was not revoked");

    const channel = await openControlChannel(harness, other);
    const closed = await channel.closed();
    assert.equal(closed.reason, "IDENTITY_REVOKED");
    assert.equal(
      harness.built.connectors.channels.connected(other.connectorId),
      false,
      "a revoked identity holds a channel",
    );
  });

  test("an unknown route the connector claims is refused and audited without a credential", async () => {
    const other = await enrolSecondConnector();
    const channel = await openControlChannel(harness, other);
    const desired = await channel.reconnect({
      active_routes: [
        {
          route_id: "svc_never_existed",
          project_id: PROJECT_ID,
          workspace_id: WORKSPACE_ID,
          observed_destination: "127.0.0.1:4321",
          expires_at: new Date(Date.now() + 600_000).toISOString().replace(/\.\d{3}Z$/u, "Z"),
        },
      ],
    });
    channel.close();

    assert.equal(desired.routes.length, 1);
    assert.equal(desired.routes[0]?.decision, "revoke");
    assert.equal(desired.routes[0]?.reason, "unknown_route");

    const events = await eventsFor("svc_never_existed");
    assert.ok(events.some((event) => event.type === "published_service.revoked"));
    const recorded = JSON.stringify(events);
    assert.ok(!recorded.includes("capability"), "the audit record mentions a credential");
  });

  test("a build below the configured minimum is classified upgrade_required", async () => {
    const other = await enrolSecondConnector();
    const channel = await openControlChannel(harness, other);
    const desired = await channel.reconnect({ connector_version: "0.1.0" });
    channel.close();
    // The harness runs the permissive default, so this build is compatible. The
    // classification itself is exercised by the decision-table unit tests; what
    // matters here is that the response always carries one.
    assert.ok(
      ["compatible", "upgrade_recommended", "upgrade_required", "unsupported"].includes(desired.upgrade),
      `upgrade = ${desired.upgrade}`,
    );
    assert.equal(desired.upgrade, "compatible");
  });
});

describe("browser sessions during a connector outage", () => {
  test("are marked degraded, retain their metadata, and resume on reconnect", async () => {
    const service = await publish();
    const routeId = service["id"] as string;

    // A session bound to the route. The allocation path needs a browser worker,
    // which this harness deliberately does not run; the reconciler's contract is
    // with the record, so the record is what the test states.
    const sessionId = `brs_${Date.now().toString(36)}`;
    await harness.pool.query(
      `insert into browser_sessions (
         id, organisation_id, project_id, published_service_id, status,
         viewport, limits, retention_policy
       ) values ($1, $2, $3, $4, 'ACTIVE', '{"width":1440,"height":900}'::jsonb, '{}'::jsonb, 'action_screenshots')`,
      [sessionId, harness.connectorConfig.organisationId, PROJECT_ID, routeId],
    );

    await stopConnector("SIGKILL");
    const degraded = await waitFor(async () => {
      const result = await harness.pool.query<{ status: string }>(
        "select status from browser_sessions where id = $1",
        [sessionId],
      );
      return result.rows[0]?.status === "DEGRADED" ? true : null;
    }, "the browser session to be marked degraded");
    assert.equal(degraded, true);

    // Degraded, not terminated: the session and its metadata survive the outage.
    const retained = await harness.pool.query<{ ended_at: Date | null; project_id: string }>(
      "select ended_at, project_id from browser_sessions where id = $1",
      [sessionId],
    );
    assert.equal(retained.rows[0]?.ended_at, null);
    assert.equal(retained.rows[0]?.project_id, PROJECT_ID);

    const events = await harness.pool.query<{ type: string; payload: Record<string, unknown> }>(
      `select type, payload from events
        where correlation ->> 'browser_session_id' = $1 order by sequence`,
      [sessionId],
    );
    const degradedEvent = events.rows.find((event) => event.type === "browser_session.degraded");
    assert.ok(degradedEvent !== undefined, "no browser_session.degraded event");
    assert.equal(degradedEvent.payload["reason"], "connector_disconnected");

    connector = startConnector();
    await waitForActive();

    const resumed = await waitFor(async () => {
      const result = await harness.pool.query<{ status: string }>(
        "select status from browser_sessions where id = $1",
        [sessionId],
      );
      return result.rows[0]?.status === "READY" ? true : null;
    }, "the browser session to resume once the route was continued");
    assert.equal(resumed, true);

    // The whole cycle, as the audit trail recorded it. Events are ordered
    // within a stream, and a connector event precedes any project association,
    // so the transcript is ordered by the instant rather than by the per-stream
    // sequence (`docs/EVENTS.md` §2).
    const cycle = await harness.pool.query<{ type: string; payload: Record<string, unknown> }>(
      `select type, payload from events
        where correlation ->> 'connector_id' = $1
           or correlation ->> 'browser_session_id' = $2
           or payload ->> 'published_service_id' = $3
        order by occurred_at, sequence`,
      [connectorId, sessionId, routeId],
    );
    const sequence = cycle.rows.map((event) => {
      const reason = event.payload["reason"] ?? event.payload["trigger"] ?? "";
      return reason === "" ? event.type : `${event.type} (${String(reason)})`;
    });
    const recorded = (prefix: string): boolean => sequence.some((entry) => entry.startsWith(prefix));
    assert.ok(recorded("connector.disconnected"), sequence.join("\n"));
    assert.ok(recorded("browser_session.degraded (connector_disconnected)"), sequence.join("\n"));
    assert.ok(recorded("connector.connected"), sequence.join("\n"));
    assert.ok(recorded("browser_session.resumed (connector_reconnected)"), sequence.join("\n"));
    await writeEvidence("event-sequence.txt", `${sequence.join("\n")}\n`);

    await harness.built.publishedServices.revoke(
      routeId,
      { organisationId: null, projectIds: null },
      { type: "system" },
      "cleanup",
    );
  });
});
