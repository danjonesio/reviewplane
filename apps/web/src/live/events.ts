/**
 * The project event-stream client (`docs/API.md` section 18.1, `docs/EVENTS.md`
 * section 10).
 *
 * ```text
 * /ws/v1/projects/:projectId/events
 * ```
 *
 * It is framework-free for the same reason the live-frame client is: the parts
 * that must be provable without a browser are the sequence bookkeeping, the
 * resume, and what happens when the server says the replay window has been
 * exceeded. Those are policy, not rendering.
 *
 * Three rules shape this file.
 *
 * **The last applied sequence is the resume point, and it is only ever raised
 * by an event this client actually handed to its consumer.** A sequence
 * acknowledged before the consumer saw the event would turn a dropped render
 * into a permanent gap: the next reconnect would ask to resume past it.
 *
 * **A refresh instruction is not an error.** `stream.refresh_required` means
 * the durable record has moved further than this socket can replay, so the
 * client abandons its position, tells the consumer to refetch state from the
 * HTTP timeline, and resumes live delivery from the sequence the server
 * reported. Silently continuing would leave a gap the reader could not see,
 * which is the failure `docs/EVENTS.md` section 10 exists to prevent.
 *
 * **The channel carries two kinds of message and one member tells them apart**
 * (`packages/protocol/src/platform-event.ts`): a control message's `type` is
 * one of the `stream.` discriminators, and anything else is an event envelope.
 * Event types are deliberately *not* checked against a closed enumeration here.
 * They come from several schema families — platform, review and browser — and
 * the protocol requires a client to tolerate a type it does not recognise. An
 * unknown type is therefore rendered by its name rather than discarded.
 */

import {
  decodeStreamMessage,
  encodeStreamMessage,
  type StreamRefreshRequiredReason,
} from "@reviewplane/protocol/platform";

/** What the page shows about the event stream. Every value is displayed as text. */
export type EventStreamStatus =
  | "connecting"
  | "subscribing"
  | "live"
  | "replaying"
  | "reconnecting"
  | "stopped"
  | "failed";

/**
 * Why the stream stopped, by its stable code.
 *
 * `docs/UX_FLOWS.md` section 18 forbids a generic message where a stable code
 * exists, so the code travels with the failure rather than being flattened into
 * prose here. The surface looks it up in its own refusal table.
 */
export interface EventStreamFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * One event as it arrives on the wire (`docs/EVENTS.md` section 2).
 *
 * `payload` is left opaque on purpose: the shape differs per type, and a
 * surface renders what it recognises rather than assuming a member is there.
 */
export interface StreamedEvent {
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  readonly occurred_at: string;
  readonly actor: { readonly type: string; readonly id?: string; readonly display?: string };
  readonly correlation: Readonly<Record<string, string>>;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface EventStreamEvents {
  onStatus(status: EventStreamStatus, failure: EventStreamFailure | null): void;
  onEvent(event: StreamedEvent): void;
  /**
   * The server could not replay from where this client asked. The consumer must
   * refetch state over HTTP; live delivery has already resumed from
   * `currentSequence`.
   */
  onRefreshRequired(reason: StreamRefreshRequiredReason, currentSequence: number): void;
  onSubscribed?(currentSequence: number, replaying: boolean): void;
}

/** The subset of `WebSocket` this client uses, so a test can supply its own. */
export interface EventSocketLike {
  close(code?: number, reason?: string): void;
  send(data: string): void;
  onopen: (() => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface EventStreamOptions {
  readonly url: string;
  readonly events: EventStreamEvents;
  /** Where to resume from. Zero means "everything the window still holds". */
  readonly lastSequence?: number;
  readonly openSocket?: (url: string) => EventSocketLike;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** Deterministic in tests; `Math.random` in the browser. */
  readonly jitter?: () => number;
}

/** Reconnect backoff, bounded so a dead control plane is not hammered. */
export const EVENTS_RECONNECT_BASE_MS = 500;
export const EVENTS_RECONNECT_MAX_MS = 15000;

/**
 * The close codes a policy refusal arrives as.
 *
 * The upgrade itself is refused with an HTTP status when authorisation fails
 * before the socket exists; once it exists, the server closes with 1008. Either
 * way retrying changes nothing, so the client stops rather than looping.
 */
const POLICY_CLOSE_CODES: readonly number[] = [1003, 1008];

function defaultSocket(url: string): EventSocketLike {
  return new WebSocket(url) as unknown as EventSocketLike;
}

/**
 * Structural admission of an event envelope.
 *
 * The type is not checked against an enumeration — see the file comment — but
 * the members this client and its consumers read are. An envelope missing one
 * of them cannot be ordered or displayed, so it is dropped rather than passed
 * on as a half-rendered row.
 */
export function readEventEnvelope(source: unknown): StreamedEvent | null {
  if (typeof source !== "object" || source === null || Array.isArray(source)) return null;
  const record = source as Record<string, unknown>;
  const id = record["id"];
  const sequence = record["sequence"];
  const type = record["type"];
  const occurredAt = record["occurred_at"];
  const actor = record["actor"];
  if (typeof id !== "string" || id === "") return null;
  if (typeof sequence !== "number" || !Number.isFinite(sequence) || sequence < 0) return null;
  if (typeof type !== "string" || type === "") return null;
  if (typeof occurredAt !== "string" || occurredAt === "") return null;
  if (typeof actor !== "object" || actor === null || Array.isArray(actor)) return null;
  const actorRecord = actor as Record<string, unknown>;
  if (typeof actorRecord["type"] !== "string") return null;
  const payload = record["payload"];
  const correlation = record["correlation"];
  return {
    id,
    sequence,
    type,
    occurred_at: occurredAt,
    actor: {
      type: actorRecord["type"],
      ...(typeof actorRecord["id"] === "string" ? { id: actorRecord["id"] } : {}),
      ...(typeof actorRecord["display"] === "string" ? { display: actorRecord["display"] } : {}),
    },
    correlation:
      typeof correlation === "object" && correlation !== null && !Array.isArray(correlation)
        ? (correlation as Record<string, string>)
        : {},
    payload:
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {},
  };
}

export class ProjectEventClient {
  readonly #options: EventStreamOptions;
  readonly #events: EventStreamEvents;
  readonly #setTimer: (callback: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  readonly #jitter: () => number;

  #socket: EventSocketLike | null = null;
  #status: EventStreamStatus = "connecting";
  #failure: EventStreamFailure | null = null;
  #attempt = 0;
  #closedByCaller = false;
  #reconnectHandle: unknown = null;
  /**
   * The highest sequence handed to the consumer. This is the resume point, and
   * nothing else may raise it.
   */
  #lastSequence = 0;

  constructor(options: EventStreamOptions) {
    this.#options = options;
    this.#events = options.events;
    this.#lastSequence = options.lastSequence ?? 0;
    this.#setTimer =
      options.setTimer ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
    this.#clearTimer =
      options.clearTimer ??
      ((handle) => {
        globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
      });
    this.#jitter = options.jitter ?? Math.random;
  }

  get status(): EventStreamStatus {
    return this.#status;
  }

  get failure(): EventStreamFailure | null {
    return this.#failure;
  }

  /** The sequence a reconnect would resume from. */
  get lastSequence(): number {
    return this.#lastSequence;
  }

  connect(): void {
    this.#closedByCaller = false;
    this.#open();
  }

  /** Closes deliberately. No reconnect follows. */
  close(): void {
    this.#closedByCaller = true;
    this.#clear(this.#reconnectHandle);
    this.#reconnectHandle = null;
    const socket = this.#socket;
    this.#socket = null;
    socket?.close(1000, "viewer closed");
    this.#setStatus("stopped", null);
  }

  #clear(handle: unknown): void {
    if (handle !== null && handle !== undefined) this.#clearTimer(handle);
  }

  #setStatus(status: EventStreamStatus, failure: EventStreamFailure | null): void {
    if (this.#status === status && this.#failure?.code === failure?.code) return;
    this.#status = status;
    this.#failure = failure;
    this.#events.onStatus(status, failure);
  }

  #open(): void {
    this.#clear(this.#reconnectHandle);
    this.#reconnectHandle = null;
    this.#setStatus(this.#attempt === 0 ? "connecting" : "reconnecting", this.#failure);

    const open = this.#options.openSocket ?? defaultSocket;
    let socket: EventSocketLike;
    try {
      socket = open(this.#options.url);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;

    socket.onopen = (): void => {
      this.#attempt = 0;
      this.#setStatus("subscribing", null);
      // The resume point travels with the subscription, so a control plane that
      // restarted picks up where this viewer left off rather than from now.
      socket.send(
        encodeStreamMessage({
          type: "stream.subscribe",
          last_sequence: this.#lastSequence,
        }),
      );
    };
    socket.onerror = (): void => {
      // `close` always follows; the reconnect is scheduled there so it cannot be
      // scheduled twice.
    };
    socket.onclose = (event): void => {
      this.#socket = null;
      if (this.#closedByCaller) return;
      if (this.#failure !== null && !this.#failure.retryable) {
        this.#setStatus("failed", this.#failure);
        return;
      }
      if (POLICY_CLOSE_CODES.includes(event.code)) {
        this.#setStatus("failed", {
          code: "RESOURCE_NOT_FOUND",
          message: "The control plane refused this event stream.",
          retryable: false,
        });
        return;
      }
      this.#scheduleReconnect();
    };
    socket.onmessage = (event): void => {
      if (typeof event.data === "string") this.#onText(event.data);
    };
  }

  #scheduleReconnect(): void {
    this.#attempt += 1;
    const exponential = Math.min(
      EVENTS_RECONNECT_MAX_MS,
      EVENTS_RECONNECT_BASE_MS * 2 ** (this.#attempt - 1),
    );
    const delay = Math.round(exponential * (0.5 + this.#jitter() * 0.5));
    this.#setStatus("reconnecting", this.#failure);
    this.#reconnectHandle = this.#setTimer(() => {
      this.#open();
    }, delay);
  }

  #onText(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    const type = (parsed as Record<string, unknown>)["type"];
    if (typeof type !== "string") return;

    if (!type.startsWith("stream.")) {
      const event = readEventEnvelope(parsed);
      if (event === null) return;
      // Out-of-order and duplicate delivery are both possible across a resume;
      // the sequence decides, not arrival.
      if (event.sequence <= this.#lastSequence) return;
      this.#lastSequence = event.sequence;
      this.#setStatus("live", null);
      this.#events.onEvent(event);
      return;
    }

    const decoded = decodeStreamMessage(text);
    if (!decoded.ok) return;
    const message = decoded.value;
    switch (message.type) {
      case "stream.subscribed":
        this.#setStatus(message.replaying ? "replaying" : "live", null);
        this.#events.onSubscribed?.(message.current_sequence, message.replaying);
        return;
      case "stream.refresh_required":
        // The window has moved past this client. Its position is abandoned and
        // live delivery resumes from the sequence the server reported, which is
        // exactly where the server itself resumed.
        this.#lastSequence = message.current_sequence;
        this.#setStatus("live", null);
        this.#events.onRefreshRequired(message.reason, message.current_sequence);
        return;
      case "stream.heartbeat":
        // A quiet stream is still a live one. Nothing to apply, but it proves
        // the socket is not a corpse.
        this.#setStatus("live", null);
        return;
      case "stream.error":
        this.#setStatus(message.retryable ? "reconnecting" : "failed", {
          code: message.code,
          message: message.message,
          retryable: message.retryable,
        });
        return;
      default:
        return;
    }
  }
}

/** Human-readable status text. Status is never conveyed by colour alone. */
export const EVENT_STREAM_STATUS_COPY: Readonly<Record<EventStreamStatus, string>> = {
  connecting: "Connecting to the project event stream",
  subscribing: "Subscribing",
  live: "Live",
  replaying: "Catching up on events missed while away",
  reconnecting: "Reconnecting",
  stopped: "Event stream stopped",
  failed: "Event stream failed",
};

/**
 * What a refresh instruction means, in the reader's terms.
 *
 * All three abandon the reader's position, and the difference is why, which is
 * what decides whether anything is wrong. Only `replay_window_exceeded` means
 * history was actually lost from the window.
 */
export const REFRESH_REASON_COPY: Readonly<Record<StreamRefreshRequiredReason, string>> = {
  replay_window_exceeded:
    "This view was away long enough that the events it missed have left the replay window. The history below has been read again from the record, so nothing is missing from it.",
  replay_limit_exceeded:
    "Too many events happened while this view was away to replay one at a time. The history below has been read again from the record, so nothing is missing from it.",
  sequence_ahead_of_stream:
    "This view held a position ahead of the project's own record, which happens when a deployment is restored from a backup. The history below has been read again from the record.",
};
