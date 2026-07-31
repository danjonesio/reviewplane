/**
 * Workspace observations reported by a connector
 * (`docs/CONNECTOR_PROTOCOL.md` §9, `docs/DOMAIN_MODEL.md` §9, ADR-0022).
 *
 * What arrives here is a **claim**, never an authorisation. A connector states
 * which project a checkout belongs to, and this module re-derives whether it
 * may: the project identifier, the organisation the certificate resolved to and
 * the project the identity was enrolled for all appear in one predicate, so a
 * project the connector may not touch produces no row rather than a row that a
 * later `if` has to remember to reject.
 *
 * What may be recorded is bounded by the schema rather than by this code. The
 * version 1 `workspace_observation` payload has members for repository
 * identity, branch, head commit, dirty state, a display label and a path hash,
 * and no member capable of carrying source file contents, a changed-path list
 * or a full filesystem path. That is the mechanism behind "source file contents
 * are not reported".
 */

import { createHash } from "node:crypto";

import type { WorkspaceObservation } from "@reviewplane/protocol";

import type { Pool, PoolClient } from "../../db/pool.ts";
import { inTransaction } from "../../db/pool.ts";
import { appendEvent, type AppendedEvent } from "../../events/append.ts";
import { newId } from "../../ids.ts";

/**
 * Bound on the workspaces one environment may hold in one project.
 *
 * A connector chooses its own workspace identifiers (`docs/CONNECTOR_PROTOCOL.md`
 * §20: "id is the workspace identifier a publication names"), so without a
 * bound an environment could fill the table with identifiers nothing will ever
 * use. The bound is generous for a development machine and finite for a hostile
 * one.
 */
export const MAX_WORKSPACES_PER_ENVIRONMENT = 32;

/** Why an observation was refused. Stable, so a caller can map it to a class. */
export type ObservationRefusal = "project_not_authorised" | "workspace_limit_exceeded";

export class WorkspaceObservationRefused extends Error {
  readonly reason: ObservationRefusal;

  constructor(reason: ObservationRefusal, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "WorkspaceObservationRefused";
    this.reason = reason;
  }
}

/** How a workspace came to be known (`packages/protocol` `workspace_observation_source`). */
export type WorkspaceSource = "connector_report" | "administrative_registration";

export interface WorkspaceRow {
  id: string;
  organisation_id: string;
  project_id: string;
  environment_id: string | null;
  connector_id: string | null;
  path_hash: string;
  display_path: string;
  repository_identity: string | null;
  branch: string;
  head_commit: string;
  dirty: boolean;
  source: WorkspaceSource;
  last_observed_at: Date | null;
}

const WORKSPACE_COLUMNS = `id, organisation_id, project_id, environment_id, connector_id, path_hash,
  display_path, repository_identity, branch, head_commit, dirty, source, last_observed_at`;

/** What the observation changed, which is what decides the event. */
export type ObservationOutcome = "created" | "head_changed" | "unchanged";

export interface RecordedObservation {
  readonly outcome: ObservationOutcome;
  readonly workspace: WorkspaceRow;
  readonly event: AppendedEvent | null;
}

/**
 * Derives the stable digest of an absolute path.
 *
 * The control plane computes this only for a workspace an operator registered
 * by path; a connector-reported workspace arrives with the digest already
 * computed on the development machine, and its path never leaves it. Both sides
 * hash the same bytes, so a checkout registered administratively and later
 * observed by a connector resolves to one row.
 */
export function pathHash(absolutePath: string): string {
  return `sha256:${createHash("sha256").update(absolutePath, "utf8").digest("hex")}`;
}

/**
 * Derives a display label from a path.
 *
 * `docs/DOMAIN_MODEL.md` §9 asks the control plane to avoid storing
 * unnecessary full filesystem paths, so what is kept is the checkout
 * directory's own name. Anything that would make the value a path again — a
 * separator, a control character — is refused by the column constraint, and
 * this function does not produce one.
 */
export function displayLabel(absolutePath: string): string {
  const trimmed = absolutePath.replace(/[/\\]+$/u, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const base = separator === -1 ? trimmed : trimmed.slice(separator + 1);
  // Filtered by code point rather than by a regular expression, so that the
  // control characters this refuses are named in the source rather than being
  // embedded in it as the bytes themselves.
  const sanitised = [...base]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join("")
    .slice(0, 128);
  return sanitised === "" ? "workspace" : sanitised;
}

export interface ObservationContext {
  readonly organisationId: string;
  /** The connector the mutually authenticated channel resolved to. */
  readonly connectorId: string;
  readonly environmentId: string;
  /**
   * The project the identity was enrolled for, or null for an
   * organisation-scoped enrolment. It narrows the predicate; it never widens
   * it.
   */
  readonly enrolledProjectId: string | null;
  readonly requestId: string;
}

/**
 * Records one observation, emitting the event the change deserves.
 *
 * An unchanged repeat refreshes `last_observed_at` and writes no event: a
 * connector reports every thirty seconds, and `docs/EVENTS.md` §7 requires a
 * high-frequency signal to be sampled or summarised rather than emitted as a
 * durable event for every occurrence.
 */
export async function recordObservation(
  pool: Pool,
  context: ObservationContext,
  observation: WorkspaceObservation,
): Promise<RecordedObservation> {
  return inTransaction(pool, async (client) => {
    await assertProjectAuthorised(client, context, observation.project_id);

    // What this connector may act on, and what merely exists.
    //
    // A workspace **identifier** is global, so a row carrying the reported one
    // is a candidate wherever it lives: if it turns out to belong to another
    // environment, that is the collision ADR-0022 point 8 refuses, and it has to
    // be seen in order to be refused.
    //
    // A **path hash** is not global. `/home/dev/app` on two development machines
    // is two checkouts, not one, so a path match is a candidate only when the
    // row belongs to this environment or to no environment at all. Matching one
    // across environments is what made two machines with the same layout fight
    // over a single row.
    const existing = await client.query<WorkspaceRow>(
      `select ${WORKSPACE_COLUMNS}
         from workspaces
        where organisation_id = $1
          and project_id = $2
          and (
                id = $3
             or (path_hash = $4 and (environment_id = $5 or environment_id is null))
          )
        order by (id = $3) desc
        limit 1
          for update`,
      [
        context.organisationId,
        observation.project_id,
        observation.workspace_id,
        observation.path_hash,
        context.environmentId,
      ],
    );
    const previous = existing.rows[0];

    if (previous === undefined) {
      return insertObserved(client, context, observation);
    }
    // The ownership check is here rather than folded into the predicate above,
    // because a row owned by another environment must be **refused** rather than
    // skipped. Skipping it would insert a second row under a primary key that is
    // already taken, and the caller would learn about the collision as a
    // constraint violation rather than as the authorisation failure it is.
    //
    // A row with no environment was registered administratively
    // (`docs/API.md` §4.3) and is adopted: an operator named that exact path and
    // this connector observes that exact path, so they are the same checkout and
    // two records for it would make "which workspace is this agent in"
    // ambiguous for the wrong reason.
    if (previous.environment_id !== null && previous.environment_id !== context.environmentId) {
      throw new WorkspaceObservationRefused(
        "project_not_authorised",
        "the reported workspace identifier belongs to another environment",
      );
    }
    return updateObserved(client, context, observation, previous);
  });
}

/**
 * Refuses a project this identity may not act for.
 *
 * The identifier, the organisation and the enrolled project scope are one
 * predicate. A project in another organisation and a project that does not
 * exist are therefore indistinguishable from here, which is the point: telling
 * them apart is an existence oracle (`docs/API.md` §5).
 */
async function assertProjectAuthorised(
  client: PoolClient,
  context: ObservationContext,
  projectId: string,
): Promise<void> {
  const authorised = await client.query<{ id: string }>(
    `select id from projects
      where id = $1
        and organisation_id = $2
        and ($3::text is null or id = $3)`,
    [projectId, context.organisationId, context.enrolledProjectId],
  );
  if (authorised.rows.length === 0) {
    throw new WorkspaceObservationRefused(
      "project_not_authorised",
      "the connector reported a workspace for a project it is not enrolled for",
    );
  }
}

async function insertObserved(
  client: PoolClient,
  context: ObservationContext,
  observation: WorkspaceObservation,
): Promise<RecordedObservation> {
  const held = await client.query<{ count: string }>(
    `select count(*)::text as count from workspaces
      where organisation_id = $1 and project_id = $2 and environment_id = $3`,
    [context.organisationId, observation.project_id, context.environmentId],
  );
  if (Number(held.rows[0]?.count ?? "0") >= MAX_WORKSPACES_PER_ENVIRONMENT) {
    throw new WorkspaceObservationRefused(
      "workspace_limit_exceeded",
      `an environment may hold at most ${String(MAX_WORKSPACES_PER_ENVIRONMENT)} workspaces in one project`,
    );
  }

  // The connector's own identifier is used when it is free. It is the value a
  // route publication names (`docs/CONNECTOR_PROTOCOL.md` §11), so inventing a
  // different one here would mean the connector could never match a publication
  // to the checkout it published from. `on conflict do nothing` is what keeps
  // that from being a way to claim somebody else's identifier: a taken one
  // inserts no row, and the refusal below is the same one a foreign project
  // gets.
  const inserted = await client.query<WorkspaceRow>(
    `insert into workspaces
       (id, organisation_id, project_id, environment_id, connector_id, path_hash, display_path,
        repository_identity, branch, head_commit, dirty, source, last_observed_at, last_seen_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'connector_report', now(), now())
     on conflict do nothing
     returning ${WORKSPACE_COLUMNS}`,
    [
      observation.workspace_id,
      context.organisationId,
      observation.project_id,
      context.environmentId,
      context.connectorId,
      observation.path_hash,
      observation.display_label,
      observation.repository_identity ?? null,
      observation.branch,
      observation.head_commit,
      observation.dirty,
    ],
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    throw new WorkspaceObservationRefused(
      "project_not_authorised",
      "the reported workspace identifier is already held elsewhere",
    );
  }

  const event = await appendEvent(client, {
    type: "workspace.observed",
    organisationId: context.organisationId,
    projectId: observation.project_id,
    actor: { type: "connector", id: context.connectorId },
    correlation: {
      request_id: context.requestId,
      connector_id: context.connectorId,
      environment_id: context.environmentId,
      workspace_id: row.id,
    },
    payload: {
      workspace_id: row.id,
      environment_id: context.environmentId,
      path_hash: row.path_hash,
      display_path: row.display_path,
      ...(row.repository_identity === null ? {} : { repository_identity: row.repository_identity }),
      branch: row.branch,
      head_commit: row.head_commit,
      dirty: row.dirty,
      source: "connector_report",
    },
  });
  return { outcome: "created", workspace: row, event };
}

async function updateObserved(
  client: PoolClient,
  context: ObservationContext,
  observation: WorkspaceObservation,
  previous: WorkspaceRow,
): Promise<RecordedObservation> {
  const moved =
    previous.branch !== observation.branch ||
    previous.head_commit !== observation.head_commit ||
    previous.dirty !== observation.dirty;

  // The predicate repeats the ownership the caller established, so that this
  // statement cannot write outside it even if it is ever reached another way. A
  // row that changed hands between the locked read and here updates nothing and
  // is refused rather than silently rewritten.
  const updated = await client.query<WorkspaceRow>(
    `update workspaces
        set environment_id      = $2,
            connector_id        = $3,
            path_hash           = $4,
            display_path        = $5,
            repository_identity = $6,
            branch              = $7,
            head_commit         = $8,
            dirty               = $9,
            source              = 'connector_report',
            updated_at          = now(),
            last_observed_at    = now(),
            last_seen_at        = now()
      where id = $1
        and organisation_id = $10
        and project_id = $11
        and (environment_id is null or environment_id = $2)
      returning ${WORKSPACE_COLUMNS}`,
    [
      previous.id,
      context.environmentId,
      context.connectorId,
      observation.path_hash,
      observation.display_label,
      observation.repository_identity ?? null,
      observation.branch,
      observation.head_commit,
      observation.dirty,
      context.organisationId,
      observation.project_id,
    ],
  );
  const row = updated.rows[0];
  if (row === undefined) {
    throw new WorkspaceObservationRefused(
      "project_not_authorised",
      "the reported workspace could not be updated inside this scope",
    );
  }
  if (!moved) return { outcome: "unchanged", workspace: row, event: null };

  const event = await appendEvent(client, {
    type: "workspace.head_changed",
    organisationId: context.organisationId,
    projectId: observation.project_id,
    actor: { type: "connector", id: context.connectorId },
    correlation: {
      request_id: context.requestId,
      connector_id: context.connectorId,
      environment_id: context.environmentId,
      workspace_id: row.id,
    },
    payload: {
      workspace_id: row.id,
      environment_id: context.environmentId,
      previous_branch: previous.branch,
      previous_head_commit: previous.head_commit,
      previous_dirty: previous.dirty,
      branch: row.branch,
      head_commit: row.head_commit,
      dirty: row.dirty,
    },
  });
  return { outcome: "head_changed", workspace: row, event };
}

/** The workspaces held in one project, for the environment view of `docs/API.md` §9. */
export async function listWorkspacesForProject(
  pool: Pool,
  input: { readonly organisationId: string; readonly projectId: string },
): Promise<WorkspaceRow[]> {
  const result = await pool.query<WorkspaceRow>(
    `select ${WORKSPACE_COLUMNS} from workspaces
      where organisation_id = $1 and project_id = $2
      order by display_path
      limit 200`,
    [input.organisationId, input.projectId],
  );
  return result.rows;
}

/** The workspaces held by one environment. */
export async function listWorkspacesForEnvironments(
  pool: Pool,
  environmentIds: readonly string[],
): Promise<WorkspaceRow[]> {
  if (environmentIds.length === 0) return [];
  const result = await pool.query<WorkspaceRow>(
    `select ${WORKSPACE_COLUMNS} from workspaces
      where environment_id = any($1::text[])
      order by display_path
      limit 400`,
    [[...environmentIds]],
  );
  return result.rows;
}

/** Mints a workspace identifier for a workspace the control plane creates itself. */
export function newWorkspaceId(): string {
  return newId("wsp_");
}
