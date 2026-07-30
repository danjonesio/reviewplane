/**
 * Browser-worker identity and assignment (`docs/SECURITY.md` section 6.4,
 * `docs/ARCHITECTURE.md` section 11).
 *
 * A worker authenticates with its own credential, which is not the
 * administrator token, and it may only be given sessions for the projects an
 * administrator has assigned to it. "Not yet assigned" means "serves nothing":
 * there is no wildcard.
 */

import type { Pool } from "pg";

import type { WorkerRegistration } from "@reviewplane/protocol/browser";

import { credentialDigest, credentialMatches, type WorkerPrincipal } from "../../auth.ts";
import { ApiError, notFound } from "../../errors.ts";
import { newId } from "../../ids.ts";

export interface WorkerRow {
  readonly id: string;
  readonly name: string;
  readonly capacity: number;
  readonly sandbox_enabled: boolean;
  readonly status: string;
  readonly browser_version: string;
}

export class WorkerRegistry {
  readonly #pool: Pool;
  readonly #expectedCredential: string;

  constructor(pool: Pool, expectedCredential: string) {
    this.#pool = pool;
    this.#expectedCredential = expectedCredential;
  }

  /**
   * Registers or refreshes the worker record.
   *
   * `docs/SECURITY.md` section 10 requires the Chromium sandbox to stay
   * enabled, and describes disabling it as an unsupported, high-risk
   * configuration. Stage 0 refuses such a worker outright rather than
   * recording the risk and continuing.
   */
  async register(credential: string, registration: WorkerRegistration): Promise<{
    workerId: string;
    assignedProjects: string[];
  }> {
    if (!credentialMatches(credential, this.#expectedCredential)) {
      throw new ApiError("AUTHENTICATION_REQUIRED", "The worker credential was not recognised.");
    }
    if (!registration.sandbox_enabled) {
      throw new ApiError(
        "POLICY_DENIED",
        "A browser worker with the Chromium sandbox disabled is not accepted (docs/SECURITY.md section 10).",
      );
    }
    const digest = credentialDigest(credential);
    const existing = await this.#pool.query<{ id: string }>(
      "SELECT id FROM browser_workers WHERE name = $1",
      [registration.worker_name],
    );
    const workerId = existing.rows[0]?.id ?? newId("wkr_");

    await this.#pool.query(
      `INSERT INTO browser_workers (
          id, name, credential_sha256, worker_version, browser_type, browser_version,
          capacity, labels, sandbox_enabled, status, registered_at, last_heartbeat_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 'active', now(), now())
       ON CONFLICT (name) DO UPDATE SET
          credential_sha256 = EXCLUDED.credential_sha256,
          worker_version    = EXCLUDED.worker_version,
          browser_version   = EXCLUDED.browser_version,
          capacity          = EXCLUDED.capacity,
          labels            = EXCLUDED.labels,
          sandbox_enabled   = EXCLUDED.sandbox_enabled,
          status            = 'active',
          last_heartbeat_at = now()`,
      [
        workerId,
        registration.worker_name,
        digest,
        registration.worker_version,
        registration.browser_type,
        registration.browser_version,
        registration.capacity,
        JSON.stringify(registration.labels),
        registration.sandbox_enabled,
      ],
    );

    return { workerId, assignedProjects: await this.assignedProjects(workerId) };
  }

  async assignedProjects(workerId: string): Promise<string[]> {
    const rows = await this.#pool.query<{ project_id: string }>(
      "SELECT project_id FROM browser_worker_projects WHERE worker_id = $1 ORDER BY project_id",
      [workerId],
    );
    return rows.rows.map((row) => row.project_id);
  }

  /** Replaces a worker's assignment. Administrative action only. */
  async assign(workerId: string, projectIds: readonly string[]): Promise<string[]> {
    const worker = await this.byId(workerId);
    await this.#pool.query("DELETE FROM browser_worker_projects WHERE worker_id = $1", [worker.id]);
    for (const projectId of projectIds) {
      await this.#pool.query(
        "INSERT INTO browser_worker_projects (worker_id, project_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [worker.id, projectId],
      );
    }
    return this.assignedProjects(worker.id);
  }

  async byId(workerId: string): Promise<WorkerRow> {
    const rows = await this.#pool.query(
      "SELECT id, name, capacity, sandbox_enabled, status, browser_version FROM browser_workers WHERE id = $1",
      [workerId],
    );
    const row = rows.rows[0] as WorkerRow | undefined;
    if (row === undefined) throw notFound("The browser worker");
    return row;
  }

  /** The single active worker, which Stage 0 schedules every session to. */
  async active(): Promise<WorkerRow | null> {
    const rows = await this.#pool.query(
      "SELECT id, name, capacity, sandbox_enabled, status, browser_version FROM browser_workers WHERE status = 'active' ORDER BY registered_at LIMIT 1",
    );
    return (rows.rows[0] as WorkerRow | undefined) ?? null;
  }

  /**
   * Resolves the principal behind a presented worker credential, with the
   * projects it may act for. A worker whose assignment is empty authenticates
   * successfully and can do nothing, which is the intended shape.
   */
  async principal(credential: string): Promise<WorkerPrincipal> {
    if (!credentialMatches(credential, this.#expectedCredential)) {
      throw new ApiError("AUTHENTICATION_REQUIRED", "The worker credential was not recognised.");
    }
    const digest = credentialDigest(credential);
    const rows = await this.#pool.query<{ id: string; name: string }>(
      "SELECT id, name FROM browser_workers WHERE credential_sha256 = $1 AND status = 'active'",
      [digest],
    );
    const row = rows.rows[0];
    if (row === undefined) {
      throw new ApiError(
        "AUTHORISATION_DENIED",
        "This worker credential is not registered with an active worker.",
      );
    }
    return {
      type: "browser_worker",
      workerId: row.id,
      name: row.name,
      assignedProjects: new Set(await this.assignedProjects(row.id)),
    };
  }

  async recordHeartbeat(workerId: string, activeSessions: number): Promise<void> {
    await this.#pool.query(
      "UPDATE browser_workers SET last_heartbeat_at = now(), active_sessions = $2 WHERE id = $1",
      [workerId, activeSessions],
    );
  }
}
