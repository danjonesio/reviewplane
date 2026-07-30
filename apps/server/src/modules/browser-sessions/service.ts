/**
 * Browser-session orchestration.
 *
 * The control plane owns the lifecycle of `docs/DOMAIN_MODEL.md` section 12
 * and the control lease of section 13; the worker owns the browser. The epoch
 * lives here because ADR-0007 makes it the control plane's job to issue it and
 * to increment it on every controller transition — a worker that minted its
 * own epoch could not give two controllers a consistent view.
 *
 * Every transition writes an event in the same transaction
 * (`docs/EVENTS.md` section 9).
 */

import type { Pool } from "pg";

import type {
  BrowserCommand,
  BrowserCommandResult,
  ControllerIdentity,
  SessionAllocate,
  SessionLimits,
  SessionStatus,
  SessionStatusReport,
  TerminationReason,
  Viewport,
} from "@reviewplane/protocol/browser";

import { inTransaction } from "../../db/pool.ts";
import { appendEvent, type EventActor } from "../../events.ts";
import { ApiError, notFound } from "../../errors.ts";
import { newId } from "../../ids.ts";
import type { BrowserWorkerClient } from "./worker-client.ts";
import type { WorkerRegistry } from "./workers.ts";

export interface BrowserSessionRecord {
  readonly id: string;
  readonly organisation_id: string;
  readonly project_id: string;
  readonly worker_id: string | null;
  readonly agent_session_id: string | null;
  readonly published_service_id: string | null;
  readonly service_origin: string | null;
  readonly browser_type: string;
  readonly browser_version: string | null;
  readonly status: SessionStatus;
  readonly current_controller: ControllerIdentity | null;
  readonly control_epoch: number;
  readonly last_sequence: number;
  readonly viewport: Viewport;
  readonly limits: SessionLimits;
  readonly retention_policy: string;
  readonly created_at: string;
  readonly ended_at: string | null;
}

export interface StartSessionInput {
  readonly organisationId: string;
  readonly projectId: string;
  readonly agentSessionId?: string;
  readonly publishedServiceId?: string;
  readonly serviceOrigin?: string;
  readonly viewport: Viewport;
  readonly controller: ControllerIdentity;
  readonly retentionClass: "action_screenshots" | "verification_evidence";
  readonly limits?: Partial<SessionLimits>;
  readonly actor: EventActor;
}

export const DEFAULT_SESSION_LIMITS: SessionLimits = {
  max_duration_seconds: 7200,
  default_timeout_ms: 30000,
  max_command_timeout_ms: 120000,
  screenshot_max_bytes: 20971520,
  snapshot_max_nodes: 400,
  snapshot_max_bytes: 32768,
};

const LEASE_SECONDS = 900;

function toRecord(row: Record<string, unknown>): BrowserSessionRecord {
  const controllerType = row["current_controller_type"] as ControllerIdentity["type"] | null;
  const controllerId = row["current_controller_id"] as string | null;
  return {
    id: row["id"] as string,
    organisation_id: row["organisation_id"] as string,
    project_id: row["project_id"] as string,
    worker_id: (row["worker_id"] as string | null) ?? null,
    agent_session_id: (row["agent_session_id"] as string | null) ?? null,
    published_service_id: (row["published_service_id"] as string | null) ?? null,
    service_origin: (row["service_origin"] as string | null) ?? null,
    browser_type: row["browser_type"] as string,
    browser_version: (row["browser_version"] as string | null) ?? null,
    status: row["status"] as SessionStatus,
    current_controller:
      controllerType === null || controllerId === null
        ? null
        : { type: controllerType, id: controllerId },
    control_epoch: Number(row["control_epoch"]),
    last_sequence: Number(row["last_sequence"]),
    viewport: row["viewport"] as Viewport,
    limits: row["limits"] as SessionLimits,
    retention_policy: row["retention_policy"] as string,
    created_at: (row["created_at"] as Date).toISOString(),
    ended_at: row["ended_at"] === null ? null : (row["ended_at"] as Date).toISOString(),
  };
}

export class BrowserSessionService {
  readonly #pool: Pool;
  readonly #workers: WorkerRegistry;
  readonly #client: BrowserWorkerClient;

  constructor(pool: Pool, workers: WorkerRegistry, client: BrowserWorkerClient) {
    this.#pool = pool;
    this.#workers = workers;
    this.#client = client;
  }

  /**
   * Allocates a session: `REQUESTED` → `ALLOCATING` → `READY`.
   *
   * The initial control lease is issued to the requesting controller at epoch
   * 1, because ADR-0007 needs a controller and an epoch to exist before any
   * command can be validated against them.
   */
  async start(input: StartSessionInput): Promise<BrowserSessionRecord> {
    const worker = await this.#workers.active();
    if (worker === null) {
      throw new ApiError(
        "BROWSER_CAPACITY_EXHAUSTED",
        "No browser worker is registered with the control plane.",
      );
    }
    const assigned = await this.#workers.assignedProjects(worker.id);
    if (!assigned.includes(input.projectId)) {
      throw new ApiError(
        "PROJECT_CONTEXT_MISMATCH",
        "The registered browser worker is not assigned to this project.",
      );
    }
    const running = await this.#pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM browser_sessions WHERE worker_id = $1 AND ended_at IS NULL AND status NOT IN ('TERMINATED', 'FAILED')",
      [worker.id],
    );
    if (Number(running.rows[0]?.count ?? 0) >= worker.capacity) {
      throw new ApiError(
        "BROWSER_CAPACITY_EXHAUSTED",
        `The browser worker is already running its capacity of ${String(worker.capacity)} sessions.`,
      );
    }

    const limits: SessionLimits = { ...DEFAULT_SESSION_LIMITS, ...input.limits };
    const sessionId = newId("brs_");
    const epoch = 1;

    const created = await inTransaction(this.#pool, async (client) => {
      const inserted = await client.query(
        `INSERT INTO browser_sessions (
            id, organisation_id, project_id, worker_id, agent_session_id,
            published_service_id, service_origin, status,
            current_controller_type, current_controller_id, control_epoch,
            viewport, limits, retention_policy
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'REQUESTED', $8, $9, $10, $11::jsonb, $12::jsonb, $13)
         RETURNING *`,
        [
          sessionId,
          input.organisationId,
          input.projectId,
          worker.id,
          input.agentSessionId ?? null,
          input.publishedServiceId ?? null,
          input.serviceOrigin ?? null,
          input.controller.type,
          input.controller.id,
          epoch,
          JSON.stringify(input.viewport),
          JSON.stringify(limits),
          input.retentionClass,
        ],
      );
      await client.query(
        `INSERT INTO control_leases (id, browser_session_id, controller_type, controller_id, epoch, expires_at, reason)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6), 'initial allocation')`,
        [newId("lse_"), sessionId, input.controller.type, input.controller.id, epoch, LEASE_SECONDS],
      );
      await appendEvent(client, {
        type: "browser_session.requested",
        organisationId: input.organisationId,
        projectId: input.projectId,
        actor: input.actor,
        correlation: { browser_session_id: sessionId, worker_id: worker.id },
        payload: { viewport: input.viewport, control_epoch: epoch },
      });
      return toRecord(inserted.rows[0] as Record<string, unknown>);
    });

    await this.#setStatus(created, "ALLOCATING", input.actor, "browser_session.allocated", {
      worker_id: worker.id,
    });

    const allocation: SessionAllocate = {
      organisation_id: input.organisationId,
      project_id: input.projectId,
      ...(input.agentSessionId === undefined ? {} : { agent_session_id: input.agentSessionId }),
      ...(input.publishedServiceId === undefined
        ? {}
        : { published_service_id: input.publishedServiceId }),
      ...(input.serviceOrigin === undefined ? {} : { service_origin: input.serviceOrigin }),
      viewport: input.viewport,
      control_epoch: epoch,
      controller: input.controller,
      limits,
      retention_class: input.retentionClass,
    };

    try {
      const allocated = await this.#client.allocate(worker.id, sessionId, allocation);
      await this.#pool.query(
        "UPDATE browser_sessions SET browser_version = $2, viewport = $3::jsonb WHERE id = $1",
        [sessionId, allocated.browser_version, JSON.stringify(allocated.viewport)],
      );
      const ready = await this.get(sessionId);
      await this.#setStatus(ready, allocated.status, input.actor, "browser_session.ready", {
        browser_type: allocated.browser_type,
        browser_version: allocated.browser_version,
      });
      return this.get(sessionId);
    } catch (error) {
      const failing = await this.get(sessionId);
      await this.#setStatus(failing, "FAILED", input.actor, "browser_session.failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async get(browserSessionId: string): Promise<BrowserSessionRecord> {
    const rows = await this.#pool.query("SELECT * FROM browser_sessions WHERE id = $1", [
      browserSessionId,
    ]);
    const row = rows.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) throw notFound("The browser session");
    return toRecord(row);
  }

  async listForProject(projectId: string): Promise<BrowserSessionRecord[]> {
    const rows = await this.#pool.query(
      "SELECT * FROM browser_sessions WHERE project_id = $1 ORDER BY created_at DESC LIMIT 100",
      [projectId],
    );
    return rows.rows.map((row) => toRecord(row as Record<string, unknown>));
  }

  /**
   * Sends one command to the worker.
   *
   * The epoch and controller are checked here and again on the worker. Both
   * checks are wanted: this one keeps a refusal cheap and auditable, and the
   * worker's own check is what protects the browser if a command ever reaches
   * it by another path.
   */
  async runCommand(input: {
    readonly browserSessionId: string;
    readonly controller: ControllerIdentity;
    readonly controlEpoch: number;
    readonly command: BrowserCommand;
    readonly actor: EventActor;
  }): Promise<BrowserCommandResult> {
    const session = await this.get(input.browserSessionId);
    if (session.status !== "READY" && session.status !== "ACTIVE") {
      throw new ApiError(
        "BROWSER_SESSION_NOT_ACTIVE",
        `The browser session is ${session.status}.`,
        { status: session.status },
      );
    }
    if (input.controlEpoch !== session.control_epoch) {
      await this.#recordRejection(session, input, "CONTROL_EPOCH_STALE");
      throw new ApiError(
        "CONTROL_EPOCH_STALE",
        "Browser control changed. Refresh session state before retrying.",
        { current_epoch: session.control_epoch },
      );
    }
    if (session.worker_id === null) {
      throw new ApiError("BROWSER_SESSION_NOT_ACTIVE", "The browser session has no worker.");
    }

    const sequence = session.last_sequence + 1;
    await this.#pool.query("UPDATE browser_sessions SET last_sequence = $2 WHERE id = $1", [
      session.id,
      sequence,
    ]);

    const result = await this.#client.command(
      session.worker_id,
      session.id,
      input.controller,
      input.controlEpoch,
      sequence,
      input.command,
    );

    await inTransaction(this.#pool, async (client) => {
      if (result.ok && session.status === "READY") {
        await client.query("UPDATE browser_sessions SET status = 'ACTIVE' WHERE id = $1", [
          session.id,
        ]);
      }
      await appendEvent(client, {
        type: result.ok ? "browser.command_executed" : "browser.command_rejected",
        organisationId: session.organisation_id,
        projectId: session.project_id,
        actor: input.actor,
        correlation: { browser_session_id: session.id },
        payload: {
          command: input.command.command,
          sequence,
          control_epoch: input.controlEpoch,
          ...(result.ok ? {} : { reason_code: result.error?.code ?? "INTERNAL_ERROR" }),
        },
      });
      if (result.ok && input.command.command === "navigate") {
        await appendEvent(client, {
          type: "browser_session.navigated",
          organisationId: session.organisation_id,
          projectId: session.project_id,
          actor: input.actor,
          correlation: { browser_session_id: session.id },
          payload: {
            // The URL is page-derived. It is recorded because the timeline
            // needs it, and it is recorded as data, never as an instruction.
            url: result.navigation?.url ?? null,
            http_status: result.navigation?.http_status ?? null,
            trust: result.trust,
          },
        });
      }
    });

    return result;
  }

  /** Terminates a session and records the transition. */
  async terminate(
    browserSessionId: string,
    reason: TerminationReason,
    actor: EventActor,
  ): Promise<BrowserSessionRecord> {
    const session = await this.get(browserSessionId);
    if (session.status === "TERMINATED" || session.status === "FAILED") return session;
    await this.#setStatus(session, "TERMINATING", actor, null, { reason });
    if (session.worker_id !== null) {
      await this.#client
        .terminate(session.worker_id, session.id, reason)
        .catch(() => undefined);
    }
    await this.#revokeLeases(session.id, `terminated: ${reason}`);
    const terminating = await this.get(browserSessionId);
    await this.#setStatus(terminating, "TERMINATED", actor, "browser_session.terminated", {
      reason,
    });
    return this.get(browserSessionId);
  }

  /**
   * Applies a status the worker reported.
   *
   * `docs/ARCHITECTURE.md` section 14 fixes the crash behaviour: the session
   * is marked failed, the control lease is revoked, and evidence already
   * uploaded is left exactly as it is. Nothing here touches artefacts.
   */
  async applyWorkerReport(
    browserSessionId: string,
    report: SessionStatusReport,
    actor: EventActor,
  ): Promise<BrowserSessionRecord> {
    const session = await this.get(browserSessionId);
    const eventType =
      report.status === "READY"
        ? "browser_session.ready"
        : report.status === "FAILED"
          ? "browser_session.failed"
          : report.status === "TERMINATED"
            ? "browser_session.terminated"
            : report.status === "DEGRADED"
              ? "browser_session.degraded"
              : null;
    if (report.status === "FAILED" || report.status === "TERMINATED") {
      await this.#revokeLeases(session.id, report.reason ?? report.status);
    }
    await this.#setStatus(session, report.status, actor, eventType, {
      reason: report.reason ?? null,
      reported_by: "browser_worker",
    });
    return this.get(browserSessionId);
  }

  async #revokeLeases(browserSessionId: string, reason: string): Promise<void> {
    await this.#pool.query(
      "UPDATE control_leases SET revoked_at = now(), reason = $2 WHERE browser_session_id = $1 AND revoked_at IS NULL",
      [browserSessionId, reason],
    );
  }

  async #recordRejection(
    session: BrowserSessionRecord,
    input: { readonly command: BrowserCommand; readonly actor: EventActor; readonly controlEpoch: number },
    code: string,
  ): Promise<void> {
    await inTransaction(this.#pool, async (client) => {
      await appendEvent(client, {
        type: "browser.command_rejected",
        organisationId: session.organisation_id,
        projectId: session.project_id,
        actor: input.actor,
        correlation: { browser_session_id: session.id },
        payload: {
          command: input.command.command,
          reason_code: code,
          presented_epoch: input.controlEpoch,
          current_epoch: session.control_epoch,
        },
      });
    });
  }

  async #setStatus(
    session: BrowserSessionRecord,
    status: SessionStatus,
    actor: EventActor,
    eventType: string | null,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const terminal = status === "TERMINATED" || status === "FAILED";
    await inTransaction(this.#pool, async (client) => {
      await client.query(
        `UPDATE browser_sessions
            SET status = $2, ended_at = CASE WHEN $3 THEN now() ELSE ended_at END
          WHERE id = $1`,
        [session.id, status, terminal],
      );
      if (eventType !== null) {
        await appendEvent(client, {
          type: eventType,
          organisationId: session.organisation_id,
          projectId: session.project_id,
          actor,
          correlation: {
            browser_session_id: session.id,
            ...(session.worker_id === null ? {} : { worker_id: session.worker_id }),
          },
          payload: { previous_status: session.status, new_status: status, ...payload },
        });
      }
    });
  }
}
