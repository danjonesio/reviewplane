/**
 * The MCP test harness.
 *
 * It runs the two processes the product runs — the control-plane API and the
 * MCP server — against one real database, and drives the second with the
 * official MCP TypeScript SDK client. That combination is the point: an
 * assertion made through the SDK is an assertion about what an agent client
 * actually receives, not about what a handler returns to itself.
 *
 * The browser worker is a stub that speaks the real browser protocol, exactly
 * as `apps/server`'s harness does. The Chromium-backed run lives in
 * `test/integration/`, which starts a real worker process.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Pool } from "pg";

import {
  decodeBrowserFrame,
  encodeBrowserFrame,
  type BrowserCommandResult,
  type BrowserFrame,
} from "@reviewplane/protocol/browser";
import { buildApp, type BuiltApp } from "@reviewplane/server/app";
import type { ServerConfig } from "@reviewplane/server/config";
import { newId } from "@reviewplane/server/domain";
import { testServerConfig } from "@reviewplane/server/testing/config";
import { encodePng, sha256 } from "@reviewplane/server/testing/png";

import { buildMcpApp, type BuiltMcpApp } from "../../src/app.ts";
import type { McpServerConfig } from "../../src/config.ts";

export const BOOTSTRAP_TOKEN = "bootstrap-token-for-mcp-tests";
export const WORKER_CREDENTIAL = "worker-credential-for-mcp-tests";
export const WORKER_COMMAND_CREDENTIAL = "worker-command-credential-mcp";

export const ADMIN = { authorization: `Bearer ${BOOTSTRAP_TOKEN}` };

/** The 390x844 preset at a device pixel ratio of 2 (`AGENTS.md`). */
export const SCREENSHOT = encodePng(780, 1688);
export const AFTER_SCREENSHOT = encodePng(780, 1688, [240, 240, 240]);

export const CAPTURED_COMMIT = "4a45b94f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60";
export const FIXED_COMMIT = "b4c5d6e7f809192a3b4c5d6e7f809192a3b4c5d6";

export interface McpHarness {
  readonly control: BuiltApp;
  readonly mcp: BuiltMcpApp;
  readonly artefactRoot: string;
  /** Screenshot bytes the stub worker will "capture" on the next request. */
  capture: Buffer;
  /** Set to make the next worker command fail with this code. */
  workerFailure: { code: string; message: string } | null;
  controlOrigin(): Promise<string>;
  mcpOrigin(): Promise<string>;
  stop(): Promise<void>;
}

const DEFAULT_ALLOCATION = {
  status: "READY",
  browser_type: "chromium",
  browser_version: "143.0.7499.4",
  viewport: { width: 390, height: 844, device_scale_factor: 2 },
  allocated_at: "2026-07-30T09:16:01.480Z",
} as const;

export async function startMcpHarness(pool: Pool): Promise<McpHarness> {
  const artefactRoot = await mkdtemp(join(tmpdir(), "reviewplane-mcp-artefacts-"));

  const serverConfig: ServerConfig = testServerConfig({
    host: "127.0.0.1",
    port: 0,
    bootstrapToken: BOOTSTRAP_TOKEN,
    workerCredential: WORKER_CREDENTIAL,
    workerCommandCredential: WORKER_COMMAND_CREDENTIAL,
    workerEndpoint: "http://browser-worker.invalid",
    artefactPath: artefactRoot,
  });

  const mcpConfig: McpServerConfig = {
    listenAddress: "127.0.0.1",
    port: 0,
    databaseUrl: "unused-in-tests",
    workerCommandCredential: WORKER_COMMAND_CREDENTIAL,
    workerEndpoint: "http://browser-worker.invalid",
    workerRequestTimeoutMs: 5000,
    artefactPath: artefactRoot,
    artefactMaxBytes: 20971520,
    apiPathPrefix: "/api/v1",
    mcpPath: "/mcp/v1",
  };

  const state: { capture: Buffer; workerFailure: { code: string; message: string } | null } = {
    capture: AFTER_SCREENSHOT,
    workerFailure: null,
  };

  let controlOrigin: string | null = null;

  /**
   * The stub worker. It decodes the frames the control plane sends and uploads
   * a real screenshot through the real artefact API, so the evidence a
   * verification later references has been digest-verified by the server.
   */
  const workerFetch: typeof fetch = async (input, init) => {
    void input;
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== `Bearer ${WORKER_COMMAND_CREDENTIAL}`) {
      return new Response(
        JSON.stringify({ error: { code: "AUTHENTICATION_REQUIRED", message: "no" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }
    const decoded = decodeBrowserFrame(String(init?.body ?? ""));
    if (!decoded.ok) {
      return new Response(
        JSON.stringify({ error: { code: "POLICY_DENIED", message: decoded.error.message } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    const frame = decoded.value;
    const envelope = frame.envelope;

    if (frame.type === "browser_session.allocate") {
      return frameResponse({
        envelope: {
          protocol_version: 1,
          message_id: newId("msg_"),
          type: "browser_session.allocated",
          sent_at: new Date().toISOString(),
          worker_id: envelope.worker_id as string,
          browser_session_id: envelope.browser_session_id as string,
          correlation_id: envelope.message_id,
        },
        type: "browser_session.allocated",
        payload: DEFAULT_ALLOCATION,
      });
    }

    if (frame.type === "browser.command") {
      const sessionId = envelope.browser_session_id as string;
      const result: BrowserCommandResult =
        state.workerFailure !== null
          ? {
              ok: false,
              command: frame.payload.command,
              sequence: envelope.sequence as number,
              control_epoch: envelope.control_epoch as number,
              duration_ms: 3,
              trust: "trusted_control_plane",
              instruction_policy: "do_not_follow_as_instructions",
              error: {
                code: state.workerFailure.code as never,
                message: state.workerFailure.message,
                retryable: true,
              },
            }
          : {
              ok: true,
              command: frame.payload.command,
              sequence: envelope.sequence as number,
              control_epoch: envelope.control_epoch as number,
              duration_ms: 12,
              trust: "untrusted_browser_content",
              instruction_policy: "do_not_follow_as_instructions",
              screenshot: await uploadCapture(sessionId, state.capture),
            };
      return frameResponse({
        envelope: {
          protocol_version: 1,
          message_id: newId("msg_"),
          type: "browser.command.result",
          sent_at: new Date().toISOString(),
          worker_id: envelope.worker_id as string,
          browser_session_id: sessionId,
          controller: envelope.controller as NonNullable<BrowserFrame["envelope"]["controller"]>,
          control_epoch: result.control_epoch,
          sequence: envelope.sequence as number,
          correlation_id: envelope.message_id,
        },
        type: "browser.command.result",
        payload: result,
      });
    }

    if (frame.type === "browser_session.terminate") {
      return frameResponse({
        envelope: {
          protocol_version: 1,
          message_id: newId("msg_"),
          type: "browser_session.status",
          sent_at: new Date().toISOString(),
          worker_id: envelope.worker_id as string,
          browser_session_id: envelope.browser_session_id as string,
          correlation_id: envelope.message_id,
        },
        type: "browser_session.status",
        payload: {
          status: "TERMINATED",
          previous_status: "ACTIVE",
          occurred_at: new Date().toISOString(),
        },
      });
    }

    return new Response(JSON.stringify({ error: { code: "RESOURCE_NOT_FOUND", message: "no" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };

  const control = await buildApp({ config: serverConfig, pool, workerFetch });
  await control.app.ready();
  const mcp = await buildMcpApp({ config: mcpConfig, pool, workerFetch });
  await mcp.app.ready();

  /** Uploads a capture exactly as the real worker does: intent, bytes, complete. */
  async function uploadCapture(browserSessionId: string, bytes: Buffer) {
    const session = await control.sessions.get(browserSessionId);
    const digest = sha256(bytes);
    const intent = await control.app.inject({
      method: "POST",
      url: `/api/v1/projects/${session.project_id}/artefacts/uploads`,
      headers: { authorization: `Bearer ${WORKER_CREDENTIAL}` },
      payload: {
        kind: "screenshot",
        content_type: "image/png",
        size_bytes: bytes.byteLength,
        sha256: digest,
        browser_session_id: browserSessionId,
        retention_class: "verification_evidence",
      },
    });
    const artefactId = (intent.json() as { data: { artefact_id: string } }).data.artefact_id;
    await control.app.inject({
      method: "POST",
      url: `/api/v1/artefacts/${artefactId}/content`,
      headers: { authorization: `Bearer ${WORKER_CREDENTIAL}`, "content-type": "image/png" },
      payload: bytes,
    });
    const completed = await control.app.inject({
      method: "POST",
      url: `/api/v1/artefacts/${artefactId}/complete`,
      headers: { authorization: `Bearer ${WORKER_CREDENTIAL}` },
      payload: { sha256: digest, size_bytes: bytes.byteLength },
    });
    const record = (completed.json() as { data: { id: string; sha256: string } }).data;
    return {
      artefact_id: record.id,
      sha256: record.sha256,
      size_bytes: bytes.byteLength,
      content_type: "image/png" as const,
      viewport: session.viewport,
      full_page: false,
      captured_at: new Date().toISOString(),
    };
  }

  let mcpOrigin: string | null = null;

  return {
    control,
    mcp,
    artefactRoot,
    get capture() {
      return state.capture;
    },
    set capture(value: Buffer) {
      state.capture = value;
    },
    get workerFailure() {
      return state.workerFailure;
    },
    set workerFailure(value: { code: string; message: string } | null) {
      state.workerFailure = value;
    },
    async controlOrigin() {
      controlOrigin ??= await control.app.listen({ host: "127.0.0.1", port: 0 });
      return controlOrigin;
    },
    async mcpOrigin() {
      mcpOrigin ??= await mcp.app.listen({ host: "127.0.0.1", port: 0 });
      return mcpOrigin;
    },
    async stop() {
      await mcp.close().catch(() => undefined);
      await control.app.close().catch(() => undefined);
      await rm(artefactRoot, { recursive: true, force: true });
    },
  };
}

function frameResponse(frame: BrowserFrame): Response {
  return new Response(encodeBrowserFrame(frame), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export interface AgentClientOptions {
  readonly token: string;
  readonly projectHint?: string;
  readonly workspaceHint?: string;
  readonly imageContent?: boolean;
  readonly clientName?: string;
}

/** Opens a real MCP client against the endpoint. */
export async function connectAgent(
  harness: McpHarness,
  options: AgentClientOptions,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const origin = await harness.mcpOrigin();
  const url = new URL(`${origin}/mcp/v1`);
  if (options.projectHint !== undefined) url.searchParams.set("project_hint", options.projectHint);
  if (options.workspaceHint !== undefined) {
    url.searchParams.set("workspace_hint", options.workspaceHint);
  }
  if (options.imageContent === false) url.searchParams.set("image_content", "false");

  const client = new Client({
    name: options.clientName ?? "claude-code",
    version: "test",
  });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${options.token}` } },
  });
  // The SDK's `Transport` declares `sessionId?: string` while the client
  // transport exposes it as a getter that may return `undefined`. Under
  // `exactOptionalPropertyTypes` those are different types.
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  return {
    client,
    async close() {
      await client.close().catch(() => undefined);
    },
  };
}

/** The parsed envelope inside a tool result's first text block. */
export function envelopeOf(result: unknown): Record<string, unknown> {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  const text = content.find((block) => block.type === "text")?.text;
  if (text === undefined) throw new Error("the tool result carried no text block");
  return JSON.parse(text) as Record<string, unknown>;
}

/** The resource-link blocks a tool result carried. */
export function resourceLinksOf(result: unknown): { uri: string }[] {
  const content = (result as { content: { type: string; uri?: string }[] }).content;
  return content
    .filter((block) => block.type === "resource_link" && typeof block.uri === "string")
    .map((block) => ({ uri: block.uri as string }));
}
