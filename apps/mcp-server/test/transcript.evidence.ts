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
import { assignReviewToAgent, issueAgentCredential, seedProject } from "./helpers/seed.ts";

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

  heading("the audit record for a denied transition");
  const denied = await postgres.pool.query(
    `SELECT type, actor_type, actor_id, payload FROM events
      WHERE project_id = $1 AND type IN ('finding.status_change_denied', 'review.status_change_denied')
      ORDER BY sequence`,
    [seeded.projectId],
  );
  show("status_change_denied", denied.rows);

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
