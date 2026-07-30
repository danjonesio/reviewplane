/**
 * Rate and size limits for live viewers (`docs/API.md` section 19).
 *
 * The limits exist because a live viewer is the cheapest way to make the
 * control plane and a browser worker do expensive work: every attached viewer
 * costs a WebSocket, a fan-out write per frame and, for the first viewer on a
 * session, a Chromium screencast. `docs/SECURITY.md` section 4 lists a
 * resource attack by an authenticated actor as a threat, so the bounds apply
 * to an authorised viewer rather than only to an anonymous one.
 *
 * They are counters in memory rather than rows in PostgreSQL: a limit that
 * protects a process is correct when it is enforced by that process, and a
 * database round trip per inbound message would itself be the load.
 */

/** Concurrent viewers on one browser session. */
export const MAX_VIEWERS_PER_SESSION = 4;

/** Concurrent viewers held by one viewer session across all browser sessions. */
export const MAX_VIEWERS_PER_VIEWER_SESSION = 8;

/** Attach attempts per viewer session per window, so a reconnect loop is bounded. */
export const MAX_ATTACHES_PER_WINDOW = 30;
export const ATTACH_WINDOW_MS = 60000;

/** Inbound messages per viewer per window. */
export const MAX_CLIENT_MESSAGES_PER_WINDOW = 20;
export const CLIENT_MESSAGE_WINDOW_MS = 10000;

/**
 * Largest inbound message. It equals the protocol's own message bound, so a
 * viewer cannot make the server allocate more than the schema allows even
 * before the schema is consulted.
 */
export const MAX_CLIENT_MESSAGE_BYTES = 8192;

/** Shortest interval between two quality requests reaching the worker. */
export const QUALITY_REQUEST_INTERVAL_MS = 2000;

export interface LimitDecision {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
}

const ALLOWED: LimitDecision = { allowed: true, retryAfterMs: 0 };

/** Fixed-window counter keyed by an arbitrary string. */
export class WindowCounter {
  readonly #windowMs: number;
  readonly #maximum: number;
  readonly #counts = new Map<string, { count: number; resetAt: number }>();

  constructor(maximum: number, windowMs: number) {
    this.#maximum = maximum;
    this.#windowMs = windowMs;
  }

  take(key: string, now = Date.now()): LimitDecision {
    const entry = this.#counts.get(key);
    if (entry === undefined || entry.resetAt <= now) {
      this.#counts.set(key, { count: 1, resetAt: now + this.#windowMs });
      return ALLOWED;
    }
    if (entry.count >= this.#maximum) {
      return { allowed: false, retryAfterMs: Math.max(0, entry.resetAt - now) };
    }
    entry.count += 1;
    return ALLOWED;
  }

  /** Discards windows that have expired, so the map cannot grow unbounded. */
  sweep(now = Date.now()): void {
    for (const [key, entry] of this.#counts) {
      if (entry.resetAt <= now) this.#counts.delete(key);
    }
  }

  get size(): number {
    return this.#counts.size;
  }
}

/** Counts concurrent holders of something, with a maximum. */
export class ConcurrencyLimiter {
  readonly #maximum: number;
  readonly #counts = new Map<string, number>();

  constructor(maximum: number) {
    this.#maximum = maximum;
  }

  acquire(key: string): boolean {
    const current = this.#counts.get(key) ?? 0;
    if (current >= this.#maximum) return false;
    this.#counts.set(key, current + 1);
    return true;
  }

  release(key: string): void {
    const current = this.#counts.get(key) ?? 0;
    if (current <= 1) this.#counts.delete(key);
    else this.#counts.set(key, current - 1);
  }

  count(key: string): number {
    return this.#counts.get(key) ?? 0;
  }
}

/** Every live-viewer limit, in one place so a route cannot forget one. */
export class LiveViewerLimits {
  readonly perSession = new ConcurrencyLimiter(MAX_VIEWERS_PER_SESSION);
  readonly perViewerSession = new ConcurrencyLimiter(MAX_VIEWERS_PER_VIEWER_SESSION);
  readonly attaches = new WindowCounter(MAX_ATTACHES_PER_WINDOW, ATTACH_WINDOW_MS);
  readonly clientMessages = new WindowCounter(
    MAX_CLIENT_MESSAGES_PER_WINDOW,
    CLIENT_MESSAGE_WINDOW_MS,
  );

  sweep(now = Date.now()): void {
    this.attaches.sweep(now);
    this.clientMessages.sweep(now);
  }
}
