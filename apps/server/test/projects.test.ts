/**
 * Project management, against a real database (`docs/TESTING.md` section 2
 * "Component" and "Fault injection"; RVP-12).
 *
 * The project is "the principal working boundary" (`docs/DOMAIN_MODEL.md`
 * section 6), so the cases that matter most here are the ones about *edges*:
 * that a slug cannot be taken twice, that a viewport a browser would refuse
 * cannot be stored, that a stale editor is told rather than silently
 * overwritten, that archiving is not deletion, and that a session scoped to one
 * project can neither read another nor discover that it exists.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { DEFAULT_VALIDATION_VIEWPORTS } from "@reviewplane/protocol/platform";
import type { Project } from "@reviewplane/protocol/platform";

import { buildApp, type BuiltApp } from "../src/app.ts";
import { TEST_BOOTSTRAP_TOKEN, testServerConfig } from "./support/config.ts";
import { eventsOfType, readSessionCookies, seedAccount } from "./support/identity.ts";
import { startMigratedDatabase, truncateAll, type MigratedDatabase } from "./support/postgres.ts";

const PASSWORD = "correct horse battery staple";
const ADMIN = { authorization: `Bearer ${TEST_BOOTSTRAP_TOKEN}` };

let postgres: MigratedDatabase;
let built: BuiltApp;
let artefactRoot: string;
let account: Awaited<ReturnType<typeof seedAccount>>;
let cookies: ReturnType<typeof readSessionCookies>;

before(async () => {
  postgres = await startMigratedDatabase();
  artefactRoot = await mkdtemp(join(tmpdir(), "reviewplane-projects-"));
});

after(async () => {
  await built?.stop();
  await postgres?.stop();
  if (artefactRoot !== undefined) await rm(artefactRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await built?.stop();
  await truncateAll(postgres.pool);
  built = await buildApp({
    config: testServerConfig({ artefactPath: artefactRoot }),
    pool: postgres.pool,
    outboxPollIntervalMs: 20,
  });
  account = await seedAccount(postgres.pool);
  const token = await built.installTokens.issue({
    organisationId: account.organisationId,
    userId: account.userId,
  });
  const claimed = await built.app.inject({
    method: "POST",
    url: "/api/v1/auth/bootstrap",
    payload: { token: token.token, email: account.email, password: PASSWORD },
  });
  assert.equal(claimed.statusCode, 201, claimed.body);
  cookies = readSessionCookies(claimed);
});

async function createProject(payload: Record<string, unknown>) {
  return built.app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: cookies.writeHeaders,
    payload,
  });
}

function data(response: { json(): unknown }): Project {
  return (response.json() as { data: Project }).data;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

describe("creating a project", () => {
  test("a name becomes a slug, and the defaults are the two required viewports", async () => {
    const response = await createProject({ name: "Refresh Surplus" });
    assert.equal(response.statusCode, 201, response.body);
    const project = data(response);
    assert.equal(project.slug, "refresh-surplus");
    assert.equal(project.default_branch, "main");
    assert.equal(project.status, "active");
    assert.equal(project.version, 1);
    assert.deepEqual(project.settings.default_validation_viewports, [...DEFAULT_VALIDATION_VIEWPORTS]);
    assert.equal(project.organisation_id, account.organisationId);

    const created = await eventsOfType(postgres.pool, project.id, "project.created");
    assert.equal(created.length, 1);
    assert.equal(created[0]?.payload["slug"], "refresh-surplus");
    assert.equal(created[0]?.payload["default_branch"], "main");
  });

  test("a repository identity is normalised to the canonical form and audited", async () => {
    const response = await createProject({
      name: "Refresh Surplus",
      repository_identity: "git@github.com:example/refresh-surplus.git",
      default_branch: "develop",
    });
    assert.equal(response.statusCode, 201, response.body);
    const project = data(response);
    assert.equal(project.repository_identity?.canonical, "github.com/example/refresh-surplus");
    assert.deepEqual(project.repository_identity?.clone_urls, [
      "git@github.com:example/refresh-surplus.git",
    ]);
    assert.equal(project.default_branch, "develop");

    const created = await eventsOfType(postgres.pool, project.id, "project.created");
    assert.equal(created[0]?.payload["repository_canonical"], "github.com/example/refresh-surplus");
    process.stdout.write(`evidence: project.created ${JSON.stringify(created[0]?.payload)}\n`);
  });

  test("several clone URLs for one repository are accepted; for two they are not", async () => {
    const together = await createProject({
      name: "Together",
      repository_identity: {
        clone_urls: [
          "git@github.com:example/api.git",
          "https://github.com/example/api.git",
        ],
      },
    });
    assert.equal(together.statusCode, 201, together.body);
    assert.equal(data(together).repository_identity?.canonical, "github.com/example/api");

    const apart = await createProject({
      name: "Apart",
      repository_identity: {
        clone_urls: ["git@github.com:example/api.git", "git@github.com:example/web.git"],
      },
    });
    assert.equal(apart.statusCode, 422, apart.body);
    const error = (apart.json() as { error: { code: string; details?: { reason?: string } } }).error;
    assert.equal(error.code, "VALIDATION_FAILED");
    assert.equal(error.details?.reason, "inconsistent_urls");
  });

  test("a viewport outside the browser's bounds is refused", async () => {
    for (const viewport of [
      { width: 100, height: 100 },
      { width: 8000, height: 900 },
      { width: 390, height: 844, device_scale_factor: 9 },
    ]) {
      const response = await createProject({
        name: `Bounds ${String(viewport.width)}x${String(viewport.height)}`,
        settings: { default_validation_viewports: [viewport] },
      });
      assert.equal(response.statusCode, 422, response.body);
      assert.equal(
        (response.json() as { error: { code: string } }).error.code,
        "VALIDATION_FAILED",
      );
    }

    const accepted = await createProject({
      name: "Mobile only",
      settings: { default_validation_viewports: [{ width: 390, height: 844 }] },
    });
    assert.equal(accepted.statusCode, 201, accepted.body);
    assert.deepEqual(data(accepted).settings.default_validation_viewports, [
      { width: 390, height: 844 },
    ]);
  });

  test("two concurrent creations of one slug produce one project and one stable refusal", async () => {
    const [first, second] = await Promise.all([
      createProject({ name: "Refresh Surplus", slug: "refresh-surplus" }),
      createProject({ name: "Refresh Surplus", slug: "refresh-surplus" }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    assert.deepEqual(statuses, [201, 422], `${first.body} | ${second.body}`);

    const refused = first.statusCode === 422 ? first : second;
    const error = (refused.json() as { error: { code: string; details?: { reason?: string } } }).error;
    assert.equal(error.code, "VALIDATION_FAILED");
    assert.equal(error.details?.reason, "slug_not_unique");

    const rows = await postgres.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM projects WHERE slug = 'refresh-surplus'",
    );
    assert.equal(rows.rows[0]?.count, "1");
  });

  test("a name with nothing sluggable in it is refused rather than guessed at", async () => {
    const response = await createProject({ name: "!!!" });
    assert.equal(response.statusCode, 422, response.body);
    assert.equal(
      (response.json() as { error: { details?: { reason?: string } } }).error.details?.reason,
      "slug_empty",
    );
  });
});

// ---------------------------------------------------------------------------
// Reading, changing, archiving
// ---------------------------------------------------------------------------

describe("managing projects", () => {
  test("a change bumps the version and names what moved", async () => {
    const project = data(await createProject({ name: "Refresh Surplus" }));
    const patched = await built.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}`,
      headers: cookies.writeHeaders,
      payload: { name: "Refresh Surplus Storefront", expected_version: project.version },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.equal(data(patched).version, project.version + 1);

    const updated = await eventsOfType(postgres.pool, project.id, "project.updated");
    assert.deepEqual(updated[0]?.payload["changed_fields"], ["name"]);
  });

  test("a stale expected_version is refused with both halves of the conflict", async () => {
    const project = data(await createProject({ name: "Refresh Surplus" }));
    await built.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}`,
      headers: cookies.writeHeaders,
      payload: { name: "First" },
    });

    const stale = await built.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}`,
      headers: cookies.writeHeaders,
      payload: { name: "Second", expected_version: project.version },
    });
    assert.equal(stale.statusCode, 409, stale.body);
    const error = (
      stale.json() as { error: { code: string; details?: { current_version?: number; expected_version?: number } } }
    ).error;
    assert.equal(error.code, "VERSION_CONFLICT");
    assert.equal(error.details?.current_version, 2);
    assert.equal(error.details?.expected_version, 1);

    // The refused write changed nothing.
    const current = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}`,
      headers: cookies.readHeaders,
    });
    assert.equal(data(current).name, "First");
  });

  test("moving the repository is audited with both sides of the move", async () => {
    const project = data(
      await createProject({
        name: "Refresh Surplus",
        repository_identity: "https://github.com/example/refresh-surplus.git",
      }),
    );
    const moved = await built.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}`,
      headers: cookies.writeHeaders,
      payload: { repository_identity: "ssh://git@git.example.internal:2222/platform/refresh-surplus.git" },
    });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal(
      data(moved).repository_identity?.canonical,
      "git.example.internal:2222/platform/refresh-surplus",
    );

    const events = await eventsOfType(postgres.pool, project.id, "project.repository_changed");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.payload["previous_canonical"], "github.com/example/refresh-surplus");
    assert.equal(
      events[0]?.payload["new_canonical"],
      "git.example.internal:2222/platform/refresh-surplus",
    );
    process.stdout.write(
      `evidence: project.repository_changed ${JSON.stringify(events[0]?.payload)}\n`,
    );

    // Setting the same repository again — spelled differently, without the
    // scheme's default suffix — is not a move and records nothing.
    const same = await built.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}`,
      headers: cookies.writeHeaders,
      payload: { repository_identity: "ssh://git.example.internal:2222/platform/refresh-surplus" },
    });
    assert.equal(same.statusCode, 200, same.body);
    assert.equal((await eventsOfType(postgres.pool, project.id, "project.repository_changed")).length, 1);
  });

  test("a repository change that keeps the canonical form is still audited", async () => {
    // The review's F3: adding a clone URL for the repository the project
    // already points at changed the row, bumped the version and wrote no
    // event at all, because the change list never mentioned the field and the
    // repository event keys on the canonical form alone.
    const project = data(
      await createProject({
        name: "Refresh Surplus",
        repository_identity: "git@github.com:example/refresh-surplus.git",
      }),
    );

    const added = await built.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}`,
      headers: cookies.writeHeaders,
      payload: {
        repository_identity: {
          clone_urls: [
            "git@github.com:example/refresh-surplus.git",
            "https://github.com/example/refresh-surplus.git",
          ],
        },
      },
    });
    assert.equal(added.statusCode, 200, added.body);
    assert.equal(data(added).repository_identity?.clone_urls?.length, 2);
    assert.equal(data(added).version, project.version + 1);

    const updates = await eventsOfType(postgres.pool, project.id, "project.updated");
    assert.equal(updates.length, 1, "the change produced no event");
    assert.deepEqual(updates[0]?.payload["changed_fields"], ["repository_identity"]);

    // The canonical form did not move, so the timeline does not claim the
    // project's history was reinterpreted.
    assert.equal(
      (await eventsOfType(postgres.pool, project.id, "project.repository_changed")).length,
      0,
    );
  });

  test("a patch that moves nothing writes no event and does not bump the version", async () => {
    const project = data(await createProject({ name: "Refresh Surplus" }));
    const repeated = await built.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}`,
      headers: cookies.writeHeaders,
      payload: { name: "Refresh Surplus", default_branch: "main" },
    });
    assert.equal(repeated.statusCode, 200, repeated.body);
    assert.equal(data(repeated).version, project.version, "a no-op patch bumped the version");
    assert.equal((await eventsOfType(postgres.pool, project.id, "project.updated")).length, 0);
  });

  test("deleting archives, and archiving twice records one event", async () => {
    const project = data(await createProject({ name: "Refresh Surplus" }));
    const archived = await built.app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${project.id}`,
      headers: cookies.writeHeaders,
    });
    assert.equal(archived.statusCode, 200, archived.body);
    assert.equal(data(archived).status, "archived");

    const events = await eventsOfType(postgres.pool, project.id, "project.archived");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.payload["previous_status"], "active");
    assert.equal(events[0]?.payload["new_status"], "archived");

    const again = await built.app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${project.id}`,
      headers: cookies.writeHeaders,
    });
    assert.equal(again.statusCode, 200);
    assert.equal((await eventsOfType(postgres.pool, project.id, "project.archived")).length, 1);

    // Archiving is not deletion: the row, its events and its slug survive.
    const rows = await postgres.pool.query<{ status: string }>(
      "SELECT status FROM projects WHERE id = $1",
      [project.id],
    );
    assert.equal(rows.rows[0]?.status, "archived");

    // And it leaves the list by default, without disappearing from the API.
    const list = await built.app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: cookies.readHeaders,
    });
    assert.deepEqual((list.json() as { data: Project[] }).data, []);
    const withArchived = await built.app.inject({
      method: "GET",
      url: "/api/v1/projects?include_archived=true",
      headers: cookies.readHeaders,
    });
    assert.equal((withArchived.json() as { data: Project[] }).data.length, 1);
  });

  test("two projects run side by side and page independently", async () => {
    const first = data(await createProject({ name: "Refresh Surplus" }));
    const second = data(await createProject({ name: "Internal Tools" }));
    assert.notEqual(first.id, second.id);

    const page = await built.app.inject({
      method: "GET",
      url: "/api/v1/projects?limit=1",
      headers: cookies.readHeaders,
    });
    const body = page.json() as { data: Project[]; meta: { next_cursor?: string } };
    assert.equal(body.data.length, 1);
    assert.ok(body.meta.next_cursor !== undefined);

    const next = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects?limit=1&cursor=${encodeURIComponent(body.meta.next_cursor)}`,
      headers: cookies.readHeaders,
    });
    const rest = next.json() as { data: Project[]; meta: { next_cursor?: string } };
    assert.equal(rest.data.length, 1);
    assert.notEqual(rest.data[0]?.id, body.data[0]?.id);
    assert.equal(rest.meta.next_cursor, undefined);
  });

  test("projects created inside one millisecond are each returned exactly once", async () => {
    // The cursor carries `created_at.toISOString()`, which is milliseconds,
    // while `timestamptz` stores microseconds. This listing is `DESC` with
    // `<`, so an untruncated comparison rounds the cursor *down* and excludes
    // every row sharing its millisecond: the page after a boundary omits them
    // and the pager then reports no more pages. That is a lost project rather
    // than a repeated one, which is the worse half of the failure — and this is
    // the endpoint the web application lists projects from.
    //
    // The burst is written directly so the whole set genuinely shares one
    // truncated millisecond; going through the create route would spread them
    // across several and prove nothing.
    const seed = data(await createProject({ name: "Anchor" }));
    const burst = ["prj_burst0001", "prj_burst0002", "prj_burst0003", "prj_burst0004"];
    for (const id of burst) {
      await postgres.pool.query(
        `INSERT INTO projects (id, organisation_id, name, slug, default_branch, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'main',
                 timestamptz '2026-07-31 12:00:00.123456+00' + ($5 || ' microseconds')::interval,
                 now())`,
        [
          id,
          account.organisationId,
          id,
          id.replaceAll("_", "-"),
          String(burst.indexOf(id) * 100),
        ],
      );
    }

    // Paged one at a time, which is the shape that exposes the gap: every page
    // boundary lands inside the burst.
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const response = await built.app.inject({
        method: "GET",
        url: `/api/v1/projects?limit=1${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
        headers: cookies.readHeaders,
      });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json() as { data: Project[]; meta: { next_cursor?: string } };
      for (const project of body.data) seen.push(project.id);
      cursor = body.meta.next_cursor;
      pages += 1;
      assert.ok(pages <= 20, "the pager terminated");
    } while (cursor !== undefined);

    const expected = [...burst, seed.id].sort();
    assert.deepEqual(
      [...seen].sort(),
      expected,
      `missing ${expected.filter((id) => !seen.includes(id)).join(",")}`,
    );
    assert.equal(new Set(seen).size, seen.length, "no project was returned twice");
  });

  test("the activity timeline pages the project's own events, newest first", async () => {
    const project = data(await createProject({ name: "Refresh Surplus" }));
    for (const name of ["One", "Two", "Three"]) {
      await built.app.inject({
        method: "PATCH",
        url: `/api/v1/projects/${project.id}`,
        headers: cookies.writeHeaders,
        payload: { name },
      });
    }
    const activity = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/activity?limit=2`,
      headers: cookies.readHeaders,
    });
    assert.equal(activity.statusCode, 200, activity.body);
    const body = activity.json() as {
      data: { type: string; sequence: number }[];
      meta: { next_cursor?: string };
    };
    assert.equal(body.data.length, 2);
    assert.equal(body.data[0]?.type, "project.updated");
    assert.ok((body.data[0]?.sequence ?? 0) > (body.data[1]?.sequence ?? 0));
    assert.ok(body.meta.next_cursor !== undefined);
  });
});

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

describe("project authorisation", () => {
  /** A session scoped to one project, as ADR-0016 mints them. */
  async function projectScopedSession(projectId: string): Promise<{ cookie: string }> {
    const minted = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/viewer-sessions`,
      headers: ADMIN,
    });
    assert.equal(minted.statusCode, 201, minted.body);
    const token = (minted.json() as { data: { token: string } }).data.token;
    return { cookie: `reviewplane_viewer=${token}` };
  }

  test("a session scoped to project A cannot read project B or learn that it exists", async () => {
    const a = data(await createProject({ name: "Project A" }));
    const b = data(await createProject({ name: "Project B" }));
    const scoped = await projectScopedSession(a.id);
    const headers = { cookie: scoped.cookie };

    const own = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${a.id}`,
      headers,
    });
    assert.equal(own.statusCode, 200, own.body);

    // The foreign identifier answers exactly as an unknown one does: a
    // different code here would confirm that project B exists.
    const foreign = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${b.id}`,
      headers,
    });
    const invented = await built.app.inject({
      method: "GET",
      url: "/api/v1/projects/prj_00000000000000000000000000000000",
      headers,
    });
    assert.equal(foreign.statusCode, 404, foreign.body);
    assert.equal(invented.statusCode, 404);
    assert.deepEqual(
      (foreign.json() as { error: { code: string; message: string } }).error,
      (invented.json() as { error: { code: string; message: string } }).error,
    );
    process.stdout.write(`evidence: cross-project denial ${foreign.body}\n`);
    process.stdout.write(`evidence: unknown identifier  ${invented.body}\n`);

    // Nor can it enumerate: the list holds its own project and nothing else.
    const list = await built.app.inject({ method: "GET", url: "/api/v1/projects", headers });
    const listed = (list.json() as { data: Project[] }).data;
    assert.deepEqual(
      listed.map((project) => project.id),
      [a.id],
    );

    // And the activity timeline of the foreign project is equally invisible.
    const activity = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${b.id}/activity`,
      headers,
    });
    assert.equal(activity.statusCode, 404);
  });

  test("a project-scoped session cannot administer projects at all", async () => {
    const project = data(await createProject({ name: "Project A" }));
    const scoped = await projectScopedSession(project.id);
    const headers = { cookie: scoped.cookie };

    for (const request of [
      { method: "POST" as const, url: "/api/v1/projects", payload: { name: "Another" } },
      { method: "PATCH" as const, url: `/api/v1/projects/${project.id}`, payload: { name: "Renamed" } },
      { method: "DELETE" as const, url: `/api/v1/projects/${project.id}` },
    ]) {
      const response = await built.app.inject({ ...request, headers });
      assert.equal(response.statusCode, 403, `${request.method} ${request.url}: ${response.body}`);
      assert.equal(
        (response.json() as { error: { code: string } }).error.code,
        "AUTHORISATION_DENIED",
      );
    }
  });

  test("an unauthenticated request reaches no project surface", async () => {
    const project = data(await createProject({ name: "Project A" }));
    for (const request of [
      { method: "GET" as const, url: "/api/v1/projects" },
      { method: "GET" as const, url: `/api/v1/projects/${project.id}` },
      { method: "GET" as const, url: `/api/v1/projects/${project.id}/activity` },
      { method: "POST" as const, url: "/api/v1/projects", payload: { name: "Another" } },
    ]) {
      const response = await built.app.inject(request);
      assert.equal(response.statusCode, 401, `${request.method} ${request.url}: ${response.body}`);
    }
  });
});
