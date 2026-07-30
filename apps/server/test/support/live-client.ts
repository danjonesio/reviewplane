/**
 * A live-view client for the tests.
 *
 * It is a real WebSocket against a listening server rather than an injected
 * request, because the properties under test are properties of the handshake:
 * a refusal before the upgrade, a cookie the browser would send, and the
 * ordering of a text message and the binary message that follows it.
 */

import { once } from "node:events";

import WebSocket from "ws";

import { decodeLiveViewFrame, type LiveViewFrame } from "@reviewplane/protocol/live-view";

export interface ReceivedFrame {
  readonly metadata: Extract<LiveViewFrame, { type: "live.frame" }>["payload"];
  readonly payload: Buffer;
}

export interface LiveClient {
  readonly socket: WebSocket;
  readonly messages: LiveViewFrame[];
  readonly frames: ReceivedFrame[];
  /** Binary messages that arrived with no preceding metadata. */
  readonly orphanPayloads: number;
  waitFor(predicate: (client: LiveClient) => boolean, timeoutMs?: number): Promise<void>;
  send(json: string): void;
  close(): Promise<void>;
}

export interface ConnectOptions {
  readonly origin?: string;
  readonly cookie?: string;
  readonly mode?: string;
}

export class UpgradeRefused extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`the live upgrade was refused with status ${String(status)}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * Opens a live stream. Rejects with `UpgradeRefused` when the server answers
 * the handshake with an HTTP status, which is the refusal path every negative
 * authorisation test asserts on.
 */
export async function connectLive(
  origin: string,
  browserSessionId: string,
  options: ConnectOptions = {},
): Promise<LiveClient> {
  const base = origin.replace(/^http/u, "ws");
  const query = options.mode === undefined ? "" : `?mode=${options.mode}`;
  const socket = new WebSocket(
    `${base}/ws/v1/browser-sessions/${browserSessionId}/live${query}`,
    {
      headers: {
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      },
    },
  );

  const messages: LiveViewFrame[] = [];
  const frames: ReceivedFrame[] = [];
  const state = { orphans: 0 };
  let pending: Extract<LiveViewFrame, { type: "live.frame" }> | null = null;

  const client: LiveClient = {
    socket,
    messages,
    frames,
    get orphanPayloads(): number {
      return state.orphans;
    },
    async waitFor(predicate, timeoutMs = 5000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(client)) {
        if (Date.now() > deadline) {
          throw new Error(
            `condition not met within ${String(timeoutMs)} ms; saw ${String(messages.length)} messages and ${String(frames.length)} frames`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    send(json: string): void {
      socket.send(json);
    },
    async close(): Promise<void> {
      if (socket.readyState === WebSocket.CLOSED) return;
      socket.close();
      await once(socket, "close").catch(() => undefined);
    },
  };

  socket.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      const metadata = pending;
      pending = null;
      if (metadata === null) {
        state.orphans += 1;
        return;
      }
      frames.push({ metadata: metadata.payload, payload: data });
      return;
    }
    const decoded = decodeLiveViewFrame(data.toString("utf8"));
    if (!decoded.ok) throw new Error(`server sent a message the protocol refuses: ${data.toString("utf8")}`);
    messages.push(decoded.value);
    if (decoded.value.type === "live.frame") pending = decoded.value;
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("unexpected-response", (_request, response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        reject(new UpgradeRefused(response.statusCode ?? 0, Buffer.concat(chunks).toString("utf8")));
      });
    });
    socket.once("error", (error) => {
      reject(error);
    });
  });

  return client;
}
