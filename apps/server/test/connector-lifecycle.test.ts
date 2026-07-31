/**
 * Connector enrolment, environment registration and workspace Git context
 * (RVP-20), against a real PostgreSQL (`docs/TESTING.md` §2).
 *
 * The security cases of `docs/TESTING.md` §10 live beside the behaviour they
 * constrain, because most of them differ from the accepted case only in the
 * database state or the credential the same handler reads. In particular:
 *
 * * a state-changing route reachable by a session cookie is forgeable unless it
 *   demands the CSRF token, and minting an enrolment token is the shape that
 *   matters most — it is a credential that enrols a machine;
 * * a connector reporting a workspace for a project it was not enrolled for is
 *   the wrong-project case `PROJECT_NOT_AUTHORISED` exists for;
 * * a foreign identifier and an unknown one must be indistinguishable, or the
 *   difference is an enumeration oracle.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";

import { decodePlatformEvent } from "@reviewplane/protocol/platform";

import { main } from "../src/cli.ts";

import { HeartbeatFloor } from "../src/modules/connectors/channel.ts";
import { sweepConnectorHealth } from "../src/modules/connectors/monitor.ts";
import { displayLabel, pathHash } from "../src/modules/connectors/workspaces.ts";
import { revokeConnector } from "../src/modules/connectors/repository.ts";
import { enrolmentCommand } from "../src/modules/connectors/routes.ts";
import { BOOTSTRAP_TOKEN, startHarness, type Harness } from "./support/harness.ts";
import { enrolOverWebSocket, generateDeviceKey, identityFrom, openControlChannel, waitFor } from "./support/connector-client.ts";
import { claimSessionFor, eventsOfType, type SessionCookies } from "./support/identity.ts";
import { truncateAll } from "./support/postgres.ts";

let harness: Harness;

before(async () => {
  harness = await startHarness();
});

after(async () => {
  await harness.stop();
});

afterEach(async () => {
  await truncateAll(harness.pool);
});

const ADMIN = { authorization: `Bearer ${BOOTSTRAP_TOKEN}` } as const;

/** The organisation this deployment enrols into, plus a project inside it. */
async function seedProject(slug = "refresh-surplus"): Promise<{
  readonly organisationId: string;
  readonly projectId: string;
}> {
  const organisationId = harness.connectorConfig.organisationId;
  await harness.pool.query(
    "insert into organisations (id, name, slug) values ($1, $2, $3) on conflict (id) do nothing",
    [organisationId, "ReviewPlane", organisationId.toLowerCase().replaceAll(/[^a-z0-9-]/gu, "-")],
  );
  const projectId = `prj_${slug.replaceAll("-", "")}`;
  await harness.pool.query(
    `insert into projects (id, organisation_id, name, slug, default_branch)
     values ($1, $2, $3, $4, 'main') on conflict (id) do nothing`,
    [projectId, organisationId, slug, slug],
  );
  return { organisationId, projectId };
}

async function session(): Promise<SessionCookies> {
  const { organisationId } = await seedProject();
  return claimSessionFor(harness.built, harness.pool, organisationId);
}

/** Enrols a connector and returns its identity, as the Go connector would. */
async function enrol(options: { readonly projectId?: string | null } = {}): Promise<{
  readonly connectorId: string;
  readonly environmentId: string;
  readonly identity: Awaited<ReturnType<typeof identityFrom>>;
}> {
  const issued = await harness.built.app.inject({
    method: "POST",
    url: "/api/v1/connectors/enrolment-tokens",
    headers: ADMIN,
    payload: options.projectId === undefined ? {} : { project_id: options.projectId },
  });
  assert.equal(issued.statusCode, 201, issued.body);
  const token = (issued.json() as { data: { enrolment_token: string } }).data.enrolment_token;

  const device = generateDeviceKey();
  const attempt = await enrolOverWebSocket(harness, token, device);
  assert.ok(attempt.response !== null, `enrolment failed: ${attempt.closeReason}`);
  const identity = identityFrom(attempt.response, device);
  const environment = await harness.pool.query<{ environment_id: string }>(
    "select environment_id from connectors where id = $1",
    [identity.connectorId],
  );
  return {
    connectorId: identity.connectorId,
    environmentId: environment.rows[0]?.environment_id ?? "",
    identity,
  };
}

describe("enrolment-token issuance from a human session", () => {
  test("a cookie session may mint a token when it presents the CSRF header", async () => {
    const { projectId } = await seedProject();
    const cookies = await session();
    const response = await harness.built.app.inject({
      method: "POST",
      url: "/api/v1/connectors/enrolment-tokens",
      headers: cookies.writeHeaders,
      payload: { project_id: projectId, environment_labels: ["proxmox"] },
    });
    assert.equal(response.statusCode, 201, response.body);
    const body = response.json() as {
      data: {
        enrolment_token: string;
        project_id: string;
        environment_labels: string[];
        connector_command: string;
        enrolment_endpoint: string;
        control_plane_url: string;
      };
    };
    assert.equal(body.data.project_id, projectId);
    assert.deepEqual(body.data.environment_labels, ["proxmox"]);
    assert.match(body.data.enrolment_endpoint, /^wss:\/\/.+\/connector\/v1\/enrol$/u);
    // `docs/UX_FLOWS.md` §5 asks the screen to show the one-time command. The
    // command reads the token from a file, never from a command line, because a
    // command line is in the process table and in shell history.
    assert.match(body.data.connector_command, /reviewplane-connector enrol/u);
    assert.match(body.data.connector_command, /--token-file/u);
    assert.ok(
      !body.data.connector_command.includes(body.data.enrolment_token),
      "the displayed command embeds the token in the process table",
    );
    assert.ok(!harness.logText().includes(body.data.enrolment_token), "the token reached the log");
  });

  test("a forged cross-origin write is refused: the cookie alone mints nothing", async () => {
    await seedProject();
    const cookies = await session();
    const response = await harness.built.app.inject({
      method: "POST",
      url: "/api/v1/connectors/enrolment-tokens",
      // Exactly what a browser attaches to a request another origin caused: the
      // cookie, and no CSRF header, because no other origin can read one.
      headers: cookies.readHeaders,
      payload: {},
    });
    assert.equal(response.statusCode, 403, response.body);
    const body = response.json() as { error: { code: string; details?: { reason?: string } } };
    assert.equal(body.error.code, "AUTHORISATION_DENIED");
    assert.equal(body.error.details?.reason, "csrf_token_invalid");
    process.stdout.write(`EVIDENCE forged POST /api/v1/connectors/enrolment-tokens -> ${String(response.statusCode)} ${response.body}\n`);

    const stored = await harness.pool.query("select count(*)::int as n from connector_enrolment_tokens");
    assert.equal((stored.rows[0] as { n: number }).n, 0, "a forged request minted a token");
  });

  test("a wrong CSRF token is refused as firmly as an absent one", async () => {
    await seedProject();
    const cookies = await session();
    const response = await harness.built.app.inject({
      method: "POST",
      url: "/api/v1/connectors/enrolment-tokens",
      headers: { ...cookies.readHeaders, "x-csrf-token": "not-the-token" },
      payload: {},
    });
    assert.equal(response.statusCode, 403, response.body);
  });

  test("a project the caller cannot reach is absent rather than forbidden", async () => {
    await seedProject();
    const cookies = await session();
    // A project in another organisation, and one that does not exist, must be
    // answered identically: the difference is an existence oracle.
    const other = await harness.pool.query<{ id: string }>(
      `insert into organisations (id, name, slug) values ('org_elsewhere', 'Elsewhere', 'elsewhere')
       on conflict (id) do nothing returning id`,
    );
    void other;
    await harness.pool.query(
      `insert into projects (id, organisation_id, name, slug, default_branch)
       values ('prj_elsewhere', 'org_elsewhere', 'Elsewhere', 'elsewhere', 'main')
       on conflict (id) do nothing`,
    );

    const foreign = await harness.built.app.inject({
      method: "POST",
      url: "/api/v1/connectors/enrolment-tokens",
      headers: cookies.writeHeaders,
      payload: { project_id: "prj_elsewhere" },
    });
    const unknown = await harness.built.app.inject({
      method: "POST",
      url: "/api/v1/connectors/enrolment-tokens",
      headers: cookies.writeHeaders,
      payload: { project_id: "prj_does_not_exist" },
    });
    assert.equal(foreign.statusCode, 404, foreign.body);
    assert.equal(unknown.statusCode, 404, unknown.body);
    const strip = (body: string): string => body.replaceAll(/req_[a-z0-9]+/gu, "req_x");
    assert.equal(strip(foreign.body), strip(unknown.body), "a foreign project is distinguishable from an unknown one");
  });

  test("a minted token's organisation is the one its project belongs to", async () => {
    // The bootstrap principal carries no organisation, so `resolveProject`
    // applies no organisation filter for it. Deriving the stored organisation
    // from the deployment default instead produced a row whose organisation and
    // project named different organisations — nothing honours it, because
    // enrolment refuses a token scoped elsewhere, but it is a row no reader can
    // interpret, and it is the RVP-66 shape.
    await seedProject();
    await harness.pool.query(
      `insert into organisations (id, name, slug) values ('org_elsewhere', 'Elsewhere', 'elsewhere')
       on conflict (id) do nothing`,
    );
    await harness.pool.query(
      `insert into projects (id, organisation_id, name, slug, default_branch)
       values ('prj_elsewhere', 'org_elsewhere', 'Elsewhere', 'elsewhere', 'main')
       on conflict (id) do nothing`,
    );
    const response = await harness.built.app.inject({
      method: "POST",
      url: "/api/v1/connectors/enrolment-tokens",
      headers: ADMIN,
      payload: { project_id: "prj_elsewhere" },
    });
    assert.equal(response.statusCode, 201, response.body);
    const data = (response.json() as { data: { id: string; organisation_id: string; project_id: string } }).data;
    assert.equal(data.project_id, "prj_elsewhere");
    assert.equal(data.organisation_id, "org_elsewhere", "the token's organisation is not its project's");

    const stored = await harness.pool.query<{ organisation_id: string; project_id: string }>(
      `select t.organisation_id, t.project_id from connector_enrolment_tokens t
         join projects p on p.id = t.project_id
        where t.id = $1 and p.organisation_id = t.organisation_id`,
      [data.id],
    );
    assert.equal(stored.rows.length, 1, "the stored token's organisation and project disagree");
  });

  test("a machine credential cannot mint an enrolment token", async () => {
    await seedProject();
    for (const authorization of [
      `Bearer ${harness.config.workerCredential}`,
      "Bearer rpa_an-agent-credential-shaped-token",
    ]) {
      const response = await harness.built.app.inject({
        method: "POST",
        url: "/api/v1/connectors/enrolment-tokens",
        headers: { authorization },
        payload: {},
      });
      assert.equal(response.statusCode, 403, `${authorization} was accepted: ${response.body}`);
      assert.equal((response.json() as { error: { code: string } }).error.code, "AUTHORISATION_DENIED");
    }
  });

  test("the bootstrap operator token still works and needs no CSRF header", async () => {
    await seedProject();
    const response = await harness.built.app.inject({
      method: "POST",
      url: "/api/v1/connectors/enrolment-tokens",
      headers: ADMIN,
      payload: {},
    });
    assert.equal(response.statusCode, 201, response.body);
  });
});

describe("connector and environment views", () => {
  test("an enrolled connector appears with its environment and health", async () => {
    const { projectId } = await seedProject();
    const enrolled = await enrol({ projectId });
    const cookies = await session();

    const list = await harness.built.app.inject({
      method: "GET",
      url: "/api/v1/connectors",
      headers: cookies.readHeaders,
    });
    assert.equal(list.statusCode, 200, list.body);
    const listed = (list.json() as { data: { id: string; status: string; capabilities: string[] }[] }).data;
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, enrolled.connectorId);
    assert.equal(listed[0]?.status, "PENDING_ENROLMENT");

    const environments = await harness.built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/environments`,
      headers: cookies.readHeaders,
    });
    assert.equal(environments.statusCode, 200, environments.body);
    const found = (
      environments.json() as {
        data: { id: string; name: string; platform: string; connectors: { id: string }[] }[];
      }
    ).data;
    assert.equal(found.length, 1);
    assert.equal(found[0]?.id, enrolled.environmentId);
    assert.equal(found[0]?.connectors[0]?.id, enrolled.connectorId);

    const one = await harness.built.app.inject({
      method: "GET",
      url: `/api/v1/environments/${enrolled.environmentId}`,
      headers: cookies.readHeaders,
    });
    assert.equal(one.statusCode, 200, one.body);
  });

  test("a foreign connector identifier is reported exactly as an unknown one", async () => {
    await seedProject();
    const cookies = await session();
    // A connector belonging to another organisation.
    await harness.pool.query(
      `insert into organisations (id, name, slug) values ('org_elsewhere', 'Elsewhere', 'elsewhere')
       on conflict (id) do nothing`,
    );
    await harness.pool.query(
      `insert into environments (id, organisation_id, name, platform, architecture)
       values ('env_elsewhere', 'org_elsewhere', 'their-vm', 'linux', 'amd64')`,
    );
    await harness.pool.query(
      `insert into connectors
         (id, organisation_id, environment_id, certificate_fingerprint, certificate_serial,
          certificate_not_after, public_key, version)
       values ('con_elsewhere', 'org_elsewhere', 'env_elsewhere', 'sha256:ff', '01',
               now() + interval '1 year', 'AAAA', '0.1.0')`,
    );

    const strip = (body: string): string => body.replaceAll(/req_[a-z0-9]+/gu, "req_x");
    for (const [foreign, unknown] of [
      ["/api/v1/connectors/con_elsewhere", "/api/v1/connectors/con_nothing"],
      ["/api/v1/environments/env_elsewhere", "/api/v1/environments/env_nothing"],
    ]) {
      const a = await harness.built.app.inject({ method: "GET", url: foreign as string, headers: cookies.readHeaders });
      const b = await harness.built.app.inject({ method: "GET", url: unknown as string, headers: cookies.readHeaders });
      assert.equal(a.statusCode, 404, a.body);
      assert.equal(b.statusCode, 404, b.body);
      assert.equal(strip(a.body), strip(b.body), `${String(foreign)} is distinguishable from ${String(unknown)}`);
    }
  });
});

describe("revocation", () => {
  test("revoking closes the channel, refuses the credential and records what it reached", async () => {
    const { projectId, organisationId } = await seedProject();
    const enrolled = await enrol({ projectId });
    const channel = await openControlChannel(harness, enrolled.identity);
    await waitFor(async () => {
      const row = await harness.pool.query<{ status: string }>(
        "select status from connectors where id = $1",
        [enrolled.connectorId],
      );
      return row.rows[0]?.status === "ACTIVE" ? true : null;
    }, "the connector to become ACTIVE");

    const cookies = await session();
    const revoked = await harness.built.app.inject({
      method: "POST",
      url: `/api/v1/connectors/${enrolled.connectorId}/revoke`,
      headers: cookies.writeHeaders,
    });
    assert.equal(revoked.statusCode, 200, revoked.body);
    const outcome = (
      revoked.json() as {
        data: { status: string; channels_closed: number; routes_revoked: number; sessions_disconnected: number };
      }
    ).data;
    assert.equal(outcome.status, "REVOKED");
    assert.equal(outcome.channels_closed, 1, "the live channel was not closed");
    assert.equal(outcome.routes_revoked, 0);
    assert.equal(outcome.sessions_disconnected, 0);

    // §18: the channels are closed, not merely marked.
    const closed = await channel.closed();
    assert.equal(closed.code, 1008);
    assert.equal(closed.reason, "IDENTITY_REVOKED");

    // §18: the prior credential cannot be reused. The refusal happens before
    // the WebSocket upgrade, so it arrives as an HTTP response rather than as a
    // close frame, and the connector never obtains a channel at all.
    const retried = await openControlChannel(harness, enrolled.identity);
    const refused = await retried.closed();
    assert.equal(refused.code, 401, `a revoked identity was admitted: ${JSON.stringify(refused)}`);
    assert.equal(refused.reason, "IDENTITY_REVOKED");

    const events = await eventsOfType(harness.pool, projectId, "connector.revoked");
    assert.equal(events.length, 1, "revocation recorded no audit event");
    assert.equal(events[0]?.payload["previous_status"], "ACTIVE");
    assert.equal(events[0]?.payload["new_status"], "REVOKED");
    assert.equal(events[0]?.actor_type, "human_user");
    void organisationId;
  });

  test("the repository's own revocation records the status it replaced", async () => {
    // `revokeConnector` is not on the API path — `revocation.ts` is — but it is
    // exported, three suites use it, and it wrote
    // `{"previous_status":"REVOKED","new_status":"REVOKED"}` because it read the
    // row its own UPDATE returned. A transition from a state to itself never
    // happened, and the decoder-replay guard cannot catch it: the value is
    // wrong but schema-valid.
    const { projectId } = await seedProject();
    const enrolled = await enrol({ projectId });
    const channel = await openControlChannel(harness, enrolled.identity);
    await waitFor(async () => {
      const rows = await harness.pool.query<{ status: string }>(
        "select status from connectors where id = $1",
        [enrolled.connectorId],
      );
      return rows.rows[0]?.status === "ACTIVE" ? true : null;
    }, "the connector to become ACTIVE");
    channel.close();
    await channel.closed();

    const event = await revokeConnector(harness.pool, enrolled.connectorId, { type: "system" });
    assert.ok(event !== null);
    const stored = await harness.pool.query<{ payload: Record<string, unknown> }>(
      "select payload from events where id = $1",
      [event.id],
    );
    const payload = stored.rows[0]?.payload ?? {};
    assert.notEqual(payload["previous_status"], "REVOKED", "it recorded the status it set, not the one it replaced");
    assert.ok(
      payload["previous_status"] === "ACTIVE" || payload["previous_status"] === "DISCONNECTED",
      `previous_status was ${String(payload["previous_status"])}`,
    );
    assert.equal(payload["new_status"], "REVOKED");
  });

  test("a forged revocation is refused", async () => {
    const { projectId } = await seedProject();
    const enrolled = await enrol({ projectId });
    const cookies = await session();
    const response = await harness.built.app.inject({
      method: "POST",
      url: `/api/v1/connectors/${enrolled.connectorId}/revoke`,
      headers: cookies.readHeaders,
    });
    assert.equal(response.statusCode, 403, response.body);
    const row = await harness.pool.query<{ status: string }>(
      "select status from connectors where id = $1",
      [enrolled.connectorId],
    );
    assert.notEqual(row.rows[0]?.status, "REVOKED", "a forged request revoked an identity");
  });

  test("revoking a connector in another organisation reports it absent", async () => {
    await seedProject();
    const cookies = await session();
    const response = await harness.built.app.inject({
      method: "POST",
      url: "/api/v1/connectors/con_elsewhere/revoke",
      headers: cookies.writeHeaders,
    });
    assert.equal(response.statusCode, 404, response.body);
    assert.equal((response.json() as { error: { code: string } }).error.code, "RESOURCE_NOT_FOUND");
  });
});

describe("workspace observations", () => {
  test("a first observation creates the record and a change records both sides", async () => {
    const { projectId } = await seedProject();
    const enrolled = await enrol({ projectId });
    const channel = await openControlChannel(harness, enrolled.identity);

    channel.sendWorkspaceObservation({
      workspace_id: "wsp_refresh_surplus",
      project_id: projectId,
      repository_identity: "github.com/example/refresh-surplus",
      branch: "main",
      head_commit: "4f3a9c1d2e8b7a6053f4e3d2c1b0a9f8e7d6c5b4",
      dirty: false,
    });
    const created = await waitFor(async () => {
      const rows = await harness.pool.query<{
        id: string;
        branch: string;
        display_path: string;
        root_path: string | null;
        repository_identity: string | null;
        source: string;
      }>("select id, branch, display_path, root_path, repository_identity, source from workspaces where id = $1", [
        "wsp_refresh_surplus",
      ]);
      return rows.rows[0] ?? null;
    }, "the workspace to be recorded");
    assert.equal(created.branch, "main");
    assert.equal(created.display_path, "refresh-surplus");
    assert.equal(created.repository_identity, "github.com/example/refresh-surplus");
    assert.equal(created.source, "connector_report");
    // The privacy rule, checked where it matters: nothing stored the path.
    assert.equal(created.root_path, null, "a connector-reported workspace stored a filesystem path");

    // A repeat with nothing changed refreshes the record and writes no event.
    channel.sendWorkspaceObservation({
      workspace_id: "wsp_refresh_surplus",
      project_id: projectId,
      repository_identity: "github.com/example/refresh-surplus",
      branch: "main",
      head_commit: "4f3a9c1d2e8b7a6053f4e3d2c1b0a9f8e7d6c5b4",
      dirty: false,
    });
    // A change on any of branch, head or dirty is the event.
    channel.sendWorkspaceObservation({
      workspace_id: "wsp_refresh_surplus",
      project_id: projectId,
      repository_identity: "github.com/example/refresh-surplus",
      branch: "feat/checkout-tidy",
      head_commit: "8b7a6053f4e3d2c1b0a9f8e7d6c5b44f3a9c1d2e",
      dirty: true,
    });
    const moved = await waitFor(async () => {
      const events = await eventsOfType(harness.pool, projectId, "workspace.head_changed");
      return events.length === 1 ? events : null;
    }, "workspace.head_changed to be recorded");
    assert.equal(moved[0]?.payload["previous_branch"], "main");
    assert.equal(moved[0]?.payload["branch"], "feat/checkout-tidy");
    assert.equal(moved[0]?.payload["previous_dirty"], false);
    assert.equal(moved[0]?.payload["dirty"], true);

    const observed = await eventsOfType(harness.pool, projectId, "workspace.observed");
    assert.equal(observed.length, 1, "an unchanged repeat wrote a second workspace.observed");
    assert.equal(observed[0]?.payload["source"], "connector_report");
    assert.ok(
      !Object.keys(observed[0]?.payload ?? {}).includes("changed_paths"),
      "the event carries a changed-path list",
    );
    channel.close();
  });

  test("a connector enrolled for one project cannot report for another", async () => {
    const { projectId } = await seedProject("refresh-surplus");
    const other = await seedProject("other-project");
    const enrolled = await enrol({ projectId });
    const channel = await openControlChannel(harness, enrolled.identity);

    channel.sendWorkspaceObservation({
      workspace_id: "wsp_elsewhere",
      project_id: other.projectId,
      branch: "main",
      head_commit: "4f3a9c1d2e8b7a6053f4e3d2c1b0a9f8e7d6c5b4",
      dirty: false,
    });

    const closed = await channel.closed();
    assert.equal(closed.code, 1008);
    assert.equal(closed.reason, "PROJECT_NOT_AUTHORISED");
    const rows = await harness.pool.query("select count(*)::int as n from workspaces");
    assert.equal((rows.rows[0] as { n: number }).n, 0, "a refused observation still wrote a row");
  });

  test("a workspace identifier held in another project cannot be claimed", async () => {
    const { projectId } = await seedProject("refresh-surplus");
    const other = await seedProject("other-project");
    await harness.pool.query(
      `insert into workspaces
         (id, organisation_id, project_id, path_hash, display_path, branch, head_commit, dirty, source)
       values ($1, $2, $3, $4, 'theirs', 'main', 'abcdef0', false, 'administrative_registration')`,
      ["wsp_contested", harness.connectorConfig.organisationId, other.projectId, `sha256:${"b".repeat(64)}`],
    );

    const enrolled = await enrol({ projectId });
    const channel = await openControlChannel(harness, enrolled.identity);
    channel.sendWorkspaceObservation({
      workspace_id: "wsp_contested",
      project_id: projectId,
      branch: "main",
      head_commit: "4f3a9c1d2e8b7a6053f4e3d2c1b0a9f8e7d6c5b4",
      dirty: false,
    });

    const closed = await channel.closed();
    assert.equal(closed.reason, "PROJECT_NOT_AUTHORISED");
    const row = await harness.pool.query<{ project_id: string }>(
      "select project_id from workspaces where id = $1",
      ["wsp_contested"],
    );
    assert.equal(row.rows[0]?.project_id, other.projectId, "the contested workspace changed hands");
  });

  test("a second environment cannot take over another environment's workspace record", async () => {
    // The cross-*project* case takes the insert path and was always refused.
    // This is the same-project, different-environment case, which reaches the
    // update path — where ADR-0022 point 8 was a claim rather than a check.
    const { projectId } = await seedProject();
    const first = await enrol({ projectId });
    const firstChannel = await openControlChannel(harness, first.identity);
    firstChannel.sendWorkspaceObservation({
      workspace_id: "wsp_contested",
      project_id: projectId,
      path_hash: `sha256:${"a".repeat(64)}`,
      display_label: "checkout-a",
      branch: "main",
      head_commit: "1111111111111111111111111111111111111111",
      dirty: false,
    });
    const before = await waitFor(async () => {
      const rows = await harness.pool.query<{
        environment_id: string;
        connector_id: string;
        path_hash: string;
        display_path: string;
        branch: string;
        head_commit: string;
      }>(
        `select environment_id, connector_id, path_hash, display_path, branch, head_commit
           from workspaces where id = $1`,
        ["wsp_contested"],
      );
      return rows.rows[0] ?? null;
    }, "the first environment's workspace");
    assert.equal(before.environment_id, first.environmentId);

    const second = await enrol({ projectId });
    assert.notEqual(second.environmentId, first.environmentId, "the two connectors shared an environment");
    const secondChannel = await openControlChannel(harness, second.identity);
    secondChannel.sendWorkspaceObservation({
      workspace_id: "wsp_contested",
      project_id: projectId,
      path_hash: `sha256:${"b".repeat(64)}`,
      display_label: "checkout-b",
      branch: "attacker-branch",
      head_commit: "2222222222222222222222222222222222222222",
      dirty: true,
    });

    const closed = await secondChannel.closed();
    assert.equal(closed.code, 1008);
    assert.equal(closed.reason, "PROJECT_NOT_AUTHORISED");

    const after = await harness.pool.query<typeof before>(
      `select environment_id, connector_id, path_hash, display_path, branch, head_commit
         from workspaces where id = $1`,
      ["wsp_contested"],
    );
    // Not one field of the first environment's record moved. Branch and head
    // commit especially: `docs/MCP_SPEC.md` §7.7 checks a verification's branch
    // against this row, so rewriting it is how an agent would come to claim a
    // fix against code nobody looked at.
    assert.deepEqual(after.rows[0], before, "another environment's workspace record was rewritten");
    const rows = await harness.pool.query<{ n: number }>("select count(*)::int as n from workspaces");
    assert.equal((rows.rows[0] as { n: number }).n, 1);
    firstChannel.close();
  });

  test("two environments with the same checkout path keep separate records", async () => {
    // `/home/dev/app` on two development machines is two checkouts. Migration
    // 0080 made `(project_id, path_hash)` unique, so they collided into one row
    // and rewrote each other every observation interval; 0081 puts the
    // environment in the key.
    const { projectId } = await seedProject();
    const samePath = `sha256:${"c".repeat(64)}`;
    const first = await enrol({ projectId });
    const second = await enrol({ projectId });
    const firstChannel = await openControlChannel(harness, first.identity);
    const secondChannel = await openControlChannel(harness, second.identity);

    firstChannel.sendWorkspaceObservation({
      workspace_id: "wsp_on_machine_one",
      project_id: projectId,
      path_hash: samePath,
      display_label: "app",
      branch: "main",
      head_commit: "1111111111111111111111111111111111111111",
      dirty: false,
    });
    secondChannel.sendWorkspaceObservation({
      workspace_id: "wsp_on_machine_two",
      project_id: projectId,
      path_hash: samePath,
      display_label: "app",
      branch: "feat/other",
      head_commit: "2222222222222222222222222222222222222222",
      dirty: true,
    });

    const both = await waitFor(async () => {
      const rows = await harness.pool.query<{ id: string; environment_id: string; branch: string }>(
        "select id, environment_id, branch from workspaces order by id",
      );
      return rows.rows.length === 2 ? rows.rows : null;
    }, "both environments to hold their own record");
    assert.deepEqual(
      both.map((row) => row.branch).sort(),
      ["feat/other", "main"],
      "the two machines overwrote each other",
    );
    assert.notEqual(both[0]?.environment_id, both[1]?.environment_id);
    firstChannel.close();
    secondChannel.close();
  });

  test("a workspace an operator registered is adopted rather than duplicated", async () => {
    // The documented behaviour of `docs/API.md` §4.3: an operator named a path,
    // a connector observes that same path, and they are one checkout. Adoption
    // is bounded to a row that belongs to no environment.
    const { projectId, organisationId } = await seedProject();
    const registered = await harness.built.workspaces.register({
      organisationId,
      projectId,
      rootPath: "/home/dev/refresh-surplus",
      branch: "main",
      headCommit: "1111111111111111111111111111111111111111",
    });
    const enrolled = await enrol({ projectId });
    const channel = await openControlChannel(harness, enrolled.identity);
    channel.sendWorkspaceObservation({
      workspace_id: "wsp_reported",
      project_id: projectId,
      path_hash: pathHash("/home/dev/refresh-surplus"),
      display_label: "refresh-surplus",
      branch: "feat/checkout-tidy",
      head_commit: "2222222222222222222222222222222222222222",
      dirty: true,
    });
    const adopted = await waitFor<{
      id: string;
      environment_id: string;
      source: string;
      branch: string;
    }>(async () => {
      const rows = await harness.pool.query<{
        id: string;
        environment_id: string;
        source: string;
        branch: string;
      }>("select id, environment_id, source, branch from workspaces");
      const row = rows.rows[0];
      return rows.rows.length === 1 && row !== undefined && row.environment_id !== null ? row : null;
    }, "the registered workspace to be adopted");
    assert.equal(adopted.id, registered.id, "adoption created a second record instead");
    assert.equal(adopted.environment_id, enrolled.environmentId);
    assert.equal(adopted.source, "connector_report");
    assert.equal(adopted.branch, "feat/checkout-tidy");
    channel.close();
  });

  test("the observed workspace reaches the project's environment view", async () => {
    const { projectId } = await seedProject();
    const enrolled = await enrol({ projectId });
    const channel = await openControlChannel(harness, enrolled.identity);
    channel.sendWorkspaceObservation({
      workspace_id: "wsp_refresh_surplus",
      project_id: projectId,
      branch: "main",
      head_commit: "4f3a9c1d2e8b7a6053f4e3d2c1b0a9f8e7d6c5b4",
      dirty: true,
    });
    await waitFor(async () => {
      const rows = await harness.pool.query("select 1 from workspaces where id = 'wsp_refresh_surplus'");
      return rows.rows.length === 1 ? true : null;
    }, "the workspace to be recorded");

    const cookies = await session();
    const response = await harness.built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/environments`,
      headers: cookies.readHeaders,
    });
    assert.equal(response.statusCode, 200, response.body);
    const workspaces = (
      response.json() as {
        data: { workspaces: { id: string; branch: string; dirty: boolean; display_path: string }[] }[];
      }
    ).data[0]?.workspaces;
    assert.equal(workspaces?.length, 1);
    assert.equal(workspaces?.[0]?.branch, "main");
    assert.equal(workspaces?.[0]?.dirty, true);
    assert.equal(workspaces?.[0]?.display_path, "refresh-surplus");
    channel.close();
  });
});

describe("what a connector credential is not", () => {
  test("an enrolled identity cannot obtain a human session or reach the administrative API", async () => {
    const { projectId } = await seedProject();
    const enrolled = await enrol({ projectId });

    // The certificate, its fingerprint and the connector identifier are the
    // only values a connector holds. None of them is a bearer credential on the
    // human API, and presenting one must not authenticate anything
    // (`docs/SECURITY.md` §6.3, `docs/TESTING.md` §10).
    for (const presented of [
      enrolled.connectorId,
      enrolled.identity.certificateFingerprint,
      enrolled.identity.certificatePem.replaceAll("\n", ""),
    ]) {
      for (const url of [
        "/api/v1/connectors",
        `/api/v1/environments/${enrolled.environmentId}`,
        "/api/v1/auth/sessions/current",
      ]) {
        const response = await harness.built.app.inject({
          method: "GET",
          url,
          headers: { authorization: `Bearer ${presented}` },
        });
        assert.equal(response.statusCode, 401, `${url} accepted a connector value: ${response.body}`);
      }
      const minted = await harness.built.app.inject({
        method: "POST",
        url: "/api/v1/connectors/enrolment-tokens",
        headers: { authorization: `Bearer ${presented}` },
        payload: {},
      });
      assert.equal(minted.statusCode, 401, `a connector value minted a token: ${minted.body}`);
    }
    const sessions = await harness.pool.query("select count(*)::int as n from viewer_sessions");
    assert.equal((sessions.rows[0] as { n: number }).n, 0, "a connector value created a human session");
  });

  test("a heartbeat flood is refused rather than served", async () => {
    const { projectId } = await seedProject();
    const enrolled = await enrol({ projectId });
    const channel = await openControlChannel(harness, enrolled.identity);
    for (let index = 0; index < 4 * (HeartbeatFloor.MAX_DROPPED + 4); index += 1) {
      channel.sendHeartbeat();
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Two bounds catch a flood, and which one arrives first depends on how fast
    // the consumer drains under load: the §7 burst bound refuses more frames
    // than the channel will buffer (1009), and the heartbeat floor refuses a
    // connector that keeps sending inside the minimum interval (1008,
    // `PROTOCOL_UNSUPPORTED`). Either is a refusal; asserting one of them
    // specifically here would make this test a timing measurement. The floor's
    // own arithmetic is asserted deterministically in "derivations" below.
    const closed = await channel.closed();
    assert.ok(
      closed.code === 1008 || closed.code === 1009,
      `the flood was served rather than refused: ${JSON.stringify(closed)}`,
    );
    if (closed.code === 1008) assert.equal(closed.reason, "PROTOCOL_UNSUPPORTED");

    // The flood cost the control plane a bounded number of transitions rather
    // than one event per frame.
    const events = await eventsOfType(harness.pool, projectId, "connector.connected");
    assert.ok(events.length <= 2, `a flood produced ${String(events.length)} connector.connected events`);
  });

  test("an oversized workspace observation is refused before it is parsed", async () => {
    const { projectId } = await seedProject();
    const enrolled = await enrol({ projectId });
    const channel = await openControlChannel(harness, enrolled.identity);
    // A frame past the §7 control-frame bound. The bound is applied to the raw
    // bytes, so nothing here is ever deserialised.
    channel.send(`{"protocol_version":1,"type":"workspace.observed","payload":"${"a".repeat(200_000)}"}`);
    const closed = await channel.closed();
    assert.ok(closed.code === 1009 || closed.code === 1007, `oversize was answered ${String(closed.code)}`);
    const rows = await harness.pool.query("select count(*)::int as n from workspaces");
    assert.equal((rows.rows[0] as { n: number }).n, 0);
  });
});

describe("the events this module writes satisfy their published schemas", () => {
  test("every connector and workspace event decodes through the generated codec", async () => {
    const { projectId, organisationId } = await seedProject();
    const enrolled = await enrol({ projectId });
    const channel = await openControlChannel(harness, enrolled.identity);
    await waitFor(async () => {
      const row = await harness.pool.query<{ status: string }>(
        "select status from connectors where id = $1",
        [enrolled.connectorId],
      );
      return row.rows[0]?.status === "ACTIVE" ? true : null;
    }, "the connector to become ACTIVE");

    channel.sendWorkspaceObservation({
      workspace_id: "wsp_refresh_surplus",
      project_id: projectId,
      repository_identity: "github.com/example/refresh-surplus",
      branch: "main",
      head_commit: "4f3a9c1d2e8b7a6053f4e3d2c1b0a9f8e7d6c5b4",
      dirty: false,
    });
    channel.sendWorkspaceObservation({
      workspace_id: "wsp_refresh_surplus",
      project_id: projectId,
      repository_identity: "github.com/example/refresh-surplus",
      branch: "feat/checkout-tidy",
      head_commit: "8b7a6053f4e3d2c1b0a9f8e7d6c5b44f3a9c1d2e",
      dirty: true,
    });
    await waitFor(async () => {
      const moved = await eventsOfType(harness.pool, projectId, "workspace.head_changed");
      return moved.length === 1 ? true : null;
    }, "the head change to be recorded");

    // Degradation and disconnection are conclusions the sweep draws from
    // silence, so they are produced here rather than waited for. Two sweeps,
    // because one silence long enough to disconnect skips `DEGRADED`
    // altogether: the sweep evaluates disconnection first, deliberately.
    await harness.pool.query(
      `update connectors
          set last_heartbeat_at = now() - make_interval(secs => $2)
        where id = $1`,
      [enrolled.connectorId, harness.connectorConfig.degradedAfterSeconds + 1],
    );
    const degraded = await sweepConnectorHealth(harness.pool, harness.connectorConfig);
    assert.deepEqual(degraded.degraded, [enrolled.connectorId]);
    await harness.pool.query(
      `update connectors
          set last_heartbeat_at = now() - make_interval(secs => $2)
        where id = $1`,
      [enrolled.connectorId, harness.connectorConfig.disconnectedAfterSeconds + 1],
    );
    const disconnected = await sweepConnectorHealth(harness.pool, harness.connectorConfig);
    assert.deepEqual(disconnected.disconnected, [enrolled.connectorId]);
    channel.close();
    await channel.closed();

    const cookies = await session();
    const revoked = await harness.built.app.inject({
      method: "POST",
      url: `/api/v1/connectors/${enrolled.connectorId}/revoke`,
      headers: cookies.writeHeaders,
    });
    assert.equal(revoked.statusCode, 200, revoked.body);

    // The stored rows are replayed through the generated decoder. This is what
    // stops `packages/protocol`'s payload schemas from describing an event
    // shape the control plane does not in fact write.
    const rows = await harness.pool.query<{
      id: string;
      schema_version: number;
      stream_key: string;
      sequence: string;
      type: string;
      occurred_at: Date;
      recorded_at: Date;
      organisation_id: string;
      project_id: string | null;
      actor_type: string;
      actor_id: string | null;
      actor_display: string | null;
      correlation: Record<string, string>;
      payload: Record<string, unknown>;
    }>(
      `select id, schema_version, stream_key, sequence, type, occurred_at, recorded_at,
              organisation_id, project_id, actor_type, actor_id, actor_display, correlation, payload
         from events
        where type like 'connector.%' or type like 'workspace.%'
        order by sequence`,
    );
    const seen = new Set<string>();
    for (const row of rows.rows) {
      const frame = {
        id: row.id,
        schema_version: row.schema_version,
        sequence: Number(row.sequence),
        type: row.type,
        occurred_at: row.occurred_at.toISOString(),
        recorded_at: row.recorded_at.toISOString(),
        organisation_id: row.organisation_id,
        ...(row.project_id === null ? {} : { project_id: row.project_id }),
        actor: {
          type: row.actor_type,
          ...(row.actor_id === null ? {} : { id: row.actor_id }),
          ...(row.actor_display === null ? {} : { display: row.actor_display }),
        },
        correlation: row.correlation,
        payload: row.payload,
      };
      const decoded = decodePlatformEvent(JSON.stringify(frame));
      assert.ok(
        decoded.ok,
        `${row.type} does not satisfy its published schema: ${
          decoded.ok ? "" : JSON.stringify(decoded.error)
        }`,
      );
      seen.add(row.type);
    }
    for (const type of [
      "connector.enrolled",
      "connector.connected",
      "connector.degraded",
      "connector.disconnected",
      "connector.revoked",
      "workspace.observed",
      "workspace.head_changed",
    ]) {
      assert.ok(seen.has(type), `${type} was never written, so nothing checked its shape`);
    }
    void organisationId;
  });
});

describe("the operator command line", () => {
  test("`reviewplane connector list` reports what is enrolled, and says so when nothing is", async () => {
    const { projectId } = await seedProject();

    const written: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    const previousUrl = process.env["REVIEWPLANE_DATABASE_URL"];
    process.env["REVIEWPLANE_DATABASE_URL"] = harness.databaseUrl;
    try {
      // Nothing enrolled: an empty report is an actionable one, not a blank.
      assert.equal(await main(["connector", "list"]), 0);
      assert.match(written.join(""), /no connector is enrolled/u);
      assert.match(written.join(""), /reviewplane-connector enrol/u);

      written.length = 0;
      const enrolled = await enrol({ projectId });
      assert.equal(await main(["connector", "list"]), 0);
      const report = written.join("");
      assert.match(report, new RegExp(enrolled.connectorId, "u"));
      assert.match(report, /PENDING_ENROLMENT/u);
      assert.match(report, /environment /u);
      assert.match(report, /last heartbeat/u);

      // It reads. There is no revoke here: revocation is an authorised, audited
      // action, and a command taking no credential could not record who did it.
      assert.equal(await main(["connector", "revoke", enrolled.connectorId]), 1);
    } finally {
      process.stdout.write = stdout;
      if (previousUrl === undefined) delete process.env["REVIEWPLANE_DATABASE_URL"];
      else process.env["REVIEWPLANE_DATABASE_URL"] = previousUrl;
    }
  });
});

describe("derivations", () => {
  test("a path hash is stable, prefixed and irreversible in shape", () => {
    const first = pathHash("/home/dan/projects/refresh-surplus");
    assert.equal(first, pathHash("/home/dan/projects/refresh-surplus"));
    assert.notEqual(first, pathHash("/home/dan/projects/other"));
    assert.match(first, /^sha256:[0-9a-f]{64}$/u);
    assert.ok(!first.includes("refresh-surplus"), "the digest leaks the path it was made from");
  });

  test("a display label is a directory name and never a path", () => {
    assert.equal(displayLabel("/home/dan/projects/refresh-surplus"), "refresh-surplus");
    assert.equal(displayLabel("/home/dan/projects/refresh-surplus/"), "refresh-surplus");
    assert.equal(displayLabel("C:\\work\\refresh-surplus"), "refresh-surplus");
    assert.equal(displayLabel("/"), "workspace");
    for (const label of [
      displayLabel("/home/dan/projects/refresh-surplus"),
      displayLabel("/a/b/c"),
      displayLabel(""),
    ]) {
      assert.ok(!label.includes("/") && !label.includes("\\"), `${label} is a path`);
    }
  });

  test("the enrolment command names the control plane over https and reads the token from a file", () => {
    const command = enrolmentCommand("wss://agents.example.internal:8443");
    assert.match(command, /--control-plane https:\/\/agents\.example\.internal:8443/u);
    assert.match(command, /--token-file/u);
    assert.ok(!command.includes("--token "), "the command puts a credential in the process table");
  });

  test("the heartbeat floor drops a flood and ends a channel that keeps it up", () => {
    const floor = new HeartbeatFloor(5_000);
    assert.equal(floor.admit(0), true, "the first heartbeat was dropped");
    assert.equal(floor.admit(10), false);
    assert.equal(floor.admit(5_000), true, "a heartbeat at the interval was dropped");
    assert.equal(floor.exhausted(), false, "one early heartbeat ended the channel");
    for (let index = 0; index <= HeartbeatFloor.MAX_DROPPED; index += 1) floor.admit(5_001);
    assert.equal(floor.exhausted(), true, "a sustained flood was not refused");
  });
});
