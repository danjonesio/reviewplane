/**
 * Integration test: the real Go connector binary against the real control
 * plane and a real PostgreSQL (`docs/TESTING.md` §2, "Connector and loopback
 * dev server"; §11 fault injection).
 *
 * This is the test that produces the Stage 0 evidence: the enrolment
 * transcript, the heartbeat sequence, the `ss -ltnp` comparison that shows the
 * connector opens no listening socket, and the denied reused-token transcript.
 */

import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";

import { revokeConnector } from "../src/modules/connectors/repository.ts";
import { issueEnrolmentToken, startHarness, type Harness } from "./support/harness.ts";
import { waitFor } from "./support/connector-client.ts";

const run = promisify(execFile);

const CONNECTOR_MODULE = resolve(import.meta.dirname, "..", "..", "..", "services", "connector");

let harness: Harness;
let binaryPath: string;
let workDirectory: string;

/** The connector binary, built from source so the test cannot drift from it. */
async function buildConnector(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reviewplane-connector-build-"));
  const output = join(directory, "reviewplane-connector");
  await run("go", ["build", "-o", output, "./cmd/reviewplane-connector"], {
    cwd: CONNECTOR_MODULE,
    // The Go toolchain is installed per-user; the test inherits the caller's
    // PATH, and reports a clear failure when it is absent.
    env: process.env,
  });
  return output;
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

interface ConnectorRun {
  readonly process: ChildProcess;
  stderr(): string;
  exited(): Promise<number | null>;
}

function startConnector(dataDir: string, extraArgs: readonly string[] = []): ConnectorRun {
  const child = spawn(
    binaryPath,
    ["run", "--data-dir", dataDir, "--ca-file", harness.caFile, "--heartbeat-interval", "1s", "--log-level", "debug", ...extraArgs],
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

async function enrolWithBinary(
  dataDir: string,
  token: string,
  extraArgs: readonly string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const controlPlane = harness.connectorUrl.replace("wss://", "https://");
  return new Promise((resolveRun) => {
    const child = spawn(
      binaryPath,
      [
        "enrol",
        "--control-plane",
        controlPlane,
        "--data-dir",
        dataDir,
        "--ca-file",
        harness.caFile,
        "--environment-name",
        "dev-ai-03",
        "--labels",
        "proxmox,development",
        "--max-attempts",
        "1",
        ...extraArgs,
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, REVIEWPLANE_ENROLMENT_TOKEN: token } },
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
}

async function connectorRow(connectorId: string): Promise<{ status: string; last_heartbeat_at: Date | null }> {
  const result = await harness.pool.query<{ status: string; last_heartbeat_at: Date | null }>(
    "select status, last_heartbeat_at from connectors where id = $1",
    [connectorId],
  );
  const row = result.rows[0];
  assert.ok(row !== undefined, `no connector record for ${connectorId}`);
  return row;
}

async function eventSequence(connectorId: string): Promise<{ sequence: number; type: string }[]> {
  const result = await harness.pool.query<{ sequence: string; type: string }>(
    "select sequence, type from events where correlation ->> 'connector_id' = $1 order by sequence",
    [connectorId],
  );
  return result.rows.map((row) => ({ sequence: Number(row.sequence), type: row.type }));
}

before(async () => {
  binaryPath = await buildConnector();
  workDirectory = await mkdtemp(join(tmpdir(), "reviewplane-connector-data-"));
  harness = await startHarness({
    connectorEnvironment: {
      REVIEWPLANE_CONNECTOR_HEARTBEAT_INTERVAL_SECONDS: "1",
      REVIEWPLANE_CONNECTOR_DEGRADED_AFTER_SECONDS: "3",
      REVIEWPLANE_CONNECTOR_DISCONNECTED_AFTER_SECONDS: "6",
      REVIEWPLANE_CONNECTOR_MONITOR_INTERVAL_SECONDS: "1",
    },
  });
});

after(async () => {
  await harness.stop();
});

describe("the connector binary against the control plane", () => {
  test("enrols, holds an authenticated channel open and opens no listening socket", async () => {
    const dataDir = join(workDirectory, "primary");
    const issued = await issueEnrolmentToken(harness, { expires_in_seconds: 600 });

    const before = await listeningSockets();

    const enrolment = await enrolWithBinary(dataDir, issued.token);
    assert.equal(enrolment.code, 0, `enrolment failed: ${enrolment.stderr}`);
    assert.match(enrolment.stdout, /Enrolled as con_/);
    assert.match(enrolment.stdout, /Identity fingerprint: sha256:[0-9a-f]{64}/);

    const connectorId = /Enrolled as (?<id>con_[A-Za-z0-9_-]+)/.exec(enrolment.stdout)?.groups?.["id"];
    assert.ok(connectorId !== undefined, "the enrolment output did not name the connector");

    // The private key is on disk with owner-only permissions and never left the
    // environment (docs/SECURITY.md section 6.2).
    const keyStat = await stat(join(dataDir, "device.key"));
    assert.equal(keyStat.mode & 0o777, 0o600, `the device key has mode ${(keyStat.mode & 0o777).toString(8)}`);
    const keyPem = await readFile(join(dataDir, "device.key"), "utf8");
    assert.match(keyPem, /^-----BEGIN PRIVATE KEY-----/);
    const storedPublicKey = await harness.pool.query<{ public_key: string }>(
      "select public_key from connectors where id = $1",
      [connectorId],
    );
    assert.ok(!keyPem.includes(storedPublicKey.rows[0]?.public_key ?? "never"), "sanity check on key material");

    assert.equal((await connectorRow(connectorId)).status, "PENDING_ENROLMENT");

    // Enrolment opened no listening socket either.
    const afterEnrolment = await listeningSockets();
    assert.equal(
      afterEnrolment.split("\n").length,
      before.split("\n").length,
      "enrolment changed the set of listening sockets",
    );

    const connector = startConnector(dataDir);
    try {
      await waitFor(async () => (await connectorRow(connectorId)).status === "ACTIVE" || null, "the connector to become ACTIVE");

      // Successive heartbeats, not just the first.
      const firstHeartbeat = (await connectorRow(connectorId)).last_heartbeat_at;
      assert.ok(firstHeartbeat !== null);
      await waitFor(async () => {
        const row = await connectorRow(connectorId);
        return row.last_heartbeat_at !== null && row.last_heartbeat_at.getTime() > firstHeartbeat.getTime()
          ? row.last_heartbeat_at
          : null;
      }, "a second heartbeat");

      // The Stage 0 exit criterion, checked while the channel is established.
      const duringRun = await listeningSockets();
      const owned = socketsForProcess(duringRun, connector.process.pid ?? -1);
      assert.deepEqual(
        owned,
        [],
        `the connector holds listening sockets:\n${owned.join("\n")}\n\nfull ss -ltnp output:\n${duringRun}`,
      );

      const events = await eventSequence(connectorId);
      const types = events.map((event) => event.type);
      assert.deepEqual(types.slice(0, 2), ["connector.enrolled", "connector.connected"], `events were ${types.join(", ")}`);
      for (let index = 1; index < events.length; index += 1) {
        assert.ok(
          (events[index]?.sequence ?? 0) > (events[index - 1]?.sequence ?? 0),
          "event sequence is not monotonic",
        );
      }

      // docs/SECURITY.md section 18 and the issue's acceptance criteria.
      const logs = connector.stderr();
      assert.ok(logs.length > 0, "the connector produced no log output");
      assert.ok(!logs.includes(issued.token), "the enrolment token appears in the connector log");
      assert.ok(!logs.includes("BEGIN PRIVATE KEY"), "private key material appears in the connector log");
      for (const line of keyPem.split("\n")) {
        if (line.startsWith("-----") || line.length < 16) continue;
        assert.ok(!logs.includes(line), "private key material appears in the connector log");
      }
      const certificatePem = await readFile(join(dataDir, "device.crt"), "utf8");
      const certificateBody = certificatePem
        .split("\n")
        .filter((line) => !line.startsWith("-----") && line.length > 16);
      for (const line of certificateBody) {
        assert.ok(!logs.includes(line), "the signed identity appears in the connector log");
      }
      // Correlation identifiers are present.
      assert.ok(logs.includes(`"connector_id":"${connectorId}"`), "the connector ID is not a log correlation field");
      assert.ok(logs.includes('"correlation_id":"cor_'), "no correlation ID in the connector log");
      assert.ok(logs.includes('"msg":"control channel established"'));
    } finally {
      connector.process.kill("SIGTERM");
      await connector.exited();
    }

    await waitFor(
      async () => (await connectorRow(connectorId)).status === "DISCONNECTED" || null,
      "the connector to be marked DISCONNECTED after it stops",
    );
    const finalTypes = (await eventSequence(connectorId)).map((event) => event.type);
    assert.ok(finalTypes.includes("connector.disconnected"), `events were ${finalTypes.join(", ")}`);
  });

  // docs/TESTING.md section 11: control-plane restart during an established
  // channel; the connector reconnects and the record returns to ACTIVE.
  test("reconnects after a control-plane restart", async () => {
    const dataDir = join(workDirectory, "restart");
    const issued = await issueEnrolmentToken(harness, { expires_in_seconds: 600 });
    const enrolment = await enrolWithBinary(dataDir, issued.token);
    assert.equal(enrolment.code, 0, enrolment.stderr);
    const connectorId = /Enrolled as (?<id>con_[A-Za-z0-9_-]+)/.exec(enrolment.stdout)?.groups?.["id"];
    assert.ok(connectorId !== undefined);

    const connector = startConnector(dataDir);
    try {
      await waitFor(async () => (await connectorRow(connectorId)).status === "ACTIVE" || null, "ACTIVE");

      await harness.restart();

      await waitFor(async () => (await connectorRow(connectorId)).status === "ACTIVE" || null, "the connector to reconnect", 40_000);
      const logs = connector.stderr();
      assert.match(logs, /channel lost; reconnecting/);
      assert.match(logs, /"retry_in":/, "the reconnect log does not report the backoff delay");
      const established = logs.split("control channel established").length - 1;
      assert.ok(established >= 2, `the channel was established ${String(established)} times`);
    } finally {
      connector.process.kill("SIGTERM");
      await connector.exited();
    }
  });

  // docs/CONNECTOR_PROTOCOL.md section 18 and the issue's acceptance criteria:
  // a revoked identity fails closed and is not retried.
  test("fails closed on a revoked identity and does not retry", async () => {
    const dataDir = join(workDirectory, "revoked");
    const issued = await issueEnrolmentToken(harness, { expires_in_seconds: 600 });
    const enrolment = await enrolWithBinary(dataDir, issued.token);
    assert.equal(enrolment.code, 0, enrolment.stderr);
    const connectorId = /Enrolled as (?<id>con_[A-Za-z0-9_-]+)/.exec(enrolment.stdout)?.groups?.["id"];
    assert.ok(connectorId !== undefined);

    await revokeConnector(harness.pool, connectorId, { type: "system" });

    const connector = startConnector(dataDir);
    const code = await connector.exited();
    // Exit code 3 is the connector's "an operator must act" code.
    assert.equal(code, 3, `the connector exited with ${String(code)}: ${connector.stderr()}`);
    const logs = connector.stderr();
    assert.match(logs, /IDENTITY_REVOKED/);
    assert.match(logs, /not retrying with this identity/);
    const attempts = logs.split("control channel established").length - 1;
    assert.equal(attempts, 0, "the connector established a channel with a revoked identity");
  });

  // The denied reused-token transcript required as evidence.
  test("a reused enrolment token is denied with ENROLMENT_TOKEN_INVALID", async () => {
    const issued = await issueEnrolmentToken(harness, { expires_in_seconds: 600 });
    const first = await enrolWithBinary(join(workDirectory, "reuse-first"), issued.token);
    assert.equal(first.code, 0, first.stderr);

    const second = await enrolWithBinary(join(workDirectory, "reuse-second"), issued.token);
    assert.equal(second.code, 3, `the reused token produced exit code ${String(second.code)}`);
    assert.match(second.stderr, /ENROLMENT_TOKEN_INVALID/);
    assert.ok(!second.stderr.includes(issued.token), "the refused token appears in the transcript");

    const connectors = await harness.pool.query<{ count: string }>(
      "select count(*)::text as count from connectors where enrolment_token_id = $1",
      [issued.id],
    );
    assert.equal(connectors.rows[0]?.count, "1");
  });

  // docs/TESTING.md section 11: the control plane unavailable at enrolment.
  test("reports CONTROL_PLANE_UNAVAILABLE when the control plane cannot be reached", async () => {
    const dataDir = join(workDirectory, "unavailable");
    const controlPlane = "https://127.0.0.1:1";
    const result = await new Promise<{ code: number; stderr: string }>((resolveRun) => {
      const child = spawn(
        binaryPath,
        [
          "enrol",
          "--control-plane",
          controlPlane,
          "--data-dir",
          dataDir,
          "--token",
          "a-token-that-will-never-be-presented",
          "--max-attempts",
          "2",
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("exit", (code) => resolveRun({ code: code ?? -1, stderr }));
    });
    assert.equal(result.code, 1, "an unreachable control plane is retryable, not terminal");
    assert.match(result.stderr, /CONTROL_PLANE_UNAVAILABLE/);
    assert.match(result.stderr, /after 2 attempts/);

    // The key was generated and no identity was recorded, so a retry is safe.
    const keyStat = await stat(join(dataDir, "device.key"));
    assert.equal(keyStat.mode & 0o777, 0o600);
    await assert.rejects(stat(join(dataDir, "identity.json")), "an interrupted enrolment recorded an identity");
  });

  // docs/DEVELOPMENT.md section 10: the private key's permissions are
  // validated on every start.
  test("refuses to start when the device key is readable by others", async () => {
    const dataDir = join(workDirectory, "permissions");
    const issued = await issueEnrolmentToken(harness, { expires_in_seconds: 600 });
    assert.equal((await enrolWithBinary(dataDir, issued.token)).code, 0);

    await run("chmod", ["644", join(dataDir, "device.key")]);
    const connector = startConnector(dataDir);
    const code = await connector.exited();
    assert.equal(code, 3, `the connector exited with ${String(code)}`);
    assert.match(connector.stderr(), /refusing to use .*device\.key/);
    assert.match(connector.stderr(), /group and other permissions must be removed/);
  });
});
