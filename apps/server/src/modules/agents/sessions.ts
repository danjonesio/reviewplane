/**
 * Agent sessions (`docs/DOMAIN_MODEL.md` section 11) and the project resolution
 * of `docs/MCP_SPEC.md` section 4.
 *
 * Two invariants of section 11 are the reason this is a store rather than a
 * field on a connection object.
 *
 * **Agent identity and human identity are distinct actors.** Every write an
 * agent makes is attributed to an `agent_session` actor with this row's
 * identifier, so the event stream records which agent session did what, and the
 * authority rules of `docs/DOMAIN_MODEL.md` section 15 have something concrete
 * to decide on.
 *
 * **An agent session cannot grant itself permissions beyond its issued
 * capability set.** The capabilities are copied onto the row when the session
 * opens and are read from the row afterwards, so a later change to the
 * credential cannot widen a session that is already running, and an audit
 * record says what the session was allowed to do at the time.
 *
 * Project resolution lives here because it is a domain decision and not a
 * transport one: the credential's binding, the hint and the project table
 * together decide, and where more than one answer survives the session is
 * refused rather than resolved by guessing.
 */

import type { Pool } from "pg";

import { inTransaction } from "../../db/pool.ts";
import { ApiError, notFound } from "../../errors.ts";
import { appendEvent, type EventActor } from "../../events/append.ts";
import { newId } from "../../ids.ts";
import type { AgentCredential } from "./credentials.ts";
import type { WorkspaceRecord, WorkspaceStore } from "./workspaces.ts";

export type AgentSessionStatus =
  | "STARTING"
  | "ACTIVE"
  | "WAITING"
  | "BLOCKED"
  | "DISCONNECTED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface ProjectReference {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface AgentSessionRecord {
  readonly id: string;
  readonly organisationId: string;
  readonly projectId: string;
  readonly credentialId: string;
  readonly workspaceId: string | null;
  readonly agentType: string;
  readonly agentVersion: string;
  readonly capabilities: readonly string[];
  readonly clientCapabilities: Readonly<Record<string, boolean>>;
  readonly status: AgentSessionStatus;
  readonly startedAt: string;
}

/** The actor an agent session acts as (`docs/EVENTS.md` section 5). */
export function agentActor(session: AgentSessionRecord, display?: string): EventActor {
  return {
    type: "agent_session",
    id: session.id,
    display: display ?? `${session.agentType} ${session.agentVersion}`.trim(),
  };
}

interface SessionRow {
  id: string;
  organisation_id: string;
  project_id: string;
  credential_id: string;
  workspace_id: string | null;
  agent_type: string;
  agent_version: string;
  capabilities: string[];
  client_capabilities: Record<string, boolean>;
  status: AgentSessionStatus;
  started_at: Date;
}

function toRecord(row: SessionRow): AgentSessionRecord {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    projectId: row.project_id,
    credentialId: row.credential_id,
    workspaceId: row.workspace_id,
    agentType: row.agent_type,
    agentVersion: row.agent_version,
    capabilities: row.capabilities,
    clientCapabilities: row.client_capabilities,
    status: row.status,
    startedAt: row.started_at.toISOString(),
  };
}

export class AgentSessionStore {
  readonly #pool: Pool;
  readonly #workspaces: WorkspaceStore;

  constructor(pool: Pool, workspaces: WorkspaceStore) {
    this.#pool = pool;
    this.#workspaces = workspaces;
  }

  /**
   * Resolves the project a session will be bound to.
   *
   * The credential's project set is the outer bound and a hint may only narrow
   * it. Where the result is not exactly one project the caller is refused with
   * `PROJECT_CONTEXT_AMBIGUOUS` and the candidates, so an agent can name the
   * project it meant. The server never picks: picking would mean an agent could
   * silently do work in the wrong project, which is the failure that costs most
   * to discover late.
   */
  async resolveProject(
    credential: AgentCredential,
    hint: string | null,
  ): Promise<ProjectReference> {
    const rows = await this.#pool.query<{ id: string; slug: string; name: string }>(
      `SELECT id, slug, name FROM projects
        WHERE id = ANY($1) AND organisation_id = $2 AND status = 'active'
        ORDER BY slug`,
      [[...credential.projectIds], credential.organisationId],
    );
    const bound = rows.rows;
    if (bound.length === 0) {
      throw new ApiError(
        "PROJECT_CONTEXT_MISMATCH",
        "This credential is bound to no project that still exists.",
      );
    }

    const candidates =
      hint === null || hint === ""
        ? bound
        : bound.filter((project) => project.id === hint || project.slug === hint);

    if (candidates.length === 1) return candidates[0] as ProjectReference;
    if (candidates.length === 0) {
      // The hint named something outside the credential's binding. Reporting a
      // mismatch rather than a not-found keeps the two cases distinguishable
      // for an operator without telling the caller whether the project exists.
      throw new ApiError(
        "PROJECT_CONTEXT_MISMATCH",
        `No project this credential is bound to matches the hint ${hint ?? ""}.`,
        { field: "project_hint" },
      );
    }
    throw new ApiError(
      "PROJECT_CONTEXT_AMBIGUOUS",
      "This credential is bound to more than one project. Name one in project_hint; the control plane will not choose for you.",
      {
        field: "project_hint",
        candidates: candidates.map((project) => ({
          id: project.id,
          slug: project.slug,
          name: project.name,
        })),
      },
    );
  }

  /**
   * Starts a session and records `agent_session.started`.
   *
   * The workspace is resolved here so the session carries the branch and commit
   * it started against, which is what a later verification is corroborated
   * with.
   */
  async start(input: {
    readonly credential: AgentCredential;
    readonly project: ProjectReference;
    readonly workspaceHint: string | null;
    readonly agentType: string;
    readonly agentVersion: string;
    readonly clientCapabilities: Readonly<Record<string, boolean>>;
    readonly transportSessionId: string;
  }): Promise<{ session: AgentSessionRecord; workspace: WorkspaceRecord | null }> {
    // The organisation comes from the credential rather than from the project
    // row: it is the tenant the caller authenticated as, and an agent
    // credential's organisation is non-nullable by construction.
    const workspace = await this.#workspaces.resolve(
      input.project.id,
      input.credential.organisationId,
      input.workspaceHint,
    );
    const id = newId("ags_");
    const session = await inTransaction(this.#pool, async (client) => {
      const inserted = await client.query<SessionRow>(
        `INSERT INTO agent_sessions
           (id, organisation_id, project_id, credential_id, workspace_id, agent_type,
            agent_version, capabilities, client_capabilities, transport_session_id,
            branch, head_commit, status, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,'ACTIVE',now())
         RETURNING id, organisation_id, project_id, credential_id, workspace_id, agent_type,
                   agent_version, capabilities, client_capabilities, status, started_at`,
        [
          id,
          input.credential.organisationId,
          input.project.id,
          input.credential.id,
          workspace?.id ?? null,
          input.agentType,
          input.agentVersion,
          [...input.credential.capabilities],
          JSON.stringify(input.clientCapabilities),
          input.transportSessionId,
          workspace?.branch ?? null,
          workspace?.head_commit ?? null,
        ],
      );
      const record = toRecord(inserted.rows[0] as SessionRow);
      await appendEvent(client, {
        type: "agent_session.started",
        organisationId: record.organisationId,
        projectId: record.projectId,
        actor: agentActor(record),
        correlation: { agent_session_id: record.id },
        payload: {
          agent_session_id: record.id,
          // The client names itself and the name is recorded as description.
          // It is never an authorisation input: the credential decides.
          agent_type: record.agentType,
          agent_version: record.agentVersion,
          capabilities: [...record.capabilities],
          client_capabilities: record.clientCapabilities,
          workspace_id: record.workspaceId,
          credential_id: record.credentialId,
        },
      });
      return record;
    });
    return { session, workspace };
  }

  /**
   * Reads a session by its transport identifier, checking the credential.
   *
   * The credential check is what stops one agent resuming another's session by
   * presenting its transport identifier: possession of the identifier proves
   * nothing, exactly as an artefact grant identifier proves nothing (ADR-0019).
   */
  async forTransport(
    transportSessionId: string,
    credentialId: string,
  ): Promise<AgentSessionRecord | null> {
    const rows = await this.#pool.query<SessionRow>(
      `SELECT id, organisation_id, project_id, credential_id, workspace_id, agent_type,
              agent_version, capabilities, client_capabilities, status, started_at
         FROM agent_sessions
        WHERE transport_session_id = $1 AND credential_id = $2 AND ended_at IS NULL`,
      [transportSessionId, credentialId],
    );
    const row = rows.rows[0];
    if (row === undefined) return null;
    await this.#pool.query("UPDATE agent_sessions SET last_seen_at = now() WHERE id = $1", [
      row.id,
    ]);
    return toRecord(row);
  }

  async get(agentSessionId: string): Promise<AgentSessionRecord> {
    const rows = await this.#pool.query<SessionRow>(
      `SELECT id, organisation_id, project_id, credential_id, workspace_id, agent_type,
              agent_version, capabilities, client_capabilities, status, started_at
         FROM agent_sessions WHERE id = $1`,
      [agentSessionId],
    );
    const row = rows.rows[0];
    if (row === undefined) throw notFound("The agent session");
    return toRecord(row);
  }

  /** Ends a session and records why (`docs/EVENTS.md` section 7). */
  async end(agentSessionId: string, status: AgentSessionStatus, reason: string): Promise<void> {
    const session = await this.get(agentSessionId).catch(() => null);
    if (session === null) return;
    await inTransaction(this.#pool, async (client) => {
      await client.query(
        "UPDATE agent_sessions SET status = $2, ended_at = now() WHERE id = $1 AND ended_at IS NULL",
        [agentSessionId, status],
      );
      await appendEvent(client, {
        type:
          status === "COMPLETED"
            ? "agent_session.completed"
            : status === "FAILED"
              ? "agent_session.failed"
              : "agent_session.disconnected",
        organisationId: session.organisationId,
        projectId: session.projectId,
        actor: agentActor(session),
        correlation: { agent_session_id: agentSessionId },
        payload: { agent_session_id: agentSessionId, status, reason },
      });
    });
  }

  /**
   * Whether the session holds a capability.
   *
   * Read from the session rather than the credential, so a session cannot gain
   * a capability that was added to its credential after it opened.
   */
  static holds(session: AgentSessionRecord, capability: string): boolean {
    return session.capabilities.includes(capability);
  }
}
