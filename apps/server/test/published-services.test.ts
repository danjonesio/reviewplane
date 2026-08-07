/**
 * Component layer (`docs/TESTING.md` section 2): the published-service
 * endpoints against a real database.
 *
 * A real database is the point. The migrations, the constraints and the
 * per-project event sequence are where several of this module's invariants
 * actually live, and none of them is exercised by a fake repository.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { verifyCapability } from "@reviewplane/protocol";
import type { CapabilityKeyring } from "@reviewplane/protocol";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.ts";
import type { BuiltApp } from "../src/app.ts";
import type { ServerConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { createPool } from "../src/db/pool.ts";
import type { Pool } from "../src/db/pool.ts";
import type {
  GatewayRegisterRequest,
  GatewayRouteView,
  TunnelGateway,
} from "../src/modules/published-services/gateway-client.ts";
import { StubRoutePublisher } from "../src/modules/published-services/service.ts";
import type { PublishedServiceService } from "../src/modules/published-services/service.ts";
import { testServerConfig } from "./support/config.ts";
import { claimSessionFor } from "./support/identity.ts";
import type { SessionCookies } from "./support/identity.ts";
import { startPostgres } from "./support/postgres.ts";
import type { TestDatabase } from "./support/postgres.ts";

const BOOTSTRAP_TOKEN = "test-bootstrap-token-0123456789abcdef";

/**
 * The projects this suite acts in.
 *
 * They are real `projects` rows in a real organisation, because the endpoints
 * resolve the project inside the caller's scope before anything else happens
 * (`docs/API.md` §5). A synthetic identifier that named no row used to reach
 * the service layer, which is exactly how the scope defect this suite now
 * covers stayed invisible.
 */
const PROJECTS = [
  "prj_test_01",
  "prj_gateway_refusal",
  "prj_mint_01",
  "prj_mint_02",
  "prj_mint_03",
  "prj_revoke_01",
  "prj_revoke_02",
  "prj_expiry_01",
  "prj_listing_a",
  "prj_listing_b",
  "prj_limit_01",
  "prj_audit_01",
  "prj_sequence_01",
] as const;

/** The organisation everything above belongs to. */
const ORGANISATION_ID = "org_publication_home";
/** A second organisation, so that "another organisation" is a real place. */
const OTHER_ORGANISATION_ID = "org_publication_foreign";
const OTHER_PROJECT_ID = "prj_foreign_01";

/** The rows a project must own before a route can name them. */
interface ProjectFixtures {
  readonly connectorId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
}
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
      organisation_id: request.organisation_id,
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
  let built: BuiltApp;
  let service: PublishedServiceService;
  /** A real cookie session in ORGANISATION_ID, for the CSRF and scope tests. */
  let session: SessionCookies;
  let home: ProjectFixtures;
  let foreign: ProjectFixtures;
  const fixtures = new Map<string, ProjectFixtures>();
  let gateway: RecordingGateway;
  let now = new Date("2026-07-30T12:00:00.000Z");

  before(async () => {
    postgres = await startPostgres();
    pool = createPool(postgres.url);
    await migrate(pool);
    await seedOrganisation(ORGANISATION_ID, "publication-home", PROJECTS);
    await seedOrganisation(OTHER_ORGANISATION_ID, "publication-foreign", [OTHER_PROJECT_ID]);
    // Every project gets its own connector, workspace and browser session,
    // because publication now resolves all three inside the caller's
    // organisation and project rather than writing whatever the body named.
    for (const [index, projectId] of PROJECTS.entries()) {
      fixtures.set(
        projectId,
        await seedProjectFixtures(ORGANISATION_ID, projectId, `home${String(index)}`),
      );
    }
    home = fixtures.get("prj_test_01") as ProjectFixtures;
    foreign = await seedProjectFixtures(OTHER_ORGANISATION_ID, OTHER_PROJECT_ID, "foreign");
    fixtures.set(OTHER_PROJECT_ID, foreign);
    gateway = new RecordingGateway();
    built = await buildApp({
      config: testConfig(postgres.url),
      pool,
      gateway,
      // The connector exchange has its own integration test against the real
      // Go binary (test/route-publication.test.ts). This file is about the
      // control plane's own rules, so the connector half is stubbed.
      publisher: new StubRoutePublisher(),
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
    session = await claimSessionFor(built, pool, ORGANISATION_ID, {
      email: "publisher@localhost",
    });
  });

  after(async () => {
    await app.close();
    await pool.end();
    await postgres.stop();
  });

  /**
   * A connector, a workspace and a browser session an organisation owns.
   *
   * The cross-organisation tests need real rows to point at: an identifier that
   * matches nothing is refused by any implementation, and it is the *foreign*
   * identifier that has to be refused identically.
   */
  async function seedProjectFixtures(
    organisationId: string,
    projectId: string,
    suffix: string,
  ): Promise<ProjectFixtures> {
    const environmentId = `env_${suffix}`;
    const connectorId = `con_${suffix}`;
    const workspaceId = `wsp_${suffix}`;
    const sessionId = `brs_${suffix}`;
    await pool.query(
      `INSERT INTO environments (id, organisation_id, project_id, name, platform, architecture)
       VALUES ($1, $2, $3, $4, 'linux', 'amd64')`,
      [environmentId, organisationId, projectId, `env-${suffix}`],
    );
    await pool.query(
      `INSERT INTO connectors (
         id, organisation_id, environment_id, project_id, certificate_fingerprint,
         certificate_serial, certificate_not_after, public_key, version, status)
       VALUES ($1, $2, $3, $4, $5, '01', now() + interval '30 days', 'key', '0.1.0', 'ACTIVE')`,
      [connectorId, organisationId, environmentId, projectId, `sha256:${suffix}`],
    );
    await pool.query(
      `INSERT INTO workspaces (
         id, organisation_id, project_id, environment_id, root_path, branch, head_commit,
         path_hash, display_path, source)
       VALUES ($1, $2, $3, $4, $5, 'main', 'abcdef1', $6, $7, 'connector_report')`,
      [
        workspaceId,
        organisationId,
        projectId,
        environmentId,
        `/srv/${suffix}`,
        // The column requires a real digest shape; the value only has to be
        // stable and distinct per fixture.
        `sha256:${createHash("sha256").update(suffix).digest("hex")}`,
        suffix,
      ],
    );
    await pool.query(
      `INSERT INTO browser_sessions (
         id, organisation_id, project_id, status, viewport, limits, retention_policy)
       VALUES ($1, $2, $3, 'REQUESTED', $4, '{}'::jsonb, 'verification_evidence')`,
      [
        sessionId,
        organisationId,
        projectId,
        JSON.stringify({ width: 1440, height: 900, device_scale_factor: 1 }),
      ],
    );
    return { connectorId, workspaceId, sessionId };
  }

  async function seedOrganisation(
    organisationId: string,
    slug: string,
    projectIds: readonly string[],
  ): Promise<void> {
    await pool.query("INSERT INTO organisations (id, name, slug) VALUES ($1, $2, $3)", [
      organisationId,
      slug,
      slug,
    ]);
    for (const projectId of projectIds) {
      await pool.query(
        "INSERT INTO projects (id, organisation_id, name, slug) VALUES ($1, $2, $3, $4)",
        [projectId, organisationId, projectId, projectId.replaceAll("_", "-")],
      );
    }
  }

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

  /**
   * A publication body naming the project's own connector, workspace and
   * browser session.
   *
   * It used to name `con_test_01`, `wsp_test_01` and `brs_test_01`, which
   * existed in no table at all — and the endpoint accepted them, which is the
   * defect this file now covers. A body whose identifiers are real is the only
   * kind that can exercise the happy path.
   */
  function createBody(projectId = "prj_test_01", overrides: Record<string, unknown> = {}) {
    const own = fixtures.get(projectId);
    return {
      connector_id: own?.connectorId ?? "con_unseeded",
      workspace_id: own?.workspaceId ?? "wsp_unseeded",
      local_host: "127.0.0.1",
      local_port: 5173,
      protocol: "http",
      ttl_seconds: 3600,
      allowed_browser_session_ids: [own?.sessionId ?? "brs_unseeded"],
      ...overrides,
    };
  }

  async function createService(projectId = "prj_test_01", overrides: Record<string, unknown> = {}) {
    const response = await request(
      "POST",
      `/api/v1/projects/${projectId}/published-services`,
      createBody(projectId, overrides),
    );
    assert.equal(response.statusCode, 201, response.body);
    return JSON.parse(response.body).data as Record<string, string>;
  }

  /** The browser session the project's routes authorise. */
  function sessionOf(projectId: string): string {
    return (fixtures.get(projectId) as ProjectFixtures).sessionId;
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
    assert.deepEqual(registered.allowed_browser_session_ids, [sessionOf("prj_test_01")]);
    // The gateway is told the route's tenancy, taken from the record rather
    // than from the request: it is what an organisation-scoped control
    // credential is held to on that surface, and a route registered without one
    // would sit outside every scope (ADR-0038). It is the organisation and not
    // the project, which the two identifiers being distinct here proves.
    assert.equal(registered.organisation_id, ORGANISATION_ID);
    assert.notEqual(registered.organisation_id, registered.project_id);

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
        createBody("prj_test_01", { local_host: host, local_port: port }),
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
      createBody("prj_test_01", { allowed_browser_session_ids: [] }),
    );
    assert.equal(response.statusCode, 422);
    assert.equal(JSON.parse(response.body).error.code, "VALIDATION_FAILED");
  });

  test("a route lifetime beyond the maximum is refused", async () => {
    const response = await request(
      "POST",
      "/api/v1/projects/prj_test_01/published-services",
      createBody("prj_test_01", { ttl_seconds: 9 * 60 * 60 }),
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
        createBody("prj_gateway_refusal"),
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
    const project = "prj_mint_01";
    const created = await createService(project);
    const response = await request(
      "POST",
      `/api/v1/published-services/${String(created["id"])}/capabilities`,
      { browser_session_id: sessionOf(project) },
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
    assert.equal(claims.projectId, project);
    assert.equal(claims.browserSessionId, sessionOf(project));
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
    const project = "prj_mint_02";
    const created = await createService(project);
    const response = await request(
      "POST",
      `/api/v1/published-services/${String(created["id"])}/capabilities`,
      { browser_session_id: "brs_someone_else" },
    );
    assert.equal(response.statusCode, 403);
    assert.equal(JSON.parse(response.body).error.code, "AUTHORISATION_DENIED");
  });

  test("a capability never outlives its route", async () => {
    const project = "prj_mint_03";
    const created = await createService(project, { ttl_seconds: 60 });
    const response = await request(
      "POST",
      `/api/v1/published-services/${String(created["id"])}/capabilities`,
      { browser_session_id: sessionOf(project), ttl_seconds: 300 },
    );
    assert.equal(response.statusCode, 201, response.body);
    const minted = JSON.parse(response.body).data as Record<string, string>;
    assert.equal(minted["expires_at"], created["expires_at"]);
  });

  test("revocation ends the route, withdraws its capabilities and is audited", async () => {
    const project = "prj_revoke_01";
    const created = await createService(project);
    const mintResponse = await request(
      "POST",
      `/api/v1/published-services/${String(created["id"])}/capabilities`,
      { browser_session_id: sessionOf(project) },
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
    const connector = (fixtures.get(project) as ProjectFixtures).connectorId;
    for (let index = 0; index < 10; index += 1) {
      const response = await request(
        "POST",
        `/api/v1/projects/${project}/published-services`,
        createBody(project, { connector_id: connector }),
      );
      assert.equal(response.statusCode, 201, `route ${String(index)}: ${response.body}`);
    }
    const eleventh = await request(
      "POST",
      `/api/v1/projects/${project}/published-services`,
      createBody(project, { connector_id: connector }),
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
        const response = await request(method, url, createBody("prj_test_01"), token);
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
    const project = "prj_audit_01";
    const created = await createService(project);
    const mintResponse = await request(
      "POST",
      `/api/v1/published-services/${String(created["id"])}/capabilities`,
      { browser_session_id: sessionOf(project) },
    );
    const minted = JSON.parse(mintResponse.body).data as Record<string, string>;
    const events = await pool.query<{ payload: unknown }>(
      `SELECT payload FROM events WHERE project_id = 'prj_audit_01'`,
    );
    const encoded = JSON.stringify(events.rows);
    assert.ok(!encoded.includes(minted["capability"] as string), "an event carries the capability");
    assert.ok(encoded.includes(minted["capability_id"] as string), "no event names the capability");
  });


  // ---------------------------------------------------------------------
  // Authorisation. Publication opens a tunnel from a central browser into a
  // development machine, and minting hands out the bearer credential for it.
  // These are the two shapes that must not be forgeable and must not cross an
  // organisation boundary.
  // ---------------------------------------------------------------------

  /**
   * A body that is not JSON at all.
   *
   * This constant used to be `{ connector_id: 42, local_port: "not a port" }`,
   * which is valid JSON that fails validation — so the test proved refusal
   * before *validation*, which was true, while the comment beside it and two
   * normative documents claimed refusal before *decode*, which was not.
   * Fastify's order is `onRequest` → `preParsing` → parsing → `preValidation`
   * → validation → `preHandler`, and the guard was a `preHandler`. Truncated
   * JSON is what tells the two apart: only a guard that runs before the parser
   * can answer it, and a `preHandler` guard never sees it at all.
   */
  const UNPARSEABLE_BODY = '{"connector_id": ';

  test("a cookie session must present its CSRF token, and is refused before the body is read", async () => {
    for (const [method, url] of [
      ["POST", `/api/v1/projects/prj_test_01/published-services`],
      ["DELETE", `/api/v1/published-services/svc_anything`],
      ["POST", `/api/v1/published-services/svc_anything/capabilities`],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: { ...session.readHeaders, "content-type": "application/json" },
        payload: UNPARSEABLE_BODY,
      });
      // The body could not be parsed, so a refusal that named it would be a
      // refusal that had read it. This one names the missing CSRF token.
      assert.equal(response.statusCode, 403, `${method} ${url}: ${response.body}`);
      const body = JSON.parse(response.body);
      assert.equal(body.error.code, "AUTHORISATION_DENIED");
      assert.equal(body.error.details.reason, "csrf_token_invalid");
    }
  });

  test("a malformed body from an authorised caller is a client error, not a server one", async () => {
    // The other half of the same defect: a body the parser rejects used to
    // reach the error hook as an unhandled failure and be answered
    // `500 INTERNAL_ERROR`, which points an operator at the server for a
    // request the client malformed.
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/prj_test_01/published-services",
      headers: { ...session.writeHeaders, "content-type": "application/json" },
      payload: UNPARSEABLE_BODY,
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(JSON.parse(response.body).error.code, "VALIDATION_FAILED");
  });

  test("a cookie session carrying its CSRF token may publish and revoke", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects/prj_test_01/published-services",
      headers: session.writeHeaders,
      payload: createBody("prj_test_01"),
    });
    assert.equal(created.statusCode, 201, created.body);
    const record = JSON.parse(created.body).data as Record<string, string>;
    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/v1/published-services/${String(record["id"])}`,
      headers: session.writeHeaders,
    });
    assert.equal(revoked.statusCode, 200, revoked.body);
  });

  /** Replaces the request identifier, which is the only per-request member. */
  function normalise(body: string): unknown {
    const parsed = JSON.parse(body) as { meta?: { request_id?: string } };
    if (parsed.meta !== undefined) parsed.meta.request_id = "req_normalised";
    return parsed;
  }

  test("a route in another organisation answers byte-identically to one that does not exist", async () => {
    // The foreign route is real: created through the bootstrap operator, which
    // belongs to no organisation and may therefore reach both.
    const foreignRoute = await createService(OTHER_PROJECT_ID);

    for (const [method, url] of [
      ["DELETE", (id: string) => `/api/v1/published-services/${id}`],
      ["POST", (id: string) => `/api/v1/published-services/${id}/capabilities`],
    ] as const) {
      const onForeign = await app.inject({
        method,
        url: url(String(foreignRoute["id"])),
        headers: session.writeHeaders,
        payload: { browser_session_id: sessionOf(OTHER_PROJECT_ID) },
      });
      const onUnknown = await app.inject({
        method,
        url: url("svc_does_not_exist_at_all"),
        headers: session.writeHeaders,
        payload: { browser_session_id: sessionOf(OTHER_PROJECT_ID) },
      });
      assert.equal(onForeign.statusCode, 404, onForeign.body);
      assert.equal(onUnknown.statusCode, 404, onUnknown.body);
      assert.deepEqual(normalise(onForeign.body), normalise(onUnknown.body));
    }

    // The foreign route is untouched: the refusal was a refusal, not a
    // revocation that happened to report an error.
    const after = await pool.query<{ status: string }>(
      "SELECT status FROM published_services WHERE id = $1",
      [foreignRoute["id"]],
    );
    assert.equal(after.rows[0]?.status, "ready");
  });

  test("a project in another organisation answers byte-identically to one that does not exist", async () => {
    for (const method of ["GET", "POST"] as const) {
      const onForeign = await app.inject({
        method,
        url: `/api/v1/projects/${OTHER_PROJECT_ID}/published-services`,
        headers: method === "GET" ? session.readHeaders : session.writeHeaders,
        payload: createBody("prj_test_01"),
      });
      const onUnknown = await app.inject({
        method,
        url: "/api/v1/projects/prj_does_not_exist_at_all/published-services",
        headers: method === "GET" ? session.readHeaders : session.writeHeaders,
        payload: createBody("prj_test_01"),
      });
      assert.equal(onForeign.statusCode, 404, onForeign.body);
      assert.deepEqual(normalise(onForeign.body), normalise(onUnknown.body));
    }
    // Nothing was written for the foreign project.
    const rows = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM published_services WHERE project_id = $1 AND status = 'requested'",
      [OTHER_PROJECT_ID],
    );
    assert.equal(rows.rows[0]?.count, "0");
  });

  test("a machine credential reaches none of these routes", async () => {
    for (const [method, url] of [
      ["GET", "/api/v1/projects/prj_test_01/published-services"],
      ["POST", "/api/v1/projects/prj_test_01/published-services"],
      ["DELETE", "/api/v1/published-services/svc_anything"],
      ["POST", "/api/v1/published-services/svc_anything/capabilities"],
    ] as const) {
      const response = await request(method, url, createBody("prj_test_01"), "rpa_agent_credential_value");
      assert.equal(response.statusCode, 403, `${method} ${url}: ${response.body}`);
      assert.equal(JSON.parse(response.body).error.code, "AUTHORISATION_DENIED");
    }
  });


  // ---------------------------------------------------------------------
  // Two-phase publication (ADR-0021). A connector dials the control plane, so
  // only the process holding its channel can finish a route; anything else
  // leaves one `requested` and this is what picks it up.
  // ---------------------------------------------------------------------

  test("a route another process requested is finished by the completion sweep", async () => {
    const requested = await service.request(
      {
        projectId: "prj_test_01",
        organisationId: ORGANISATION_ID,
        connectorId: home.connectorId,
        workspaceId: home.workspaceId,
        localHost: "127.0.0.1",
        localPort: 5173,
        protocol: "http",
        ttlSeconds: 600,
        allowedBrowserSessionIds: [home.sessionId],
      },
      { type: "agent_session", id: "ags_sweep" },
      "req_sweep",
    );
    // Phase one touched nothing outside the database: no gateway registration
    // and no connector exchange happened for this route.
    assert.equal(requested.status, "requested");
    assert.ok(!gateway.registered.some((entry) => entry.route_id === requested.id));
    assert.deepEqual(await eventTypes(requested.id), ["published_service.requested"]);

    // The grace is what keeps the sweep off a route the API is publishing right
    // now; zero means "take everything", which is what a test wants.
    const finished = await service.completePending({ olderThanMs: 0 });
    assert.ok(
      finished.some((entry) => entry.id === requested.id && entry.status === "ready"),
      `the sweep did not finish the route: ${JSON.stringify(finished)}`,
    );
    assert.ok(gateway.registered.some((entry) => entry.route_id === requested.id));
    assert.deepEqual(await eventTypes(requested.id), [
      "published_service.requested",
      "published_service.ready",
    ]);

    // A second sweep finds nothing: the record has left `requested`, and
    // completing it twice would open a second route for one request.
    const registrations = gateway.registered.length;
    assert.deepEqual(await service.completePending({ olderThanMs: 0 }), []);
    assert.equal(gateway.registered.length, registrations);
  });

  test("a refusal the failure vocabulary does not name is recorded as INTERNAL_ERROR", async () => {
    // `published_service_failure_class` in `packages/protocol` is closed, so a
    // code outside it would produce an event no consumer can decode. The caller
    // still receives the original error; only the record is narrowed.
    const { ApiError } = await import("../src/errors.ts");
    const requested = await service.request(
      {
        projectId: "prj_test_01",
        organisationId: ORGANISATION_ID,
        connectorId: home.connectorId,
        workspaceId: home.workspaceId,
        localHost: "127.0.0.1",
        localPort: 5173,
        protocol: "http",
        ttlSeconds: 600,
        allowedBrowserSessionIds: [home.sessionId],
      },
      { type: "system" },
      "req_sweep_2",
    );
    gateway.refuseWith = new ApiError("RATE_LIMITED", "not a publication failure class");
    try {
      await assert.rejects(() => service.complete(requested.id, { type: "system" }, "req_sweep_2"));
    } finally {
      gateway.refuseWith = null;
    }
    const row = await pool.query<{ status: string; failure_class: string }>(
      "SELECT status, failure_class FROM published_services WHERE id = $1",
      [requested.id],
    );
    assert.equal(row.rows[0]?.status, "failed");
    assert.equal(row.rows[0]?.failure_class, "INTERNAL_ERROR");
  });


  // ---------------------------------------------------------------------
  // Every identifier in the body is resolved inside the caller's scope. The
  // project was the only one that ever was; these are the other three.
  // ---------------------------------------------------------------------

  test("another organisation's connector cannot be named, and its route limit is untouched", async () => {
    // The reported denial of service: ten publications naming the victim's
    // connector filled its limit, the rows were invisible to the victim because
    // the listing is project scoped, and the victim's own publication was then
    // refused ROUTE_LIMIT_EXCEEDED.
    const attempts = [];
    for (let index = 0; index < 12; index += 1) {
      attempts.push(
        await app.inject({
          method: "POST",
          url: "/api/v1/projects/prj_test_01/published-services",
          headers: session.writeHeaders,
          payload: createBody("prj_test_01", {
            connector_id: foreign.connectorId,
            workspace_id: home.workspaceId,
            allowed_browser_session_ids: [home.sessionId],
          }),
        }),
      );
    }
    for (const attempt of attempts) {
      assert.equal(attempt.statusCode, 404, attempt.body);
      assert.equal(JSON.parse(attempt.body).error.code, "RESOURCE_NOT_FOUND");
    }

    // A connector that exists nowhere answers identically, so the refusal
    // cannot be used to discover which connectors exist.
    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/projects/prj_test_01/published-services",
      headers: session.writeHeaders,
      payload: createBody("prj_test_01", {
        connector_id: "con_does_not_exist_at_all",
        workspace_id: home.workspaceId,
        allowed_browser_session_ids: [home.sessionId],
      }),
    });
    assert.deepEqual(normalise(attempts[0]!.body), normalise(unknown.body));

    // The victim's state is unchanged: nothing the attacker's project asked for
    // holds a slot on the victim's connector. The victim's own routes, published
    // earlier in this file, are left out of the count deliberately — they are
    // the rows that are supposed to be there.
    const held = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM published_services
        WHERE connector_id = $1 AND project_id <> $2`,
      [foreign.connectorId, OTHER_PROJECT_ID],
    );
    assert.equal(held.rows[0]?.count, "0");

    const victim = await request(
      "POST",
      `/api/v1/projects/${OTHER_PROJECT_ID}/published-services`,
      createBody(OTHER_PROJECT_ID, {
        connector_id: foreign.connectorId,
        workspace_id: foreign.workspaceId,
        allowed_browser_session_ids: [foreign.sessionId],
      }),
    );
    assert.equal(victim.statusCode, 201, victim.body);
  });

  test("another organisation's browser session cannot be authorised, so no capability can bind it", async () => {
    // The reported capability forgery: publishing with the victim's session
    // identifier in the allow-list, then minting against that same list, which
    // was the only check made. The gateway and the connector both re-check
    // against the record's list, so all three layers agreed with the attacker.
    const published = await app.inject({
      method: "POST",
      url: "/api/v1/projects/prj_test_01/published-services",
      headers: session.writeHeaders,
      payload: createBody("prj_test_01", {
        connector_id: home.connectorId,
        workspace_id: home.workspaceId,
        allowed_browser_session_ids: [foreign.sessionId],
      }),
    });
    assert.equal(published.statusCode, 404, published.body);
    assert.equal(JSON.parse(published.body).error.code, "RESOURCE_NOT_FOUND");

    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/projects/prj_test_01/published-services",
      headers: session.writeHeaders,
      payload: createBody("prj_test_01", {
        connector_id: home.connectorId,
        workspace_id: home.workspaceId,
        allowed_browser_session_ids: ["brs_does_not_exist_at_all"],
      }),
    });
    assert.deepEqual(normalise(published.body), normalise(unknown.body));

    // One reachable session and one foreign one is still refused: the rule is
    // every session, not at least one.
    const mixed = await app.inject({
      method: "POST",
      url: "/api/v1/projects/prj_test_01/published-services",
      headers: session.writeHeaders,
      payload: createBody("prj_test_01", {
        connector_id: home.connectorId,
        workspace_id: home.workspaceId,
        allowed_browser_session_ids: [home.sessionId, foreign.sessionId],
      }),
    });
    assert.equal(mixed.statusCode, 404, mixed.body);

    // No route outside the victim's own project authorises the victim's
    // session, and no capability anywhere binds that session to one.
    const rows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM published_services
        WHERE $1 = ANY(allowed_browser_session_ids) AND project_id <> $2`,
      [foreign.sessionId, OTHER_PROJECT_ID],
    );
    assert.equal(rows.rows[0]?.count, "0");
    const capabilities = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM route_capabilities
        WHERE browser_session_id = $1 AND project_id <> $2`,
      [foreign.sessionId, OTHER_PROJECT_ID],
    );
    assert.equal(capabilities.rows[0]?.count, "0");
  });

  test("another organisation's workspace cannot be named", async () => {
    const foreignWorkspace = await app.inject({
      method: "POST",
      url: "/api/v1/projects/prj_test_01/published-services",
      headers: session.writeHeaders,
      payload: createBody("prj_test_01", {
        connector_id: home.connectorId,
        workspace_id: foreign.workspaceId,
        allowed_browser_session_ids: [home.sessionId],
      }),
    });
    const unknownWorkspace = await app.inject({
      method: "POST",
      url: "/api/v1/projects/prj_test_01/published-services",
      headers: session.writeHeaders,
      payload: createBody("prj_test_01", {
        connector_id: home.connectorId,
        workspace_id: "wsp_does_not_exist_at_all",
        allowed_browser_session_ids: [home.sessionId],
      }),
    });
    assert.equal(foreignWorkspace.statusCode, 404, foreignWorkspace.body);
    assert.equal(JSON.parse(foreignWorkspace.body).error.code, "WORKSPACE_NOT_FOUND");
    assert.deepEqual(normalise(foreignWorkspace.body), normalise(unknownWorkspace.body));
  });

  test("a route that expired while still requested is expired by the sweep", async () => {
    // It was selected by status = 'ready' only, so a publication nothing
    // completed sat in `requested` past its expiry and kept holding a slot
    // against the per-connector limit — which made
    // `docs/DOMAIN_MODEL.md` §10's "nothing may leave a route in it
    // indefinitely" true only while a one-second sweep happened to be running.
    const requested = await service.request(
      {
        projectId: "prj_test_01",
        organisationId: ORGANISATION_ID,
        connectorId: home.connectorId,
        workspaceId: home.workspaceId,
        localHost: "127.0.0.1",
        localPort: 5173,
        protocol: "http",
        ttlSeconds: 60,
        allowedBrowserSessionIds: [home.sessionId],
      },
      { type: "system" },
      "req_stuck",
    );
    assert.equal(requested.status, "requested");

    const before = now;
    now = new Date(before.getTime() + 5 * 60_000);
    try {
      const expired = await service.expireDue();
      assert.ok(
        expired.some((entry) => entry.id === requested.id && entry.status === "expired"),
        `the sweep left the route in requested: ${JSON.stringify(expired)}`,
      );
    } finally {
      now = before;
    }
    // The audit record names the status the record was actually in.
    const events = await pool.query<{ payload: { previous_status: string } }>(
      `SELECT payload FROM events WHERE type = 'published_service.expired'
         AND payload->>'published_service_id' = $1`,
      [requested.id],
    );
    assert.equal(events.rows[0]?.payload.previous_status, "requested");

    // And the slot it held is released: it no longer counts towards the
    // per-connector limit, which is what leaving it in `requested` cost.
    const carried = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM published_services
        WHERE id = $1 AND status IN ('requested', 'ready')`,
      [requested.id],
    );
    assert.equal(carried.rows[0]?.count, "0");
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
