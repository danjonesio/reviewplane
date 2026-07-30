/**
 * Integration test: publishing a loopback development service through the real
 * Go connector (`docs/TESTING.md` §2 "Connector and loopback dev server", §11
 * fault injection).
 *
 * This is the control-plane half of the Stage 0 exit criterion "a dev server
 * bound to loopback on a remote VM is usable by central Chromium". The browser
 * half needs the Compose stack; this half needs nothing but a real connector
 * process and a real loopback service, and it is where the evidence for the
 * publication path comes from: the acknowledgement carries the destination the
 * connector observed, the `ss -ltnp` comparison shows the connector opened no
 * listening socket while carrying a route, and every documented failure
 * surface answers with its own stable code.
 */

import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";

import type {
  GatewayRegisterRequest,
  GatewayRouteView,
  TunnelGateway,
} from "../src/modules/published-services/gateway-client.ts";
import { issueEnrolmentToken, startHarness, BOOTSTRAP_TOKEN, type Harness } from "./support/harness.ts";
import { waitFor } from "./support/connector-client.ts";

const run = promisify(execFile);

const CONNECTOR_MODULE = resolve(import.meta.dirname, "..", "..", "..", "services", "connector");
const PROJECT_ID = "prj_fixture";
const WORKSPACE_ID = "wsp_fixture";
const SESSION_ID = "brs_fixture";

/**
 * A gateway that records what it was told.
 *
 * The gateway's own behaviour is tested exhaustively in
 * `services/tunnel-gateway`. What matters here is that the control plane sends
 * the right instruction, and only after the connector has acknowledged.
 */
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

let harness: Harness;
let gateway: RecordingGateway;
let binaryPath: string;
let workDirectory: string;
let connectorId: string;
let connector: ConnectorRun;
let fixture: Server;
let fixturePort: number;
let closedPort: number;

interface ConnectorRun {
  readonly process: ChildProcess;
  stderr(): string;
  exited(): Promise<number | null>;
}

async function buildConnector(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reviewplane-connector-build-"));
  const output = join(directory, "reviewplane-connector");
  await run("go", ["build", "-o", output, "./cmd/reviewplane-connector"], {
    cwd: CONNECTOR_MODULE,
    env: process.env,
  });
  return output;
}

/** Starts the loopback development service the route will point at. */
async function startFixture(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/plain");
    response.end(`fixture:${request.url ?? "/"}`);
  });
  await new Promise<void>((resolveListen) => {
    // 127.0.0.1 only: the whole proof is that no inbound port is opened.
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return { server, port: address.port };
}

/** The listening TCP sockets on this machine, as `ss -ltnp` reports them. */
async function listeningSockets(): Promise<string> {
  const { stdout } = await run("ss", ["-ltnp"]);
  return stdout;
}

function socketsForProcess(output: string, pid: number): string[] {
  return output
    .split("\n")
    .filter((line) => line.includes(`pid=${String(pid)},`) || line.includes(`pid=${String(pid)})`));
}

/**
 * Writes the connector configuration of `docs/CONNECTOR_PROTOCOL.md` §20.
 *
 * The publication block is what the connector enforces independently of the
 * control plane, so the test states it explicitly rather than relying on a
 * default that would make the enforcement untestable.
 */
async function writeConnectorConfig(dataDir: string, allowedPorts: readonly number[]): Promise<string> {
  const path = join(workDirectory, "connector.yaml");
  await writeFile(
    path,
    [
      "control_plane:",
      `  url: ${harness.connectorUrl.replace("wss://", "https://")}`,
      "  tls:",
      `    ca_file: ${harness.caFile}`,
      "identity:",
      `  data_dir: ${dataDir}`,
      "heartbeat:",
      "  interval: 1s",
      "workspaces:",
      `  - id: ${WORKSPACE_ID}`,
      "    path: /tmp/reviewplane-fixture",
      `    project: ${PROJECT_ID}`,
      "publication:",
      "  allowed_hosts:",
      "    - 127.0.0.1",
      "  allowed_ports:",
      ...allowedPorts.map((port) => `    - ${String(port)}`),
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

function startConnector(dataDir: string, configPath: string): ConnectorRun {
  const child = spawn(
    binaryPath,
    ["run", "--config", configPath, "--data-dir", dataDir, "--ca-file", harness.caFile, "--log-level", "debug"],
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

async function publish(
  body: Record<string, unknown> = {},
  projectId = PROJECT_ID,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${harness.apiUrl}/api/v1/projects/${projectId}/published-services`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
    body: JSON.stringify({
      connector_id: connectorId,
      workspace_id: WORKSPACE_ID,
      local_host: "127.0.0.1",
      local_port: fixturePort,
      protocol: "http",
      ttl_seconds: 600,
      allowed_browser_session_ids: [SESSION_ID],
      ...body,
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function eventTypes(publishedServiceId: string): Promise<string[]> {
  const result = await harness.pool.query<{ type: string }>(
    `select type from events where payload ->> 'published_service_id' = $1 order by sequence`,
    [publishedServiceId],
  );
  return result.rows.map((row) => row.type);
}

before(async () => {
  binaryPath = await buildConnector();
  workDirectory = await mkdtemp(join(tmpdir(), "reviewplane-publication-"));
  const started = await startFixture();
  fixture = started.server;
  fixturePort = started.port;

  gateway = new RecordingGateway();
  harness = await startHarness({
    gateway,
    // The fixture binds an ephemeral port, so the harness policy is wider than
    // the Stage 0 default. Everything the SSRF corpus refuses is still refused.
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
    [PROJECT_ID, harness.connectorConfig.organisationId, "Fixture", "fixture"],
  );

  const dataDir = join(workDirectory, "connector");
  const issued = await issueEnrolmentToken(harness, { expires_in_seconds: 600 });
  const enrolment = await new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun) => {
    const child = spawn(
      binaryPath,
      [
        "enrol",
        "--control-plane",
        harness.connectorUrl.replace("wss://", "https://"),
        "--data-dir",
        dataDir,
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

  // A second port inside the connector's allow-list with nothing bound to it,
  // so the PORT_NOT_LISTENING case is refused by the probe rather than by the
  // destination policy. Reserving and releasing it is how the test names a port
  // it knows nothing else on the machine is using.
  const reserved = await startFixture();
  closedPort = reserved.port;
  await new Promise<void>((resolveClose) => {
    reserved.server.close(() => {
      resolveClose();
    });
  });

  const configPath = await writeConnectorConfig(dataDir, [fixturePort, closedPort]);
  connector = startConnector(dataDir, configPath);
  await waitFor(async () => {
    const result = await harness.pool.query<{ status: string }>(
      "select status from connectors where id = $1",
      [connectorId],
    );
    return result.rows[0]?.status === "ACTIVE" ? true : null;
  }, "the connector to become ACTIVE");
});

after(async () => {
  connector.process.kill("SIGTERM");
  await connector.exited();
  await new Promise<void>((resolveClose) => {
    fixture.close(() => {
      resolveClose();
    });
  });
  await harness.stop();
});

describe("publishing a loopback development service", () => {
  // docs/CONNECTOR_PROTOCOL.md section 11 and docs/API.md section 10.
  test("is acknowledged by the connector and becomes ready", async () => {
    const socketsBefore = await listeningSockets();

    const created = await publish();
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const record = created.body["data"] as Record<string, string>;

    assert.equal(record["status"], "ready");
    // The destination of record is the one the connector reported it opened,
    // not the one the control plane asked for.
    assert.equal(record["observed_destination"], `127.0.0.1:${String(fixturePort)}`);
    assert.equal(record["scope"], "browser_session");

    // docs/ARCHITECTURE.md section 7.3: the internal origin's leftmost label is
    // the public alias, which is a DNS label and never the svc_ identifier.
    assert.match(String(record["public_alias"]), /^[a-z0-9][a-z0-9-]{0,62}$/u);
    assert.equal(
      record["internal_origin"],
      `https://${String(record["public_alias"])}.internal.invalid/`,
    );
    assert.ok(!String(record["public_alias"]).includes("_"), "the alias must be a DNS label");

    // The gateway is told only after the connector has acknowledged.
    const registered = gateway.registered.at(-1);
    assert.ok(registered !== undefined);
    assert.equal(registered.route_id, record["id"]);
    assert.equal(registered.observed_destination, `127.0.0.1:${String(fixturePort)}`);

    // docs/EVENTS.md section 7.
    assert.deepEqual(await eventTypes(String(record["id"])), [
      "published_service.requested",
      "published_service.ready",
    ]);

    // Stage 0 exit criterion 5: carrying a route opened no listening socket on
    // the development VM.
    const socketsAfter = await listeningSockets();
    const pid = connector.process.pid;
    assert.ok(pid !== undefined);
    assert.deepEqual(
      socketsForProcess(socketsAfter, pid),
      [],
      `the connector is listening on a socket:\n${socketsForProcess(socketsAfter, pid).join("\n")}`,
    );
    assert.equal(
      socketsAfter.split("\n").length,
      socketsBefore.split("\n").length,
      "publishing a route changed the set of listening sockets",
    );
  });

  // docs/CONNECTOR_PROTOCOL.md section 11: the startup grace is bounded and
  // ends in PORT_NOT_LISTENING.
  test("a destination that is not listening fails with PORT_NOT_LISTENING", async () => {
    // Inside the connector's allow-list but with nothing bound: the connector's
    // own probe is what refuses it, after its bounded grace.
    const port = closedPort;
    const started = Date.now();
    const refused = await publish({ local_port: port });
    const elapsed = Date.now() - started;

    const error = (refused.body["error"] as Record<string, string> | undefined) ?? {};
    assert.equal(refused.status, 503, JSON.stringify(refused.body));
    assert.equal(error["code"], "PORT_NOT_LISTENING");
    assert.ok(elapsed < 30_000, `the publication waited ${String(elapsed)} ms; the grace must be bounded`);

    // The record exists and is failed, carrying the class rather than free text.
    const failed = await harness.pool.query<{ status: string; failure_class: string }>(
      "select status, failure_class from published_services where local_port = $1",
      [port],
    );
    assert.equal(failed.rows[0]?.status, "failed");
    assert.equal(failed.rows[0]?.failure_class, "PORT_NOT_LISTENING");
  });

  // docs/CONNECTOR_PROTOCOL.md section 11: the connector's own policy refuses a
  // destination the control plane was willing to publish.
  test("a destination outside the connector's policy fails with DESTINATION_NOT_ALLOWED", async () => {
    const other = await startFixture();
    try {
      const refused = await publish({ local_port: other.port });
      const error = (refused.body["error"] as Record<string, string> | undefined) ?? {};
      assert.equal(refused.status, 422, JSON.stringify(refused.body));
      assert.equal(error["code"], "DESTINATION_NOT_ALLOWED");
    } finally {
      await new Promise<void>((resolveClose) => {
        other.server.close(() => {
          resolveClose();
        });
      });
    }
  });

  // docs/CONNECTOR_PROTOCOL.md section 11: the connector answers for its own
  // projects only.
  test("a project the connector does not serve fails with PROJECT_NOT_AUTHORISED", async () => {
    await harness.pool.query(
      "insert into projects (id, organisation_id, name, slug) values ($1, $2, $3, $4) on conflict do nothing",
      ["prj_other", harness.connectorConfig.organisationId, "Other", "other"],
    );
    const refused = await publish({}, "prj_other");
    const error = (refused.body["error"] as Record<string, string> | undefined) ?? {};
    assert.equal(error["code"], "PROJECT_NOT_AUTHORISED", JSON.stringify(refused.body));
  });

  // docs/UX_FLOWS.md section 18: "no connector connected" is an actionable
  // cause with its own stable code, not a generic failure.
  test("a connector that is not connected fails with CONNECTOR_OFFLINE", async () => {
    const refused = await publish({ connector_id: "con_never_enrolled" });
    const error = (refused.body["error"] as Record<string, string> | undefined) ?? {};
    assert.equal(refused.status, 503, JSON.stringify(refused.body));
    assert.equal(error["code"], "CONNECTOR_OFFLINE");
  });

  // docs/DOMAIN_MODEL.md section 10: publication always expires, and the
  // requested lifetime is bounded.
  test("a lifetime beyond the configured maximum is refused", async () => {
    const refused = await publish({ ttl_seconds: 60 * 60 * 24 * 30 });
    const error = (refused.body["error"] as Record<string, string> | undefined) ?? {};
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(error["code"], "ROUTE_EXPIRED");
  });

  // docs/CONNECTOR_PROTOCOL.md section 11: at least one browser session must be
  // named, or the route is not published at all.
  test("a route no browser session may use is not published", async () => {
    const refused = await publish({ allowed_browser_session_ids: [] });
    const error = (refused.body["error"] as Record<string, string> | undefined) ?? {};
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(error["code"], "VALIDATION_FAILED");
  });

  // docs/API.md section 10: deletion revokes immediately and is idempotent.
  test("revocation tells the gateway first and produces one event", async () => {
    const created = await publish();
    const record = created.body["data"] as Record<string, string>;
    const id = String(record["id"]);

    for (const attempt of [1, 2]) {
      const response = await fetch(`${harness.apiUrl}/api/v1/published-services/${id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
      });
      assert.equal(response.status, 200, `attempt ${String(attempt)}`);
    }
    assert.ok(gateway.revokedRoutes.includes(id), "the gateway was not told to revoke");
    const types = await eventTypes(id);
    assert.deepEqual(
      types.filter((type) => type === "published_service.revoked"),
      ["published_service.revoked"],
      "revocation is idempotent and produces at most one event",
    );
  });

  // docs/SECURITY.md section 18: no capability and no credential in a log line.
  test("no capability value reaches the log or an event", async () => {
    const created = await publish();
    const record = created.body["data"] as Record<string, string>;
    const minted = await fetch(
      `${harness.apiUrl}/api/v1/published-services/${String(record["id"])}/capabilities`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
        body: JSON.stringify({ browser_session_id: SESSION_ID }),
      },
    );
    const mintedBody = (await minted.json()) as { data?: { capability: string } };
    assert.equal(minted.status, 201, JSON.stringify(mintedBody));
    const capability = mintedBody.data?.capability ?? "";
    assert.ok(capability.length > 0);

    assert.ok(!harness.logText().includes(capability), "the capability appears in the log");
    const events = await harness.pool.query<{ payload: unknown }>(
      "select payload from events where payload ->> 'published_service_id' = $1",
      [String(record["id"])],
    );
    assert.ok(
      !JSON.stringify(events.rows).includes(capability),
      "the capability appears in an event payload",
    );
  });
});
