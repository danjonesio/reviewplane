/**
 * The review and finding rules, as pure functions.
 *
 * They live apart from the service because they are the part that must be true
 * regardless of transport. `docs/TESTING.md` section 4 asks for exactly these
 * as unit tests — "agent cannot accept human finding", "accepted review cannot
 * mutate silently", "finding claim uses optimistic version", "review slug
 * uniqueness is project scoped" — and a rule that can only be exercised
 * through an HTTP handler and a database is a rule nobody will exercise.
 *
 * **The tables are not here.** Both status machines, and the authority column
 * that says which actor types may request each transition, are data in
 * `packages/protocol/schemas/review/v1.schema.json` and are read through
 * `@reviewplane/protocol/review` (ADR-0024). This module decides what a
 * violation *means* — which code, which message, which detail a caller needs to
 * recover — and never what the table contains. The MCP layer and the web
 * application read the same table, so a permitted action is derived once rather
 * than restated in three places that can drift.
 *
 * Nothing here touches PostgreSQL, Fastify or the event log.
 */

import {
  ACTIVE_REVIEW_STATUS_VALUES,
  FINDING_TRANSITIONS,
  REVIEW_TRANSITIONS,
  checkGeometryForType,
  findingTransitionsFor,
  isFinalDisposition,
  isFindingTransitionLegal,
  isImmutableReviewStatus,
  isReviewTransitionLegal,
  mayActorMoveFinding,
  mayActorMoveReview,
  reviewStatusesReachableBy,
  transitionsAvailableTo,
  type AnnotationType,
  type FindingSource,
  type FindingStatus,
  type ReviewStatus,
} from "@reviewplane/protocol/review";

import { ApiError } from "../../errors.ts";
import type { ActorType } from "../../events/append.ts";

/**
 * The transitions an agent may perform, as `from:to` labels, read from the
 * authority column of the protocol table rather than restated.
 *
 * The list is short on purpose. It stops at `AWAITING_HUMAN_REVIEW`, which is
 * the product invariant of `AGENTS.md` expressed as data: an agent submits
 * work for review and a human decides. It is exactly the
 * `docs/MCP_SPEC.md` section 7.7 list, and it is exactly that list because both
 * are rendered from one source.
 */
export const AGENT_TRANSITION_LABELS: readonly string[] = findingTransitionsFor("agent_session");

/** The finding transitions available to an agent from one status. */
export function agentTransitionsFrom(status: FindingStatus): string[] {
  return transitionsAvailableTo("agent_session", status, FINDING_TRANSITIONS);
}

/** The review statuses an agent can reach at all (`docs/API.md` section 12). */
export const AGENT_REVIEW_STATUSES: readonly ReviewStatus[] =
  reviewStatusesReachableBy("agent_session");

/** Statuses whose slug still reserves the name inside its project. */
export const ACTIVE_REVIEW_STATUSES: readonly ReviewStatus[] = ACTIVE_REVIEW_STATUS_VALUES;

/** Whether an actor acts with human authority. */
export function isHumanActor(actorType: ActorType): boolean {
  return actorType === "human_user";
}

/**
 * Optimistic concurrency (`docs/API.md` section 13, `docs/MCP_SPEC.md`
 * section 11).
 *
 * The refusal carries the version the record actually holds, so a caller can
 * re-read and retry rather than guess.
 */
export function assertExpectedVersion(current: number, expected: number, what: string): void {
  if (current !== expected) {
    throw new ApiError("VERSION_CONFLICT", `The ${what} changed since it was loaded.`, {
      current_version: current,
      expected_version: expected,
    });
  }
}

export function assertReviewTransition(from: ReviewStatus, to: ReviewStatus): void {
  if (from === to) return;
  if (!isReviewTransitionLegal(from, to)) {
    throw new ApiError("POLICY_DENIED", `A review cannot move from ${from} to ${to}.`, {
      field: "status",
    });
  }
}

/**
 * A closed review is immutable except for archival metadata, comments and an
 * explicit reopen (`docs/DOMAIN_MODEL.md` section 14).
 *
 * "Silently" is the word that matters in the test name: the refusal is
 * explicit and carries a code, rather than the write being dropped or applied
 * to a copy.
 *
 * The two exceptions are the two the section itself names. Archival is metadata
 * about a finished review rather than a change to it. Reopening is the section's
 * own sentence — "reopening an accepted review creates a new review revision or
 * explicit reopen event" — so it is admitted here as a status move on its own
 * and never alongside a field edit: a caller that wanted to retitle an accepted
 * review by reopening it in the same request would have found a way around the
 * rule rather than an exception to it.
 */
export function assertReviewMutable(
  status: ReviewStatus,
  change: { readonly status?: ReviewStatus; readonly fields: readonly string[] },
): void {
  if (!isImmutableReviewStatus(status)) return;
  if (change.fields.length === 0) {
    if (change.status === "ARCHIVED") return;
    if (status === "ACCEPTED" && change.status === "CHANGES_REQUESTED") return;
  }
  throw new ApiError(
    "POLICY_DENIED",
    `A ${status} review is immutable except for archival metadata, comments and an explicit reopen.`,
    { field: change.fields[0] ?? "status" },
  );
}

/**
 * Whether this actor type may request this review transition
 * (`docs/DOMAIN_MODEL.md` section 14, authority column).
 *
 * An agent reaches exactly three of the nine statuses: `ASSIGNED` by claiming,
 * and `IN_PROGRESS` and `AWAITING_HUMAN_REVIEW` by working. `ACCEPTED` is
 * human-only, which is the authority boundary of `AGENTS.md`, and so is every
 * withdrawal and every archival — an agent that could cancel a review could
 * dispose of the human feedback it was given rather than answering it.
 */
export function assertActorMayMoveReview(
  actorType: ActorType,
  from: ReviewStatus,
  to: ReviewStatus,
): void {
  if (from === to) return;
  if (mayActorMoveReview(actorType, from, to)) return;
  if (to === "ACCEPTED") {
    throw new ApiError(
      "AUTHORISATION_DENIED",
      "Only a human may accept a review. An agent submits work for review and a human decides.",
      { field: "status" },
    );
  }
  throw new ApiError(
    "AUTHORISATION_DENIED",
    `A ${actorType} principal may not move a review from ${from} to ${to}.`,
    {
      field: "status",
      allowed_transitions: transitionsAvailableTo(actorType, from, REVIEW_TRANSITIONS),
    },
  );
}

/**
 * A final disposition is a human decision, from **any** status
 * (`docs/DOMAIN_MODEL.md` section 15, `docs/API.md` section 13).
 *
 * This runs before the legality check, and that order is the rule rather than
 * an optimisation. The documents say a final disposition requested by an agent
 * is `AUTHORISATION_DENIED` unconditionally; checking legality first would make
 * the answer depend on where the finding happened to be, so an agent asking to
 * resolve a finding it had actually claimed — from `CLAIMED`, `IN_PROGRESS` or
 * `FIXED_UNVERIFIED` — would be told the *move* was impossible rather than that
 * the *decision* was not its to make. The second answer is the true one, and it
 * is the one an auditor asking "did an agent try to accept this?" needs.
 *
 * It applies to an agent's own finding too. Section 15 permits auto-resolution
 * "by policy if configured", and Stage 1 configures none.
 */
export function assertActorMayDispose(
  actorType: ActorType,
  source: FindingSource,
  to: FindingStatus,
): void {
  if (!isFinalDisposition(to)) return;
  if (isHumanActor(actorType)) return;
  if (actorType === "agent_session" && source === "human") {
    throw new ApiError(
      "AUTHORISATION_DENIED",
      `A human-authored finding cannot be set to ${to} by an agent. Submit verification and mark it AWAITING_HUMAN_REVIEW instead.`,
      { field: "status" },
    );
  }
  throw new ApiError(
    "AUTHORISATION_DENIED",
    `A finding cannot be set to ${to} by a ${actorType} principal. A final disposition is a human decision, and no project policy permits otherwise.`,
    { field: "status" },
  );
}

/**
 * Closing a review is a human decision, from any status
 * (`docs/API.md` section 12: "Only a `human_user` actor may move a review to
 * `ACCEPTED`, `CANCELLED` or `ARCHIVED`").
 *
 * The same reasoning as {@link assertActorMayDispose}, and it runs in the same
 * place: an agent asking to accept a review from a status the lifecycle would
 * not allow anyway should still be told it may not accept reviews, because that
 * is the fact worth auditing.
 */
export function assertActorMayCloseReview(actorType: ActorType, to: ReviewStatus): void {
  if (!CLOSING_REVIEW_STATUSES.includes(to)) return;
  if (isHumanActor(actorType)) return;
  if (to === "ACCEPTED") {
    throw new ApiError(
      "AUTHORISATION_DENIED",
      "Only a human may accept a review. An agent submits work for review and a human decides.",
      { field: "status" },
    );
  }
  throw new ApiError(
    "AUTHORISATION_DENIED",
    `A ${actorType} principal may not move a review to ${to}. Withdrawing or archiving a review disposes of the feedback it carries, which is a human decision.`,
    { field: "status" },
  );
}

/** The review statuses that close a review to further work. */
const CLOSING_REVIEW_STATUSES: readonly ReviewStatus[] = ["ACCEPTED", "CANCELLED", "ARCHIVED"];

export function assertFindingTransition(from: FindingStatus, to: FindingStatus): void {
  if (from === to) return;
  if (!isFindingTransitionLegal(from, to)) {
    throw new ApiError("POLICY_DENIED", `A finding cannot move from ${from} to ${to}.`, {
      field: "status",
    });
  }
}

/**
 * The authority rule of `AGENTS.md` and `docs/DOMAIN_MODEL.md` section 15,
 * enforced in the domain layer rather than in the MCP layer alone.
 *
 * Two separate checks, in this order, because the messages differ and the
 * first is the one a reader needs:
 *
 *   1. an agent may never finally dispose of a **human-authored** finding;
 *   2. an agent may only perform the transitions `docs/MCP_SPEC.md`
 *      section 7.7 lists, whoever authored the finding.
 *
 * The second is why an agent cannot resolve its own finding either: agent
 * findings may be auto-resolved *by policy if configured*, and Stage 0
 * configures no policy, so there is nothing to permit it.
 */
export function assertActorMayMoveFinding(
  actorType: ActorType,
  source: FindingSource,
  from: FindingStatus,
  to: FindingStatus,
): void {
  if (from === to) return;
  if (mayActorMoveFinding(actorType, from, to)) return;

  if (isHumanActor(actorType)) {
    // A human may make every legal transition; reaching here means the pair is
    // not in the table at all, and `assertFindingTransition` has already said
    // so more precisely. Restating it as an authority failure would blame the
    // caller's identity for a request that nobody could make.
    throw new ApiError("POLICY_DENIED", `A finding cannot move from ${from} to ${to}.`, {
      field: "status",
    });
  }

  if (actorType !== "agent_session") {
    // A connector, a worker or an integration observes; it does not decide.
    // Granting them the agent allowlist by default is how a credential meant
    // for uploading a screenshot ends up able to close somebody's finding.
    throw new ApiError(
      "AUTHORISATION_DENIED",
      `A ${actorType} principal may not change the status of a finding.`,
      { field: "status" },
    );
  }

  if (source === "human" && isFinalDisposition(to)) {
    throw new ApiError(
      "AUTHORISATION_DENIED",
      `A human-authored finding cannot be set to ${to} by an agent. Submit verification and mark it AWAITING_HUMAN_REVIEW instead.`,
      { field: "status" },
    );
  }

  if (isFinalDisposition(to)) {
    // An agent's own finding is no different in Stage 1. Section 15 permits
    // auto-resolution "by policy if configured", and no policy is configured,
    // so there is nothing to permit it. The code is the authority one because
    // the refusal is about who is asking rather than about the move.
    throw new ApiError(
      "AUTHORISATION_DENIED",
      `A finding cannot be set to ${to} by an agent. A final disposition is a human decision, and no project policy permits otherwise.`,
      { field: "status", allowed_transitions: agentTransitionsFrom(from) },
    );
  }

  throw new ApiError(
    "POLICY_DENIED",
    `An agent may not move a finding from ${from} to ${to}. No project policy permits it.`,
    { field: "status", allowed_transitions: agentTransitionsFrom(from) },
  );
}

/**
 * Whether a review may be accepted (`docs/API.md` section 12: "Review accept
 * checks that all required human-authored findings are resolved or explicitly
 * waived").
 *
 * Waived means a human moved the finding to `WONT_FIX` or `DUPLICATE`, which
 * are final dispositions and are human decisions in Stage 1. So the rule is one
 * sentence: every human-authored finding must have reached a final disposition.
 * The refusal names the findings that have not, because "some finding is
 * outstanding" is not something a reviewer can act on.
 *
 * Agent-authored findings are deliberately not required. A human accepting a
 * review is judging the feedback they gave; an agent's own note about its work
 * is not a condition of that judgement.
 */
export function assertReviewAcceptable(
  findings: readonly {
    readonly id: string;
    readonly source: FindingSource;
    readonly status: FindingStatus;
  }[],
): void {
  const outstanding = findings.filter(
    (finding) => finding.source === "human" && !isFinalDisposition(finding.status),
  );
  if (outstanding.length === 0) return;
  const first = outstanding[0];
  throw new ApiError(
    "POLICY_DENIED",
    `${String(outstanding.length)} human-authored finding(s) are neither resolved nor explicitly waived, so this review cannot be accepted yet.`,
    {
      field: "findings",
      reason: `finding ${first?.id ?? "unknown"} is ${first?.status ?? "outstanding"}`,
    },
  );
}

/**
 * The commit context a verification claim has to survive
 * (`docs/MCP_SPEC.md` section 7.7: "The server validates evidence ownership,
 * commit context and required policy checks").
 *
 * Two checks, and both are about the claim being *possible* rather than about
 * it being *true* — the artefacts are what make it true.
 *
 * A fix cannot exist at the revision the defect was captured from. If the
 * commit is the same, either nothing was changed or the wrong commit was
 * reported, and both make the evidence unattributable.
 *
 * Where the control plane knows which branch the workspace is on, a claim
 * naming another branch is refused: the agent has told the control plane
 * something it can check, and checking it is the point of recording the
 * workspace at all. Where no workspace is registered the branch is recorded
 * with a warning instead, because an uncorroborated branch is still better
 * evidence than a refused submission with a verified screenshot behind it.
 */
export function assertVerificationCommitContext(input: {
  readonly capturedCommit: string;
  readonly commit: string;
  readonly branch: string;
  readonly workspaceBranch: string | null;
}): { readonly branchCorroborated: boolean } {
  if (input.commit === input.capturedCommit) {
    throw new ApiError(
      "EVIDENCE_REQUIRED",
      "The verification commit is the commit the finding was captured at, so it cannot be the commit that fixed it. Report the commit the change landed in.",
      { field: "commit", required_evidence: ["commit_after_the_change"] },
    );
  }
  if (input.workspaceBranch === null) return { branchCorroborated: false };
  if (input.workspaceBranch !== input.branch) {
    throw new ApiError(
      "EVIDENCE_REQUIRED",
      `The workspace is on branch ${input.workspaceBranch} and the verification claims branch ${input.branch}. Report the workspace state before submitting, or submit from the branch the change is on.`,
      { field: "branch" },
    );
  }
  return { branchCorroborated: true };
}

/**
 * No completion claim without evidence (`AGENTS.md`, `docs/MCP_SPEC.md`
 * section 7.8).
 *
 * Stage 0 holds the note half of that evidence; the after-screenshot half
 * arrives with the verification submission, and the refusal names both so a
 * caller learns the whole requirement rather than discovering it one field at
 * a time.
 */
export function assertCompletionEvidence(
  to: FindingStatus,
  evidence: { readonly resolutionNote?: string | undefined },
): void {
  if (to !== "FIXED_UNVERIFIED") return;
  if (evidence.resolutionNote !== undefined && evidence.resolutionNote.trim() !== "") return;
  throw new ApiError(
    "EVIDENCE_REQUIRED",
    "A finding cannot be claimed fixed without a resolution note describing what was changed and how it was checked.",
    { required_evidence: ["resolution_note", "after_screenshot_artefact"] },
  );
}

/**
 * The captured context of `docs/UX_FLOWS.md` section 9.
 *
 * Element context is deliberately absent from the list: the flow itself marks
 * it "if available", and Stage 0 computes none. Everything else is required,
 * because a finding without it cannot be reproduced once the browser session
 * has gone — which is the whole reason the review outlives the session.
 */
export const REQUIRED_FINDING_CONTEXT: readonly string[] = [
  "url",
  "viewport",
  "viewport.device_scale_factor",
  "scroll_position",
  "captured_commit",
  "screenshot_artefact_id",
];

export function missingCapturedContext(body: Readonly<Record<string, unknown>>): string[] {
  const missing: string[] = [];
  for (const field of REQUIRED_FINDING_CONTEXT) {
    if (field === "viewport.device_scale_factor") {
      const viewport = body["viewport"];
      const present =
        typeof viewport === "object" &&
        viewport !== null &&
        typeof (viewport as Record<string, unknown>)["device_scale_factor"] === "number";
      if (!present) missing.push(field);
      continue;
    }
    const value = body[field];
    if (value === undefined || value === null || value === "") missing.push(field);
  }
  return missing;
}

export function assertCapturedContext(body: Readonly<Record<string, unknown>>): void {
  const missing = missingCapturedContext(body);
  if (missing.length === 0) return;
  throw new ApiError(
    "UNSUPPORTED_CAPABILITY",
    "A finding without its captured context cannot be reproduced later and is refused rather than stored incomplete.",
    { missing_context: missing },
  );
}

/**
 * Geometry validation at the API boundary. Out-of-range values are refused,
 * never clamped (ADR-0006, `docs/DOMAIN_MODEL.md` section 16).
 */
export function assertGeometry(type: AnnotationType, geometry: unknown): void {
  if (typeof geometry !== "object" || geometry === null || Array.isArray(geometry)) {
    throw new ApiError("UNSUPPORTED_CAPABILITY", "geometry must be an object.", {
      field: "geometry",
    });
  }
  const violations = checkGeometryForType(type, geometry as Record<string, unknown>);
  if (violations.length === 0) return;
  const first = violations[0];
  throw new ApiError(
    "UNSUPPORTED_CAPABILITY",
    // The message says what the frame is, because the usual cause is a caller
    // sending CSS pixels or viewport-relative values.
    `${first?.message ?? "geometry is not valid"}. Coordinates are normalised to the artefact content rectangle and must lie between 0 and 1 inclusive.`,
    { field: `geometry.${first?.member ?? "x"}` },
  );
}
