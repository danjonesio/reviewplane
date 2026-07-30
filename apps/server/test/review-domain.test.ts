/**
 * The domain rules of `docs/TESTING.md` section 4, exercised without a
 * database or an HTTP server.
 *
 * "Agent cannot accept human finding" is the one that matters most. It is a
 * product invariant of `AGENTS.md`, and testing it only through the MCP layer
 * would prove that one caller is polite rather than that the rule holds.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../src/errors.ts";
import {
  assertActorMayMoveFinding,
  assertActorMayMoveReview,
  assertCompletionEvidence,
  assertExpectedVersion,
  assertFindingTransition,
  assertGeometry,
  assertReviewMutable,
  assertReviewTransition,
  missingCapturedContext,
} from "../src/modules/reviews/domain.ts";

function refusal(work: () => void): ApiError {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected an ApiError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: "the call was permitted" });
}

test("an agent cannot resolve a human-authored finding", () => {
  const denial = refusal(() => {
    assertActorMayMoveFinding("agent_session", "human", "AWAITING_HUMAN_REVIEW", "RESOLVED");
  });
  assert.equal(denial.code, "AUTHORISATION_DENIED");
  assert.match(denial.message, /human-authored finding cannot be set to RESOLVED by an agent/u);
  // The message names the transition an agent may make instead, because a
  // refusal that does not say what to do next produces a retry loop.
  assert.match(denial.message, /AWAITING_HUMAN_REVIEW/u);
});

test("an agent cannot mark a human-authored finding wont_fix or duplicate either", () => {
  for (const status of ["WONT_FIX", "DUPLICATE"] as const) {
    const denial = refusal(() => {
      assertActorMayMoveFinding("agent_session", "human", "OPEN", status);
    });
    assert.equal(denial.code, "AUTHORISATION_DENIED");
  }
});

test("an agent may take a human-authored finding as far as awaiting human review", () => {
  // The whole permitted path of docs/MCP_SPEC.md section 7.7.
  const path: readonly (readonly [string, string])[] = [
    ["OPEN", "CLAIMED"],
    ["CLAIMED", "IN_PROGRESS"],
    ["IN_PROGRESS", "FIXED_UNVERIFIED"],
    ["FIXED_UNVERIFIED", "AWAITING_HUMAN_REVIEW"],
  ];
  for (const [from, to] of path) {
    assertFindingTransition(from as never, to as never);
    assertActorMayMoveFinding("agent_session", "human", from as never, to as never);
  }
});

test("an agent cannot resolve its own finding either, because no policy permits it", () => {
  const denial = refusal(() => {
    assertActorMayMoveFinding("agent_session", "agent", "AWAITING_HUMAN_REVIEW", "RESOLVED");
  });
  // A different code from the human-authored case: this one is about the
  // absence of an auto-resolution policy, not about authority over a human's
  // finding (docs/DOMAIN_MODEL.md section 15).
  assert.equal(denial.code, "POLICY_DENIED");
  assert.match(denial.message, /No project policy permits it/u);
});

test("a human may resolve a human-authored finding", () => {
  assertActorMayMoveFinding("human_user", "human", "AWAITING_HUMAN_REVIEW", "RESOLVED");
  assertActorMayMoveFinding("human_user", "human", "RESOLVED", "REOPENED");
});

test("a browser worker has no authority over a finding at all", () => {
  const denial = refusal(() => {
    assertActorMayMoveFinding("browser_worker", "human", "OPEN", "CLAIMED");
  });
  assert.equal(denial.code, "AUTHORISATION_DENIED");
  assert.match(denial.message, /browser_worker principal may not change the status/u);
});

test("only a human may accept a review", () => {
  const denial = refusal(() => {
    assertActorMayMoveReview("agent_session", "ACCEPTED");
  });
  assert.equal(denial.code, "AUTHORISATION_DENIED");
  assertActorMayMoveReview("human_user", "ACCEPTED");
});

test("an accepted review cannot mutate silently", () => {
  const denial = refusal(() => {
    assertReviewMutable("ACCEPTED", { fields: ["title"] });
  });
  assert.equal(denial.code, "POLICY_DENIED");
  assert.match(denial.message, /immutable except for archival metadata/u);

  // Archival is the one permitted change, and it carries no other field.
  assertReviewMutable("ACCEPTED", { status: "ARCHIVED", fields: [] });
  const withField = refusal(() => {
    assertReviewMutable("ACCEPTED", { status: "ARCHIVED", fields: ["slug"] });
  });
  assert.equal(withField.code, "POLICY_DENIED");
});

test("a review status machine has no implicit transitions", () => {
  assertReviewTransition("DRAFT", "READY");
  assertReviewTransition("AWAITING_HUMAN_REVIEW", "ACCEPTED");
  const denial = refusal(() => {
    assertReviewTransition("DRAFT", "ACCEPTED");
  });
  assert.equal(denial.code, "POLICY_DENIED");
  assert.equal(refusal(() => { assertReviewTransition("ARCHIVED", "DRAFT"); }).code, "POLICY_DENIED");
});

test("optimistic version comparison reports the version the record holds", () => {
  assertExpectedVersion(4, 4, "finding");
  const conflict = refusal(() => {
    assertExpectedVersion(7, 4, "finding");
  });
  assert.equal(conflict.code, "VERSION_CONFLICT");
  assert.equal(conflict.details["current_version"], 7);
  assert.equal(conflict.details["expected_version"], 4);
});

test("a completion claim without a resolution note is refused with EVIDENCE_REQUIRED", () => {
  const denial = refusal(() => {
    assertCompletionEvidence("FIXED_UNVERIFIED", {});
  });
  assert.equal(denial.code, "EVIDENCE_REQUIRED");
  assert.deepEqual(denial.details["required_evidence"], [
    "resolution_note",
    "after_screenshot_artefact",
  ]);
  assertCompletionEvidence("FIXED_UNVERIFIED", {
    resolutionNote: "Raised the collapse breakpoint to 900px.",
  });
  // Whitespace is not a resolution note.
  assert.equal(
    refusal(() => { assertCompletionEvidence("FIXED_UNVERIFIED", { resolutionNote: "   " }); }).code,
    "EVIDENCE_REQUIRED",
  );
});

test("the captured-context list is the one docs/UX_FLOWS.md section 9 fixes", () => {
  const complete = {
    url: "https://route.internal.invalid/",
    viewport: { width: 390, height: 844, device_scale_factor: 2 },
    scroll_position: { x: 0, y: 320 },
    captured_commit: "4a45b94",
    screenshot_artefact_id: "art_a",
  };
  assert.deepEqual(missingCapturedContext(complete), []);

  assert.deepEqual(missingCapturedContext({ ...complete, screenshot_artefact_id: undefined }), [
    "screenshot_artefact_id",
  ]);
  // A viewport without a device pixel ratio is not a viewport: the ratio is
  // what relates CSS pixels to the captured image.
  assert.deepEqual(
    missingCapturedContext({ ...complete, viewport: { width: 390, height: 844 } }),
    ["viewport.device_scale_factor"],
  );
  assert.deepEqual(missingCapturedContext({}).length, 6);
});

test("geometry outside 0 to 1 is refused at the boundary and names the reference frame", () => {
  assertGeometry("rectangle", { x: 0.54, y: 0.02, width: 0.38, height: 0.11 });
  const denial = refusal(() => {
    assertGeometry("rectangle", { x: 421, y: 17, width: 296, height: 93 });
  });
  assert.equal(denial.code, "UNSUPPORTED_CAPABILITY");
  assert.match(denial.message, /artefact content rectangle/u);
  assert.match(denial.message, /between 0 and 1 inclusive/u);

  // A shape that does not match its type.
  assert.equal(
    refusal(() => { assertGeometry("point", { x: 0.1, y: 0.2, width: 0.3, height: 0.1 }); }).code,
    "UNSUPPORTED_CAPABILITY",
  );
  assert.equal(
    refusal(() => { assertGeometry("rectangle", "0.5,0.5"); }).code,
    "UNSUPPORTED_CAPABILITY",
  );
});
