/**
 * A full MCP transcript from a real client, for the evidence RVP-49 requires.
 *
 * It is not a test and asserts nothing beyond what it needs in order to keep
 * going: `test/mcp.test.ts` holds the assertions. What this produces is the
 * readable record a human reviews — the calls an agent actually makes, in
 * order, with the envelopes the endpoint actually returned.
 *
 * Run it from `apps/mcp-server` with a Docker daemon available:
 *
 *     node --conditions=development test/transcript.evidence.ts
 *
 * It starts a disposable PostgreSQL, the control plane, the MCP server and the
 * official MCP TypeScript SDK client, and tears all of it down afterwards.
 */

import { startMigratedDatabase, truncateAll } from "@reviewplane/server/testing";

import { ADMIN, connectAgent, envelopeOf, startMcpHarness } from "./helpers/harness.ts";
import {
  assignReviewToAgent,
  issueAgentCredential,
  seedProject,
  startBrowserSessionForAgent,
} from "./helpers/seed.ts";

function heading(text: string): void {
  process.stdout.write(`\n=== ${text} ===\n`);
}

function show(label: string, value: unknown): void {
  process.stdout.write(`--- ${label}\n${JSON.stringify(value, null, 2)}\n`);
}

const postgres = await startMigratedDatabase();
await truncateAll(postgres.pool);
const harness = await startMcpHarness(postgres.pool);

try {
  const seeded = await seedProject(harness);
  const credential = await issueAgentCredential(harness, {
    organisationId: seeded.organisationId,
    projectIds: [seeded.projectId],
  });

  heading("initialise");
  const agent = await connectAgent(harness, { token: credential.token });
  show("server capabilities", agent.client.getServerCapabilities());
  show("instructions", agent.client.getInstructions());

  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const result = await agent.client.callTool({ name, arguments: args });
    const envelope = envelopeOf(result);
    show(`${name} <- ${JSON.stringify(args)}`, envelope);
    return envelope;
  };

  heading("project_current");
  const current = await call("project_current", {});
  const sessionStatus = await call("agent_session_status", {});
  const agentSessionId = (
    (sessionStatus["data"] as { agent_session_id: string }) ?? { agent_session_id: "" }
  ).agent_session_id;
  void current;

  heading("a human assigns the review, which delivers an inbox item");
  const assigned = await assignReviewToAgent(harness, seeded.reviewId, agentSessionId, 1);
  show("POST /api/v1/reviews/:id/assign", assigned.body);

  heading("agent_inbox_list");
  const inbox = await call("agent_inbox_list", {});
  const itemId = ((inbox["data"] as { items: { id: string }[] }).items[0] ?? { id: "" }).id;

  heading("agent_inbox_acknowledge");
  await call("agent_inbox_acknowledge", {
    inbox_item_id: itemId,
    idempotency_key: "transcript-ack-1",
  });

  heading("review_get for bugs-on-homepage (trust labels on page-derived text)");
  const review = await call("review_get", {
    review: "bugs-on-homepage",
    include: ["findings", "artefact_links", "staleness"],
  });
  const findings = (review["data"] as { findings?: { id: string; version: number }[] }).findings ?? [];
  const finding = findings[0];

  heading("finding_claim");
  const claimed = await call("finding_claim", {
    finding_id: finding?.id ?? seeded.findingId,
    expected_version: finding?.version ?? 1,
    idempotency_key: "transcript-claim-1",
  });
  const claimedVersion = (claimed["data"] as { finding: { version: number } }).finding.version;

  heading("finding_update_status");
  await call("finding_update_status", {
    finding_id: finding?.id ?? seeded.findingId,
    expected_version: claimedVersion,
    status: "IN_PROGRESS",
    idempotency_key: "transcript-progress-1",
  });

  heading("a denied ACCEPTED transition");
  // The agent-facing enumeration does not contain a final disposition, so the
  // request is refused by the advertised contract before any domain code runs
  // (ADR-0020). The refusal is AUTHORISATION_DENIED rather than a schema
  // complaint, and the attempt is audited even though the domain never saw it.
  await call("finding_update_status", {
    finding_id: finding?.id ?? seeded.findingId,
    expected_version: claimedVersion + 1,
    status: "ACCEPTED",
    idempotency_key: "transcript-accept-1",
  });
  await call("review_update_status", {
    review_id: seeded.reviewId,
    expected_version: 3,
    status: "ACCEPTED",
    idempotency_key: "transcript-accept-2",
  });

  // ------------------------------------------------------ the completion gate

  const findingId = finding?.id ?? seeded.findingId;

  heading("task_validation_status BEFORE any evidence");
  await call("task_validation_status", { review: "bugs-on-homepage", finding_id: findingId });

  heading("task_complete with nothing submitted");
  await call("task_complete", {
    review: "bugs-on-homepage",
    summary: "I believe the breakpoint change is finished.",
    idempotency_key: "transcript-complete-1",
  });

  heading("the agent captures an after screenshot");
  const browser = await startBrowserSessionForAgent(harness, seeded, agentSessionId);
  const shot = await call("browser_take_screenshot", {
    browser_session_id: browser.browserSessionId,
    control_epoch: browser.controlEpoch,
    purpose: "verification",
    idempotency_key: "transcript-shot-1",
  });
  const afterArtefactId = (shot["data"] as { artefact: { artefact_id: string } }).artefact
    .artefact_id;

  heading("finding_submit_verification with one viewport only");
  await call("finding_submit_verification", {
    finding_id: findingId,
    summary: "Raised the collapse breakpoint to 900px; checked on mobile so far.",
    branch: "redesign",
    commit: "b4c5d6e7f809192a3b4c5d6e7f809192a3b4c5d6",
    tested_viewports: [{ width: 390, height: 844, device_scale_factor: 2 }],
    checks: {
      reproduced_before: true,
      console_errors_reviewed: true,
      network_failures_reviewed: true,
    },
    artefact_ids: [afterArtefactId],
    idempotency_key: "transcript-verify-1",
  });

  heading("the hand-over is refused: the evidence gate");
  await call("finding_update_status", {
    finding_id: findingId,
    expected_version: claimedVersion + 2,
    status: "AWAITING_HUMAN_REVIEW",
    idempotency_key: "transcript-awaiting-1",
  });

  heading("finding_submit_verification with the full payload (supersedes the first)");
  await call("finding_submit_verification", {
    finding_id: findingId,
    summary: "Changed the navigation collapse breakpoint to 900px.",
    branch: "redesign",
    commit: "b4c5d6e7f809192a3b4c5d6e7f809192a3b4c5d6",
    tested_viewports: [
      { width: 390, height: 844, device_scale_factor: 2 },
      { width: 1440, height: 900, device_scale_factor: 1 },
    ],
    checks: {
      reproduced_before: true,
      console_errors_reviewed: true,
      network_failures_reviewed: true,
      accessibility_checked: false,
    },
    artefact_ids: [afterArtefactId],
    idempotency_key: "transcript-verify-2",
  });

  heading("task_validation_status AFTER: the missing list has emptied");
  await call("task_validation_status", { review: "bugs-on-homepage", finding_id: findingId });

  heading("the agent asks a human to look");
  await call("finding_update_status", {
    finding_id: findingId,
    expected_version: claimedVersion + 3,
    status: "AWAITING_HUMAN_REVIEW",
    idempotency_key: "transcript-awaiting-2",
  });

  heading("task_complete now answers blocked_pending_review");
  await call("task_complete", {
    review: "bugs-on-homepage",
    summary: "Everything available to an agent on this review is done.",
    idempotency_key: "transcript-complete-2",
  });

  heading("the before-and-after pair, with hashes, from the artefact store");
  const pair = await postgres.pool.query(
    `SELECT va.role, a.id, a.kind, a.state, a.sha256, a.size_bytes, a.storage_key,
            a.content_width_px, a.content_height_px
       FROM verifications v
       JOIN verification_artefacts va ON va.verification_id = v.id
       JOIN artefacts a ON a.id = va.artefact_id
      WHERE v.finding_id = $1 AND v.status = 'submitted'
      UNION ALL
     SELECT 'before (finding original)', a.id, a.kind, a.state, a.sha256, a.size_bytes,
            a.storage_key, a.content_width_px, a.content_height_px
       FROM findings f JOIN artefacts a ON a.id = f.screenshot_artefact_id
      WHERE f.id = $1`,
    [findingId],
  );
  show("before/after artefacts", pair.rows);

  heading("the verification history: the first claim was superseded, not deleted");
  const history = await postgres.pool.query(
    `SELECT id, status, summary, submitted_at, superseded_at,
            superseded_by_verification_id, supersedes_verification_id
       FROM verifications WHERE finding_id = $1 ORDER BY submitted_at`,
    [findingId],
  );
  show("verifications", history.rows);

  heading("the audit record for a denied transition");
  const denied = await postgres.pool.query(
    `SELECT type, actor_type, actor_id, payload FROM events
      WHERE project_id = $1 AND type IN ('finding.status_change_denied', 'review.status_change_denied')
      ORDER BY sequence`,
    [seeded.projectId],
  );
  show("status_change_denied", denied.rows);

  heading("the recorded completion evaluations");
  const evaluations = await postgres.pool.query(
    `SELECT actor_type, actor_id, payload FROM events
      WHERE project_id = $1 AND type = 'review.completion_evaluated' ORDER BY sequence`,
    [seeded.projectId],
  );
  show("review.completion_evaluated", evaluations.rows);

  heading("the whole event sequence");
  const events = await postgres.pool.query<{ type: string; actor_type: string }>(
    "SELECT type, actor_type FROM events WHERE project_id = $1 ORDER BY sequence",
    [seeded.projectId],
  );
  process.stdout.write(
    `${events.rows.map((row) => `${row.type} (${row.actor_type})`).join("\n")}\n`,
  );

  await agent.close();
  void ADMIN;
} finally {
  await harness.stop();
  await postgres.stop();
}
