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
 * Nothing here touches PostgreSQL, Fastify or the event log.
 */

import {
  checkGeometryForType,
  type AnnotationType,
  type FindingSource,
  type FindingStatus,
  type ReviewStatus,
} from "@reviewplane/protocol/review";

import { ApiError } from "../../errors.ts";
import type { ActorType } from "../../events.ts";

/**
 * Review transitions. Absent from this table means refused: a status machine
 * with an implicit "anything else is fine" branch is not a status machine.
 */
const REVIEW_TRANSITIONS: Readonly<Record<ReviewStatus, readonly ReviewStatus[]>> = {
  DRAFT: ["READY", "CANCELLED"],
  READY: ["ASSIGNED", "DRAFT", "CANCELLED"],
  ASSIGNED: ["IN_PROGRESS", "READY", "CANCELLED"],
  IN_PROGRESS: ["AWAITING_HUMAN_REVIEW", "CHANGES_REQUESTED", "CANCELLED"],
  AWAITING_HUMAN_REVIEW: ["ACCEPTED", "CHANGES_REQUESTED", "CANCELLED"],
  CHANGES_REQUESTED: ["IN_PROGRESS", "ASSIGNED", "CANCELLED"],
  ACCEPTED: ["ARCHIVED"],
  CANCELLED: ["ARCHIVED"],
  ARCHIVED: [],
};

/** Finding transitions (`docs/DOMAIN_MODEL.md` section 15). */
const FINDING_TRANSITIONS: Readonly<Record<FindingStatus, readonly FindingStatus[]>> = {
  OPEN: ["CLAIMED", "IN_PROGRESS", "BLOCKED", "WONT_FIX", "DUPLICATE"],
  CLAIMED: ["IN_PROGRESS", "BLOCKED", "OPEN"],
  IN_PROGRESS: ["FIXED_UNVERIFIED", "BLOCKED", "AWAITING_HUMAN_REVIEW"],
  BLOCKED: ["IN_PROGRESS", "OPEN"],
  FIXED_UNVERIFIED: ["AWAITING_HUMAN_REVIEW", "IN_PROGRESS"],
  AWAITING_HUMAN_REVIEW: ["RESOLVED", "REOPENED"],
  RESOLVED: ["REOPENED"],
  REOPENED: ["CLAIMED", "IN_PROGRESS"],
  WONT_FIX: ["REOPENED"],
  DUPLICATE: ["REOPENED"],
};

/**
 * The transitions an agent may perform, taken verbatim from
 * `docs/MCP_SPEC.md` section 7.7. Everything else is human-only.
 *
 * The list is short on purpose. It stops at `awaiting_human_review`, which is
 * the product invariant of `AGENTS.md` expressed as data: an agent submits
 * work for review and a human decides.
 */
const AGENT_TRANSITIONS: readonly (readonly [FindingStatus, FindingStatus])[] = [
  ["OPEN", "CLAIMED"],
  ["CLAIMED", "IN_PROGRESS"],
  ["IN_PROGRESS", "BLOCKED"],
  ["IN_PROGRESS", "FIXED_UNVERIFIED"],
  ["FIXED_UNVERIFIED", "AWAITING_HUMAN_REVIEW"],
  ["REOPENED", "IN_PROGRESS"],
];

/**
 * The same list rendered as `from:to`, for a refusal that tells a caller what
 * it *can* do. A refusal that only says no makes an agent guess.
 */
export const AGENT_TRANSITION_LABELS: readonly string[] = AGENT_TRANSITIONS.map(
  ([from, to]) => `${from}:${to}`,
);

/** The transitions available from one status, for the same purpose. */
export function agentTransitionsFrom(status: FindingStatus): string[] {
  return AGENT_TRANSITIONS.filter(([from]) => from === status).map(
    ([from, to]) => `${from}:${to}`,
  );
}

/**
 * Statuses that finally dispose of a finding. Reaching one is a decision about
 * whether the reported problem was real, which is the decision
 * `docs/DOMAIN_MODEL.md` section 15 reserves to a human for a human-authored
 * finding.
 */
const FINAL_DISPOSITIONS: readonly FindingStatus[] = ["RESOLVED", "WONT_FIX", "DUPLICATE"];

/** Statuses in which a review is closed to ordinary edits. */
const IMMUTABLE_REVIEW_STATUSES: readonly ReviewStatus[] = ["ACCEPTED", "CANCELLED", "ARCHIVED"];

/** Statuses whose slug still reserves the name inside its project. */
export const ACTIVE_REVIEW_STATUSES: readonly ReviewStatus[] = [
  "DRAFT",
  "READY",
  "ASSIGNED",
  "IN_PROGRESS",
  "AWAITING_HUMAN_REVIEW",
  "CHANGES_REQUESTED",
  "ACCEPTED",
];

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
  if (!REVIEW_TRANSITIONS[from].includes(to)) {
    throw new ApiError("POLICY_DENIED", `A review cannot move from ${from} to ${to}.`, {
      field: "status",
    });
  }
}

/**
 * An accepted review is immutable except for archival metadata
 * (`docs/DOMAIN_MODEL.md` section 14).
 *
 * "Silently" is the word that matters in the test name: the refusal is
 * explicit and carries a code, rather than the write being dropped or applied
 * to a copy.
 */
export function assertReviewMutable(
  status: ReviewStatus,
  change: { readonly status?: ReviewStatus; readonly fields: readonly string[] },
): void {
  if (!IMMUTABLE_REVIEW_STATUSES.includes(status)) return;
  const archivalOnly = change.status === "ARCHIVED" && change.fields.length === 0;
  if (archivalOnly) return;
  throw new ApiError(
    "POLICY_DENIED",
    `A ${status} review is immutable except for archival metadata.`,
    { field: change.fields[0] ?? "status" },
  );
}

/** Only a human may accept a review. */
export function assertActorMayMoveReview(
  actorType: ActorType,
  to: ReviewStatus,
): void {
  if (to === "ACCEPTED" && !isHumanActor(actorType)) {
    throw new ApiError(
      "AUTHORISATION_DENIED",
      "Only a human may accept a review. An agent submits work for review and a human decides.",
      { field: "status" },
    );
  }
}

export function assertFindingTransition(from: FindingStatus, to: FindingStatus): void {
  if (from === to) return;
  if (!FINDING_TRANSITIONS[from].includes(to)) {
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
  if (isHumanActor(actorType)) return;

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

  if (source === "human" && FINAL_DISPOSITIONS.includes(to)) {
    throw new ApiError(
      "AUTHORISATION_DENIED",
      `A human-authored finding cannot be set to ${to} by an agent. Submit verification and mark it AWAITING_HUMAN_REVIEW instead.`,
      { field: "status" },
    );
  }

  const permitted = AGENT_TRANSITIONS.some(([left, right]) => left === from && right === to);
  if (!permitted) {
    throw new ApiError(
      "POLICY_DENIED",
      `An agent may not move a finding from ${from} to ${to}. No project policy permits it.`,
      { field: "status", allowed_transitions: agentTransitionsFrom(from) },
    );
  }
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
