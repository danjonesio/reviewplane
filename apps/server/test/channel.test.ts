/**
 * Component and security tests for the mutually authenticated control channel
 * (`docs/CONNECTOR_PROTOCOL.md` §5, §6, §8; `docs/DOMAIN_MODEL.md` §8).
 *
 * The heartbeat thresholds are deliberately short here so that the real state
 * machine — not a stubbed clock — drives `ACTIVE → DEGRADED → DISCONNECTED`
 * inside a test.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, describe, test } from "node:test";

import {
  generateCertificateAuthority,
  issueConnectorCertificate,
} from "../src/modules/connectors/x509.ts";
import { sweepConnectorHealth } from "../src/modules/connectors/monitor.ts";
import { revokeConnector } from "../src/modules/connectors/repository.ts";
import { issueEnrolmentToken, startHarness, type Harness } from "./support/harness.ts";
import {
  enrolOverWebSocket,
  generateDeviceKey,
  identityFrom,
  openControlChannel,
  waitFor,
  type ConnectorIdentity,
} from "./support/connector-client.ts";

let harness: Harness;

before(async () => {
  harness = await startHarness({
    connectorEnvironment: {
      REVIEWPLANE_CONNECTOR_HEARTBEAT_INTERVAL_SECONDS: "1",
      REVIEWPLANE_CONNECTOR_DEGRADED_AFTER_SECONDS: "2",
      REVIEWPLANE_CONNECTOR_DISCONNECTED_AFTER_SECONDS: "4",
      REVIEWPLANE_CONNECTOR_MONITOR_INTERVAL_SECONDS: "1",
    },
  });
});

after(async () => {
  await harness.stop();
});

async function enrolConnector(): Promise<ConnectorIdentity> {
  const issued = await issueEnrolmentToken(harness, { expires_in_seconds: 600 });
  const device = generateDeviceKey();
  const attempt = await enrolOverWebSocket(harness, issued.token, device);
  assert.ok(attempt.response !== null, `enrolment failed: ${attempt.closeReason}`);
  return identityFrom(attempt.response, device);
}

async function statusOf(connectorId: string): Promise<string> {
  const result = await harness.pool.query<{ status: string }>(
    "select status from connectors where id = $1",
    [connectorId],
  );
  return result.rows[0]?.status ?? "missing";
}

async function eventTypes(connectorId: string): Promise<string[]> {
  const result = await harness.pool.query<{ type: string }>(
    "select type from events where correlation ->> 'connector_id' = $1 order by sequence",
    [connectorId],
  );
  return result.rows.map((row) => row.type);
}

describe("control channel authentication", () => {
  test("a connector with its issued identity is accepted and marked ACTIVE", async () => {
    const identity = await enrolConnector();
    assert.equal(await statusOf(identity.connectorId), "PENDING_ENROLMENT");

    const channel = await openControlChannel(harness, identity);
    await waitFor(async () => (await statusOf(identity.connectorId)) === "ACTIVE" || null, "the connector to become ACTIVE");

    const types = await eventTypes(identity.connectorId);
    assert.ok(types.includes("connector.enrolled"), `events were ${types.join(", ")}`);
    assert.ok(types.includes("connector.connected"), `events were ${types.join(", ")}`);

    channel.close();
    await channel.closed();
    await waitFor(
      async () => (await statusOf(identity.connectorId)) === "DISCONNECTED" || null,
      "the connector to become DISCONNECTED after the channel closes",
    );
    assert.ok((await eventTypes(identity.connectorId)).includes("connector.disconnected"));
  });

  test("a connection with no client certificate is refused", async () => {
    const identity = await enrolConnector();
    const channel = await openControlChannel(harness, identity, { withoutCertificate: true });
    const closed = await channel.closed();
    assert.equal(closed.reason, "IDENTITY_REVOKED");
    assert.equal(await statusOf(identity.connectorId), "PENDING_ENROLMENT");
  });

  test("a certificate from another authority cannot open the channel", async () => {
    const identity = await enrolConnector();
    const foreignAuthority = generateCertificateAuthority({
      commonName: "Someone else's CA",
      organization: "Elsewhere",
      notAfter: new Date(Date.now() + 86_400_000),
    });
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const foreign = issueConnectorCertificate({
      authority: foreignAuthority,
      connectorId: identity.connectorId,
      organization: "ReviewPlane",
      subjectPublicKeyInfo: Buffer.from(publicKey.export({ type: "spki", format: "der" })),
      notAfter: new Date(Date.now() + 86_400_000),
    });

    const channel = await openControlChannel(harness, identity, {
      certificatePem: foreign.pem,
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    });
    const closed = await channel.closed();
    assert.equal(closed.reason, "IDENTITY_REVOKED", "a foreign certificate opened the channel");
  });

  // docs/CONNECTOR_PROTOCOL.md section 18 and the issue's acceptance criteria.
  test("a revoked identity fails closed with IDENTITY_REVOKED", async () => {
    const identity = await enrolConnector();
    const first = await openControlChannel(harness, identity);
    await waitFor(async () => (await statusOf(identity.connectorId)) === "ACTIVE" || null, "ACTIVE");
    first.close();
    await first.closed();

    const event = await revokeConnector(harness.pool, identity.connectorId, { type: "system" });
    assert.ok(event !== null, "revocation produced no event");
    assert.equal(event.type, "connector.revoked");
    assert.equal(await statusOf(identity.connectorId), "REVOKED");

    const retry = await openControlChannel(harness, identity);
    const closed = await retry.closed();
    // The refusal arrives before the upgrade, so it is an HTTP status carrying
    // the stable class rather than a WebSocket close.
    assert.equal(closed.reason, "IDENTITY_REVOKED");
    assert.equal(closed.code, 401);
    assert.equal(await statusOf(identity.connectorId), "REVOKED", "a revoked connector was reactivated");
  });

  test("an identity the control plane does not know is refused", async () => {
    const identity = await enrolConnector();
    await harness.pool.query("delete from connectors where id = $1", [identity.connectorId]);
    const channel = await openControlChannel(harness, identity);
    const closed = await channel.closed();
    assert.equal(closed.reason, "IDENTITY_REVOKED");
  });
});

describe("heartbeats", () => {
  test("a heartbeat is recorded and keeps the connector ACTIVE", async () => {
    const identity = await enrolConnector();
    const channel = await openControlChannel(harness, identity);
    channel.sendHeartbeat({ uptime_seconds: 42, active_routes: 0, active_streams: 0 });

    const recorded = await waitFor(async () => {
      const result = await harness.pool.query<{ last_heartbeat_at: Date | null }>(
        "select last_heartbeat_at from connectors where id = $1",
        [identity.connectorId],
      );
      return result.rows[0]?.last_heartbeat_at ?? null;
    }, "the heartbeat to be recorded");
    assert.ok(recorded instanceof Date);
    assert.equal(await statusOf(identity.connectorId), "ACTIVE");

    const environment = await harness.pool.query<{ last_seen_at: Date | null }>(
      "select last_seen_at from environments where id = (select environment_id from connectors where id = $1)",
      [identity.connectorId],
    );
    assert.ok(environment.rows[0]?.last_seen_at instanceof Date, "the environment last_seen_at was not updated");

    channel.close();
    await channel.closed();
  });

  // docs/DOMAIN_MODEL.md section 8 and docs/CONNECTOR_PROTOCOL.md section 8.
  test("heartbeat loss drives ACTIVE to DEGRADED to DISCONNECTED", async () => {
    const identity = await enrolConnector();
    const channel = await openControlChannel(harness, identity);
    channel.sendHeartbeat();
    await waitFor(async () => (await statusOf(identity.connectorId)) === "ACTIVE" || null, "ACTIVE");

    // The socket stays open and the heartbeats stop, so the transition is
    // driven by heartbeat loss rather than by the connection closing.
    await harness.pool.query(
      "update connectors set last_heartbeat_at = now() - interval '3 seconds' where id = $1",
      [identity.connectorId],
    );
    let sweep = await sweepConnectorHealth(harness.pool, harness.connectorConfig);
    assert.deepEqual(sweep.degraded, [identity.connectorId], "the connector did not degrade");
    assert.equal(await statusOf(identity.connectorId), "DEGRADED");

    await harness.pool.query(
      "update connectors set last_heartbeat_at = now() - interval '10 seconds' where id = $1",
      [identity.connectorId],
    );
    sweep = await sweepConnectorHealth(harness.pool, harness.connectorConfig);
    assert.deepEqual(sweep.disconnected, [identity.connectorId], "the connector did not disconnect");
    assert.equal(await statusOf(identity.connectorId), "DISCONNECTED");

    const types = await eventTypes(identity.connectorId);
    assert.ok(types.includes("connector.degraded"), `events were ${types.join(", ")}`);
    assert.ok(types.includes("connector.disconnected"), `events were ${types.join(", ")}`);

    // Every one of the four connector events carries actor type "connector".
    const actors = await harness.pool.query<{ type: string; actor_type: string }>(
      `select type, actor_type from events
        where correlation ->> 'connector_id' = $1
          and type in ('connector.enrolled', 'connector.connected', 'connector.degraded', 'connector.disconnected')`,
      [identity.connectorId],
    );
    assert.ok(actors.rows.length >= 4);
    for (const row of actors.rows) {
      assert.equal(row.actor_type, "connector", `${row.type} was recorded with actor ${row.actor_type}`);
    }

    // A heartbeat after the loss returns the connector to ACTIVE and records it.
    channel.sendHeartbeat();
    await waitFor(async () => (await statusOf(identity.connectorId)) === "ACTIVE" || null, "recovery to ACTIVE");
    channel.close();
    await channel.closed();
  });

  test("a repeated sweep does not re-emit a transition that already happened", async () => {
    const identity = await enrolConnector();
    const channel = await openControlChannel(harness, identity);
    await waitFor(async () => (await statusOf(identity.connectorId)) === "ACTIVE" || null, "ACTIVE");
    await harness.pool.query(
      "update connectors set last_heartbeat_at = now() - interval '3 seconds' where id = $1",
      [identity.connectorId],
    );
    const first = await sweepConnectorHealth(harness.pool, harness.connectorConfig);
    assert.equal(first.degraded.length, 1);
    const second = await sweepConnectorHealth(harness.pool, harness.connectorConfig);
    assert.equal(second.degraded.length, 0, "the sweep re-emitted a transition");
    channel.close();
    await channel.closed();
  });
});

describe("hostile control frames", () => {
  const frames: { name: string; frame: string; expectReason: string }[] = [
    { name: "not json", frame: "definitely not json", expectReason: "" },
    { name: "truncated", frame: '{"protocol_version":1,"type":"heartbeat"', expectReason: "" },
    {
      name: "trailing data",
      frame:
        '{"protocol_version":1,"message_id":"msg_a","type":"heartbeat","sent_at":"2026-07-28T11:00:00Z",' +
        '"connector_id":"con_a","payload":{"status":"healthy","uptime_seconds":1,"version":"0.1.0",' +
        '"active_routes":0,"active_streams":0}}{}',
      expectReason: "",
    },
    {
      name: "unknown protocol version",
      frame: JSON.stringify({
        protocol_version: 2,
        message_id: "msg_a",
        type: "heartbeat",
        sent_at: "2026-07-28T11:00:00Z",
        connector_id: "con_a",
        payload: {},
      }),
      expectReason: "PROTOCOL_UNSUPPORTED",
    },
    {
      name: "unknown message type",
      frame: JSON.stringify({
        protocol_version: 1,
        message_id: "msg_a",
        type: "heartbeat.v2",
        sent_at: "2026-07-28T11:00:00Z",
        connector_id: "con_a",
        payload: {},
      }),
      expectReason: "PROTOCOL_UNSUPPORTED",
    },
    {
      name: "unknown payload property",
      frame: JSON.stringify({
        protocol_version: 1,
        message_id: "msg_a",
        type: "heartbeat",
        sent_at: "2026-07-28T11:00:00Z",
        connector_id: "con_a",
        payload: {
          status: "healthy",
          uptime_seconds: 1,
          version: "0.1.0",
          active_routes: 0,
          active_streams: 0,
          resource_summary: { load: 0.1, process_list: ["secret"] },
        },
      }),
      expectReason: "",
    },
    {
      name: "wrong direction",
      frame: JSON.stringify({
        protocol_version: 1,
        message_id: "msg_a",
        type: "route.publish",
        sent_at: "2026-07-28T11:00:00Z",
        connector_id: "con_a",
        payload: {
          route_id: "svc_a",
          project_id: "prj_a",
          workspace_id: "wsp_a",
          local_host: "127.0.0.1",
          local_port: 4321,
          protocol: "http",
          expires_at: "2026-07-28T12:00:00Z",
          allowed_browser_session_ids: ["brs_a"],
        },
      }),
      expectReason: "PROTOCOL_UNSUPPORTED",
    },
  ];

  for (const testCase of frames) {
    test(`${testCase.name} is refused without crashing the listener`, async () => {
      const identity = await enrolConnector();
      const channel = await openControlChannel(harness, identity);
      channel.send(testCase.frame);
      const closed = await channel.closed();
      assert.equal(closed.reason, testCase.expectReason, `${testCase.name} closed with ${closed.reason}`);
    });
  }

  test("an oversized frame is refused", async () => {
    const identity = await enrolConnector();
    const channel = await openControlChannel(harness, identity);
    channel.send(
      JSON.stringify({
        protocol_version: 1,
        message_id: `msg_${"a".repeat(70_000)}`,
        type: "heartbeat",
        sent_at: "2026-07-28T11:00:00Z",
        connector_id: identity.connectorId,
        payload: { status: "healthy", uptime_seconds: 1, version: "0.1.0", active_routes: 0, active_streams: 0 },
      }),
    );
    const closed = await channel.closed();
    assert.ok(closed.code === 1009 || closed.code === 1006, `oversized frame closed with ${String(closed.code)}`);
  });

  // Defence in depth: the frame must name the identity the handshake proved.
  test("a frame attributed to another connector is refused", async () => {
    const first = await enrolConnector();
    const second = await enrolConnector();
    const channel = await openControlChannel(harness, first);
    channel.send(
      JSON.stringify({
        protocol_version: 1,
        message_id: "msg_impersonation",
        type: "heartbeat",
        sent_at: "2026-07-28T11:00:00Z",
        connector_id: second.connectorId,
        payload: { status: "healthy", uptime_seconds: 1, version: "0.1.0", active_routes: 0, active_streams: 0 },
      }),
    );
    const closed = await channel.closed();
    assert.equal(closed.reason, "IDENTITY_REVOKED");

    const other = await harness.pool.query<{ last_heartbeat_at: Date | null }>(
      "select last_heartbeat_at from connectors where id = $1",
      [second.connectorId],
    );
    assert.equal(other.rows[0]?.last_heartbeat_at, null, "the impersonated connector received a heartbeat");
  });

  test("the listener still serves after every hostile frame", async () => {
    const identity = await enrolConnector();
    const channel = await openControlChannel(harness, identity);
    channel.sendHeartbeat();
    await waitFor(async () => (await statusOf(identity.connectorId)) === "ACTIVE" || null, "ACTIVE");
    channel.close();
    await channel.closed();
  });
});

describe("logging", () => {
  test("no credential or key material appears in the server log", async () => {
    const issued = await issueEnrolmentToken(harness);
    const device = generateDeviceKey();
    const attempt = await enrolOverWebSocket(harness, issued.token, device);
    assert.ok(attempt.response !== null);
    const identity = identityFrom(attempt.response, device);
    const channel = await openControlChannel(harness, identity);
    channel.sendHeartbeat();
    await waitFor(async () => (await statusOf(identity.connectorId)) === "ACTIVE" || null, "ACTIVE");
    channel.close();
    await channel.closed();

    const text = harness.logText();
    assert.ok(text.length > 0, "no log output was captured, so the assertion would be vacuous");
    assert.ok(!text.includes(issued.token), "the enrolment token appears in the log");
    assert.ok(!text.includes(device.privateKeyPem.trim()), "a device private key appears in the log");
    assert.ok(!text.includes("BEGIN PRIVATE KEY"), "PEM private key material appears in the log");
    assert.ok(
      !text.includes(attempt.response.signed_identity.certificate),
      "the signed identity appears in the log",
    );
    // Correlation identifiers are present, which is what the logs are for.
    assert.ok(text.includes(identity.connectorId), "the connector ID is not logged as a correlation field");
  });
});
