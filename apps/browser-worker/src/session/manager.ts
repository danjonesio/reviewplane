/**
 * Worker-level session orchestration: capacity, assignment, lifecycle and the
 * authorisation checks that run before any command touches a page.
 *
 * The lifecycle is the one in `docs/DOMAIN_MODEL.md` section 12. The
 * authorisation order is the one in `docs/SECURITY.md` section 7: the session
 * belongs to a project this worker serves, the session is active, the
 * controller owns the lease or the command is a non-interactive system
 * capture, and the control epoch matches.
 */

import { mkdir } from "node:fs/promises";

import type {
  BrowserCommand,
  BrowserCommandResult,
  CommandError,
  ControllerIdentity,
  SessionAllocate,
  SessionStatus,
  SessionStatusReport,
  TerminationReason,
} from "@reviewplane/protocol/browser";

import type { LiveMode, QualityState } from "@reviewplane/protocol/live-view";

import type { WorkerConfig } from "../config.ts";
import { createLogger, type Logger } from "../logging.ts";
import { executeCommand, buildResult, type ArtefactUploader } from "./commands.ts";
import { authoriseCommand } from "./control.ts";
import {
  ScreencastProducer,
  ScreencastUnavailableError,
  type LiveTransport,
} from "./screencast.ts";
import { BrowserSession, type SessionAllocation } from "./session.ts";
import type { ViewerPreference } from "./quality.ts";
import { captureSize } from "./viewport.ts";

/** Raised for a request the worker refuses before it reaches a session. */
export class SessionRefusal extends Error {
  readonly error: CommandError;

  constructor(error: CommandError) {
    super(error.message);
    this.error = error;
  }
}

export interface ManagerObserver {
  /** Called for every lifecycle transition the worker observes. */
  onStatus(session: BrowserSession, report: SessionStatusReport): void;
}

export interface SessionManagerOptions {
  readonly config: WorkerConfig;
  readonly artefacts: ArtefactUploader;
  readonly observer: ManagerObserver;
  readonly now?: () => Date;
  readonly logger?: Logger;
}

function refusal(
  code: CommandError["code"],
  message: string,
  retryable: boolean,
  currentEpoch?: number,
): CommandError {
  return {
    code,
    message,
    retryable,
    ...(currentEpoch === undefined ? {} : { current_epoch: currentEpoch }),
  };
}

export class SessionManager {
  readonly #config: WorkerConfig;
  readonly #artefacts: ArtefactUploader;
  readonly #observer: ManagerObserver;
  readonly #now: () => Date;
  readonly #logger: Logger;
  readonly #sessions = new Map<string, BrowserSession>();
  /** At most one live producer per session; the control plane fans out. */
  readonly #producers = new Map<string, ScreencastProducer>();
  #assignedProjects: ReadonlySet<string> | null = null;

  constructor(options: SessionManagerOptions) {
    this.#config = options.config;
    this.#artefacts = options.artefacts;
    this.#observer = options.observer;
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger ?? createLogger({ service: "browser-worker" });
  }

  /**
   * Records the projects the control plane assigned to this worker. Until it
   * is called the worker accepts nothing: `docs/SECURITY.md` section 6.4 says
   * a worker may only receive sessions compatible with its assignment, and
   * "not yet told" is not the same as "anything".
   */
  setAssignedProjects(projects: readonly string[]): void {
    this.#assignedProjects = new Set(projects);
  }

  get activeSessions(): number {
    return this.#sessions.size;
  }

  get sessions(): readonly BrowserSession[] {
    return [...this.#sessions.values()];
  }

  get(browserSessionId: string): BrowserSession | undefined {
    return this.#sessions.get(browserSessionId);
  }

  /** Allocates an isolated context, or refuses with a stable code. */
  async allocate(
    browserSessionId: string,
    request: SessionAllocate,
  ): Promise<BrowserSession> {
    if (this.#sessions.has(browserSessionId)) {
      const existing = this.#sessions.get(browserSessionId) as BrowserSession;
      return existing;
    }
    const assigned = this.#assignedProjects;
    if (assigned === null || !assigned.has(request.project_id)) {
      throw new SessionRefusal(
        refusal(
          "PROJECT_CONTEXT_MISMATCH",
          "This worker is not assigned to the project the browser session belongs to.",
          false,
        ),
      );
    }
    if (this.#sessions.size >= this.#config.capacity) {
      throw new SessionRefusal(
        refusal(
          "BROWSER_CAPACITY_EXHAUSTED",
          `This worker is already running its capacity of ${String(this.#config.capacity)} browser sessions.`,
          true,
        ),
      );
    }

    const allocation: SessionAllocation = {
      browserSessionId,
      organisationId: request.organisation_id,
      projectId: request.project_id,
      ...(request.agent_session_id === undefined
        ? {}
        : { agentSessionId: request.agent_session_id }),
      ...(request.published_service_id === undefined
        ? {}
        : { publishedServiceId: request.published_service_id }),
      ...(request.service_origin === undefined ? {} : { serviceOrigin: request.service_origin }),
      // reveal() is called exactly here, at the boundary where the credential
      // enters the session that will present it. It is held privately from
      // this point and never returned or logged.
      ...(request.service_capability === undefined
        ? {}
        : { serviceCapability: request.service_capability.reveal() }),
      viewport: request.viewport,
      controlEpoch: request.control_epoch,
      controller: request.controller,
      limits: this.#boundLimits(request),
      retentionClass: request.retention_class,
    };

    await mkdir(this.#config.sessionRoot, { recursive: true });
    const session = await BrowserSession.allocate(allocation, {
      sessionRoot: this.#config.sessionRoot,
      sandbox: this.#config.sandbox,
      ...(this.#config.tunnel === undefined ? {} : { tunnel: this.#config.tunnel }),
      onSelfTermination: (terminated, status, reason) => {
        this.#sessions.delete(terminated.id);
        void this.stopLive(terminated.id);
        this.#report(terminated, status, "ACTIVE", reason);
      },
    });
    this.#sessions.set(browserSessionId, session);
    this.#report(session, "READY", "ALLOCATING", "isolated context allocated");
    return session;
  }

  /**
   * Clamps the limits the control plane asked for to the ones this worker is
   * configured to enforce. `docs/ARCHITECTURE.md` section 4.5 makes limit
   * enforcement the worker's own responsibility, so it never widens them on
   * request.
   */
  #boundLimits(request: SessionAllocate): SessionAllocate["limits"] {
    const limits = request.limits;
    return {
      max_duration_seconds: Math.min(
        limits.max_duration_seconds,
        this.#config.maxSessionDurationSeconds,
      ),
      default_timeout_ms: Math.min(limits.default_timeout_ms, this.#config.defaultTimeoutMs),
      max_command_timeout_ms: Math.min(
        limits.max_command_timeout_ms,
        this.#config.maxCommandTimeoutMs,
      ),
      screenshot_max_bytes: Math.min(limits.screenshot_max_bytes, this.#config.screenshotMaxBytes),
      snapshot_max_nodes: Math.min(limits.snapshot_max_nodes, this.#config.snapshotMaxNodes),
      snapshot_max_bytes: Math.min(limits.snapshot_max_bytes, this.#config.snapshotMaxBytes),
    };
  }

  /**
   * Authorises and runs one command.
   *
   * A refusal is a result rather than an exception, because the control plane
   * records `browser.command_rejected` from it and the agent needs the stable
   * code and the epoch that is actually current.
   */
  async handleCommand(
    browserSessionId: string,
    controller: ControllerIdentity,
    epoch: number,
    sequence: number,
    command: BrowserCommand,
  ): Promise<BrowserCommandResult> {
    const session = this.#sessions.get(browserSessionId);
    if (session === undefined) {
      return buildResult(
        command.command,
        sequence,
        epoch,
        0,
        {},
        refusal(
          "BROWSER_SESSION_NOT_ACTIVE",
          "No such browser session on this worker.",
          false,
        ),
      );
    }
    if (!session.acceptsCommands) {
      return buildResult(
        command.command,
        sequence,
        session.controlEpoch,
        0,
        {},
        refusal(
          "BROWSER_SESSION_NOT_ACTIVE",
          `Browser session is ${session.status}.`,
          false,
          session.controlEpoch,
        ),
      );
    }
    if (!session.browserAlive) {
      // The browser died under us. Evidence already uploaded stays; the
      // session is failed rather than quietly retried
      // (docs/ARCHITECTURE.md section 14).
      await this.fail(session, "browser process is no longer connected");
      return buildResult(
        command.command,
        sequence,
        session.controlEpoch,
        0,
        {},
        refusal("BROWSER_SESSION_NOT_ACTIVE", "Browser session failed.", false),
      );
    }

    const denial = authoriseCommand(
      { epoch: session.controlEpoch, controller: session.controller, lastSequence: session.lastSequence },
      { command: command.command, controller, epoch, sequence },
    );
    if (denial !== null) {
      return buildResult(
        command.command,
        sequence,
        session.controlEpoch,
        0,
        {},
        refusal(denial.code, denial.message, denial.retryable, denial.currentEpoch),
      );
    }

    if (command.timeout_ms > session.limits.max_command_timeout_ms) {
      return buildResult(
        command.command,
        sequence,
        session.controlEpoch,
        0,
        {},
        refusal(
          "POLICY_DENIED",
          `Command timeout exceeds the ${String(session.limits.max_command_timeout_ms)} ms session limit.`,
          false,
        ),
      );
    }

    session.recordSequence(sequence);
    const result = await executeCommand(
      { session, artefacts: this.#artefacts, now: this.#now },
      command,
      sequence,
    );
    if (command.command === "navigate" && result.ok) {
      this.#report(session, session.status, "READY", "navigated");
    }
    return result;
  }

  // -------------------------------------------------------------------
  // Live frames
  // -------------------------------------------------------------------

  /**
   * Starts the live producer for one session.
   *
   * There is at most one producer per session: the control plane fans a single
   * worker stream out to however many viewers are attached, so a second viewer
   * costs the worker nothing and cannot be used to multiply capture work
   * (`docs/API.md` section 19).
   *
   * A screencast that will not start is reported as a refusal rather than
   * failing the session. `docs/DEVELOPMENT.md` section 11 requires the live
   * stream to degrade without breaking the workflow, so navigation, snapshots
   * and screenshots stay available on a session with no live frames.
   */
  async startLive(
    browserSessionId: string,
    mode: LiveMode,
    transport: LiveTransport,
  ): Promise<ScreencastProducer> {
    const session = this.#sessions.get(browserSessionId);
    if (session === undefined) {
      throw new SessionRefusal(
        refusal("RESOURCE_NOT_FOUND", "No such browser session on this worker.", false),
      );
    }
    if (!session.acceptsCommands) {
      throw new SessionRefusal(
        refusal(
          "BROWSER_SESSION_NOT_ACTIVE",
          `Browser session is ${session.status}.`,
          false,
          session.controlEpoch,
        ),
      );
    }
    if (this.#producers.has(browserSessionId)) {
      throw new SessionRefusal(
        refusal(
          "POLICY_DENIED",
          "This browser session already has a live producer; the control plane fans one stream out to every viewer.",
          true,
        ),
      );
    }
    const producer = new ScreencastProducer({
      browserSessionId,
      page: session.requirePage(),
      capture: captureSize(session.viewport),
      mode,
      logger: this.#logger,
      now: this.#now,
    });
    this.#producers.set(browserSessionId, producer);
    try {
      await producer.start(transport);
    } catch (error) {
      this.#producers.delete(browserSessionId);
      if (error instanceof ScreencastUnavailableError) {
        throw new SessionRefusal(
          refusal(
            "UNSUPPORTED_CAPABILITY",
            "Live capture could not be started for this session. Navigation and screenshot capture are unaffected.",
            true,
          ),
        );
      }
      throw error;
    }
    return producer;
  }

  /** Stops the live producer, if one is running. Safe to call repeatedly. */
  async stopLive(browserSessionId: string): Promise<void> {
    const producer = this.#producers.get(browserSessionId);
    if (producer === undefined) return;
    this.#producers.delete(browserSessionId);
    await producer.stop();
  }

  liveProducer(browserSessionId: string): ScreencastProducer | undefined {
    return this.#producers.get(browserSessionId);
  }

  /** Relays a viewer's advisory quality request to the scheduler. */
  async requestLiveQuality(
    browserSessionId: string,
    preference: ViewerPreference,
  ): Promise<QualityState> {
    const producer = this.#producers.get(browserSessionId);
    if (producer === undefined) {
      throw new SessionRefusal(
        refusal("RESOURCE_NOT_FOUND", "This browser session has no live producer.", false),
      );
    }
    return producer.requestQuality(preference);
  }

  /** Terminates a session and destroys its ephemeral data. */
  async terminate(
    browserSessionId: string,
    reason: TerminationReason,
    detail?: string,
  ): Promise<SessionStatusReport> {
    const session = this.#sessions.get(browserSessionId);
    if (session === undefined) {
      throw new SessionRefusal(
        refusal("RESOURCE_NOT_FOUND", "No such browser session on this worker.", false),
      );
    }
    const previous = session.status;
    session.setStatus("TERMINATING");
    this.#sessions.delete(browserSessionId);
    // The producer goes before the context does: a screencast still attached
    // to a closing page produces errors rather than frames.
    await this.stopLive(browserSessionId);
    await session.destroy();
    session.setStatus("TERMINATED");
    return this.#report(session, "TERMINATED", previous, detail ?? `terminated: ${reason}`);
  }

  /** Marks a session failed, preserving anything already uploaded. */
  async fail(session: BrowserSession, reason: string): Promise<SessionStatusReport> {
    const previous = session.status;
    this.#sessions.delete(session.id);
    await this.stopLive(session.id);
    await session.destroy();
    session.setStatus("FAILED");
    return this.#report(session, "FAILED", previous, reason);
  }

  /** Closes every session, for worker shutdown. */
  async shutdown(): Promise<void> {
    const ids = [...this.#sessions.keys()];
    for (const id of ids) {
      await this.terminate(id, "worker_shutdown").catch(() => undefined);
    }
  }

  #report(
    session: BrowserSession,
    status: SessionStatus,
    previous: SessionStatus,
    reason: string,
  ): SessionStatusReport {
    const report: SessionStatusReport = {
      status,
      previous_status: previous,
      reason,
      control_epoch: session.controlEpoch,
      current_controller: session.controller,
      occurred_at: this.#now().toISOString(),
    };
    this.#observer.onStatus(session, report);
    return report;
  }
}
