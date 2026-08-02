/**
 * The completion gate, as pure functions (`docs/MCP_SPEC.md` section 7.8,
 * ADR-0029).
 *
 * The product's promise is verified before-and-after evidence rather than an
 * agent's assertion that it fixed something, and the gate is where an agent
 * discovers what is still missing **before** it declares a task finished
 * instead of after a human rejects the claim. Four decisions here are
 * load-bearing, and each of them is a rule that could be got subtly wrong
 * without anything failing loudly.
 *
 * **Requirements come from the project.** `required_viewports` is rendered from
 * the project's `default_validation_viewports` (`docs/DOMAIN_MODEL.md`
 * section 6), which defaults to the two viewports `AGENTS.md` requires. A
 * constant here would be a second copy of a configurable rule, and the two
 * would disagree the first time an operator changed one.
 *
 * **What the control plane checked is separated from what an agent claimed.**
 * `checks` is an attestation by the submitting actor: Stage 1 captures no
 * console or network artefact, so there is nothing for the control plane to
 * confirm `console_errors_reviewed` against. Reporting it beside the artefact
 * checks, in one undifferentiated list, would let a reader conclude that the
 * control plane had confirmed an agent's word about its own work — which is
 * exactly the confusion the whole product exists to remove. `assuranceFor`
 * therefore returns two lists and names the actor the second belongs to.
 *
 * **A viewport requirement is about CSS size.** A requirement of `390x844` is
 * satisfied by a capture at `390x844` whatever its device pixel ratio, because
 * testing a phone viewport at a ratio of 2 is more faithful to the device and
 * not less. Where a project deliberately names a ratio, that ratio is required
 * too. Refusing a stricter capture than the one asked for would make the gate
 * reject correct work, and a gate that rejects correct work gets bypassed.
 *
 * **None of the four results terminates anything.** `task_complete` records the
 * evaluation and hands back requirements (`docs/MCP_SPEC.md` section 7.8), and
 * `blocked_pending_review` is the *correct* answer when everything available to
 * an agent is done — not a failure to retry. The enumeration has no member
 * meaning "stopped", so the rule is structural rather than advisory.
 *
 * Nothing here touches PostgreSQL, Fastify or the event log.
 */

import type { CompletionResult } from "@reviewplane/protocol/mcp";
import { formatViewport, type ProjectSettings, type ValidationViewport } from "@reviewplane/protocol/platform";
import type { FindingStatus, VerificationChecks, Viewport } from "@reviewplane/protocol/review";

import type { ActorType } from "../../events/append.ts";

/** What a project requires before work counts as done. */
export interface CompletionRequirements {
  readonly required_viewports: readonly string[];
  readonly console_review: boolean;
  readonly network_review: boolean;
  readonly final_screenshot: boolean;
  readonly accessibility_check: boolean;
}

/** Who established each piece of evidence. */
export interface EvidenceAssurance {
  readonly verified_by_control_plane: readonly string[];
  readonly asserted_by_agent: readonly string[];
  readonly asserted_by?: { readonly type: ActorType; readonly id?: string; readonly display?: string };
}

/** The part of a verification the gate reads. */
export interface EvidenceUnderReview {
  readonly verification_id: string;
  readonly tested_viewports: readonly Viewport[];
  readonly checks: VerificationChecks;
  readonly after_artefact_id: string | null;
  readonly branch_corroborated: boolean;
  readonly submitted_by: { readonly type: ActorType; readonly id?: string; readonly display?: string };
}

/** One finding's standing against the requirements. */
export interface FindingCompletionState {
  readonly finding_id: string;
  readonly status: FindingStatus;
  readonly result: CompletionResult;
  readonly missing: readonly string[];
  readonly warnings: readonly string[];
  readonly verification_id?: string;
  readonly verification_count: number;
}

/**
 * The requirements the project configures.
 *
 * Every flag except `accessibility_check` is true in Stage 1: `AGENTS.md`
 * requires console output and failed network requests to be checked, and a
 * completion claim with no after screenshot is the thing the product exists to
 * refuse. Accessibility is recorded and deliberately **not** required
 * (RVP-53 "Out of scope"), so it never appears in a missing list; it appears in
 * warnings instead, which is what `completed_with_warnings` is for.
 */
export function completionRequirementsFor(settings: ProjectSettings): CompletionRequirements {
  const viewports = settings.default_validation_viewports.map((viewport) => formatViewport(viewport));
  return {
    required_viewports: viewports,
    console_review: true,
    network_review: true,
    final_screenshot: true,
    accessibility_check: false,
  };
}

/**
 * Whether a capture satisfies a required viewport.
 *
 * CSS width and height must match. The device pixel ratio is compared only when
 * the requirement names one other than 1, for the reason in this module's
 * header: a project that asked for `390x844` gets a truer answer from a capture
 * at a ratio of 2 than from one at 1, and refusing it would be a gate rejecting
 * better evidence than it asked for.
 */
export function viewportSatisfies(required: ValidationViewport, tested: Viewport): boolean {
  if (required.width !== tested.width || required.height !== tested.height) return false;
  const requiredScale = required.device_scale_factor ?? 1;
  if (requiredScale === 1) return true;
  return (tested.device_scale_factor ?? 1) === requiredScale;
}

/** The label a missing viewport is reported under, matching `docs/MCP_SPEC.md` section 7.8. */
export function viewportRequirementLabel(viewport: ValidationViewport): string {
  return `${formatViewport(viewport)} verification`;
}

/**
 * Everything a submission does not yet satisfy.
 *
 * A `null` submission is not an error and not an empty answer: it means the
 * whole requirement set is outstanding, which is what an agent that has done no
 * work should be told.
 *
 * The order is the order a reader should act in: evidence the control plane
 * checks first, then the assertions, because an agent that has not captured a
 * screenshot has more to do than one that forgot to tick a box.
 */
export function missingEvidence(
  settings: ProjectSettings,
  requirements: CompletionRequirements,
  evidence: EvidenceUnderReview | null,
): string[] {
  const missing: string[] = [];
  if (evidence === null) {
    if (requirements.final_screenshot) missing.push("after screenshot");
    for (const viewport of settings.default_validation_viewports) {
      missing.push(viewportRequirementLabel(viewport));
    }
    if (requirements.console_review) missing.push("console review");
    if (requirements.network_review) missing.push("network review");
    return missing;
  }

  if (requirements.final_screenshot && evidence.after_artefact_id === null) {
    missing.push("after screenshot");
  }
  for (const viewport of settings.default_validation_viewports) {
    const covered = evidence.tested_viewports.some((tested) => viewportSatisfies(viewport, tested));
    if (!covered) missing.push(viewportRequirementLabel(viewport));
  }
  if (requirements.console_review && evidence.checks.console_errors_reviewed !== true) {
    missing.push("console review");
  }
  if (requirements.network_review && evidence.checks.network_failures_reviewed !== true) {
    missing.push("network review");
  }
  return missing;
}

/**
 * What a submission is short of that is worth saying but not worth refusing.
 *
 * `reproduced_before: false` is the interesting one. It is not required — an
 * agent may legitimately fix something it could not reproduce first — but a
 * human deciding whether to accept the claim should be told, because it is the
 * difference between "this was broken and now is not" and "this looks right".
 */
export function evidenceWarnings(evidence: EvidenceUnderReview | null): string[] {
  if (evidence === null) return [];
  const warnings: string[] = [];
  if (evidence.checks.accessibility_checked !== true) warnings.push("accessibility not checked");
  if (evidence.checks.reproduced_before !== true) warnings.push("defect not reproduced first");
  if (!evidence.branch_corroborated) warnings.push("branch not corroborated by a workspace");
  return warnings;
}

/**
 * The two halves of the evidence, with the actor the second belongs to.
 *
 * `verified_by_control_plane` names only checks this control plane really
 * performed before recording the submission — the ownership, lineage, upload
 * and digest checks in `ReviewService.submitVerification`, the presence of an
 * after screenshot, and the commit and branch context. `asserted_by_agent`
 * names the members of the `checks` object that were true, each of which is
 * the submitter's word and nothing more.
 */
export function assuranceFor(evidence: EvidenceUnderReview | null): EvidenceAssurance {
  if (evidence === null) {
    return { verified_by_control_plane: [], asserted_by_agent: [] };
  }
  const verified: string[] = [
    "artefact project ownership",
    "artefact browser session lineage",
    "artefact upload completed",
    "artefact integrity digest",
    "commit differs from capture",
  ];
  if (evidence.after_artefact_id !== null) verified.push("after screenshot present");
  if (evidence.branch_corroborated) verified.push("branch matches workspace");

  const asserted: string[] = [];
  if (evidence.checks.reproduced_before) asserted.push("reproduced before");
  if (evidence.checks.console_errors_reviewed) asserted.push("console errors reviewed");
  if (evidence.checks.network_failures_reviewed) asserted.push("network failures reviewed");
  if (evidence.checks.accessibility_checked) asserted.push("accessibility checked");

  return {
    verified_by_control_plane: verified,
    asserted_by_agent: asserted,
    asserted_by: evidence.submitted_by,
  };
}

/** The label used when the evidence is complete but nobody has been asked to look. */
export const HUMAN_REVIEW_NOT_REQUESTED = "human review not yet requested";

/**
 * One finding's result.
 *
 * The mapping is deliberately explicit rather than derived from a predicate,
 * because each row is a product statement:
 *
 *   * `RESOLVED` is the only status that means a human accepted the work.
 *   * `WONT_FIX` and `DUPLICATE` are decisions too, but they dispose of a
 *     report without fixing it, so they carry a warning rather than a clean
 *     completion.
 *   * `AWAITING_HUMAN_REVIEW` and `BLOCKED` are both "a human must act next".
 *     Neither is a failure and neither should be retried.
 *   * everything else is work the agent still has, whether that is evidence it
 *     has not gathered or a hand-over it has not requested.
 */
export function findingCompletionState(input: {
  readonly findingId: string;
  readonly status: FindingStatus;
  readonly settings: ProjectSettings;
  readonly requirements: CompletionRequirements;
  readonly evidence: EvidenceUnderReview | null;
  readonly verificationCount: number;
}): FindingCompletionState {
  const missing = missingEvidence(input.settings, input.requirements, input.evidence);
  const warnings = evidenceWarnings(input.evidence);
  const base = {
    finding_id: input.findingId,
    status: input.status,
    verification_count: input.verificationCount,
    ...(input.evidence === null ? {} : { verification_id: input.evidence.verification_id }),
  };

  if (input.status === "RESOLVED") {
    const resolvedWarnings =
      input.evidence === null ? [...warnings, "resolved with no verification on record"] : warnings;
    return {
      ...base,
      result: resolvedWarnings.length === 0 ? "completed" : "completed_with_warnings",
      missing: [],
      warnings: resolvedWarnings,
    };
  }
  if (input.status === "WONT_FIX" || input.status === "DUPLICATE") {
    return {
      ...base,
      result: "completed_with_warnings",
      missing: [],
      warnings: [...warnings, `disposed as ${input.status} without a fix`],
    };
  }
  if (input.status === "AWAITING_HUMAN_REVIEW" || input.status === "BLOCKED") {
    return { ...base, result: "blocked_pending_review", missing: [], warnings };
  }
  return {
    ...base,
    result: "blocked_missing_evidence",
    missing: missing.length === 0 ? [HUMAN_REVIEW_NOT_REQUESTED] : missing,
    warnings,
  };
}

/**
 * The result for a set of findings, worst first.
 *
 * A review with no findings is `completed`: there is nothing outstanding, and
 * saying so is more useful than inventing a warning for an empty set.
 */
export function aggregateCompletionResult(
  states: readonly FindingCompletionState[],
): CompletionResult {
  if (states.some((state) => state.result === "blocked_missing_evidence")) {
    return "blocked_missing_evidence";
  }
  if (states.some((state) => state.result === "blocked_pending_review")) {
    return "blocked_pending_review";
  }
  if (states.some((state) => state.result === "completed_with_warnings")) {
    return "completed_with_warnings";
  }
  return "completed";
}

/** Deduplicated, order-preserving union of every finding's outstanding requirements. */
export function aggregateMissing(states: readonly FindingCompletionState[]): string[] {
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const state of states) {
    for (const item of state.missing) {
      if (seen.has(item)) continue;
      seen.add(item);
      missing.push(item);
    }
  }
  return missing;
}

/**
 * What to do next, in this interface's own vocabulary.
 *
 * A refusal that says only what is wrong makes an agent guess, and a guessing
 * agent retries. The `blocked_pending_review` line is the one that matters
 * most: `docs/MCP_SPEC.md` section 7.8 requires that an agent MUST NOT read it
 * as a failure, and the place to say so is the response itself.
 */
export function nextActions(
  result: CompletionResult,
  states: readonly FindingCompletionState[],
): string[] {
  const actions: string[] = [];
  if (result === "blocked_missing_evidence") {
    const awaiting = states.filter((state) => state.missing.includes(HUMAN_REVIEW_NOT_REQUESTED));
    if (awaiting.length > 0) {
      actions.push("Move each verified finding to AWAITING_HUMAN_REVIEW");
    }
    const evidence = states.filter(
      (state) =>
        state.result === "blocked_missing_evidence" &&
        !state.missing.includes(HUMAN_REVIEW_NOT_REQUESTED),
    );
    if (evidence.length > 0) {
      actions.push("Capture the missing evidence and call finding_submit_verification");
    }
  }
  if (result === "blocked_pending_review") {
    actions.push("Wait for a human decision");
    actions.push("Do not retry this call as though it had failed");
  }
  if (result === "completed" || result === "completed_with_warnings") {
    actions.push("No further agent action is available on this review");
  }
  return actions;
}
