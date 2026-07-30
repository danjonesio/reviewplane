/**
 * The HTTP client.
 *
 * Every call is same-origin and carries the viewer session cookie, because the
 * gateway serves this application and proxies `/api` and `/ws` to the control
 * plane (`docs/ARCHITECTURE.md` section 4.1). There is no configurable API
 * host: a build that pointed at another origin would be a second place to get
 * the trust boundary wrong.
 *
 * Errors are the `docs/API.md` section 5 envelope, so a caller sees the stable
 * code rather than a status number.
 */

export interface ApiErrorBody {
  readonly error?: { readonly code?: string; readonly message?: string };
}

export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!response.ok) {
    let code = "INTERNAL_ERROR";
    let message = `The request failed with status ${String(response.status)}.`;
    try {
      const body = JSON.parse(text) as ApiErrorBody;
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // Not the expected envelope; the status carries the meaning.
    }
    throw new ApiFailure(response.status, code, message);
  }
  return (JSON.parse(text) as { data: T }).data;
}

export interface Project {
  readonly id: string;
  readonly organisation_id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly device_scale_factor: number;
}

export interface BrowserSession {
  readonly id: string;
  readonly project_id: string;
  readonly organisation_id: string;
  readonly status: string;
  readonly service_origin: string | null;
  readonly browser_version: string | null;
  readonly viewport: Viewport;
  readonly control_epoch: number;
  readonly created_at: string;
  readonly ended_at: string | null;
}

export interface ViewerSession {
  readonly viewer_session_id: string;
  readonly display: string;
  readonly project_ids: readonly string[] | null;
}

export const api = {
  async currentViewer(): Promise<ViewerSession> {
    return request<ViewerSession>("/api/v1/auth/viewer-sessions/current");
  },

  async signIn(bootstrapToken: string): Promise<void> {
    await request("/api/v1/auth/viewer-sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${bootstrapToken}` },
    });
  },

  async signOut(): Promise<void> {
    await request("/api/v1/auth/viewer-sessions/current", { method: "DELETE" });
  },

  async projects(): Promise<Project[]> {
    return request<Project[]>("/api/v1/projects");
  },

  async browserSessions(projectId: string): Promise<BrowserSession[]> {
    return request<BrowserSession[]>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/browser-sessions`,
    );
  },

  async browserSession(sessionId: string): Promise<BrowserSession> {
    return request<BrowserSession>(`/api/v1/browser-sessions/${encodeURIComponent(sessionId)}`);
  },
};

/** Statuses a live view is worth opening for. */
export const ACTIVE_STATUSES: readonly string[] = [
  "REQUESTED",
  "ALLOCATING",
  "READY",
  "ACTIVE",
  "PAUSED",
  "DEGRADED",
];

export function isActive(session: BrowserSession): boolean {
  return ACTIVE_STATUSES.includes(session.status);
}

/** The live WebSocket URL for a session, on this same origin. */
export function liveUrl(sessionId: string, mode: string): string {
  const scheme = globalThis.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${globalThis.location.host}/ws/v1/browser-sessions/${encodeURIComponent(sessionId)}/live?mode=${encodeURIComponent(mode)}`;
}
