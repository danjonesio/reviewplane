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
  /**
   * The route this reservation has **asked** to be admitted to, which is not
   * the route it is bound to (ADR-0037).
   *
   * Binding mints a session-scoped route capability and only the process holding
   * the signing key may do that, so an allocation requested by the MCP endpoint
   * is recorded here and completed by `api`. It is a separate column rather than
   * an early write to `published_service_id` because that column is what the
   * agent-facing view calls "published service this session may reach", and a
   * session that has asked and not yet been authorised may reach nothing.
   */
  readonly requested_published_service_id: string | null;
  /** When admission was asked for, which is what the allocation deadline runs from. */
  readonly allocation_requested_at: string | null;
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
 * The scope a caller acts in, mirroring `published-services/repository.ts`.
 *
 * `organisationId` is `null` only for the organisation-wide bootstrap
 * administrator (ADR-0016); `projectIds` is `null` for a session not delegated
 * to a subset of projects. One rule about what a principal may reach, expressed
 * once.
 */
export interface SessionScope {
  readonly organisationId: string | null;
  readonly projectIds: readonly string[] | null;
}

/**
 * The scope the completion sweep runs in.
 *
 * Phase two acts for the **deployment** rather than for a principal: the
 * reservation was authorised when it was requested, and the process finishing it
 * has no session to read a scope from. It is named rather than written inline so
 * that "unscoped" is a deliberate, greppable choice instead of an omission — the
 * same reason `published-services/service.ts` names `EVERY_SCOPE`.
 *
 * It is not a hole. The authorisation phase two runs is a **joined** read
 * requiring the route, its connector, the project and the session to agree with
 * each other, and requiring the route's own allow-list to name the session. The
 * reservation is a request, not a grant, so a row written by the process that
 * cannot mint cannot widen what the process that can mint will do.
 */
const DEPLOYMENT_SCOPE: SessionScope = { organisationId: null, projectIds: null };

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
 *
 * `allocate` joined the set with ADR-0037. Allocation is a lifecycle act — it is
 * the transition `REQUESTED` → `ALLOCATING` → `READY` — and `docs/EVENTS.md` §7
 * already covers a refused lifecycle act with this event type. No new type is
 * added: an auditor asks "did anything try to act on this session and get
 * refused?", and a second type would let an auditor who checked one and not the
 * other get a confident wrong answer.
 */
export type LifecycleAct =
  | "pause"
  | "resume"
  | "end"
  | "allocate"
  | "control_request"
  | "control_release";

/**
 * The stable class a refused or failed allocation is recorded under.
 *
 * `#failReservation` used to record the caught error's `message` as free text,
 * where `docs/EVENTS.md` §8 requires a stable class and where the publication
 * path had already got it right: "No free text: the class is the diagnosis"
 * (`published-services/service.ts`). A refusal recorded as free text is not a
 * refusal an auditor can query for — a message changes with a refactor, and the
 * query that counted refused allocations stops counting them without failing.
 */
export type AllocationFailureClass =
  | "AUTHORISATION_DENIED"
  | "BROWSER_CAPACITY_EXHAUSTED"
  | "BROWSER_SESSION_NOT_ACTIVE"
  | "CONNECTOR_OFFLINE"
  | "IDENTITY_REVOKED"
  | "PROJECT_CONTEXT_MISMATCH"
  | "PUBLISHED_SERVICE_UNAVAILABLE"
  | "RESOURCE_NOT_FOUND"
  | "ROUTE_EXPIRED"
  | "UNSUPPORTED_CAPABILITY"
  | "VALIDATION_FAILED"
  | "CONTROL_PLANE_UNAVAILABLE"
  | "INTERNAL_ERROR";

const ALLOCATION_FAILURE_CLASSES: readonly string[] = [
  "AUTHORISATION_DENIED",
  "BROWSER_CAPACITY_EXHAUSTED",
  "BROWSER_SESSION_NOT_ACTIVE",
  "CONNECTOR_OFFLINE",
  "IDENTITY_REVOKED",
  "PROJECT_CONTEXT_MISMATCH",
  "PUBLISHED_SERVICE_UNAVAILABLE",
  "RESOURCE_NOT_FOUND",
  "ROUTE_EXPIRED",
  "UNSUPPORTED_CAPABILITY",
  "VALIDATION_FAILED",
  "CONTROL_PLANE_UNAVAILABLE",
];

/**
 * The class a thrown value is recorded as.
 *
 * Anything unrecognised becomes `INTERNAL_ERROR`: an honest "something inside
 * the control plane went wrong" beats an audit record nobody can query, and the
 * caller still receives the original error. It is the rule
 * `published-services/service.ts` already applies to a failed publication.
 */
export function allocationFailureClassOf(error: unknown): AllocationFailureClass {
  const code = error instanceof ApiError ? error.code : null;
  if (code !== null && ALLOCATION_FAILURE_CLASSES.includes(code)) {
    return code as AllocationFailureClass;
  }
  return "INTERNAL_ERROR";
}

/** One event of a browser session's timeline (`docs/API.md` section 11). */
export interface TimelineEntry {
  readonly id: string;
  readonly type: string;
  readonly occurred_at: string;
  readonly actor: { readonly type: string; readonly display: string | null };
  readonly payload: Record<string, unknown>;
}

/**
 * Resolves a published service into the binding a session is allocated with.
 *
 * `organisationId` is an argument and is never constructed by the implementation
 * (ADR-0037). The binder used to build its own scope as
 * `{ organisationId: null, projectIds: [projectId] }`, which was sound only
 * because a project identifier implies its organisation — an implication a
 * shipped release violated, and a rule that holds because of a second rule
 * elsewhere is the kind that stops holding silently (RVP-91, RVP-92).
 *
 * Only a process holding the capability signing key can implement this
 * usefully: binding mints, the control plane is the minting authority
 * (`docs/ARCHITECTURE.md` §7.3), and the MCP endpoint is deliberately built
 * without a key. That process implements {@link AllocationAuthoriser} instead
 * and asks `api` to finish the act (ADR-0021).
 */
export interface ServiceBinder {
  bind(input: {
    readonly publishedServiceId: string;
    readonly organisationId: string;
    readonly projectId: string;
    readonly browserSessionId: string;
    readonly actor: EventActor;
    readonly requestId: string;
  }): Promise<ServiceBinding>;
}

/**
 * Answers whether a session may be admitted to a route, without minting.
 *
 * It is the half of {@link ServiceBinder} that needs no secret, so it runs in
 * **either** process. That is what lets an agent's allocation be diagnosed where
 * it was asked for — a route in another project, a revoked connector, a route
 * that does not name the reservation — rather than failing silently a sweep
 * interval later, in a process the agent is not talking to.
 *
 * It is not the enforcement. The process that mints runs the same read again,
 * because the record it is acting on was written by a process with no authority
 * to grant anything.
 */
export interface AllocationAuthoriser {
  authorise(input: {
    readonly publishedServiceId: string;
    readonly organisationId: string;
    readonly projectId: string;
    readonly browserSessionId: string;
  }): Promise<void>;
}

/**
 * Withdraws the route capabilities minted for a browser session.
 *
 * A capability outliving the browser it was minted for is a credential nobody is
 * accounting for, so ending a session withdraws them (ADR-0037). This gives
 * `HttpTunnelGateway.revokeCapability` its first production caller.
 *
 * **Withdrawal is best effort, and every mention of it says so.** The gateway
 * verifies a capability from its signature without a database read, and RVP-76
 * records that its revocation set is in memory and does not survive a restart. A
 * revocation recorded here is durable in the control plane and not necessarily
 * at the gateway. The bound `mint` applies — a capability may not outlive its
 * session's maximum duration — is what stands when this fails, and it stands
 * without the gateway's cooperation. RVP-99 carries the gap.
 *
 * Both processes construct one. The MCP process may **withdraw** a capability
 * and still cannot mint one, which is ADR-0021's existing carve-out for
 * `development_service_unpublish` extended to the credential rather than only to
 * the route. That the gateway's control token is unscoped means "withdraws,
 * never registers" is restraint rather than authority — also RVP-76's, and
 * stated rather than assumed.
 */
export interface SessionCapabilityRevoker {
  revokeForSession(browserSessionId: string): Promise<readonly string[]>;
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

/**
 * How long a requested allocation may sit before the sweep takes it over.
 *
 * `api` allocates inline for its own callers, so a reservation it is working on
 * is milliseconds old. Waiting before the sweep touches one keeps the two paths
 * from allocating one reservation twice; the status-guarded `UPDATE` is what
 * makes a lost race cost one wasted claim rather than two allocations.
 */
export const ALLOCATION_GRACE_MS = 2_000;

/**
 * How long a reservation carrying a requested route may live before it is
 * failed, whatever state it is in.
 *
 * This is the mechanism and the sweep is only what notices. `docs/DOMAIN_MODEL.md`
 * §12's `REQUESTED` had no lifetime, and a `REQUESTED` row with
 * `ended_at IS NULL` is exactly what the worker capacity query counts — so a
 * reservation nothing could complete held a browser slot for ever. It is
 * comfortably longer than a Chromium context takes to come up, because failing a
 * reservation that was about to work would be worse than the slot it frees.
 */
export const ALLOCATION_DEADLINE_MS = 120_000;

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
    requested_published_service_id:
      (row["requested_published_service_id"] as string | null) ?? null,
    allocation_requested_at:
      row["allocation_requested_at"] === null || row["allocation_requested_at"] === undefined
        ? null
        : (row["allocation_requested_at"] as Date).toISOString(),
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

export interface BrowserSessionServiceOptions {
  /**
   * Answers whether a session may be admitted to a route, in a process that
   * cannot mint. Present in both processes; see {@link AllocationAuthoriser}.
   */
  readonly authoriser?: AllocationAuthoriser | null;
  /** Withdraws the capabilities a session held when it ends. Best effort. */
  readonly revoker?: SessionCapabilityRevoker | null;
  /** Injected for the tests that drive the deadline. */
  readonly now?: () => Date;
}

export class BrowserSessionService {
  readonly #pool: Pool;
  readonly #workers: WorkerRegistry;
  readonly #client: BrowserWorkerClient;
  readonly #binder: ServiceBinder | null;
  readonly #authoriser: AllocationAuthoriser | null;
  readonly #revoker: SessionCapabilityRevoker | null;
  readonly #now: () => Date;

  constructor(
    pool: Pool,
    workers: WorkerRegistry,
    client: BrowserWorkerClient,
    binder: ServiceBinder | null = null,
    options: BrowserSessionServiceOptions = {},
  ) {
    this.#pool = pool;
    this.#workers = workers;
    this.#client = client;
    this.#binder = binder;
    this.#authoriser = options.authoriser ?? null;
    this.#revoker = options.revoker ?? null;
    this.#now = options.now ?? (() => new Date());
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
    /**
     * The caller's scope. **Required**, and it is the whole of ADR-0037's
     * governing rule applied here: never source an authority input from the
     * record being authorised.
     *
     * This used to read through the unscoped `get()` and carry no caller scope
     * at all. Every authorisation it enjoyed happened above it, in the route
     * layer, and it held only because today's callers name a session they have
     * just created or have already resolved. `browser_session_allocate` takes a
     * session identifier **as an argument**, so it inherits none of that — and a
     * property of every caller is not a property of this function.
     */
    readonly scope: SessionScope;
    readonly publishedServiceId?: string;
    readonly actor: EventActor;
    readonly requestId: string;
  }): Promise<BrowserSessionRecord> {
    // The identifier, the caller's project scope and the caller's organisation
    // are one `WHERE` clause, and a session in another tenancy earns the refusal
    // an unknown identifier earns, byte for byte (`docs/SECURITY.md` §7).
    const session = await this.getForScope(input.browserSessionId, input.scope);
    if (session.status !== "REQUESTED") {
      // Deliberately does not fail the session: it is already allocated, and a
      // second allocation attempt is the caller's mistake rather than the
      // session's.
      const refusal = new ApiError(
        "BROWSER_SESSION_NOT_ACTIVE",
        "Only a reserved browser session can be allocated.",
        { browser_session_status: session.status },
      );
      await this.#recordAllocationRejection(session, input.actor, refusal);
      throw refusal;
    }
    if (session.worker_id === null) {
      await this.#failReservation(session, input.actor, "BROWSER_CAPACITY_EXHAUSTED");
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
          // Both terms, and neither invented here. The organisation comes from
          // the session row the scoped read returned, and the joined query the
          // binder runs requires the route's project to belong to it — so a row
          // whose two columns disagreed is refused rather than honoured.
          organisationId: session.organisation_id,
          projectId: session.project_id,
          browserSessionId: session.id,
          actor: input.actor,
          requestId: input.requestId,
        });
      } catch (error) {
        await this.#failReservation(session, input.actor, allocationFailureClassOf(error));
        throw error;
      }
      await this.#pool.query(
        // The request is **cleared** in the same statement that records the
        // bind. `requested_published_service_id` means exactly "this reservation
        // asked for a route and has not been bound to one", so a bound session
        // can never match the sweep, and the agent-facing
        // `published_service_id` — "the service this session may reach" — stays
        // a fact rather than becoming an intention.
        `UPDATE browser_sessions
            SET published_service_id = $2,
                service_origin = $3,
                requested_published_service_id = NULL,
                allocation_requested_at = NULL
          WHERE id = $1`,
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
      const reported = await this.#explainWorkerRefusal(session, error);
      const failing = await this.get(session.id);
      // The stable class, not the exception's text. `docs/EVENTS.md` §8 requires
      // a reason code for a failure, and the same rule that fixed
      // `#failReservation` applies to the worker's own refusal.
      await this.#setStatus(failing, "FAILED", input.actor, "browser_session.failed", {
        reason_code: allocationFailureClassOf(reported),
        trigger: "worker_refused",
      });
      await this.#withdrawCapabilities(session.id);
      throw reported;
    }
  }

  /**
   * Phase one of an allocation asked for by a process that cannot mint.
   *
   * It resolves the reservation in the caller's scope, checks that the caller
   * may admit it, asks {@link AllocationAuthoriser} whether the route admits it,
   * and writes the request. **It touches nothing outside PostgreSQL**: it mints
   * nothing, contacts no worker and reaches no gateway (ADR-0021, ADR-0037).
   *
   * The authorisation read runs here as well as in phase two, and the two are
   * not redundant. Here it is what lets the agent be told *why* — a route in
   * another project, a revoked connector, a route that does not name this
   * reservation — in the call it made, rather than a sweep interval later in a
   * process it is not talking to. There it is the enforcement, because the row
   * it acts on was written by a process with no authority to grant anything.
   */
  async requestAllocation(input: {
    readonly browserSessionId: string;
    readonly scope: SessionScope;
    readonly publishedServiceId: string;
    readonly actor: EventActor;
    readonly requestId: string;
  }): Promise<BrowserSessionRecord> {
    const session = await this.getForScope(input.browserSessionId, input.scope);
    if (session.status !== "REQUESTED") {
      const refusal = new ApiError(
        "BROWSER_SESSION_NOT_ACTIVE",
        "Only a reserved browser session can be allocated.",
        { browser_session_status: session.status },
      );
      await this.#recordAllocationRejection(session, input.actor, refusal);
      throw refusal;
    }
    if (this.#authoriser === null) {
      throw new ApiError(
        "UNSUPPORTED_CAPABILITY",
        "This control plane cannot admit a browser session to a published service.",
      );
    }
    try {
      await this.#authoriser.authorise({
        publishedServiceId: input.publishedServiceId,
        organisationId: session.organisation_id,
        projectId: session.project_id,
        browserSessionId: session.id,
      });
    } catch (error) {
      // The refusal is recorded and the reservation is **not** failed. Nothing
      // has been claimed and no worker has been contacted, so the reservation is
      // still usable: an agent that named the wrong route can publish the right
      // one and call again, which is what an agent that fixed its arguments
      // needs. It still holds a worker slot, and the deadline sweep is what ends
      // one nobody comes back for.
      await this.#recordAllocationRejection(session, input.actor, error);
      throw error;
    }

    const now = this.#now();
    await inTransaction(this.#pool, async (client) => {
      await client.query(
        `UPDATE browser_sessions
            SET requested_published_service_id = $2, allocation_requested_at = $3
          WHERE id = $1 AND status = 'REQUESTED'`,
        [session.id, input.publishedServiceId, now.toISOString()],
      );
      await appendEvent(client, {
        // The amendment to the reservation, on the type the reservation itself
        // was recorded under. A second event type for "the same session, now
        // asking for a route" would split one session's story across two names.
        type: "browser_session.requested",
        organisationId: session.organisation_id,
        projectId: session.project_id,
        actor: input.actor,
        correlation: {
          request_id: input.requestId,
          browser_session_id: session.id,
          published_service_id: input.publishedServiceId,
        },
        payload: {
          requested_published_service_id: input.publishedServiceId,
          allocation_requested_at: now.toISOString(),
          control_epoch: session.control_epoch,
        },
        occurredAt: now,
      });
    });
    return this.get(session.id);
  }

  /**
   * Phase two: completes allocations another process requested.
   *
   * It runs only where the capability signing key is. `olderThanMs` is what
   * keeps it from racing the inline path, and the status guard is in the
   * `UPDATE` {@link allocate} performs through `#setStatus`, so the worst a lost
   * race costs is one wasted claim rather than two allocations for one request.
   */
  async completePendingAllocations(
    options: { readonly olderThanMs?: number; readonly limit?: number } = {},
  ): Promise<BrowserSessionRecord[]> {
    const olderThan = new Date(this.#now().getTime() - (options.olderThanMs ?? ALLOCATION_GRACE_MS));
    const pending = await this.#pool.query(
      `SELECT * FROM browser_sessions
        WHERE status = 'REQUESTED'
          AND ended_at IS NULL
          AND requested_published_service_id IS NOT NULL
          AND allocation_requested_at <= $1
        ORDER BY allocation_requested_at
        LIMIT $2`,
      [olderThan.toISOString(), options.limit ?? 25],
    );
    const finished: BrowserSessionRecord[] = [];
    for (const row of pending.rows) {
      const session = toRecord(row as Record<string, unknown>);
      const routeId = session.requested_published_service_id;
      if (routeId === null) continue;
      try {
        finished.push(
          await this.allocate({
            browserSessionId: session.id,
            // Phase two acts for the deployment; see DEPLOYMENT_SCOPE.
            scope: DEPLOYMENT_SCOPE,
            publishedServiceId: routeId,
            actor: { type: "system", display: "browser session allocator" },
            requestId: `alloc_${session.id}`,
          }),
        );
      } catch {
        // `allocate` has already failed the reservation and recorded the class.
        // There is no caller to rethrow to, and a sweep that stopped at the
        // first refusal would leave every later reservation holding a slot.
        finished.push(await this.get(session.id).catch(() => session));
      }
    }
    return finished;
  }

  /**
   * Fails every reservation carrying a requested route that has outlived the
   * allocation deadline, whatever state it is in.
   *
   * This is the half of ADR-0021 that turned out to matter. "Nothing stays in
   * `requested`" was kept by the route's own **lifetime** and not by a
   * one-second timer; a browser-session reservation had no lifetime, and a
   * `REQUESTED` row with `ended_at IS NULL` is exactly what the capacity query
   * counts. So the deadline is the mechanism and this sweep is only what
   * notices.
   *
   * It touches only reservations that carry a requested route. A reservation
   * made with `allocate: false` and no route is somebody's in-progress work and
   * is left alone; bounding *that* one is its own issue.
   */
  async failOverdueAllocations(
    options: {
      readonly deadlineMs?: number;
      readonly limit?: number;
      /** One reservation, for the caller whose own wait has just ended. */
      readonly browserSessionId?: string;
      /**
       * One agent session's own reservations.
       *
       * This is what makes the sweep callable from the MCP process without it
       * performing a deployment-wide write. `api`'s sweep is what releases a
       * stranded reservation and, if `api` is down, nothing else does — while
       * the MCP process can still start **unbound** sessions, because those need
       * no signing key. So stranded reservations compete for worker capacity
       * with work that would otherwise succeed, and four of them fill a default
       * worker: the incident at `create()` reproduced by the fix for it.
       *
       * An agent that keeps working therefore reclaims the slots it stranded,
       * which is the case that fills a worker. An agent that stops leaves its
       * reservations for `api`. That narrows the limit rather than closing it,
       * and ADR-0037 says so in those words.
       */
      readonly agentSessionId?: string;
    } = {},
  ): Promise<BrowserSessionRecord[]> {
    const cutoff = new Date(this.#now().getTime() - (options.deadlineMs ?? ALLOCATION_DEADLINE_MS));
    const overdue = await this.#pool.query(
      `SELECT * FROM browser_sessions
        WHERE ended_at IS NULL
          AND status IN ('REQUESTED', 'ALLOCATING', 'DEGRADED')
          AND requested_published_service_id IS NOT NULL
          AND allocation_requested_at <= $1
          AND ($3::text IS NULL OR id = $3)
          AND ($4::text IS NULL OR agent_session_id = $4)
        ORDER BY allocation_requested_at
        LIMIT $2`,
      [
        cutoff.toISOString(),
        options.limit ?? 50,
        options.browserSessionId ?? null,
        options.agentSessionId ?? null,
      ],
    );
    const failed: BrowserSessionRecord[] = [];
    for (const row of overdue.rows) {
      const session = toRecord(row as Record<string, unknown>);
      await this.#failReservation(
        session,
        { type: "system", display: "browser session allocator" },
        // The honest diagnosis in both states. A reservation nobody claimed and
        // one somebody claimed and abandoned are the same fact from the
        // reservation's side: the control plane was not there to finish it.
        "CONTROL_PLANE_UNAVAILABLE",
        "allocation_deadline",
      );
      // `ALLOCATING` past the deadline means something claimed it and did not
      // finish, possibly after the worker had begun opening a context. The
      // worker is asked to drop it; a worker that never had one answers
      // harmlessly, and the call is best effort either way.
      if (session.status === "ALLOCATING" && session.worker_id !== null) {
        await this.#client
          .terminate(session.worker_id, session.id, "failure")
          .catch(() => undefined);
      }
      failed.push(await this.get(session.id));
    }
    return failed;
  }

  /**
   * Waits, bounded, for a requested allocation to reach a terminal answer.
   *
   * **The wait ends in the record as it stands.** A reservation still `REQUESTED`
   * or `ALLOCATING` when the deadline passes is reported as such and never as
   * ready: an agent that navigated to an origin nothing was carrying would read
   * the failure as a fault in the application it is reviewing.
   *
   * It applies the deadline sweep's own `UPDATE` when its wait ends, so the
   * promise that nothing stays requested does not depend on a timer in the
   * process that may be the one that is down.
   */
  async awaitAllocation(
    browserSessionId: string,
    scope: SessionScope,
    options: { readonly timeoutMs: number; readonly pollMs?: number },
  ): Promise<BrowserSessionRecord> {
    const pollMs = options.pollMs ?? 100;
    const deadline = Date.now() + options.timeoutMs;
    for (;;) {
      const record = await this.getForScope(browserSessionId, scope);
      if (record.status !== "REQUESTED" && record.status !== "ALLOCATING") return record;
      if (Date.now() >= deadline) {
        // This reservation and no other. A sweep here that failed every overdue
        // row would have one agent's timeout end another agent's allocation.
        await this.failOverdueAllocations({
          deadlineMs: options.timeoutMs,
          limit: 1,
          browserSessionId,
        }).catch(() => undefined);
        return this.getForScope(browserSessionId, scope);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /**
   * Distinguishes "this worker does not serve that project" from "this worker
   * has not been told yet".
   *
   * Both arrive as `PROJECT_CONTEXT_MISMATCH` from the worker, and the second
   * one contradicts everything the caller can see: the control plane checked
   * the same assignment moments earlier and passed it, and the fleet view lists
   * the project against the worker. The two are one fact in two copies —
   * `browser_worker_projects` here, and an in-memory set on the worker that
   * converges on the next heartbeat (ADR-0026) — and only this side can compare
   * them.
   *
   * It changes no decision. The refusal stands, because the worker's check is
   * the one protecting the browser and a control plane that talked it round
   * would be enforcing nothing. What changes is that the answer says which of
   * the two conditions it is, and how long the second one lasts.
   *
   * `docs/UX_FLOWS.md` section 18: a refusal names the condition and the way
   * out, rather than restating the rule.
   */
  async #explainWorkerRefusal(
    session: BrowserSessionRecord,
    error: unknown,
  ): Promise<unknown> {
    if (!(error instanceof ApiError) || error.code !== "PROJECT_CONTEXT_MISMATCH") return error;
    if (session.worker_id === null) return error;
    const assigned = await this.#workers.assignedProjects(session.worker_id);
    if (!assigned.includes(session.project_id)) return error;
    const seconds = this.#workers.config.heartbeatIntervalSeconds;
    return new ApiError(
      "PROJECT_CONTEXT_MISMATCH",
      `The browser worker refused this session's project, but the control plane has it assigned: the worker's copy of its assignment is stale and is restated on its next heartbeat, within ${String(seconds)} seconds of the assignment (ADR-0026). Retry after that; no restart is needed.`,
      { browser_worker_assignment: "stale", heartbeat_interval_seconds: seconds },
    );
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
      // The session was created by this call from these two identifiers, so the
      // scope is the caller's own and is not read back off the row.
      scope: { organisationId: input.organisationId, projectIds: [input.projectId] },
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
   *
   * The reason is a **stable class** and never the caught error's message. It
   * was the message until ADR-0037, which `docs/EVENTS.md` §8 forbids and which
   * the publication path had already got right: "No free text: the class is the
   * diagnosis". A refusal recorded as free text is not one an auditor can query
   * for — the query that counted refused allocations stops counting them the
   * first time somebody rewords an exception, and nothing fails.
   */
  async #failReservation(
    session: BrowserSessionRecord,
    actor: EventActor,
    reasonCode: AllocationFailureClass,
    trigger: "allocation_refused" | "allocation_deadline" = "allocation_refused",
  ): Promise<void> {
    await this.#revokeLeases(session.id, `allocation refused: ${reasonCode}`);
    await this.#setStatus(session, "FAILED", actor, "browser_session.failed", {
      reason_code: reasonCode,
      // The two are distinguished because they send an operator to different
      // places: a refusal is the request's fault and names its own class, and a
      // deadline is the control plane not having been there to finish one.
      trigger,
      // The status the record was actually in, for the reason the route expiry
      // sweep records it: a status it was never in is a fact an auditor cannot
      // see through (`docs/EVENTS.md` §7).
      previous_status: session.status,
    });
    // A reservation that never allocated normally holds no capability. It can:
    // the bind mints before the worker call, so a worker refusal fails a
    // reservation that already has one. Withdrawal is best effort (RVP-99).
    await this.#withdrawCapabilities(session.id);
  }

  /**
   * Records a refused allocation.
   *
   * `docs/EVENTS.md` §7 already covers a refused lifecycle act with
   * `browser.command_rejected` and `kind: "lifecycle"`, so no new event type is
   * added: an auditor asks "did anything try to act on this session and get
   * refused?", and a second type would let an auditor who checked one and not
   * the other get a confident wrong answer.
   *
   * Allocation presents no epoch — a reservation has never had a controller
   * transition — so the session's own is recorded, exactly as `requestControl`
   * does for the two refusals that precede a decision.
   */
  async #recordAllocationRejection(
    session: BrowserSessionRecord,
    actor: EventActor,
    error: unknown,
  ): Promise<void> {
    await this.#recordLifecycleRejection(
      session,
      {
        act: "allocate",
        controlEpoch: session.control_epoch,
        controller: session.current_controller ?? { type: "system", id: "sys_allocation" },
        actor,
        projectId: session.project_id,
      },
      {
        code: allocationFailureClassOf(error) as CommandDenial["code"],
        message: error instanceof Error ? error.message : "The allocation was refused.",
        reason: "allocation_refused",
      },
    );
  }

  /**
   * Records a refused lifecycle act where there is no session to correlate to.
   *
   * Two refusals reach it, and neither can use {@link #recordLifecycleRejection}
   * because both happen before or instead of resolving a session record: a
   * `browser_session_start` that named a route, which is refused **before**
   * anything is reserved, and a `browser_session_allocate` naming a session that
   * is not resolvable in the caller's scope.
   *
   * The record goes to the **actor's** project stream, which is the same rule a
   * cross-project attempt already follows: writing it to a stream the caller
   * cannot read would let a stranger append rows to somebody else's timeline.
   * It carries no `browser_session_id`, which is the shape
   * `published-services/reconciliation.ts` already uses for a route the control
   * plane never had.
   *
   * This exists because a refusal that happens before the domain layer is a
   * refusal the domain layer cannot record — RVP-49's trap — and a correct,
   * unrecorded denial is the defect class this repository has shipped more than
   * once.
   */
  async recordUnresolvedLifecycleRejection(input: {
    readonly organisationId: string;
    readonly projectId: string;
    readonly act: LifecycleAct;
    readonly actor: EventActor;
    readonly controllerType: ControllerIdentity["type"];
    readonly reasonCode: AllocationFailureClass;
    readonly reason: string;
  }): Promise<void> {
    await inTransaction(this.#pool, async (client) => {
      await appendEvent(client, {
        type: "browser.command_rejected",
        organisationId: input.organisationId,
        projectId: input.projectId,
        actor: input.actor,
        // No `browser_session_id`: there is no session, or none this caller is
        // entitled to be told about. A fabricated correlation would be worse
        // than none — it would file the attempt against somebody else's record.
        correlation: {},
        payload: {
          kind: "lifecycle",
          command: input.act,
          reason_code: input.reasonCode,
          reason: input.reason,
          interactive: true,
          presented_controller_type: input.controllerType,
          // The counterpart of `cross_project`: it says the record carries no
          // session because there was none to name, so an auditor does not read
          // a missing correlation as a lost write.
          browser_session_unresolved: true,
        },
      });
    });
  }

  /**
   * Withdraws the route capabilities a session held, best effort.
   *
   * The gateway is told first and the record is marked second, by the revoker.
   * A failure is swallowed: this runs on the way *out* of a session, and a
   * termination that failed because the gateway was unreachable would leave a
   * browser running that somebody asked to stop — which is worse than a
   * capability that expires on its own. The mint's session bound is what limits
   * that window; RVP-99 is what closes it.
   */
  async #withdrawCapabilities(browserSessionId: string): Promise<void> {
    if (this.#revoker === null) return;
    await this.#revoker.revokeForSession(browserSessionId).catch(() => undefined);
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
    // The gateway first, then the record — the revoker's own ordering, and the
    // one revocation and reconnect reconciliation already use: marking a record
    // closed while the gateway still carried it turns a closure into a claim.
    // Best effort; see {@link SessionCapabilityRevoker}.
    await this.#withdrawCapabilities(session.id);
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
      // A worker-reported end is an end: the browser is gone, so the credential
      // it was holding is withdrawn on the same terms as a controller-requested
      // termination. Best effort; see {@link SessionCapabilityRevoker}.
      await this.#withdrawCapabilities(session.id);
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
