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
  type BrowserCommand,
  type BrowserCommandResult,
  type BrowserFrame,
  type ControllerIdentity,
  type SnapshotResult,
  type Viewport,
} from "@reviewplane/protocol/browser";
import { buildApp, type BuiltApp } from "@reviewplane/server/app";
import type { ServerConfig } from "@reviewplane/server/config";
import { newId } from "@reviewplane/server/domain";
import { testServerConfig } from "@reviewplane/server/testing/config";
import { AcceptingGateway, StubRoutePublisher } from "@reviewplane/server/testing/publishing";
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

/**
 * The origin the stub worker pretends its session was allocated against.
 *
 * A root-relative navigation resolves against it exactly as the real worker
 * resolves against the session's published-service origin, so a test can assert
 * on the settled URL without publishing a route.
 */
export const STUB_SERVICE_ORIGIN = "https://route-id.internal.invalid";

/**
 * The rendered snapshot the stub worker returns.
 *
 * It is the example of `docs/MCP_SPEC.md` §7.4 verbatim, including a page-authored
 * accessible name, because the point of the snapshot assertions is that this text
 * reaches an agent labelled untrusted.
 */
export const STUB_SNAPSHOT_TEXT = [
  "- banner",
  '  - link "Refresh Surplus" [ref=e2]',
  '  - navigation "Main" [ref=e4]',
  "- main",
  '  - heading "Give technology another life" [ref=e9]',
  '  - link "Browse products" [ref=e12]',
].join("\n");

/** One command the stub worker was asked to run, and who it arrived from. */
export interface IssuedCommand {
  readonly command: BrowserCommand;
  readonly controller: ControllerIdentity;
}

export interface McpHarness {
  readonly control: BuiltApp;
  /** The recording gateway double, for assertions about which calls were made. */
  readonly gateway: AcceptingGateway;
  /** The database both processes share, for fixtures that write rows directly. */
  readonly pool: Pool;
  readonly mcp: BuiltMcpApp;
  readonly artefactRoot: string;
  /** Screenshot bytes the stub worker will "capture" on the next request. */
  capture: Buffer;
  /** Set to make the next worker command fail with this code. */
  workerFailure: { code: string; message: string } | null;
  /**
   * Text the stub worker returns for the next snapshot. A test that wants a
   * hostile page — one whose element names read as instructions — sets it here.
   */
  snapshotText: string;
  /**
   * Every command the stub worker was asked to run, in order, with the
   * controller the control plane issued it as. The controller is recorded
   * because it is a security property rather than plumbing: a capture must
   * arrive as `system` and an interactive command as `agent`.
   */
  readonly commands: readonly IssuedCommand[];
  /**
   * Everything the **control plane** has logged, as one string.
   *
   * For "no secret reaches a log line" assertions (`docs/SECURITY.md` section
   * 18). It is the control plane's log rather than both processes': the MCP
   * app's Fastify logger is off in this harness, and it is the control plane
   * that resolves credentials, serves artefact bytes and writes events.
   */
  logText(): string;
  /**
   * Whether the harness runs `api`'s allocation completion sweep (ADR-0037).
   *
   * True by default, because without it this harness is not the product: an
   * agent calling `browser_session_allocate` with a route writes the request and
   * waits for the process holding the signing key to finish it. A test that
   * wants to *observe* the intermediate state — a reservation requested and not
   * yet completed — sets it false and drives
   * `control.sessions.completePendingAllocations()` itself.
   */
  completeAllocations: boolean;
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
    // Not silent, because the log is collected rather than printed and a suite
    // asserting that no credential reaches a log line needs there to be log
    // lines to search (`docs/SECURITY.md` section 18). Nothing reaches a
    // terminal: `logDestination` below is an array.
    logLevel: "info",
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
    // The tunnel gateway is unreachable in this harness on purpose: nothing
    // here revokes a route, and a reachable control listener would make a
    // test depend on a service it never started.
    tunnelControlUrl: "http://127.0.0.1:1",
    tunnelControlToken: "test-tunnel-control-token-0001",
    internalSuffix: "internal.invalid",
    routeTtlMaxSeconds: 28_800,
    publishWaitMs: 5_000,
    allocateWaitMs: 5_000,
    apiPathPrefix: "/api/v1",
    mcpPath: "/mcp/v1",
  };

  const state: {
    capture: Buffer;
    workerFailure: { code: string; message: string } | null;
    snapshotText: string;
    snapshots: number;
    viewport: Viewport;
    commands: IssuedCommand[];
    completeAllocations: boolean;
  } = {
    capture: AFTER_SCREENSHOT,
    workerFailure: null,
    snapshotText: STUB_SNAPSHOT_TEXT,
    snapshots: 0,
    viewport: { ...DEFAULT_ALLOCATION.viewport },
    commands: [],
    completeAllocations: true,
  };

  /**
   * A fresh snapshot, with a fresh identity.
   *
   * The identity changes on every capture because that is the rule the product
   * relies on: an element reference is valid for the snapshot that issued it,
   * and a resize supersedes it. A stub that reused one identifier would let a
   * test pass that should have caught a reference surviving a resize.
   */
  const nextSnapshot = (): SnapshotResult => {
    state.snapshots += 1;
    return {
      snapshot_id: `snp_stub${String(state.snapshots).padStart(4, "0")}`,
      viewport: { ...state.viewport },
      scroll_position: { x: 0, y: 0 },
      node_count: 6,
      truncated: false,
      text: state.snapshotText,
      elements: [
        { ref: "e2", role: "link", name: "Refresh Surplus" },
        { ref: "e4", role: "navigation", name: "Main" },
        { ref: "e9", role: "heading", name: "Give technology another life" },
        { ref: "e12", role: "link", name: "Browse products" },
      ],
    };
  };

  /** The URL a navigation settles on: root-relative resolves against the origin. */
  const settle = (target: string): string =>
    target.startsWith("/") ? `${STUB_SERVICE_ORIGIN}${target}` : target;

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
      // The viewport is echoed rather than fixed, because a real Chromium
      // context opens at the size it was allocated with. A stub that always
      // answered one size would make every viewport assertion in the suite an
      // assertion about the stub.
      state.viewport = { ...frame.payload.viewport };
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
        payload: { ...DEFAULT_ALLOCATION, viewport: { ...state.viewport } },
      });
    }

    if (frame.type === "browser.command") {
      const sessionId = envelope.browser_session_id as string;
      const command = frame.payload;
      state.commands.push({
        command,
        controller: envelope.controller as ControllerIdentity,
      });
      const base = {
        command: command.command,
        sequence: envelope.sequence as number,
        control_epoch: envelope.control_epoch as number,
        instruction_policy: "do_not_follow_as_instructions",
      } as const;
      const result: BrowserCommandResult =
        state.workerFailure !== null
          ? {
              ...base,
              ok: false,
              duration_ms: 3,
              trust: "trusted_control_plane",
              error: {
                code: state.workerFailure.code as never,
                message: state.workerFailure.message,
                retryable: true,
              },
            }
          : await succeed(sessionId, command, base);
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

  // The connector and gateway doubles the server suite already uses. Without
  // them a route requested here reaches `failed`, because the real publisher
  // wants a connector control channel no test starts — which would make every
  // allocation test an assertion about a missing connector rather than about
  // the allocation. The doubles answer with the destination the control plane
  // authorised; the agent-facing rules are unchanged, and `request()` still
  // resolves the connector, the workspace and the sessions for itself.
  const publisher = new StubRoutePublisher();
  const gateway = new AcceptingGateway();
  // The control plane's log is collected so that a suite can assert what is
  // *not* in it (`docs/SECURITY.md` section 18). It is the process that resolves
  // credentials, serves artefact bytes and writes events, so it is where a raw
  // token would surface if one ever did.
  const logLines: string[] = [];
  const logDestination = {
    write(line: string): void {
      logLines.push(line);
    },
  };
  const control = await buildApp({
    config: serverConfig,
    pool,
    workerFetch,
    publisher,
    gateway,
    logDestination,
  });
  await control.app.ready();
  const mcp = await buildMcpApp({
    config: mcpConfig,
    pool,
    workerFetch,
    // The MCP process still never completes a publication: it requests, and
    // `api` finishes (ADR-0021). This is here so that a test that reaches
    // `complete` in this process fails loudly rather than silently marking a
    // good route `failed` — which is exactly what `UnreachableRoutePublisher`
    // is for, so it is deliberately **not** overridden.
  });
  await mcp.app.ready();

  /**
   * The allocation completion sweep `apps/server/src/main.ts` runs in `api`
   * (ADR-0037).
   *
   * It runs here because without it this harness is not the product: an agent
   * calling `browser_session_allocate` with a route writes the request and
   * waits, and the process that holds the capability signing key is the one
   * that finishes it. A harness with no sweep would let every such test time
   * out and would have proved nothing about the handoff.
   *
   * The grace is zero rather than the production two seconds because there is
   * no inline path racing it here — the MCP endpoint is the only requester — and
   * a two-second grace would put two seconds into every test that allocates.
   */
  const allocations = setInterval(() => {
    if (!state.completeAllocations) return;
    void control.sessions.completePendingAllocations({ olderThanMs: 0 }).catch(() => undefined);
  }, 25);
  allocations.unref();

  /**
   * What the stub worker returns for a command it was able to run.
   *
   * Each command returns what the real worker returns and nothing more, because
   * the trust rules are asserted against exactly that: a navigation and a
   * snapshot carry the page and are labelled untrusted; a click carries its own
   * duration and is not. The browser protocol's own validator refuses the
   * mislabelled alternatives on the way out of here, so a stub that got this
   * wrong would fail rather than quietly weaken the assertions.
   */
  async function succeed(
    browserSessionId: string,
    command: BrowserCommand,
    base: {
      readonly command: BrowserCommandResult["command"];
      readonly sequence: number;
      readonly control_epoch: number;
      readonly instruction_policy: "do_not_follow_as_instructions";
    },
  ): Promise<BrowserCommandResult> {
    switch (command.command) {
      case "navigate":
        return {
          ...base,
          ok: true,
          duration_ms: 24,
          trust: "untrusted_browser_content",
          viewport: { ...state.viewport },
          navigation: {
            url: settle(command.navigate?.url ?? "/"),
            http_status: 200,
            redirected: false,
            title: "Refresh Surplus",
          },
        };
      case "snapshot":
        return {
          ...base,
          ok: true,
          duration_ms: 18,
          trust: "untrusted_browser_content",
          viewport: { ...state.viewport },
          snapshot: nextSnapshot(),
        };
      case "resize":
        if (command.resize !== undefined) state.viewport = { ...command.resize.viewport };
        return {
          ...base,
          ok: true,
          duration_ms: 9,
          trust: "untrusted_browser_content",
          viewport: { ...state.viewport },
          // A resize invalidates every outstanding reference, so it returns the
          // snapshot that replaces them (`docs/MCP_SPEC.md` §7.4).
          snapshot: nextSnapshot(),
        };
      case "take_screenshot":
        return {
          ...base,
          ok: true,
          duration_ms: 12,
          trust: "untrusted_browser_content",
          screenshot: await uploadCapture(browserSessionId, state.capture),
        };
      default:
        return {
          ...base,
          ok: true,
          duration_ms: 7,
          trust: "trusted_control_plane",
          viewport: { ...state.viewport },
        };
    }
  }

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
      scroll_position: { x: 0, y: 0 },
      full_page: false,
      captured_at: new Date().toISOString(),
    };
  }

  let mcpOrigin: string | null = null;

  return {
    control,
    gateway,
    pool,
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
    get snapshotText() {
      return state.snapshotText;
    },
    set snapshotText(value: string) {
      state.snapshotText = value;
    },
    get completeAllocations() {
      return state.completeAllocations;
    },
    set completeAllocations(value: boolean) {
      state.completeAllocations = value;
    },
    get commands() {
      return state.commands;
    },
    logText() {
      return logLines.join("\n");
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
      clearInterval(allocations);
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
  /**
   * Declares MCP resource support away.
   *
   * `image_resources` is negotiated as `resources && image_content`
   * (`src/context.ts`), so this is the second of the two ways a client can lose
   * it, and a suite asserting the negotiation has to be able to exercise both.
   */
  readonly resources?: boolean;
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
  if (options.resources === false) url.searchParams.set("resources", "false");

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
