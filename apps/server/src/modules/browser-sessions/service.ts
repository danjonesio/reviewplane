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

import { SensitiveString } from "@reviewplane/protocol";
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
import { appendEvent, type EventActor } from "../../events/append.ts";
import { ApiError, notFound } from "../../errors.ts";
import { newId } from "../../ids.ts";
import { authoriseBrowserCommand, isInteractive, type CommandDenial } from "./authorisation.ts";
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
  readonly viewport: Viewport;
  readonly controller: ControllerIdentity;
  readonly retentionClass: "action_screenshots" | "verification_evidence";
  readonly limits?: Partial<SessionLimits>;
  readonly actor: EventActor;
}

/**
 * Binds a session to a published service at allocation.
 *
 * The origin and the capability are both derived from the route by the control
 * plane, never taken from the caller. A caller-supplied origin would let anyone
 * who can start a session choose what that session's browser is allowed to
 * reach, which is the egress control itself (`docs/SECURITY.md` §9).
 */
export interface ServiceBinding {
  readonly publishedServiceId: string;
  readonly serviceOrigin: string;
  readonly serviceCapability: string;
}

/**
 * A lifecycle act a controller performs on a session.
 *
 * It is what `browser.command_rejected` records under `command` when one is
 * refused, with `kind: "lifecycle"` distinguishing it from a browser command.
 */
export type LifecycleAct =
  | "pause"
  | "resume"
  | "end"
  | "control_request"
  | "control_release";

/** One event of a browser session's timeline (`docs/API.md` section 11). */
export interface TimelineEntry {
  readonly id: string;
  readonly type: string;
  readonly occurred_at: string;
  readonly actor: { readonly type: string; readonly display: string | null };
  readonly payload: Record<string, unknown>;
}

/** Resolves a published service into the binding a session is allocated with. */
export interface ServiceBinder {
  bind(input: {
    readonly publishedServiceId: string;
    readonly projectId: string;
    readonly browserSessionId: string;
    readonly actor: EventActor;
    readonly requestId: string;
  }): Promise<ServiceBinding>;
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
  readonly #binder: ServiceBinder | null;

  constructor(
    pool: Pool,
    workers: WorkerRegistry,
    client: BrowserWorkerClient,
    binder: ServiceBinder | null = null,
  ) {
    this.#pool = pool;
    this.#workers = workers;
    this.#client = client;
    this.#binder = binder;
  }

  /**
   * Reserves a session: the row and its initial control lease, and nothing
   * else. The session is `REQUESTED`, has a worker chosen but not contacted,
   * and can already be named in a route's `allowed_browser_session_ids`.
   *
   * This exists because publication and allocation each need the other to have
   * happened first. `POST /published-services` requires the session identifiers
   * a route authorises (`docs/CONNECTOR_PROTOCOL.md` §11: a route no session
   * may use is not published), while the worker's egress policy is fixed when
   * the context is created and cannot be widened afterwards. Reserving the
   * identifier first breaks the cycle without weakening either rule, and
   * `REQUESTED` is already the first state of the `docs/DOMAIN_MODEL.md` §12
   * lifecycle — this is the state finally being used for what it describes.
   *
   * The initial control lease is issued to the requesting controller at epoch
   * 1, because ADR-0007 needs a controller and an epoch to exist before any
   * command can be validated against them.
   */
  async create(input: StartSessionInput): Promise<BrowserSessionRecord> {
    // `active()` applies the liveness term in its own query rather than
    // returning a row for the caller to check (ADR-0027). A worker that died
    // between two sweeps still has `status = 'active'`, and scheduling onto it
    // would surface as a session that never becomes ready instead of the
    // capacity refusal `docs/UX_FLOWS.md` section 18 promises.
    const worker = await this.#workers.active();
    if (worker === null) {
      throw new ApiError(
        "BROWSER_CAPACITY_EXHAUSTED",
        "No live browser worker is available. A registered worker that has stopped reporting is not counted as capacity; check `reviewplane status`.",
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
          // The route binding is written at allocation, once the control plane
          // has read the route and minted a capability for this session.
          null,
          null,
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
    return created;
  }

  /**
   * Allocates a reserved session on its worker: `REQUESTED` → `ALLOCATING` →
   * `READY`.
   *
   * When the session is bound to a published service, the origin and the
   * capability come from the route, resolved here. Neither is ever taken from
   * the caller: the origin is the worker's egress allow-list and the capability
   * is a bearer credential, so accepting either from a request body would hand
   * the caller the control it is the point of.
   */
  async allocate(input: {
    readonly browserSessionId: string;
    readonly publishedServiceId?: string;
    readonly actor: EventActor;
    readonly requestId: string;
  }): Promise<BrowserSessionRecord> {
    const session = await this.get(input.browserSessionId);
    if (session.status !== "REQUESTED") {
      // Deliberately does not fail the session: it is already allocated, and a
      // second allocation attempt is the caller's mistake rather than the
      // session's.
      throw new ApiError(
        "BROWSER_SESSION_NOT_ACTIVE",
        "Only a reserved browser session can be allocated.",
        { browser_session_status: session.status },
      );
    }
    if (session.worker_id === null) {
      await this.#failReservation(session, input.actor, "the reservation has no worker");
      throw new ApiError("BROWSER_CAPACITY_EXHAUSTED", "This session has no worker.");
    }

    let binding: ServiceBinding | null = null;
    if (input.publishedServiceId !== undefined) {
      // Every failure between here and the worker call ends the reservation.
      //
      // It did not, and the consequence was worse than an untidy row: a
      // `REQUESTED` session with `ended_at IS NULL` is exactly what the capacity
      // query counts, so four refused starts — a mistyped published-service
      // identifier is enough — filled a default worker and no further session
      // could be started in the project at all. A refusal that consumes the
      // resource it refused to allocate is a denial of service with extra steps.
      try {
        if (this.#binder === null) {
          throw new ApiError(
            "UNSUPPORTED_CAPABILITY",
            "This control plane cannot bind a published service to a browser session.",
          );
        }
        binding = await this.#binder.bind({
          publishedServiceId: input.publishedServiceId,
          projectId: session.project_id,
          browserSessionId: session.id,
          actor: input.actor,
          requestId: input.requestId,
        });
      } catch (error) {
        await this.#failReservation(
          session,
          input.actor,
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
      await this.#pool.query(
        "UPDATE browser_sessions SET published_service_id = $2, service_origin = $3 WHERE id = $1",
        [session.id, binding.publishedServiceId, binding.serviceOrigin],
      );
    }

    const bound = await this.get(session.id);
    await this.#setStatus(bound, "ALLOCATING", input.actor, "browser_session.allocated", {
      worker_id: session.worker_id,
      published_service_id: binding?.publishedServiceId ?? null,
    });

    const allocation: SessionAllocate = {
      organisation_id: session.organisation_id,
      project_id: session.project_id,
      ...(session.agent_session_id === null ? {} : { agent_session_id: session.agent_session_id }),
      ...(binding === null
        ? {}
        : {
            published_service_id: binding.publishedServiceId,
            service_origin: binding.serviceOrigin,
            // The capability is a bearer credential. It is passed here and
            // nowhere else, and the generated model redacts it in every log,
            // debug and default JSON representation.
            service_capability: new SensitiveString(binding.serviceCapability),
          }),
      viewport: session.viewport,
      control_epoch: session.control_epoch,
      controller: session.current_controller ?? { type: "system", id: "sys_allocation" },
      limits: session.limits,
      retention_class: session.retention_policy as "action_screenshots" | "verification_evidence",
    };

    try {
      const allocated = await this.#client.allocate(session.worker_id, session.id, allocation);
      await this.#pool.query(
        "UPDATE browser_sessions SET browser_version = $2, viewport = $3::jsonb WHERE id = $1",
        [session.id, allocated.browser_version, JSON.stringify(allocated.viewport)],
      );
      const ready = await this.get(session.id);
      await this.#setStatus(ready, allocated.status, input.actor, "browser_session.ready", {
        browser_type: allocated.browser_type,
        browser_version: allocated.browser_version,
      });
      return this.get(session.id);
    } catch (error) {
      const failing = await this.get(session.id);
      await this.#setStatus(failing, "FAILED", input.actor, "browser_session.failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Reserves and allocates in one call, for a session that needs no route or
   * whose route already names it.
   */
  async start(
    input: StartSessionInput & { readonly requestId?: string },
  ): Promise<BrowserSessionRecord> {
    const created = await this.create(input);
    return this.allocate({
      browserSessionId: created.id,
      ...(input.publishedServiceId === undefined
        ? {}
        : { publishedServiceId: input.publishedServiceId }),
      actor: input.actor,
      requestId: input.requestId ?? "req_internal",
    });
  }

  /**
   * Ends a reservation that could not be allocated, so it stops counting
   * against the worker's capacity.
   *
   * `FAILED` rather than `TERMINATED`: nothing was ever allocated, and the
   * session is a record of an attempt that did not succeed. The lease goes with
   * it, because a lease on a session that will never exist is a lease nobody
   * can release.
   */
  async #failReservation(
    session: BrowserSessionRecord,
    actor: EventActor,
    reason: string,
  ): Promise<void> {
    await this.#revokeLeases(session.id, `allocation refused: ${reason}`);
    await this.#setStatus(session, "FAILED", actor, "browser_session.failed", {
      reason,
      trigger: "allocation_refused",
    });
  }

  async get(browserSessionId: string): Promise<BrowserSessionRecord> {
    const rows = await this.#pool.query("SELECT * FROM browser_sessions WHERE id = $1", [
      browserSessionId,
    ]);
    const row = rows.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) throw notFound("The browser session");
    return toRecord(row);
  }

  /**
   * Reads a session inside a caller's scope, in one query.
   *
   * The identifier, the caller's project scope and the caller's organisation
   * are all in the same `WHERE` clause, so a row satisfying one and not the
   * others is never returned and then refused by a later branch — and the
   * refusal for a session in another tenancy is the **same refusal**, message
   * included, that an unknown identifier earns.
   *
   * The route used to read the session unscoped and then resolve its project
   * through the authorisation layer. Both calls refused correctly and the two
   * refusals said different things: "The browser session was not found." for an
   * unknown identifier and "The project was not found." for another
   * organisation's session. `docs/TESTING.md` §10 requires the *bodies* to be
   * equal and not merely the statuses, because wording is as much an existence
   * oracle as a status code is.
   */
  async getForScope(
    browserSessionId: string,
    scope: { readonly projectIds: readonly string[] | null; readonly organisationId: string | null },
  ): Promise<BrowserSessionRecord> {
    const rows = await this.#pool.query(
      `SELECT s.*
         FROM browser_sessions s
         JOIN projects p ON p.id = s.project_id
        WHERE s.id = $1
          AND ($2::text[] IS NULL OR s.project_id = ANY($2))
          AND ($3::text IS NULL OR p.organisation_id = $3)`,
      [
        browserSessionId,
        scope.projectIds === null ? null : [...scope.projectIds],
        scope.organisationId,
      ],
    );
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
   * Sends one command to the worker, once the whole of `docs/SECURITY.md`
   * section 7 has passed.
   *
   * Every check is applied here, before the command leaves the control plane,
   * and the worker applies its own again. Both are wanted: this one keeps a
   * refusal cheap and auditable and is the only layer that can see the *route*
   * (the worker's egress policy was fixed when its context was created), and
   * the worker's check is what protects the browser if a command ever reaches
   * it by another path.
   *
   * `projectId` is the actor's project and is required. It used to be absent,
   * and each caller checked the project for itself — which meant the Stage 1
   * exit criterion "browser control commands are project scoped" was a property
   * of every caller rather than of this function. A caller that forgot would
   * have driven another project's browser.
   */
  async runCommand(input: {
    readonly browserSessionId: string;
    readonly projectId: string;
    readonly controller: ControllerIdentity;
    readonly controlEpoch: number;
    readonly command: BrowserCommand;
    readonly actor: EventActor;
  }): Promise<BrowserCommandResult> {
    const session = await this.get(input.browserSessionId).catch((error: unknown) => {
      if (error instanceof ApiError && error.code === "RESOURCE_NOT_FOUND") return null;
      throw error;
    });
    if (session === null) throw notFound("The browser session");

    const denial = authoriseBrowserCommand(
      {
        sessionProjectId: session.project_id,
        actorProjectId: input.projectId,
        status: session.status,
        currentEpoch: session.control_epoch,
        currentController: session.current_controller,
        presentedEpoch: input.controlEpoch,
        presentedController: input.controller,
        publishedServiceId: session.published_service_id,
        routeAssociated: await this.#routeAssociated(session),
      },
      input.command,
    );
    if (denial !== null) {
      // Every denial is recorded, not only the epoch one. Until RVP-30 exactly
      // one of them was: a command refused for a wrong session status threw and
      // wrote nothing, so an auditor asking "did anything try to drive that
      // terminated session?" got the same answer as if nothing had. A denial
      // that is correct and unrecorded is the defect class this repository has
      // shipped twice.
      //
      // A cross-project attempt is recorded against the **actor's** project,
      // never the session's. Writing it to the session's stream would let a
      // stranger append rows to a timeline they cannot read, which is a worse
      // outcome than the enumeration the refusal already prevents.
      await this.#recordRejection(session, input, denial);
      throw new ApiError(denial.code, denial.message, denial.details);
    }

    if (session.worker_id === null) {
      await this.#recordRejection(session, input, {
        code: "BROWSER_SESSION_NOT_ACTIVE",
        message: "The browser session has no worker.",
        reason: "no_worker",
      });
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
      if (result.ok && result.screenshot !== undefined) {
        // `docs/EVENTS.md` section 7 lists screenshot.captured under Evidence.
        // It records that a capture was taken and which artefact it became; the
        // artefact events record the upload itself.
        await appendEvent(client, {
          type: "screenshot.captured",
          organisationId: session.organisation_id,
          projectId: session.project_id,
          actor: input.actor,
          correlation: {
            browser_session_id: session.id,
            artefact_id: result.screenshot.artefact_id,
          },
          payload: {
            purpose: input.command.take_screenshot?.purpose ?? "verification",
            full_page: result.screenshot.full_page,
            viewport: result.screenshot.viewport,
            size_bytes: result.screenshot.size_bytes,
            sha256: result.screenshot.sha256,
            captured_at: result.screenshot.captured_at,
          },
        });
      }
    });

    return result;
  }

  /**
   * Whether the session's published service is still a route that authorises
   * it (`docs/SECURITY.md` section 7, check six).
   *
   * `null` means the session has no published service at all, which is not a
   * fault: such a session can reach nothing, and the worker's own egress policy
   * already says so. `false` means the route exists but has been revoked, has
   * expired, or no longer names this session — a state the worker cannot see,
   * because its egress policy was fixed when its context was created and
   * `docs/SECURITY.md` section 10 forbids widening it afterwards. The control
   * plane is the only layer that can refuse this, so it does.
   */
  async #routeAssociated(session: BrowserSessionRecord): Promise<boolean | null> {
    if (session.published_service_id === null) return null;
    const rows = await this.#pool.query<{ associated: boolean }>(
      `SELECT true AS associated
         FROM published_services
        WHERE id = $1
          AND project_id = $2
          AND status = 'ready'
          AND expires_at > now()
          AND $3 = ANY(allowed_browser_session_ids)`,
      [session.published_service_id, session.project_id, session.id],
    );
    return rows.rows.length > 0;
  }

  /**
   * Ends a session on behalf of a controller.
   *
   * `docs/MCP_SPEC.md` section 7.3 puts ending a session under the same epoch
   * and lease rules as pausing one, on the stated grounds that "pausing or
   * ending a browser somebody else now controls is not a lesser act than
   * clicking in it". {@link terminate} below applies no such check because its
   * callers are the reconciler and the worker report, which are not
   * controllers; this is the controller-facing door, and it is the one every
   * human and agent path uses.
   */
  async end(input: {
    readonly browserSessionId: string;
    readonly projectId: string;
    readonly controller: ControllerIdentity;
    readonly controlEpoch: number;
    readonly reason: TerminationReason;
    readonly actor: EventActor;
  }): Promise<BrowserSessionRecord> {
    const session = await this.get(input.browserSessionId);
    if (session.project_id !== input.projectId) throw notFound("The browser session");
    if (session.status === "TERMINATED" || session.status === "FAILED") return session;
    await this.#requireControl(
      {
        browserSessionId: input.browserSessionId,
        projectId: input.projectId,
        controller: input.controller,
        controlEpoch: input.controlEpoch,
        act: "end",
        actor: input.actor,
      },
      ["REQUESTED", "ALLOCATING", "READY", "ACTIVE", "PAUSED", "DEGRADED"],
    );
    return this.terminate(input.browserSessionId, input.reason, input.actor);
  }

  /**
   * Terminates a session and records the transition.
   *
   * This applies no controller or epoch check: it is the internal door, used by
   * the reconciler, by worker-reported failure and by administrative cleanup.
   * A controller ending its own session goes through {@link end}.
   */
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

  /**
   * Records a refusal.
   *
   * `docs/SECURITY.md` section 8 requires stale commands to be rejected **and
   * logged**, so this is not optional bookkeeping: an attempt with no record is
   * indistinguishable from one that never happened. The payload names the code,
   * the reason and both epochs, and never the command's arguments — a refused
   * `type_text` is exactly the command whose argument must not be written to an
   * append-only table.
   */
  async #recordRejection(
    session: BrowserSessionRecord,
    input: {
      readonly command: BrowserCommand;
      readonly actor: EventActor;
      readonly controlEpoch: number;
      readonly controller: ControllerIdentity;
      readonly projectId: string;
    },
    denial: CommandDenial,
  ): Promise<void> {
    const crossProject = denial.reason === "project_mismatch";
    const stream = crossProject
      ? await this.#projectStream(input.projectId)
      : { organisationId: session.organisation_id, projectId: session.project_id };
    if (stream === null) return;
    await inTransaction(this.#pool, async (client) => {
      await appendEvent(client, {
        type: "browser.command_rejected",
        organisationId: stream.organisationId,
        projectId: stream.projectId,
        actor: input.actor,
        correlation: { browser_session_id: session.id },
        // The member names here are deliberately unprefixed, unlike the
        // refusal `details` object where `status` became
        // `browser_session_status`. The two cases are opposites. `details` is
        // one object serving reviews, findings and browser sessions, so a bare
        // `status` there says nothing about which record it describes. This
        // payload is correlated to `browser_session_id`, so everything in it is
        // about that one session by construction — `current_epoch` is the
        // session's epoch and is not called `browser_session_control_epoch`,
        // and prefixing only the status would make it the odd field out in its
        // own record. `docs/EVENTS.md` section 7 names these fields.
        payload: {
          command: input.command.command,
          reason_code: denial.code,
          reason: denial.reason,
          interactive: isInteractive(input.command.command),
          presented_epoch: input.controlEpoch,
          presented_controller_type: input.controller.type,
          // A cross-project attempt learns nothing about the session it named,
          // so the record does not carry the session's epoch or status either:
          // the audit trail is written for the actor's project, and the other
          // project's state is not a fact this stream is entitled to.
          ...(crossProject
            ? { cross_project: true }
            : { current_epoch: session.control_epoch, session_status: session.status }),
        },
      });
    });
  }

  async #projectStream(
    projectId: string,
  ): Promise<{ organisationId: string; projectId: string } | null> {
    const rows = await this.#pool.query<{ organisation_id: string }>(
      "SELECT organisation_id FROM projects WHERE id = $1",
      [projectId],
    );
    const organisationId = rows.rows[0]?.organisation_id;
    return organisationId === undefined ? null : { organisationId, projectId };
  }

  // -------------------------------------------------------------------
  // Lifecycle: pause and resume
  // -------------------------------------------------------------------

  /**
   * Suspends agent-issued interactive commands (`docs/MCP_SPEC.md` section
   * 7.3).
   *
   * A pause is a gate on authority, not a stop on the browser: the context
   * stays open, live frames keep flowing so a human can still watch, and
   * non-interactive system capture continues — which is what makes "pause and
   * look at it" a usable act rather than a blackout. The worker is not told,
   * deliberately: the lifecycle is the control plane's (`docs/DOMAIN_MODEL.md`
   * section 12), and a worker that also held a pause flag would be a second
   * answer to whether a command may run.
   */
  async pause(input: {
    readonly browserSessionId: string;
    readonly projectId: string;
    readonly controller: ControllerIdentity;
    readonly controlEpoch: number;
    readonly actor: EventActor;
  }): Promise<BrowserSessionRecord> {
    const session = await this.#requireControl(
      { ...input, act: "pause" },
      ["READY", "ACTIVE"],
    );
    await this.#setStatus(session, "PAUSED", input.actor, "browser_session.paused", {
      controller_type: input.controller.type,
    });
    return this.get(session.id);
  }

  /** Re-admits interactive commands to the controller that owns the lease. */
  async resume(input: {
    readonly browserSessionId: string;
    readonly projectId: string;
    readonly controller: ControllerIdentity;
    readonly controlEpoch: number;
    readonly actor: EventActor;
  }): Promise<BrowserSessionRecord> {
    const session = await this.#requireControl(
      { ...input, act: "resume" },
      ["PAUSED"],
    );
    // READY rather than ACTIVE: a resumed session has been sitting, and the
    // page may have moved under it. READY is the state a fresh snapshot is
    // taken from, and the first successful command moves it to ACTIVE again.
    await this.#setStatus(session, "READY", input.actor, "browser_session.resumed", {
      controller_type: input.controller.type,
    });
    return this.get(session.id);
  }

  /**
   * The project, state, epoch and lease checks a lifecycle change shares with a
   * command.
   *
   * Pausing or ending a browser somebody else now controls is not a lesser act
   * than clicking in it, so it is refused by the same rules
   * (`docs/SECURITY.md` section 8).
   */
  async #requireControl(
    input: {
      readonly browserSessionId: string;
      readonly projectId: string;
      readonly controller: ControllerIdentity;
      readonly controlEpoch: number;
      readonly act: LifecycleAct;
      readonly actor: EventActor;
    },
    from: readonly SessionStatus[],
  ): Promise<BrowserSessionRecord> {
    const session = await this.get(input.browserSessionId);
    if (session.project_id !== input.projectId) {
      await this.#recordLifecycleRejection(session, input, {
        code: "RESOURCE_NOT_FOUND",
        message: "The browser session was not found.",
        reason: "project_mismatch",
      });
      throw notFound("The browser session");
    }
    if (!from.includes(session.status)) {
      return this.#refuseLifecycle(session, input, {
        code: "BROWSER_SESSION_NOT_ACTIVE",
        message: `The browser session is ${session.status}.`,
        details: { browser_session_status: session.status },
        reason: "session_not_active",
      });
    }
    if (input.controlEpoch !== session.control_epoch) {
      return this.#refuseLifecycle(session, input, {
        code: "CONTROL_EPOCH_STALE",
        message: "Browser control changed. Refresh session state before retrying.",
        details: { current_epoch: session.control_epoch },
        reason: "control_epoch_stale",
      });
    }
    const controller = session.current_controller;
    if (
      controller !== null &&
      (controller.type !== input.controller.type || controller.id !== input.controller.id)
    ) {
      return this.#refuseLifecycle(session, input, {
        code: "CONTROL_NOT_OWNED",
        message: "Another controller holds the interactive lease for this browser session.",
        details: { current_epoch: session.control_epoch },
        reason: "control_not_owned",
      });
    }
    return session;
  }

  /** Records the refusal and then raises it, so neither can happen alone. */
  async #refuseLifecycle(
    session: BrowserSessionRecord,
    input: {
      readonly act: LifecycleAct;
      readonly controlEpoch: number;
      readonly controller: ControllerIdentity;
      readonly actor: EventActor;
      readonly projectId: string;
    },
    denial: CommandDenial,
  ): Promise<never> {
    await this.#recordLifecycleRejection(session, input, denial);
    throw new ApiError(denial.code, denial.message, denial.details);
  }

  /**
   * Records a refused lifecycle act.
   *
   * It shares `browser.command_rejected` with the command path rather than
   * having a type of its own. The question an auditor asks is "did anything try
   * to act on this session and get refused?", and splitting the answer across
   * two event types would mean an auditor who checked one and not the other got
   * a confident wrong answer. `kind` distinguishes them, and `command` carries
   * the act.
   *
   * This existed only on the command path until the adversarial pass on PR
   * #123. Every denial from `#requireControl`, `releaseControl` and
   * `requestControl` threw with no event — the same shape as the defect the
   * command path had already been fixed for, reproduced one layer up.
   * `docs/SECURITY.md` §8 requires a refused act to be logged as well as
   * rejected.
   */
  async #recordLifecycleRejection(
    session: BrowserSessionRecord,
    input: {
      readonly act: LifecycleAct;
      readonly controlEpoch: number;
      readonly controller: ControllerIdentity;
      readonly actor: EventActor;
      readonly projectId: string;
    },
    denial: CommandDenial,
  ): Promise<void> {
    const crossProject = denial.reason === "project_mismatch";
    const stream = crossProject
      ? await this.#projectStream(input.projectId)
      : { organisationId: session.organisation_id, projectId: session.project_id };
    if (stream === null) return;
    await inTransaction(this.#pool, async (client) => {
      await appendEvent(client, {
        type: "browser.command_rejected",
        organisationId: stream.organisationId,
        projectId: stream.projectId,
        actor: input.actor,
        correlation: { browser_session_id: session.id },
        payload: {
          kind: "lifecycle",
          command: input.act,
          reason_code: denial.code,
          reason: denial.reason,
          interactive: true,
          presented_epoch: input.controlEpoch,
          presented_controller_type: input.controller.type,
          ...(crossProject
            ? { cross_project: true }
            : { current_epoch: session.control_epoch, session_status: session.status }),
        },
      });
    });
  }

  // -------------------------------------------------------------------
  // Control leases
  // -------------------------------------------------------------------

  /**
   * Transfers the interactive lease and increments the epoch (ADR-0007).
   *
   * The increment is the whole mechanism: after it, every command carrying the
   * previous epoch is refused, which is what makes "exactly one interactive
   * controller" true of commands in flight and not only of the lease table. The
   * two writes are one transaction, so a lease can never exist at an epoch the
   * session does not carry.
   *
   * `human` is refused with `UNSUPPORTED_CAPABILITY` in Stage 1: takeover
   * through the control WebSocket is Stage 2 work (`docs/ROADMAP.md`). The
   * refusal is by capability rather than by silence so that a client learns the
   * feature is absent rather than that its request was malformed — and the
   * epoch model is already correct, so Stage 2 adds a controller rather than
   * reworking this.
   */
  async requestControl(input: {
    readonly browserSessionId: string;
    readonly projectId: string;
    readonly controller: ControllerIdentity;
    readonly reason?: string;
    readonly actor: EventActor;
  }): Promise<BrowserSessionRecord> {
    const session = await this.get(input.browserSessionId);
    // A refused *grant* of control has its own event below —
    // `browser.control_requested` with `granted: false` — but these two
    // refusals happen before there is a decision to record, so they are
    // recorded as rejections like every other refused act. The presented epoch
    // is the session's own: this route takes none, because requesting control
    // is how a caller who does not know the current epoch acquires one.
    const denialContext = {
      ...input,
      controlEpoch: session.control_epoch,
      act: "control_request" as const,
    };
    if (session.project_id !== input.projectId) {
      await this.#recordLifecycleRejection(session, denialContext, {
        code: "RESOURCE_NOT_FOUND",
        message: "The browser session was not found.",
        reason: "project_mismatch",
      });
      throw notFound("The browser session");
    }
    if (session.ended_at !== null || session.status === "TERMINATED" || session.status === "FAILED") {
      return this.#refuseLifecycle(session, denialContext, {
        code: "BROWSER_SESSION_NOT_ACTIVE",
        message: `The browser session is ${session.status}.`,
        details: { browser_session_status: session.status },
        reason: "session_not_active",
      });
    }
    if (input.controller.type === "human") {
      // The request is still audited: `docs/EVENTS.md` section 7 lists
      // browser.control_requested, and a refused takeover is exactly the
      // attempt an auditor goes looking for.
      await inTransaction(this.#pool, async (client) => {
        await appendEvent(client, {
          type: "browser.control_requested",
          organisationId: session.organisation_id,
          projectId: session.project_id,
          actor: input.actor,
          correlation: { browser_session_id: session.id },
          payload: {
            requested_controller_type: input.controller.type,
            granted: false,
            reason_code: "UNSUPPORTED_CAPABILITY",
          },
        });
      });
      throw new ApiError(
        "UNSUPPORTED_CAPABILITY",
        "Human interactive control arrives with takeover in Stage 2. The lease, the epoch and the rejection of stale commands are already in force.",
      );
    }

    const current = session.current_controller;
    if (current !== null && current.type === input.controller.type && current.id === input.controller.id) {
      // Already the controller. Re-requesting is idempotent and does **not**
      // increment the epoch: `docs/TESTING.md` section 5 requires duplicate
      // control commands to be idempotent, and an increment here would refuse
      // every command the caller had already prepared.
      return session;
    }

    const epoch = session.control_epoch + 1;
    await inTransaction(this.#pool, async (client) => {
      await client.query(
        "UPDATE control_leases SET revoked_at = now(), reason = 'superseded by a new controller' WHERE browser_session_id = $1 AND revoked_at IS NULL",
        [session.id],
      );
      await client.query(
        `UPDATE browser_sessions
            SET current_controller_type = $2,
                current_controller_id   = $3,
                control_epoch           = $4
          WHERE id = $1`,
        [session.id, input.controller.type, input.controller.id, epoch],
      );
      await client.query(
        `INSERT INTO control_leases (id, browser_session_id, controller_type, controller_id, epoch, expires_at, reason)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6), $7)`,
        [
          newId("lse_"),
          session.id,
          input.controller.type,
          input.controller.id,
          epoch,
          LEASE_SECONDS,
          input.reason ?? "control requested",
        ],
      );
      await appendEvent(client, {
        type: "browser.control_requested",
        organisationId: session.organisation_id,
        projectId: session.project_id,
        actor: input.actor,
        correlation: { browser_session_id: session.id },
        payload: { requested_controller_type: input.controller.type, granted: true },
      });
      await appendEvent(client, {
        type: "browser.control_transferred",
        organisationId: session.organisation_id,
        projectId: session.project_id,
        actor: input.actor,
        correlation: { browser_session_id: session.id },
        payload: {
          previous_controller_type: current?.type ?? null,
          new_controller_type: input.controller.type,
          previous_epoch: session.control_epoch,
          control_epoch: epoch,
        },
      });
    });
    return this.get(session.id);
  }

  /**
   * Releases the interactive lease.
   *
   * The epoch increments here too. It has to: after a release nobody holds the
   * lease, and a command still carrying the released epoch would otherwise
   * satisfy the epoch check and be refused only by the ownership check — which
   * is the weaker of the two and the one Stage 2's takeover has to change.
   */
  async releaseControl(input: {
    readonly browserSessionId: string;
    readonly projectId: string;
    readonly controller: ControllerIdentity;
    readonly controlEpoch: number;
    readonly actor: EventActor;
  }): Promise<BrowserSessionRecord> {
    const session = await this.get(input.browserSessionId);
    const denialContext = { ...input, act: "control_release" as const };
    if (session.project_id !== input.projectId) {
      await this.#recordLifecycleRejection(session, denialContext, {
        code: "RESOURCE_NOT_FOUND",
        message: "The browser session was not found.",
        reason: "project_mismatch",
      });
      throw notFound("The browser session");
    }
    if (input.controlEpoch !== session.control_epoch) {
      return this.#refuseLifecycle(session, denialContext, {
        code: "CONTROL_EPOCH_STALE",
        message: "Browser control changed. Refresh session state before retrying.",
        details: { current_epoch: session.control_epoch },
        reason: "control_epoch_stale",
      });
    }
    const current = session.current_controller;
    if (current === null) return session;
    if (current.type !== input.controller.type || current.id !== input.controller.id) {
      return this.#refuseLifecycle(session, denialContext, {
        code: "CONTROL_NOT_OWNED",
        message: "Another controller holds the interactive lease for this browser session.",
        details: { current_epoch: session.control_epoch },
        reason: "control_not_owned",
      });
    }

    const epoch = session.control_epoch + 1;
    await inTransaction(this.#pool, async (client) => {
      await client.query(
        "UPDATE control_leases SET revoked_at = now(), reason = 'released by controller' WHERE browser_session_id = $1 AND revoked_at IS NULL",
        [session.id],
      );
      await client.query(
        `UPDATE browser_sessions
            SET current_controller_type = NULL,
                current_controller_id   = NULL,
                control_epoch           = $2
          WHERE id = $1`,
        [session.id, epoch],
      );
      await appendEvent(client, {
        type: "browser.control_released",
        organisationId: session.organisation_id,
        projectId: session.project_id,
        actor: input.actor,
        correlation: { browser_session_id: session.id },
        payload: {
          previous_controller_type: current.type,
          previous_epoch: session.control_epoch,
          control_epoch: epoch,
        },
      });
    });
    return this.get(session.id);
  }

  // -------------------------------------------------------------------
  // Timeline and reconciliation
  // -------------------------------------------------------------------

  /**
   * The audit record of one browser session, newest first
   * (`docs/API.md` section 11).
   *
   * It is read from the event table rather than from a second log, because
   * `AGENTS.md` requires every meaningful state change to produce an event and
   * a timeline assembled from anything else would be a different set of facts.
   */
  async timeline(
    browserSessionId: string,
    projectId: string,
    limit = 100,
  ): Promise<readonly TimelineEntry[]> {
    const session = await this.get(browserSessionId);
    if (session.project_id !== projectId) throw notFound("The browser session");
    const rows = await this.#pool.query<{
      id: string;
      type: string;
      occurred_at: Date;
      actor_type: string;
      actor_display: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT id, type, occurred_at, actor_type, actor_display, payload
         FROM events
        WHERE project_id = $1
          AND correlation ->> 'browser_session_id' = $2
        ORDER BY occurred_at DESC, sequence DESC
        LIMIT $3`,
      [projectId, browserSessionId, Math.min(Math.max(limit, 1), 200)],
    );
    return rows.rows.map((row) => ({
      id: row.id,
      type: row.type,
      occurred_at: row.occurred_at.toISOString(),
      actor: { type: row.actor_type, display: row.actor_display },
      payload: row.payload,
    }));
  }

  /**
   * Applies a status the reconciler concluded (`docs/OPERATIONS.md` section 9).
   *
   * `DEGRADED` is the answer for "the worker is no longer reporting this
   * session": `docs/DOMAIN_MODEL.md` section 12 requires the session and its
   * metadata to be retained and to remain diagnosable rather than to be
   * terminated. `FAILED` is for a worker that is gone; evidence already
   * uploaded stays exactly where it is.
   */
  async markReconciled(
    browserSessionId: string,
    status: "DEGRADED" | "FAILED",
    reason: string,
  ): Promise<void> {
    const session = await this.get(browserSessionId);
    if (session.status === status) return;
    if (status === "FAILED") await this.#revokeLeases(session.id, reason);
    await this.#setStatus(
      session,
      status,
      { type: "system", display: "browser session reconciler" },
      status === "FAILED" ? "browser_session.failed" : "browser_session.degraded",
      { reason, trigger: "reconciliation" },
    );
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
