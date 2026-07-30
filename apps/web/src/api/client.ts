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

import type { Annotation, Finding, Review } from "@reviewplane/protocol/review";

export type { Annotation, Finding, Review };

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

/**
 * Artefact metadata (`docs/UX_FLOWS.md` section 17).
 *
 * `content_rectangle` is the reference frame every annotation on this artefact
 * is normalised against. It may be absent — an artefact the server could not
 * measure — and the viewer must degrade rather than guess, because a guessed
 * frame produces an overlay that looks right and is not.
 */
export interface ArtefactContentRectangle {
  readonly width_px: number;
  readonly height_px: number;
}

export interface Artefact {
  readonly id: string;
  readonly project_id: string;
  readonly kind: string;
  readonly state: string;
  readonly content_type: string;
  readonly size_bytes: number | null;
  readonly sha256: string | null;
  readonly storage_key: string | null;
  readonly content_rectangle: ArtefactContentRectangle | null;
  readonly redaction_state: string;
  readonly retention_class: string;
  readonly available_at: string | null;
}

export interface ArtefactGrant {
  readonly grant_id: string;
  readonly artefact_id: string;
  /** Same-origin path that serves the bytes while the grant is live. */
  readonly url: string;
  readonly expires_at: string;
  readonly expires_in_seconds: number;
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

  async reviews(projectId: string): Promise<Review[]> {
    return request<Review[]>(`/api/v1/projects/${encodeURIComponent(projectId)}/reviews`);
  },

  async review(reviewId: string): Promise<Review> {
    return request<Review>(`/api/v1/reviews/${encodeURIComponent(reviewId)}`);
  },

  async findings(reviewId: string): Promise<Finding[]> {
    return request<Finding[]>(`/api/v1/reviews/${encodeURIComponent(reviewId)}/findings`);
  },

  async annotations(findingId: string): Promise<Annotation[]> {
    return request<Annotation[]>(
      `/api/v1/findings/${encodeURIComponent(findingId)}/annotations`,
    );
  },

  async artefact(artefactId: string): Promise<Artefact> {
    return request<Artefact>(`/api/v1/artefacts/${encodeURIComponent(artefactId)}`);
  },

  /**
   * Mints the short-lived grant that lets an `<img>` load one artefact
   * (ADR-0019). The returned path is useless to anyone without this viewer's
   * session cookie, so it is safe to put in an element attribute.
   */
  async artefactGrant(artefactId: string): Promise<ArtefactGrant> {
    return request<ArtefactGrant>(
      `/api/v1/artefacts/${encodeURIComponent(artefactId)}/grants`,
      { method: "POST" },
    );
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
