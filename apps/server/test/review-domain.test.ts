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
  AGENT_REVIEW_STATUSES,
  AGENT_TRANSITION_LABELS,
  assertActorMayCloseReview,
  assertActorMayDispose,
  assertActorMayMoveFinding,
  assertActorMayMoveReview,
  assertCompletionEvidence,
  assertExpectedVersion,
  assertFindingTransition,
  assertGeometry,
  assertReviewAcceptable,
  assertReviewMutable,
  assertReviewTransition,
  missingCapturedContext,
} from "../src/modules/reviews/domain.ts";
import { sourceForActor } from "../src/modules/reviews/service.ts";

function refusal(work: () => void): ApiError {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected an ApiError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: "the call was permitted" });
}

/**
 * The structured details of a refusal, asserting that it carried any.
 *
 * `docs/MCP_SPEC.md` §12 requires a refusal to name what the caller has to
 * change — the current version, the allowed transitions, the evidence that is
 * missing — so a refusal with no details is itself a failure.
 */
function detailsOf(error: ApiError): Readonly<Record<string, unknown>> {
  assert.ok(error.details !== undefined, `${error.code} carried no details`);
  return error.details;
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
  // A final disposition is a human decision whoever authored the finding.
  // docs/DOMAIN_MODEL.md section 15 permits auto-resolution of an agent's own
  // finding "by policy if configured", and Stage 1 configures none, so there is
  // nothing to permit it (docs/API.md section 13).
  assert.equal(denial.code, "AUTHORISATION_DENIED");
  assert.match(denial.message, /no project policy permits otherwise/u);
});

test("an agent transition outside the six is refused and says what is available", () => {
  // Not a final disposition, so this is the POLICY_DENIED arm of docs/API.md
  // section 13 rather than the authority one, and it must name what the agent
  // *can* do — a refusal that only says no produces a retry loop.
  const denial = refusal(() => {
    assertActorMayMoveFinding("agent_session", "human", "CLAIMED", "OPEN");
  });
  assert.equal(denial.code, "POLICY_DENIED");
  assert.deepEqual(detailsOf(denial)["allowed_transitions"], ["CLAIMED:IN_PROGRESS"]);
});

test("the agent-permitted finding transitions are exactly the six of MCP_SPEC 7.7", () => {
  // Read from the protocol table rather than restated here, so this test
  // proves the table and the rule agree rather than proving a copy of the rule
  // agrees with itself (ADR-0024).
  assert.deepEqual([...AGENT_TRANSITION_LABELS].sort(), [
    "CLAIMED:IN_PROGRESS",
    "FIXED_UNVERIFIED:AWAITING_HUMAN_REVIEW",
    "IN_PROGRESS:BLOCKED",
    "IN_PROGRESS:FIXED_UNVERIFIED",
    "OPEN:CLAIMED",
    "REOPENED:IN_PROGRESS",
  ]);
});

test("an agent reaches exactly three review statuses, and ACCEPTED is not one", () => {
  assert.deepEqual([...AGENT_REVIEW_STATUSES].sort(), [
    "ASSIGNED",
    "AWAITING_HUMAN_REVIEW",
    "IN_PROGRESS",
  ]);
  assert.ok(!AGENT_REVIEW_STATUSES.includes("ACCEPTED"));
});

test("a human may resolve a human-authored finding", () => {
  assertActorMayMoveFinding("human_user", "human", "AWAITING_HUMAN_REVIEW", "RESOLVED");
  assertActorMayMoveFinding("human_user", "human", "RESOLVED", "REOPENED");
});

test("a human can reopen a resolved finding", () => {
  // docs/TESTING.md section 4, required transition test 2. Reopening is what
  // makes acceptance reversible, and it is a human's to make from every final
  // disposition rather than only from RESOLVED.
  for (const from of ["RESOLVED", "WONT_FIX", "DUPLICATE"] as const) {
    assertFindingTransition(from, "REOPENED");
    assertActorMayMoveFinding("human_user", "human", from, "REOPENED");
  }
  // An agent cannot, whichever disposition it starts from: reopening a decision
  // is as much a decision as making it.
  const denial = refusal(() => {
    assertActorMayMoveFinding("agent_session", "human", "RESOLVED", "REOPENED");
  });
  assert.equal(denial.code, "POLICY_DENIED");
});

test("a staleness warning does not close a finding on its own", () => {
  // docs/TESTING.md section 4, required transition test 6, and
  // docs/DOMAIN_MODEL.md section 24: "Staleness is a warning and workflow
  // input, not automatic invalidation."
  //
  // The property is structural rather than behavioural, which is why it is
  // testable at all: there is no transition into a final disposition from
  // anything but a human decision, so nothing a staleness calculation could
  // return would close a finding. Stage 1 persists the captured context the
  // calculation will read and computes no staleness.
  for (const from of ["OPEN", "IN_PROGRESS", "BLOCKED", "REOPENED"] as const) {
    for (const to of ["RESOLVED", "WONT_FIX", "DUPLICATE"] as const) {
      const denial = refusal(() => {
        assertActorMayMoveFinding("system", "human", from, to);
      });
      assert.equal(
        denial.code,
        "AUTHORISATION_DENIED",
        `a system actor closed a ${from} finding as ${to}`,
      );
    }
  }
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
    assertActorMayMoveReview("agent_session", "AWAITING_HUMAN_REVIEW", "ACCEPTED");
  });
  assert.equal(denial.code, "AUTHORISATION_DENIED");
  assert.match(denial.message, /Only a human may accept a review/u);
  assertActorMayMoveReview("human_user", "AWAITING_HUMAN_REVIEW", "ACCEPTED");
});

test("an agent may not withdraw or archive a review either", () => {
  for (const [from, to] of [
    ["DRAFT", "CANCELLED"],
    ["IN_PROGRESS", "CANCELLED"],
    ["ACCEPTED", "ARCHIVED"],
    ["ACCEPTED", "CHANGES_REQUESTED"],
  ] as const) {
    const denial = refusal(() => {
      assertActorMayMoveReview("agent_session", from, to);
    });
    assert.equal(denial.code, "AUTHORISATION_DENIED", `an agent moved ${from} to ${to}`);
  }
});

test("an accepted review cannot mutate silently", () => {
  const denial = refusal(() => {
    assertReviewMutable("ACCEPTED", { fields: ["title"] });
  });
  assert.equal(denial.code, "POLICY_DENIED");
  assert.match(denial.message, /immutable except for archival metadata/u);

  // Archival and an explicit reopen are the two permitted changes, and neither
  // carries another field: a caller that wanted to retitle an accepted review
  // by reopening it in the same request would have found a way around the rule
  // rather than an exception to it (docs/DOMAIN_MODEL.md section 14).
  assertReviewMutable("ACCEPTED", { status: "ARCHIVED", fields: [] });
  assertReviewMutable("ACCEPTED", { status: "CHANGES_REQUESTED", fields: [] });
  for (const change of [
    { status: "ARCHIVED", fields: ["slug"] },
    { status: "CHANGES_REQUESTED", fields: ["title"] },
    { status: "IN_PROGRESS", fields: [] },
  ] as const) {
    assert.equal(
      refusal(() => {
        assertReviewMutable("ACCEPTED", change);
      }).code,
      "POLICY_DENIED",
      `an ACCEPTED review admitted ${JSON.stringify(change)}`,
    );
  }
  // A cancelled review is closed in the same way, and cannot be reopened.
  assert.equal(
    refusal(() => {
      assertReviewMutable("CANCELLED", { status: "CHANGES_REQUESTED", fields: [] });
    }).code,
    "POLICY_DENIED",
  );
});

test("a review cannot be accepted while a human-authored finding is outstanding", () => {
  const outstanding = [
    { id: "fin_a", source: "human", status: "RESOLVED" },
    { id: "fin_b", source: "human", status: "AWAITING_HUMAN_REVIEW" },
  ] as const;
  const denial = refusal(() => {
    assertReviewAcceptable(outstanding);
  });
  assert.equal(denial.code, "POLICY_DENIED");
  assert.match(String(detailsOf(denial)["reason"]), /fin_b/u);

  // Waived counts as decided: WONT_FIX and DUPLICATE are human decisions.
  assertReviewAcceptable([
    { id: "fin_a", source: "human", status: "RESOLVED" },
    { id: "fin_b", source: "human", status: "WONT_FIX" },
    { id: "fin_c", source: "human", status: "DUPLICATE" },
    // An agent's own note about its work is not a condition of the human's
    // judgement of the feedback they gave.
    { id: "fin_d", source: "agent", status: "IN_PROGRESS" },
  ]);
  assertReviewAcceptable([]);
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
  assert.equal(detailsOf(conflict)["current_version"], 7);
  assert.equal(detailsOf(conflict)["expected_version"], 4);
});

test("a completion claim without a resolution note is refused with EVIDENCE_REQUIRED", () => {
  const denial = refusal(() => {
    assertCompletionEvidence("FIXED_UNVERIFIED", {});
  });
  assert.equal(denial.code, "EVIDENCE_REQUIRED");
  assert.deepEqual(detailsOf(denial)["required_evidence"], [
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

test("a finding's source is derived from the actor and cannot be chosen", () => {
  // The acceptance authority rule of docs/DOMAIN_MODEL.md section 15 is decided
  // on this value, so it is a function of who is writing and of nothing a
  // caller sends. Everything that is not an agent session records `human`,
  // which is the conservative direction: a finding wrongly labelled human needs
  // a human to close it, and one wrongly labelled agent would not.
  assert.equal(sourceForActor("agent_session"), "agent");
  assert.equal(sourceForActor("human_user"), "human");
  assert.equal(sourceForActor("system"), "human");
  assert.equal(sourceForActor("browser_worker"), "human");
  assert.equal(sourceForActor("connector"), "human");
  assert.equal(sourceForActor("integration"), "human");
});

test("a final disposition is refused for an agent from every status, legal or not", () => {
  // The rule is about the decision, not about the move, so it does not consult
  // the lifecycle (docs/API.md section 13). Checking legality first would make
  // an agent asking to resolve a finding it had claimed hear that the move was
  // impossible rather than that the decision was not its to make — and would
  // record the attempt under the wrong class, which is how 21 of 33 refusals
  // came to leave no trail at all.
  for (const to of ["RESOLVED", "WONT_FIX", "DUPLICATE"] as const) {
    for (const source of ["human", "agent"] as const) {
      const denial = refusal(() => {
        assertActorMayDispose("agent_session", source, to);
      });
      assert.equal(
        denial.code,
        "AUTHORISATION_DENIED",
        `an agent disposed of a ${source}-authored finding as ${to}`,
      );
    }
  }
  // A human may, and a transition that is not a disposition is not this guard's
  // business — it belongs to the lifecycle check that follows.
  assertActorMayDispose("human_user", "human", "RESOLVED");
  assertActorMayDispose("agent_session", "human", "IN_PROGRESS");
  assertActorMayDispose("agent_session", "agent", "FIXED_UNVERIFIED");
});

test("closing a review is refused for an agent whatever status it starts from", () => {
  for (const to of ["ACCEPTED", "CANCELLED", "ARCHIVED"] as const) {
    const denial = refusal(() => {
      assertActorMayCloseReview("agent_session", to);
    });
    assert.equal(denial.code, "AUTHORISATION_DENIED", `an agent moved a review to ${to}`);
  }
  assertActorMayCloseReview("human_user", "ACCEPTED");
  assertActorMayCloseReview("agent_session", "IN_PROGRESS");
  assertActorMayCloseReview("agent_session", "AWAITING_HUMAN_REVIEW");
});

test("a finding claim is an ordinary optimistic-concurrency write", () => {
  // docs/TESTING.md section 4, required transition test 4. The unit half: a
  // claim compares versions like any other write and reports the version the
  // record actually holds. The concurrent half - one claim, one refusal - is in
  // reviews.test.ts, where two callers race a real row lock.
  assertFindingTransition("OPEN", "CLAIMED");
  assertActorMayMoveFinding("agent_session", "human", "OPEN", "CLAIMED");
  assertActorMayMoveFinding("human_user", "human", "OPEN", "CLAIMED");
  const conflict = refusal(() => {
    assertExpectedVersion(3, 1, "finding");
  });
  assert.equal(conflict.code, "VERSION_CONFLICT");
  assert.equal(detailsOf(conflict)["current_version"], 3);
});
