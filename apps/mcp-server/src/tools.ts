/**
 * The Stage 0 tool catalogue (`docs/MCP_SPEC.md` sections 7.1, 7.4, 7.6, 7.7).
 *
 * The set is exactly `MESSAGE_TYPE_VALUES` from the schema, which is what
 * section 14 calls the tool availability set. Nothing else is registered, so a
 * client discovers the Stage 0 boundary from `tools/list` rather than from a
 * refusal: there is no inbox tool, no development-service tool, no visual
 * inspection, no completion gate, no review listing or search, and — the one
 * that matters most — **no secret tool at all**.
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

import type { BrowserCommand, ControllerIdentity } from "@reviewplane/protocol/browser";
import {
  MESSAGE_TYPE_VALUES,
  type AgentCapability,
  type ArtefactLink,
  type FindingView,
  type MessageType,
  type SchemaViolation,
  type TrustLabel,
} from "@reviewplane/protocol/mcp";
import {
  validateAgentInboxAcknowledgeInput,
  validateAgentInboxListInput,
  validateAgentSessionStatusInput,
  validateBrowserTakeScreenshotInput,
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
  agentTransitionsFrom,
  requestDigest,
  type InboxItemStatus,
  type ReviewListFilter,
} from "@reviewplane/server/domain";

import { STAGE_0_POLICY, type McpConnection, type McpServices } from "./context.ts";
import { Warnings, refusalFrom, successEnvelope } from "./envelope.ts";
import { toolInputDescription, toolInputSchema, toolResultDescription } from "./schemas.ts";
import {
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
  readonly warnings: Warnings;
  readonly views: ViewContext;
}

interface ToolDefinition {
  readonly name: MessageType;
  readonly title: string;
  readonly capability: AgentCapability;
  /** Whether the tool writes. A writing tool requires an idempotency key. */
  readonly stateChanging: boolean;
  readonly validate: Validator;
  readonly run: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolRun>;
}

/** Default bound for a browser command, inside the session's own maximum. */
const SCREENSHOT_TIMEOUT_MS = 30000;

function decode(validate: Validator, args: unknown): Record<string, unknown> {
  const violations: SchemaViolation[] = [];
  validate(args ?? {}, "$", violations);
  if (violations.length === 0) return (args ?? {}) as Record<string, unknown>;
  const first = violations[0] as SchemaViolation;
  throw new ApiError("UNSUPPORTED_CAPABILITY", `${first.path} ${first.message}`, {
    field: first.path,
  });
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
        // The item names human-authored work: a title a human wrote and a
        // review slug. No page-derived member reaches this shape, which is why
        // it is the one review-adjacent response that is not mixed.
        trust: "trusted_human_instruction",
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
        trust: "trusted_human_instruction",
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
      const data: Record<string, unknown> = { review: toReviewView(review, context.views) };
      let pageDerived = false;

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
        if (page.findings.length > 0) {
          pageDerived = true;
          data["findings"] = page.findings.map((finding) => toFindingView(finding, context.views));
        }
        if (page.nextCursor !== null) {
          data["findings_next_cursor"] = encodeCursor(page.nextCursor);
          context.warnings.add(
            "findings_truncated",
            `This review has more findings than one page. Continue with findings_cursor.`,
          );
        }
        if (include.includes("artefact_links")) {
          const links: ArtefactLink[] = [];
          for (const finding of page.findings) {
            const link = await toArtefactLink(finding.screenshot_artefact_id, "before", context.views);
            if (link !== null) links.push(link);
          }
          if (links.length > 0) {
            data["artefact_links"] = links;
            pageDerived = true;
          }
        }
      }

      if (include.includes("comments")) {
        const comments = await context.services.reviews.listCommentsFor(
          context.connection.scope,
          { reviewId: review.id },
          { limit: 20 },
        );
        if (comments.length > 0) data["comments"] = comments.map(toCommentView);
      }

      if (include.includes("staleness")) {
        // The captured context and nothing else. `docs/DOMAIN_MODEL.md`
        // section 24 puts the calculation in Stage 2, so `computed: false` is
        // stated rather than left to be inferred from a missing verdict: an
        // agent must be able to tell "the capture still matches" from "nobody
        // looked", and only one of those is true here.
        const workspace = context.connection.workspace;
        data["staleness"] = {
          computed: false,
          captured_branch: review.captured_branch,
          captured_commit: review.captured_commit,
          ...(workspace === null || workspace.branch === null
            ? {}
            : { workspace_branch: workspace.branch }),
          ...(workspace === null || workspace.head_commit === null
            ? {}
            : { workspace_head_commit: workspace.head_commit }),
        };
        context.warnings.add(
          "staleness_unavailable",
          "This build records the captured branch and commit and computes no staleness verdict.",
          "Reproduce the finding against the current code before changing anything.",
        );
      }

      return {
        trust: trustFor({ pageDerived, humanAuthored: true }),
        data,
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
      return { trust: "trusted_control_plane", data: { comment: toCommentView(comment) } };
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
      const data: Record<string, unknown> = { finding: view };

      if (include.includes("annotations")) {
        const annotations = await context.services.reviews.listAnnotations(
          context.connection.scope,
          findingId,
        );
        if (annotations.length > 0) {
          data["annotations"] = annotations.slice(0, 32).map(toAnnotationView);
        }
      }
      if (include.includes("comments")) {
        const comments = await context.services.reviews.listComments(
          context.connection.scope,
          findingId,
        );
        if (comments.length > 0) data["comments"] = comments.map(toCommentView);
      }
      if (include.includes("artefact_links") && link !== null) data["artefact_links"] = [link];
      if (include.includes("verification")) {
        const verification = await context.services.reviews.latestVerification(
          context.connection.scope,
          findingId,
        );
        if (verification !== null) {
          data["latest_verification"] = await toVerificationView(verification, context.views);
        }
      }
      if (!context.connection.serverCapabilities.image_resources) {
        context.warnings.add(
          "image_content_unsupported",
          "This client declared no image capability, so evidence is returned as links and text.",
          "Read the screenshot:// resource, or fetch content_path with this session's credential.",
        );
      }
      return { trust: trustFor({ pageDerived: true, humanAuthored: true }), data };
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
      return { trust: "trusted_control_plane", data: { comment: toCommentView(comment) } };
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
      const record = await services.browserSessions.get(browserSessionId).catch(() => null);
      if (record === null || record.project_id !== connection.project.id) {
        // Another project's session is not found rather than forbidden: a
        // distinct refusal would confirm the identifier exists.
        throw new ApiError("RESOURCE_NOT_FOUND", "The browser session was not found.");
      }
      if (record.agent_session_id !== null && record.agent_session_id !== connection.session.id) {
        throw new ApiError(
          "AUTHORISATION_DENIED",
          "This browser session belongs to a different agent session.",
        );
      }

      const controller: ControllerIdentity = record.current_controller ?? {
        type: "agent",
        id: connection.session.id,
      };
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
    throw new ApiError("UNSUPPORTED_CAPABILITY", `${name} is not a Stage 0 tool.`);
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
  const context: ToolContext = { connection, services, warnings, views };

  let scope: Parameters<McpServices["idempotency"]["complete"]>[0] | null = null;
  try {
    const decoded = decode(tool.validate, args);

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
