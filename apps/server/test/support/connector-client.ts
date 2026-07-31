/**
 * A connector double for component and security tests.
 *
 * It speaks the real protocol through `@reviewplane/protocol` and presents a
 * real client certificate, so the paths it exercises are the ones the Go
 * connector uses. Its purpose is the cases a real connector will not produce on
 * demand: a malformed frame, an oversized frame, a frame in the wrong
 * direction, a frame attributed to another identity, a missing certificate.
 */

import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { randomUUID } from "node:crypto";

import {
  decodeControlFrame,
  encodeControlFrame,
  SensitiveString,
  type ConnectorFrame,
  type Heartbeat,
  type ReconnectRequest,
  type ReconnectResponse,
  type RegistrationResponse,
  type WorkspaceObservation,
} from "@reviewplane/protocol";
import { WebSocket, type ClientOptions } from "ws";

import { ENROLMENT_PATH, CONTROL_PATH } from "../../src/modules/connectors/config.ts";
import type { Harness } from "./harness.ts";

export interface DeviceKey {
  readonly privateKeyPem: string;
  readonly publicKeyBase64: string;
}

export function generateDeviceKey(): DeviceKey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyBase64: Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64"),
  };
}

function rfc3339(at: Date = new Date()): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

function messageId(): string {
  return `msg_${randomUUID().replaceAll("-", "")}`;
}

export interface EnrolmentAttempt {
  readonly response: RegistrationResponse | null;
  readonly closeCode: number;
  readonly closeReason: string;
}

export interface EnrolmentOptions {
  readonly environmentName?: string;
  readonly labels?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly version?: string;
  /** Raw bytes to send instead of a well-formed registration request. */
  readonly rawFrame?: string | Buffer;
}

/** Runs one registration exchange over the enrolment WebSocket endpoint. */
export function enrolOverWebSocket(
  harness: Harness,
  token: string,
  device: DeviceKey,
  options: EnrolmentOptions = {},
): Promise<EnrolmentAttempt> {
  const url = `${harness.connectorUrl}${ENROLMENT_PATH}`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      ca: harness.built.connectors.authority.certificatePem,
      servername: "localhost",
      rejectUnauthorized: true,
    } as ClientOptions);
    let response: RegistrationResponse | null = null;

    socket.on("open", () => {
      if (options.rawFrame !== undefined) {
        socket.send(options.rawFrame);
        return;
      }
      const frame: ConnectorFrame = {
        envelope: {
          protocol_version: 1,
          message_id: messageId(),
          type: "connector.registration.request",
          sent_at: rfc3339(),
        },
        type: "connector.registration.request",
        payload: {
          enrolment_token: new SensitiveString(token),
          public_key: device.publicKeyBase64,
          environment: {
            name: options.environmentName ?? "dev-ai-03",
            platform: "linux",
            architecture: "amd64",
            ...(options.labels === undefined ? {} : { labels: [...options.labels] }),
          },
          connector: {
            version: options.version ?? "0.1.0",
            capabilities: [...(options.capabilities ?? ["http-tunnel", "websocket-tunnel"])],
          },
        },
      };
      socket.send(encodeControlFrame(frame));
    });

    socket.on("message", (data: Buffer) => {
      const parsed = JSON.parse(data.toString("utf8")) as { type: string; payload: RegistrationResponse };
      if (parsed.type === "connector.registration.response") response = parsed.payload;
    });

    socket.on("close", (code: number, reason: Buffer) => {
      resolve({ response, closeCode: code, closeReason: reason.toString("utf8") });
    });
    socket.on("error", (error: Error) => {
      // A refused upgrade closes without a WebSocket close frame; the close
      // handler still fires, so only a hard failure reaches here.
      if (response === null) reject(error);
    });
  });
}

export interface ConnectorIdentity {
  readonly connectorId: string;
  readonly certificatePem: string;
  readonly certificateFingerprint: string;
  readonly privateKeyPem: string;
  readonly controlUrl: string;
}

export function identityFrom(response: RegistrationResponse, device: DeviceKey): ConnectorIdentity {
  const der = Buffer.from(response.signed_identity.certificate, "base64");
  const certificate = new X509Certificate(der);
  return {
    connectorId: response.connector_id,
    certificatePem: certificate.toString(),
    certificateFingerprint: response.signed_identity.certificate_fingerprint,
    privateKeyPem: device.privateKeyPem,
    controlUrl: response.control_plane_endpoints.control_url,
  };
}

export interface ControlChannel {
  readonly socket: WebSocket;
  send(payload: string | Buffer): void;
  sendHeartbeat(overrides?: Partial<Heartbeat>): void;
  /**
   * Sends the `docs/CONNECTOR_PROTOCOL.md` §17 reconnect payload and resolves
   * with the desired state that answers it.
   *
   * A double is what makes the hostile cases testable: a real connector will not
   * claim another connector's route on demand, and that is exactly the claim
   * reconciliation has to refuse.
   */
  reconnect(overrides?: Partial<ReconnectRequest>, timeoutMs?: number): Promise<ReconnectResponse>;
  /**
   * Sends the `docs/CONNECTOR_PROTOCOL.md` §9 workspace observation.
   *
   * A double again, and for the same reason: the observations that must be
   * refused — a project this identity is not enrolled for, an identifier held
   * elsewhere — are ones a correct connector never sends.
   */
  sendWorkspaceObservation(overrides?: Partial<WorkspaceObservation>): void;
  closed(): Promise<{ code: number; reason: string }>;
  close(): void;
}

export interface ControlChannelOptions {
  /** Present no client certificate at all. */
  readonly withoutCertificate?: boolean;
  /** Present this certificate and key instead of the identity's own. */
  readonly certificatePem?: string;
  readonly privateKeyPem?: string;
}

/** Opens the mutually authenticated control channel. */
export function openControlChannel(
  harness: Harness,
  identity: ConnectorIdentity,
  options: ControlChannelOptions = {},
): Promise<ControlChannel> {
  const url = `${harness.connectorUrl}${CONTROL_PATH}`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      ca: harness.built.connectors.authority.certificatePem,
      servername: "localhost",
      rejectUnauthorized: true,
      ...(options.withoutCertificate === true
        ? {}
        : {
            cert: options.certificatePem ?? identity.certificatePem,
            key: options.privateKeyPem ?? identity.privateKeyPem,
          }),
    } as ClientOptions);

    let closeResolve: ((value: { code: number; reason: string }) => void) | null = null;
    const closedPromise = new Promise<{ code: number; reason: string }>((resolveClose) => {
      closeResolve = resolveClose;
    });
    let settled = false;

    socket.on("close", (code: number, reason: Buffer) => {
      closeResolve?.({ code, reason: reason.toString("utf8") });
      if (!settled) {
        settled = true;
        resolve(channel);
      }
    });
    // The control plane refuses a wrong identity before the upgrade, so the
    // refusal arrives as an HTTP response rather than a close frame. Both are
    // reported the same way: the code is the status and the reason is the
    // stable error class.
    socket.on("unexpected-response", (_request, response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => {
        closeResolve?.({ code: response.statusCode ?? 0, reason: body.trim() });
        if (!settled) {
          settled = true;
          resolve(channel);
        }
      });
    });
    socket.on("error", (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    const channel: ControlChannel = {
      socket,
      send(payload) {
        socket.send(payload);
      },
      sendHeartbeat(overrides = {}) {
        const payload: Heartbeat = {
          status: "healthy",
          uptime_seconds: 1,
          version: "0.1.0",
          active_routes: 0,
          active_streams: 0,
          ...overrides,
        };
        const frame: ConnectorFrame = {
          envelope: {
            protocol_version: 1,
            message_id: messageId(),
            type: "heartbeat",
            sent_at: rfc3339(),
            connector_id: identity.connectorId,
          },
          type: "heartbeat",
          payload,
        };
        socket.send(encodeControlFrame(frame));
      },
      sendWorkspaceObservation(overrides = {}) {
        const payload: WorkspaceObservation = {
          workspace_id: "wsp_test_workspace",
          project_id: "prj_test_project",
          path_hash: `sha256:${"a".repeat(64)}`,
          display_label: "refresh-surplus",
          branch: "main",
          head_commit: "4f3a9c1d2e8b7a6053f4e3d2c1b0a9f8e7d6c5b4",
          dirty: false,
          observed_at: rfc3339(),
          ...overrides,
        };
        const frame: ConnectorFrame = {
          envelope: {
            protocol_version: 1,
            message_id: messageId(),
            type: "workspace.observed",
            sent_at: rfc3339(),
            connector_id: identity.connectorId,
          },
          type: "workspace.observed",
          payload,
        };
        socket.send(encodeControlFrame(frame));
      },
      reconnect(overrides = {}, timeoutMs = 15_000) {
        const payload: ReconnectRequest = {
          connector_version: "0.1.0",
          capabilities: ["http-tunnel"],
          active_routes: [],
          active_streams: [],
          known_agent_sessions: [],
          workspace_head_state: [],
          ...overrides,
        };
        const id = messageId();
        const frame: ConnectorFrame = {
          envelope: {
            protocol_version: 1,
            message_id: id,
            type: "connector.reconnect.request",
            sent_at: rfc3339(),
            connector_id: identity.connectorId,
          },
          type: "connector.reconnect.request",
          payload,
        };
        return new Promise<ReconnectResponse>((resolveDesired, rejectDesired) => {
          const timer = setTimeout(() => {
            socket.off("message", onMessage);
            rejectDesired(new Error("the control plane sent no desired state"));
          }, timeoutMs);
          function onMessage(data: Buffer): void {
            const decoded = decodeControlFrame(Buffer.isBuffer(data) ? data : Buffer.from(data));
            if (!decoded.ok) return;
            if (decoded.value.type !== "connector.reconnect.response") return;
            if (decoded.value.envelope.correlation_id !== id) return;
            clearTimeout(timer);
            socket.off("message", onMessage);
            resolveDesired(decoded.value.payload);
          }
          socket.on("message", onMessage);
          socket.send(encodeControlFrame(frame));
        });
      },
      closed: () => closedPromise,
      close() {
        socket.close();
      },
    };

    socket.on("open", () => {
      if (!settled) {
        settled = true;
        resolve(channel);
      }
    });
  });
}

/** Waits until `check` returns a value, or fails after `timeoutMs`. */
export async function waitFor<T>(
  check: () => Promise<T | null> | T | null,
  description: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== null && value !== undefined && value !== false) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${description}${last === null ? "" : `: ${String(last)}`}`);
}
