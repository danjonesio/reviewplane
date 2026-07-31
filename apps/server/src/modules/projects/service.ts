/**
 * Projects: the principal working boundary (`docs/DOMAIN_MODEL.md` section 6,
 * `docs/API.md` section 8).
 *
 * Everything a review, a browser session, a connector or an artefact belongs to
 * hangs off a project, so three rules are enforced here rather than in a
 * handler:
 *
 *   * **A slug is unique inside an organisation**, and the uniqueness is the
 *     database's. Two requests creating `refresh-surplus` at the same instant
 *     are not resolved by a read followed by a write — one commits, the other
 *     is told the name is taken.
 *   * **Repository identity is normalised before it is stored** and its changes
 *     are audited separately from everything else, because a review's captured
 *     commit is interpreted against it: moving the repository quietly would
 *     reinterpret history.
 *   * **Every mutation carries a version**, so a concurrent editor is told its
 *     copy is stale instead of silently losing the other change.
 */

import {
  defaultProjectSettings,
  newEntityId,
  normaliseProjectSettings,
  normaliseRepositoryIdentity,
} from "@reviewplane/protocol/platform";
import type { Project, ProjectSettings, RepositoryIdentity } from "@reviewplane/protocol/platform";

import type { Pool, PoolClient } from "../../db/pool.ts";
import { ApiError, notFound } from "../../errors.ts";
import { appendEvent } from "../../events/append.ts";
import type { EventActor, EventPublisher } from "../../events/append.ts";
import { inTransaction } from "../../db/pool.ts";

/** PostgreSQL's `unique_violation`. */
const UNIQUE_VIOLATION = "23505";

/** The columns every representation is built from. */
const COLUMNS = `id, organisation_id, name, slug, repository_identity, default_branch,
                 status, settings, version, created_at, updated_at`;

export interface ProjectRow {
  readonly id: string;
  readonly organisation_id: string;
  readonly name: string;
  readonly slug: string;
  readonly repository_identity: RepositoryIdentity | null;
  readonly default_branch: string;
  readonly status: string;
  readonly settings: ProjectSettings;
  readonly version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export function projectView(row: ProjectRow): Project {
  return {
    id: row.id,
    organisation_id: row.organisation_id,
    name: row.name,
    slug: row.slug,
    ...(row.repository_identity === null ? {} : { repository_identity: row.repository_identity }),
    default_branch: row.default_branch,
    status: row.status === "archived" ? "archived" : "active",
    settings: row.settings,
    version: Number(row.version),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export interface CreateProjectInput {
  readonly organisationId: string;
  readonly name: string;
  readonly slug?: string | undefined;
  readonly repositoryIdentity?: unknown;
  readonly defaultBranch?: string | undefined;
  readonly settings?: unknown;
  readonly actor: EventActor;
  readonly requestId: string;
}

export interface UpdateProjectInput {
  readonly projectId: string;
  readonly organisationId: string;
  readonly expectedVersion?: number | undefined;
  readonly name?: string | undefined;
  readonly slug?: string | undefined;
  readonly repositoryIdentity?: unknown;
  readonly defaultBranch?: string | undefined;
  readonly settings?: unknown;
  readonly actor: EventActor;
  readonly requestId: string;
}

export class ProjectService {
  readonly #pool: Pool;
  readonly #events: EventPublisher | undefined;

  constructor(pool: Pool, events?: EventPublisher) {
    this.#pool = pool;
    this.#events = events;
  }

  async byId(projectId: string): Promise<ProjectRow | null> {
    const rows = await this.#pool.query<ProjectRow>(
      `SELECT ${COLUMNS} FROM projects WHERE id = $1`,
      [projectId],
    );
    return rows.rows[0] ?? null;
  }

  /**
   * Creates a project and the first event of its stream.
   *
   * The event is written to the new project's own stream, which is what makes
   * `project.created` the event a project's activity timeline begins at.
   */
  async create(input: CreateProjectInput): Promise<ProjectRow> {
    const name = readName(input.name);
    const slug = input.slug === undefined || input.slug === "" ? slugify(name) : readSlug(input.slug);
    const defaultBranch = readBranch(input.defaultBranch ?? "main");
    const settings = readSettings(input.settings);
    const repository =
      input.repositoryIdentity === undefined || input.repositoryIdentity === null
        ? null
        : readRepositoryIdentity(input.repositoryIdentity);

    const id = newEntityId("project");
    try {
      const created = await inTransaction(this.#pool, async (client) => {
        const rows = await client.query<ProjectRow>(
          `INSERT INTO projects
             (id, organisation_id, name, slug, repository_identity, default_branch, settings)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb)
           RETURNING ${COLUMNS}`,
          [
            id,
            input.organisationId,
            name,
            slug,
            repository === null ? null : JSON.stringify(repository),
            defaultBranch,
            JSON.stringify(settings),
          ],
        );
        const row = rows.rows[0];
        if (row === undefined) throw new Error("projects: the insert returned no row");

        const appended = await appendEvent(client, {
          type: "project.created",
          organisationId: input.organisationId,
          projectId: row.id,
          actor: input.actor,
          correlation: { request_id: input.requestId },
          payload: {
            slug: row.slug,
            name: row.name,
            default_branch: row.default_branch,
            ...(repository === null ? {} : { repository_canonical: repository.canonical }),
          },
        });
        return { row, appended };
      });
      this.#events?.publish(created.appended);
      return created.row;
    } catch (error) {
      throw translateSlugConflict(error, slug);
    }
  }

  /**
   * Applies a partial change.
   *
   * Two events, deciding different things, which is why neither is derived from
   * the other:
   *
   *   * `project.updated` names every attribute whose stored value moved,
   *     including `repository_identity`. A row that changed and produced no
   *     event would break "every meaningful state change produces an audit
   *     record" (`AGENTS.md`), and the shape that used to do it was a
   *     repository whose clone URLs changed while its canonical form did not
   *     (RVP-12 review, F3).
   *   * `project.repository_changed` fires only when the **canonical** identity
   *     moves, because that is the fact `docs/EVENTS.md` section 7 gives its own
   *     event: a review's captured commit is interpreted against it. Recording
   *     an added clone URL as a repository change would make a reader think the
   *     project's history had been reinterpreted when it had not.
   *
   * A patch that names attributes but moves none writes no event and does not
   * bump the version: repeating a request must not manufacture history.
   */
  async update(input: UpdateProjectInput): Promise<ProjectRow> {
    const name = input.name === undefined ? undefined : readName(input.name);
    const slug = input.slug === undefined ? undefined : readSlug(input.slug);
    const defaultBranch = input.defaultBranch === undefined ? undefined : readBranch(input.defaultBranch);
    const settings = input.settings === undefined ? undefined : readSettings(input.settings);
    const repository =
      input.repositoryIdentity === undefined ? undefined : readRepositoryIdentity(input.repositoryIdentity);

    if (name === undefined && slug === undefined && defaultBranch === undefined && settings === undefined && repository === undefined) {
      throw new ApiError("VALIDATION_FAILED", "The request changes nothing.", { reason: "empty_patch" });
    }

    try {
      const committed = await inTransaction(this.#pool, async (client) => {
        const current = await lockProject(client, input.projectId, input.organisationId);
        assertVersion(current, input.expectedVersion);

        const previousCanonical = current.repository_identity?.canonical ?? null;
        const repositoryChanged = repository !== undefined && repository.canonical !== previousCanonical;

        // What actually moved, compared against the stored row rather than
        // against which members the request happened to carry.
        const changes: string[] = [];
        if (name !== undefined && name !== current.name) changes.push("name");
        if (slug !== undefined && slug !== current.slug) changes.push("slug");
        if (defaultBranch !== undefined && defaultBranch !== current.default_branch) {
          changes.push("default_branch");
        }
        if (settings !== undefined && !sameJson(settings, current.settings)) changes.push("settings");
        if (repository !== undefined && !sameJson(repository, current.repository_identity)) {
          changes.push("repository_identity");
        }
        if (changes.length === 0) return { row: current, appended: [] };

        const rows = await client.query<ProjectRow>(
          `UPDATE projects
              SET name = COALESCE($3, name),
                  slug = COALESCE($4, slug),
                  default_branch = COALESCE($5, default_branch),
                  settings = COALESCE($6::jsonb, settings),
                  repository_identity = CASE WHEN $7::jsonb IS NULL THEN repository_identity ELSE $7::jsonb END,
                  version = version + 1,
                  updated_at = now()
            WHERE id = $1 AND organisation_id = $2
        RETURNING ${COLUMNS}`,
          [
            input.projectId,
            input.organisationId,
            name ?? null,
            slug ?? null,
            defaultBranch ?? null,
            settings === undefined ? null : JSON.stringify(settings),
            repository === undefined ? null : JSON.stringify(repository),
          ],
        );
        const row = rows.rows[0];
        if (row === undefined) throw notFound("The project");

        const appended = [
          await appendEvent(client, {
            type: "project.updated",
            organisationId: row.organisation_id,
            projectId: row.id,
            actor: input.actor,
            correlation: { request_id: input.requestId },
            payload: { changed_fields: changes },
          }),
        ];
        if (repositoryChanged && repository !== undefined) {
          appended.push(
            await appendEvent(client, {
              type: "project.repository_changed",
              organisationId: row.organisation_id,
              projectId: row.id,
              actor: input.actor,
              correlation: { request_id: input.requestId },
              payload: {
                ...(previousCanonical === null ? {} : { previous_canonical: previousCanonical }),
                new_canonical: repository.canonical,
              },
            }),
          );
        }
        return { row, appended };
      });
      for (const event of committed.appended) this.#events?.publish(event);
      return committed.row;
    } catch (error) {
      throw translateSlugConflict(error, slug ?? "");
    }
  }

  /**
   * Archives a project (`docs/API.md` section 8: "deletion should initially
   * archive and require a separate destructive purge flow").
   *
   * Archiving an already-archived project changes nothing and records nothing:
   * a repeated `DELETE` is the same request, and a second `project.archived`
   * would put an occurrence in the timeline that did not occur.
   */
  async archive(input: {
    readonly projectId: string;
    readonly organisationId: string;
    readonly expectedVersion?: number | undefined;
    readonly actor: EventActor;
    readonly requestId: string;
  }): Promise<ProjectRow> {
    const committed = await inTransaction(this.#pool, async (client) => {
      const current = await lockProject(client, input.projectId, input.organisationId);
      assertVersion(current, input.expectedVersion);
      if (current.status === "archived") return { row: current, appended: null };

      const rows = await client.query<ProjectRow>(
        `UPDATE projects
            SET status = 'archived', archived_at = now(), version = version + 1, updated_at = now()
          WHERE id = $1 AND organisation_id = $2
      RETURNING ${COLUMNS}`,
        [input.projectId, input.organisationId],
      );
      const row = rows.rows[0];
      if (row === undefined) throw notFound("The project");

      const appended = await appendEvent(client, {
        type: "project.archived",
        organisationId: row.organisation_id,
        projectId: row.id,
        actor: input.actor,
        correlation: { request_id: input.requestId },
        payload: { previous_status: current.status === "archived" ? "archived" : "active", new_status: "archived" },
      });
      return { row, appended };
    });
    if (committed.appended !== null) this.#events?.publish(committed.appended);
    return committed.row;
  }
}

/**
 * Reads the row for update, inside the caller's organisation.
 *
 * `FOR UPDATE` is what makes the version check a check rather than a guess: two
 * concurrent writers serialise here, so the second reads the version the first
 * wrote instead of the one it started from.
 */
async function lockProject(
  client: PoolClient,
  projectId: string,
  organisationId: string,
): Promise<ProjectRow> {
  const rows = await client.query<ProjectRow>(
    `SELECT ${COLUMNS} FROM projects WHERE id = $1 AND organisation_id = $2 FOR UPDATE`,
    [projectId, organisationId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw notFound("The project");
  return row;
}

/**
 * Whether two stored JSON values are the same document.
 *
 * Member order is normalised before comparison, because `jsonb` does not
 * preserve the order a value was written in: comparing the serialised forms
 * directly would report a change every time PostgreSQL happened to return the
 * members in a different order from the one the caller sent.
 */
function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${stableJson(member)}`).join(",")}}`;
}

function assertVersion(row: ProjectRow, expected: number | undefined): void {
  if (expected === undefined) return;
  if (Number(row.version) !== expected) {
    throw new ApiError("VERSION_CONFLICT", "The project changed since it was loaded.", {
      current_version: Number(row.version),
      expected_version: expected,
    });
  }
}

/**
 * Turns the unique-violation a duplicate slug produces into the stable refusal
 * `docs/API.md` section 8 documents.
 *
 * The database is what decides, which is why two callers racing the same slug
 * get one project and one refusal rather than two projects or a deadlock.
 */
function translateSlugConflict(error: unknown, slug: string): unknown {
  const code = (error as { code?: string }).code;
  const constraint = (error as { constraint?: string }).constraint;
  if (code === UNIQUE_VIOLATION && constraint === "projects_slug_unique_per_organisation") {
    return new ApiError(
      "VALIDATION_FAILED",
      `Another project in this organisation already uses the slug ${slug}.`,
      { field: "slug", reason: "slug_not_unique" },
    );
  }
  return error;
}

/** `Refresh Surplus` becomes `refresh-surplus`. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    // Combining marks left by NFKD: dropped so that an accented name slugs.
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 63)
    .replace(/-+$/gu, "");
  if (slug === "") {
    throw new ApiError(
      "VALIDATION_FAILED",
      "A project name must contain at least one letter or digit, or supply a slug directly.",
      { field: "slug", reason: "slug_empty" },
    );
  }
  return slug;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;
// eslint-disable-next-line no-control-regex -- the class exists to exclude them
const NAME_PATTERN = /^[^\u0000-\u001f\u007f]{1,200}$/u;

function readName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError("VALIDATION_FAILED", "A project name is required.", { field: "name" });
  }
  const name = value.trim();
  if (!NAME_PATTERN.test(name)) {
    throw new ApiError("VALIDATION_FAILED", "A project name must be at most 200 printable characters.", {
      field: "name",
    });
  }
  return name;
}

function readSlug(value: unknown): string {
  if (typeof value !== "string" || !SLUG_PATTERN.test(value)) {
    throw new ApiError(
      "VALIDATION_FAILED",
      "A slug is lowercase letters, digits and hyphens, starting with a letter or digit.",
      { field: "slug", reason: "slug_malformed" },
    );
  }
  return value;
}

function readBranch(value: unknown): string {
  if (typeof value !== "string" || !BRANCH_PATTERN.test(value)) {
    throw new ApiError("VALIDATION_FAILED", "That is not a branch name.", { field: "default_branch" });
  }
  return value;
}

function readSettings(value: unknown): ProjectSettings {
  const normalised = normaliseProjectSettings(value ?? defaultProjectSettings());
  if (!normalised.ok) {
    const first = normalised.violations[0];
    throw new ApiError(
      "VALIDATION_FAILED",
      first === undefined ? "The project settings are not valid." : first.message,
      {
        field: first === undefined ? "settings" : first.path.replace(/\[[0-9]+\]/gu, ""),
        reason: first === undefined ? "invalid" : first.code,
      },
    );
  }
  return normalised.value;
}

function readRepositoryIdentity(value: unknown): RepositoryIdentity {
  if (typeof value !== "string" && (typeof value !== "object" || value === null || Array.isArray(value))) {
    throw new ApiError(
      "VALIDATION_FAILED",
      "A repository identity is a clone URL, or an object holding clone_urls.",
      { field: "repository_identity" },
    );
  }
  const normalised = normaliseRepositoryIdentity(
    value as string | { canonical?: string; clone_urls?: readonly string[] },
  );
  if (!normalised.ok) {
    throw new ApiError(
      "VALIDATION_FAILED",
      REPOSITORY_MESSAGES[normalised.reason] ?? "That is not a repository this project can be associated with.",
      { field: "repository_identity", reason: normalised.reason },
    );
  }
  return { canonical: normalised.value.canonical, clone_urls: [...normalised.value.clone_urls] };
}

const REPOSITORY_MESSAGES: Readonly<Record<string, string>> = {
  empty: "A repository identity is required when the field is present.",
  too_long: "That repository URL is longer than this field accepts.",
  invalid_characters: "A repository URL must not contain spaces or control characters.",
  unsupported_scheme: "A repository URL must be an https, http, ssh or git remote.",
  missing_host: "That repository URL names no host.",
  missing_path: "That repository URL names a host but no repository.",
  inconsistent_urls: "Those clone URLs are for different repositories.",
  too_many_clone_urls: "At most eight clone URLs may be recorded for one project.",
};
