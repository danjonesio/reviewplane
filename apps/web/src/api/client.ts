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

import type {
  Connector,
  ConnectorStatus,
  Environment,
  Workspace,
} from "@reviewplane/protocol/platform";
import type { Annotation, Finding, Review } from "@reviewplane/protocol/review";

export type { Annotation, Connector, ConnectorStatus, Environment, Finding, Review, Workspace };

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

/** Cookie the control plane puts the CSRF token in (`docs/API.md` section 4). */
const CSRF_COOKIE = "reviewplane_csrf";

/**
 * Reads the CSRF token the control plane issued with this session.
 *
 * It is deliberately readable — the session cookie is not — because the whole
 * mechanism is that the application echoes it in a header that no cross-site
 * form can set.
 */
export function csrfToken(): string | null {
  for (const part of document.cookie.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== CSRF_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    return value === "" ? null : decodeURIComponent(value);
  }
  return null;
}

/** Methods that change state and therefore carry the CSRF token. */
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const token = UNSAFE_METHODS.has(method) ? csrfToken() : null;
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === null ? {} : { "x-csrf-token": token }),
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

export interface ValidationViewport {
  readonly width: number;
  readonly height: number;
  readonly device_scale_factor?: number;
}

export interface RepositoryIdentity {
  readonly canonical: string;
  readonly clone_urls?: readonly string[];
}

export interface ProjectSettings {
  readonly default_validation_viewports: readonly ValidationViewport[];
}

export interface Project {
  readonly id: string;
  readonly organisation_id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly repository_identity?: RepositoryIdentity;
  readonly default_branch: string;
  readonly settings: ProjectSettings;
  readonly version: number;
  readonly created_at?: string;
  readonly updated_at?: string;
}

/** What a project's creation form sends (`docs/UX_FLOWS.md` section 4). */
export interface ProjectDraft {
  readonly name: string;
  readonly slug?: string;
  readonly repository_identity?: string;
  readonly default_branch?: string;
  readonly settings?: ProjectSettings;
}

/** The current human session (`docs/API.md` section 4). */
export interface HumanSession {
  readonly session_id: string;
  readonly user_id?: string;
  readonly organisation_id?: string;
  readonly email?: string;
  readonly display: string;
  readonly project_ids?: readonly string[];
  readonly expires_at: string;
}

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly display_name: string;
  readonly status: string;
  readonly local_credential_set?: boolean;
}

export interface CurrentSession {
  readonly session: HumanSession;
  readonly user: SessionUser | null;
}

/** What the first-run screen needs before anybody can sign in. */
export interface BootstrapStatus {
  readonly bootstrap_required: boolean;
  readonly install_token_outstanding: boolean;
  readonly organisation: { readonly id: string; readonly name: string; readonly slug: string } | null;
}

/** One event of a project's activity timeline (`docs/EVENTS.md` section 2). */
export interface ActivityEvent {
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  readonly occurred_at: string;
  readonly actor: { readonly type: string; readonly display?: string };
  readonly payload: Record<string, unknown>;
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

/**
 * Environments, connectors and workspaces (`docs/API.md` section 9,
 * `docs/DOMAIN_MODEL.md` sections 7 to 9).
 *
 * The records themselves come from `@reviewplane/protocol/platform`, which is
 * generated from the schema every service validates against. What is declared
 * here is only the shape of the responses that carry them: which members a list
 * answers with, and what the detail endpoint adds. A hand-written second copy of
 * `Connector` would be another thing to keep in step with the schema, which
 * `docs/DEVELOPMENT.md` section 3 forbids.
 */
/**
 * A member the schema records by absence and the API answers with `null`.
 *
 * Both spellings mean "the control plane does not know", and a page that
 * accepted only one of them would render the other as a date in 1970.
 */
type Absent<T> = T | null | undefined;

export type ConnectorSummary = Pick<
  Connector,
  "id" | "environment_id" | "certificate_fingerprint" | "version" | "capabilities" | "status"
> & {
  readonly project_id?: Absent<Connector["project_id"]>;
  readonly connected_at?: Absent<Connector["connected_at"]>;
  readonly last_heartbeat_at?: Absent<Connector["last_heartbeat_at"]>;
  readonly revoked_at?: Absent<Connector["revoked_at"]>;
};

/** One connector read on its own, which also answers with its environment. */
export interface ConnectorRecord extends ConnectorSummary {
  readonly certificate_not_after?: Absent<Connector["certificate_not_after"]>;
  readonly environment?: Absent<EnvironmentSummary>;
}

export type EnvironmentSummary = Pick<
  Environment,
  "id" | "name" | "platform" | "architecture" | "labels" | "trust_level" | "status"
> & {
  readonly project_id?: Absent<Environment["project_id"]>;
  readonly last_seen_at?: Absent<Environment["last_seen_at"]>;
};

/**
 * A checkout a connector reported. `display_path` is a label rather than a
 * path, and there is no member that could carry one: what is reportable about
 * somebody else's machine is bounded by the schema (`docs/DOMAIN_MODEL.md`
 * section 9).
 */
export type WorkspaceSummary = Pick<
  Workspace,
  "id" | "path_hash" | "display_path" | "branch" | "head_commit" | "dirty"
> & {
  readonly repository_identity?: Absent<Workspace["repository_identity"]>;
  readonly last_observed_at?: Absent<Workspace["last_observed_at"]>;
};

export interface EnvironmentRecord extends EnvironmentSummary {
  readonly connectors: readonly ConnectorSummary[];
  readonly workspaces: readonly WorkspaceSummary[];
}

/** What the enrolment form sends (`docs/API.md` section 9). */
export interface EnrolmentTokenDraft {
  readonly project_id?: string;
  readonly expires_in_seconds?: number;
  readonly max_uses?: number;
  readonly environment_labels?: readonly string[];
}

/**
 * The issued token, which is the only place its value ever appears: the control
 * plane stores a digest and cannot reproduce it (`docs/API.md` section 9,
 * `docs/CONNECTOR_PROTOCOL.md` section 4.1). Nothing here is cached, and the
 * value is held for the life of the page that minted it and no longer.
 *
 * This response has no schema in `packages/protocol` yet, so it is declared
 * here; it belongs there once the platform schema covers the enrolment-token
 * surface.
 */
export interface EnrolmentToken {
  readonly id: string;
  readonly organisation_id: string;
  readonly project_id?: string | null;
  readonly environment_labels: readonly string[];
  readonly max_uses: number;
  readonly expires_at: string;
  readonly enrolment_token: string;
  readonly enrolment_endpoint: string;
  readonly control_plane_url: string;
  /** The ready-to-run command, assembled by the control plane. */
  readonly connector_command: string;
}

/** What revocation did, so the page can report it rather than imply it. */
export interface ConnectorRevocation {
  readonly id: string;
  readonly status: ConnectorStatus;
  readonly revoked_at: string;
  readonly routes_revoked: number;
  readonly sessions_disconnected: number;
  readonly channels_closed: number;
}

export const api = {
  /** Whether this installation still has to be claimed. */
  async bootstrapStatus(): Promise<BootstrapStatus> {
    return request<BootstrapStatus>("/api/v1/auth/bootstrap");
  },

  /** Claims the installation with the one-time token the operator minted. */
  async bootstrap(input: {
    readonly token: string;
    readonly email: string;
    readonly password: string;
  }): Promise<CurrentSession> {
    return request<CurrentSession>("/api/v1/auth/bootstrap", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  async currentSession(): Promise<CurrentSession> {
    return request<CurrentSession>("/api/v1/auth/sessions/current");
  },

  async signIn(input: { readonly email: string; readonly password: string }): Promise<CurrentSession> {
    return request<CurrentSession>("/api/v1/auth/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  async signOut(): Promise<void> {
    await request("/api/v1/auth/sessions/current", { method: "DELETE" });
  },

  async projects(): Promise<Project[]> {
    return request<Project[]>("/api/v1/projects");
  },

  async project(projectId: string): Promise<Project> {
    return request<Project>(`/api/v1/projects/${encodeURIComponent(projectId)}`);
  },

  async createProject(draft: ProjectDraft): Promise<Project> {
    return request<Project>("/api/v1/projects", {
      method: "POST",
      body: JSON.stringify(draft),
    });
  },

  async updateProject(
    projectId: string,
    change: Partial<ProjectDraft> & { readonly expected_version?: number },
  ): Promise<Project> {
    return request<Project>(`/api/v1/projects/${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      body: JSON.stringify(change),
    });
  },

  async archiveProject(projectId: string): Promise<Project> {
    return request<Project>(`/api/v1/projects/${encodeURIComponent(projectId)}`, {
      method: "DELETE",
    });
  },

  async activity(projectId: string, limit = 20): Promise<ActivityEvent[]> {
    return request<ActivityEvent[]>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/activity?limit=${String(limit)}`,
    );
  },

  async browserSessions(projectId: string): Promise<BrowserSession[]> {
    return request<BrowserSession[]>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/browser-sessions`,
    );
  },

  async browserSession(sessionId: string): Promise<BrowserSession> {
    return request<BrowserSession>(`/api/v1/browser-sessions/${encodeURIComponent(sessionId)}`);
  },

  /**
   * Mints an enrolment token. The response is the only sight of its value, so
   * nothing here retries: a retried mint would issue a second credential.
   */
  async createEnrolmentToken(draft: EnrolmentTokenDraft): Promise<EnrolmentToken> {
    return request<EnrolmentToken>("/api/v1/connectors/enrolment-tokens", {
      method: "POST",
      body: JSON.stringify(draft),
    });
  },

  async connectors(): Promise<ConnectorSummary[]> {
    return request<ConnectorSummary[]>("/api/v1/connectors");
  },

  async connector(connectorId: string): Promise<ConnectorRecord> {
    return request<ConnectorRecord>(`/api/v1/connectors/${encodeURIComponent(connectorId)}`);
  },

  async revokeConnector(connectorId: string): Promise<ConnectorRevocation> {
    return request<ConnectorRevocation>(
      `/api/v1/connectors/${encodeURIComponent(connectorId)}/revoke`,
      { method: "POST" },
    );
  },

  async environments(projectId: string): Promise<EnvironmentRecord[]> {
    return request<EnvironmentRecord[]>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/environments`,
    );
  },

  async environment(environmentId: string): Promise<EnvironmentRecord> {
    return request<EnvironmentRecord>(`/api/v1/environments/${encodeURIComponent(environmentId)}`);
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
