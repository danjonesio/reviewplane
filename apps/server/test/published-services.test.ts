/**
 * Component layer (`docs/TESTING.md` section 2): the published-service
 * endpoints against a real database.
 *
 * A real database is the point. The migrations, the constraints and the
 * per-project event sequence are where several of this module's invariants
 * actually live, and none of them is exercised by a fake repository.
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { verifyCapability } from "@reviewplane/protocol";
import type { CapabilityKeyring } from "@reviewplane/protocol";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.ts";
import type { ServerConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { createPool } from "../src/db/pool.ts";
import type { Pool } from "../src/db/pool.ts";
import type {
  GatewayRegisterRequest,
  GatewayRouteView,
  TunnelGateway,
} from "../src/modules/published-services/gateway-client.ts";
import type { PublishedServiceService } from "../src/modules/published-services/service.ts";
import { testServerConfig } from "./support/config.ts";
import { startPostgres } from "./support/postgres.ts";
import type { TestDatabase } from "./support/postgres.ts";

const BOOTSTRAP_TOKEN = "test-bootstrap-token-0123456789abcdef";
const SIGNING_KEY = new Uint8Array(32).fill(0x11);
const KEY_ID = "stage0-a";

/**
 * A gateway that records what it was told.
 *
 * The gateway's own behaviour is tested exhaustively in
 * `services/tunnel-gateway`; what matters here is that the control plane sends
 * the right instruction, in the right order, and reacts correctly to a refusal.
 */
class RecordingGateway implements TunnelGateway {
  readonly registered: GatewayRegisterRequest[] = [];
  readonly revokedRoutes: string[] = [];
  readonly revokedCapabilities: string[] = [];
  connectorConnected = true;
  refuseWith: Error | null = null;

  register(request: GatewayRegisterRequest): Promise<GatewayRouteView> {
    if (this.refuseWith !== null) return Promise.reject(this.refuseWith);
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
      connector_connected: this.connectorConnected,
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

  revokeCapability(capabilityId: string): Promise<void> {
    this.revokedCapabilities.push(capabilityId);
    return Promise.resolve();
  }
}

function testConfig(databaseUrl: string): ServerConfig {
  return testServerConfig({
    databaseUrl,
    bootstrapToken: BOOTSTRAP_TOKEN,
    capabilityKeyId: KEY_ID,
    capabilityKey: SIGNING_KEY,
  });
}

describe("published-service endpoints", () => {
  let postgres: TestDatabase;
  let pool: Pool;
  let app: FastifyInstance;
  let service: PublishedServiceService;
  let gateway: RecordingGateway;
  let now = new Date("2026-07-30T12:00:00.000Z");

  before(async () => {
    postgres = await startPostgres();
    pool = createPool(postgres.url);
    await migrate(pool);
    gateway = new RecordingGateway();
    const built = await buildApp({
      config: testConfig(postgres.url),
      pool,
      gateway,
      destinationPolicy: {
        // The fixture development server binds to an ephemeral port, so the
        // test policy is wider than the Stage 0 default. Everything the SSRF
        // corpus refuses is still refused.
        allowedHosts: ["127.0.0.1", "::1"],
        allowedPorts: [{ low: 1024, high: 65535 }],
        allowedProtocols: ["http"],
        allowNonLoopback: false,
        allowLinkLocal: false,
      },
      now: () => now,
    });
    app = built.app;
    service = built.publishedServices;
    await app.ready();
  });

  after(async () => {
    await app.close();
    await pool.end();
    await postgres.stop();
  });

  async function request(
    method: string,
    url: string,
    body?: unknown,
    token: string | null = BOOTSTRAP_TOKEN,
  ) {
    return app.inject({
      method: method as "GET",
      url,
      ...(token === null ? {} : { headers: { authorization: `Bearer ${token}` } }),
      ...(body === undefined ? {} : { payload: body as object }),
    });
  }

  function createBody(overrides: Record<string, unknown> = {}) {
    return {
      connector_id: "con_test_01",
      workspace_id: "wsp_test_01",
      local_host: "127.0.0.1",
      local_port: 5173,
      protocol: "http",
      ttl_seconds: 3600,
      allowed_browser_session_ids: ["brs_test_01"],
      ...overrides,
    };
  }

  async function createService(projectId = "prj_test_01", overrides: Record<string, unknown> = {}) {
    const response = await request(
      "POST",
      `/api/v1/projects/${projectId}/published-services`,
      createBody(overrides),
    );
    assert.equal(response.statusCode, 201, response.body);
    return JSON.parse(response.body).data as Record<string, string>;
  }

  async function eventTypes(publishedServiceId: string): Promise<string[]> {
    const result = await pool.query<{ type: string }>(
      `SELECT type FROM events
        WHERE payload->>'published_service_id' = $1
        ORDER BY sequence`,
      [publishedServiceId],
    );
    return result.rows.map((row) => row.type);
  }

  test("a published service is created and matches the domain model", async () => {
    const created = await createService();
    // `docs/DOMAIN_MODEL.md` section 10 field list.
    for (const field of [
      "id",
      "project_id",
      "connector_id",
      "workspace_id",
      "local_host",
      "local_port",
      "protocol",
      "public_alias",
      "scope",
      "expires_at",
      "status",
    ]) {
      assert.ok(field in created, `the record has no ${field}`);
    }
    assert.equal(created["status"], "ready");
    assert.equal(created["scope"], "browser_session");
    assert.equal(created["observed_destination"], "127.0.0.1:5173");
    assert.equal(
      created["internal_origin"],
      `https://${String(created["public_alias"])}.internal.invalid/`,
    );
    assert.equal(created["expires_at"], "2026-07-30T13:00:00.000Z");

    const registered = gateway.registered.at(-1);
    assert.ok(registered !== undefined);
    assert.equal(registered.route_id, created["id"]);
    assert.equal(registered.public_alias, created["public_alias"]);
    assert.deepEqual(registered.allowed_browser_session_ids, ["brs_test_01"]);

    assert.deepEqual(await eventTypes(String(created["id"])), [
      "published_service.requested",
      "published_service.ready",
    ]);
  });

  test("the public alias is a DNS label and never the route identifier", async () => {
    // The alias is the leftmost label of the internal origin, and a route
    // identifier conventionally carries an underscore.
    const created = await createService();
    assert.match(String(created["public_alias"]), /^[a-z0-9][a-z0-9-]{0,62}$/u);
    assert.notEqual(created["public_alias"], created["id"]);
  });

  test("a link-local or metadata destination is refused at publication", async () => {
    for (const [host, port] of [
      ["169.254.169.254", 80],
      ["169.254.10.1", 3000],
      ["10.0.0.5", 3000],
      ["0.0.0.0", 3000],
      ["localhost", 5173],
    ] as const) {
      const response = await request(
        "POST",
        "/api/v1/projects/prj_test_01/published-services",
        createBody({ local_host: host, local_port: port }),
      );
      assert.equal(response.statusCode, 422, `${host} was accepted`);
      const body = JSON.parse(response.body);
      assert.equal(body.error.code, "DESTINATION_NOT_ALLOWED", `${host}: ${response.body}`);
    }
  });

  test("a route with no authorised browser session is not published", async () => {
    const response = await request(
      "POST",
      "/api/v1/projects/prj_test_01/published-services",
      createBody({ allowed_browser_session_ids: [] }),
    );
    assert.equal(response.statusCode, 422);
    assert.equal(JSON.parse(response.body).error.code, "VALIDATION_FAILED");
  });

  test("a route lifetime beyond the maximum is refused", async () => {
    const response = await request(
      "POST",
      "/api/v1/projects/prj_test_01/published-services",
      createBody({ ttl_seconds: 9 * 60 * 60 }),
    );
    assert.equal(response.statusCode, 422);
    assert.equal(JSON.parse(response.body).error.code, "ROUTE_EXPIRED");
  });

  test("a gateway refusal marks the record failed and is audited", async () => {
    const { ApiError } = await import("../src/errors.ts");
    gateway.refuseWith = new ApiError("DESTINATION_NOT_ALLOWED", "refused by the gateway");
    try {
      const response = await request(
        "POST",
        "/api/v1/projects/prj_gateway_refusal/published-services",
        createBody(),
      );
      assert.equal(response.statusCode, 422);
      assert.equal(JSON.parse(response.body).error.code, "DESTINATION_NOT_ALLOWED");
    } finally {
      gateway.refuseWith = null;
    }
    const failed = await pool.query<{ id: string; status: string; failure_class: string }>(
      `SELECT id, status, failure_class FROM published_services WHERE project_id = 'prj_gateway_refusal'`,
    );
    assert.equal(failed.rows.length, 1);
    assert.equal(failed.rows[0]?.status, "failed");
    assert.equal(failed.rows[0]?.failure_class, "DESTINATION_NOT_ALLOWED");
    assert.deepEqual(await eventTypes(String(failed.rows[0]?.id)), [
      "published_service.requested",
      "published_service.failed",
    ]);
  });

  test("a capability is minted, bound to the route, project and session", async () => {
    const created = await createService("prj_mint_01");
    const response = await request(
      "POST",
      `/api/v1/published-services/${String(created["id"])}/capabilities`,
      { browser_session_id: "brs_test_01" },
    );
    assert.equal(response.statusCode, 201, response.body);
    const minted = JSON.parse(response.body).data as Record<string, string>;

    const keyring: CapabilityKeyring = new Map([[KEY_ID, SIGNING_KEY]]);
    const claims = verifyCapability(
      keyring,
      minted["capability"] as string,
      Math.floor(now.getTime() / 1000),
    );
    assert.equal(claims.routeId, created["id"]);
    assert.equal(claims.projectId, "prj_mint_01");
    assert.equal(claims.browserSessionId, "brs_test_01");
    assert.equal(claims.capabilityId, minted["capability_id"]);
    assert.equal(minted["internal_origin"], created["internal_origin"]);

    // The token is never persisted: a row holding the bearer credential would
    // turn a database read into a route grant.
    const stored = await pool.query<{ id: string }>(
      `SELECT id FROM route_capabilities WHERE id = $1`,
      [minted["capability_id"]],
    );
    assert.equal(stored.rows.length, 1);
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'route_capabilities'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    assert.ok(!names.includes("capability"), "the capability token is stored");
    assert.ok(!names.includes("token"), "the capability token is stored");
  });

  test("a capability cannot be minted for a session the route does not authorise", async () => {
    const created = await createService("prj_mint_02");
    const response = await request(
      "POST",
      `/api/v1/published-services/${String(created["id"])}/capabilities`,
      { browser_session_id: "brs_someone_else" },
    );
    assert.equal(response.statusCode, 403);
    assert.equal(JSON.parse(response.body).error.code, "AUTHORISATION_DENIED");
  });

  test("a capability never outlives its route", async () => {
    const created = await createService("prj_mint_03", { ttl_seconds: 60 });
    const response = await request(
      "POST",
      `/api/v1/published-services/${String(created["id"])}/capabilities`,
      { browser_session_id: "brs_test_01", ttl_seconds: 300 },
    );
    assert.equal(response.statusCode, 201, response.body);
    const minted = JSON.parse(response.body).data as Record<string, string>;
    assert.equal(minted["expires_at"], created["expires_at"]);
  });

  test("revocation ends the route, withdraws its capabilities and is audited", async () => {
    const created = await createService("prj_revoke_01");
    const mintResponse = await request(
      "POST",
      `/api/v1/published-services/${String(created["id"])}/capabilities`,
      { browser_session_id: "brs_test_01" },
    );
    const minted = JSON.parse(mintResponse.body).data as Record<string, string>;

    const response = await request("DELETE", `/api/v1/published-services/${String(created["id"])}`);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(JSON.parse(response.body).data.status, "revoked");

    // The gateway is told before the record changes: marking the record revoked
    // while the gateway still carried the route would make the revocation a lie.
    assert.ok(gateway.revokedRoutes.includes(String(created["id"])));

    const capability = await pool.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM route_capabilities WHERE id = $1`,
      [minted["capability_id"]],
    );
    assert.notEqual(capability.rows[0]?.revoked_at, null);
    assert.ok((await eventTypes(String(created["id"]))).includes("published_service.revoked"));
  });

  test("revoking twice produces one event", async () => {
    const created = await createService("prj_revoke_02");
    await request("DELETE", `/api/v1/published-services/${String(created["id"])}`);
    const second = await request("DELETE", `/api/v1/published-services/${String(created["id"])}`);
    assert.equal(second.statusCode, 200);
    const types = await eventTypes(String(created["id"]));
    assert.equal(types.filter((type) => type === "published_service.revoked").length, 1);
  });

  test("expiry ends due routes and records published_service.expired", async () => {
    const created = await createService("prj_expiry_01", { ttl_seconds: 120 });
    const before = now;
    now = new Date(before.getTime() + 5 * 60_000);
    try {
      const expired = await service.expireDue();
      // Other short-lived routes from earlier tests are due at the same
      // instant; what matters is that this one is among them and that a second
      // sweep finds nothing.
      assert.ok(
        expired.some((entry) => entry.id === created["id"]),
        "the sweep did not expire the route",
      );
      assert.ok(expired.every((entry) => entry.status === "expired"));
      assert.ok(gateway.revokedRoutes.includes(String(created["id"])));
      assert.ok((await eventTypes(String(created["id"]))).includes("published_service.expired"));
      // A second sweep changes nothing.
      assert.equal((await service.expireDue()).length, 0);
    } finally {
      now = before;
    }
  });

  test("the listing is scoped to its project", async () => {
    await createService("prj_listing_a");
    await createService("prj_listing_b");
    const response = await request("GET", "/api/v1/projects/prj_listing_a/published-services");
    assert.equal(response.statusCode, 200);
    const services = JSON.parse(response.body).data as { project_id: string }[];
    assert.ok(services.length >= 1);
    assert.ok(services.every((entry) => entry.project_id === "prj_listing_a"));
  });

  test("the concurrent route limit per connector is enforced", async () => {
    const project = "prj_limit_01";
    const connector = "con_limit_01";
    for (let index = 0; index < 10; index += 1) {
      const response = await request(
        "POST",
        `/api/v1/projects/${project}/published-services`,
        createBody({ connector_id: connector }),
      );
      assert.equal(response.statusCode, 201, `route ${String(index)}: ${response.body}`);
    }
    const eleventh = await request(
      "POST",
      `/api/v1/projects/${project}/published-services`,
      createBody({ connector_id: connector }),
    );
    assert.equal(eleventh.statusCode, 429, eleventh.body);
    assert.equal(JSON.parse(eleventh.body).error.code, "ROUTE_LIMIT_EXCEEDED");
  });

  test("every endpoint requires the administrator token", async () => {
    for (const [method, url] of [
      ["GET", "/api/v1/projects/prj_test_01/published-services"],
      ["POST", "/api/v1/projects/prj_test_01/published-services"],
      ["DELETE", "/api/v1/published-services/svc_anything"],
      ["POST", "/api/v1/published-services/svc_anything/capabilities"],
    ] as const) {
      for (const token of [null, "wrong", BOOTSTRAP_TOKEN.slice(0, 8)]) {
        const response = await request(method, url, createBody(), token);
        assert.equal(response.statusCode, 401, `${method} ${url} with ${String(token)}`);
        assert.equal(JSON.parse(response.body).error.code, "AUTHENTICATION_REQUIRED");
      }
    }
  });

  test("an unknown published service is not found", async () => {
    const response = await request("DELETE", "/api/v1/published-services/svc_does_not_exist");
    assert.equal(response.statusCode, 404);
    assert.equal(JSON.parse(response.body).error.code, "RESOURCE_NOT_FOUND");
  });

  test("no event payload carries a capability value", async () => {
    // `docs/EVENTS.md` section 8 excludes raw secrets, and a capability is a
    // bearer credential.
    const created = await createService("prj_audit_01");
    const mintResponse = await request(
      "POST",
      `/api/v1/published-services/${String(created["id"])}/capabilities`,
      { browser_session_id: "brs_test_01" },
    );
    const minted = JSON.parse(mintResponse.body).data as Record<string, string>;
    const events = await pool.query<{ payload: unknown }>(
      `SELECT payload FROM events WHERE project_id = 'prj_audit_01'`,
    );
    const encoded = JSON.stringify(events.rows);
    assert.ok(!encoded.includes(minted["capability"] as string), "an event carries the capability");
    assert.ok(encoded.includes(minted["capability_id"] as string), "no event names the capability");
  });

  test("the event sequence is monotonic within a project", async () => {
    const project = "prj_sequence_01";
    await createService(project);
    await createService(project);
    const result = await pool.query<{ sequence: string }>(
      `SELECT sequence FROM events WHERE project_id = $1 ORDER BY sequence`,
      [project],
    );
    const sequences = result.rows.map((row) => Number(row.sequence));
    assert.deepEqual(sequences, [1, 2, 3, 4]);
  });
});
