/**
 * Events, rendered as a history a person can read.
 *
 * The event record is the audit trail (`docs/EVENTS.md` section 2) and the
 * activity panel is that same record seen by a supervisor rather than an
 * auditor. This module is the mapping between them, and it is framework-free so
 * that the mapping can be proved without rendering anything.
 *
 * Three rules govern what may reach the screen.
 *
 * **Nothing is rendered from the payload that was not asked for by name.** A
 * timeline MUST NOT display secret values, cookies or authorisation headers
 * (`docs/SECURITY.md`, `docs/UX_FLOWS.md` section 18). Redaction is already
 * applied when the event is created, but an allow-list is the stronger
 * guarantee: a payload member added later cannot leak onto this surface by
 * default, because a member nobody named here is never read. `DETAIL_FIELDS`
 * is that list, and `describe` reads through it and through nothing else.
 *
 * **Page-derived text is labelled as page-derived** (ADR-0010). A URL, a page
 * title or a selector came from a browser rendering somebody else's
 * application. It is displayed as text, never as an anchor, and it carries a
 * marker saying where it came from, so a reader never mistakes an application's
 * words for the control plane's.
 *
 * **An unknown event type is named, not hidden.** New event types are added
 * within a protocol version and clients must tolerate the ones they do not
 * recognise. A row that says only `finding.retitled` and when it happened is
 * still a true row; dropping it would make the history silently incomplete,
 * which is exactly what the audit requirement forbids.
 */

import type { StreamedEvent } from "./events.ts";

/**
 * Which panel a row belongs in.
 *
 * The session room's Activity panel of `docs/UX_FLOWS.md` section 7 lists agent
 * actions, findings and comments as separate groups, so the category is decided
 * once here rather than by each surface re-reading the type prefix.
 */
export type TimelineCategory =
  | "agent_action"
  | "finding"
  | "comment"
  | "review"
  | "session"
  | "environment"
  | "system";

export const TIMELINE_CATEGORY_LABEL: Readonly<Record<TimelineCategory, string>> = {
  agent_action: "Agent action",
  finding: "Finding",
  comment: "Comment",
  review: "Review",
  session: "Browser session",
  environment: "Environment",
  system: "System",
};

/** One row of the history. Everything a surface renders is on this object. */
export interface TimelineEntry {
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  readonly occurredAt: string;
  readonly category: TimelineCategory;
  /** What happened, as a sentence. Never blank, never "an event occurred". */
  readonly summary: string;
  /** Who caused it, as words. Actor identity is never inferred from display text. */
  readonly actor: string;
  /**
   * Named payload members worth showing, already filtered. Each says whether it
   * came from the page, so the surface can label it without knowing the type.
   */
  readonly details: readonly TimelineDetail[];
  /** True when any detail is page-derived, so a row can carry one marker. */
  readonly pageDerived: boolean;
}

export interface TimelineDetail {
  readonly label: string;
  readonly value: string;
  /** ADR-0010: this text came from a rendered page and is not trustworthy. */
  readonly pageDerived: boolean;
}

interface Shape {
  readonly category: TimelineCategory;
  readonly summary: string;
}

/**
 * What each event type means, in the reader's terms.
 *
 * The sentences are written in the past tense and name the object, because a
 * history is read as a sequence of things that happened rather than as a list
 * of state names. Types absent from this table still render — see `shapeOf`.
 */
const SHAPES: Readonly<Record<string, Shape>> = {
  "browser_session.requested": { category: "session", summary: "A browser session was requested" },
  "browser_session.allocated": {
    category: "session",
    summary: "A browser worker accepted the session",
  },
  "browser_session.ready": { category: "session", summary: "The browser session became ready" },
  "browser_session.navigated": { category: "agent_action", summary: "The browser navigated" },
  "browser_session.paused": { category: "session", summary: "Agent browser input was paused" },
  "browser_session.resumed": { category: "session", summary: "Agent browser input resumed" },
  "browser_session.degraded": {
    category: "session",
    summary: "The browser session degraded; its worker stopped reporting",
  },
  "browser_session.failed": { category: "session", summary: "The browser session failed" },
  "browser_session.terminated": { category: "session", summary: "The browser session ended" },
  "browser_session.reconciled": {
    category: "session",
    summary: "The browser session was reconciled against its worker",
  },
  "browser.command_executed": { category: "agent_action", summary: "A browser command ran" },
  "browser.command_rejected": {
    category: "agent_action",
    summary: "A browser command was refused",
  },
  "browser.control_requested": { category: "session", summary: "Browser control was requested" },
  "browser.control_transferred": { category: "session", summary: "Browser control moved" },
  "browser.control_released": { category: "session", summary: "Browser control was released" },
  "browser.live_view_started": { category: "session", summary: "A viewer attached to the stream" },
  "browser.live_view_stopped": { category: "session", summary: "A viewer left the stream" },
  "review.created": { category: "review", summary: "A review was created" },
  "review.named": { category: "review", summary: "A review was named" },
  "review.assigned": { category: "review", summary: "A review was assigned to an agent" },
  "review.claimed": { category: "review", summary: "An agent claimed the review" },
  "review.status_changed": { category: "review", summary: "The review's status changed" },
  "review.status_change_denied": {
    category: "review",
    summary: "A review status change was refused",
  },
  "review.completion_evaluated": {
    category: "review",
    summary: "The review's completion gate was evaluated",
  },
  "review.accepted": { category: "review", summary: "A human accepted the review" },
  "review.reopened": { category: "review", summary: "The review was reopened" },
  "review.archived": { category: "review", summary: "The review was archived" },
  "review.comment_added": { category: "comment", summary: "A comment was added to the review" },
  "finding.created": { category: "finding", summary: "A finding was created" },
  "finding.annotated": { category: "finding", summary: "A finding was annotated" },
  "finding.claimed": { category: "finding", summary: "An agent claimed the finding" },
  "finding.resolved": { category: "finding", summary: "An agent reported the finding resolved" },
  "finding.reopened": { category: "finding", summary: "The finding was reopened" },
  "finding.status_changed": { category: "finding", summary: "The finding's status changed" },
  "finding.status_change_denied": {
    category: "finding",
    summary: "A finding status change was refused",
  },
  "finding.verification_submitted": {
    category: "finding",
    summary: "An agent submitted verification evidence",
  },
  "finding.comment_added": { category: "comment", summary: "A comment was added to the finding" },
  "published_service.requested": {
    category: "environment",
    summary: "A development service publication was requested",
  },
  "published_service.ready": {
    category: "environment",
    summary: "A development service became reachable",
  },
  "published_service.failed": {
    category: "environment",
    summary: "A development service publication failed",
  },
  "published_service.expired": {
    category: "environment",
    summary: "A development service route expired",
  },
  "published_service.revoked": {
    category: "environment",
    summary: "A development service route was revoked",
  },
  "connector.enrolled": { category: "environment", summary: "A connector was enrolled" },
  "connector.connected": { category: "environment", summary: "A connector connected" },
  "connector.degraded": { category: "environment", summary: "A connector stopped reporting" },
  "connector.disconnected": { category: "environment", summary: "A connector disconnected" },
  "connector.revoked": { category: "environment", summary: "A connector was revoked" },
  "workspace.observed": { category: "environment", summary: "A checkout was reported" },
  "workspace.head_changed": { category: "environment", summary: "A checkout's commit changed" },
  "artefact.upload_started": { category: "system", summary: "An artefact upload started" },
  "artefact.upload_completed": { category: "system", summary: "An artefact was stored" },
  "artefact.upload_failed": { category: "system", summary: "An artefact upload failed" },
  "artefact.access_granted": { category: "system", summary: "An artefact grant was minted" },
  "project.created": { category: "system", summary: "The project was created" },
  "project.updated": { category: "system", summary: "The project was updated" },
  "project.repository_changed": { category: "system", summary: "The project's repository changed" },
  "project.archived": { category: "system", summary: "The project was archived" },
};

/**
 * The only payload members that may be rendered, and whether each is page-derived.
 *
 * Adding a member here is a deliberate act. Anything absent is never read, so a
 * payload that later carries a header, a cookie or a token cannot reach this
 * surface by accident.
 */
const DETAIL_FIELDS: readonly {
  readonly key: string;
  readonly label: string;
  readonly pageDerived: boolean;
}[] = [
  { key: "url", label: "Address", pageDerived: true },
  { key: "title", label: "Page title", pageDerived: true },
  { key: "selector", label: "Selector", pageDerived: true },
  { key: "text", label: "Page text", pageDerived: true },
  { key: "command", label: "Command", pageDerived: false },
  { key: "kind", label: "Kind", pageDerived: false },
  { key: "status", label: "Status", pageDerived: false },
  { key: "from_status", label: "From", pageDerived: false },
  { key: "to_status", label: "To", pageDerived: false },
  { key: "reason", label: "Reason", pageDerived: false },
  { key: "error_class", label: "Refused as", pageDerived: false },
  { key: "severity", label: "Severity", pageDerived: false },
  { key: "slug", label: "Name", pageDerived: false },
  { key: "branch", label: "Branch", pageDerived: false },
  { key: "commit", label: "Commit", pageDerived: false },
  { key: "viewport", label: "Viewport", pageDerived: false },
  { key: "control_epoch", label: "Control epoch", pageDerived: false },
];

/** Longest a single detail may be before it is cut. Bounded, not trusted. */
const MAX_DETAIL_CHARS = 240;

function renderScalar(value: unknown): string | null {
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    // One level only, and only of scalars: a viewport is `{width, height}` and
    // reads better as `1440x900` than as two rows. Anything deeper is skipped
    // rather than serialised, because a serialised object is how a secret in an
    // unexpected member would reach a screen.
    const record = value as Record<string, unknown>;
    const width = record["width"];
    const height = record["height"];
    if (typeof width === "number" && typeof height === "number") {
      return `${String(width)}x${String(height)}`;
    }
    return null;
  }
  return null;
}

/**
 * The named members of a payload, in the order `DETAIL_FIELDS` declares.
 *
 * Order is fixed rather than payload-defined so that two events of the same type
 * read the same way, and so a test can assert on a row without depending on
 * JSON member order.
 */
export function describe(payload: Readonly<Record<string, unknown>>): readonly TimelineDetail[] {
  const details: TimelineDetail[] = [];
  for (const field of DETAIL_FIELDS) {
    const rendered = renderScalar(payload[field.key]);
    if (rendered === null) continue;
    details.push({
      label: field.label,
      value:
        rendered.length > MAX_DETAIL_CHARS
          ? `${rendered.slice(0, MAX_DETAIL_CHARS)}…`
          : rendered,
      pageDerived: field.pageDerived,
    });
  }
  return details;
}

/**
 * The shape of an event type, falling back to one derived from its name.
 *
 * The fallback keeps an unrecognised type readable: the category comes from the
 * prefix, which is stable across the vocabulary, and the summary is the type
 * itself. That is less than a written sentence and more than nothing.
 */
export function shapeOf(type: string): Shape {
  const known = SHAPES[type];
  if (known !== undefined) return known;
  const prefix = type.split(".")[0] ?? "";
  const category: TimelineCategory =
    prefix === "finding"
      ? "finding"
      : prefix === "review"
        ? "review"
        : prefix === "browser" || prefix === "browser_session"
          ? "session"
          : prefix === "connector" || prefix === "workspace" || prefix === "published_service"
            ? "environment"
            : "system";
  return { category, summary: type };
}

/**
 * Who caused an event, as words.
 *
 * `docs/EVENTS.md` section 5 forbids inferring actor identity from display text,
 * so the actor *type* is always stated and the display, when there is one, is
 * additional rather than a replacement. "agent session claude-1" says what
 * "claude-1" alone does not.
 */
export function actorLabel(actor: StreamedEvent["actor"]): string {
  const kind = actor.type.replaceAll("_", " ");
  const display = actor.display ?? actor.id;
  return display === undefined || display === "" ? kind : `${kind} ${display}`;
}

/** One event as one row. */
export function toTimelineEntry(event: StreamedEvent): TimelineEntry {
  const shape = shapeOf(event.type);
  const details = describe(event.payload);
  return {
    id: event.id,
    sequence: event.sequence,
    type: event.type,
    occurredAt: event.occurred_at,
    category: shape.category,
    summary: shape.summary,
    actor: actorLabel(event.actor),
    details,
    pageDerived: details.some((detail) => detail.pageDerived),
  };
}

/**
 * How many rows a surface keeps.
 *
 * The panel is a window on a durable record, not a copy of it. A viewer left
 * open for a day must not grow without bound, and the full history is one HTTP
 * request away, so the newest rows win and the rest are dropped.
 */
export const MAX_TIMELINE_ROWS = 200;

/**
 * Merges an event into a history, newest first, bounded.
 *
 * A duplicate sequence replaces rather than appends: a resume that overlaps by
 * one event must not show that event twice.
 */
export function mergeEntry(
  history: readonly TimelineEntry[],
  entry: TimelineEntry,
  limit = MAX_TIMELINE_ROWS,
): readonly TimelineEntry[] {
  const without = history.filter((existing) => existing.id !== entry.id);
  const next = [entry, ...without].sort((left, right) => right.sequence - left.sequence);
  return next.length > limit ? next.slice(0, limit) : next;
}

/**
 * The supervision status of `docs/UX_FLOWS.md` section 3.
 *
 * Section 3 names five — active, waiting, blocked, paused, disconnected — and
 * the domain has nine (`docs/DOMAIN_MODEL.md` section 12). The mapping is here,
 * once, rather than in each card: a session is *waiting* while the deployment is
 * still finding it a browser, *active* once a browser is answering, *paused*
 * when input is suspended, *blocked* when it has failed and can go no further
 * without a person, and *disconnected* when the worker carrying it has stopped
 * reporting or the session has gone.
 */
export type FleetStatus = "active" | "waiting" | "blocked" | "paused" | "disconnected";

const FLEET_STATUS: Readonly<Record<string, FleetStatus>> = {
  REQUESTED: "waiting",
  ALLOCATING: "waiting",
  READY: "active",
  ACTIVE: "active",
  PAUSED: "paused",
  DEGRADED: "disconnected",
  TERMINATING: "disconnected",
  TERMINATED: "disconnected",
  FAILED: "blocked",
};

/**
 * The status word, its shape and its explanation — never colour alone.
 *
 * `docs/UX_FLOWS.md` sections 12 and 19 forbid colour as the only means of
 * identification, so every caller gets a word and a mark and can decide
 * separately whether to add a colour.
 */
export interface StatusLabel {
  readonly status: FleetStatus;
  /** The word a reader sees. */
  readonly word: string;
  /** A non-colour mark, so two statuses differ in a greyscale screenshot. */
  readonly mark: string;
  /** Why the session is in this state, in one sentence. */
  readonly explanation: string;
  /** The underlying domain status, always stated so nothing is hidden by the map. */
  readonly domainStatus: string;
}

const STATUS_TEXT: Readonly<
  Record<FleetStatus, { readonly word: string; readonly mark: string; readonly explanation: string }>
> = {
  active: {
    word: "Active",
    mark: "●",
    explanation: "A central Chromium is answering for this session.",
  },
  waiting: {
    word: "Waiting",
    mark: "◐",
    explanation: "The deployment is still allocating a browser for this session.",
  },
  blocked: {
    word: "Blocked",
    mark: "■",
    explanation:
      "The session cannot go further without a person. Evidence already captured is unaffected.",
  },
  paused: {
    word: "Paused",
    mark: "▮",
    explanation: "Agent browser input is suspended. The browser is still allocated.",
  },
  disconnected: {
    word: "Disconnected",
    mark: "○",
    explanation:
      "The worker carrying this session has stopped reporting, or the session has ended.",
  },
};

export function statusLabel(domainStatus: string): StatusLabel {
  const status = FLEET_STATUS[domainStatus] ?? "disconnected";
  const text = STATUS_TEXT[status];
  return { status, domainStatus, ...text };
}
