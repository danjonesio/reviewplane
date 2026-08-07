/**
 * The tool catalogue (`docs/MCP_SPEC.md` sections 7.1, 7.2, 7.4, 7.6, 7.7, 7.8).
 *
 * The set is exactly `MESSAGE_TYPE_VALUES` from the schema, which is what
 * section 14 calls the tool availability set. Nothing else is registered, so a
 * client discovers the boundary from `tools/list` rather than from a refusal:
 * there is no browser lifecycle or interaction tool, no visual inspection, and
 * — the one that matters most — **no secret tool at all**. The
 * published-service tools of section 7.2 joined the set with RVP-24; they take
 * no connector and no browser-session argument, because a caller that could
 * name either would be choosing which development machine the central browser
 * reaches (`src/development-services.ts`). The completion gate of section 7.8
 * joined it with RVP-53: `task_validation_status` reads, `task_complete`
 * records its own evaluation, and **neither moves a review or a finding and
 * neither terminates the agent**.
 *
 * Every state-changing tool goes through the same four gates, in this order:
 *
 *   1. the generated validator for its arguments, so a malformed call is
 *      refused before any domain code runs and the client was told the same
 *      schema the server enforces;
 *   2. the capability the credential must carry, read from the session rather
 *      than the credential so a session cannot widen mid-flight;
 *   3. the idempotency key, claimed before the work runs, so a retry produces
 *      one record rather than two (`docs/TESTING.md` section 11);
 *   4. the domain, which owns the authority and concurrency rules and refuses
 *      in the same vocabulary the agent sees.
 */

import { randomUUID } from "node:crypto";

import type {
  BrowserCommand,
  BrowserCommandResult,
  ControllerIdentity,
  KeyName,
  ScrollDirection,
  WaitCondition,
  WaitUntil,
} from "@reviewplane/protocol/browser";
import {
  MESSAGE_TYPE_VALUES,
  PAYLOAD_MAX_BYTES,
  type AgentCapability,
  type ArtefactLink,
  type BrowserCommandName,
  type BrowserInteractionResult,
  type BrowserNavigationView,
  type BrowserSessionDetail,
  type BrowserSnapshotView,
  type FindingView,
  type MessageType,
  type SchemaViolation,
  type TrustLabel,
  type Viewport,
} from "@reviewplane/protocol/mcp";
import {
  validateAgentInboxAcknowledgeInput,
  validateAgentInboxListInput,
  validateAgentSessionStatusInput,
  validateDevelopmentServicePublishInput,
  validateDevelopmentServiceUnpublishInput,
  validateDevelopmentServicesListInput,
  validateBrowserElementInput,
  validateBrowserNavigateInput,
  validateBrowserPressKeyInput,
  validateBrowserResizeInput,
  validateBrowserScrollInput,
  validateBrowserSelectOptionInput,
  validateBrowserSessionAllocateInput,
  validateBrowserSessionControlInput,
  validateBrowserSessionReferenceInput,
  validateBrowserSessionStartInput,
  validateBrowserSnapshotInput,
  validateBrowserTakeScreenshotInput,
  validateBrowserTypeInput,
  validateBrowserWaitInput,
  validateFindingAddCommentInput,
  validateFindingClaimInput,
  validateFindingGetInput,
  validateFindingMarkBlockedInput,
  validateFindingSubmitVerificationInput,
  validateFindingUpdateStatusInput,
  validateProjectCurrentInput,
  validateReviewAddCommentInput,
  validateReviewClaimInput,
  validateReviewGetInput,
  validateReviewListInput,
  validateReviewSearchInput,
  validateReviewUpdateStatusInput,
  validateTaskCompleteInput,
  validateTaskValidationStatusInput,
} from "@reviewplane/protocol/mcp";
import {
  ApiError,
  agentActor,
  aggregateCompletionResult,
  aggregateMissing,
  assuranceFor,
  missingEvidence,
  nextActions,
  type BrowserSessionRecord,
  type CompletionRequirements,
  type ErrorCode,
  type EvidenceAssurance,
  type FindingCompletionState,
  agentTransitionsFrom,
  isHumanReservedStatus,
  requestDigest,
  type InboxItemStatus,
  type ReviewListFilter,
} from "@reviewplane/server/domain";

import { STAGE_1_POLICY, type McpConnection, type McpServices } from "./context.ts";
import {
  DEFAULT_ROUTE_TTL_SECONDS,
  scopeOf,
  toDevelopmentServiceView,
} from "./development-services.ts";
import { Warnings, refusalFrom, successEnvelope } from "./envelope.ts";
import { toolInputDescription, toolInputSchema, toolResultDescription } from "./schemas.ts";
import {
  BoundedPayload,
  decodeCursor,
  encodeCursor,
  toAnnotationView,
  toArtefactLink,
  toCommentView,
  toFindingView,
  toInboxItemView,
  toReviewView,
  toVerificationView,
  trustFor,
  type ViewContext,
} from "./views.ts";

type Validator = (value: unknown, path: string, out: SchemaViolation[]) => void;

export interface ToolRun {
  readonly data: unknown;
  readonly trust: TrustLabel;
}

export interface ToolContext {
  readonly connection: McpConnection;
  readonly services: McpServices;
  /** The identifier this call is recorded under, echoed in the envelope. */
  readonly requestId: string;
  readonly warnings: Warnings;
  readonly views: ViewContext;
}

interface ToolDefinition {
  readonly name: MessageType;
  readonly title: string;
  readonly capability: AgentCapability;
  /**
   * Whether the tool writes a durable record. Such a tool requires an
   * idempotency key, claimed before the work runs, so a retry produces one
   * record rather than two.
   *
   * The browser interaction tools of `docs/MCP_SPEC.md` §7.4 are `false` and it
   * is not an oversight: they change a browser rather than a record, and their
   * schemas declare no key. A key is what makes a retry return the *first*
   * result, and there is no honest first result to return — the page has
   * already moved, so replaying a stored answer would describe a page that no
   * longer exists. `docs/MCP_SPEC.md` §10 asks for a key "when retries can
   * occur"; here a retry is a second click, and saying so is better than
   * pretending the second one did not happen.
   */
  readonly stateChanging: boolean;
  readonly validate: Validator;
  /**
   * Where this tool names a record whose status it would move, for the
   * authority audit below. A tool without one cannot express a transition at
   * all, so there is nothing for it to be refused for.
   */
  readonly authority?: {
    readonly kind: "review" | "finding";
    readonly idField: string;
  };
  readonly run: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolRun>;
}

/** Default bound for a browser command, inside the session's own maximum. */
const SCREENSHOT_TIMEOUT_MS = 30000;

/**
 * Viewport a session starts at when the caller names none.
 *
 * The first of `AGENTS.md` "Browser-facing work". A default that was not one of
 * the required validation viewports would produce evidence at a size nobody
 * asked to be checked.
 */
const DEFAULT_VIEWPORT: Viewport = { width: 1440, height: 900, device_scale_factor: 1 };

/** The rendered-snapshot bound of the MCP schema (`docs/MCP_SPEC.md` §13). */
const SNAPSHOT_TEXT_MAX_CHARS = 32768;

/**
 * Share of an interaction tool's byte bound a rendered snapshot may occupy.
 *
 * The browser protocol lets a worker return 65536 characters and the MCP
 * snapshot view permits 32768, but neither is the operative limit: the response
 * bound is measured on the *encoded* payload, and a snapshot is newline-heavy,
 * so JSON escaping can nearly double it. Bounding the text against the encoded
 * size rather than the character count is what stops a legitimate page becoming
 * a thrown `McpResponseEncodeError` — the failure mode `docs/MCP_SPEC.md` §13
 * records as an outage with a byte count attached.
 */
const SNAPSHOT_TEXT_BUDGET = 0.75;

function decode(validate: Validator, args: unknown): Record<string, unknown> {
  const violations: SchemaViolation[] = [];
  validate(args ?? {}, "$", violations);
  if (violations.length === 0) return (args ?? {}) as Record<string, unknown>;
  const first = violations[0] as SchemaViolation;
  throw new ApiError("UNSUPPORTED_CAPABILITY", `${first.path} ${first.message}`, {
    field: first.path,
  });
}

/**
 * Audits an attempt to name a status the authority rules reserve to a human,
 * and answers it in the vocabulary the documents promise.
 *
 * The agent-facing status enumerations do not contain `RESOLVED`, `WONT_FIX`,
 * `DUPLICATE` or `ACCEPTED` (ADR-0020), so a request naming one is refused by
 * the generated validator before any domain code runs. That structural denial
 * is the stronger control and it stays — but on its own it produced two defects
 * that only showed up when somebody drove a real client at it.
 *
 * The attempt left **no trace**. `docs/DOMAIN_MODEL.md` section 15 requires
 * every refused transition to be audited, and says why: "an attempt with no
 * record is indistinguishable from one that never happened, and the Stage 1
 * exit criterion is that the attempt leaves a trail". The domain layer writes
 * that record for the refusals it raises, and it never saw this one. So the
 * single attempt an auditor goes looking for — *did an agent try to accept a
 * human's finding?* — was the one attempt nothing recorded.
 *
 * And the code was wrong. `docs/MCP_SPEC.md` section 7.7 promises
 * `AUTHORISATION_DENIED` for exactly this case; an unrecognised enumeration
 * member produces `UNSUPPORTED_CAPABILITY`, which tells an agent its client is
 * out of date rather than that it asked for something only a human may decide.
 *
 * This runs on the refusal path only, and only for the reserved statuses, so
 * the ordinary "that is not a status" refusal is unchanged. The reserved set is
 * read from the domain (`isHumanReservedStatus`), which reads it from
 * `packages/protocol`, so this layer holds no second list to drift (ADR-0024).
 */
async function auditReservedStatusAttempt(
  tool: ToolDefinition,
  args: unknown,
  context: ToolContext,
  refusal: unknown,
): Promise<unknown> {
  const authority = tool.authority;
  if (authority === undefined) return refusal;
  if (!(refusal instanceof ApiError) || refusal.code !== "UNSUPPORTED_CAPABILITY") return refusal;
  const supplied = (args ?? {}) as Record<string, unknown>;
  const requested = supplied["status"];
  const recordId = supplied[authority.idField];
  if (typeof requested !== "string" || !isHumanReservedStatus(requested)) return refusal;
  if (typeof recordId !== "string" || recordId === "") return refusal;

  const message =
    authority.kind === "finding"
      ? `A finding cannot be set to ${requested} by an agent. A final disposition is a human decision; submit verification and mark the finding AWAITING_HUMAN_REVIEW instead.`
      : `A review cannot be set to ${requested} by an agent. Accepting, cancelling or archiving a review disposes of the feedback it carries, which is a human decision.`;

  await context.services.reviews.recordTransitionDenied(
    context.connection.scope,
    {
      kind: authority.kind,
      id: recordId,
      requested,
      code: "AUTHORISATION_DENIED",
      reason: message,
    },
    agentActor(context.connection.session, context.connection.client.name),
  );
  return new ApiError("AUTHORISATION_DENIED", message, { field: "status" });
}

/**
 * The trust label an inbox response carries.
 *
 * An item's title is the review's or the finding's, and both are human-authored
 * in the ordinary case. A `finding_reopened` item about an **agent**-authored
 * finding is not: that finding's title came from a page, so the response
 * carries page-derived bytes and must say so (ADR-0010). No tool creates an
 * agent-authored finding yet, so this returns the trusted label in practice —
 * which is the point of deriving it rather than asserting it.
 */
function inboxTrust(items: readonly { readonly finding_source: string | null }[]): TrustLabel {
  const pageDerived = items.some((item) => item.finding_source === "agent");
  return trustFor({ pageDerived, humanAuthored: true });
}

/** The review named by an immutable identifier or a project-scoped slug. */
async function resolveReview(selector: string, context: ToolContext) {
  const { services, connection } = context;
  const byId = await services.reviews.getReview(connection.scope, selector).catch(() => null);
  if (byId !== null) return byId;
  // The slug lookup is filtered by project, so a slug that exists only in
  // another project is not found here. No cross-project search happens, which
  // is what docs/MCP_SPEC.md section 7.6 forbids.
  return services.reviews.getReviewBySlug(connection.scope, selector);
}

async function findingWithLinks(
  finding: Awaited<ReturnType<McpServices["reviews"]["getFinding"]>>,
  context: ToolContext,
  role: string | null,
): Promise<{ view: FindingView; link: ArtefactLink | null }> {
  const view = toFindingView(finding, context.views);
  const link = await toArtefactLink(finding.screenshot_artefact_id, role, context.views);
  return { view, link };
}

// ---------------------------------------------------------------- browser

/**
 * The browser session an argument named, when this agent session may act on it.
 *
 * `null` means the caller is not entitled to know: the identifier is unknown,
 * or it names a session in another project. Both are `RESOURCE_NOT_FOUND`, and
 * this deliberately does **not** raise it — the domain does. `runCommand`
 * records a cross-project attempt against the **actor's** project stream with
 * `cross_project: true`, and a refusal produced here first would leave exactly
 * the attempt an auditor goes looking for unrecorded. The refusal the service
 * raises is byte for byte the one an unknown identifier earns, so deferring
 * costs the caller nothing.
 *
 * The ownership check is the one thing this layer must still do, and it runs
 * **only after** the project matches. A session in another project that happens
 * to belong to another agent session must not earn `AUTHORISATION_DENIED`: that
 * answer says "it exists, but not for you", which is the enumeration
 * `docs/API.md` §5 forbids.
 */
async function browserSessionIfPermitted(
  browserSessionId: string,
  context: ToolContext,
): Promise<BrowserSessionRecord | null> {
  const { connection, services } = context;
  // `getForScope`, not `get()`. This read the session unscoped and then compared
  // `project_id` in an `if`, with **no organisation term at all** — the shape
  // `docs/SECURITY.md` §7 forbids, which requires every term in one `WHERE` and
  // a row "never returned and then rejected by a later branch". It was sound
  // only because a project identifier implies its organisation, which is a fact
  // about other code (ADR-0037). A second shape for "resolve a session in the
  // caller's scope" is how the wrong one gets copied, so there is now one.
  const record = await services.browserSessions
    .getForScope(browserSessionId, scopeOf(connection))
    .catch(() => null);
  if (record === null) return null;
  if (record.agent_session_id !== null && record.agent_session_id !== connection.session.id) {
    throw new ApiError(
      "AUTHORISATION_DENIED",
      "This browser session belongs to a different agent session.",
    );
  }
  return record;
}

/**
 * The same, for a tool with no domain call behind it to defer the refusal to.
 *
 * `browser_session_status` reads a record and answers; there is no command for
 * the service to refuse and audit, so this layer raises the refusal itself, in
 * the same words.
 */
async function requireBrowserSession(
  browserSessionId: string,
  context: ToolContext,
): Promise<BrowserSessionRecord> {
  const record = await browserSessionIfPermitted(browserSessionId, context);
  if (record === null) throw new ApiError("RESOURCE_NOT_FOUND", "The browser session was not found.");
  return record;
}

/** The controller an agent session acts as for an interactive command (ADR-0007). */
function agentController(context: ToolContext): ControllerIdentity {
  return { type: "agent", id: context.connection.session.id };
}

/**
 * The controller a non-interactive capture is issued as.
 *
 * A snapshot and a screenshot are the two `system_capture_commands` of the
 * browser protocol: `docs/SECURITY.md` §7 admits them without the interactive
 * lease, and `docs/TESTING.md` §5 requires that issuing one never transfers or
 * revokes it. Presenting the *system* controller is what makes both true, and
 * it is why a capture must not be issued as the lease holder — a tool that sent
 * `record.current_controller` would be acting in the name of whoever holds the
 * lease, which is impersonation whether or not the command is harmless.
 *
 * The identity is derived from the agent session so the audit trail still names
 * who captured, and it is derived rather than accepted: no argument reaches it.
 */
function captureController(context: ToolContext): ControllerIdentity {
  return { type: "system", id: `sys_${context.connection.session.id}` };
}

/**
 * The bounds a command is built against when the session is not this caller's.
 *
 * Such a command is refused by the service before it is sent anywhere, so these
 * numbers are never applied to a browser. They exist so that building the
 * command does not require reading limits out of a record the caller may not
 * see.
 */
const FOREIGN_SESSION_LIMITS = { default_timeout_ms: 30000, max_command_timeout_ms: 120000 };

/**
 * The bound one command runs under: the caller's, or the session's default,
 * and never beyond the session's own maximum.
 *
 * Clamping rather than refusing is right here and wrong for a route lifetime
 * (`docs/MCP_SPEC.md` §7.2 refuses an over-long TTL). A shortened route makes an
 * agent believe it has access it does not have; a shortened command timeout
 * makes it wait less than it asked and then read `BROWSER_COMMAND_TIMEOUT`,
 * which is the truthful answer either way.
 */
function commandTimeout(
  args: Record<string, unknown>,
  limits: { readonly default_timeout_ms: number; readonly max_command_timeout_ms: number },
): number {
  const requested = (args["timeout_ms"] as number | undefined) ?? limits.default_timeout_ms;
  return Math.min(Math.max(requested, 100), limits.max_command_timeout_ms);
}

/**
 * The URL the control plane last saw this browser settle on.
 *
 * It is read from the event stream rather than from a column because the
 * control plane keeps no such column: `browser_session.navigated` is written in
 * the same transaction as the command that caused it (`docs/EVENTS.md` §9), so
 * the timeline is the record. Nothing else would be — a second copy on the
 * session row could disagree with the audit trail.
 *
 * The read is bounded, so a session that has issued more than 200 events since
 * its last navigation reports no URL. Absent means "the control plane does not
 * know", which is the honest answer; it never means "about:blank".
 */
async function lastNavigatedUrl(
  record: BrowserSessionRecord,
  context: ToolContext,
): Promise<string | null> {
  const timeline = await context.services.browserSessions.timeline(
    record.id,
    context.connection.project.id,
    200,
  );
  for (const entry of timeline) {
    if (entry.type !== "browser_session.navigated") continue;
    const url = entry.payload["url"];
    if (typeof url === "string" && url !== "") return url;
  }
  return null;
}

/**
 * One browser session as an agent sees it.
 *
 * `includeUrl` is a deliberate per-tool decision rather than a convenience.
 * The URL a browser settled on is page-derived, so a view carrying one obliges
 * the untrusted label on the whole response (ADR-0010) — and the codec enforces
 * that, refusing a `session.url` under a trusted label on the way out. Only
 * `browser_session_status` asks for it, because §7.3 says that tool returns the
 * URL; starting, pausing, resuming and ending a session are control-plane facts
 * about a lease and a lifecycle, and labelling those four untrusted would tell
 * an agent to distrust the epoch it has to present on its next command.
 *
 * The view carries no route capability and no origin credential. It carries the
 * origin, which is the address, and never the bearer token that opens it: the
 * capability is minted by the control plane and never leaves it
 * (`docs/ARCHITECTURE.md` §7.3).
 */
async function toBrowserSessionView(
  record: BrowserSessionRecord,
  context: ToolContext,
  options: { readonly includeUrl: boolean },
): Promise<BrowserSessionDetail> {
  const url = options.includeUrl ? await lastNavigatedUrl(record, context) : null;
  const liveView =
    context.connection.serverCapabilities.browser_live &&
    record.ended_at === null &&
    (record.status === "READY" || record.status === "ACTIVE" || record.status === "PAUSED");
  return {
    browser_session_id: record.id,
    status: record.status,
    control_epoch: record.control_epoch,
    ...(record.current_controller === null
      ? {}
      : {
          current_controller: {
            type: record.current_controller.type,
            id: record.current_controller.id,
          },
        }),
    viewport: record.viewport,
    // ADR-0001 fixes Chromium, and the schema's enumeration says so. A worker
    // that reported anything else is omitted rather than asserted.
    ...(record.browser_type === "chromium" ? { browser_type: "chromium" as const } : {}),
    ...(record.browser_version === null ? {} : { browser_version: record.browser_version }),
    ...(record.published_service_id === null
      ? {}
      : { published_service_id: record.published_service_id }),
    ...(record.service_origin === null ? {} : { service_origin: record.service_origin }),
    ...(url === null ? {} : { url }),
    live_view_available: liveView,
    created_at: record.created_at,
    ...(record.ended_at === null ? {} : { ended_at: record.ended_at }),
  };
}

/**
 * Sends one command and converts a refused result into the refusal the agent
 * reads.
 *
 * A `BrowserCommandResult` that reports `ok: false` is a completed exchange
 * carrying a stable code, so it becomes an `ApiError` with that same code
 * rather than a new one: a refusal that started at the worker reaches the agent
 * without being renamed, which is the property the shared error enumeration
 * exists for (`docs/MCP_SPEC.md` §12). `current_epoch` is carried across because
 * `CONTROL_EPOCH_STALE` is useless without it.
 */
async function runBrowserCommand(
  args: Record<string, unknown>,
  context: ToolContext,
  build: (limits: typeof FOREIGN_SESSION_LIMITS) => BrowserCommand,
  controller: ControllerIdentity,
): Promise<{
  readonly result: BrowserCommandResult;
  readonly controlEpoch: number;
}> {
  const { connection, services } = context;
  const browserSessionId = args["browser_session_id"] as string;
  const controlEpoch = args["control_epoch"] as number;
  // `null` is a session this caller may not see. The command is built anyway
  // and handed to the service, which refuses it and records the attempt; the
  // bounds it is built with are never applied to a browser.
  const record = await browserSessionIfPermitted(browserSessionId, context);
  const result = await services.browserSessions.runCommand({
    browserSessionId,
    // The **actor's** project, never the session's. Passing the session's own
    // would make the comparison inside the service compare a value with itself.
    projectId: connection.project.id,
    controller,
    controlEpoch,
    command: build(record?.limits ?? FOREIGN_SESSION_LIMITS),
    actor: agentActor(connection.session, connection.client.name),
  });
  if (!result.ok) {
    const error = result.error;
    throw new ApiError(
      (error?.code ?? "INTERNAL_ERROR") as ErrorCode,
      error?.message ?? "The browser command did not complete.",
      error?.current_epoch === undefined ? undefined : { current_epoch: error.current_epoch },
    );
  }
  return { result, controlEpoch };
}

/**
 * A worker's snapshot as the bounded, page-derived view an agent receives.
 *
 * The text is truncated against the encoded size and the truncation is
 * *reported*: a snapshot that silently lost its second half would have an agent
 * conclude an element is absent from a page that contains it.
 */
function toSnapshotView(
  snapshot: NonNullable<BrowserCommandResult["snapshot"]>,
  tool: MessageType,
  context: ToolContext,
): BrowserSnapshotView {
  const budget = Math.floor(PAYLOAD_MAX_BYTES[tool] * SNAPSHOT_TEXT_BUDGET);
  let text = snapshot.text.slice(0, SNAPSHOT_TEXT_MAX_CHARS);
  let truncated = snapshot.truncated || text.length < snapshot.text.length;
  while (text.length > 0 && Buffer.byteLength(JSON.stringify(text), "utf8") > budget) {
    text = text.slice(0, Math.floor(text.length * 0.9));
    truncated = true;
  }
  if (truncated && !snapshot.truncated) {
    context.warnings.add(
      "text_truncated",
      "The page described more than this response may carry, so the snapshot is a summary.",
      "Narrow the page, or ask for a smaller max_nodes and work through the page in parts.",
    );
  }
  return {
    snapshot_id: snapshot.snapshot_id,
    viewport: snapshot.viewport,
    node_count: snapshot.node_count,
    truncated,
    text,
  };
}

function toNavigationView(
  navigation: NonNullable<BrowserCommandResult["navigation"]>,
): BrowserNavigationView {
  return {
    url: navigation.url,
    ...(navigation.http_status === undefined ? {} : { http_status: navigation.http_status }),
    redirected: navigation.redirected,
    title: navigation.title,
  };
}

/**
 * The payload every interaction tool answers with.
 *
 * It always names the session, the command and the epoch the command ran under,
 * so an agent can tell a result it asked for from one it inherited. The epoch
 * reported is the one the caller presented rather than the one the worker
 * echoed: the two are equal by construction, because a mismatch is refused
 * before the command leaves the control plane, and the presented value is the
 * one the schema bounds to a real epoch.
 */
function toInteractionResult(input: {
  readonly tool: MessageType;
  readonly command: BrowserCommandName;
  readonly browserSessionId: string;
  readonly controlEpoch: number;
  readonly result: BrowserCommandResult;
  readonly context: ToolContext;
}): BrowserInteractionResult {
  const { result } = input;
  const viewport = result.viewport ?? result.snapshot?.viewport;
  return {
    browser_session_id: input.browserSessionId,
    command: input.command,
    control_epoch: input.controlEpoch,
    duration_ms: result.duration_ms,
    ...(viewport === undefined ? {} : { viewport }),
    ...(result.navigation === undefined
      ? {}
      : { navigation: toNavigationView(result.navigation) }),
    ...(result.snapshot === undefined
      ? {}
      : { snapshot: toSnapshotView(result.snapshot, input.tool, input.context) }),
  };
}

/**
 * The trust label an interaction response carries.
 *
 * Derived from what the result turned out to contain, not from which tool
 * produced it: a click that returns only its own duration carries nothing from
 * the page, and labelling it untrusted would make the label mean "a browser was
 * involved" rather than "these bytes came from a page". The two exceptions are
 * the tools whose entire purpose is to return page content — a navigation and a
 * snapshot are untrusted whatever a worker returned, so an empty answer from
 * one cannot be read as a trusted one.
 */
function interactionTrust(tool: MessageType, payload: BrowserInteractionResult): TrustLabel {
  if (tool === "browser_navigate" || tool === "browser_snapshot") {
    return "untrusted_browser_content";
  }
  return payload.navigation !== undefined || payload.snapshot !== undefined
    ? "untrusted_browser_content"
    : "trusted_control_plane";
}

/**
 * The shared body of the interaction tools.
 *
 * `controller` is a parameter rather than a default because the choice is the
 * security decision: the eight interactive commands are issued as the agent and
 * require its lease, and a snapshot is issued as the system controller, which
 * the matrix admits without the lease and which cannot take it away.
 */
async function interactionRun(
  tool: MessageType,
  command: BrowserCommandName,
  args: Record<string, unknown>,
  context: ToolContext,
  build: (limits: typeof FOREIGN_SESSION_LIMITS) => BrowserCommand,
  controller: ControllerIdentity,
): Promise<ToolRun> {
  const { result, controlEpoch } = await runBrowserCommand(args, context, build, controller);
  const payload = toInteractionResult({
    tool,
    command,
    browserSessionId: args["browser_session_id"] as string,
    controlEpoch,
    result,
    context,
  });
  return { trust: interactionTrust(tool, payload), data: payload };
}

const TOOLS: readonly ToolDefinition[] = [
  {
    name: "project_current",
    title: "Current project, workspace and policy",
    capability: "project:read",
    stateChanging: false,
    validate: validateProjectCurrentInput,
    async run(_args, context) {
      const { connection } = context;
      const { requirements } = await context.services.reviews.completionRequirements(
        connection.scope,
      );
      const workspace =
        connection.workspace === null
          ? null
          : await context.services.workspaces.get(
              connection.workspace.id,
              connection.scope.organisationId,
            );
      if (workspace === null) {
        context.warnings.add(
          "workspace_unresolved",
          "No workspace is registered for this project, so the branch and commit of a verification cannot be corroborated.",
          "Register the workspace through the control-plane API, or the connector once Stage 1 lands.",
        );
      }
      return {
        trust: "trusted_project_configuration",
        data: {
          project: {
            id: connection.project.id,
            slug: connection.project.slug,
            name: connection.project.name,
          },
          ...(workspace === null
            ? {}
            : {
                workspace: {
                  id: workspace.id,
                  root_path: workspace.root_path,
                  branch: workspace.branch,
                  head_commit: workspace.head_commit,
                  dirty: workspace.dirty,
                },
              }),
          policy: {
            agent_may_accept_findings: STAGE_1_POLICY.agent_may_accept_findings,
            verification_required: STAGE_1_POLICY.verification_required,
            secret_tools_available: STAGE_1_POLICY.secret_tools_available,
            // Read from the project rather than from the constant beside the
            // other three. The other three are product invariants that no
            // project may vary; this one is a project setting
            // (`docs/DOMAIN_MODEL.md` section 6), and advertising a constant
            // here made `project_current` tell an agent to check viewports the
            // project had not chosen while the completion gate demanded the
            // ones it had. One of the two had to be the source, and the
            // project is.
            required_viewports: [...requirements.required_viewports],
          },
        },
      };
    },
  },
  {
    name: "agent_session_status",
    title: "Agent session identity and browser sessions",
    capability: "project:read",
    stateChanging: false,
    validate: validateAgentSessionStatusInput,
    async run(args, context) {
      const { connection, services } = context;
      const include = (args["include"] as string[] | undefined) ?? [
        "browser_sessions",
        "capabilities",
      ];
      const sessions = include.includes("browser_sessions")
        ? (await services.browserSessions.listForProject(connection.project.id))
            .filter(
              (record) =>
                record.agent_session_id === connection.session.id &&
                record.ended_at === null &&
                (record.status === "READY" || record.status === "ACTIVE"),
            )
            .slice(0, 16)
        : [];
      const pending = await services.inbox.pendingCount(connection.scope, {
        type: "agent_session",
        id: connection.session.id,
      });
      return {
        trust: "trusted_control_plane",
        data: {
          inbox_pending_count: pending,
          agent_session_id: connection.session.id,
          status: connection.session.status,
          client: { name: connection.client.name, version: connection.client.version },
          project: { id: connection.project.id, slug: connection.project.slug },
          ...(connection.workspace === null
            ? {}
            : {
                workspace: {
                  id: connection.workspace.id,
                  root_path: connection.workspace.root_path,
                  branch: connection.workspace.branch,
                  head_commit: connection.workspace.head_commit,
                  dirty: connection.workspace.dirty,
                },
              }),
          capabilities: connection.serverCapabilities,
          granted_capabilities: [...connection.session.capabilities],
          ...(sessions.length === 0
            ? {}
            : {
                browser_sessions: sessions.map((record) => ({
                  id: record.id,
                  status: record.status,
                  control_epoch: record.control_epoch,
                  ...(record.current_controller === null
                    ? {}
                    : {
                        controller: {
                          type:
                            record.current_controller.type === "agent"
                              ? ("agent_session" as const)
                              : record.current_controller.type === "human"
                                ? ("human_user" as const)
                                : ("system" as const),
                          id: record.current_controller.id,
                        },
                      }),
                  viewport: record.viewport,
                  ...(record.service_origin === null
                    ? {}
                    : { service_origin: record.service_origin }),
                })),
              }),
          expires_at: connection.credential.expiresAt.toISOString(),
        },
      };
    },
  },
  {
    name: "agent_inbox_list",
    title: "List assigned work delivered to this agent session",
    capability: "project:read",
    // Retrieval is idempotent, so it is not state-changing and carries no key:
    // reading an inbox twice reads the same inbox
    // (`docs/DOMAIN_MODEL.md` section 21).
    stateChanging: false,
    validate: validateAgentInboxListInput,
    async run(args, context) {
      const { connection, services } = context;
      const rawCursor = args["cursor"] as string | undefined;
      const cursor = rawCursor === undefined ? null : decodeCursor(rawCursor);
      if (rawCursor !== undefined && cursor === null) {
        throw new ApiError("UNSUPPORTED_CAPABILITY", "cursor is not a cursor this server issued.", {
          field: "cursor",
        });
      }
      const page = await services.inbox.list(connection.scope, {
        ...(args["status"] === undefined
          ? {}
          : { statuses: args["status"] as readonly InboxItemStatus[] }),
        // The recipient is the session, taken from the authenticated
        // connection. There is no argument that could name another recipient,
        // so one agent session cannot read another's inbox.
        recipient: { type: "agent_session", id: connection.session.id },
        limit: (args["limit"] as number | undefined) ?? 20,
        ...(cursor === null ? {} : { after: { sortKey: cursor.createdAt, id: cursor.id } }),
      });
      if (page.nextCursor !== null) {
        context.warnings.add(
          "results_truncated",
          "More inbox items remain than fit in one page. Continue with cursor.",
        );
      }
      return {
        // An item names human-authored work — a title a human wrote and a review
        // slug — so the ordinary case is the one review-adjacent response that
        // is not mixed. The exception is a reopened finding an *agent*
        // authored: its title is then text a page supplied, and labelling it
        // trusted would be exactly the mislabelling ADR-0010 forbids. Nothing
        // creates such a finding today; the label is derived from the data
        // rather than from that fact, so it stays correct when one does.
        trust: inboxTrust(page.items),
        data: {
          items: page.items.map((item) => toInboxItemView(item, context.views)),
          pending_count: page.pendingCount,
          ...(page.nextCursor === null
            ? {}
            : {
                next_cursor: encodeCursor({
                  createdAt: page.nextCursor.sortKey,
                  id: page.nextCursor.id,
                }),
              }),
        },
      };
    },
  },
  {
    name: "agent_inbox_acknowledge",
    title: "Acknowledge receipt of one inbox item",
    capability: "project:read",
    stateChanging: true,
    validate: validateAgentInboxAcknowledgeInput,
    async run(args, context) {
      const { connection, services } = context;
      const result = await services.inbox.transition(
        connection.scope,
        args["inbox_item_id"] as string,
        // The target is fixed by the tool. There is no argument an agent could
        // set to `completed`: acknowledgement is receipt, and completing the
        // work is a different act with different evidence
        // (`docs/DOMAIN_MODEL.md` section 21).
        "acknowledged",
        agentActor(connection.session, connection.client.name),
        { recipient: { type: "agent_session", id: connection.session.id } },
      );
      return {
        trust: inboxTrust([result.item]),
        data: {
          item: toInboxItemView(result.item, context.views),
          ...(result.previousStatus === result.item.status
            ? {}
            : { previous_status: result.previousStatus }),
        },
      };
    },
  },
  {
    name: "review_list",
    title: "List this project's reviews",
    capability: "review:read",
    stateChanging: false,
    validate: validateReviewListInput,
    async run(args, context) {
      const { connection, services } = context;
      const rawCursor = args["cursor"] as string | undefined;
      const cursor = rawCursor === undefined ? null : decodeCursor(rawCursor);
      if (rawCursor !== undefined && cursor === null) {
        throw new ApiError("UNSUPPORTED_CAPABILITY", "cursor is not a cursor this server issued.", {
          field: "cursor",
        });
      }
      const limit = (args["limit"] as number | undefined) ?? 20;
      const filter: ReviewListFilter = {
        ...(args["status"] === undefined
          ? {}
          : { statuses: args["status"] as NonNullable<ReviewListFilter["statuses"]> }),
        ...(args["assigned_to_me"] === true
          ? { assignedAgentSessionId: connection.session.id }
          : {}),
        ...(args["slug_prefix"] === undefined
          ? {}
          : { slugPrefix: args["slug_prefix"] as string }),
        ...(args["updated_since"] === undefined
          ? {}
          : { updatedSince: args["updated_since"] as string }),
      };
      const page = await services.reviews.listReviewsPage(
        connection.scope,
        {
          limit: limit + 1,
          after: cursor === null ? null : { sortKey: cursor.createdAt, id: cursor.id },
        },
        filter,
      );
      const items = page.items.slice(0, limit);
      const last = items[items.length - 1];
      const more = page.items.length > limit;
      if (more) {
        context.warnings.add(
          "results_truncated",
          "More reviews remain than fit in one page. Continue with cursor.",
        );
      }
      return {
        trust: "trusted_human_instruction",
        data: {
          reviews: items.map((review) => toReviewView(review, context.views)),
          ...(more && last !== undefined
            ? { next_cursor: encodeCursor({ createdAt: last.created_at, id: last.id }) }
            : {}),
        },
      };
    },
  },
  {
    name: "review_search",
    title: "Search this project's reviews",
    capability: "review:read",
    stateChanging: false,
    validate: validateReviewSearchInput,
    async run(args, context) {
      const { connection, services } = context;
      // `connection.scope` is the session's organisation and project, decided
      // when the connection authenticated. The tool takes no project argument
      // and passes none, so there is no code path here that could search
      // another project (`docs/MCP_SPEC.md` section 7.6).
      const matches = await services.reviews.searchReviews(
        connection.scope,
        args["query"] as string,
        (args["limit"] as number | undefined) ?? 10,
      );
      return {
        // Which part matched is control-plane fact and the review's own title
        // is human-authored. The matching finding text is deliberately not
        // returned: an excerpt would carry page-derived bytes into a list.
        trust: "trusted_human_instruction",
        data: {
          matches: matches.map((match) => ({
            review: toReviewView(match.review, context.views),
            matched: [...match.matched],
          })),
        },
      };
    },
  },
  {
    name: "review_get",
    title: "Retrieve a review by name or identifier",
    capability: "review:read",
    stateChanging: false,
    validate: validateReviewGetInput,
    async run(args, context) {
      const review = await resolveReview(args["review"] as string, context);
      const include = (args["include"] as string[] | undefined) ?? ["findings", "artefact_links"];
      // Assembled through the bound rather than checked against it afterwards.
      // Findings, their evidence links and the review's comments are all
      // caller-influenced in size, and the sum of them used to be able to
      // exceed the tool's declared limit and throw (`docs/MCP_SPEC.md` §13).
      const payload = new BoundedPayload("review_get");
      payload.require("review", toReviewView(review, context.views));
      let pageDerived = false;

      // Staleness is offered first because it is a fixed handful of bytes the
      // caller explicitly asked for, and losing it to a long comment would be
      // the wrong thing to drop.
      if (include.includes("staleness")) {
        // The captured context and nothing else. `docs/DOMAIN_MODEL.md`
        // section 24 puts the calculation in Stage 2, so `computed: false` is
        // stated rather than left to be inferred from a missing verdict: an
        // agent must be able to tell "the capture still matches" from "nobody
        // looked", and only one of those is true here.
        const workspace = context.connection.workspace;
        payload.offer("staleness", {
          computed: false,
          captured_branch: review.captured_branch,
          captured_commit: review.captured_commit,
          ...(workspace === null || workspace.branch === null
            ? {}
            : { workspace_branch: workspace.branch }),
          ...(workspace === null || workspace.head_commit === null
            ? {}
            : { workspace_head_commit: workspace.head_commit }),
        });
        context.warnings.add(
          "staleness_unavailable",
          "This build records the captured branch and commit and computes no staleness verdict.",
          "Reproduce the finding against the current code before changing anything.",
        );
      }

      if (include.includes("findings")) {
        const rawCursor = args["findings_cursor"] as string | undefined;
        const cursor = rawCursor === undefined ? null : decodeCursor(rawCursor);
        if (rawCursor !== undefined && cursor === null) {
          throw new ApiError("UNSUPPORTED_CAPABILITY", "findings_cursor is not a cursor this server issued.", {
            field: "findings_cursor",
          });
        }
        const page = await context.services.reviews.listFindingsPage(
          context.connection.scope,
          review.id,
          {
            limit: (args["findings_limit"] as number | undefined) ?? 20,
            ...(cursor === null ? {} : { cursor }),
          },
        );
        // The views are built in the same order as the records, so the index of
        // the last view that fitted is the index of the record the next cursor
        // has to be minted from. Truncating without doing that would skip the
        // findings that were dropped, which is worse than not paging at all.
        const views = page.findings.map((finding) => toFindingView(finding, context.views));
        const kept = payload.fill("findings", views);
        if (kept.included.length > 0) pageDerived = true;
        const lastIncluded = page.findings[kept.included.length - 1];
        const moreRemain = kept.truncated || page.nextCursor !== null;
        if (moreRemain) {
          const next =
            kept.truncated && lastIncluded !== undefined
              ? { createdAt: lastIncluded.created_at, id: lastIncluded.id }
              : page.nextCursor;
          if (next !== null && next !== undefined) {
            payload.offer("findings_next_cursor", encodeCursor(next));
          }
          context.warnings.add(
            "findings_truncated",
            "This review has more findings than fit in one page. Continue with findings_cursor.",
          );
        }

        if (include.includes("artefact_links")) {
          // Only for the findings that survived the bound: a link to evidence
          // for a finding this response does not carry is context an agent
          // cannot place.
          const links: ArtefactLink[] = [];
          for (const finding of page.findings.slice(0, kept.included.length)) {
            const link = await toArtefactLink(finding.screenshot_artefact_id, "before", context.views);
            if (link !== null) links.push(link);
          }
          const keptLinks = payload.fill("artefact_links", links);
          if (keptLinks.included.length > 0) pageDerived = true;
          if (keptLinks.truncated) {
            context.warnings.add(
              "results_truncated",
              "Some evidence links did not fit in this response. Read them with finding_get.",
            );
          }
        }
      }

      if (include.includes("comments")) {
        const rawCursor = args["comments_cursor"] as string | undefined;
        const cursor = rawCursor === undefined ? null : decodeCursor(rawCursor);
        if (rawCursor !== undefined && cursor === null) {
          throw new ApiError("UNSUPPORTED_CAPABILITY", "comments_cursor is not a cursor this server issued.", {
            field: "comments_cursor",
          });
        }
        const page = await context.services.reviews.listCommentsPage(
          context.connection.scope,
          { reviewId: review.id },
          {
            limit: (args["comments_limit"] as number | undefined) ?? 20,
            ...(cursor === null ? {} : { cursor }),
          },
        );
        const kept = payload.fill(
          "comments",
          page.comments.map((comment) => toCommentView(comment, context.views)),
        );
        const lastIncluded = page.comments[kept.included.length - 1];
        const moreRemain = kept.truncated || page.nextCursor !== null;
        if (moreRemain) {
          const next =
            kept.truncated && lastIncluded !== undefined
              ? { createdAt: lastIncluded.created_at, id: lastIncluded.id }
              : page.nextCursor;
          if (next !== null && next !== undefined) {
            payload.offer("comments_next_cursor", encodeCursor(next));
          }
          context.warnings.add(
            "results_truncated",
            "This review has more comments than fit in one page. Continue with comments_cursor.",
          );
        }
      }

      return {
        trust: trustFor({ pageDerived, humanAuthored: true }),
        data: payload.data,
      };
    },
  },
  {
    name: "review_claim",
    title: "Claim a review for this agent session",
    capability: "review:write",
    stateChanging: true,
    validate: validateReviewClaimInput,
    async run(args, context) {
      const before = await context.services.reviews.getReview(
        context.connection.scope,
        args["review_id"] as string,
      );
      const review = await context.services.reviews.claimReview(
        context.connection.scope,
        args["review_id"] as string,
        args["expected_version"] as number,
        agentActor(context.connection.session, context.connection.client.name),
      );
      return {
        trust: "trusted_human_instruction",
        data: {
          review: toReviewView(review, context.views),
          ...(review.status === before.status ? {} : { previous_status: before.status }),
        },
      };
    },
  },
  {
    name: "review_update_status",
    title: "Move a review to an agent-permitted status",
    capability: "review:write",
    stateChanging: true,
    validate: validateReviewUpdateStatusInput,
    authority: { kind: "review", idField: "review_id" },
    async run(args, context) {
      const reviewId = args["review_id"] as string;
      const before = await context.services.reviews.getReview(context.connection.scope, reviewId);
      const review = await context.services.reviews.updateReview(
        context.connection.scope,
        reviewId,
        {
          expectedVersion: args["expected_version"] as number,
          status: args["status"] as typeof before.status,
        },
        agentActor(context.connection.session, context.connection.client.name),
      );
      return {
        trust: "trusted_human_instruction",
        data: {
          review: toReviewView(review, context.views),
          ...(review.status === before.status ? {} : { previous_status: before.status }),
        },
      };
    },
  },
  {
    name: "review_add_comment",
    title: "Add an attributed agent comment to a review",
    capability: "review:write",
    stateChanging: true,
    validate: validateReviewAddCommentInput,
    async run(args, context) {
      const comment = await context.services.reviews.addReviewComment(
        context.connection.scope,
        args["review_id"] as string,
        args["body"] as string,
        // The author is the agent session and is derived here, never taken from
        // the arguments: a caller able to name an author could write in a
        // human's name and the comment would read as human instruction.
        agentActor(context.connection.session, context.connection.client.name),
      );
      return { trust: "trusted_control_plane", data: { comment: toCommentView(comment, context.views) } };
    },
  },
  {
    name: "finding_get",
    title: "Read one finding with its evidence and verification",
    capability: "finding:read",
    stateChanging: false,
    validate: validateFindingGetInput,
    async run(args, context) {
      const findingId = args["finding_id"] as string;
      const finding = await context.services.reviews.getFinding(context.connection.scope, findingId);
      const include = (args["include"] as string[] | undefined) ?? [
        "annotations",
        "artefact_links",
        "verification",
      ];
      const { view, link } = await findingWithLinks(finding, context, "before");
      const payload = new BoundedPayload("finding_get");
      payload.require("finding", view);

      // Evidence and the latest verification are offered before the
      // collections: they are the two things an agent needs in order to act on
      // the finding at all, and a long comment thread must not displace them.
      if (include.includes("artefact_links") && link !== null) payload.offer("artefact_links", [link]);
      if (include.includes("verification")) {
        const verification = await context.services.reviews.latestVerification(
          context.connection.scope,
          findingId,
        );
        if (verification !== null) {
          payload.offer(
            "latest_verification",
            await toVerificationView(verification, context.views),
          );
        }
      }
      if (include.includes("annotations")) {
        const annotations = await context.services.reviews.listAnnotations(
          context.connection.scope,
          findingId,
        );
        const kept = payload.fill("annotations", annotations.slice(0, 32).map(toAnnotationView));
        if (kept.truncated) {
          context.warnings.add(
            "results_truncated",
            "Some annotations did not fit in this response. Read the finding in the web application for all of them.",
          );
        }
      }
      if (include.includes("comments")) {
        const rawCursor = args["comments_cursor"] as string | undefined;
        const cursor = rawCursor === undefined ? null : decodeCursor(rawCursor);
        if (rawCursor !== undefined && cursor === null) {
          throw new ApiError("UNSUPPORTED_CAPABILITY", "comments_cursor is not a cursor this server issued.", {
            field: "comments_cursor",
          });
        }
        const page = await context.services.reviews.listCommentsPage(
          context.connection.scope,
          { reviewId: finding.review_id, findingId },
          {
            limit: (args["comments_limit"] as number | undefined) ?? 20,
            ...(cursor === null ? {} : { cursor }),
          },
        );
        const kept = payload.fill(
          "comments",
          page.comments.map((comment) => toCommentView(comment, context.views)),
        );
        const lastIncluded = page.comments[kept.included.length - 1];
        const moreRemain = kept.truncated || page.nextCursor !== null;
        if (moreRemain) {
          const next =
            kept.truncated && lastIncluded !== undefined
              ? { createdAt: lastIncluded.created_at, id: lastIncluded.id }
              : page.nextCursor;
          if (next !== null && next !== undefined) {
            payload.offer("comments_next_cursor", encodeCursor(next));
          }
          context.warnings.add(
            "results_truncated",
            "This finding has more comments than fit in one page. Continue with comments_cursor.",
          );
        }
      }
      if (!context.connection.serverCapabilities.image_resources) {
        context.warnings.add(
          "image_content_unsupported",
          "This client declared no image capability, so evidence is returned as links and text.",
          "Read the screenshot:// resource, or fetch content_path with this session's credential.",
        );
      }
      return {
        trust: trustFor({ pageDerived: true, humanAuthored: true }),
        data: payload.data,
      };
    },
  },
  {
    name: "finding_claim",
    title: "Claim one finding with optimistic concurrency",
    capability: "finding:write",
    stateChanging: true,
    validate: validateFindingClaimInput,
    async run(args, context) {
      const findingId = args["finding_id"] as string;
      const before = await context.services.reviews.getFinding(context.connection.scope, findingId);
      const finding = await context.services.reviews.updateFinding(
        context.connection.scope,
        findingId,
        { expectedVersion: args["expected_version"] as number, status: "CLAIMED" },
        agentActor(context.connection.session, context.connection.client.name),
      );
      return {
        trust: trustFor({ pageDerived: true, humanAuthored: true }),
        data: {
          finding: toFindingView(finding, context.views),
          ...(finding.status === before.status ? {} : { previous_status: before.status }),
        },
      };
    },
  },
  {
    name: "finding_update_status",
    title: "Move a finding through the agent transitions",
    capability: "finding:write",
    stateChanging: true,
    validate: validateFindingUpdateStatusInput,
    authority: { kind: "finding", idField: "finding_id" },
    async run(args, context) {
      const findingId = args["finding_id"] as string;
      const before = await context.services.reviews.getFinding(context.connection.scope, findingId);
      const finding = await context.services.reviews
        .updateFinding(
          context.connection.scope,
          findingId,
          {
            expectedVersion: args["expected_version"] as number,
            status: args["status"] as typeof before.status,
            ...(args["resolution_note"] === undefined
              ? {}
              : { resolutionNote: args["resolution_note"] as string }),
          },
          agentActor(context.connection.session, context.connection.client.name),
        )
        .catch((error: unknown) => {
          // A refused transition says what *is* possible from here. The domain
          // layer does not know the caller is an agent; this layer does, so the
          // agent-permitted list is added here rather than guessed there.
          if (error instanceof ApiError && error.code === "POLICY_DENIED") {
            throw new ApiError(error.code, error.message, {
              ...error.details,
              allowed_transitions: agentTransitionsFrom(before.status),
            });
          }
          throw error;
        });
      return {
        trust: trustFor({ pageDerived: true, humanAuthored: true }),
        data: {
          finding: toFindingView(finding, context.views),
          ...(finding.status === before.status ? {} : { previous_status: before.status }),
        },
      };
    },
  },
  {
    name: "finding_mark_blocked",
    title: "Mark a finding blocked, with the reason a human must act on",
    capability: "finding:write",
    stateChanging: true,
    validate: validateFindingMarkBlockedInput,
    async run(args, context) {
      const findingId = args["finding_id"] as string;
      const before = await context.services.reviews.getFinding(context.connection.scope, findingId);
      // `reason` is required by the schema, so the refusal for a block that
      // says nothing happens before any domain code runs. The requested human
      // action rides on the same reason field, because the domain records one
      // string and inventing a second column for a sentence would be a
      // migration in place of a sentence.
      const reason =
        args["requested_human_action"] === undefined
          ? (args["reason"] as string)
          : `${args["reason"] as string} Requested of a human: ${args["requested_human_action"] as string}`;
      const finding = await context.services.reviews
        .updateFinding(
          context.connection.scope,
          findingId,
          {
            expectedVersion: args["expected_version"] as number,
            status: "BLOCKED",
            reason: reason.slice(0, 512),
          },
          agentActor(context.connection.session, context.connection.client.name),
        )
        .catch((error: unknown) => {
          if (error instanceof ApiError && error.code === "POLICY_DENIED") {
            throw new ApiError(error.code, error.message, {
              ...error.details,
              allowed_transitions: agentTransitionsFrom(before.status),
            });
          }
          throw error;
        });
      return {
        trust: trustFor({ pageDerived: true, humanAuthored: true }),
        data: {
          finding: toFindingView(finding, context.views),
          ...(finding.status === before.status ? {} : { previous_status: before.status }),
        },
      };
    },
  },
  {
    name: "finding_add_comment",
    title: "Add an attributed agent comment to a finding",
    capability: "finding:write",
    stateChanging: true,
    validate: validateFindingAddCommentInput,
    async run(args, context) {
      const comment = await context.services.reviews.addComment(
        context.connection.scope,
        args["finding_id"] as string,
        args["body"] as string,
        agentActor(context.connection.session, context.connection.client.name),
      );
      return { trust: "trusted_control_plane", data: { comment: toCommentView(comment, context.views) } };
    },
  },
  {
    name: "finding_submit_verification",
    title: "Submit verification evidence for a finding",
    capability: "verification:submit",
    stateChanging: true,
    validate: validateFindingSubmitVerificationInput,
    async run(args, context) {
      const findingId = args["finding_id"] as string;
      const expectedVersion = args["expected_version"] as number | undefined;
      if (expectedVersion !== undefined) {
        const current = await context.services.reviews.getFinding(
          context.connection.scope,
          findingId,
        );
        if (current.version !== expectedVersion) {
          throw new ApiError("VERSION_CONFLICT", "The finding changed since it was loaded.", {
            current_version: current.version,
            expected_version: expectedVersion,
          });
        }
      }
      const submitted = await context.services.reviews.submitVerification(
        context.connection.scope,
        findingId,
        {
          summary: args["summary"] as string,
          branch: args["branch"] as string,
          commit: args["commit"] as string,
          testedViewports: args["tested_viewports"] as never,
          checks: args["checks"] as never,
          artefactIds: args["artefact_ids"] as string[],
          workspaceBranch: context.connection.workspace?.branch ?? null,
        },
        agentActor(context.connection.session, context.connection.client.name),
      );
      if (!submitted.branchCorroborated) {
        context.warnings.add(
          "verification_branch_uncorroborated",
          "No workspace is registered for this project, so the branch on this verification was recorded but not checked.",
          "A human reviewer should confirm the branch before accepting.",
        );
      }
      // What the submission still does not satisfy, answered here rather than
      // left for the agent to discover from a refusal on the next transition.
      // An agent that learns the gap at submission fixes it in the same turn;
      // one that learns it from `EVIDENCE_REQUIRED` has already believed itself
      // finished.
      const workspaceBranch = context.connection.workspace?.branch ?? null;
      const { settings, requirements } = await context.services.reviews.completionRequirements(
        context.connection.scope,
      );
      const evidence = await context.services.reviews.completionEvidenceFor(
        context.connection.scope,
        findingId,
        workspaceBranch,
      );
      return {
        trust: trustFor({ pageDerived: true, humanAuthored: true }),
        data: {
          verification: {
            ...(await toVerificationView(submitted.verification, context.views)),
            assurance: assuranceFor(evidence),
          },
          finding: toFindingView(submitted.finding, context.views),
          requirements,
          missing: missingEvidence(settings, requirements, evidence),
        },
      };
    },
  },
  {
    name: "browser_take_screenshot",
    title: "Capture verification evidence from a browser session",
    capability: "browser:capture",
    stateChanging: true,
    validate: validateBrowserTakeScreenshotInput,
    async run(args, context) {
      const { connection, services } = context;
      const browserSessionId = args["browser_session_id"] as string;
      await browserSessionIfPermitted(browserSessionId, context);

      // A capture is a system command, issued as the system controller. It used
      // to be issued as `record.current_controller`, which is to say in the name
      // of whoever held the interactive lease — impersonation, and unnecessary:
      // `take_screenshot` is one of the browser protocol's two
      // `system_capture_commands`, so the matrix admits it without the lease and
      // issuing it can never transfer one (`docs/TESTING.md` §5).
      const controller = captureController(context);
      const command: BrowserCommand = {
        command: "take_screenshot",
        timeout_ms: SCREENSHOT_TIMEOUT_MS,
        take_screenshot: {
          full_page: (args["full_page"] as boolean | undefined) ?? false,
          // A capture that is not persisted produces no artefact and therefore
          // no evidence, and evidence is the only reason this tool exists.
          persist: true,
          purpose: "verification",
        },
      };
      const result = await services.browserSessions.runCommand({
        browserSessionId,
        projectId: connection.project.id,
        controller,
        controlEpoch: args["control_epoch"] as number,
        command,
        actor: agentActor(connection.session, connection.client.name),
      });
      if (!result.ok || result.screenshot === undefined) {
        const code = (result.error?.code ?? "INTERNAL_ERROR") as ApiError["code"];
        throw new ApiError(code, result.error?.message ?? "The capture did not produce evidence.");
      }
      const link = await toArtefactLink(result.screenshot.artefact_id, "after", context.views);
      if (link === null) {
        throw new ApiError(
          "ARTEFACT_UPLOAD_INCOMPLETE",
          "The capture was taken but the artefact is not available as evidence.",
        );
      }
      if (!connection.serverCapabilities.image_resources) {
        context.warnings.add(
          "image_content_unsupported",
          "This client declared no image capability, so the capture is returned as a link and its digest.",
          "Read the screenshot:// resource, or fetch content_path with this session's credential.",
        );
      }
      return {
        // A picture of a page is page-derived, whatever is in it.
        trust: "untrusted_browser_content",
        data: {
          artefact: link,
          browser_session_id: browserSessionId,
          captured_at: result.screenshot.captured_at,
          viewport: result.screenshot.viewport,
          full_page: result.screenshot.full_page,
          ...(result.navigation?.url === undefined ? {} : { url: result.navigation.url }),
        },
      };
    },
  },
  {
    name: "browser_session_start",
    title: "Start or reserve a central browser session for this agent session",
    capability: "browser:control",
    stateChanging: true,
    validate: validateBrowserSessionStartInput,
    async run(args, context) {
      const { connection, services } = context;
      const publishedServiceId = args["published_service_id"] as string | undefined;
      const common = {
        organisationId: connection.credential.organisationId,
        // Neither the project nor the agent session is an argument. A caller
        // that could name either would be starting a browser somewhere it has
        // no authority, and the schema has no member to put them in.
        projectId: connection.project.id,
        agentSessionId: connection.session.id,
        viewport: (args["viewport"] as Viewport | undefined) ?? DEFAULT_VIEWPORT,
        controller: agentController(context),
        // Everything captured in a session an agent started is evidence a
        // human will judge, so it is retained on the evidence window rather
        // than the shorter action-screenshot one.
        retentionClass: "verification_evidence" as const,
        actor: agentActor(connection.session, connection.client.name),
      };

      if (publishedServiceId !== undefined) {
        // Refused **before anything is reserved**, so the refusal costs no
        // browser slot, and refused here rather than by the schema so that it
        // is audited and can name the way out.
        //
        // A route cannot be made to work on this call by any amount of
        // authorisation care, and that is the ordering rather than the missing
        // signing key: a route names the sessions it authorises when it is
        // published, `mint` refuses unless the route already names the session,
        // and a worker's egress policy is fixed when its context is created and
        // cannot be widened afterwards. This call reserves and allocates at
        // once, so a route published beforehand names the *previous* session.
        // Handing this process a signing key would have moved the refusal from
        // UNSUPPORTED_CAPABILITY to AUTHORISATION_DENIED and no further
        // (ADR-0037).
        //
        // The member is retained rather than removed because removing it would
        // route a foreseeable refusal into the generated validator, which is
        // the one layer that records nothing and whose text names neither the
        // condition nor the replacement (`docs/MCP_SPEC.md` §14, §18 of
        // `docs/UX_FLOWS.md`). Every agent following the previous §7.3, a
        // cached tool description or an older prompt sends this argument.
        await services.browserSessions.recordUnresolvedLifecycleRejection({
          organisationId: connection.credential.organisationId,
          projectId: connection.project.id,
          act: "allocate",
          actor: agentActor(connection.session, connection.client.name),
          controllerType: "agent",
          reasonCode: "VALIDATION_FAILED",
          reason: "published_service_id_on_start",
        });
        throw new ApiError(
          "VALIDATION_FAILED",
          "A route cannot authorise a browser session that did not exist when it was published. Start this session with allocate: false, publish a route with development_service_publish — it will name this reservation — then call browser_session_allocate.",
          { field: "published_service_id" },
        );
      }

      // `allocate: false` reserves and stops. The identifier can then be named
      // in a route's allowed_browser_session_ids, which is the only order that
      // works (`docs/API.md` §11).
      const record =
        args["allocate"] === false
          ? await services.browserSessions.create(common)
          : await services.browserSessions.start({ ...common, requestId: context.requestId });
      return {
        // A newly reserved or allocated session has been nowhere, so this view
        // is a lease, an epoch and a viewport: control-plane fact throughout.
        trust: "trusted_control_plane",
        data: { session: await toBrowserSessionView(record, context, { includeUrl: false }) },
      };
    },
  },
  {
    name: "browser_session_allocate",
    title: "Allocate a reserved browser session, optionally admitting it to a route",
    capability: "browser:control",
    stateChanging: true,
    validate: validateBrowserSessionAllocateInput,
    async run(args, context) {
      const { connection, services } = context;
      const browserSessionId = args["browser_session_id"] as string;
      const publishedServiceId = args["published_service_id"] as string | undefined;
      const scope = scopeOf(connection);
      const actor = agentActor(connection.session, connection.client.name);

      // The session identifier arrives as an **argument**, so it inherits none
      // of the authorisation the other browser tools get from having just
      // created the session or from a route layer above them. It is resolved in
      // the connection's scope — identifier, project and organisation in one
      // `WHERE` — and only then checked for ownership, so a session in another
      // project earns the refusal an unknown identifier earns rather than
      // "it exists, but not for you" (`docs/API.md` §5).
      const record = await browserSessionIfPermitted(browserSessionId, context);
      if (record === null) {
        // Nothing to correlate the refusal to, so it goes to this agent's own
        // project stream without a session identifier. A refusal that is correct
        // and unrecorded is the defect class this repository has shipped twice.
        await services.browserSessions.recordUnresolvedLifecycleRejection({
          organisationId: connection.credential.organisationId,
          projectId: connection.project.id,
          act: "allocate",
          actor,
          controllerType: "agent",
          reasonCode: "RESOURCE_NOT_FOUND",
          reason: "browser_session_unresolved",
        });
        throw new ApiError("RESOURCE_NOT_FOUND", "The browser session was not found.");
      }

      if (publishedServiceId === undefined) {
        // No route means nothing to mint, so this process finishes it itself.
        // The two-phase handoff exists for the signing key and for nothing else;
        // using it where no key is needed would add a sweep interval to an
        // allocation that could have answered immediately.
        const allocated = await services.browserSessions.allocate({
          browserSessionId,
          scope,
          actor,
          requestId: context.requestId,
        });
        return {
          trust: "trusted_control_plane",
          data: { session: await toBrowserSessionView(allocated, context, { includeUrl: false }) },
        };
      }

      // Phase one, here: authorise and record the request, touching nothing
      // outside PostgreSQL. Phase two runs in `api`, which holds the capability
      // signing key — a process that cannot mint cannot leak a minting key
      // (ADR-0020, ADR-0021).
      await services.browserSessions.requestAllocation({
        browserSessionId,
        scope,
        publishedServiceId,
        actor,
        requestId: context.requestId,
      });
      const settled = await services.browserSessions.awaitAllocation(browserSessionId, scope, {
        timeoutMs: services.config.allocateWaitMs,
      });
      if (settled.status === "REQUESTED" || settled.status === "ALLOCATING") {
        // The wait ends in the record as it stands and never in a claim. An
        // agent told a session was ready when nothing was carrying its origin
        // would read the navigation failure as a fault in the application it is
        // reviewing.
        context.warnings.add(
          "allocation_incomplete",
          "The allocation has not finished. The session is reported as it stands; call browser_session_status before navigating.",
          `browser_session_status=${settled.status}`,
        );
      }
      return {
        trust: "trusted_control_plane",
        data: { session: await toBrowserSessionView(settled, context, { includeUrl: false }) },
      };
    },
  },
  {
    name: "browser_session_status",
    title: "Read one browser session's lifecycle, controller and current URL",
    capability: "browser:control",
    stateChanging: false,
    validate: validateBrowserSessionReferenceInput,
    async run(args, context) {
      const record = await requireBrowserSession(args["browser_session_id"] as string, context);
      return {
        // Fixed rather than derived, and this is the one place that is right.
        // §7.3 says this tool returns the URL, so an agent must be able to rely
        // on one answer: a label that was trusted until the browser navigated
        // and untrusted afterwards would teach an agent to treat the tool as
        // trusted and then hand it page-derived bytes under that habit.
        trust: "untrusted_browser_content",
        data: { session: await toBrowserSessionView(record, context, { includeUrl: true }) },
      };
    },
  },
  {
    name: "browser_session_pause",
    title: "Suspend agent-issued interactive commands in a browser session",
    capability: "browser:control",
    stateChanging: true,
    validate: validateBrowserSessionControlInput,
    async run(args, context) {
      const { connection, services } = context;
      const browserSessionId = args["browser_session_id"] as string;
      // The project, the epoch and the lease are the service's to check, and it
      // refuses a session in another project as not found. Only the ownership
      // rule is this layer's, and it runs only once the project has matched.
      await browserSessionIfPermitted(browserSessionId, context);
      const paused = await services.browserSessions.pause({
        browserSessionId,
        projectId: connection.project.id,
        controller: agentController(context),
        controlEpoch: args["control_epoch"] as number,
        actor: agentActor(connection.session, connection.client.name),
      });
      return {
        trust: "trusted_control_plane",
        data: { session: await toBrowserSessionView(paused, context, { includeUrl: false }) },
      };
    },
  },
  {
    name: "browser_session_resume",
    title: "Re-admit interactive commands to the controller holding the lease",
    capability: "browser:control",
    stateChanging: true,
    validate: validateBrowserSessionControlInput,
    async run(args, context) {
      const { connection, services } = context;
      const browserSessionId = args["browser_session_id"] as string;
      await browserSessionIfPermitted(browserSessionId, context);
      const resumed = await services.browserSessions.resume({
        browserSessionId,
        projectId: connection.project.id,
        controller: agentController(context),
        controlEpoch: args["control_epoch"] as number,
        actor: agentActor(connection.session, connection.client.name),
      });
      return {
        trust: "trusted_control_plane",
        data: { session: await toBrowserSessionView(resumed, context, { includeUrl: false }) },
      };
    },
  },
  {
    name: "browser_session_end",
    title: "Terminate a browser session and destroy its context",
    capability: "browser:control",
    stateChanging: true,
    validate: validateBrowserSessionControlInput,
    async run(args, context) {
      const { connection, services } = context;
      const browserSessionId = args["browser_session_id"] as string;
      await browserSessionIfPermitted(browserSessionId, context);
      // `end`, not `terminate`. The second applies no epoch and no lease check
      // — it is the reconciler's and the worker report's door. This is the
      // controller-facing one, and §7.3 puts ending a session under the same
      // rules as pausing it.
      const ended = await services.browserSessions.end({
        browserSessionId,
        projectId: connection.project.id,
        controller: agentController(context),
        controlEpoch: args["control_epoch"] as number,
        // The agent asked; it is not a capacity, policy or failure termination,
        // and the reason is what the timeline will carry for ever.
        reason: "requested",
        actor: agentActor(connection.session, connection.client.name),
      });
      return {
        trust: "trusted_control_plane",
        data: { session: await toBrowserSessionView(ended, context, { includeUrl: false }) },
      };
    },
  },
  {
    name: "browser_navigate",
    title: "Open a URL inside the session's published-service origin",
    capability: "browser:control",
    stateChanging: false,
    validate: validateBrowserNavigateInput,
    run: (args, context) =>
      interactionRun("browser_navigate", "navigate", args, context, (limits) => ({
        command: "navigate",
        timeout_ms: commandTimeout(args, limits),
        navigate: {
          // The URL is passed through unresolved. A root-relative path is
          // resolved against the session's origin by the worker, and an
          // absolute URL outside that origin is refused there — resolving it
          // here would put the egress decision in the process that took the
          // argument (`docs/SECURITY.md` §9).
          url: args["url"] as string,
          wait_until: (args["wait_until"] as WaitUntil | undefined) ?? "domcontentloaded",
        },
      }), agentController(context)),
  },
  {
    name: "browser_snapshot",
    title: "Capture a bounded accessibility snapshot of the current page",
    // A snapshot reads the page; it does not steer it. An agent granted
    // capture but not control can look and cannot act.
    capability: "browser:capture",
    stateChanging: false,
    validate: validateBrowserSnapshotInput,
    run: (args, context) =>
      interactionRun("browser_snapshot", "snapshot", args, context, (limits) => ({
        command: "snapshot",
        timeout_ms: commandTimeout(args, limits),
        ...(args["max_nodes"] === undefined && args["max_bytes"] === undefined
          ? {}
          : {
              snapshot: {
                ...(args["max_nodes"] === undefined
                  ? {}
                  : { max_nodes: args["max_nodes"] as number }),
                ...(args["max_bytes"] === undefined
                  ? {}
                  : { max_bytes: args["max_bytes"] as number }),
              },
            }),
        // Issued as the system controller: a snapshot reads the page without
        // holding the interactive lease, and reading it never takes the lease
        // away from whoever does.
      }), captureController(context)),
  },
  {
    name: "browser_click",
    title: "Click one element of the current snapshot",
    capability: "browser:control",
    stateChanging: false,
    validate: validateBrowserElementInput,
    run: (args, context) =>
      interactionRun("browser_click", "click", args, context, (limits) => ({
        command: "click",
        timeout_ms: commandTimeout(args, limits),
        click: {
          snapshot_id: args["snapshot_id"] as string,
          ref: args["ref"] as string,
        },
      }), agentController(context)),
  },
  {
    name: "browser_type",
    title: "Type text into one element of the current snapshot",
    capability: "browser:control",
    stateChanging: false,
    validate: validateBrowserTypeInput,
    run: (args, context) =>
      // The text is **not** inspected here. `docs/SECURITY.md` §12 puts the
      // secret-shape refusal in the authorisation matrix, where it is applied
      // to every caller and audited as `browser.command_rejected`; a second
      // check in this layer would refuse a subset, silently, with no record,
      // and would be the one somebody later "optimised" away.
      interactionRun("browser_type", "type_text", args, context, (limits) => ({
        command: "type_text",
        timeout_ms: commandTimeout(args, limits),
        type_text: {
          snapshot_id: args["snapshot_id"] as string,
          ref: args["ref"] as string,
          text: args["text"] as string,
          ...(args["submit"] === undefined ? {} : { submit: args["submit"] as boolean }),
        },
      }), agentController(context)),
  },
  {
    name: "browser_select_option",
    title: "Select options of a select element",
    capability: "browser:control",
    stateChanging: false,
    validate: validateBrowserSelectOptionInput,
    run: (args, context) =>
      interactionRun("browser_select_option", "select_option", args, context, (limits) => ({
        command: "select_option",
        timeout_ms: commandTimeout(args, limits),
        select_option: {
          snapshot_id: args["snapshot_id"] as string,
          ref: args["ref"] as string,
          values: args["values"] as string[],
        },
      }), agentController(context)),
  },
  {
    name: "browser_press_key",
    title: "Press one key from the closed key vocabulary",
    capability: "browser:control",
    stateChanging: false,
    validate: validateBrowserPressKeyInput,
    run: (args, context) =>
      interactionRun("browser_press_key", "press_key", args, context, (limits) => ({
        command: "press_key",
        timeout_ms: commandTimeout(args, limits),
        press_key: {
          key: args["key"] as KeyName,
          ...(args["snapshot_id"] === undefined
            ? {}
            : { snapshot_id: args["snapshot_id"] as string }),
          ...(args["ref"] === undefined ? {} : { ref: args["ref"] as string }),
        },
      }), agentController(context)),
  },
  {
    name: "browser_scroll",
    title: "Scroll the page or one element by a bounded distance",
    capability: "browser:control",
    stateChanging: false,
    validate: validateBrowserScrollInput,
    run: (args, context) =>
      interactionRun("browser_scroll", "scroll", args, context, (limits) => ({
        command: "scroll",
        timeout_ms: commandTimeout(args, limits),
        scroll: {
          direction: args["direction"] as ScrollDirection,
          amount_px: args["amount_px"] as number,
          ...(args["snapshot_id"] === undefined
            ? {}
            : { snapshot_id: args["snapshot_id"] as string }),
          ...(args["ref"] === undefined ? {} : { ref: args["ref"] as string }),
        },
      }), agentController(context)),
  },
  {
    name: "browser_resize",
    title: "Resize the viewport and return the snapshot that replaces it",
    capability: "browser:control",
    stateChanging: false,
    validate: validateBrowserResizeInput,
    async run(args, context) {
      const { result, controlEpoch } = await runBrowserCommand(
        args,
        context,
        (limits) => ({
          command: "resize",
          timeout_ms: commandTimeout(args, limits),
          resize: { viewport: args["viewport"] as Viewport },
        }),
        agentController(context),
      );
      if (result.snapshot === undefined) {
        // §7.4 requires a resize to invalidate every outstanding element
        // reference and to produce the snapshot that replaces them. A result
        // without one is not a smaller answer: an agent would read it as "the
        // resize happened and my references still work", act on a reference the
        // page no longer has, and click whatever now occupies that position.
        // Refusing is the only honest outcome.
        throw new ApiError(
          "INTERNAL_ERROR",
          "The resize returned no snapshot, so every element reference it invalidated is unreplaced. Take a fresh snapshot before acting on any reference.",
        );
      }
      const payload = toInteractionResult({
        tool: "browser_resize",
        command: "resize",
        browserSessionId: args["browser_session_id"] as string,
        controlEpoch,
        result,
        context,
      });
      return { trust: interactionTrust("browser_resize", payload), data: payload };
    },
  },
  {
    name: "browser_wait",
    title: "Wait for one bounded condition",
    capability: "browser:control",
    stateChanging: false,
    validate: validateBrowserWaitInput,
    run: (args, context) =>
      // Each condition is defined by exactly one target and the generated
      // validator has already refused a request that named two, so this passes
      // through what survived rather than choosing between them by precedence.
      interactionRun("browser_wait", "wait", args, context, (limits) => ({
        command: "wait",
        timeout_ms: commandTimeout(args, limits),
        wait: {
          condition: args["condition"] as WaitCondition,
          ...(args["url_pattern"] === undefined
            ? {}
            : { url_pattern: args["url_pattern"] as string }),
          ...(args["selector"] === undefined ? {} : { selector: args["selector"] as string }),
          ...(args["text"] === undefined ? {} : { text: args["text"] as string }),
        },
      }), agentController(context)),
  },
  {
    name: "development_services_list",
    title: "List the project's published development services",
    capability: "project:read",
    stateChanging: false,
    validate: validateDevelopmentServicesListInput,
    async run(args, context) {
      const services = await context.services.developmentServices.list(
        context.connection.project.id,
        scopeOf(context.connection),
        args["limit"] as number | undefined,
      );
      return {
        trust: "trusted_project_configuration",
        data: { services: services.map(toDevelopmentServiceView) },
      };
    },
  },
  {
    name: "development_service_publish",
    title: "Publish a local development service through the connector",
    capability: "service:publish",
    stateChanging: true,
    validate: validateDevelopmentServicePublishInput,
    async run(args, context) {
      const { connection, services } = context;
      const workspaceId = args["workspace_id"] as string;
      // The workspace must belong to this session's project. A workspace in
      // another project is reported absent rather than forbidden, so a foreign
      // identifier and an unknown one are indistinguishable (`docs/API.md` §5).
      // The organisation is a term of the query rather than a check after it
      // (RVP-92): a row outside the tenant is not returned at all, so the
      // project comparison below is the second line and not the only one.
      const workspace = await services.workspaces.get(
        workspaceId,
        connection.scope.organisationId,
      );
      if (workspace === null || workspace.project_id !== connection.project.id) {
        throw new ApiError("WORKSPACE_NOT_FOUND", "No such workspace in this project.");
      }
      const connector = await services.developmentServices.connectorForProject(
        connection.project.id,
      );
      const sessions = await services.developmentServices.publishableSessions(
        connection.project.id,
        connection.session.id,
      );
      if (sessions.length === 0) {
        // `docs/CONNECTOR_PROTOCOL.md` §11: a route no session may use is not
        // published. Saying so here is better than a schema complaint about an
        // array the agent has no way to fill in.
        throw new ApiError(
          "BROWSER_SESSION_NOT_ACTIVE",
          "This project has no browser session for a route to authorise. Start one first.",
        );
      }

      const outcome = await services.developmentServices.publish(
        {
          projectId: connection.project.id,
          organisationId: connection.credential.organisationId,
          connectorId: connector.id,
          workspaceId,
          localHost: (args["local_host"] as string | undefined) ?? "127.0.0.1",
          localPort: args["local_port"] as number,
          protocol: (args["protocol"] as string | undefined) ?? "http",
          ttlSeconds: (args["ttl_seconds"] as number | undefined) ?? DEFAULT_ROUTE_TTL_SECONDS,
          allowedBrowserSessionIds: sessions,
        },
        scopeOf(connection),
        agentActor(connection.session, connection.client.name),
        context.requestId,
      );
      if (outcome.status === "failed" && outcome.failure_class !== null) {
        // One failure, one code, from the connector to the caller
        // (`docs/API.md` §10). The record already carries the class; renaming
        // it here would give the agent a different diagnosis from the audit
        // trail's.
        throw new ApiError(
          outcome.failure_class as ErrorCode,
          "The connector or the tunnel gateway refused this publication.",
          { published_service_id: outcome.id },
        );
      }
      return {
        trust: "trusted_project_configuration",
        data: { service: toDevelopmentServiceView(outcome) },
      };
    },
  },
  {
    name: "development_service_unpublish",
    title: "Revoke a published development service",
    capability: "service:publish",
    stateChanging: true,
    validate: validateDevelopmentServiceUnpublishInput,
    async run(args, context) {
      const revoked = await context.services.developmentServices.revoke(
        args["published_service_id"] as string,
        scopeOf(context.connection),
        agentActor(context.connection.session, context.connection.client.name),
        context.requestId,
      );
      return {
        trust: "trusted_project_configuration",
        data: { service: toDevelopmentServiceView(revoked) },
      };
    },
  },
  {
    name: "task_validation_status",
    title: "What this project requires before the work counts as done",
    capability: "finding:read",
    stateChanging: false,
    validate: validateTaskValidationStatusInput,
    async run(args, context) {
      const evaluation = await evaluateCompletionFor(args, context);
      return {
        // Nothing here came from a page. The response carries identifiers,
        // statuses and requirement labels the control plane composed, and no
        // finding view, no title and no URL — which is why the member holding
        // the per-finding detail is called `finding_states` rather than
        // `findings`, and why this label is honest rather than convenient.
        trust: "trusted_control_plane",
        data: {
          browser_required: evaluation.requirements.required_viewports.length > 0,
          requirements: evaluation.requirements,
          missing: aggregateMissing(evaluation.states),
          assurance: evaluation.assurance,
          finding_states: evaluation.states.map(toCompletionStateView),
        },
      };
    },
  },
  {
    name: "task_complete",
    title: "Evaluate the completion policy and report what remains",
    capability: "finding:read",
    // It records the evaluation, so it takes an idempotency key like every
    // other tool that writes. What it records is an event, never a change to a
    // review or a finding: calling it can move nothing.
    stateChanging: true,
    validate: validateTaskCompleteInput,
    async run(args, context) {
      const evaluation = await evaluateCompletionFor(args, context);
      const result = aggregateCompletionResult(evaluation.states);
      const missing = aggregateMissing(evaluation.states);

      await context.services.reviews.recordCompletionEvaluation(
        context.connection.scope,
        {
          reviewId: evaluation.reviewId,
          ...(args["finding_id"] === undefined
            ? {}
            : { findingId: args["finding_id"] as string }),
          result,
          missing,
          findingCount: evaluation.states.length,
          ...(args["summary"] === undefined
            ? {}
            : { summary: (args["summary"] as string).slice(0, 2000) }),
        },
        agentActor(context.connection.session, context.connection.client.name),
      );

      if (result === "blocked_pending_review") {
        context.warnings.add(
          "completion_blocked_pending_review",
          "Everything available to an agent on this review is done and a human must now decide.",
          "Do not retry this call and do not attempt a further transition; the next move is not one an agent may make.",
        );
      }
      return {
        trust: "trusted_control_plane",
        data: {
          result,
          // Stated rather than implied. The tool's name is the one thing about
          // it that could be misread, and `docs/MCP_SPEC.md` section 7.8
          // requires that it does not terminate the CLI agent.
          terminates_session: false,
          requirements: evaluation.requirements,
          missing,
          assurance: evaluation.assurance,
          next_actions: nextActions(result, evaluation.states),
          finding_states: evaluation.states.map(toCompletionStateView),
        },
      };
    },
  },
];

/** The completion state as the agent-facing schema carries it. */
function toCompletionStateView(state: FindingCompletionState): Record<string, unknown> {
  return {
    finding_id: state.finding_id,
    status: state.status,
    result: state.result,
    missing: [...state.missing],
    ...(state.verification_id === undefined ? {} : { verification_id: state.verification_id }),
    verification_count: state.verification_count,
  };
}

/**
 * The evaluation both completion tools share.
 *
 * They answer the same question and must answer it identically:
 * `task_validation_status` is the read an agent takes before it decides it has
 * finished, and `task_complete` is the same evaluation recorded. If the two
 * could disagree, the read would stop being worth taking.
 *
 * `assurance` is assembled from the **current** verification of the first
 * finding that has one. That is a deliberate simplification of a bounded
 * response rather than an oversight: the per-finding detail carries each
 * finding's own gaps, and the top-level assurance answers "who established the
 * evidence on this work" for a reader who needs one sentence. Where no finding
 * has a verification, both lists are empty and `asserted_by` is absent — which
 * says plainly that nothing has been established rather than implying
 * confirmation by omission.
 */
async function evaluateCompletionFor(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<{
  readonly reviewId: string;
  readonly requirements: CompletionRequirements;
  readonly states: readonly FindingCompletionState[];
  readonly assurance: EvidenceAssurance;
}> {
  const review = await resolveReview(args["review"] as string, context);
  const workspaceBranch = context.connection.workspace?.branch ?? null;
  const evaluation = await context.services.reviews.evaluateCompletion(context.connection.scope, {
    reviewId: review.id,
    ...(args["finding_id"] === undefined ? {} : { findingId: args["finding_id"] as string }),
    workspaceBranch,
  });

  let assurance: EvidenceAssurance = assuranceFor(null);
  for (const state of evaluation.states) {
    if (state.verification_id === undefined) continue;
    const evidence = await context.services.reviews.completionEvidenceFor(
      context.connection.scope,
      state.finding_id,
      workspaceBranch,
    );
    if (evidence === null) continue;
    assurance = assuranceFor(evidence);
    break;
  }

  return {
    reviewId: review.id,
    requirements: evaluation.requirements,
    states: evaluation.states,
    assurance,
  };
}

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** The tool availability set the server advertises (`docs/MCP_SPEC.md` §14). */
export function toolListing(): {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: `${toolResultDescription(tool.name)} ${toolInputDescription(tool.name)}`.trim(),
    inputSchema: toolInputSchema(tool.name),
  }));
}

/** The schema's list and the registered list must be the same list. */
export function assertToolSetMatchesSchema(): void {
  const registered = TOOLS.map((tool) => tool.name).sort();
  const declared = [...MESSAGE_TYPE_VALUES].sort();
  if (JSON.stringify(registered) !== JSON.stringify(declared)) {
    throw new Error(
      `the registered tool set ${JSON.stringify(registered)} is not the schema's availability set ${JSON.stringify(declared)}`,
    );
  }
}

export interface ToolOutcome {
  readonly json: string;
  readonly value: unknown;
  readonly ok: boolean;
  readonly resourceLinks: readonly { uri: string; name: string; mimeType?: string }[];
}

/**
 * Runs one tool call and answers in the envelope.
 *
 * A domain refusal is a successful call reporting `ok: false`, so the agent
 * reads a stable code and decides. Only an unknown tool is a protocol error,
 * because at that point there is no envelope shape to answer in.
 */
export async function callTool(
  name: string,
  args: unknown,
  connection: McpConnection,
  services: McpServices,
): Promise<ToolOutcome> {
  const tool = BY_NAME.get(name as MessageType);
  if (tool === undefined) {
    throw new ApiError("UNSUPPORTED_CAPABILITY", `${name} is not an available tool.`);
  }
  const requestId = `req_${randomUUID().replaceAll("-", "")}`;
  const warnings = new Warnings();
  const views: ViewContext = {
    artefacts: services.artefacts,
    session: connection.session,
    projectSlug: connection.project.slug,
    apiPathPrefix: services.config.apiPathPrefix,
    warnings,
  };
  const context: ToolContext = { connection, services, requestId, warnings, views };

  let scope: Parameters<McpServices["idempotency"]["complete"]>[0] | null = null;
  try {
    let decoded: Record<string, unknown>;
    try {
      decoded = decode(tool.validate, args);
    } catch (violation) {
      // A schema refusal is where the authority boundary is actually crossed
      // for the transitions the enumeration does not contain, so it is where
      // the attempt has to be recorded and where the documented code has to
      // come from. Everything else is re-thrown untouched.
      throw await auditReservedStatusAttempt(tool, args, context, violation);
    }

    if (!connection.session.capabilities.includes(tool.capability)) {
      throw new ApiError(
        "AUTHORISATION_DENIED",
        `This agent session was not granted ${tool.capability}, so it may not call ${tool.name}.`,
      );
    }

    if (tool.stateChanging) {
      const key = decoded["idempotency_key"] as string;
      scope = {
        projectId: connection.project.id,
        actorType: "agent_session",
        actorId: connection.session.id,
        tool: tool.name,
        key,
      };
      const claim = await services.idempotency.claim(scope, requestDigest(decoded));
      if (claim.replayed) {
        // One record, one response: the stored envelope is returned verbatim so
        // a retry cannot observe a second write that never happened.
        const stored = claim.response as { json?: string };
        const json = stored.json ?? JSON.stringify(stored);
        return {
          json,
          value: JSON.parse(json) as unknown,
          ok: true,
          resourceLinks: resourceLinksOf(JSON.parse(json) as Record<string, unknown>),
        };
      }
    }

    const result = await tool.run(decoded, context);
    const envelope = successEnvelope({
      tool: tool.name,
      requestId,
      trust: result.trust,
      data: result.data as never,
      warnings: warnings.list,
    });
    if (scope !== null) await services.idempotency.complete(scope, { json: envelope.json });
    return {
      json: envelope.json,
      value: envelope.value,
      ok: true,
      resourceLinks: resourceLinksOf(envelope.value as Record<string, unknown>),
    };
  } catch (error) {
    // The key is released, so an agent that fixes its arguments and retries with
    // the same key re-runs rather than being handed the refusal for ever.
    //
    // This used to justify itself as "a refused call wrote nothing", which is
    // **false** for `browser_session_start`: by the time a refusal is raised it
    // has already written a session row, a control lease and a
    // `browser_session.requested` event. The behaviour is nonetheless right, and
    // for a different reason — re-running is what a caller that corrected its
    // arguments needs, and the row the first attempt left behind costs the
    // second one nothing. A failed reservation is stamped `FAILED` with
    // `ended_at` set, and the worker capacity query excludes `FAILED` outright,
    // so it holds no slot. `browser_session_allocate` names a reservation that
    // already exists, so it cannot create a second one whatever the key does.
    if (scope !== null) await services.idempotency.release(scope).catch(() => undefined);
    const refusal = refusalFrom(tool.name, requestId, error, warnings.list);
    return { json: refusal.json, value: refusal.value, ok: false, resourceLinks: [] };
  }
}

/**
 * The resource links a response carries, as MCP content blocks.
 *
 * A client that understands `resource_link` gets a first-class reference it can
 * read; a client that does not still has the same identifiers and digests in
 * the envelope text. Neither gets image bytes (`docs/MCP_SPEC.md` section 13).
 */
function resourceLinksOf(value: Record<string, unknown>): {
  uri: string;
  name: string;
  mimeType?: string;
}[] {
  const links: { uri: string; name: string; mimeType?: string }[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const member of node) visit(member);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    const uri = record["resource_uri"];
    if (typeof uri === "string" && typeof record["artefact_id"] === "string") {
      links.push({
        uri,
        name: `${record["kind"] as string} ${record["artefact_id"] as string}`,
        ...(typeof record["content_type"] === "string"
          ? { mimeType: record["content_type"] }
          : {}),
      });
    }
    for (const member of Object.values(record)) visit(member);
  };
  visit(value);
  return links.slice(0, 16);
}
