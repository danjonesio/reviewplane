/**
 * A stub control plane for the user-interface suite.
 *
 * It serves the built application exactly as the gateway does — static assets
 * with a single-page fallback, `/api` and `/ws` on the same origin — and
 * speaks the real live-view protocol from `packages/protocol`. Nothing here
 * reimplements a message shape: every frame is encoded by the generated
 * encoder, so a message the browser refuses would fail this suite too.
 *
 * The point of a stub rather than the real server is restartability: the
 * fault-injection case of `docs/TESTING.md` section 11 is an API restart
 * during a live view, and a stub can be stopped and started in a second
 * without a database.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";

import { WebSocketServer, type WebSocket } from "ws";

import {
  encodeLiveViewFrame,
  type FrameMetadata,
  type LiveMode,
  type SessionStatus,
} from "@reviewplane/protocol/live-view";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export interface StubOptions {
  /** Directory holding the built application. */
  readonly distDirectory: string;
  /** JPEG frames streamed in rotation, newest first on each tick. */
  readonly frames: readonly Uint8Array[];
  /** Port to bind. Zero picks one; a restart reuses the same number. */
  readonly port?: number;
  /** Set to refuse the live upgrade, for the failure-state case. */
  refuseLive?: boolean;
  /**
   * PNG bytes served as the review's screenshot artefact. Supplied by the
   * annotation suite, which renders a real page and marks a known region of
   * it, because an overlay that lands on the wrong part of a blank image would
   * pass any test that did not look at the picture.
   */
  readonly screenshot?: Uint8Array;
}

export interface StubControlPlane {
  readonly origin: string;
  readonly port: number;
  /** Live viewers currently attached. */
  readonly viewers: number;
  /** Frames written to viewers since start. */
  readonly framesSent: number;
  stop(): Promise<void>;
}

const BOOTSTRAP_TOKEN = "ui-suite-bootstrap-token";
const COOKIE = "reviewplane_viewer=ui-suite-session";

const PROJECT = {
  id: "prj_ui_suite",
  organisation_id: "org_ui_suite",
  name: "Refresh Surplus",
  slug: "refresh-surplus",
  status: "active",
};

export const SESSION: {
  readonly id: string;
  readonly project_id: string;
  readonly organisation_id: string;
  readonly status: SessionStatus;
  readonly service_origin: string;
  readonly browser_version: string;
  readonly viewport: { width: number; height: number; device_scale_factor: number };
  readonly control_epoch: number;
  readonly created_at: string;
  readonly ended_at: string | null;
} = {
  id: "brs_ui_suite_session",
  project_id: PROJECT.id,
  organisation_id: PROJECT.organisation_id,
  status: "ACTIVE",
  service_origin: "https://route-ui-suite.internal.invalid",
  browser_version: "143.0.7499.4",
  viewport: { width: 1440, height: 900, device_scale_factor: 1 },
  control_epoch: 1,
  created_at: "2026-07-30T10:00:00.000Z",
  ended_at: null,
};

/**
 * The review the annotation suite reads.
 *
 * The geometry is the whole point of the fixture: `MARKED_REGION` is where the
 * rendered page paints a distinctly coloured block, and the annotation claims
 * exactly that region. An overlay that lands anywhere else is a defect the
 * suite can see, rather than one it has to be told about.
 */
export const MARKED_REGION = { x: 0.25, y: 0.3, width: 0.3, height: 0.12 } as const;

/**
 * The colour painted inside `MARKED_REGION`, as the page renders it. It is
 * deliberately far from every overlay tone, so an evidence screenshot shows
 * the mark's outline against the region rather than red on red.
 */
export const MARKED_COLOUR = { r: 16, g: 185, b: 129 } as const;

/** The 390x844 preset at a device pixel ratio of 2 (`AGENTS.md`). */
export const CAPTURE_VIEWPORT = { width: 390, height: 844, device_scale_factor: 2 } as const;

export const REVIEW = {
  id: "rev_ui_suite_bugs",
  organisation_id: "org_ui_suite",
  project_id: "prj_ui_suite",
  slug: "bugs-on-homepage",
  title: "Bugs on homepage",
  description: "Fix these before continuing with the product page.",
  status: "READY",
  version: 2,
  created_by: { type: "human_user", id: "vwr_ui", display: "bootstrap administrator" },
  captured_branch: "feat/homepage-refresh",
  captured_commit: "4a45b94f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60",
  captured_workspace_id: "wsp_ui_suite",
  source_browser_session_id: "brs_ui_suite_session",
  finding_count: 2,
  created_at: "2026-07-30T10:12:04.118Z",
  updated_at: "2026-07-30T10:12:44.310Z",
};

export const MEASURED_ARTEFACT = "art_ui_suite_measured";
export const UNMEASURED_ARTEFACT = "art_ui_suite_unmeasured";

const FINDINGS = [
  {
    id: "fin_ui_suite_hero",
    organisation_id: REVIEW.organisation_id,
    project_id: REVIEW.project_id,
    review_id: REVIEW.id,
    title: "Hero heading overlaps the basket button",
    description: "At 390x844 the heading wraps onto the button and hides it.",
    severity: "high",
    status: "OPEN",
    source: "human",
    version: 1,
    created_by: { type: "human_user", id: "vwr_ui", display: "bootstrap administrator" },
    url: "https://route-ui-suite.internal.invalid/",
    viewport: CAPTURE_VIEWPORT,
    scroll_position: { x: 0, y: 320 },
    captured_commit: REVIEW.captured_commit,
    screenshot_artefact_id: MEASURED_ARTEFACT,
    acceptance_criteria: "The basket button is fully visible and operable at 390x844.",
    annotation_count: 3,
    created_at: "2026-07-30T10:12:44.310Z",
    updated_at: "2026-07-30T10:12:44.310Z",
  },
  {
    id: "fin_ui_suite_unmeasured",
    organisation_id: REVIEW.organisation_id,
    project_id: REVIEW.project_id,
    review_id: REVIEW.id,
    title: "Basket count is stale after removal",
    description: "The evidence for this finding could not be measured by the server.",
    severity: "medium",
    status: "OPEN",
    source: "human",
    version: 1,
    created_by: { type: "human_user", id: "vwr_ui", display: "bootstrap administrator" },
    url: "https://route-ui-suite.internal.invalid/basket",
    viewport: CAPTURE_VIEWPORT,
    scroll_position: { x: 0, y: 0 },
    captured_commit: REVIEW.captured_commit,
    screenshot_artefact_id: UNMEASURED_ARTEFACT,
    annotation_count: 1,
    created_at: "2026-07-30T10:13:02.110Z",
    updated_at: "2026-07-30T10:13:02.110Z",
  },
];

const ANNOTATIONS: Readonly<Record<string, readonly Record<string, unknown>[]>> = {
  "fin_ui_suite_hero": [
    {
      id: "ann_ui_suite_rectangle",
      organisation_id: REVIEW.organisation_id,
      project_id: REVIEW.project_id,
      finding_id: "fin_ui_suite_hero",
      artefact_id: MEASURED_ARTEFACT,
      type: "rectangle",
      geometry: MARKED_REGION,
      label: "Heading overlapping the basket button",
      style_hint: "critical",
      revision: 1,
      created_by: { type: "human_user", id: "vwr_ui" },
      created_at: "2026-07-30T10:12:44.318Z",
    },
    {
      id: "ann_ui_suite_marker",
      organisation_id: REVIEW.organisation_id,
      project_id: REVIEW.project_id,
      finding_id: "fin_ui_suite_hero",
      artefact_id: MEASURED_ARTEFACT,
      type: "numbered_marker",
      geometry: { x: 0.4, y: 0.36 },
      label: "Centre of the overlapping region",
      marker_number: 2,
      style_hint: "default",
      revision: 1,
      created_by: { type: "human_user", id: "vwr_ui" },
      created_at: "2026-07-30T10:12:45.001Z",
    },
    {
      id: "ann_ui_suite_arrow",
      organisation_id: REVIEW.organisation_id,
      project_id: REVIEW.project_id,
      finding_id: "fin_ui_suite_hero",
      artefact_id: MEASURED_ARTEFACT,
      type: "arrow",
      geometry: { x: 0.1, y: 0.7, x2: 0.4, y2: 0.42 },
      label: "Pointing at the hidden basket button",
      style_hint: "informational",
      revision: 1,
      created_by: { type: "human_user", id: "vwr_ui" },
      created_at: "2026-07-30T10:12:45.400Z",
    },
  ],
  "fin_ui_suite_unmeasured": [
    {
      id: "ann_ui_suite_unmeasured",
      organisation_id: REVIEW.organisation_id,
      project_id: REVIEW.project_id,
      finding_id: "fin_ui_suite_unmeasured",
      artefact_id: UNMEASURED_ARTEFACT,
      type: "rectangle",
      geometry: { x: 0.05, y: 0.05, width: 0.2, height: 0.05 },
      label: "Stale basket count",
      style_hint: "default",
      revision: 1,
      created_by: { type: "human_user", id: "vwr_ui" },
      created_at: "2026-07-30T10:13:02.118Z",
    },
  ],
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(encoded)),
  });
  response.end(encoded);
}

function hasSession(request: IncomingMessage): boolean {
  return (request.headers.cookie ?? "").includes("reviewplane_viewer=");
}

export async function startStubControlPlane(options: StubOptions): Promise<StubControlPlane> {
  const state = { viewers: 0, framesSent: 0, sequence: 0, grants: 0 };
  /** Minted artefact grants, so a content path is only reachable through one. */
  const grants = new Map<string, string>();

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: { code: "INTERNAL_ERROR" } });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://ui-suite.invalid");
    const path = url.pathname;

    if (path === "/api/v1/auth/viewer-sessions" && request.method === "POST") {
      if (request.headers.authorization !== `Bearer ${BOOTSTRAP_TOKEN}`) {
        sendJson(response, 401, {
          error: { code: "AUTHENTICATION_REQUIRED", message: "The token was not recognised." },
        });
        return;
      }
      response.setHeader("set-cookie", `${COOKIE}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600`);
      sendJson(response, 201, { data: { viewer_session_id: "vwr_ui", project_ids: null } });
      return;
    }

    if (path === "/api/v1/auth/viewer-sessions/current") {
      if (request.method === "DELETE") {
        response.setHeader("set-cookie", "reviewplane_viewer=; Path=/; Max-Age=0");
        response.writeHead(204);
        response.end();
        return;
      }
      if (!hasSession(request)) {
        sendJson(response, 401, {
          error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." },
        });
        return;
      }
      sendJson(response, 200, {
        data: {
          viewer_session_id: "vwr_ui",
          display: "bootstrap administrator",
          project_ids: null,
        },
      });
      return;
    }

    if (!hasSession(request) && path.startsWith("/api/")) {
      sendJson(response, 401, {
        error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." },
      });
      return;
    }

    if (path === "/api/v1/projects") {
      sendJson(response, 200, { data: [PROJECT] });
      return;
    }
    if (path === `/api/v1/projects/${PROJECT.id}/browser-sessions`) {
      sendJson(response, 200, { data: [SESSION] });
      return;
    }
    if (path === `/api/v1/browser-sessions/${SESSION.id}`) {
      sendJson(response, 200, { data: SESSION });
      return;
    }

    // ------------------------------------------------------------ reviews
    if (path === `/api/v1/projects/${PROJECT.id}/reviews`) {
      sendJson(response, 200, { data: [REVIEW] });
      return;
    }
    if (path === `/api/v1/reviews/${REVIEW.id}`) {
      sendJson(response, 200, { data: REVIEW });
      return;
    }
    if (path === `/api/v1/reviews/${REVIEW.id}/findings`) {
      sendJson(response, 200, { data: FINDINGS });
      return;
    }
    const annotationsMatch = /^\/api\/v1\/findings\/([^/]+)\/annotations$/u.exec(path);
    if (annotationsMatch !== null) {
      sendJson(response, 200, { data: ANNOTATIONS[annotationsMatch[1] as string] ?? [] });
      return;
    }

    // ---------------------------------------------------------- artefacts
    const artefactMatch = /^\/api\/v1\/artefacts\/([^/]+)$/u.exec(path);
    if (artefactMatch !== null) {
      const id = artefactMatch[1] as string;
      // One artefact the server measured and one it did not. The second is
      // what proves the viewer degrades to the original plus the annotation
      // list instead of guessing a reference frame.
      sendJson(response, 200, {
        data: {
          id,
          project_id: PROJECT.id,
          kind: "screenshot",
          state: "available",
          content_type: "image/png",
          size_bytes: options.screenshot?.byteLength ?? 0,
          sha256: "9f2c4c9d1b6a7e35d0d8c4a1f6b30e7c2a5d9e84b1c60f37a2d8e5b4c9f01a63",
          storage_key: "sha256/9f/2c4c9d1b6a7e35d0d8c4a1f6b30e7c2a5d9e84b1c60f37a2d8e5b4c9f01a63",
          content_rectangle:
            id === UNMEASURED_ARTEFACT
              ? null
              : {
                  width_px: CAPTURE_VIEWPORT.width * CAPTURE_VIEWPORT.device_scale_factor,
                  height_px: CAPTURE_VIEWPORT.height * CAPTURE_VIEWPORT.device_scale_factor,
                },
          redaction_state: "not_applied",
          retention_class: "verification_evidence",
          available_at: "2026-07-30T10:12:20.000Z",
        },
      });
      return;
    }
    const grantMatch = /^\/api\/v1\/artefacts\/([^/]+)\/grants$/u.exec(path);
    if (grantMatch !== null && request.method === "POST") {
      state.grants += 1;
      const grantId = `agr_ui_${String(state.grants)}`;
      grants.set(grantId, grantMatch[1] as string);
      sendJson(response, 201, {
        data: {
          grant_id: grantId,
          artefact_id: grantMatch[1],
          url: `/api/v1/artefact-content/${grantId}`,
          expires_at: new Date(Date.now() + 120_000).toISOString(),
          expires_in_seconds: 120,
        },
      });
      return;
    }
    const contentMatch = /^\/api\/v1\/artefact-content\/([^/]+)$/u.exec(path);
    if (contentMatch !== null) {
      const artefactId = grants.get(contentMatch[1] as string);
      const bytes = options.screenshot;
      if (artefactId === undefined || bytes === undefined) {
        sendJson(response, 401, {
          error: { code: "AUTHENTICATION_REQUIRED", message: "No such grant." },
        });
        return;
      }
      response.writeHead(200, {
        "content-type": "image/png",
        "content-length": String(bytes.byteLength),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "referrer-policy": "no-referrer",
      });
      response.end(Buffer.from(bytes));
      return;
    }

    if (path.startsWith("/api/")) {
      sendJson(response, 404, { error: { code: "RESOURCE_NOT_FOUND", message: "No such route." } });
      return;
    }

    await serveStatic(path, response);
  }

  async function serveStatic(path: string, response: ServerResponse): Promise<void> {
    const relative = normalize(path).replace(/^(\.\.[/\\])+/u, "");
    let file = join(options.distDirectory, relative);
    const info = await stat(file).catch(() => null);
    if (info === null || info.isDirectory()) {
      // Client-side routing: an unknown path is the application document.
      file = join(options.distDirectory, "index.html");
    }
    const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
    response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    createReadStream(file).pipe(response);
  }

  const sockets = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://ui-suite.invalid");
    const match = /^\/ws\/v1\/browser-sessions\/([^/]+)\/live$/u.exec(url.pathname);
    if (match === null || !hasSession(request)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    if (options.refuseLive === true) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }
    const mode = (url.searchParams.get("mode") ?? "session_room") as LiveMode;
    sockets.handleUpgrade(request, socket, head, (client) => {
      attach(client, match[1] as string, mode);
    });
  });

  function attach(client: WebSocket, browserSessionId: string, mode: LiveMode): void {
    state.viewers += 1;
    const envelope = (type: "live.attached" | "live.session_state" | "live.frame") => ({
      protocol_version: 1 as const,
      // Identifiers are opaque and bounded to `[A-Za-z0-9_-]`; a message type
      // carries a dot, so it cannot be spliced into one.
      message_id: `msg_${String(state.sequence)}_${type.replace(/\./gu, "_")}`,
      type,
      sent_at: new Date().toISOString(),
      browser_session_id: browserSessionId,
      stream_id: "lvs_ui_suite",
    });

    client.send(
      encodeLiveViewFrame({
        envelope: envelope("live.session_state"),
        type: "live.session_state",
        payload: {
          status: SESSION.status,
          url: `${SESSION.service_origin}/checkout`,
          viewport: SESSION.viewport,
          control_epoch: SESSION.control_epoch,
          live_capture: true,
          observed_at: new Date().toISOString(),
        },
      }),
    );
    client.send(
      encodeLiveViewFrame({
        envelope: envelope("live.attached"),
        type: "live.attached",
        payload: {
          project_id: PROJECT.id,
          mode,
          format: "image/jpeg",
          retention: "never",
          max_frame_bytes: 4194304,
          attached_at: new Date().toISOString(),
        },
      }),
    );

    // The rate matches the mode's band, so the page under test sees the same
    // cadence a worker would produce.
    const interval = mode === "thumbnail" ? 250 : 66;
    const timer = setInterval(() => {
      if (client.readyState !== client.OPEN) return;
      const payload = options.frames[state.sequence % options.frames.length];
      if (payload === undefined) return;
      state.sequence += 1;
      const metadata: FrameMetadata = {
        sequence: state.sequence,
        captured_at: new Date().toISOString(),
        mode,
        format: "image/jpeg",
        width: SESSION.viewport.width,
        height: SESSION.viewport.height,
        quality: 70,
        byte_length: payload.byteLength,
        dropped_before: 0,
      };
      client.send(
        encodeLiveViewFrame({
          envelope: envelope("live.frame"),
          type: "live.frame",
          payload: metadata,
        }),
      );
      client.send(payload, { binary: true });
      state.framesSent += 1;
    }, interval);

    client.on("close", () => {
      clearInterval(timer);
      state.viewers -= 1;
    });
    client.on("message", () => {
      // Viewer heartbeats and quality requests are accepted and ignored; the
      // scheduler is the worker's, and there is no worker here.
    });
  }

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    port: address.port,
    get viewers(): number {
      return state.viewers;
    },
    get framesSent(): number {
      return state.framesSent;
    },
    async stop(): Promise<void> {
      for (const client of sockets.clients) client.terminate();
      sockets.close();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

export const UI_SUITE_TOKEN = BOOTSTRAP_TOKEN;
