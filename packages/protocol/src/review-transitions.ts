/**
 * The review and finding transition tables, with their authority column
 * (`docs/DOMAIN_MODEL.md` sections 14 and 15, ADR-0024).
 *
 * The tables themselves are **data**, in
 * `schemas/review/v1.schema.json` under `x-protocol.vocabularies`, and this
 * module is the typed reader for them. That split is the whole point: the
 * control plane, the MCP layer and the web application all need to know which
 * actions are permitted from a given status, and three copies of one rule is
 * three places for it to drift. The schema is the source; nothing below adds a
 * transition, removes one, or decides authority on its own.
 *
 * Two properties are load-bearing.
 *
 * **Absence means refused.** There is no default branch: a pair that is not in
 * the table is not a transition, and an actor type that is not on the entry may
 * not request it. A status machine with an implicit "anything else is fine"
 * arm is not a status machine.
 *
 * **The authority column is separate from the legality column.** A transition
 * can be legal and still be refused for the actor asking, and the two produce
 * different refusals: an illegal transition is a request that makes no sense
 * from here, and an unauthorised one is a request that makes sense and is not
 * this caller's to make. `docs/API.md` section 13 fixes the order the two are
 * checked in, and callers rely on the distinction to tell an agent what it may
 * do instead.
 *
 * This module holds no Node built-in, because `apps/web` derives the actions it
 * offers from the same table the server enforces.
 */

import {
  ACTIVE_REVIEW_STATUSES,
  FINAL_FINDING_DISPOSITIONS,
  FINDING_STATUS_TRANSITIONS,
  IMMUTABLE_REVIEW_STATUSES,
  REVIEW_STATUS_TRANSITIONS,
  type ActorType,
  type FindingStatus,
  type ReviewStatus,
} from "./generated/review/v1/types.ts";

/** One row of a transition table. */
export interface StatusTransition<TStatus extends string> {
  readonly from: TStatus;
  readonly to: TStatus;
  /** Actor types that may request it. Never empty. */
  readonly actorTypes: readonly ActorType[];
}

function parse<TStatus extends string>(
  entries: readonly string[],
  what: string,
): readonly StatusTransition<TStatus>[] {
  return entries.map((entry) => {
    const parts = entry.split(":");
    const [from, to, actors] = parts;
    if (parts.length !== 3 || from === undefined || to === undefined || actors === undefined) {
      // A malformed row would otherwise become a transition nobody may make, or
      // worse, one everybody may. Failing at load is the safe direction.
      throw new Error(
        `schemas/review/v1.schema.json: ${what} entry ${entry} is not from:to:actor_types`,
      );
    }
    const names = actors.split(",");
    if (names.length === 0 || names.some((actor) => actor === "")) {
      throw new Error(`schemas/review/v1.schema.json: ${what} entry ${entry} names no actor type`);
    }
    return { from: from as TStatus, to: to as TStatus, actorTypes: names as ActorType[] };
  });
}

/** The review lifecycle of `docs/DOMAIN_MODEL.md` section 14, as rows. */
export const REVIEW_TRANSITIONS: readonly StatusTransition<ReviewStatus>[] =
  parse<ReviewStatus>(REVIEW_STATUS_TRANSITIONS, "review_status_transitions");

/** The finding lifecycle of `docs/DOMAIN_MODEL.md` section 15, as rows. */
export const FINDING_TRANSITIONS: readonly StatusTransition<FindingStatus>[] =
  parse<FindingStatus>(FINDING_STATUS_TRANSITIONS, "finding_status_transitions");

/** Statuses that finally dispose of a finding. */
export const FINAL_DISPOSITIONS: readonly FindingStatus[] =
  FINAL_FINDING_DISPOSITIONS as readonly FindingStatus[];

/** Statuses whose slug still reserves the project-scoped review name. */
export const ACTIVE_REVIEW_STATUS_VALUES: readonly ReviewStatus[] =
  ACTIVE_REVIEW_STATUSES as readonly ReviewStatus[];

/** Statuses in which a review is closed to ordinary edits. */
export const IMMUTABLE_REVIEW_STATUS_VALUES: readonly ReviewStatus[] =
  IMMUTABLE_REVIEW_STATUSES as readonly ReviewStatus[];

function find<TStatus extends string>(
  table: readonly StatusTransition<TStatus>[],
  from: TStatus,
  to: TStatus,
): StatusTransition<TStatus> | undefined {
  return table.find((row) => row.from === from && row.to === to);
}

/** Whether the lifecycle admits this move at all, whoever is asking. */
export function isReviewTransitionLegal(from: ReviewStatus, to: ReviewStatus): boolean {
  return find(REVIEW_TRANSITIONS, from, to) !== undefined;
}

export function isFindingTransitionLegal(from: FindingStatus, to: FindingStatus): boolean {
  return find(FINDING_TRANSITIONS, from, to) !== undefined;
}

/** Whether this actor type may request a legal move. */
export function mayActorMoveReview(
  actorType: ActorType,
  from: ReviewStatus,
  to: ReviewStatus,
): boolean {
  return find(REVIEW_TRANSITIONS, from, to)?.actorTypes.includes(actorType) ?? false;
}

export function mayActorMoveFinding(
  actorType: ActorType,
  from: FindingStatus,
  to: FindingStatus,
): boolean {
  return find(FINDING_TRANSITIONS, from, to)?.actorTypes.includes(actorType) ?? false;
}

/**
 * What an actor may do from here, as `from:to` labels.
 *
 * A refusal that only says no makes a caller guess, and a guessing agent
 * retries. `docs/MCP_SPEC.md` section 12 requires `details.allowed_transitions`
 * for exactly this reason, and this is what fills it.
 */
export function transitionsAvailableTo(
  actorType: ActorType,
  from: ReviewStatus | FindingStatus,
  table: readonly StatusTransition<string>[],
): string[] {
  return table
    .filter((row) => row.from === from && row.actorTypes.includes(actorType))
    .map((row) => `${row.from}:${row.to}`);
}

/** Every finding transition one actor type may request, as `from:to` labels. */
export function findingTransitionsFor(actorType: ActorType): string[] {
  return FINDING_TRANSITIONS.filter((row) => row.actorTypes.includes(actorType)).map(
    (row) => `${row.from}:${row.to}`,
  );
}

/** Every review status one actor type can reach through a transition. */
export function reviewStatusesReachableBy(actorType: ActorType): ReviewStatus[] {
  const reachable = new Set<ReviewStatus>();
  for (const row of REVIEW_TRANSITIONS) {
    if (row.actorTypes.includes(actorType)) reachable.add(row.to);
  }
  return [...reachable];
}

/** Whether a status still reserves the review's project-scoped slug. */
export function isActiveReviewStatus(status: ReviewStatus): boolean {
  return ACTIVE_REVIEW_STATUS_VALUES.includes(status);
}

/** Whether a status closes a review to ordinary edits. */
export function isImmutableReviewStatus(status: ReviewStatus): boolean {
  return IMMUTABLE_REVIEW_STATUS_VALUES.includes(status);
}

/** Whether a status finally disposes of a finding. */
export function isFinalDisposition(status: FindingStatus): boolean {
  return FINAL_DISPOSITIONS.includes(status);
}
