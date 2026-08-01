/**
 * The completion gate as pure functions (`docs/TESTING.md` section 2 "Unit",
 * section 4 "Domain": "Verification requires evidence under policy";
 * section 8 "Completion-gate missing evidence response").
 *
 * None of these needs a database, and each is a rule that could be got subtly
 * wrong without anything failing loudly — a viewport comparison that is too
 * strict rejects correct work, one that is too loose lets an unchecked viewport
 * through, and neither shows up as an error.
 *
 * The stateful half — a real submission, supersession, the gated transition and
 * the database backstop — is in `verification-evidence.test.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { COMPLETION_RESULT_VALUES } from "@reviewplane/protocol/mcp";
import { DEFAULT_VALIDATION_VIEWPORTS, type ProjectSettings } from "@reviewplane/protocol/platform";
import type { VerificationChecks, Viewport } from "@reviewplane/protocol/review";

import {
  ApiError,
  HUMAN_REVIEW_NOT_REQUESTED,
  aggregateCompletionResult,
  aggregateMissing,
  assertCompletionEvidence,
  assuranceFor,
  completionRequirementsFor,
  evidenceWarnings,
  findingCompletionState,
  missingEvidence,
  nextActions,
  viewportSatisfies,
  type EvidenceUnderReview,
  type FindingCompletionState,
} from "../src/domain.ts";

const DEFAULT_SETTINGS: ProjectSettings = {
  default_validation_viewports: DEFAULT_VALIDATION_VIEWPORTS.map((viewport) => ({ ...viewport })),
};

const COMPLETE_CHECKS: VerificationChecks = {
  reproduced_before: true,
  console_errors_reviewed: true,
  network_failures_reviewed: true,
  accessibility_checked: true,
};

function evidence(overrides: Partial<EvidenceUnderReview> = {}): EvidenceUnderReview {
  return {
    verification_id: "ver_one",
    tested_viewports: [
      { width: 390, height: 844, device_scale_factor: 2 },
      { width: 1440, height: 900, device_scale_factor: 1 },
    ] as Viewport[],
    checks: COMPLETE_CHECKS,
    after_artefact_id: "art_after",
    branch_corroborated: true,
    submitted_by: { type: "agent_session", id: "ags_one", display: "claude-code" },
    ...overrides,
  };
}

function refusal(run: () => void): ApiError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected an ApiError, got ${String(error)}`);
    return error;
  }
  assert.fail("the call was permitted");
}

// ---------------------------------------------------------------- requirements

test("requirements come from the project's viewports, not from a constant", () => {
  // docs/DOMAIN_MODEL.md section 6: default_validation_viewports is a project
  // setting. A gate holding its own copy would demand the defaults from a
  // project that had chosen something else.
  const defaults = completionRequirementsFor(DEFAULT_SETTINGS);
  assert.deepEqual([...defaults.required_viewports], ["390x844", "1440x900"]);

  const narrow = completionRequirementsFor({
    default_validation_viewports: [{ width: 1280, height: 720 }],
  });
  assert.deepEqual([...narrow.required_viewports], ["1280x720"]);

  // A device pixel ratio the project asked for is part of the label, so the
  // agent is told what it must actually do.
  const retina = completionRequirementsFor({
    default_validation_viewports: [{ width: 390, height: 844, device_scale_factor: 3 }],
  });
  assert.deepEqual([...retina.required_viewports], ["390x844@3x"]);
});

test("accessibility is recorded and never required", () => {
  // RVP-53 "Out of scope": accessibility_checked is recorded but not enforced.
  // It must therefore never appear in a missing list, and must appear in
  // warnings, which is what completed_with_warnings exists for.
  const requirements = completionRequirementsFor(DEFAULT_SETTINGS);
  assert.equal(requirements.accessibility_check, false);

  const unchecked = evidence({ checks: { ...COMPLETE_CHECKS, accessibility_checked: false } });
  assert.deepEqual(missingEvidence(DEFAULT_SETTINGS, requirements, unchecked), []);
  assert.ok(evidenceWarnings(unchecked).includes("accessibility not checked"));
});

// ------------------------------------------------------------------- viewports

test("a viewport requirement is about CSS size, and a stricter capture satisfies it", () => {
  // A project asking for 390x844 gets a truer answer from a capture at a device
  // pixel ratio of 2 than from one at 1. Refusing the stricter capture would be
  // a gate rejecting better evidence than it asked for.
  assert.equal(
    viewportSatisfies({ width: 390, height: 844 }, { width: 390, height: 844, device_scale_factor: 2 }),
    true,
  );
  assert.equal(
    viewportSatisfies({ width: 390, height: 844 }, { width: 390, height: 844, device_scale_factor: 1 }),
    true,
  );

  // A different CSS size never satisfies it, in either direction. A larger
  // viewport is not a superset: the defect this product exists to catch is a
  // layout that breaks at one width and not another.
  assert.equal(
    viewportSatisfies({ width: 390, height: 844 }, { width: 391, height: 844, device_scale_factor: 1 }),
    false,
  );
  assert.equal(
    viewportSatisfies({ width: 390, height: 844 }, { width: 1440, height: 900, device_scale_factor: 1 }),
    false,
  );
  assert.equal(
    viewportSatisfies({ width: 390, height: 844 }, { width: 390, height: 845, device_scale_factor: 1 }),
    false,
  );

  // Where the project deliberately names a ratio, that ratio is required too.
  assert.equal(
    viewportSatisfies(
      { width: 390, height: 844, device_scale_factor: 3 },
      { width: 390, height: 844, device_scale_factor: 2 },
    ),
    false,
  );
  assert.equal(
    viewportSatisfies(
      { width: 390, height: 844, device_scale_factor: 3 },
      { width: 390, height: 844, device_scale_factor: 3 },
    ),
    true,
  );
});

// -------------------------------------------------------------- missing lists

test("no submission means the whole requirement set is outstanding", () => {
  const requirements = completionRequirementsFor(DEFAULT_SETTINGS);
  assert.deepEqual(missingEvidence(DEFAULT_SETTINGS, requirements, null), [
    "after screenshot",
    "390x844 verification",
    "1440x900 verification",
    "console review",
    "network review",
  ]);
});

test("the missing list names one absent viewport in the shape docs/MCP_SPEC.md section 7.8 prints", () => {
  const requirements = completionRequirementsFor(DEFAULT_SETTINGS);
  const mobileOnly = evidence({
    tested_viewports: [{ width: 1440, height: 900, device_scale_factor: 1 }] as Viewport[],
  });
  assert.deepEqual(missingEvidence(DEFAULT_SETTINGS, requirements, mobileOnly), [
    "390x844 verification",
  ]);
});

test("an unticked agent assertion is missing evidence, and a missing screenshot is too", () => {
  const requirements = completionRequirementsFor(DEFAULT_SETTINGS);
  const unreviewed = evidence({
    checks: { ...COMPLETE_CHECKS, console_errors_reviewed: false, network_failures_reviewed: false },
    after_artefact_id: null,
  });
  assert.deepEqual(missingEvidence(DEFAULT_SETTINGS, requirements, unreviewed), [
    "after screenshot",
    "console review",
    "network review",
  ]);
});

test("a complete submission is missing nothing", () => {
  const requirements = completionRequirementsFor(DEFAULT_SETTINGS);
  assert.deepEqual(missingEvidence(DEFAULT_SETTINGS, requirements, evidence()), []);
});

// -------------------------------------------------------------------- assurance

test("the gate never presents an agent's checks as control-plane verification", () => {
  // The invariant this issue exists to keep honest. Stage 1 captures no console
  // or network artefact, so there is nothing for the control plane to confirm
  // console_errors_reviewed against; reporting it beside the artefact checks in
  // one list would let a reader conclude it had been.
  const assurance = assuranceFor(evidence());
  for (const claim of [
    "reproduced before",
    "console errors reviewed",
    "network failures reviewed",
    "accessibility checked",
  ]) {
    assert.ok(assurance.asserted_by_agent.includes(claim), `${claim} is not recorded as a claim`);
    assert.ok(
      !assurance.verified_by_control_plane.includes(claim),
      `${claim} is presented as control-plane verification`,
    );
  }
  // And the claim names whose it is.
  assert.deepEqual(assurance.asserted_by, {
    type: "agent_session",
    id: "ags_one",
    display: "claude-code",
  });

  // The control-plane half names only checks the control plane really made.
  assert.ok(assurance.verified_by_control_plane.includes("artefact integrity digest"));
  assert.ok(assurance.verified_by_control_plane.includes("commit differs from capture"));
});

test("with nothing submitted, both assurance lists are empty and no actor is named", () => {
  // Silence must not read as confirmation. An absent asserted_by is the honest
  // shape for "nobody has claimed anything", and an empty verified list is the
  // honest shape for "the control plane has checked nothing".
  const none = assuranceFor(null);
  assert.deepEqual([...none.verified_by_control_plane], []);
  assert.deepEqual([...none.asserted_by_agent], []);
  assert.equal(none.asserted_by, undefined);
});

test("an unticked check is absent from the asserted list rather than asserted as false", () => {
  const partial = assuranceFor(
    evidence({ checks: { ...COMPLETE_CHECKS, console_errors_reviewed: false } }),
  );
  assert.ok(!partial.asserted_by_agent.includes("console errors reviewed"));
  assert.ok(partial.asserted_by_agent.includes("network failures reviewed"));
});

test("an uncorroborated branch is a warning on the claim, not a control-plane check", () => {
  const uncorroborated = assuranceFor(evidence({ branch_corroborated: false }));
  assert.ok(!uncorroborated.verified_by_control_plane.includes("branch matches workspace"));
  assert.ok(
    evidenceWarnings(evidence({ branch_corroborated: false })).includes(
      "branch not corroborated by a workspace",
    ),
  );
});

// ----------------------------------------------------------------- result selection

test("each status maps to the documented result", () => {
  const requirements = completionRequirementsFor(DEFAULT_SETTINGS);
  const evaluate = (
    status: Parameters<typeof findingCompletionState>[0]["status"],
    supplied: EvidenceUnderReview | null = evidence(),
  ): FindingCompletionState =>
    findingCompletionState({
      findingId: "fin_one",
      status,
      settings: DEFAULT_SETTINGS,
      requirements,
      evidence: supplied,
      verificationCount: supplied === null ? 0 : 1,
    });

  assert.equal(evaluate("RESOLVED").result, "completed");
  assert.equal(evaluate("WONT_FIX").result, "completed_with_warnings");
  assert.equal(evaluate("DUPLICATE").result, "completed_with_warnings");
  assert.equal(evaluate("AWAITING_HUMAN_REVIEW").result, "blocked_pending_review");
  // BLOCKED is a human's move next, exactly like AWAITING_HUMAN_REVIEW, and is
  // not an agent failure to retry.
  assert.equal(evaluate("BLOCKED").result, "blocked_pending_review");
  for (const status of ["OPEN", "CLAIMED", "IN_PROGRESS", "REOPENED", "FIXED_UNVERIFIED"] as const) {
    assert.equal(evaluate(status, null).result, "blocked_missing_evidence", status);
  }
});

test("evidence complete but not handed over is blocked with an actionable gap", () => {
  // The case that would otherwise report "blocked_missing_evidence" with an
  // empty missing list, which says nothing an agent can act on.
  const requirements = completionRequirementsFor(DEFAULT_SETTINGS);
  const state = findingCompletionState({
    findingId: "fin_one",
    status: "FIXED_UNVERIFIED",
    settings: DEFAULT_SETTINGS,
    requirements,
    evidence: evidence(),
    verificationCount: 1,
  });
  assert.equal(state.result, "blocked_missing_evidence");
  assert.deepEqual([...state.missing], [HUMAN_REVIEW_NOT_REQUESTED]);
  assert.deepEqual(nextActions(state.result, [state]), [
    "Move each verified finding to AWAITING_HUMAN_REVIEW",
  ]);
});

test("a finding resolved with no verification on record is completed with a warning", () => {
  const requirements = completionRequirementsFor(DEFAULT_SETTINGS);
  const state = findingCompletionState({
    findingId: "fin_one",
    status: "RESOLVED",
    settings: DEFAULT_SETTINGS,
    requirements,
    evidence: null,
    verificationCount: 0,
  });
  assert.equal(state.result, "completed_with_warnings");
  assert.ok(state.warnings.includes("resolved with no verification on record"));
});

test("the aggregate is the worst result present, and an empty review is completed", () => {
  const state = (result: FindingCompletionState["result"]): FindingCompletionState => ({
    finding_id: `fin_${result}`,
    status: "OPEN",
    result,
    missing: [],
    warnings: [],
    verification_count: 0,
  });
  assert.equal(aggregateCompletionResult([]), "completed");
  assert.equal(aggregateCompletionResult([state("completed")]), "completed");
  assert.equal(
    aggregateCompletionResult([state("completed"), state("completed_with_warnings")]),
    "completed_with_warnings",
  );
  assert.equal(
    aggregateCompletionResult([state("completed_with_warnings"), state("blocked_pending_review")]),
    "blocked_pending_review",
  );
  assert.equal(
    aggregateCompletionResult([state("blocked_pending_review"), state("blocked_missing_evidence")]),
    "blocked_missing_evidence",
  );
});

test("the aggregate missing list deduplicates and keeps the order it was found in", () => {
  const withMissing = (id: string, missing: string[]): FindingCompletionState => ({
    finding_id: id,
    status: "IN_PROGRESS",
    result: "blocked_missing_evidence",
    missing,
    warnings: [],
    verification_count: 0,
  });
  assert.deepEqual(
    aggregateMissing([
      withMissing("fin_a", ["after screenshot", "390x844 verification"]),
      withMissing("fin_b", ["390x844 verification", "console review"]),
    ]),
    ["after screenshot", "390x844 verification", "console review"],
  );
});

test("no completion result can express termination", () => {
  // docs/MCP_SPEC.md section 7.8: task_complete does not terminate the CLI
  // agent. The enumeration is where that is made unsayable.
  assert.equal(COMPLETION_RESULT_VALUES.length, 4);
  for (const result of COMPLETION_RESULT_VALUES) {
    assert.doesNotMatch(result, /terminat|abort|stop|exit|kill/u, result);
  }
  assert.deepEqual(nextActions("blocked_pending_review", []), [
    "Wait for a human decision",
    "Do not retry this call as though it had failed",
  ]);
});

// --------------------------------------------------------------- the gate itself

test("an agent cannot request human review until the evidence is complete", () => {
  // docs/TESTING.md section 4: "Verification requires evidence under policy".
  const denial = refusal(() => {
    assertCompletionEvidence("AWAITING_HUMAN_REVIEW", {
      actorType: "agent_session",
      missing: ["390x844 verification"],
    });
  });
  assert.equal(denial.code, "EVIDENCE_REQUIRED");
  assert.deepEqual(
    (denial.details as Record<string, unknown>)["required_evidence"],
    ["390x844 verification"],
  );
  // The refusal names the whole gap rather than the first item, so a caller
  // learns the requirement in one round trip instead of discovering it one
  // field at a time.
  const both = refusal(() => {
    assertCompletionEvidence("AWAITING_HUMAN_REVIEW", {
      actorType: "agent_session",
      missing: ["390x844 verification", "console review"],
    });
  });
  assert.deepEqual(
    (both.details as Record<string, unknown>)["required_evidence"],
    ["390x844 verification", "console review"],
  );
});

test("an agent with complete evidence may request human review", () => {
  assertCompletionEvidence("AWAITING_HUMAN_REVIEW", {
    actorType: "agent_session",
    missing: [],
  });
});

test("the evidence gate does not overrule a human's own judgement", () => {
  // ADR-0029. A human moving a finding to AWAITING_HUMAN_REVIEW is exercising
  // the very authority the gate defers to. This is stated as a decision rather
  // than left implicit, because it is the one place the gate is deliberately
  // narrower than it could be — and nothing is weakened by it, since before
  // this rule there was no gate on this transition for anybody.
  assertCompletionEvidence("AWAITING_HUMAN_REVIEW", {
    actorType: "human_user",
    missing: ["390x844 verification", "after screenshot"],
  });
});

test("the resolution-note gate on FIXED_UNVERIFIED is unchanged", () => {
  // Regression: RVP-37 shipped this and it must keep behaving identically for
  // every actor type.
  for (const actorType of ["agent_session", "human_user"] as const) {
    const denial = refusal(() => {
      assertCompletionEvidence("FIXED_UNVERIFIED", { actorType });
    });
    assert.equal(denial.code, "EVIDENCE_REQUIRED");
    const blank = refusal(() => {
      assertCompletionEvidence("FIXED_UNVERIFIED", { actorType, resolutionNote: "   " });
    });
    assert.equal(blank.code, "EVIDENCE_REQUIRED");
    assertCompletionEvidence("FIXED_UNVERIFIED", {
      actorType,
      resolutionNote: "Changed the collapse breakpoint to 900px.",
    });
  }
});

test("the gate applies to no other transition", () => {
  // A gate that fired on an unrelated move would block ordinary work. Every
  // status an agent may reach other than the two above passes untouched, with
  // or without evidence.
  for (const to of ["CLAIMED", "IN_PROGRESS", "BLOCKED", "REOPENED"] as const) {
    assertCompletionEvidence(to, { actorType: "agent_session", missing: ["after screenshot"] });
  }
});
