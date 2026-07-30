/**
 * The live-view client: everything about the stream that is not React.
 *
 * It is framework-free on purpose. The reconnect policy, the pairing of frame
 * metadata with the binary message that follows it, and the mapping from a
 * protocol refusal to one of the `docs/UX_FLOWS.md` section 18 states are the
 * parts that must be tested without a browser, and they are the parts the
 * annotation overlay of a later issue will build on: an overlay needs the
 * frame's declared dimensions and sequence, not a React ref.
 *
 * Frames are handed to the consumer as bytes and are never stored. The client
 * keeps at most one frame — the one being decoded — which is the browser-side
 * half of the same drop-rather-than-queue rule the worker and the control
 * plane apply (`docs/ARCHITECTURE.md` section 6.3).
 */

import {
  decodeLiveViewFrame,
  encodeLiveViewFrame,
  type FailureState,
  type FrameMetadata,
  type LiveMode,
  type QualityState,
  type SessionState,
  type StreamHeartbeat,
} from "@reviewplane/protocol/live-view";

/** What the page shows about the stream. Every value is displayed as text. */
export type LiveStatus =
  | "connecting"
  | "live"
  | "waiting_for_frames"
  | "reconnecting"
  | "stalled"
  | "stopped"
  | "failed";

export interface LiveFailure {
  readonly state: FailureState;
  readonly message: string;
  readonly retryable: boolean;
}

export interface LiveClientEvents {
  onStatus(status: LiveStatus, failure: LiveFailure | null): void;
  onFrame(payload: Uint8Array, metadata: FrameMetadata): void;
  onSessionState(state: SessionState): void;
  onQuality(quality: QualityState): void;
  onHeartbeat(heartbeat: StreamHeartbeat): void;
}

/** The subset of `WebSocket` this client uses, so a test can supply its own. */
export interface SocketLike {
  binaryType: string;
  close(code?: number, reason?: string): void;
  send(data: string): void;
  onopen: (() => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface LiveClientOptions {
  readonly url: string;
  readonly events: LiveClientEvents;
  readonly mode?: LiveMode;
  readonly openSocket?: (url: string) => SocketLike;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** Deterministic in tests; `Math.random` in the browser. */
  readonly jitter?: () => number;
}

/** Reconnect backoff, bounded so a dead control plane is not hammered. */
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 15000;

/** No frame for this long while connected means the stream has stalled. */
export const STALL_AFTER_MS = 6000;

/** How often the viewer reports the sequence it last painted. */
export const VIEWER_HEARTBEAT_MS = 5000;

function defaultSocket(url: string): SocketLike {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  return socket as unknown as SocketLike;
}

export class LiveClient {
  readonly #options: LiveClientOptions;
  readonly #events: LiveClientEvents;
  readonly #now: () => number;
  readonly #setTimer: (callback: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  readonly #jitter: () => number;

  #socket: SocketLike | null = null;
  #status: LiveStatus = "connecting";
  #failure: LiveFailure | null = null;
  #pendingMetadata: FrameMetadata | null = null;
  #attempt = 0;
  #closedByCaller = false;
  #reconnectHandle: unknown = null;
  #stallHandle: unknown = null;
  #heartbeatHandle: unknown = null;
  #lastRenderedSequence = 0;
  #browserSessionId: string | null = null;

  constructor(options: LiveClientOptions) {
    this.#options = options;
    this.#events = options.events;
    this.#now = options.now ?? (() => Date.now());
    this.#setTimer =
      options.setTimer ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
    this.#clearTimer = options.clearTimer ?? ((handle) => {
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
    this.#jitter = options.jitter ?? Math.random;
  }

  get status(): LiveStatus {
    return this.#status;
  }

  get failure(): LiveFailure | null {
    return this.#failure;
  }

  /** Records the sequence the page actually painted, for the heartbeat. */
  markRendered(sequence: number): void {
    if (sequence > this.#lastRenderedSequence) this.#lastRenderedSequence = sequence;
  }

  connect(): void {
    this.#closedByCaller = false;
    this.#open();
  }

  /** Closes deliberately. No reconnect follows. */
  close(): void {
    this.#closedByCaller = true;
    this.#clear(this.#reconnectHandle);
    this.#clear(this.#stallHandle);
    this.#clear(this.#heartbeatHandle);
    this.#reconnectHandle = null;
    this.#stallHandle = null;
    this.#heartbeatHandle = null;
    const socket = this.#socket;
    this.#socket = null;
    socket?.close(1000, "viewer closed");
    this.#setStatus("stopped", null);
  }

  /** Sends an advisory quality request. The worker decides what happens. */
  requestQuality(request: {
    readonly mode?: LiveMode;
    readonly maxFps?: number;
    readonly maxWidth?: number;
    readonly maxHeight?: number;
  }): void {
    const socket = this.#socket;
    if (socket === null || this.#browserSessionId === null) return;
    socket.send(
      encodeLiveViewFrame({
        envelope: {
          protocol_version: 1,
          message_id: `msg_${String(this.#now())}`,
          type: "live.quality_request",
          sent_at: new Date(this.#now()).toISOString(),
          browser_session_id: this.#browserSessionId,
        },
        type: "live.quality_request",
        payload: {
          ...(request.mode === undefined ? {} : { mode: request.mode }),
          ...(request.maxFps === undefined ? {} : { max_fps: request.maxFps }),
          ...(request.maxWidth === undefined ? {} : { max_width: request.maxWidth }),
          ...(request.maxHeight === undefined ? {} : { max_height: request.maxHeight }),
          requested_at: new Date(this.#now()).toISOString(),
        },
      }),
    );
  }

  #clear(handle: unknown): void {
    if (handle !== null && handle !== undefined) this.#clearTimer(handle);
  }

  #setStatus(status: LiveStatus, failure: LiveFailure | null): void {
    if (this.#status === status && this.#failure?.state === failure?.state) return;
    this.#status = status;
    this.#failure = failure;
    this.#events.onStatus(status, failure);
  }

  #open(): void {
    this.#clear(this.#reconnectHandle);
    this.#reconnectHandle = null;
    this.#setStatus(this.#attempt === 0 ? "connecting" : "reconnecting", this.#failure);

    const open = this.#options.openSocket ?? defaultSocket;
    let socket: SocketLike;
    try {
      socket = open(this.#options.url);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    socket.binaryType = "arraybuffer";
    this.#socket = socket;

    socket.onopen = (): void => {
      this.#attempt = 0;
      this.#setStatus("waiting_for_frames", null);
      this.#armStall();
      this.#armHeartbeat();
    };
    socket.onerror = (): void => {
      // `close` always follows; the reconnect is scheduled there so it cannot
      // be scheduled twice.
    };
    socket.onclose = (event): void => {
      this.#socket = null;
      this.#clear(this.#stallHandle);
      this.#clear(this.#heartbeatHandle);
      this.#stallHandle = null;
      this.#heartbeatHandle = null;
      if (this.#closedByCaller) return;
      if (this.#failure !== null && !this.#failure.retryable) {
        this.#setStatus("failed", this.#failure);
        return;
      }
      if (event.code === 1008 || event.code === 1003) {
        this.#setStatus("failed", {
          state: "not_authorised_for_project",
          message: "The control plane refused this live stream.",
          retryable: false,
        });
        return;
      }
      this.#scheduleReconnect();
    };
    socket.onmessage = (event): void => {
      this.#onMessage(event.data);
    };
  }

  /**
   * Jittered exponential backoff. The jitter matters because every viewer of
   * a control plane that restarts would otherwise reconnect in the same
   * millisecond.
   */
  #scheduleReconnect(): void {
    this.#attempt += 1;
    const exponential = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (this.#attempt - 1));
    const delay = Math.round(exponential * (0.5 + this.#jitter() * 0.5));
    this.#setStatus("reconnecting", this.#failure);
    this.#reconnectHandle = this.#setTimer(() => {
      this.#open();
    }, delay);
  }

  #armStall(): void {
    this.#clear(this.#stallHandle);
    this.#stallHandle = this.#setTimer(() => {
      // Connected but not painting. `docs/UX_FLOWS.md` section 18 wants this
      // said out loud rather than left as a frozen picture.
      if (this.#status === "live" || this.#status === "waiting_for_frames") {
        this.#setStatus("stalled", {
          state: "live_capture_unavailable",
          message:
            "No frames have arrived recently. The browser session may be idle, or capture may have stopped.",
          retryable: true,
        });
      }
    }, STALL_AFTER_MS);
  }

  #armHeartbeat(): void {
    this.#clear(this.#heartbeatHandle);
    const beat = (): void => {
      const socket = this.#socket;
      if (socket === null || this.#browserSessionId === null) return;
      socket.send(
        encodeLiveViewFrame({
          envelope: {
            protocol_version: 1,
            message_id: `msg_${String(this.#now())}`,
            type: "live.viewer_heartbeat",
            sent_at: new Date(this.#now()).toISOString(),
            browser_session_id: this.#browserSessionId,
          },
          type: "live.viewer_heartbeat",
          payload: {
            observed_at: new Date(this.#now()).toISOString(),
            last_sequence_rendered: this.#lastRenderedSequence,
          },
        }),
      );
      this.#heartbeatHandle = this.#setTimer(beat, VIEWER_HEARTBEAT_MS);
    };
    this.#heartbeatHandle = this.#setTimer(beat, VIEWER_HEARTBEAT_MS);
  }

  #onMessage(data: unknown): void {
    if (typeof data === "string") {
      this.#onText(data);
      return;
    }
    const bytes = toBytes(data);
    if (bytes === null) return;
    const metadata = this.#pendingMetadata;
    this.#pendingMetadata = null;
    if (metadata === null) {
      // A payload with no metadata cannot be described, so it is not painted.
      return;
    }
    if (metadata.byte_length !== bytes.byteLength) return;
    this.#setStatus("live", null);
    this.#armStall();
    this.#events.onFrame(bytes, metadata);
  }

  #onText(text: string): void {
    const decoded = decodeLiveViewFrame(text);
    if (!decoded.ok) return;
    const frame = decoded.value;
    if (frame.envelope.browser_session_id !== undefined) {
      this.#browserSessionId = frame.envelope.browser_session_id;
    }
    switch (frame.type) {
      case "live.frame":
        this.#pendingMetadata = frame.payload;
        return;
      case "live.session_state":
        this.#events.onSessionState(frame.payload);
        return;
      case "live.quality":
        this.#events.onQuality(frame.payload);
        return;
      case "live.heartbeat":
        this.#events.onHeartbeat(frame.payload);
        return;
      case "live.attached":
        this.#setStatus("waiting_for_frames", null);
        return;
      case "live.error":
        this.#setStatus(frame.payload.retryable ? "reconnecting" : "failed", {
          state: frame.payload.state,
          message: frame.payload.message,
          retryable: frame.payload.retryable,
        });
        return;
      default:
        return;
    }
  }
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

/**
 * The failure states, rendered for a human.
 *
 * `docs/UX_FLOWS.md` section 18 forbids a generic message where a stable code
 * exists, and requires the cause to be actionable. Each entry therefore names
 * what happened and what the reader can do about it.
 */
export const FAILURE_COPY: Readonly<
  Record<FailureState, { readonly title: string; readonly action: string }>
> = {
  not_authenticated: {
    title: "Your session has expired",
    action: "Sign in again with the bootstrap administrator token to resume watching.",
  },
  not_authorised_for_project: {
    title: "This project is not yours to view",
    action:
      "The signed-in viewer session is scoped to other projects. Sign in with a session that covers this project.",
  },
  browser_session_not_found: {
    title: "That browser session no longer exists",
    action: "Return to the session list and open one that is still running.",
  },
  browser_session_ended: {
    title: "The browser session has ended",
    action: "Evidence already captured is unaffected. Start a new session to continue.",
  },
  browser_worker_failed: {
    title: "The browser worker stopped responding",
    action:
      "The session is marked failed and its control lease is revoked. Uploaded evidence is preserved; start a fresh session.",
  },
  live_capture_unavailable: {
    title: "Live frames are unavailable",
    action:
      "The session is still usable: navigation and screenshot capture work without the live stream.",
  },
  viewer_rate_limited: {
    title: "Too many live viewers",
    action: "Close another live view of this session, or wait a moment and try again.",
  },
  control_plane_unavailable: {
    title: "The control plane is unreachable",
    action: "Reconnecting automatically. Session state refreshes as soon as it answers.",
  },
};

/** Human-readable status text. Status is never conveyed by colour alone. */
export const STATUS_COPY: Readonly<Record<LiveStatus, string>> = {
  connecting: "Connecting to the live stream",
  live: "Live",
  waiting_for_frames: "Connected, waiting for the first frame",
  reconnecting: "Reconnecting",
  stalled: "Stream stalled",
  stopped: "Live view stopped",
  failed: "Live view failed",
};
