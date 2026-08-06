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
  PublishedService as PublishedServiceEntity,
  Workspace,
} from "@reviewplane/protocol/platform";
import type {
  Annotation,
  AnnotationCreateRequest,
  AnnotationGeometry,
  AnnotationType,
  Comment,
  ElementContext,
  EvidenceAssurance,
  Finding,
  FindingSeverity,
  FindingStatus,
  Review,
  ReviewPriority,
  ReviewStatus,
  ScrollPosition,
  VerificationReference,
  VerificationReview,
} from "@reviewplane/protocol/review";

export type {
  Annotation,
  AnnotationCreateRequest,
  AnnotationGeometry,
  AnnotationType,
  Comment,
  Connector,
  ConnectorStatus,
  ElementContext,
  Environment,
  EvidenceAssurance,
  Finding,
  FindingSeverity,
  FindingStatus,
  Review,
  ReviewPriority,
  ReviewStatus,
  ScrollPosition,
  VerificationReference,
  VerificationReview,
  Workspace,
};

/** The verification shape the review workspace reads. */
export type Verification = VerificationReference;

/** The review-search dimensions of `docs/UX_FLOWS.md` section 16. */
export interface ReviewFilters {
  readonly q?: string;
  readonly status?: string;
  readonly severity?: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly createdSince?: string;
}

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
  /**
   * What this event is about, by identifier (`docs/EVENTS.md` section 5).
   *
   * It is not decoration. The session room shows one browser session's rows and
   * decides which those are from `browser_session_id` here; an event read over
   * HTTP that arrived without its correlation would be filtered out of the very
   * panel it belongs in, and the room would look empty until something new
   * happened to arrive over the socket instead.
   */
  readonly correlation?: Record<string, string>;
  readonly payload: Record<string, unknown>;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly device_scale_factor: number;
}

/**
 * Who holds interactive control of a browser (`docs/DOMAIN_MODEL.md` section
 * 13). Exactly one controller drives a session at a time, and this is the
 * record of which one; `null` is nobody, which is a real state rather than a
 * missing value.
 */
export interface ControllerIdentity {
  readonly type: string;
  readonly id: string;
}

/**
 * A browser session as `docs/API.md` section 11 answers it, which is the
 * server's `BrowserSessionRecord` minus the members no viewer surface reads.
 *
 * Every member the control plane may not know arrives as `null` rather than
 * absent, so none of them is optional. `control_epoch` and `current_controller`
 * are read together: the epoch is what a pause, a resume or a command is
 * authorised against, and the controller is who it would be taken from.
 */
export interface BrowserSession {
  readonly id: string;
  readonly project_id: string;
  readonly organisation_id: string;
  readonly status: string;
  readonly published_service_id: string | null;
  readonly service_origin: string | null;
  readonly browser_version: string | null;
  readonly viewport: Viewport;
  readonly current_controller: ControllerIdentity | null;
  readonly control_epoch: number;
  readonly created_at: string;
  readonly ended_at: string | null;
}

/** What the start form sends (`docs/API.md` section 11). */
export interface BrowserSessionDraft {
  /**
   * The route this session may reach, or absent for a session that reaches
   * nothing. The origin and the capability are derived from this record by the
   * control plane and are never sent by a caller: the origin *is* the worker's
   * egress allow-list (`docs/SECURITY.md` §9).
   */
  readonly published_service_id?: string;
  readonly viewport: Viewport;
}

/**
 * One entry of a session's own timeline (`docs/API.md` section 11).
 *
 * It is the event record of `docs/EVENTS.md` section 2 narrowed to one session:
 * what happened, when, and who caused it. `payload` is left opaque because the
 * shape differs per event type and a surface renders what it recognises rather
 * than assuming a member is there.
 */
export interface BrowserSessionTimelineEntry {
  readonly id: string;
  readonly type: string;
  readonly occurred_at: string;
  readonly actor: { readonly type: string; readonly display: string | null };
  readonly payload: Record<string, unknown>;
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

/**
 * What a browser command answered with (`docs/API.md` §11).
 *
 * Only the two members the capture flow reads are declared. The result is
 * page-derived throughout and carries its own trust label; nothing here is
 * ever treated as an instruction (ADR-0010).
 */
export interface BrowserCommandOutcome {
  readonly ok: boolean;
  readonly error?: { readonly code?: string; readonly message?: string };
  readonly screenshot?: {
    readonly artefact_id: string;
    readonly viewport: Viewport;
    /**
     * Where the page was scrolled when the pixels were taken, measured by the
     * worker. It is what relates a viewport-sized picture to the document the
     * snapshot's element boxes are expressed against (ADR-0033).
     */
    readonly scroll_position: ScrollPosition;
    readonly captured_at: string;
  };
  readonly snapshot?: {
    readonly snapshot_id: string;
    readonly viewport: Viewport;
    readonly scroll_position: ScrollPosition;
    readonly truncated: boolean;
    readonly elements: readonly SnapshotElement[];
  };
}

/**
 * One element of a snapshot. Everything but `ref` and `selector_strategy` is
 * page-derived and is displayed as text, never followed.
 */
export interface SnapshotElement {
  readonly ref: string;
  readonly role: string;
  readonly name?: string;
  readonly box?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly selector?: string;
  readonly selector_strategy?: ElementContext["selector_strategy"];
  readonly text_excerpt?: string;
  readonly dom_fingerprint?: string;
}

/** The named review a human creates from a session (`docs/UX_FLOWS.md` §10). */
export interface ReviewDraft {
  readonly slug: string;
  readonly title: string;
  readonly description?: string;
  readonly status?: "DRAFT" | "READY";
  readonly priority?: ReviewPriority;
  readonly captured_branch: string;
  readonly captured_commit: string;
  readonly captured_workspace_id: string;
  readonly source_browser_session_id: string;
}

/** A finding and the marks that explain it (`docs/UX_FLOWS.md` §9). */
export interface FindingDraft {
  readonly title: string;
  readonly description?: string;
  readonly severity: FindingSeverity;
  readonly url: string;
  readonly viewport: Viewport;
  readonly scroll_position: ScrollPosition;
  readonly captured_commit: string;
  readonly screenshot_artefact_id: string;
  readonly element_context?: ElementContext;
  readonly acceptance_criteria?: string;
  readonly annotations?: readonly AnnotationCreateRequest[];
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
  /**
   * When retention becomes due. Stage 1 records it and deletes nothing, so the
   * viewer says "due" and never "deleted" (`docs/UX_FLOWS.md` section 17).
   */
  readonly expires_at: string | null;
  /**
   * How the bytes are served. `attachment` is active markup, which is never
   * rendered under this origin (`docs/SECURITY.md` section 13).
   */
  readonly disposition: "inline" | "attachment";
  /**
   * The key that would decrypt these bytes, or null. Null is the honest
   * statement that they are not application-encrypted.
   */
  readonly encryption_key_reference: string | null;
  readonly thumbnail_state: string;
  readonly thumbnail_artefact_id: string | null;
  readonly source_artefact_id: string | null;
  readonly available_at: string | null;
}

export interface ArtefactGrant {
  readonly grant_id: string;
  readonly artefact_id: string;
  /**
   * Where the bytes are while the grant is live. A same-origin path under the
   * `filesystem` driver; a short-lived presigned URL under `s3` (ADR-0019). The
   * caller does not need to know which.
   */
  readonly url: string;
  readonly expires_at: string;
  readonly expires_in_seconds: number;
  readonly disposition: "inline" | "attachment";
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

/**
 * A published development service: a temporary route from a central browser
 * worker to a port on the development machine (`docs/DOMAIN_MODEL.md` section
 * 10, `docs/API.md` section 10).
 *
 * The closed vocabularies come from `packages/protocol` rather than being
 * spelled again here. An earlier version of this file declared all of them
 * locally with a comment saying the platform schema did not cover the record —
 * true when it was written, and false by the end of the same change. Widening
 * `protocol` and `failure_class` to `string` is not a small loss: they are the
 * two fields the publication surface renders by name, and a code outside the
 * vocabulary would have compiled.
 *
 * The **shape** is still declared here, and deliberately. The generated
 * `PublishedService` entity is the durable record; this is what `docs/API.md`
 * section 10 returns, which adds `internal_origin` and renders an absent member
 * as `null` rather than omitting it. Importing the entity and pretending the
 * response matched it would be a type that lies about which members can be
 * read without a check.
 */
export type PublishedServiceStatus = PublishedServiceEntity["status"];

export interface PublishedService {
  readonly id: string;
  readonly project_id: string;
  readonly connector_id: string;
  readonly workspace_id: string;
  readonly local_host: string;
  readonly local_port: number;
  readonly protocol: PublishedServiceEntity["protocol"];
  readonly public_alias: string;
  readonly internal_origin: string;
  readonly scope: string;
  readonly allowed_browser_session_ids: readonly string[];
  readonly expires_at: string;
  readonly status: PublishedServiceStatus;
  readonly failure_class?: Absent<NonNullable<PublishedServiceEntity["failure_class"]>>;
  readonly observed_destination?: Absent<string>;
}

/**
 * What the publication form sends.
 *
 * `allowed_browser_session_ids` must name at least one session:
 * `docs/CONNECTOR_PROTOCOL.md` section 11 does not publish a route no session
 * may use, so a form that could send none would only ever be refused.
 */
export interface PublishedServiceDraft {
  readonly connector_id: string;
  readonly workspace_id: string;
  readonly local_host: string;
  readonly local_port: number;
  readonly protocol: string;
  readonly ttl_seconds: number;
  readonly allowed_browser_session_ids: readonly string[];
}

/**
 * One delivered piece of work (`docs/API.md` section 16,
 * `docs/DOMAIN_MODEL.md` section 21).
 *
 * Acknowledgement and completion are separate members because they are separate
 * facts: an agent that has seen the work has not done it. A surface that read
 * one from the other would report a review as finished the moment it was
 * collected.
 *
 * Every member the control plane may not know arrives as `null` rather than
 * absent, which is why none of them is optional here.
 */
export interface InboxItem {
  readonly id: string;
  readonly organisation_id: string;
  readonly project_id: string;
  readonly recipient_type: "human_user" | "agent_session";
  readonly recipient_id: string | null;
  readonly type: string;
  readonly title: string;
  readonly status: "pending" | "acknowledged" | "completed" | "dismissed" | "expired";
  readonly review_id: string | null;
  readonly review_slug: string | null;
  readonly finding_id: string | null;
  readonly priority: string | null;
  readonly finding_count: number | null;
  readonly assigned_by: {
    readonly type: string;
    readonly id?: string;
    readonly display?: string;
  } | null;
  readonly created_at: string;
  readonly acknowledged_at: string | null;
  readonly completed_at: string | null;
  readonly expires_at: string | null;
}

/** What revocation did, so the page can report it rather than imply it. */
export interface ConnectorRevocation {
  readonly id: string;
  readonly status: ConnectorStatus;
  readonly revoked_at: string;
  readonly routes_revoked: number;
  readonly sessions_disconnected: number;
  readonly channels_closed: number;
  readonly agent_credentials_revoked: number;
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
   * Starts a browser session in a project.
   *
   * The organisation is not sent: it is the project's, and the control plane
   * resolves it. A caller that named one would be naming a second authority for
   * the same fact, and the only interesting case would be the two disagreeing.
   */
  async startBrowserSession(
    projectId: string,
    draft: BrowserSessionDraft,
  ): Promise<BrowserSession> {
    return request<BrowserSession>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/browser-sessions`,
      { method: "POST", body: JSON.stringify(draft) },
    );
  },

  /**
   * Pauses a session against the control epoch the caller last read.
   *
   * The epoch travels with the request because exactly one controller drives a
   * browser at a time (`docs/DESIGN_PRINCIPLES.md` §6). A stale one is refused
   * with `CONTROL_EPOCH_STALE` and never reaches the worker, so a page holding
   * an old number changes nothing by asking twice.
   */
  async pauseBrowserSession(sessionId: string, controlEpoch: number): Promise<BrowserSession> {
    return request<BrowserSession>(
      `/api/v1/browser-sessions/${encodeURIComponent(sessionId)}/pause`,
      { method: "POST", body: JSON.stringify({ control_epoch: controlEpoch }) },
    );
  },

  async resumeBrowserSession(sessionId: string, controlEpoch: number): Promise<BrowserSession> {
    return request<BrowserSession>(
      `/api/v1/browser-sessions/${encodeURIComponent(sessionId)}/resume`,
      { method: "POST", body: JSON.stringify({ control_epoch: controlEpoch }) },
    );
  },

  /**
   * Ends a session. Termination is not an epoch-authorised command — it takes
   * the browser away from whoever holds it — so it carries no epoch.
   */
  async terminateBrowserSession(
    sessionId: string,
    controlEpoch: number,
  ): Promise<BrowserSession> {
    // The epoch is required, like every other lifecycle change: ending a
    // browser somebody else now controls is not a lesser act than clicking in
    // it (`docs/API.md` §11).
    return request<BrowserSession>(
      `/api/v1/browser-sessions/${encodeURIComponent(sessionId)}/terminate`,
      { method: "POST", body: JSON.stringify({ control_epoch: controlEpoch }) },
    );
  },

  /** What has happened to one session, newest first. */
  async browserSessionTimeline(
    sessionId: string,
    limit = 20,
  ): Promise<BrowserSessionTimelineEntry[]> {
    return request<BrowserSessionTimelineEntry[]>(
      `/api/v1/browser-sessions/${encodeURIComponent(sessionId)}/timeline?limit=${String(limit)}`,
    );
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

  async publishedServices(projectId: string): Promise<PublishedService[]> {
    return request<PublishedService[]>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/published-services`,
    );
  },

  /**
   * Publishes a development service. The control plane asks the connector and
   * the gateway in turn, so the record this answers with may be `requested`
   * rather than `ready`; the caller reports what it was given rather than
   * assuming the route is carried.
   */
  async publishService(projectId: string, draft: PublishedServiceDraft): Promise<PublishedService> {
    return request<PublishedService>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/published-services`,
      { method: "POST", body: JSON.stringify(draft) },
    );
  },

  /** Revokes a route. The gateway is instructed before the record changes. */
  async revokePublishedService(serviceId: string): Promise<PublishedService> {
    return request<PublishedService>(
      `/api/v1/published-services/${encodeURIComponent(serviceId)}`,
      { method: "DELETE" },
    );
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

  /**
   * One finding (`docs/API.md` §13).
   *
   * A finding of another project is answered `RESOURCE_NOT_FOUND`, byte for
   * byte as an unknown identifier is, so the pair cannot be used to enumerate
   * the other.
   */
  async finding(findingId: string): Promise<Finding> {
    return request<Finding>(`/api/v1/findings/${encodeURIComponent(findingId)}`);
  },

  /**
   * The project's inbox, in every status.
   *
   * The endpoint answers with the live statuses alone when none is named, and a
   * review whose delivery was completed or dismissed would then be
   * indistinguishable from one that was never delivered at all. The statuses
   * are therefore listed explicitly, so an absent item means an absent item.
   */
  async inbox(projectId: string): Promise<InboxItem[]> {
    const statuses = ["pending", "acknowledged", "completed", "dismissed", "expired"]
      .map((status) => `status=${status}`)
      .join("&");
    return request<InboxItem[]>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/inbox?${statuses}`,
    );
  },

  async annotations(findingId: string): Promise<Annotation[]> {
    return request<Annotation[]>(
      `/api/v1/findings/${encodeURIComponent(findingId)}/annotations`,
    );
  },

  /**
   * Captures a screenshot to annotate (`docs/API.md` §11).
   *
   * `take_screenshot` is a **non-interactive system capture**, so a person
   * watching a session may take one without holding the interactive control
   * lease (`docs/SECURITY.md` §7). Stage 1 offers no human takeover, and this
   * is what makes annotating a live application possible without one.
   *
   * `full_page` is false deliberately. The annotation's geometry is normalised
   * to the artefact's content rectangle, and a viewport capture's content
   * rectangle is the viewport scaled by the device pixel ratio — the same
   * frame the human was looking at. A full-page capture is a different picture
   * of a different height, and a mark drawn on the frame would land somewhere
   * else on it.
   */
  async captureScreenshot(
    sessionId: string,
    controlEpoch: number,
  ): Promise<BrowserCommandOutcome> {
    return request<BrowserCommandOutcome>(
      `/api/v1/browser-sessions/${encodeURIComponent(sessionId)}/commands`,
      {
        method: "POST",
        body: JSON.stringify({
          control_epoch: controlEpoch,
          command: {
            command: "take_screenshot",
            take_screenshot: { full_page: false, purpose: "annotation" },
          },
        }),
      },
    );
  },

  /**
   * Takes the bounded accessibility snapshot an annotation is resolved
   * against (`docs/API.md` §11, ADR-0033).
   *
   * It is a system capture like the screenshot, and it is taken beside one so
   * that the elements it describes are the elements in the picture. Resolving
   * later, against a fresh snapshot, would answer about a page that has moved.
   */
  async captureSnapshot(
    sessionId: string,
    controlEpoch: number,
  ): Promise<BrowserCommandOutcome> {
    return request<BrowserCommandOutcome>(
      `/api/v1/browser-sessions/${encodeURIComponent(sessionId)}/commands`,
      {
        method: "POST",
        body: JSON.stringify({
          control_epoch: controlEpoch,
          command: { command: "snapshot", snapshot: {} },
        }),
      },
    );
  },

  /**
   * Creates a named review (`docs/API.md` §12).
   *
   * The slug is the durable handle an agent retrieves the review by, and it
   * must be unique among the project's active reviews. Nothing here decides
   * whether a value is acceptable: a second implementation of the rules would
   * eventually disagree with the one that enforces them, so the server refuses
   * and this surface reports what it said.
   *
   * The idempotency key is the form's own, minted once when the form is
   * opened. A double submit therefore returns the review the first submit
   * created rather than colliding with its own slug.
   */
  async createReview(
    projectId: string,
    draft: ReviewDraft,
    idempotencyKey?: string,
  ): Promise<Review> {
    return request<Review>(`/api/v1/projects/${encodeURIComponent(projectId)}/reviews`, {
      method: "POST",
      body: JSON.stringify(draft),
      ...(idempotencyKey === undefined
        ? {}
        : { headers: { "idempotency-key": idempotencyKey } }),
    });
  },

  /**
   * Creates a finding and its annotations in one request (`docs/API.md` §13).
   *
   * They travel together because a finding and the geometry that explains it
   * must never exist apart: a finding whose annotations failed to save would
   * be a report of a problem with no indication of where it is.
   */
  async createFinding(
    reviewId: string,
    draft: FindingDraft,
    idempotencyKey?: string,
  ): Promise<{ finding: Finding; annotations: Annotation[] }> {
    return request<{ finding: Finding; annotations: Annotation[] }>(
      `/api/v1/reviews/${encodeURIComponent(reviewId)}/findings`,
      {
        method: "POST",
        body: JSON.stringify(draft),
        ...(idempotencyKey === undefined
          ? {}
          : { headers: { "idempotency-key": idempotencyKey } }),
      },
    );
  },

  /** Assigns a review to an agent session, or clears the assignment (§12). */
  async assignReview(
    reviewId: string,
    expectedVersion: number,
    agentSessionId: string | null,
  ): Promise<Review> {
    return request<Review>(`/api/v1/reviews/${encodeURIComponent(reviewId)}/assign`, {
      method: "POST",
      body: JSON.stringify({
        expected_version: expectedVersion,
        ...(agentSessionId === null ? {} : { assigned_agent_session_id: agentSessionId }),
      }),
    });
  },

  /** Moves a review to another status by the route that fixes that status. */
  async transitionReview(
    reviewId: string,
    action: "request-review" | "accept" | "reopen" | "archive",
    expectedVersion: number,
    reason?: string,
  ): Promise<Review> {
    return request<Review>(`/api/v1/reviews/${encodeURIComponent(reviewId)}/${action}`, {
      method: "POST",
      body: JSON.stringify({
        expected_version: expectedVersion,
        // Required by the control plane for a reopen (ADR-0036). The field is
        // sent when it is there and never invented: a client that supplied a
        // placeholder would satisfy the rule and defeat it.
        ...(reason === undefined || reason.trim() === "" ? {} : { reason }),
      }),
    });
  },

  /** Every review of a project, with the search filters of `docs/UX_FLOWS.md` §16. */
  async searchReviews(projectId: string, filters: ReviewFilters): Promise<Review[]> {
    const query = new URLSearchParams();
    if (filters.q !== undefined && filters.q.trim() !== "") query.set("q", filters.q.trim());
    if (filters.status !== undefined && filters.status !== "") query.set("status", filters.status);
    if (filters.severity !== undefined && filters.severity !== "") {
      query.set("severity", filters.severity);
    }
    if (filters.branch !== undefined && filters.branch.trim() !== "") {
      query.set("branch", filters.branch.trim());
    }
    if (filters.commit !== undefined && filters.commit.trim() !== "") {
      query.set("commit", filters.commit.trim());
    }
    if (filters.createdSince !== undefined && filters.createdSince !== "") {
      query.set("created_since", filters.createdSince);
    }
    const suffix = query.toString();
    return request<Review[]>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/reviews${suffix === "" ? "" : `?${suffix}`}`,
    );
  },

  /**
   * Every verification a finding has accumulated, newest first, superseded and
   * decided records included (`docs/API.md` §13).
   *
   * A surface that showed only the current claim would make a
   * repeatedly-reopened finding look like a first attempt every time
   * (`docs/DOMAIN_MODEL.md` §19).
   */
  async findingVerifications(findingId: string): Promise<Verification[]> {
    return request<Verification[]>(
      `/api/v1/findings/${encodeURIComponent(findingId)}/verifications`,
    );
  },

  /**
   * One **named** verification with its assurance split (ADR-0031, ADR-0035).
   *
   * The comparison renders from this rather than from "latest", and the
   * identifier in the path is the one a decision then carries. That is the
   * whole point: a client cannot obtain the identifier of a claim it did not
   * render, so an accept naming one is an accept of evidence somebody looked
   * at.
   */
  async verificationReview(findingId: string, verificationId: string): Promise<VerificationReview> {
    return request<VerificationReview>(
      `/api/v1/findings/${encodeURIComponent(findingId)}/verifications/${encodeURIComponent(
        verificationId,
      )}`,
    );
  },

  /**
   * A human's decision about one finding (`docs/API.md` §13).
   *
   * `verificationId` is the claim the comparison was rendered from, and it
   * travels with the decision unchanged. **Nothing here re-reads the finding.**
   * A client that fetched the current version when the button was pressed would
   * send a version that matches whatever an agent has just written, which is
   * precisely the defect ADR-0035 exists to close; the caller passes what it
   * rendered and this function forwards it.
   */
  async decideFinding(
    findingId: string,
    action: "accept" | "reopen" | "wont-fix",
    decision: {
      readonly expectedVersion: number;
      readonly verificationId?: string | null;
      readonly reason?: string;
      readonly duplicateOfFindingId?: string;
    },
  ): Promise<Finding> {
    return request<Finding>(`/api/v1/findings/${encodeURIComponent(findingId)}/${action}`, {
      method: "POST",
      body: JSON.stringify({
        expected_version: decision.expectedVersion,
        ...(decision.verificationId === undefined || decision.verificationId === null
          ? {}
          : { verification_id: decision.verificationId }),
        ...(decision.reason === undefined || decision.reason.trim() === ""
          ? {}
          : { reason: decision.reason }),
        ...(decision.duplicateOfFindingId === undefined
          ? {}
          : { duplicate_of_finding_id: decision.duplicateOfFindingId }),
      }),
    });
  },

  /** Comments on one review, current revisions only (`docs/API.md` §12). */
  async reviewComments(reviewId: string): Promise<Comment[]> {
    return request<Comment[]>(`/api/v1/reviews/${encodeURIComponent(reviewId)}/comments`);
  },

  /** Comments on one finding, current revisions only (`docs/API.md` §13). */
  async findingComments(findingId: string): Promise<Comment[]> {
    return request<Comment[]>(`/api/v1/findings/${encodeURIComponent(findingId)}/comments`);
  },

  /**
   * Appends a comment. The body carries no author: attribution is derived from
   * the authenticated actor (`docs/DOMAIN_MODEL.md` §18).
   */
  async addComment(
    target: { readonly reviewId: string } | { readonly findingId: string },
    body: string,
  ): Promise<Comment> {
    const path =
      "findingId" in target
        ? `/api/v1/findings/${encodeURIComponent(target.findingId)}/comments`
        : `/api/v1/reviews/${encodeURIComponent(target.reviewId)}/comments`;
    return request<Comment>(path, { method: "POST", body: JSON.stringify({ body }) });
  },

  /**
   * Edits one annotation (`docs/API.md` §14). The edit appends a revision and
   * retains the one it supersedes; the screenshot underneath is untouched.
   */
  async updateAnnotation(
    annotationId: string,
    expectedRevision: number,
    change: {
      geometry?: AnnotationGeometry;
      label?: string;
      marker_number?: number;
      style_hint?: "default" | "critical" | "informational";
    },
  ): Promise<Annotation> {
    return request<Annotation>(`/api/v1/annotations/${encodeURIComponent(annotationId)}`, {
      method: "PATCH",
      body: JSON.stringify({ expected_revision: expectedRevision, ...change }),
    });
  },

  /**
   * Withdraws one annotation (`docs/API.md` §14). It records a revision
   * carrying `deleted_at` rather than deleting anything.
   */
  async withdrawAnnotation(annotationId: string, expectedRevision: number): Promise<Annotation> {
    return request<Annotation>(
      `/api/v1/annotations/${encodeURIComponent(annotationId)}?expected_revision=${String(
        expectedRevision,
      )}`,
      { method: "DELETE" },
    );
  },

  async artefact(artefactId: string): Promise<Artefact> {
    return request<Artefact>(`/api/v1/artefacts/${encodeURIComponent(artefactId)}`);
  },

  /**
   * The latest verification for a finding, or null.
   *
   * The viewer needs the after screenshot it names for the before-and-after
   * comparison of `docs/UX_FLOWS.md` section 17.
   */
  async findingVerification(findingId: string): Promise<Verification | null> {
    return request<Verification | null>(
      `/api/v1/findings/${encodeURIComponent(findingId)}/verification`,
    );
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

/**
 * The project event-stream WebSocket URL, on this same origin
 * (`docs/API.md` section 18.1).
 *
 * The resume position is not a query parameter: it travels in the
 * `stream.subscribe` message after the upgrade, so it never reaches an access
 * log or a proxy's URL history.
 */
export function eventsUrl(projectId: string): string {
  const scheme = globalThis.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${globalThis.location.host}/ws/v1/projects/${encodeURIComponent(projectId)}/events`;
}
