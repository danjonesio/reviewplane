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
  PAYLOAD_MAX_BYTES,
  decodeMcpToolResponse,
  type MessageType,
} from "@reviewplane/protocol/mcp";
import {
  DEFAULT_ARTEFACT_MAX_BYTES,
  DEFAULT_ARTEFACT_PATH,
  loadArtefactStoreConfig,
  requestDigest,
} from "@reviewplane/server/domain";

import { loadMcpServerConfig } from "../src/config.ts";

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

/**
 * Every registered tool declares a response bound, and the bound is a number.
 *
 * `docs/MCP_SPEC.md` §13 requires a per-tool size limit, and the server reads it
 * from `PAYLOAD_MAX_BYTES` in two places that both do arithmetic on it:
 * `BoundedPayload` derives its assembly budget from it, and the snapshot view
 * derives how much rendered page text may be carried. A tool with no entry
 * yields `undefined`, every comparison against the resulting `NaN` is false, and
 * the effect is not a refusal but the **opposite** of the bound — nothing is
 * ever judged too large, so an unbounded payload is assembled and then thrown
 * out by the encoder. That is the failure mode §13 was written about, arriving
 * by the one route the section does not mention.
 *
 * So it is asserted over the registered set rather than over a list here: a tool
 * added without a bound fails this test at the moment it is registered, whoever
 * adds it and whichever branch it arrives on.
 */
test("every registered tool declares a usable response bound", () => {
  for (const tool of toolListing()) {
    const bound = PAYLOAD_MAX_BYTES[tool.name as MessageType];
    assert.equal(
      typeof bound,
      "number",
      `${tool.name} declares no PAYLOAD_MAX_BYTES entry, so its budget is NaN`,
    );
    assert.ok(Number.isFinite(bound) && bound > 0, `${tool.name} declares a bound of ${String(bound)}`);
    // A budget computed from the bound has to stay a number that can be
    // compared, which is the property the arithmetic above actually depends on.
    assert.ok(Number.isFinite(Math.floor(bound * 0.75)));
  }
});

/**
 * `docs/SECURITY.md` §20: restore is a privileged local operation and is
 * reachable through no network interface — including this one.
 *
 * It is asserted here, against the tool table the server actually registers,
 * rather than by reading the file for a pattern. An agent that could restore an
 * installation could replace every review in it with rows of its own choosing,
 * which is the authority boundary `docs/MCP_SPEC.md` exists to hold.
 */
test("no tool exposes backup or restore", () => {
  const named = toolListing()
    .map((tool) => tool.name)
    .filter((name) => /backup|restore|migrate|rotate|truncate/iu.test(name));
  assert.deepEqual(named, [], `the MCP surface exposes ${named.join(", ")}`);
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

test("a refusal carries the browser details the schema declares, under the schema's names", () => {
  const paused = refusalEnvelope({
    tool: "browser_click",
    requestId: "req_unit",
    code: "BROWSER_SESSION_NOT_ACTIVE",
    message: "The browser session is paused.",
    // The domain calls it `status`; the schema calls it
    // `browser_session_status`. The alias is what makes renaming the domain's
    // key a no-op here rather than a silent loss of the member.
    details: { status: "PAUSED", reason: "session_paused" },
  });
  assert.deepEqual(paused.value.error.details, { browser_session_status: "PAUSED" });

  const renamed = refusalEnvelope({
    tool: "browser_click",
    requestId: "req_unit",
    code: "BROWSER_SESSION_NOT_ACTIVE",
    message: "The browser session is paused.",
    details: { browser_session_status: "PAUSED" },
  });
  assert.deepEqual(renamed.value.error.details, { browser_session_status: "PAUSED" });

  const secret = refusalEnvelope({
    tool: "browser_type",
    requestId: "req_unit",
    code: "POLICY_DENIED",
    message: "This value looks like secret material.",
    details: { reason: "secret_material", detected: "reviewplane_agent_token" },
  });
  // The rule, never the value, and never the prose restatement of the code.
  assert.deepEqual(secret.value.error.details, { detected: "reviewplane_agent_token" });

  const route = refusalEnvelope({
    tool: "browser_navigate",
    requestId: "req_unit",
    code: "AUTHORISATION_DENIED",
    message: "The published service no longer authorises this session.",
    details: { published_service_id: "svc_one" },
  });
  assert.deepEqual(route.value.error.details, { published_service_id: "svc_one" });
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
  // The inbox tools are advertised, so the capability says so. Nothing is
  // pushed, whatever the client says: an agent polls and acknowledges
  // explicitly (`docs/MCP_SPEC.md` section 9).
  assert.equal(negotiateCapabilities(defaults).review_inbox, true);
  assert.equal(negotiateCapabilities(defaults).managed_messages, false);
  assert.equal(negotiateCapabilities(degraded).review_inbox, true);
});

test("the inbox capability is not degraded by a client that consumes no images", () => {
  // Degradation is per capability. A client without image support still
  // receives its work: the inbox carries titles and identifiers, not pixels.
  const noImages = readClientCapabilities(new URLSearchParams("image_content=false&resources=false"));
  const negotiated = negotiateCapabilities(noImages);
  assert.equal(negotiated.image_resources, false);
  assert.equal(negotiated.review_inbox, true);
});

test("a cursor round-trips and a forged one is refused", () => {
  const cursor = { createdAt: "2026-07-30T10:04:12.137Z", id: "fin_one" };
  assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
  assert.equal(decodeCursor("not-a-cursor"), null);
  assert.equal(decodeCursor(Buffer.from("nonsense", "utf8").toString("base64url")), null);
});

test("the MCP server's artefact defaults are the artefact module's own", () => {
  // `REVIEWPLANE_ARTEFACT_PATH` and `REVIEWPLANE_ARTEFACT_MAX_BYTES` have three
  // readers: `apps/server/src/config.ts`, `apps/server/src/modules/artefacts/
  // config.ts` and this package's `src/config.ts`. The artefact module owns the
  // values and cannot be imported by the server's own configuration without an
  // import cycle, and this package is separate again, so the duplication is
  // real and a test is what stops it drifting.
  // `apps/server/test/artefact-store-stage-1.test.ts` asserts the pair inside
  // that package; this asserts the third.
  //
  // Drift here would be worse than untidy. The MCP server reads evidence the
  // control plane wrote: two different defaults mean an agent reading an empty
  // directory while the API serves the same artefact perfectly well.
  const mcp = loadMcpServerConfig({
    REVIEWPLANE_DATABASE_URL: "postgres://localhost/reviewplane",
    REVIEWPLANE_WORKER_COMMAND_CREDENTIAL: "d".repeat(32),
    REVIEWPLANE_TUNNEL_CONTROL_TOKEN: "e".repeat(32),
  });
  assert.equal(mcp.artefactPath, DEFAULT_ARTEFACT_PATH);
  assert.equal(mcp.artefactMaxBytes, DEFAULT_ARTEFACT_MAX_BYTES);

  // And the driver the MCP server would build from the same environment is the
  // one the artefact module resolves, so an `s3` deployment does not leave the
  // agent surface reading a local directory.
  const store = loadArtefactStoreConfig({});
  assert.equal(store.path, mcp.artefactPath);
  assert.equal(store.maxBytes, mcp.artefactMaxBytes);
});
