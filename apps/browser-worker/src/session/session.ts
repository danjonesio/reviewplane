/**
 * One browser session: an isolated Chromium context with an ephemeral profile.
 *
 * `docs/DOMAIN_MODEL.md` section 12 owns the lifecycle and the record fields;
 * `docs/ARCHITECTURE.md` section 6.2 owns the isolation posture. Each session
 * gets its own profile directory under the worker's session root and its own
 * browser process, so nothing — cookies, storage, cache, service workers —
 * survives termination or crosses into another session or project.
 *
 * The context is launched with the Chromium sandbox enabled. `docs/SECURITY.md`
 * section 10 allows disabling it only behind an explicit high-risk
 * configuration, which `config.ts` makes an operator opt into by name.
 */

import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { chromium, type BrowserContext, type Page } from "playwright-core";

import type {
  ControllerIdentity,
  RetentionClass,
  SessionLimits,
  SessionStatus,
  Viewport,
} from "@reviewplane/protocol/browser";

import type { SandboxMode } from "../config.ts";
import type { Snapshot } from "./snapshot.ts";
import { playwrightViewport } from "./viewport.ts";

/** Allocation request, in worker terms. */
export interface SessionAllocation {
  readonly browserSessionId: string;
  readonly organisationId: string;
  readonly projectId: string;
  readonly agentSessionId?: string;
  readonly publishedServiceId?: string;
  readonly serviceOrigin?: string;
  /**
   * Session-scoped route capability. The worker presents it to the tunnel
   * gateway on every request to serviceOrigin and to no other origin, and it is
   * never written to a log: it is held as a private field and read only when a
   * request header is being built.
   */
  readonly serviceCapability?: string;
  readonly viewport: Viewport;
  readonly controlEpoch: number;
  readonly controller: ControllerIdentity;
  readonly limits: SessionLimits;
  readonly retentionClass: RetentionClass;
}

export interface SessionEnvironment {
  readonly sessionRoot: string;
  readonly sandbox: SandboxMode;
  /**
   * How Chromium reaches the tunnel gateway (ADR-0015).
   *
   * `*.internal.invalid` has no DNS, deliberately: the origin names a route,
   * not a host, and the reserved TLD guarantees no resolver anywhere will
   * answer for it. The mapping is handed to Chromium so that the browser
   * connects to the gateway without a resolver being involved at all.
   */
  readonly tunnel?: TunnelAccess;
  /** Called when the worker itself ends the session, for example on timeout. */
  readonly onSelfTermination: (
    session: BrowserSession,
    status: SessionStatus,
    reason: string,
  ) => void;
}

/**
 * The header the tunnel gateway authorises on.
 *
 * It matches `CapabilityHeader` in `services/tunnel-gateway`. A header rather
 * than a query parameter or part of the origin, because both of those end up
 * somewhere durable: an origin appears in Referer and in the development
 * server's access log, a query parameter appears in those plus browser history.
 * The gateway strips the whole `X-ReviewPlane-` namespace before the request
 * reaches the development service.
 */
const CAPABILITY_HEADER = "x-reviewplane-capability";

/** Where an internal origin resolves to, and what certificate is trusted there. */
export interface TunnelAccess {
  /** Domain the internal origins live under, without a leading dot. */
  readonly internalSuffix: string;
  /** `host:port` of the tunnel gateway's browser-facing listener. */
  readonly gatewayAddress: string;
  /**
   * Base64 SHA-256 of the gateway certificate's SubjectPublicKeyInfo.
   *
   * The gateway serves a certificate for a reserved TLD issued by a private
   * authority, which no public trust store can vouch for. Pinning that one key
   * is narrower than installing an authority that could then vouch for
   * anything: a certificate for any other name, or from any other issuer, still
   * fails. ADR-0015 records why this rather than a CA import.
   */
  readonly certificateSpki: string;
}

/**
 * The Chromium flags that make an internal origin reachable.
 *
 * Both are scoped to the suffix and to one public key. Neither disables
 * certificate verification generally, and neither widens what the session may
 * reach: the egress policy still refuses every origin but the session's own.
 */
export function tunnelArguments(tunnel: TunnelAccess | undefined): string[] {
  if (tunnel === undefined) return [];
  return [
    `--host-resolver-rules=MAP *.${tunnel.internalSuffix} ${tunnel.gatewayAddress}`,
    `--ignore-certificate-errors-spki-list=${tunnel.certificateSpki}`,
  ];
}

const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  "TERMINATED",
  "FAILED",
]);

export class BrowserSession {
  readonly id: string;
  readonly organisationId: string;
  readonly projectId: string;
  readonly agentSessionId: string | undefined;
  readonly publishedServiceId: string | undefined;
  readonly serviceOrigin: string | undefined;
  readonly limits: SessionLimits;
  readonly retentionClass: RetentionClass;
  readonly createdAt: Date;

  #status: SessionStatus = "REQUESTED";
  #viewport: Viewport;
  #controlEpoch: number;
  #controller: ControllerIdentity;
  #lastSequence = -1;
  #context: BrowserContext | null = null;
  #page: Page | null = null;
  #profileDirectory: string | null = null;
  #snapshot: Snapshot | null = null;
  #browserVersion = "unknown";
  #durationTimer: NodeJS.Timeout | null = null;
  #endedAt: Date | null = null;
  /** Never logged, never returned, never put on a request to another origin. */
  readonly #serviceCapability: string | undefined;

  private constructor(allocation: SessionAllocation) {
    this.id = allocation.browserSessionId;
    this.organisationId = allocation.organisationId;
    this.projectId = allocation.projectId;
    this.agentSessionId = allocation.agentSessionId;
    this.publishedServiceId = allocation.publishedServiceId;
    this.serviceOrigin = allocation.serviceOrigin;
    this.#serviceCapability = allocation.serviceCapability;
    this.limits = allocation.limits;
    this.retentionClass = allocation.retentionClass;
    this.createdAt = new Date();
    this.#viewport = allocation.viewport;
    this.#controlEpoch = allocation.controlEpoch;
    this.#controller = allocation.controller;
  }

  static async allocate(
    allocation: SessionAllocation,
    environment: SessionEnvironment,
  ): Promise<BrowserSession> {
    const session = new BrowserSession(allocation);
    session.#status = "ALLOCATING";
    try {
      // One directory per session, created fresh. Its removal on termination
      // is what "ephemeral session data is destroyed" means in practice.
      const directory = await mkdtemp(join(environment.sessionRoot, "session-"));
      session.#profileDirectory = directory;

      const context = await chromium.launchPersistentContext(directory, {
        headless: true,
        chromiumSandbox: environment.sandbox === "required",
        ...playwrightViewport(allocation.viewport),
        acceptDownloads: false,
        serviceWorkers: "block",
        // A hostile page must not be able to open a window that escapes the
        // session's egress policy.
        permissions: [],
        args: tunnelArguments(environment.tunnel),
      });
      session.#context = context;
      session.#browserVersion = context.browser()?.version() ?? "unknown";

      await session.#applyEgressPolicy(context);

      const existing = context.pages();
      session.#page = existing[0] ?? (await context.newPage());
      session.#page.setDefaultTimeout(allocation.limits.default_timeout_ms);
      session.#page.setDefaultNavigationTimeout(allocation.limits.default_timeout_ms);

      session.#status = "READY";
      session.#armDurationLimit(environment);
      return session;
    } catch (error) {
      session.#status = "FAILED";
      await session.destroy();
      throw error;
    }
  }

  /**
   * Restricts the session to the origin of its published service.
   *
   * `docs/ARCHITECTURE.md` section 6.2 allows "explicit network routes only",
   * and the issue's security notes state the worker must not have general
   * internet access by default. Navigation is checked separately; this is the
   * subresource-level control, so an image, script or fetch inside an
   * otherwise permitted page cannot reach elsewhere either.
   */
  async #applyEgressPolicy(context: BrowserContext): Promise<void> {
    const allowed = this.serviceOrigin;
    const capability = this.#serviceCapability;
    await context.route("**/*", (route) => {
      const target = route.request().url();
      if (target.startsWith("about:") || target.startsWith("data:")) {
        void route.continue();
        return;
      }
      if (allowed !== undefined && isWithinOrigin(target, allowed)) {
        if (capability === undefined) {
          void route.continue();
          return;
        }
        // The capability is attached inside the branch that has already
        // established the request is for this session's own origin. A
        // context-wide extra header would instead put a bearer credential on
        // requests this policy is about to refuse, and would follow a redirect
        // to wherever it led.
        void route.continue({
          headers: { ...route.request().headers(), [CAPABILITY_HEADER]: capability },
        });
        return;
      }
      void route.abort("blockedbyclient");
    });
  }

  #armDurationLimit(environment: SessionEnvironment): void {
    const milliseconds = this.limits.max_duration_seconds * 1000;
    this.#durationTimer = setTimeout(() => {
      void (async () => {
        await this.destroy();
        this.#status = "TERMINATED";
        environment.onSelfTermination(
          this,
          "TERMINATED",
          `session exceeded its ${String(this.limits.max_duration_seconds)} second duration limit`,
        );
      })();
    }, milliseconds);
    // The limit must not by itself keep the worker process alive.
    this.#durationTimer.unref();
  }

  get status(): SessionStatus {
    return this.#status;
  }

  get viewport(): Viewport {
    return this.#viewport;
  }

  get controlEpoch(): number {
    return this.#controlEpoch;
  }

  get controller(): ControllerIdentity {
    return this.#controller;
  }

  get lastSequence(): number {
    return this.#lastSequence;
  }

  get browserVersion(): string {
    return this.#browserVersion;
  }

  get profileDirectory(): string | null {
    return this.#profileDirectory;
  }

  get endedAt(): Date | null {
    return this.#endedAt;
  }

  get snapshot(): Snapshot | null {
    return this.#snapshot;
  }

  /** The page commands operate on. Throws when the session is not usable. */
  requirePage(): Page {
    const page = this.#page;
    if (page === null) throw new Error(`browser session ${this.id} has no page`);
    return page;
  }

  /** Whether the session can accept commands (`BROWSER_SESSION_NOT_ACTIVE`). */
  get acceptsCommands(): boolean {
    return this.#status === "READY" || this.#status === "ACTIVE";
  }

  get isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this.#status);
  }

  markActive(): void {
    if (this.#status === "READY") this.#status = "ACTIVE";
  }

  setStatus(status: SessionStatus): void {
    this.#status = status;
    if (TERMINAL_STATUSES.has(status) && this.#endedAt === null) this.#endedAt = new Date();
  }

  recordSequence(sequence: number): void {
    if (sequence > this.#lastSequence) this.#lastSequence = sequence;
  }

  /** Replaces the current snapshot, disposing the one it supersedes. */
  async replaceSnapshot(snapshot: Snapshot | null): Promise<void> {
    const previous = this.#snapshot;
    this.#snapshot = snapshot;
    if (previous !== null) await previous.handle.dispose().catch(() => undefined);
  }

  /**
   * Applies a new viewport. Every outstanding element reference is invalidated
   * first, because `docs/MCP_SPEC.md` section 7.4 requires a resize to produce
   * a new snapshot rather than to silently renumber the old one.
   */
  async resize(viewport: Viewport): Promise<void> {
    await this.replaceSnapshot(null);
    const page = this.requirePage();
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    this.#viewport = viewport;
  }

  /** Whether the browser process is still there (`docs/ARCHITECTURE.md` §14). */
  get browserAlive(): boolean {
    const context = this.#context;
    if (context === null) return false;
    const browser = context.browser();
    return browser === null ? true : browser.isConnected();
  }

  /**
   * Closes the context and removes the ephemeral profile directory. Safe to
   * call more than once, and safe to call after a crash.
   */
  async destroy(): Promise<void> {
    if (this.#durationTimer !== null) {
      clearTimeout(this.#durationTimer);
      this.#durationTimer = null;
    }
    await this.replaceSnapshot(null);
    const context = this.#context;
    this.#context = null;
    this.#page = null;
    if (context !== null) {
      const browser = context.browser();
      await context.close().catch(() => undefined);
      // Closing the persistent context closes its browser, but waiting for
      // the process explicitly keeps a terminated session from leaving a
      // Chromium behind competing for the worker's own CPU.
      if (browser !== null) await browser.close().catch(() => undefined);
    }
    const directory = this.#profileDirectory;
    this.#profileDirectory = null;
    if (directory !== null) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
    if (this.#endedAt === null) this.#endedAt = new Date();
  }
}

/** Whether a directory still exists, used by the destruction tests. */
export async function directoryExists(path: string): Promise<boolean> {
  try {
    const entry = await stat(path);
    return entry.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether a URL belongs to the session's published-service origin.
 *
 * Compared on parsed origin rather than on a string prefix, so
 * `https://route-id.internal.invalid.attacker.example` does not match
 * `https://route-id.internal.invalid`.
 */
export function isWithinOrigin(target: string, origin: string): boolean {
  let targetUrl: URL;
  let originUrl: URL;
  try {
    targetUrl = new URL(target);
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  return targetUrl.origin === originUrl.origin;
}
