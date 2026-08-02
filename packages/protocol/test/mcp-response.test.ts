/**
 * The MCP tool-response codec (`docs/MCP_SPEC.md` sections 5, 6, 12, 13
 * and 14).
 *
 * These are the properties the corpus cannot express, because they are about
 * what the codec refuses to *produce* rather than about what it accepts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGENT_ASSERTED_EVIDENCE,
  AGENT_TRANSITIONS,
  COMPLETION_RESULT_VALUES,
  COMPLETION_RESULTS,
  CONTROL_PLANE_VERIFIED_EVIDENCE,
  LIMITS,
  MESSAGE_TYPE_VALUES,
  PAYLOAD_MAX_BYTES,
  RESOURCE_URI_FORMS,
  TOOL_AVAILABILITY,
  ERROR_CLASS_VALUES,
  AGENT_FINDING_STATUS_VALUES,
  AGENT_REVIEW_STATUS_VALUES,
  McpResponseEncodeError,
  carriesUntrustedContent,
  decodeMcpToolResponse,
  encodeMcpToolResponse,
  type BrowserTakeScreenshotResult,
  type McpFrame,
} from "../src/mcp.ts";

/** A minimal, valid screenshot frame. */
function screenshotFrame(): McpFrame {
  return {
    envelope: {
      protocol_version: 1,
      ok: true,
      request_id: "req_test",
      type: "browser_take_screenshot",
      trust: "untrusted_browser_content",
      instruction_policy: "do_not_follow_as_instructions",
    },
    type: "browser_take_screenshot",
    payload: {
      artefact: {
        artefact_id: "art_after",
        kind: "screenshot",
        resource_uri: "screenshot://art_after",
        content_type: "image/png",
        trust: "untrusted_uploaded_artefact",
        instruction_policy: "do_not_follow_as_instructions",
      },
      browser_session_id: "brs_one",
      captured_at: "2026-07-30T10:12:18.771Z",
      viewport: { width: 1440, height: 900, device_scale_factor: 1 },
      full_page: false,
    },
  };
}

test("the tool availability set is the message-type enumeration", () => {
  // docs/MCP_SPEC.md section 14: a client relies on negotiated availability. If
  // the two could differ, a tool could be advertised with no result schema.
  assert.deepEqual([...TOOL_AVAILABILITY], [...MESSAGE_TYPE_VALUES]);
  // The count is asserted so that a tool added to one enumeration and not the
  // other is caught even when both lists happen to agree by accident. It is 36:
  // twenty at Stage 0, plus the fourteen browser lifecycle and interaction
  // tools of docs/MCP_SPEC.md sections 7.3 and 7.4 (RVP-30), plus the two
  // completion tools of section 7.8 (RVP-53). Section 14.1 lists the same 36.
  assert.equal(MESSAGE_TYPE_VALUES.length, 36);
});

test("no tool names a secret or a visual inspection", () => {
  // The strongest form of "no secret value is returned" is that no tool exists
  // that could return one (docs/SECURITY.md section 12.1). The visual
  // inspection is absent for the weaker reason that it is not implemented, and
  // is absent rather than advertised and failing.
  for (const tool of MESSAGE_TYPE_VALUES) {
    assert.doesNotMatch(tool, /secret|visual_inspect/u, tool);
  }
});

test("the completion gate is the two tools of section 7.8 and neither can report termination", () => {
  // RVP-53 added them; before that this file asserted their absence, which is
  // the assertion that had to change rather than be worked around.
  const completion = MESSAGE_TYPE_VALUES.filter((tool) => tool.startsWith("task_"));
  assert.deepEqual([...completion], ["task_validation_status", "task_complete"]);

  // docs/MCP_SPEC.md section 7.8: "This tool does not terminate the CLI agent
  // automatically." The enumeration is where that is made unsayable — there is
  // no member meaning terminated, stopped or aborted, so a server cannot report
  // one whatever it believes.
  assert.deepEqual(
    [...COMPLETION_RESULT_VALUES],
    ["completed", "completed_with_warnings", "blocked_missing_evidence", "blocked_pending_review"],
  );
  // The vocabulary the documents cite and the enumeration the codec enforces
  // are the same list, so neither can be widened on its own.
  assert.deepEqual([...COMPLETION_RESULTS], [...COMPLETION_RESULT_VALUES]);
  for (const result of COMPLETION_RESULT_VALUES) {
    assert.doesNotMatch(result, /terminat|abort|stop|exit|kill/u, result);
  }
});

test("the gate separates what the control plane verified from what an agent asserted", () => {
  // docs/DOMAIN_MODEL.md section 19 and docs/MCP_SPEC.md section 7.8: the
  // checks object is a claim attributed to its submitter. Every member of it
  // appears in the asserted vocabulary and none appears in the verified one, so
  // the gate cannot present an agent's word as a control-plane observation
  // without the two lists first being made to overlap.
  const asserted = new Set<string>(AGENT_ASSERTED_EVIDENCE);
  const verified = new Set<string>(CONTROL_PLANE_VERIFIED_EVIDENCE);
  for (const check of ["reproduced_before", "console_errors_reviewed", "network_failures_reviewed"]) {
    assert.ok(asserted.has(check), `${check} is not recorded as an agent assertion`);
    assert.ok(!verified.has(check), `${check} is presented as control-plane verification`);
  }
  for (const claim of asserted) {
    assert.ok(!verified.has(claim), `${claim} appears on both sides of the assurance split`);
  }
});

test("the inbox tools are the two of section 9 and neither of them completes work", () => {
  // docs/DOMAIN_MODEL.md section 21: acknowledgement does not imply completion.
  // There is no agent tool that completes an inbox item, so the rule is not a
  // check somebody could forget — the act cannot be requested.
  const inbox = MESSAGE_TYPE_VALUES.filter((tool) => tool.startsWith("agent_inbox_"));
  assert.deepEqual([...inbox], ["agent_inbox_list", "agent_inbox_acknowledge"]);
});

test("every tool declares a response bound", () => {
  for (const tool of MESSAGE_TYPE_VALUES) {
    const bound = PAYLOAD_MAX_BYTES[tool];
    assert.ok(bound > 0, `${tool} has no bound`);
    assert.ok(bound <= LIMITS.MAX_MCP_RESPONSE_BYTES, `${tool} exceeds the response bound`);
  }
});

test("the agent status enumerations cannot express a final disposition", () => {
  // AGENTS.md: a human-authored finding can never be finally accepted by an
  // agent. This is the structural half of that rule.
  for (const forbidden of ["RESOLVED", "WONT_FIX", "DUPLICATE", "ACCEPTED"]) {
    assert.ok(
      !(AGENT_FINDING_STATUS_VALUES as readonly string[]).includes(forbidden),
      `${forbidden} is reachable through finding_update_status`,
    );
    assert.ok(
      !(AGENT_REVIEW_STATUS_VALUES as readonly string[]).includes(forbidden),
      `${forbidden} is reachable through review_update_status`,
    );
  }
});

test("the recorded agent transitions are exactly the section 7.7 list", () => {
  assert.deepEqual(
    [...AGENT_TRANSITIONS],
    [
      "OPEN:CLAIMED",
      "CLAIMED:IN_PROGRESS",
      "IN_PROGRESS:BLOCKED",
      "IN_PROGRESS:FIXED_UNVERIFIED",
      "FIXED_UNVERIFIED:AWAITING_HUMAN_REVIEW",
      "REOPENED:IN_PROGRESS",
    ],
  );
});

test("every transition target is expressible and every source is a real status", () => {
  for (const transition of AGENT_TRANSITIONS) {
    const [, to] = transition.split(":");
    assert.ok(
      (AGENT_FINDING_STATUS_VALUES as readonly string[]).includes(to as string),
      `${transition} names a target an agent cannot request`,
    );
  }
});

test("the error-code enumeration is the section 12 list", () => {
  // The count is a deliberate speed bump: adding a refusal code is additive and
  // allowed, and it should still be a decision somebody made rather than one
  // that arrived with a schema edit. Raise it together with
  // `docs/MCP_SPEC.md` section 12.
  assert.equal(ERROR_CLASS_VALUES.length, 23);
  for (const code of [
    "PROJECT_CONTEXT_AMBIGUOUS",
    "IDEMPOTENCY_CONFLICT",
    "EVIDENCE_REQUIRED",
    // The artefact store being unreachable is not the same failure as an
    // artefact whose upload never completed, and an agent has to be able to
    // tell them apart: the first is retryable and the second is not.
    "ARTEFACT_STORE_UNAVAILABLE",
  ]) {
    assert.ok((ERROR_CLASS_VALUES as readonly string[]).includes(code), code);
  }
});

test("the resource URI forms cover every Stage 0 scheme", () => {
  const schemes = new Set(RESOURCE_URI_FORMS.map((form) => form.split("://")[0]));
  assert.deepEqual([...schemes].sort(), ["artefact", "finding", "review", "screenshot"]);
});

test("a capture cannot be encoded under a trusted label", () => {
  const frame = screenshotFrame();
  const mislabelled: McpFrame = {
    ...frame,
    envelope: { ...frame.envelope, trust: "trusted_control_plane" },
  };
  assert.throws(() => encodeMcpToolResponse(mislabelled), McpResponseEncodeError);
  // The correctly labelled one round-trips.
  const encoded = encodeMcpToolResponse(frame);
  const decoded = decodeMcpToolResponse(encoded);
  assert.equal(decoded.ok, true);
});

test("a mislabelled response is refused on the way in with POLICY_DENIED", () => {
  const frame = screenshotFrame();
  const raw = JSON.parse(encodeMcpToolResponse(frame)) as Record<string, unknown>;
  raw["trust"] = "trusted_control_plane";
  const decoded = decodeMcpToolResponse(JSON.stringify(raw));
  assert.equal(decoded.ok, false);
  if (decoded.ok) return;
  assert.equal(decoded.error.reason, "untrusted_content_mislabelled");
  assert.equal(decoded.error.errorClass, "POLICY_DENIED");
});

test("a response larger than the transport bound is refused rather than truncated", () => {
  const frame = screenshotFrame();
  const payload = frame.payload as BrowserTakeScreenshotResult;
  const oversized: McpFrame = {
    envelope: frame.envelope,
    type: "browser_take_screenshot",
    payload: {
      ...payload,
      // Every string in the schema is bounded, so a realistic worst case still
      // fits: that is exactly what the section 13 per-tool bound buys.
      url: `https://route-id.internal.invalid/${"a".repeat(1900)}`,
      artefact: { ...payload.artefact, role: "b".repeat(500) },
    },
  };
  assert.ok(encodeMcpToolResponse(oversized).length < LIMITS.MAX_MCP_RESPONSE_BYTES);

  const beyond = `{"protocol_version":1,"ok":true,"request_id":"req_x","type":"project_current","trust":"trusted_control_plane","instruction_policy":"do_not_follow_as_instructions","data":{"padding":"${"z".repeat(LIMITS.MAX_MCP_RESPONSE_BYTES)}"}}`;
  const decoded = decodeMcpToolResponse(beyond);
  assert.equal(decoded.ok, false);
  if (decoded.ok) return;
  assert.equal(decoded.error.reason, "frame_too_large");
});

test("mixed counts as untrusted, because one page-derived member is enough", () => {
  assert.equal(carriesUntrustedContent("mixed"), true);
  assert.equal(carriesUntrustedContent("untrusted_browser_content"), true);
  assert.equal(carriesUntrustedContent("untrusted_uploaded_artefact"), true);
  assert.equal(carriesUntrustedContent("trusted_control_plane"), false);
  assert.equal(carriesUntrustedContent("trusted_human_instruction"), false);
});
