/**
 * Which decisions this surface offers, derived from the shared transition table
 * (ADR-0024).
 *
 * The table and its authority column are protocol data in
 * `packages/protocol/schemas/review/v1.schema.json`, read here through
 * `@reviewplane/protocol/review`. Nothing in this module knows which statuses
 * exist or who may move between them; it knows which *route* corresponds to
 * which target status, which is a fact about `docs/API.md` sections 12 and 13
 * and about nothing else.
 *
 * That separation is the point. A view model that restated "a human may accept
 * a finding awaiting review" would be a third copy of a rule the server and the
 * MCP layer already read from one source, and the copy that drifts is always
 * the one nobody tests. It would also be the copy that reads as authority: a
 * reader who sees an Accept button believes accepting is possible, and if the
 * button appeared because a view model said so rather than because the table
 * did, the belief would be the product's own mistake.
 *
 * **Offering an action is never granting it.** The server refuses every
 * decision it should refuse whether or not a control was rendered
 * (`docs/SECURITY.md` section 7). This module decides what to *show*, so that a
 * reviewer is not offered something that will certainly fail, and it decides
 * nothing else.
 */

import {
  mayActorMoveFinding,
  mayActorMoveReview,
  type ActorType,
  type FindingStatus,
  type ReviewStatus,
} from "@reviewplane/protocol/review";

/** The human decisions on one finding, in the order a reviewer meets them. */
export type FindingDecision = "accept" | "reopen" | "wont-fix";

/** The human decisions on one review. */
export type ReviewDecision = "accept" | "reopen" | "archive" | "request-review";

/**
 * The target status each finding route fixes.
 *
 * The route names the decision and the table decides whether it is possible.
 * `wont-fix` reaches `WONT_FIX`, or `DUPLICATE` when the request also names a
 * duplicate; the two share a route and a legality, so one entry covers both.
 */
const FINDING_TARGET: Readonly<Record<FindingDecision, FindingStatus>> = {
  accept: "RESOLVED",
  reopen: "REOPENED",
  "wont-fix": "WONT_FIX",
};

const REVIEW_TARGET: Readonly<Record<ReviewDecision, ReviewStatus>> = {
  accept: "ACCEPTED",
  reopen: "CHANGES_REQUESTED",
  archive: "ARCHIVED",
  "request-review": "AWAITING_HUMAN_REVIEW",
};

/** What each decision is called where a reader sees it. */
export const FINDING_DECISION_LABEL: Readonly<Record<FindingDecision, string>> = {
  accept: "Accept",
  reopen: "Reopen",
  "wont-fix": "Won't fix",
};

export const REVIEW_DECISION_LABEL: Readonly<Record<ReviewDecision, string>> = {
  accept: "Accept review",
  reopen: "Reopen review",
  archive: "Archive review",
  "request-review": "Request human review",
};

/**
 * The decisions requiring a statement of why (ADR-0036).
 *
 * The server enforces this; naming it here is what lets the form ask before the
 * request rather than after the refusal. The two must agree, and the server is
 * the one that decides — a form that stopped asking would not make the rule go
 * away, it would only make the refusal arrive later.
 */
export const FINDING_DECISION_REQUIRES_REASON: Readonly<Record<FindingDecision, boolean>> = {
  accept: false,
  reopen: true,
  "wont-fix": true,
};

export const REVIEW_DECISION_REQUIRES_REASON: Readonly<Record<ReviewDecision, boolean>> = {
  accept: false,
  reopen: true,
  archive: false,
  "request-review": false,
};

/** The finding decisions this actor may request from this status. */
export function findingDecisionsFrom(
  actorType: ActorType,
  status: FindingStatus,
): FindingDecision[] {
  return (Object.keys(FINDING_TARGET) as FindingDecision[]).filter((decision) =>
    mayActorMoveFinding(actorType, status, FINDING_TARGET[decision]),
  );
}

/** The review decisions this actor may request from this status. */
export function reviewDecisionsFrom(actorType: ActorType, status: ReviewStatus): ReviewDecision[] {
  return (Object.keys(REVIEW_TARGET) as ReviewDecision[]).filter((decision) =>
    mayActorMoveReview(actorType, status, REVIEW_TARGET[decision]),
  );
}

/**
 * Whether a decision on this finding must name the claim it is about
 * (ADR-0035).
 *
 * True exactly when the finding holds a current claim, which is what the
 * control plane checks. A surface that guessed from the status instead would be
 * wrong for a finding whose claim was accepted and then reopened, and the
 * request would be refused for a reason the reader could not see.
 */
export function decisionNeedsClaim(currentVerificationId: string | null): boolean {
  return currentVerificationId !== null;
}
