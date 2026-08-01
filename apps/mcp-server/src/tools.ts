/**
 * The tool catalogue (`docs/MCP_SPEC.md` sections 7.1, 7.2, 7.4, 7.6, 7.7).
 *
 * The set is exactly `MESSAGE_TYPE_VALUES` from the schema, which is what
 * section 14 calls the tool availability set. Nothing else is registered, so a
 * client discovers the boundary from `tools/list` rather than from a refusal:
 * there is no inbox tool, no visual inspection, no completion gate, no review
 * listing or search, and — the one that matters most — **no secret tool at
 * all**. The published-service tools of section 7.2 joined the set with RVP-24;
 * they take no connector and no browser-session argument, because a caller that
 * could name either would be choosing which development machine the central
 * browser reaches (`src/development-services.ts`).
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
} from "@reviewplane/protocol/mcp";
import {
  ApiError,
  agentActor,
  type BrowserSessionRecord,
  type ErrorCode,
  agentTransitionsFrom,
  isHumanReservedStatus,
  requestDigest,
  type InboxItemStatus,
  type ReviewListFilter,
} from "@reviewplane/server/domain";

import { STAGE_0_POLICY, type McpConnection, type McpServices } from "./context.ts";
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
 * The browser session an argument named, or the refusal an unknown identifier
 * earns.
 *
 * The order of the two checks is the security property. A session in another
 * project is reported **not found**, byte for byte as an identifier that never
 * existed: a distinct refusal would confirm the identifier exists, which is the
 * enumeration a cross-project caller wants (`docs/API.md` §5). So the project
 * comparison has to come first — a foreign session that happens to belong to
 * another *agent* session must not earn `AUTHORISATION_DENIED`, because that
 * answer says "it exists, but not for you".
 *
 * The project check here is not the one that scopes a command. `runCommand`
 * takes the actor's project and applies the whole `docs/SECURITY.md` §7 matrix
 * itself, which is what makes "browser control commands are project scoped" a
 * property of the call rather than of every caller remembering. This one exists
 * so that reading the record in order to check its *agent session* cannot leak
 * what the service would have refused.
 */
async function resolveBrowserSession(
  browserSessionId: string,
  context: ToolContext,
): Promise<BrowserSessionRecord> {
  const { connection, services } = context;
  const record = await services.browserSessions.get(browserSessionId).catch(() => null);
  if (record === null || record.project_id !== connection.project.id) {
    throw new ApiError("RESOURCE_NOT_FOUND", "The browser session was not found.");
  }
  if (record.agent_session_id !== null && record.agent_session_id !== connection.session.id) {
    throw new ApiError(
      "AUTHORISATION_DENIED",
      "This browser session belongs to a different agent session.",
    );
  }
  return record;
}

/** The controller an agent session acts as (ADR-0007). */
function agentController(context: ToolContext): ControllerIdentity {
  return { type: "agent", id: context.connection.session.id };
}

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
function commandTimeout(args: Record<string, unknown>, record: BrowserSessionRecord): number {
  const requested = (args["timeout_ms"] as number | undefined) ?? record.limits.default_timeout_ms;
  return Math.min(Math.max(requested, 100), record.limits.max_command_timeout_ms);
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
 * The lifecycle rules `BrowserSessionService.terminate` does not apply.
 *
 * `pause` and `resume` go through the service's own `#requireControl`, which
 * compares the epoch and the lease. `terminate` takes an identifier, a reason
 * and an actor and checks none of the three — it is the operator and reconciler
 * path. `docs/MCP_SPEC.md` §7.3 requires the epoch on a lifecycle change for the
 * stated reason that "pausing or ending a browser somebody else now controls is
 * not a lesser act than clicking in it", and the input schema requires
 * `control_epoch` accordingly, so a tool that accepted the epoch and ignored it
 * would be advertising a check it does not perform.
 *
 * This is therefore the one place the tool layer restates a domain rule, and it
 * should stop being so: the right home is a controller-aware termination on
 * `BrowserSessionService`. Until that exists, ending is refused here on exactly
 * the terms the service refuses a pause on, in the same vocabulary and the same
 * order — epoch before lease, so a superseded controller is told the epoch that
 * is current rather than only that it no longer owns the lease.
 */
function requireControlOfSession(
  record: BrowserSessionRecord,
  controlEpoch: number,
  context: ToolContext,
): void {
  if (record.status === "TERMINATED" || record.status === "FAILED") {
    throw new ApiError("BROWSER_SESSION_NOT_ACTIVE", `The browser session is ${record.status}.`);
  }
  if (controlEpoch !== record.control_epoch) {
    throw new ApiError(
      "CONTROL_EPOCH_STALE",
      "Browser control changed. Refresh session state before retrying.",
      { current_epoch: record.control_epoch },
    );
  }
  const controller = record.current_controller;
  const mine = agentController(context);
  if (controller !== null && (controller.type !== mine.type || controller.id !== mine.id)) {
    throw new ApiError(
      "CONTROL_NOT_OWNED",
      "Another controller holds the interactive lease for this browser session.",
      { current_epoch: record.control_epoch },
    );
  }
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
  build: (record: BrowserSessionRecord) => BrowserCommand,
): Promise<{
  readonly record: BrowserSessionRecord;
  readonly result: BrowserCommandResult;
  readonly controlEpoch: number;
}> {
  const { connection, services } = context;
  const browserSessionId = args["browser_session_id"] as string;
  const controlEpoch = args["control_epoch"] as number;
  const record = await resolveBrowserSession(browserSessionId, context);
  const result = await services.browserSessions.runCommand({
    browserSessionId,
    // The **actor's** project, never the session's. Passing the session's own
    // would make the comparison inside the service compare a value with itself.
    projectId: connection.project.id,
    controller: agentController(context),
    controlEpoch,
    command: build(record),
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
  return { record, result, controlEpoch };
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

/** The shared body of the eight interaction tools that are not a snapshot. */
async function interactionRun(
  tool: MessageType,
  command: BrowserCommandName,
  args: Record<string, unknown>,
  context: ToolContext,
  build: (record: BrowserSessionRecord) => BrowserCommand,
): Promise<ToolRun> {
  const { result, controlEpoch } = await runBrowserCommand(args, context, build);
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
      const workspace =
        connection.workspace === null
          ? null
          : await context.services.workspaces.get(connection.workspace.id);
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
            agent_may_accept_findings: STAGE_0_POLICY.agent_may_accept_findings,
            verification_required: STAGE_0_POLICY.verification_required,
            secret_tools_available: STAGE_0_POLICY.secret_tools_available,
            required_viewports: [...STAGE_0_POLICY.required_viewports],
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
      return {
        trust: trustFor({ pageDerived: true, humanAuthored: true }),
        data: {
          verification: await toVerificationView(submitted.verification, context.views),
          finding: toFindingView(submitted.finding, context.views),
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
      const record = await resolveBrowserSession(browserSessionId, context);

      const controller: ControllerIdentity = record.current_controller ?? agentController(context);
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
    title: "Start a central browser session for this agent session",
    capability: "browser:control",
    stateChanging: true,
    validate: validateBrowserSessionStartInput,
    async run(args, context) {
      const { connection, services } = context;
      const actor = agentActor(connection.session, connection.client.name);
      // Reserved and allocated as two steps rather than through `start`, so
      // that a failed allocation can be cleaned up.
      //
      // Allocation reserves the row first, because a route has to be able to
      // name the session it authorises before the session exists. Every way
      // allocation can then fail *before* the worker is contacted — no binder,
      // a published service in another project, one that does not exist —
      // throws out of a reserved `REQUESTED` row, and that row counts against
      // the worker's capacity for ever: `ended_at IS NULL` and a status that is
      // neither `TERMINATED` nor `FAILED`. Four refused starts would fill a
      // default worker, which makes a mistyped identifier a denial of service
      // against the whole project. So the reservation is released here.
      const reserved = await services.browserSessions.create({
        organisationId: connection.credential.organisationId,
        // Neither the project nor the agent session is an argument. A caller
        // that could name either would be starting a browser somewhere it has
        // no authority, and the schema has no member to put them in.
        projectId: connection.project.id,
        agentSessionId: connection.session.id,
        viewport: (args["viewport"] as Viewport | undefined) ?? DEFAULT_VIEWPORT,
        controller: agentController(context),
        // Everything captured in a session an agent started is evidence a human
        // will judge, so it is retained on the evidence window rather than the
        // shorter action-screenshot one (`docs/DEPLOYMENT.md` retention).
        retentionClass: "verification_evidence",
        actor,
      });
      const record = await services.browserSessions
        .allocate({
          browserSessionId: reserved.id,
          ...(args["published_service_id"] === undefined
            ? {}
            : { publishedServiceId: args["published_service_id"] as string }),
          actor,
          requestId: context.requestId,
        })
        .catch(async (error: unknown) => {
          // Best effort, and the refusal the agent reads is the original one:
          // a browser that never opened is not a more interesting failure than
          // the reason it never opened.
          await services.browserSessions.terminate(reserved.id, "failure", actor).catch(() => undefined);
          throw error;
        });
      return {
        // A newly allocated session has been nowhere, so this view is a lease,
        // an epoch and a viewport: control-plane fact throughout.
        trust: "trusted_control_plane",
        data: { session: await toBrowserSessionView(record, context, { includeUrl: false }) },
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
      const record = await resolveBrowserSession(args["browser_session_id"] as string, context);
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
      const record = await resolveBrowserSession(args["browser_session_id"] as string, context);
      const paused = await services.browserSessions.pause({
        browserSessionId: record.id,
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
      const record = await resolveBrowserSession(args["browser_session_id"] as string, context);
      const resumed = await services.browserSessions.resume({
        browserSessionId: record.id,
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
      const record = await resolveBrowserSession(args["browser_session_id"] as string, context);
      requireControlOfSession(record, args["control_epoch"] as number, context);
      const ended = await services.browserSessions.terminate(
        record.id,
        // The agent asked; it is not a capacity, policy or failure termination,
        // and the reason is what the timeline will carry for ever.
        "requested",
        agentActor(connection.session, connection.client.name),
      );
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
      interactionRun("browser_navigate", "navigate", args, context, (record) => ({
        command: "navigate",
        timeout_ms: commandTimeout(args, record),
        navigate: {
          // The URL is passed through unresolved. A root-relative path is
          // resolved against the session's origin by the worker, and an
          // absolute URL outside that origin is refused there — resolving it
          // here would put the egress decision in the process that took the
          // argument (`docs/SECURITY.md` §9).
          url: args["url"] as string,
          wait_until: (args["wait_until"] as WaitUntil | undefined) ?? "domcontentloaded",
        },
      })),
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
      interactionRun("browser_snapshot", "snapshot", args, context, (record) => ({
        command: "snapshot",
        timeout_ms: commandTimeout(args, record),
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
      })),
  },
  {
    name: "browser_click",
    title: "Click one element of the current snapshot",
    capability: "browser:control",
    stateChanging: false,
    validate: validateBrowserElementInput,
    run: (args, context) =>
      interactionRun("browser_click", "click", args, context, (record) => ({
        command: "click",
        timeout_ms: commandTimeout(args, record),
        click: {
          snapshot_id: args["snapshot_id"] as string,
          ref: args["ref"] as string,
        },
      })),
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
      interactionRun("browser_type", "type_text", args, context, (record) => ({
        command: "type_text",
        timeout_ms: commandTimeout(args, record),
        type_text: {
          snapshot_id: args["snapshot_id"] as string,
          ref: args["ref"] as string,
          text: args["text"] as string,
          ...(args["submit"] === undefined ? {} : { submit: args["submit"] as boolean }),
        },
      })),
  },
  {
    name: "browser_select_option",
    title: "Select options of a select element",
    capability: "browser:control",
    stateChanging: false,
    validate: validateBrowserSelectOptionInput,
    run: (args, context) =>
      interactionRun("browser_select_option", "select_option", args, context, (record) => ({
        command: "select_option",
        timeout_ms: commandTimeout(args, record),
        select_option: {
          snapshot_id: args["snapshot_id"] as string,
          ref: args["ref"] as string,
          values: args["values"] as string[],
        },
      })),
  },
  {
    name: "browser_press_key",
    title: "Press one key from the closed key vocabulary",
    capability: "browser:control",
    stateChanging: false,
    validate: validateBrowserPressKeyInput,
    run: (args, context) =>
      interactionRun("browser_press_key", "press_key", args, context, (record) => ({
        command: "press_key",
        timeout_ms: commandTimeout(args, record),
        press_key: {
          key: args["key"] as KeyName,
          ...(args["snapshot_id"] === undefined
            ? {}
            : { snapshot_id: args["snapshot_id"] as string }),
          ...(args["ref"] === undefined ? {} : { ref: args["ref"] as string }),
        },
      })),
  },
  {
    name: "browser_scroll",
    title: "Scroll the page or one element by a bounded distance",
    capability: "browser:control",
    stateChanging: false,
    validate: validateBrowserScrollInput,
    run: (args, context) =>
      interactionRun("browser_scroll", "scroll", args, context, (record) => ({
        command: "scroll",
        timeout_ms: commandTimeout(args, record),
        scroll: {
          direction: args["direction"] as ScrollDirection,
          amount_px: args["amount_px"] as number,
          ...(args["snapshot_id"] === undefined
            ? {}
            : { snapshot_id: args["snapshot_id"] as string }),
          ...(args["ref"] === undefined ? {} : { ref: args["ref"] as string }),
        },
      })),
  },
  {
    name: "browser_resize",
    title: "Resize the viewport and return the snapshot that replaces it",
    capability: "browser:control",
    stateChanging: false,
    validate: validateBrowserResizeInput,
    async run(args, context) {
      const { result, controlEpoch } = await runBrowserCommand(args, context, (record) => ({
        command: "resize",
        timeout_ms: commandTimeout(args, record),
        resize: { viewport: args["viewport"] as Viewport },
      }));
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
      interactionRun("browser_wait", "wait", args, context, (record) => ({
        command: "wait",
        timeout_ms: commandTimeout(args, record),
        wait: {
          condition: args["condition"] as WaitCondition,
          ...(args["url_pattern"] === undefined
            ? {}
            : { url_pattern: args["url_pattern"] as string }),
          ...(args["selector"] === undefined ? {} : { selector: args["selector"] as string }),
          ...(args["text"] === undefined ? {} : { text: args["text"] as string }),
        },
      })),
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
      const workspace = await services.workspaces.get(workspaceId);
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
];

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
    // A refused call wrote nothing, so the key is released: an agent that fixes
    // its arguments and retries with the same key must not be handed the
    // refusal for ever.
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
