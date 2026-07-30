/**
 * Unit tests (`docs/TESTING.md` section 2 "Unit"): the envelope, the trust
 * label, the idempotency scope and the tool-schema contract.
 *
 * None of these needs a database, and each of them is a rule somebody could
 * break without any test that needs one noticing.
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  MESSAGE_TYPE_VALUES,
  decodeMcpToolResponse,
  type MessageType,
} from "@reviewplane/protocol/mcp";
import { requestDigest } from "@reviewplane/server/domain";

import { STAGE_0_POLICY, negotiateCapabilities, readClientCapabilities } from "../src/context.ts";
import { Warnings, refusalEnvelope, successEnvelope } from "../src/envelope.ts";
import { toolInputSchema } from "../src/schemas.ts";
import { assertToolSetMatchesSchema, toolListing } from "../src/tools.ts";
import { decodeCursor, encodeCursor, trustFor } from "../src/views.ts";

const SNAPSHOT = join(import.meta.dirname, "contract", "tool-schemas.json");

test("the registered tool set is the schema's availability set", () => {
  assertToolSetMatchesSchema();
  assert.deepEqual(
    toolListing().map((tool) => tool.name).sort(),
    [...MESSAGE_TYPE_VALUES].sort(),
  );
});

test("the advertised tool schemas match the committed contract snapshot", () => {
  // docs/TESTING.md section 2 "Contract": a breaking tool change cannot land
  // silently. Regenerate deliberately with REVIEWPLANE_UPDATE_SNAPSHOT=1 and
  // read the diff; a changed argument shape is a protocol decision.
  const current = `${JSON.stringify(
    Object.fromEntries(
      toolListing().map((tool) => [tool.name, { title: tool.title, inputSchema: tool.inputSchema }]),
    ),
    null,
    2,
  )}\n`;
  if (process.env["REVIEWPLANE_UPDATE_SNAPSHOT"] === "1") {
    writeFileSync(SNAPSHOT, current, "utf8");
    return;
  }
  const committed = readFileSync(SNAPSHOT, "utf8");
  assert.equal(
    current,
    committed,
    "the advertised tool schemas changed; run REVIEWPLANE_UPDATE_SNAPSHOT=1 and review the diff",
  );
});

test("a tool schema carries only the definitions it references", () => {
  const schema = toolInputSchema("review_get" as MessageType) as {
    $defs: Record<string, unknown>;
  };
  assert.ok("review_selector" in schema.$defs);
  assert.ok("page_limit" in schema.$defs);
  // Definitions for other tools are not dragged along, which is what keeps
  // tools/list bounded (docs/MCP_SPEC.md section 13).
  assert.ok(!("verification_checks" in schema.$defs));
  assert.ok(!("policy_summary" in schema.$defs));
});

test("no advertised schema leaks the package's private bound annotations", () => {
  for (const tool of toolListing()) {
    assert.doesNotMatch(JSON.stringify(tool.inputSchema), /"x-/u, tool.name);
  }
});

test("a successful envelope decodes under the protocol codec", () => {
  const built = successEnvelope({
    tool: "project_current",
    requestId: "req_unit",
    trust: "trusted_project_configuration",
    data: {
      project: { id: "prj_one", slug: "refresh-surplus" },
      policy: {
        agent_may_accept_findings: STAGE_0_POLICY.agent_may_accept_findings,
        verification_required: STAGE_0_POLICY.verification_required,
        secret_tools_available: STAGE_0_POLICY.secret_tools_available,
        required_viewports: [...STAGE_0_POLICY.required_viewports],
      },
    } as never,
    warnings: [],
  });
  const decoded = decodeMcpToolResponse(built.json);
  assert.equal(decoded.ok, true);
});

test("a refusal carries the stable code and says whether a retry could help", () => {
  const conflict = refusalEnvelope({
    tool: "finding_claim",
    requestId: "req_unit",
    code: "VERSION_CONFLICT",
    message: "The finding changed since it was loaded.",
    details: { current_version: 4, expected_version: 3, unexpected: "dropped" },
  });
  assert.equal(conflict.value.ok, false);
  assert.equal(conflict.value.error.retryable, false);
  assert.deepEqual(conflict.value.error.details, { current_version: 4, expected_version: 3 });

  const rateLimited = refusalEnvelope({
    tool: "finding_claim",
    requestId: "req_unit",
    code: "RATE_LIMITED",
    message: "Retry shortly.",
    details: { retry_after_ms: 500 },
  });
  assert.equal(rateLimited.value.error.retryable, true);
});

test("a refusal never grows an unbounded message", () => {
  const refusal = refusalEnvelope({
    tool: "review_get",
    requestId: "req_unit",
    code: "RESOURCE_NOT_FOUND",
    message: "x".repeat(5000),
  });
  assert.equal(refusal.value.error.message.length, 512);
});

test("warnings are deduplicated and bounded", () => {
  const warnings = new Warnings();
  for (let index = 0; index < 30; index += 1) {
    warnings.add("text_truncated", `truncated ${String(index)}`);
    warnings.add("findings_truncated", `paged ${String(index)}`);
  }
  assert.equal(warnings.list.length, 2);
});

test("the trust label is decided by what a response contains", () => {
  assert.equal(trustFor({ pageDerived: true, humanAuthored: true }), "mixed");
  assert.equal(trustFor({ pageDerived: true, humanAuthored: false }), "untrusted_browser_content");
  assert.equal(trustFor({ pageDerived: false, humanAuthored: true }), "trusted_human_instruction");
  assert.equal(trustFor({ pageDerived: false, humanAuthored: false }), "trusted_control_plane");
});

test("an idempotency digest ignores argument order but not argument values", () => {
  const one = requestDigest({ finding_id: "fin_a", summary: "b", idempotency_key: "k" });
  const reordered = requestDigest({ idempotency_key: "k", summary: "b", finding_id: "fin_a" });
  const different = requestDigest({ finding_id: "fin_a", summary: "c", idempotency_key: "k" });
  assert.equal(one, reordered);
  assert.notEqual(one, different);
});

test("client capabilities default generously and degrade on request", () => {
  const defaults = readClientCapabilities(new URLSearchParams());
  assert.equal(defaults.image_content, true);
  assert.equal(defaults.managed_messages, false);

  const degraded = readClientCapabilities(new URLSearchParams("image_content=false"));
  assert.equal(degraded.image_content, false);
  assert.equal(negotiateCapabilities(degraded).image_resources, false);
  // Stage 0 advertises no inbox and pushes nothing, whatever the client says.
  assert.equal(negotiateCapabilities(defaults).review_inbox, false);
  assert.equal(negotiateCapabilities(defaults).managed_messages, false);
});

test("a cursor round-trips and a forged one is refused", () => {
  const cursor = { createdAt: "2026-07-30T10:04:12.137Z", id: "fin_one" };
  assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
  assert.equal(decodeCursor("not-a-cursor"), null);
  assert.equal(decodeCursor(Buffer.from("nonsense", "utf8").toString("base64url")), null);
});
