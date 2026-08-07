/**
 * `browser_session_allocate` and the reserve/publish/allocate order
 * (`docs/MCP_SPEC.md` §7.3, `docs/API.md` §11, ADR-0037, RVP-90, RVP-81).
 *
 * The authority this file exists to pin is one sentence: an authenticated agent
 * may admit a browser session **it reserved itself**, in **its own project**, to
 * a route **that project already published** and that **already names that
 * session** — with the control plane, which alone holds the signing key,
 * performing the bind.
 *
 * Every clause of it is a separate test below, and each is written as a refusal
 * rather than as a happy path, because each was reachable before this change or
 * would be reachable again if one term were dropped. The two tenancy refusals
 * compare **whole error bodies** rather than codes: `docs/TESTING.md` §10
 * requires a cross-tenant refusal to be byte-identical to the one an unknown
 * identifier earns, and wording is as much an existence oracle as a status is.
 *
 * These run as a real agent credential through a real MCP client, which is the
 * shape the product actually issues: one organisation and one project, so both
 * tenancy terms in every scoped query are non-null. A suite written as the
 * bootstrap administrator would have `organisationId: null` **and**
 * `projectIds: null`, both terms would go vacuous, and a regression dropping
 * either would ship green.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { startMigratedDatabase, truncateAll, type MigratedDatabase } from "@reviewplane/server/testing";

import { connectAgent, envelopeOf, startMcpHarness, type McpHarness } from "./helpers/harness.ts";
import {
  issueAgentCredential,
  seedConnector,
  seedProject,
  seedSiblingProject,
  setConnectorStatus,
  type SeededProject,
} from "./helpers/seed.ts";

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

async function connected(seeded?: SeededProject): Promise<Connected> {
  const project = seeded ?? (await seedProject(harness));
  const credential = await issueAgentCredential(harness, {
    organisationId: project.organisationId,
    projectIds: [project.projectId],
  });
  const agent = await connectAgent(harness, { token: credential.token });
  return { seeded: project, client: agent.client, close: agent.close };
}

async function call(
  client: Connected["client"],
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return envelopeOf(await client.callTool({ name, arguments: args }));
}

function errorOf(envelope: Record<string, unknown>): {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
} {
  return envelope["error"] as {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

function sessionOf(envelope: Record<string, unknown>): Record<string, unknown> {
  return (envelope["data"] as Record<string, unknown>)["session"] as Record<string, unknown>;
}

let keys = 0;
function key(label: string): string {
  keys += 1;
  return `${label}-${String(keys).padStart(4, "0")}`;
}

/** Reserves a session without allocating it: the first step of the only order. */
async function reserve(agent: Connected): Promise<string> {
  const envelope = await call(agent.client, "browser_session_start", {
    allocate: false,
    idempotency_key: key("reserve"),
  });
  assert.equal(envelope["ok"], true, JSON.stringify(envelope));
  const session = sessionOf(envelope);
  assert.equal(session["status"], "REQUESTED", "allocate:false must not allocate");
  return session["browser_session_id"] as string;
}

/**
 * Publishes a route naming the given sessions, as an administrator.
 *
 * The HTTP surface rather than `development_service_publish`, because the agent
 * tool resolves the sessions it authorises for itself and these tests need to
 * name a **specific** set — including, for the denial cases, one that does not
 * contain the reservation under test.
 */
async function publish(
  seeded: SeededProject,
  connectorId: string,
  sessionIds: readonly string[],
): Promise<string> {
  const response = await harness.control.app.inject({
    method: "POST",
    url: `/api/v1/projects/${seeded.projectId}/published-services`,
    headers: { authorization: `Bearer ${"bootstrap-token-for-mcp-tests"}` },
    payload: {
      connector_id: connectorId,
      workspace_id: seeded.workspaceId,
      local_host: "127.0.0.1",
      local_port: 4321,
      protocol: "http",
      ttl_seconds: 600,
      allowed_browser_session_ids: [...sessionIds],
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  const record = (response.json() as { data: Record<string, string> }).data;
  assert.equal(record["status"], "ready", response.body);
  return record["id"] as string;
}

async function rejections(projectId: string): Promise<Record<string, unknown>[]> {
  const rows = await postgres.pool.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM events WHERE project_id = $1 AND type = 'browser.command_rejected' ORDER BY sequence",
    [projectId],
  );
  return rows.rows.map((row) => row.payload);
}

// ------------------------------------------------------------------ the order

test("reserve, publish, allocate, navigate is the whole agent order and it works", async () => {
  const agent = await connected();
  try {
    const { connectorId } = await seedConnector(harness, agent.seeded);
    const sessionId = await reserve(agent);

    // The route is published *after* the reservation exists, which is the only
    // order that can work: a route names the sessions it authorises when it is
    // published, and the worker's egress policy is fixed when its context is
    // created and cannot be widened afterwards.
    const routeId = await publish(agent.seeded, connectorId, [sessionId]);

    const allocated = await call(agent.client, "browser_session_allocate", {
      browser_session_id: sessionId,
      published_service_id: routeId,
      idempotency_key: key("allocate"),
    });
    assert.equal(allocated["ok"], true, JSON.stringify(allocated));
    const session = sessionOf(allocated);
    assert.equal(session["status"], "READY");
    assert.equal(session["browser_session_id"], sessionId);

    // The bind happened in `api`, not here: this process holds no signing key,
    // and a capability row exists for exactly this pair.
    const bound = await postgres.pool.query<{
      published_service_id: string;
      service_origin: string;
    }>("SELECT published_service_id, service_origin FROM browser_sessions WHERE id = $1", [
      sessionId,
    ]);
    assert.equal(bound.rows[0]?.published_service_id, routeId);
    assert.match(String(bound.rows[0]?.service_origin), /^https:\/\/svc-/u);
    const capabilities = await postgres.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM route_capabilities WHERE browser_session_id = $1 AND published_service_id = $2",
      [sessionId, routeId],
    );
    assert.equal(capabilities.rows[0]?.count, "1");

    // And the session can be driven, which is the point of the whole exercise.
    const navigated = await call(agent.client, "browser_navigate", {
      browser_session_id: sessionId,
      control_epoch: session["control_epoch"],
      url: "/checkout",
    });
    assert.equal(navigated["ok"], true, JSON.stringify(navigated));
  } finally {
    await agent.close();
  }
});

test("a reservation contacts no worker, and allocating without a route needs no handoff", async () => {
  const agent = await connected();
  try {
    const before = harness.commands.length;
    const sessionId = await reserve(agent);
    assert.equal(harness.commands.length, before);

    // No route means nothing to mint, so this process finishes it itself rather
    // than paying a sweep interval for a key it does not need.
    const allocated = await call(agent.client, "browser_session_allocate", {
      browser_session_id: sessionId,
      idempotency_key: key("allocate-no-route"),
    });
    assert.equal(allocated["ok"], true, JSON.stringify(allocated));
    assert.equal(sessionOf(allocated)["status"], "READY");
    const bound = await postgres.pool.query<{ published_service_id: string | null }>(
      "SELECT published_service_id FROM browser_sessions WHERE id = $1",
      [sessionId],
    );
    assert.equal(bound.rows[0]?.published_service_id, null);
  } finally {
    await agent.close();
  }
});

// ------------------------------------------------------------------- denials

test("a route in another project of the same organisation is absent, not forbidden", async () => {
  // The sibling shares this credential's **organisation**, so the organisation
  // term alone would admit it. Only the project term refuses it, which is what
  // makes this test able to see that term being dropped. A case written with two
  // `seedProject` fixtures is also a cross-organisation case and would pass with
  // the project term removed from the query entirely.
  const agent = await connected();
  const elsewhere = await seedSiblingProject(harness, agent.seeded);
  try {
    const { connectorId } = await seedConnector(harness, elsewhere);
    // A real, ready route in a project this credential is not bound to, naming
    // a real session of that project.
    const theirSession = await harness.control.sessions.create({
      organisationId: elsewhere.organisationId,
      projectId: elsewhere.projectId,
      viewport: { width: 1440, height: 900, device_scale_factor: 1 },
      controller: { type: "system", id: "sys_elsewhere" },
      retentionClass: "verification_evidence",
      actor: { type: "system" },
    });
    const theirRoute = await publish(
      { ...agent.seeded, ...elsewhere },
      connectorId,
      [theirSession.id],
    );

    const mine = await reserve(agent);
    const foreign = await call(agent.client, "browser_session_allocate", {
      browser_session_id: mine,
      published_service_id: theirRoute,
      idempotency_key: key("allocate-foreign-route"),
    });
    const unknown = await call(agent.client, "browser_session_allocate", {
      browser_session_id: mine,
      published_service_id: "svc_does_not_exist_at_all",
      idempotency_key: key("allocate-unknown-route"),
    });
    assert.equal(errorOf(foreign).code, "RESOURCE_NOT_FOUND");
    // The whole body, not the code. A message that named the other project's
    // route as "belonging to another project" would be the enumeration oracle
    // `docs/API.md` §5 forbids, and would pass a code-only assertion.
    assert.deepEqual(errorOf(foreign), errorOf(unknown));

    // Nothing was minted, and the reservation is still usable: a refused request
    // has claimed nothing, so an agent that names the right route next can still
    // use the session it reserved.
    const minted = await postgres.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM route_capabilities",
    );
    assert.equal(minted.rows[0]?.count, "0");
    const still = await postgres.pool.query<{ status: string }>(
      "SELECT status FROM browser_sessions WHERE id = $1",
      [mine],
    );
    assert.equal(still.rows[0]?.status, "REQUESTED");
  } finally {
    await agent.close();
  }
});

test("a route in another organisation is refused by the organisation term, not by luck", async () => {
  // This is the case a project-only scope would still refuse — a route in
  // another organisation is also in another project — so it is asserted through
  // the **query** as well as through the answer: the binder's read carries an
  // organisation term that is never constructed as null, and a project
  // identifier implying its organisation is a fact about other code (RVP-91,
  // RVP-92, ADR-0037).
  const agent = await connected();
  const otherOrganisation = await seedProject(harness);
  try {
    assert.notEqual(otherOrganisation.organisationId, agent.seeded.organisationId);
    const { connectorId } = await seedConnector(harness, otherOrganisation);
    const theirSession = await harness.control.sessions.create({
      organisationId: otherOrganisation.organisationId,
      projectId: otherOrganisation.projectId,
      viewport: { width: 1440, height: 900, device_scale_factor: 1 },
      controller: { type: "system", id: "sys_other_org" },
      retentionClass: "verification_evidence",
      actor: { type: "system" },
    });
    const theirRoute = await publish(otherOrganisation, connectorId, [theirSession.id]);

    const mine = await reserve(agent);
    const foreign = await call(agent.client, "browser_session_allocate", {
      browser_session_id: mine,
      published_service_id: theirRoute,
      idempotency_key: key("allocate-foreign-org-route"),
    });
    const unknown = await call(agent.client, "browser_session_allocate", {
      browser_session_id: mine,
      published_service_id: "svc_does_not_exist_at_all",
      idempotency_key: key("allocate-unknown-org-route"),
    });
    assert.equal(errorOf(foreign).code, "RESOURCE_NOT_FOUND");
    assert.deepEqual(errorOf(foreign), errorOf(unknown));

    // The other organisation's route is untouched, and no capability exists for
    // any pair at all.
    const untouched = await postgres.pool.query<{ status: string }>(
      "SELECT status FROM published_services WHERE id = $1",
      [theirRoute],
    );
    assert.equal(untouched.rows[0]?.status, "ready");
    const minted = await postgres.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM route_capabilities",
    );
    assert.equal(minted.rows[0]?.count, "0");
  } finally {
    await agent.close();
  }
});

test("a reservation belonging to another agent session cannot be allocated", async () => {
  const seeded = await seedProject(harness);
  const first = await connected(seeded);
  const second = await connected(seeded);
  try {
    // Same project, same organisation, same credential shape: the only thing
    // that differs is which agent session reserved it.
    const theirs = await reserve(first);
    const refused = await call(second.client, "browser_session_allocate", {
      browser_session_id: theirs,
      idempotency_key: key("allocate-other-agents-reservation"),
    });
    assert.equal(refused["ok"], false, JSON.stringify(refused));
    // AUTHORISATION_DENIED and not RESOURCE_NOT_FOUND, because this caller *is*
    // entitled to know the session exists — it is in their project. The
    // enumeration rule is about tenancy, and this is not a tenancy refusal.
    assert.equal(errorOf(refused).code, "AUTHORISATION_DENIED");

    const untouched = await postgres.pool.query<{ status: string }>(
      "SELECT status FROM browser_sessions WHERE id = $1",
      [theirs],
    );
    assert.equal(untouched.rows[0]?.status, "REQUESTED", "the other agent's reservation moved");
  } finally {
    await second.close();
    await first.close();
  }
});

test("a reservation that is already allocated is refused and is not re-allocated", async () => {
  const agent = await connected();
  try {
    const sessionId = await reserve(agent);
    const first = await call(agent.client, "browser_session_allocate", {
      browser_session_id: sessionId,
      idempotency_key: key("allocate-once"),
    });
    assert.equal(first["ok"], true, JSON.stringify(first));

    const again = await call(agent.client, "browser_session_allocate", {
      browser_session_id: sessionId,
      // A **different** key, so this is a second request rather than a replay.
      idempotency_key: key("allocate-twice"),
    });
    assert.equal(again["ok"], false, JSON.stringify(again));
    assert.equal(errorOf(again).code, "BROWSER_SESSION_NOT_ACTIVE");
    assert.equal(errorOf(again).details?.["browser_session_status"], "READY");

    // One browser, not two. The refusal is the caller's mistake and does not
    // fail the session it named.
    const rows = await postgres.pool.query<{ status: string; n: string }>(
      "SELECT status, count(*)::text AS n FROM browser_sessions WHERE project_id = $1 GROUP BY status",
      [agent.seeded.projectId],
    );
    const ready = rows.rows.find((row) => row.status === "READY");
    assert.equal(ready?.n, "2", "the fixture's session plus this one, and no more");

    // And the refusal is audited as a lifecycle rejection.
    const audited = await rejections(agent.seeded.projectId);
    const allocateRejections = audited.filter((payload) => payload["command"] === "allocate");
    assert.equal(allocateRejections.length, 1);
    assert.equal(allocateRejections[0]?.["kind"], "lifecycle");
    assert.equal(allocateRejections[0]?.["reason_code"], "BROWSER_SESSION_NOT_ACTIVE");
  } finally {
    await agent.close();
  }
});

test("a revoked connector is IDENTITY_REVOKED and a disconnected one is CONNECTOR_OFFLINE", async () => {
  // The two are distinguished on purpose (`docs/CONNECTOR_PROTOCOL.md` §21): a
  // revoked identity will not come back and the route must be published through
  // another connector, while a connector the deployment has and cannot reach is
  // worth waiting for. Answering both with one code sends an operator to the
  // wrong place.
  const agent = await connected();
  try {
    const { connectorId } = await seedConnector(harness, agent.seeded);
    const revokedSession = await reserve(agent);
    const offlineSession = await reserve(agent);
    const route = await publish(agent.seeded, connectorId, [revokedSession, offlineSession]);

    await setConnectorStatus(harness, connectorId, "REVOKED");
    const revoked = await call(agent.client, "browser_session_allocate", {
      browser_session_id: revokedSession,
      published_service_id: route,
      idempotency_key: key("allocate-revoked-connector"),
    });
    assert.equal(errorOf(revoked).code, "IDENTITY_REVOKED");
    assert.equal(errorOf(revoked).details?.["connector_status"], "REVOKED");

    await setConnectorStatus(harness, connectorId, "DISCONNECTED");
    const offline = await call(agent.client, "browser_session_allocate", {
      browser_session_id: offlineSession,
      published_service_id: route,
      idempotency_key: key("allocate-offline-connector"),
    });
    assert.equal(errorOf(offline).code, "CONNECTOR_OFFLINE");
    assert.equal(errorOf(offline).details?.["connector_status"], "DISCONNECTED");

    // Neither produced a capability. The refusal is before the mint, so the
    // gateway never has to refuse a credential the control plane should not
    // have issued.
    const minted = await postgres.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM route_capabilities",
    );
    assert.equal(minted.rows[0]?.count, "0");
  } finally {
    await agent.close();
  }
});

test("a route that does not name the reservation is refused, and no route is amended", async () => {
  const agent = await connected();
  try {
    const { connectorId } = await seedConnector(harness, agent.seeded);
    const named = await reserve(agent);
    const unnamed = await reserve(agent);
    const route = await publish(agent.seeded, connectorId, [named]);

    const refused = await call(agent.client, "browser_session_allocate", {
      browser_session_id: unnamed,
      published_service_id: route,
      idempotency_key: key("allocate-unnamed-session"),
    });
    assert.equal(errorOf(refused).code, "AUTHORISATION_DENIED");
    assert.equal(errorOf(refused).details?.["published_service_id"], route);

    // The allow-list is a control, not a formality: the refusal does not add the
    // session to it. Amending a live route would require re-registering it with
    // the gateway, which would grant reach to a credential that could not have
    // published the route. (Re-registration no longer resurrects capabilities
    // revoked against the identifier — ADR-0038 — and that was never the whole
    // of the reason.)
    const list = await postgres.pool.query<{ allowed_browser_session_ids: string[] }>(
      "SELECT allowed_browser_session_ids FROM published_services WHERE id = $1",
      [route],
    );
    assert.deepEqual(list.rows[0]?.allowed_browser_session_ids, [named]);
  } finally {
    await agent.close();
  }
});

// ------------------------------------------------------ the deprecated member

test("browser_session_start refuses published_service_id, names the replacement, and reserves nothing", async () => {
  const agent = await connected();
  try {
    const before = await postgres.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM browser_sessions WHERE project_id = $1",
      [agent.seeded.projectId],
    );

    const refused = await call(agent.client, "browser_session_start", {
      published_service_id: "svc_anything_at_all",
      idempotency_key: key("start-with-route"),
    });
    assert.equal(refused["ok"], false, JSON.stringify(refused));
    assert.equal(errorOf(refused).code, "VALIDATION_FAILED");
    assert.equal(errorOf(refused).details?.["field"], "published_service_id");
    // The refusal states the condition and the way out (`docs/UX_FLOWS.md` §18),
    // and names the tool that replaces it rather than telling the agent to find
    // a human.
    assert.match(errorOf(refused).message, /browser_session_allocate/u);
    assert.match(errorOf(refused).message, /allocate: false/u);
    assert.match(errorOf(refused).message, /development_service_publish/u);

    // It precedes `create`, so nothing was reserved and no browser slot moved.
    // The predecessor of this refusal reserved a row first and then failed it,
    // and four such starts filled a default worker.
    const after = await postgres.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM browser_sessions WHERE project_id = $1",
      [agent.seeded.projectId],
    );
    assert.equal(after.rows[0]?.n, before.rows[0]?.n, "a refused start reserved a session");

    // And it is audited. A refusal in the schema layer would have recorded
    // nothing, which is the whole reason the member is retained rather than
    // removed (ADR-0037).
    const audited = (await rejections(agent.seeded.projectId)).filter(
      (payload) => payload["command"] === "allocate",
    );
    assert.equal(audited.length, 1);
    assert.equal(audited[0]?.["reason_code"], "VALIDATION_FAILED");
    assert.equal(audited[0]?.["reason"], "published_service_id_on_start");
    assert.equal(audited[0]?.["browser_session_unresolved"], true);
  } finally {
    await agent.close();
  }
});

test("E6/E5: the refusal is VALIDATION_FAILED and not the validator's, and allocate:false is no loophole", async () => {
  // **The highest-leverage assertion in the deprecated-property set.** `decode`
  // produces `UNSUPPORTED_CAPABILITY` for a schema violation, so this single
  // comparison fails the moment somebody "tidies up" the schema by deleting the
  // member — which would flip the refusal to the validator layer, lose the audit
  // record, and replace the directions with the validator's own text in one
  // move. `docs/MCP_SPEC.md` §14 forbids that deletion inside protocol version
  // 1; this is the gate that notices if it happens anyway.
  const agent = await connected();
  try {
    for (const [label, args] of [
      ["plain", {}],
      // E5: reserving rather than starting is not a way round it. The refusal
      // precedes `create` on both, so neither takes a browser slot.
      ["with allocate:false", { allocate: false }],
    ] as const) {
      const before = await postgres.pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM browser_sessions WHERE project_id = $1",
        [agent.seeded.projectId],
      );
      const refused = await call(agent.client, "browser_session_start", {
        published_service_id: "svc_00000000000000000000000000000000",
        idempotency_key: key(`e6-${label.replace(/[^a-z]+/giu, "-")}`),
        ...args,
      });
      assert.equal(errorOf(refused).code, "VALIDATION_FAILED", label);
      assert.notEqual(errorOf(refused).code, "UNSUPPORTED_CAPABILITY", label);
      assert.equal(errorOf(refused).details?.["field"], "published_service_id", label);
      // The three the message must keep whatever else is reworded: `docs/UX_FLOWS.md`
      // §18 wants the way out, not this particular wording.
      for (const substring of [
        "allocate: false",
        "development_service_publish",
        "browser_session_allocate",
      ]) {
        assert.ok(errorOf(refused).message.includes(substring), `${label}: ${substring}`);
      }
      const after = await postgres.pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM browser_sessions WHERE project_id = $1",
        [agent.seeded.projectId],
      );
      assert.equal(after.rows[0]?.n, before.rows[0]?.n, `${label} reserved a session`);
    }

    // E4: the property is still advertised, and its description says so.
    const listed = await agent.client.listTools();
    const start = listed.tools.find((tool) => tool.name === "browser_session_start");
    const properties = (start?.inputSchema as { properties: Record<string, { description?: string }> })
      .properties;
    const deprecated = properties["published_service_id"]?.description ?? "";
    assert.match(deprecated, /DEPRECATED/u, deprecated);
    assert.match(deprecated, /browser_session_allocate/u, deprecated);
  } finally {
    await agent.close();
  }
});

test("the advertised browser_session_start description names browser_session_allocate", async () => {
  // A tool description is the only place a client that never reads the
  // documents learns the order. This repository's most common defect is a
  // document and a surface that disagree with no gate between them, so the
  // description is pinned here rather than left to review.
  const agent = await connected();
  try {
    const listed = await agent.client.listTools();
    const start = listed.tools.find((tool) => tool.name === "browser_session_start");
    assert.ok(start !== undefined, "browser_session_start is not advertised");
    assert.match(String(start.description), /browser_session_allocate/u);

    const allocate = listed.tools.find((tool) => tool.name === "browser_session_allocate");
    assert.ok(allocate !== undefined, "browser_session_allocate is not advertised");
    const properties = Object.keys(
      (allocate.inputSchema as { properties: Record<string, unknown> }).properties,
    ).sort();
    // Two identifiers and a key. No origin, no connector, no workspace, no
    // project and no organisation: each would be an authorisation input the
    // caller chose.
    assert.deepEqual(properties, ["browser_session_id", "idempotency_key", "published_service_id"]);
  } finally {
    await agent.close();
  }
});

// ------------------------------------------------------- timeout and takeover

test("the sweep completes a reservation the requesting process could not", async () => {
  // The harness's own background sweep is off for this one, because the state
  // under test is the *intermediate* one — requested and not yet completed —
  // and a sweep running every 25ms would have finished it before the assertion.
  harness.completeAllocations = false;
  const agent = await connected();
  try {
    const { connectorId } = await seedConnector(harness, agent.seeded);
    const sessionId = await reserve(agent);
    const routeId = await publish(agent.seeded, connectorId, [sessionId]);

    // Phase one alone, exactly as the MCP endpoint performs it: the request is
    // recorded and nothing outside PostgreSQL is touched.
    const before = harness.commands.length;
    await harness.mcp.services.browserSessions.requestAllocation({
      browserSessionId: sessionId,
      scope: { organisationId: agent.seeded.organisationId, projectIds: [agent.seeded.projectId] },
      publishedServiceId: routeId,
      actor: { type: "system", display: "test" },
      requestId: "req_sweep_test",
    });
    assert.equal(harness.commands.length, before, "phase one reached the worker");
    const requested = await postgres.pool.query<{
      status: string;
      requested_published_service_id: string | null;
      published_service_id: string | null;
    }>(
      "SELECT status, requested_published_service_id, published_service_id FROM browser_sessions WHERE id = $1",
      [sessionId],
    );
    assert.equal(requested.rows[0]?.status, "REQUESTED");
    assert.equal(requested.rows[0]?.requested_published_service_id, routeId);
    // The requested route is **not** written to `published_service_id`: that
    // column is what the agent-facing view calls "the service this session may
    // reach", and it may reach nothing until the bind has run.
    assert.equal(requested.rows[0]?.published_service_id, null);

    // Phase two, in the process that holds the signing key.
    const finished = await harness.control.sessions.completePendingAllocations({ olderThanMs: 0 });
    assert.equal(finished.length, 1);
    assert.equal(finished[0]?.status, "READY");
    assert.equal(finished[0]?.published_service_id, routeId);

    // A second sweep claims nothing: the status-guarded read excludes a
    // reservation that has moved, so a lost race costs one wasted claim rather
    // than two allocations for one request.
    const second = await harness.control.sessions.completePendingAllocations({ olderThanMs: 0 });
    assert.deepEqual(second, []);
    const capabilities = await postgres.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM route_capabilities WHERE browser_session_id = $1",
      [sessionId],
    );
    assert.equal(capabilities.rows[0]?.count, "1", "the sweep minted a second capability");
  } finally {
    await agent.close();
  }
});

test("a reservation nothing completes is failed by the deadline and stops holding a slot", async () => {
  harness.completeAllocations = false;
  const agent = await connected();
  try {
    const { connectorId } = await seedConnector(harness, agent.seeded);
    const sessionId = await reserve(agent);
    const routeId = await publish(agent.seeded, connectorId, [sessionId]);
    await harness.mcp.services.browserSessions.requestAllocation({
      browserSessionId: sessionId,
      scope: { organisationId: agent.seeded.organisationId, projectIds: [agent.seeded.projectId] },
      publishedServiceId: routeId,
      actor: { type: "system", display: "test" },
      requestId: "req_deadline_test",
    });

    // The deadline, not a timer in the process that may be the one that is
    // down. A `REQUESTED` row with `ended_at IS NULL` is exactly what the worker
    // capacity query counts, so a reservation nothing can complete would
    // otherwise hold a browser slot for ever.
    const failed = await harness.control.sessions.failOverdueAllocations({ deadlineMs: 0 });
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.status, "FAILED");

    const row = await postgres.pool.query<{ status: string; ended_at: Date | null }>(
      "SELECT status, ended_at FROM browser_sessions WHERE id = $1",
      [sessionId],
    );
    assert.equal(row.rows[0]?.status, "FAILED");
    assert.notEqual(row.rows[0]?.ended_at, null, "a failed reservation still counts as capacity");

    // The failure is recorded under a **stable class**, not the text of an
    // exception. `docs/EVENTS.md` §8 requires a reason code, and a query that
    // counted refused allocations by matching a message stops counting them the
    // first time somebody rewords one.
    const events = await postgres.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM events
        WHERE type = 'browser_session.failed' AND correlation ->> 'browser_session_id' = $1`,
      [sessionId],
    );
    assert.equal(events.rows.length, 1);
    assert.equal(events.rows[0]?.payload["reason_code"], "CONTROL_PLANE_UNAVAILABLE");
    assert.equal(events.rows[0]?.payload["trigger"], "allocation_deadline");
    assert.equal(events.rows[0]?.payload["reason"], undefined, "free text survived in the payload");
  } finally {
    await agent.close();
  }
});

test("the bounded wait ends in the record as it stands and never reports ready", async () => {
  harness.completeAllocations = false;
  const agent = await connected();
  try {
    const { connectorId } = await seedConnector(harness, agent.seeded);
    const sessionId = await reserve(agent);
    const routeId = await publish(agent.seeded, connectorId, [sessionId]);
    await harness.mcp.services.browserSessions.requestAllocation({
      browserSessionId: sessionId,
      scope: { organisationId: agent.seeded.organisationId, projectIds: [agent.seeded.projectId] },
      publishedServiceId: routeId,
      actor: { type: "system", display: "test" },
      requestId: "req_wait_test",
    });

    // A wait with no time in it, and no sweep having run: the answer is the
    // record, which is `REQUESTED`. An agent told a session was ready when
    // nothing was carrying its origin would read the navigation failure as a
    // fault in the application it is reviewing.
    const settled = await harness.mcp.services.browserSessions.awaitAllocation(
      sessionId,
      { organisationId: agent.seeded.organisationId, projectIds: [agent.seeded.projectId] },
      { timeoutMs: 0, pollMs: 1 },
    );
    assert.notEqual(settled.status, "READY");
    assert.ok(
      settled.status === "REQUESTED" || settled.status === "FAILED",
      `the wait reported ${settled.status}`,
    );
  } finally {
    await agent.close();
  }
});

// ------------------------------------------------ the attack list's A-series

test("A2/A1: an unknown route and a cross-project route are the same bytes and different records", async () => {
  // **The pair is the whole point, and neither half proves anything alone.**
  // Asserting only the byte-equality proves the system is uniformly blind;
  // asserting only the audit marker proves nothing about disclosure. They are in
  // one test because in two files they drift.
  const agent = await connected();
  const elsewhere = await seedSiblingProject(harness, agent.seeded);
  try {
    const { connectorId } = await seedConnector(harness, elsewhere);
    const theirSession = await harness.control.sessions.create({
      organisationId: elsewhere.organisationId,
      projectId: elsewhere.projectId,
      viewport: { width: 1440, height: 900, device_scale_factor: 1 },
      controller: { type: "system", id: "sys_pair" },
      retentionClass: "verification_evidence",
      actor: { type: "system" },
    });
    const theirRoute = await publish(
      { ...agent.seeded, ...elsewhere },
      connectorId,
      [theirSession.id],
    );

    const mine = await reserve(agent);
    const foreign = await call(agent.client, "browser_session_allocate", {
      browser_session_id: mine,
      published_service_id: theirRoute,
      idempotency_key: key("pair-foreign"),
    });
    const unknown = await call(agent.client, "browser_session_allocate", {
      browser_session_id: mine,
      published_service_id: "svc_00000000000000000000000000000000",
      idempotency_key: key("pair-unknown"),
    });

    // Identical bytes to the caller.
    assert.equal(errorOf(foreign).code, "RESOURCE_NOT_FOUND");
    assert.deepEqual(errorOf(foreign), errorOf(unknown));

    // Distinguishable records in the audit trail, both on **this** project's
    // stream. Without the marker an agent probing another project's identifiers
    // and an operator's typo are indistinguishable to an auditor.
    const audited = (await rejections(agent.seeded.projectId)).filter(
      (payload) => payload["command"] === "allocate",
    );
    assert.equal(audited.length, 2);
    const [crossProject, notFound] = audited;
    assert.equal(crossProject?.["cross_project"], true);
    assert.equal(crossProject?.["published_service_id"], theirRoute);
    assert.equal(crossProject?.["reason_code"], "RESOURCE_NOT_FOUND");
    // The caller was not entitled to know the other tenancy's record exists, so
    // the record withholds what it would have disclosed.
    assert.equal(crossProject?.["session_status"], undefined);
    assert.equal(crossProject?.["current_epoch"], undefined);

    // A2: the marker is absent for a genuinely unknown identifier. An
    // implementation that never set it would also pass this half — which is why
    // the pair is asserted together.
    assert.equal(notFound?.["cross_project"], undefined);
    assert.equal(notFound?.["published_service_id"], "svc_00000000000000000000000000000000");

    // A3's negative: nothing was written to the other project's stream. A
    // refusal appearing in the victim's audit trail is an oracle in the other
    // direction and noise for the victim.
    const theirs = await rejections(elsewhere.projectId);
    assert.deepEqual(theirs, []);
  } finally {
    await agent.close();
  }
});

test("A5b/A5: ownership is checked only after the project matches", async () => {
  // The pair pins the **order** of two checks. A5 alone passes even if ownership
  // runs first; A5b alone passes even if there is no ownership check at all.
  const seeded = await seedProject(harness);
  const first = await connected(seeded);
  const second = await connected(seeded);
  const elsewhere = await seedSiblingProject(harness, seeded);
  try {
    // A5: same project, different agent session -> AUTHORISATION_DENIED. The
    // caller is entitled to know the session exists; it is in their project.
    const theirs = await reserve(first);
    const owned = await call(second.client, "browser_session_allocate", {
      browser_session_id: theirs,
      idempotency_key: key("a5-owned"),
    });
    assert.equal(errorOf(owned).code, "AUTHORISATION_DENIED");

    // A5b: another project -> RESOURCE_NOT_FOUND, equal to an unknown
    // identifier. "It exists, but not for you" is the enumeration `docs/API.md`
    // §5 forbids, and it is what an ownership check running first would produce.
    const theirsElsewhere = await harness.control.sessions.create({
      organisationId: elsewhere.organisationId,
      projectId: elsewhere.projectId,
      viewport: { width: 1440, height: 900, device_scale_factor: 1 },
      controller: { type: "system", id: "sys_a5b" },
      retentionClass: "verification_evidence",
      actor: { type: "system" },
    });
    const foreign = await call(first.client, "browser_session_allocate", {
      browser_session_id: theirsElsewhere.id,
      idempotency_key: key("a5b-foreign"),
    });
    const unknown = await call(first.client, "browser_session_allocate", {
      browser_session_id: "brs_00000000000000000000000000000000",
      idempotency_key: key("a5b-unknown"),
    });
    assert.equal(errorOf(foreign).code, "RESOURCE_NOT_FOUND");
    assert.deepEqual(errorOf(foreign), errorOf(unknown));
  } finally {
    await second.close();
    await first.close();
  }
});

test("A10: a capability denial is recorded, for a tool this change did not add", async () => {
  // **The single highest-value entry in the attack list**, because it is the one
  // that regresses invisibly: removing the audit write changes no response and
  // breaks no other test. Execution against two real processes proved that this
  // refusal wrote nothing at all — for any of the 37 tools.
  //
  // It is asserted on `review_list` rather than on an allocation tool on
  // purpose. The fix is in `callTool` with no per-tool branching, and a test
  // that only covered this change's own tools would pass a "fix" that added one.
  const seeded = await seedProject(harness);
  const credential = await issueAgentCredential(harness, {
    organisationId: seeded.organisationId,
    projectIds: [seeded.projectId],
    capabilities: ["project:read"],
  });
  const agent = await connectAgent(harness, { token: credential.token });
  try {
    const before = await postgres.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM browser_sessions WHERE project_id = $1",
      [seeded.projectId],
    );

    const refused = await call(agent.client, "browser_session_allocate", {
      browser_session_id: "brs_anything_at_all_0000000000000",
      idempotency_key: key("a10-no-capability"),
    });
    assert.equal(refused["ok"], false, JSON.stringify(refused));
    assert.equal(errorOf(refused).code, "AUTHORISATION_DENIED");
    assert.match(errorOf(refused).message, /browser:control/u);

    // A read-only tool, so nothing about the assertion depends on a write path.
    // The capability gate runs after the argument validator, so the arguments
    // must be valid — this one takes none.
    const other = await call(agent.client, "review_list", {});
    assert.equal(errorOf(other).code, "AUTHORISATION_DENIED");

    const audited = (await rejections(seeded.projectId)).filter(
      (payload) => payload["capability_denied"] === true,
    );
    assert.equal(audited.length, 2, "a capability denial left no record");
    assert.equal(audited[0]?.["kind"], "capability");
    assert.equal(audited[0]?.["command"], "browser_session_allocate");
    assert.equal(audited[0]?.["required_capability"], "browser:control");
    assert.equal(audited[0]?.["reason_code"], "AUTHORISATION_DENIED");
    assert.equal(audited[1]?.["command"], "review_list");
    assert.equal(audited[1]?.["required_capability"], "review:read");

    // No reservation was created and no worker was contacted.
    const after = await postgres.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM browser_sessions WHERE project_id = $1",
      [seeded.projectId],
    );
    assert.equal(after.rows[0]?.n, before.rows[0]?.n);
  } finally {
    await agent.close();
  }
});

test("B2: allocation never re-registers a route with the gateway", async () => {
  // The test that fails if the route-amendment design is ever introduced. It
  // costs one counter and it is the only automated defence against that path
  // returning.
  const agent = await connected();
  try {
    const { connectorId } = await seedConnector(harness, agent.seeded);
    const sessionId = await reserve(agent);
    const routeId = await publish(agent.seeded, connectorId, [sessionId]);
    const afterPublish = harness.gateway.registered.length;
    assert.equal(afterPublish, 1, "publication did not register exactly one route");

    const allocated = await call(agent.client, "browser_session_allocate", {
      browser_session_id: sessionId,
      published_service_id: routeId,
      idempotency_key: key("b2-allocate"),
    });
    assert.equal(allocated["ok"], true, JSON.stringify(allocated));
    assert.equal(
      harness.gateway.registered.length,
      afterPublish,
      "allocation registered a route with the gateway",
    );
  } finally {
    await agent.close();
  }
});

test("B3/F5/F6: the opportunistic sweep reclaims the caller's strandings and only the caller's", async () => {
  // The opportunistic sweep is the one place the MCP process writes to rows it
  // did not create in that call. A deployment-wide sweep there would be an
  // unscoped write from the agent-facing process, which is the shape the rest of
  // this change removes.
  harness.completeAllocations = false;
  const seeded = await seedProject(harness);
  const first = await connected(seeded);
  const second = await connected(seeded);
  try {
    const { connectorId } = await seedConnector(harness, seeded);
    const mine = await reserve(first);
    const theirs = await reserve(second);
    const route = await publish(seeded, connectorId, [mine, theirs]);

    const scopeOf = (project: SeededProject) => ({
      organisationId: project.organisationId,
      projectIds: [project.projectId],
    });
    for (const [session, services] of [
      [mine, harness.mcp.services],
      [theirs, harness.mcp.services],
    ] as const) {
      await services.browserSessions.requestAllocation({
        browserSessionId: session,
        scope: scopeOf(seeded),
        publishedServiceId: route,
        actor: { type: "system", display: "test" },
        requestId: `req_${session}`,
      });
    }
    // Both are now stranded past the deadline.
    await postgres.pool.query(
      "UPDATE browser_sessions SET allocation_requested_at = now() - interval '10 minutes' WHERE id = ANY($1)",
      [[mine, theirs]],
    );

    // The first agent calls a tool that runs the opportunistic sweep.
    await call(first.client, "browser_session_start", {
      allocate: false,
      idempotency_key: key("b3-reclaim"),
    });

    const statuses = await postgres.pool.query<{ id: string; status: string }>(
      "SELECT id, status FROM browser_sessions WHERE id = ANY($1)",
      [[mine, theirs]],
    );
    const byId = new Map(statuses.rows.map((row) => [row.id, row.status]));
    assert.equal(byId.get(mine), "FAILED", "the caller's own stranded reservation was not reclaimed");
    assert.equal(byId.get(theirs), "REQUESTED", "the sweep touched another agent session's row");
  } finally {
    await second.close();
    await first.close();
  }
});
