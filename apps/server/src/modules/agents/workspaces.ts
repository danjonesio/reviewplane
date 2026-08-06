/**
 * Workspaces (`docs/DOMAIN_MODEL.md` section 9).
 *
 * The workspace is the checkout an agent is working in. Stage 1's connector
 * reports it; Stage 0 registers it administratively, because
 * `docs/MCP_SPEC.md` section 4 has to answer session initialisation with a
 * branch and a head commit and a value the control plane invented would be
 * worse than an absent one.
 *
 * It exists in Stage 0 for one concrete reason beyond the answer shape: it is
 * what `finding_submit_verification` checks a claimed branch against. Without
 * it the branch on a verification is an unverifiable string.
 */

import type { Pool } from "pg";

import { ApiError, notFound } from "../../errors.ts";
import { newId } from "../../ids.ts";
import { displayLabel, pathHash } from "../connectors/workspaces.ts";

export interface WorkspaceRecord {
  readonly id: string;
  readonly organisation_id: string;
  readonly project_id: string;
  readonly root_path: string;
  readonly branch: string;
  readonly head_commit: string;
  readonly dirty: boolean;
}

interface WorkspaceRow {
  id: string;
  organisation_id: string;
  project_id: string;
  root_path: string;
  branch: string;
  head_commit: string;
  dirty: boolean;
}

export class WorkspaceStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * Registers or updates the workspace at one root path in one project.
   *
   * Upsert on `(project_id, root_path)` rather than insert-or-fail: a connector
   * reporting the same checkout after a commit is the normal case, and a second
   * row for the same directory would make "which workspace is this agent in"
   * ambiguous for the wrong reason.
   */
  async register(input: {
    readonly organisationId: string;
    readonly projectId: string;
    readonly rootPath: string;
    readonly branch: string;
    readonly headCommit: string;
    readonly dirty?: boolean;
    readonly connectorId?: string;
  }): Promise<WorkspaceRecord> {
    if (!/^[0-9a-f]{7,64}$/u.test(input.headCommit)) {
      throw new ApiError(
        "UNSUPPORTED_CAPABILITY",
        "head_commit must be 7 to 64 lowercase hexadecimal characters.",
        { field: "head_commit" },
      );
    }
    if (input.rootPath.trim() === "" || input.branch.trim() === "") {
      throw new ApiError("UNSUPPORTED_CAPABILITY", "root_path and branch are required.", {
        field: "root_path",
      });
    }
    // `path_hash` and `display_path` are derived from the same bytes a
    // connector would hash, so a checkout registered here and later observed by
    // a connector resolves to one row rather than two (RVP-20). The conflict
    // target is the path hash rather than the path: a connector-reported
    // workspace stores no path at all, and `(project_id, root_path)` cannot
    // match a row whose `root_path` is null.
    //
    // The target is qualified by `environment_id IS NULL` because that is the
    // index it names (migration 0081). A workspace registered here belongs to no
    // environment — nothing observed it — and it must not collide with a
    // checkout at the same path on a development machine, which is a different
    // record owned by the environment that reported it.
    const rows = await this.#pool.query<WorkspaceRow>(
      `INSERT INTO workspaces
         (id, organisation_id, project_id, connector_id, root_path, path_hash, display_path,
          branch, head_commit, dirty, source, last_seen_at, last_observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'administrative_registration', now(), now())
       ON CONFLICT (project_id, path_hash) WHERE environment_id IS NULL DO UPDATE
          SET branch = EXCLUDED.branch,
              head_commit = EXCLUDED.head_commit,
              dirty = EXCLUDED.dirty,
              connector_id = EXCLUDED.connector_id,
              root_path = EXCLUDED.root_path,
              display_path = EXCLUDED.display_path,
              updated_at = now(),
              last_seen_at = now(),
              last_observed_at = now()
       RETURNING id, organisation_id, project_id, root_path, branch, head_commit, dirty`,
      [
        newId("wsp_"),
        input.organisationId,
        input.projectId,
        input.connectorId ?? null,
        input.rootPath,
        pathHash(input.rootPath),
        displayLabel(input.rootPath),
        input.branch,
        input.headCommit,
        input.dirty ?? false,
      ],
    );
    const row = rows.rows[0];
    if (row === undefined) throw notFound("The workspace");
    return row;
  }

  /**
   * The workspaces of one project, inside one organisation.
   *
   * Both terms, and not one. `organisation_id` was in the SELECT list and
   * absent from the WHERE, so the query answered for whatever project
   * identifier reached it — and `root_path` is the developer machine's absolute
   * filesystem path, which `docs/DOMAIN_MODEL.md` section 9 reduces to
   * `path_hash` and `display_label` on the connector protocol *precisely so that
   * it is not disclosed*. Serving it to another tenant contradicted a stated
   * privacy property of the product rather than only an access rule (RVP-92).
   *
   * The organisation is required rather than optional. A caller that has not
   * resolved one has not authorised the read, and an optional parameter is a
   * term the next caller omits by accident.
   */
  async listForProject(projectId: string, organisationId: string): Promise<WorkspaceRecord[]> {
    const rows = await this.#pool.query<WorkspaceRow>(
      `SELECT id, organisation_id, project_id, root_path, branch, head_commit, dirty
         FROM workspaces
        WHERE project_id = $1 AND organisation_id = $2
        ORDER BY root_path LIMIT 50`,
      [projectId, organisationId],
    );
    return rows.rows;
  }

  /**
   * One workspace by identifier, inside one organisation.
   *
   * This read `WHERE id = $1` and left every caller to check the tenancy for
   * itself afterwards. Both callers did — `apps/mcp-server/src/tools.ts`
   * compares `project_id` against the session's project — but "the query
   * returns rows from other tenants and the caller is expected to drop them" is
   * the arrangement `docs/SECURITY.md` section 7 rules out: a row failing any
   * part of the predicate is not returned, rather than returned and then
   * rejected by a later branch.
   */
  async get(workspaceId: string, organisationId: string): Promise<WorkspaceRecord | null> {
    const rows = await this.#pool.query<WorkspaceRow>(
      `SELECT id, organisation_id, project_id, root_path, branch, head_commit, dirty
         FROM workspaces WHERE id = $1 AND organisation_id = $2`,
      [workspaceId, organisationId],
    );
    return rows.rows[0] ?? null;
  }

  /**
   * Resolves the workspace a session is in.
   *
   * A hint matching one workspace wins. No hint and exactly one workspace wins,
   * because there is nothing to be ambiguous about. No hint and several
   * workspaces resolves to none: the branch on a later verification is then
   * recorded with a warning rather than checked against a workspace picked at
   * random, which would be worse than not checking it.
   */
  async resolve(
    projectId: string,
    organisationId: string,
    hint: string | null,
  ): Promise<WorkspaceRecord | null> {
    const workspaces = await this.listForProject(projectId, organisationId);
    if (hint !== null && hint !== "") {
      const normalised = hint.replace(/\/+$/u, "");
      const matched = workspaces.filter(
        (workspace) =>
          workspace.id === hint || workspace.root_path.replace(/\/+$/u, "") === normalised,
      );
      return matched.length === 1 ? (matched[0] as WorkspaceRecord) : null;
    }
    return workspaces.length === 1 ? (workspaces[0] as WorkspaceRecord) : null;
  }
}
