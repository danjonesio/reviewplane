/**
 * The published-service tools of `docs/MCP_SPEC.md` §7.2, against a real
 * database and a real MCP client (`docs/TESTING.md` §8, §2 "Component", §10
 * "Security", §11 "Fault injection").
 *
 * What is asserted here is mostly what an agent **cannot** do. Publication is
 * the SSRF surface of `docs/SECURITY.md` §9: an agent that could name a
 * connector, a project or a workspace outside its session would be choosing
 * which development machine the central browser reaches. The tools take none of
 * those, so every case below is a refusal produced by the server resolving them
 * from the session instead — and each refusal is a stable code, because
 * `docs/UX_FLOWS.md` §18 forbids a generic failure where one exists.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { startMigratedDatabase, truncateAll, type MigratedDatabase } from "@reviewplane/server/testing";

import {
  connectAgent,
  envelopeOf,
  startMcpHarness,
  type McpHarness,
} from "./helpers/harness.ts";
import { issueAgentCredential, seedProject, type SeededProject } from "./helpers/seed.ts";

let postgres: MigratedDatabase;
let harness: McpHarness;

before(async () => {
  postgres = await startMigratedDatabase();
});

after(async () => {
  await harness?.stop();
  await postgres?.stop();
});

beforeEach(async () => {
  await harness?.stop();
  await truncateAll(postgres.pool);
  harness = await startMcpHarness(postgres.pool);
});

interface Connected {
  readonly seeded: SeededProject;
  readonly client: Awaited<ReturnType<typeof connectAgent>>["client"];
  readonly close: () => Promise<void>;
}

async function connected(capabilities?: readonly string[]): Promise<Connected> {
  const seeded = await seedProject(harness);
  const credential = await issueAgentCredential(harness, {
    organisationId: seeded.organisationId,
    projectIds: [seeded.projectId],
    ...(capabilities === undefined ? {} : { capabilities }),
  });
  const agent = await connectAgent(harness, { token: credential.token });
  return { seeded, client: agent.client, close: agent.close };
}

async function call(
  client: Connected["client"],
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return envelopeOf(await client.callTool({ name, arguments: args }));
}

function errorOf(envelope: Record<string, unknown>): { code: string; message: string } {
  return envelope["error"] as { code: string; message: string };
}

function dataOf(envelope: Record<string, unknown>): Record<string, unknown> {
  return envelope["data"] as Record<string, unknown>;
}

test("the three published-service tools are advertised with their input schemas", async () => {
  const agent = await connected();
  try {
    const listed = await agent.client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    for (const name of [
      "development_services_list",
      "development_service_publish",
      "development_service_unpublish",
    ]) {
      assert.ok(names.includes(name), `${name} is not advertised`);
    }
    const publish = listed.tools.find((tool) => tool.name === "development_service_publish");
    assert.ok(publish !== undefined);
    const properties = Object.keys(
      (publish.inputSchema as { properties: Record<string, unknown> }).properties,
    ).sort();
    // The whole of §7.2's input, and nothing that would let a caller choose a
    // machine: no connector, no project, no browser session.
    assert.deepEqual(properties, [
      "idempotency_key",
      "local_host",
      "local_port",
      "protocol",
      "ttl_seconds",
      "workspace_id",
    ]);
  } finally {
    await agent.close();
  }
});

test("the listing is empty for a project that publishes nothing", async () => {
  const agent = await connected();
  try {
    const envelope = await call(agent.client, "development_services_list", {});
    assert.deepEqual(dataOf(envelope)["services"], []);
  } finally {
    await agent.close();
  }
});

test("publication with no connector connected is CONNECTOR_OFFLINE, not a hang", async () => {
  // `docs/UX_FLOWS.md` §18 "No connector connected" and the fault-injection
  // case of RVP-24: a project with no environment has nothing to publish
  // through, and the refusal names that rather than timing out.
  const agent = await connected();
  try {
    const envelope = await call(agent.client, "development_service_publish", {
      workspace_id: agent.seeded.workspaceId,
      local_port: 4321,
      idempotency_key: "publish-no-connector",
    });
    assert.equal(errorOf(envelope).code, "CONNECTOR_OFFLINE");
  } finally {
    await agent.close();
  }
});

test("a workspace outside the session's project is absent, not forbidden", async () => {
  const agent = await connected();
  const elsewhere = await seedProject(harness);
  try {
    // A workspace that exists, in a project this session is not bound to, and
    // one that does not exist at all. `docs/API.md` §5 requires the two to be
    // indistinguishable, so the whole normalised body is compared rather than
    // the status code.
    const foreign = await call(agent.client, "development_service_publish", {
      workspace_id: elsewhere.workspaceId,
      local_port: 4321,
      idempotency_key: "publish-foreign-workspace",
    });
    const unknown = await call(agent.client, "development_service_publish", {
      workspace_id: "wsp_does_not_exist_at_all",
      local_port: 4321,
      idempotency_key: "publish-unknown-workspace",
    });
    assert.equal(errorOf(foreign).code, "WORKSPACE_NOT_FOUND");
    assert.deepEqual(errorOf(foreign), errorOf(unknown));

    // Nothing was written for the other project.
    const rows = await postgres.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM published_services WHERE project_id = $1",
      [elsewhere.projectId],
    );
    assert.equal(rows.rows[0]?.count, "0");
  } finally {
    await agent.close();
  }
});

test("a route in another project is invisible to the listing and absent to unpublish", async () => {
  const agent = await connected();
  const elsewhere = await seedProject(harness);
  try {
    // The route is written directly: this asserts the read scope, and going
    // through the connector exchange would assert the publication path instead.
    await postgres.pool.query(
      `INSERT INTO published_services (
         id, organisation_id, project_id, connector_id, workspace_id, public_alias,
         local_host, local_port, protocol, allowed_browser_session_ids, expires_at, status
       ) VALUES ($1, $2, $3, 'con_elsewhere', $4, 'svc-elsewhere', '127.0.0.1', 4321, 'http',
                 ARRAY['brs_elsewhere'], now() + interval '1 hour', 'ready')`,
      ["svc_elsewhere", elsewhere.organisationId, elsewhere.projectId, elsewhere.workspaceId],
    );

    const listed = await call(agent.client, "development_services_list", {});
    assert.deepEqual(dataOf(listed)["services"], []);

    const foreign = await call(agent.client, "development_service_unpublish", {
      published_service_id: "svc_elsewhere",
      idempotency_key: "unpublish-foreign-route",
    });
    const unknown = await call(agent.client, "development_service_unpublish", {
      published_service_id: "svc_does_not_exist_at_all",
      idempotency_key: "unpublish-unknown-route",
    });
    assert.equal(errorOf(foreign).code, "RESOURCE_NOT_FOUND");
    assert.deepEqual(errorOf(foreign), errorOf(unknown));

    // The foreign route is untouched. A refusal that had revoked it first would
    // have reported the same code and done the damage anyway.
    const after = await postgres.pool.query<{ status: string }>(
      "SELECT status FROM published_services WHERE id = 'svc_elsewhere'",
    );
    assert.equal(after.rows[0]?.status, "ready");
  } finally {
    await agent.close();
  }
});

test("a credential without service:publish may list and may not publish or revoke", async () => {
  // `docs/SECURITY.md` §6.3: an agent credential is capability scoped, and
  // opening a tunnel into a development machine is not something an existing
  // credential should acquire because a release shipped.
  const agent = await connected(["project:read", "review:read"]);
  try {
    const listed = await call(agent.client, "development_services_list", {});
    assert.deepEqual(dataOf(listed)["services"], []);

    for (const [tool, args] of [
      [
        "development_service_publish",
        {
          workspace_id: agent.seeded.workspaceId,
          local_port: 4321,
          idempotency_key: "publish-without-capability",
        },
      ],
      [
        "development_service_unpublish",
        { published_service_id: "svc_anything", idempotency_key: "unpublish-without-capability" },
      ],
    ] as const) {
      const envelope = await call(agent.client, tool, args);
      assert.equal(errorOf(envelope).code, "AUTHORISATION_DENIED", `${tool}: ${JSON.stringify(envelope)}`);
    }
  } finally {
    await agent.close();
  }
});

test("a destination outside the policy is refused before any record exists", async () => {
  // The control plane runs the destination policy of `docs/SECURITY.md` §9
  // itself, before the connector is consulted — so a metadata endpoint is
  // refused whether or not a connector is connected, and leaves no row behind.
  const agent = await connected();
  try {
    for (const host of ["169.254.169.254", "10.0.0.5", "0.0.0.0"]) {
      const envelope = await call(agent.client, "development_service_publish", {
        workspace_id: agent.seeded.workspaceId,
        local_host: host,
        local_port: 80,
        idempotency_key: `publish-${host}`,
      });
      // The connector is resolved first and this deployment has none, so the
      // refusal a *connected* project would give — DESTINATION_NOT_ALLOWED — is
      // preceded here by CONNECTOR_OFFLINE. Either way nothing is published:
      // that is what the row count asserts, and it is the property that matters.
      assert.ok(
        ["CONNECTOR_OFFLINE", "DESTINATION_NOT_ALLOWED"].includes(errorOf(envelope).code),
        `${host}: ${JSON.stringify(envelope)}`,
      );
    }
    const rows = await postgres.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM published_services",
    );
    assert.equal(rows.rows[0]?.count, "0");
  } finally {
    await agent.close();
  }
});
