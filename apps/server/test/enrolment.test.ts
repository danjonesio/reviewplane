/**
 * Component tests for enrolment-token issuance and the registration exchange,
 * against a real PostgreSQL (`docs/TESTING.md` §2).
 *
 * The security cases of `docs/TESTING.md` §10 are here rather than in a
 * separate file, because a reused token and a valid token differ only in the
 * database state that the same handler reads.
 */

import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { migrate } from "../src/db/migrate.ts";
import { BOOTSTRAP_TOKEN, issueEnrolmentToken, startHarness, type Harness } from "./support/harness.ts";
import { enrolOverWebSocket, generateDeviceKey } from "./support/connector-client.ts";

let harness: Harness;

before(async () => {
  harness = await startHarness();
});

after(async () => {
  await harness.stop();
});

describe("migrations", () => {
  test("the runner applies each file once and is idempotent", async () => {
    // The harness already migrated, so a second run must apply nothing.
    const second = await migrate(harness.pool);
    assert.equal(second.applied.length, 0, `re-running applied ${second.applied.join(", ")}`);
    assert.ok(second.alreadyApplied.length >= 3, "the connector migrations should be recorded");

    const recorded = await harness.pool.query<{ filename: string }>(
      "select filename from schema_migrations order by filename",
    );
    assert.deepEqual(
      recorded.rows.map((row) => row.filename),
      [...second.alreadyApplied].sort((left, right) => left.localeCompare(right)),
    );
  });

  test("the tables the connector module needs exist", async () => {
    const result = await harness.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' order by table_name`,
    );
    const tables = new Set(result.rows.map((row) => row.table_name));
    for (const expected of [
      "connector_enrolment_tokens",
      "connector_tls_material",
      "connectors",
      "environments",
      "event_streams",
      "events",
      "organisations",
      "projects",
      "schema_migrations",
    ]) {
      assert.ok(tables.has(expected), `the ${expected} table is missing`);
    }
  });
});

describe("enrolment-token issuance", () => {
  test("requires the bootstrap administrator token", async () => {
    const url = `${harness.apiUrl}/api/v1/connectors/enrolment-tokens`;
    for (const headers of [
      {},
      { authorization: "Bearer " },
      { authorization: "Bearer wrong-token-entirely" },
      { authorization: BOOTSTRAP_TOKEN },
      { authorization: `Bearer ${BOOTSTRAP_TOKEN.slice(0, -1)}` },
      { authorization: `Basic ${Buffer.from(BOOTSTRAP_TOKEN).toString("base64")}` },
    ]) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: "{}",
      });
      assert.equal(response.status, 401, `headers ${JSON.stringify(headers)} were accepted`);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, "AUTHENTICATION_REQUIRED");
    }
  });

  test("issues a single-use expiring token and stores only its hash", async () => {
    const issued = await issueEnrolmentToken(harness, { max_uses: 1, expires_in_seconds: 600 });
    assert.match(issued.token, /^[A-Za-z0-9._~+/=-]{16,256}$/, "the token must satisfy the schema bounds");
    assert.equal(issued.maxUses, 1);
    assert.ok(new Date(issued.expiresAt).getTime() > Date.now());

    const stored = await harness.pool.query<{ token_hash: string; uses: number; max_uses: number }>(
      "select token_hash, uses, max_uses from connector_enrolment_tokens where id = $1",
      [issued.id],
    );
    const row = stored.rows[0];
    assert.ok(row !== undefined);
    assert.notEqual(row.token_hash, issued.token, "the raw token must not be stored");
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);
    assert.equal(row.uses, 0);

    // docs/SECURITY.md section 18: the token must not reach the log.
    assert.ok(!harness.logText().includes(issued.token), "the enrolment token appears in the log output");
    assert.ok(
      harness.logText().includes(issued.id),
      "the token identifier should be logged so that issuance is auditable",
    );
  });

  test("rejects out-of-range and malformed issuance requests", async () => {
    const url = `${harness.apiUrl}/api/v1/connectors/enrolment-tokens`;
    const cases: Record<string, unknown>[] = [
      { max_uses: 0 },
      { max_uses: 1000 },
      { max_uses: 1.5 },
      { expires_in_seconds: 1 },
      { expires_in_seconds: 10_000_000 },
      { environment_labels: "production" },
      { environment_labels: ["Production"] },
      { environment_labels: ["dev", "dev"] },
      { project_id: 42 },
    ];
    for (const body of cases) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 422, `${JSON.stringify(body)} was accepted`);
      const payload = (await response.json()) as { error: { code: string } };
      assert.equal(payload.error.code, "VALIDATION_FAILED");
    }
  });
});

describe("registration exchange", () => {
  test("issues a device identity, records the connector and emits connector.enrolled", async () => {
    const issued = await issueEnrolmentToken(harness, { expires_in_seconds: 600 });
    const device = generateDeviceKey();
    const attempt = await enrolOverWebSocket(harness, issued.token, device, {
      environmentName: "dev-ai-03",
      labels: ["proxmox", "development"],
    });

    assert.ok(attempt.response !== null, `enrolment was refused: ${attempt.closeReason}`);
    const response = attempt.response;
    assert.match(response.connector_id, /^con_[A-Za-z0-9_-]+$/);
    assert.match(response.signed_identity.certificate_fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.match(response.control_plane_endpoints.control_url, /^wss:\/\//);
    assert.match(response.control_plane_endpoints.data_url, /^wss:\/\//);
    assert.match(response.policy_digest, /^sha256:[0-9a-f]{64}$/);

    // The certificate carries the connector's own public key and nothing of its
    // private key: the protocol has no field that could carry one.
    const certificate = new X509Certificate(Buffer.from(response.signed_identity.certificate, "base64"));
    assert.equal(
      certificate.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      device.publicKeyBase64,
    );
    assert.match(certificate.subject, new RegExp(`CN=${response.connector_id}`));

    const connector = await harness.pool.query<{
      status: string;
      certificate_fingerprint: string;
      capabilities: string[];
      version: string;
      public_key: string;
    }>("select status, certificate_fingerprint, capabilities, version, public_key from connectors where id = $1", [
      response.connector_id,
    ]);
    const row = connector.rows[0];
    assert.ok(row !== undefined, "no connector record was created");
    assert.equal(row.status, "PENDING_ENROLMENT");
    assert.equal(row.certificate_fingerprint, response.signed_identity.certificate_fingerprint);
    assert.deepEqual(row.capabilities, ["http-tunnel", "websocket-tunnel"]);
    assert.equal(row.public_key, device.publicKeyBase64);

    const environment = await harness.pool.query<{ name: string; platform: string; labels: string[] }>(
      `select name, platform, labels from environments
        where id = (select environment_id from connectors where id = $1)`,
      [response.connector_id],
    );
    assert.equal(environment.rows[0]?.name, "dev-ai-03");
    assert.deepEqual(environment.rows[0]?.labels, ["proxmox", "development"]);

    const events = await harness.pool.query<{ type: string; actor_type: string; actor_id: string }>(
      "select type, actor_type, actor_id from events where actor_id = $1 order by sequence",
      [response.connector_id],
    );
    assert.equal(events.rows[0]?.type, "connector.enrolled");
    assert.equal(events.rows[0]?.actor_type, "connector");

    // The token is consumed on success.
    const token = await harness.pool.query<{ uses: number; consumed_at: Date | null }>(
      "select uses, consumed_at from connector_enrolment_tokens where id = $1",
      [issued.id],
    );
    assert.equal(token.rows[0]?.uses, 1);
    assert.notEqual(token.rows[0]?.consumed_at, null);

    assert.ok(!harness.logText().includes(issued.token), "the enrolment token appears in the log output");
  });

  test("a reused token is denied with ENROLMENT_TOKEN_INVALID", async () => {
    const issued = await issueEnrolmentToken(harness, { expires_in_seconds: 600 });
    const first = await enrolOverWebSocket(harness, issued.token, generateDeviceKey());
    assert.ok(first.response !== null, "the first enrolment should succeed");

    const second = await enrolOverWebSocket(harness, issued.token, generateDeviceKey());
    assert.equal(second.response, null, "the reused token was accepted");
    assert.equal(second.closeReason, "ENROLMENT_TOKEN_INVALID");
    assert.equal(second.closeCode, 1008);

    const connectors = await harness.pool.query<{ count: string }>(
      "select count(*)::text as count from connectors where enrolment_token_id = $1",
      [issued.id],
    );
    assert.equal(connectors.rows[0]?.count, "1", "the reused token created a second identity");
  });

  test("an expired token is denied with ENROLMENT_TOKEN_INVALID", async () => {
    const issued = await issueEnrolmentToken(harness, { expires_in_seconds: 60 });
    await harness.pool.query(
      "update connector_enrolment_tokens set expires_at = now() - interval '1 second' where id = $1",
      [issued.id],
    );
    const attempt = await enrolOverWebSocket(harness, issued.token, generateDeviceKey());
    assert.equal(attempt.response, null);
    assert.equal(attempt.closeReason, "ENROLMENT_TOKEN_INVALID");
  });

  test("a revoked token is denied with ENROLMENT_TOKEN_INVALID", async () => {
    const issued = await issueEnrolmentToken(harness);
    await harness.pool.query("update connector_enrolment_tokens set revoked_at = now() where id = $1", [
      issued.id,
    ]);
    const attempt = await enrolOverWebSocket(harness, issued.token, generateDeviceKey());
    assert.equal(attempt.closeReason, "ENROLMENT_TOKEN_INVALID");
  });

  test("a token scoped to another organisation is denied with ENROLMENT_TOKEN_INVALID", async () => {
    // Stage 0 is single-organisation, so a token minted elsewhere is out of
    // scope for this control plane.
    const issued = await issueEnrolmentToken(harness);
    await harness.pool.query(
      "insert into organisations (id, name, slug) values ($1, $2, $3) on conflict do nothing",
      ["org_elsewhere", "Another organisation", "org-elsewhere"],
    );
    await harness.pool.query(
      "update connector_enrolment_tokens set organisation_id = $2 where id = $1",
      [issued.id, "org_elsewhere"],
    );
    const attempt = await enrolOverWebSocket(harness, issued.token, generateDeviceKey());
    assert.equal(attempt.response, null, "a token from another organisation was accepted");
    assert.equal(attempt.closeReason, "ENROLMENT_TOKEN_INVALID");
  });

  test("an environment missing the labels the token requires is denied", async () => {
    const issued = await issueEnrolmentToken(harness, { environment_labels: ["proxmox", "development"] });
    const denied = await enrolOverWebSocket(harness, issued.token, generateDeviceKey(), {
      labels: ["proxmox"],
    });
    assert.equal(denied.response, null, "an environment missing a required label was accepted");
    assert.equal(denied.closeReason, "ENROLMENT_TOKEN_INVALID");

    const accepted = await enrolOverWebSocket(harness, issued.token, generateDeviceKey(), {
      labels: ["proxmox", "development", "extra"],
    });
    assert.ok(accepted.response !== null, "a superset of the required labels should be accepted");
  });

  test("a token that was never issued is denied", async () => {
    const attempt = await enrolOverWebSocket(
      harness,
      "a-token-value-that-was-never-issued-at-all",
      generateDeviceKey(),
    );
    assert.equal(attempt.closeReason, "ENROLMENT_TOKEN_INVALID");
  });

  test("a multi-use token is consumed exactly max_uses times", async () => {
    const issued = await issueEnrolmentToken(harness, { max_uses: 2 });
    assert.ok((await enrolOverWebSocket(harness, issued.token, generateDeviceKey())).response !== null);
    assert.ok((await enrolOverWebSocket(harness, issued.token, generateDeviceKey())).response !== null);
    const third = await enrolOverWebSocket(harness, issued.token, generateDeviceKey());
    assert.equal(third.closeReason, "ENROLMENT_TOKEN_INVALID");
  });

  test("malformed and oversized enrolment frames are refused without crashing the listener", async () => {
    const device = generateDeviceKey();
    const cases: { name: string; frame: string | Buffer; expect: string[] }[] = [
      { name: "not json", frame: "this is not json", expect: [""] },
      { name: "truncated", frame: '{"protocol_version":1,"type":"heartbeat"', expect: [""] },
      {
        name: "unknown version",
        frame: JSON.stringify({
          protocol_version: 9,
          message_id: "msg_a",
          type: "connector.registration.request",
          sent_at: "2026-07-28T11:00:00Z",
          payload: {},
        }),
        expect: ["PROTOCOL_UNSUPPORTED"],
      },
      {
        name: "unknown type",
        frame: JSON.stringify({
          protocol_version: 1,
          message_id: "msg_a",
          type: "connector.registration.begin",
          sent_at: "2026-07-28T11:00:00Z",
          payload: {},
        }),
        expect: ["PROTOCOL_UNSUPPORTED"],
      },
      {
        name: "wrong message type for this endpoint",
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
          },
        }),
        expect: ["PROTOCOL_UNSUPPORTED"],
      },
      {
        name: "oversized frame",
        frame: JSON.stringify({
          protocol_version: 1,
          message_id: `msg_${"a".repeat(70_000)}`,
          type: "connector.registration.request",
          sent_at: "2026-07-28T11:00:00Z",
          payload: {},
        }),
        expect: [""],
      },
    ];

    for (const testCase of cases) {
      const attempt = await enrolOverWebSocket(harness, "unused", device, { rawFrame: testCase.frame });
      assert.equal(attempt.response, null, `${testCase.name} was accepted`);
      assert.ok(
        testCase.expect.includes(attempt.closeReason),
        `${testCase.name} closed with ${JSON.stringify(attempt.closeReason)}`,
      );
    }

    // The listener is still serving after all of that.
    const issued = await issueEnrolmentToken(harness);
    const healthy = await enrolOverWebSocket(harness, issued.token, generateDeviceKey());
    assert.ok(healthy.response !== null, "the listener stopped serving after hostile frames");
  });
});

describe("connector credentials are not human credentials", () => {
  // docs/TESTING.md section 10, Isolation: a connector credential must not
  // become a human session.
  test("a connector identity is rejected by the administrative API", async () => {
    const issued = await issueEnrolmentToken(harness);
    const device = generateDeviceKey();
    const attempt = await enrolOverWebSocket(harness, issued.token, device);
    assert.ok(attempt.response !== null);
    const response = attempt.response;

    const presentations = [
      response.connector_id,
      response.signed_identity.certificate,
      response.signed_identity.certificate_fingerprint,
      device.publicKeyBase64,
      issued.token,
    ];
    for (const presented of presentations) {
      for (const path of [
        "/api/v1/connectors",
        "/api/v1/connectors/certificate-authority",
        `/api/v1/connectors/${response.connector_id}`,
      ]) {
        const result = await fetch(`${harness.apiUrl}${path}`, {
          headers: { authorization: `Bearer ${presented}` },
        });
        assert.equal(
          result.status,
          401,
          `${path} accepted a connector credential (${presented.slice(0, 12)}…)`,
        );
      }
    }
  });

  test("the certificate-authority export carries the certificate and never the private key", async () => {
    const response = await fetch(`${harness.apiUrl}/api/v1/connectors/certificate-authority`, {
      headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: Record<string, unknown> };
    const serialised = JSON.stringify(body);
    assert.ok(String(body.data["certificate_pem"]).includes("BEGIN CERTIFICATE"));
    assert.ok(!serialised.includes("BEGIN PRIVATE KEY"), "the CA private key was exported");
    assert.ok(!serialised.includes("BEGIN EC PRIVATE KEY"), "the CA private key was exported");

    const stored = await harness.pool.query<{ private_key_pem: string }>(
      "select private_key_pem from connector_tls_material where purpose = 'certificate_authority'",
    );
    const privateKey = stored.rows[0]?.private_key_pem ?? "";
    assert.ok(privateKey.includes("BEGIN PRIVATE KEY"));
    assert.ok(!harness.logText().includes(privateKey), "the CA private key appears in the log output");
  });
});
