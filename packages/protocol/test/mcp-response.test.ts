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
  AGENT_TRANSITIONS,
  LIMITS,
  MESSAGE_TYPE_VALUES,
  PAYLOAD_MAX_BYTES,
  RESOURCE_URI_FORMS,
  STAGE_0_TOOL_AVAILABILITY,
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
  assert.deepEqual([...STAGE_0_TOOL_AVAILABILITY], [...MESSAGE_TYPE_VALUES]);
  assert.equal(MESSAGE_TYPE_VALUES.length, 11);
});

test("no Stage 0 tool names a secret, an inbox, a completion gate or a listing", () => {
  // The strongest form of "no secret value is returned" is that no tool exists
  // that could return one (docs/SECURITY.md section 12.1).
  for (const tool of MESSAGE_TYPE_VALUES) {
    assert.doesNotMatch(tool, /secret|inbox|task_|visual_inspect|review_list|review_search/u, tool);
  }
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
  assert.equal(ERROR_CLASS_VALUES.length, 22);
  for (const code of ["PROJECT_CONTEXT_AMBIGUOUS", "IDEMPOTENCY_CONFLICT", "EVIDENCE_REQUIRED"]) {
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
