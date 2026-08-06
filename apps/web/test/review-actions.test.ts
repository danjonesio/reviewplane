/**
 * Which decisions the review workspace offers, and where the answer comes from
 * (ADR-0024, `docs/TESTING.md` section 15).
 *
 * The point of these tests is not that the answers are correct — the protocol
 * table already decides that, and restating its rows here would be a second
 * copy of the thing under test. The point is that the answers are **derived**:
 * every assertion below is written against the table read from
 * `@reviewplane/protocol/review`, so a view model that hard-coded a status list
 * would fail the moment the table and the list disagreed rather than the moment
 * somebody noticed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FINDING_TRANSITIONS,
  REVIEW_TRANSITIONS,
  type FindingStatus,
  type ReviewStatus,
} from "@reviewplane/protocol/review";

import {
  FINDING_DECISION_REQUIRES_REASON,
  REVIEW_DECISION_REQUIRES_REASON,
  decisionNeedsClaim,
  findingDecisionsFrom,
  reviewDecisionsFrom,
} from "../src/review-actions.ts";

/** Every status the finding table names, from either side of a transition. */
function findingStatuses(): FindingStatus[] {
  const seen = new Set<FindingStatus>();
  for (const transition of FINDING_TRANSITIONS) {
    seen.add(transition.from);
    seen.add(transition.to);
  }
  return [...seen];
}

function reviewStatuses(): ReviewStatus[] {
  const seen = new Set<ReviewStatus>();
  for (const transition of REVIEW_TRANSITIONS) {
    seen.add(transition.from);
    seen.add(transition.to);
  }
  return [...seen];
}

test("a decision is offered exactly when the shared table permits it", () => {
  const target = { accept: "RESOLVED", reopen: "REOPENED", "wont-fix": "WONT_FIX" } as const;
  for (const status of findingStatuses()) {
    const offered = new Set(findingDecisionsFrom("human_user", status));
    for (const [decision, to] of Object.entries(target) as [
      keyof typeof target,
      FindingStatus,
    ][]) {
      const permitted = FINDING_TRANSITIONS.some(
        (transition) =>
          transition.from === status &&
          transition.to === to &&
          transition.actorTypes.includes("human_user"),
      );
      assert.equal(
        offered.has(decision),
        permitted,
        `${decision} from ${status}: offered=${String(offered.has(decision))} permitted=${String(permitted)}`,
      );
    }
  }
});

test("an agent is offered no disposition from any status", () => {
  // The product invariant, read out of the table rather than asserted about it.
  // An agent submits verification and requests review; a human decides.
  for (const status of findingStatuses()) {
    assert.deepEqual(
      findingDecisionsFrom("agent_session", status),
      [],
      `an agent must be offered no disposition from ${status}`,
    );
  }
});

test("a human is offered accept and reopen exactly where a finding awaits them", () => {
  // The one row this surface exists for. It is asserted separately from the
  // exhaustive test above because a derivation that returned nothing at all
  // would satisfy that test's negative half everywhere.
  const awaiting = findingDecisionsFrom("human_user", "AWAITING_HUMAN_REVIEW");
  assert.deepEqual([...awaiting].sort(), ["accept", "reopen", "wont-fix"]);

  // And a resolved finding can be sent back but not accepted again.
  assert.deepEqual(findingDecisionsFrom("human_user", "RESOLVED"), ["reopen"]);

  // A finding nobody has worked on cannot be accepted: there is nothing to
  // accept, and the table says so.
  assert.ok(!findingDecisionsFrom("human_user", "OPEN").includes("accept"));
});

test("review decisions come from the review table, including the agent's absence", () => {
  const target = {
    accept: "ACCEPTED",
    reopen: "CHANGES_REQUESTED",
    archive: "ARCHIVED",
    "request-review": "AWAITING_HUMAN_REVIEW",
  } as const;
  for (const status of reviewStatuses()) {
    const offered = new Set(reviewDecisionsFrom("human_user", status));
    for (const [decision, to] of Object.entries(target) as [
      keyof typeof target,
      ReviewStatus,
    ][]) {
      const permitted = REVIEW_TRANSITIONS.some(
        (transition) =>
          transition.from === status &&
          transition.to === to &&
          transition.actorTypes.includes("human_user"),
      );
      assert.equal(offered.has(decision), permitted, `${decision} from ${status}`);
    }
    assert.ok(
      !reviewDecisionsFrom("agent_session", status).includes("accept"),
      `an agent must never be offered review acceptance from ${status}`,
    );
    assert.ok(!reviewDecisionsFrom("agent_session", status).includes("archive"));
  }
});

test("reopen and wont-fix require a reason and accept does not", () => {
  // ADR-0036. The form asks because the server requires; the two agree here so
  // that a reviewer is told what is needed rather than refused for it.
  assert.equal(FINDING_DECISION_REQUIRES_REASON.reopen, true);
  assert.equal(FINDING_DECISION_REQUIRES_REASON["wont-fix"], true);
  assert.equal(FINDING_DECISION_REQUIRES_REASON.accept, false);
  assert.equal(REVIEW_DECISION_REQUIRES_REASON.reopen, true);
  assert.equal(REVIEW_DECISION_REQUIRES_REASON.accept, false);
});

test("a decision names a claim exactly when the finding holds one", () => {
  // ADR-0035. Derived from the claim the page rendered rather than guessed from
  // the status: a finding whose claim was accepted and then reopened holds
  // none, and a surface reasoning from the status would send an identifier the
  // control plane refuses.
  assert.equal(decisionNeedsClaim("ver_abc"), true);
  assert.equal(decisionNeedsClaim(null), false);
});
