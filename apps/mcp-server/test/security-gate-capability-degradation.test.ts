/**
 * The standing **capability-degradation gate** (RVP-96, `docs/ARCHITECTURE.md`
 * section 8.3, `docs/MCP_SPEC.md` section 3, `docs/UX_FLOWS.md` section 18).
 *
 * A client that cannot read image bytes must still be able to do the work. The
 * property is *degradation*, and degradation is a comparison: it is not "the
 * reduced client got an answer" but "the reduced client reached the same
 * outcome, by the same route, with the same evidence — and was told what it was
 * given instead."
 *
 * So this gate runs the agent loop **twice against identical fixtures**, once
 * with `image_resources: true` and once with it negotiated to `false`, and
 * compares the two. A test that only exercised the reduced path could not tell
 * a graceful degradation from a path that had quietly stopped doing something
 * both clients need — the artefact identity is the clearest example: a reduced
 * client that received a *different* screenshot would satisfy every assertion
 * about links and warnings while being given the wrong evidence.
 *
 * `image_resources` is the **negotiated** result and not a property of the
 * server (`apps/mcp-server/src/context.ts`): it is `resources && image_content`,
 * so there are two ways a client can declare it away and both are exercised.
 *
 * The secret assertions are here rather than in a suite of their own because
 * "on either path" is the requirement. A degraded response takes a different
 * branch through the resource reader and the tool views, and a branch that runs
 * only for reduced clients is exactly where a raw `content_path` could become a
 * raw credential without anybody noticing.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { startMigratedDatabase, truncateAll, type MigratedDatabase } from "@reviewplane/server/testing";

import {
  BOOTSTRAP_TOKEN,
  WORKER_COMMAND_CREDENTIAL,
  WORKER_CREDENTIAL,
  connectAgent,
  envelopeOf,
  resourceLinksOf,
  startMcpHarness,
  type McpHarness,
} from "./helpers/harness.ts";
import {
  issueAgentCredential,
  seedProject,
  startBrowserSessionForAgent,
  type SeededProject,
} from "./helpers/seed.ts";

let postgres: MigratedDatabase;
let harness: McpHarness;

before(async () => {
  postgres = await startMigratedDatabase();
});

after(async () => {
  await harness?.stop();
  await postgres?.stop();
});

beforeEach(async () => {
  await harness?.stop();
  await truncateAll(postgres.pool);
  harness = await startMcpHarness(postgres.pool);
});

const VIEWPORTS = [
  { width: 390, height: 844, device_scale_factor: 2 },
  { width: 1440, height: 900, device_scale_factor: 1 },
];
const CHECKS = {
  reproduced_before: true,
  console_errors_reviewed: true,
  network_failures_reviewed: true,
};
const FIXED_COMMIT = "b4c5d6e7f809192a3b4c5d6e7f809192a3b4c5d6";

interface Agent {
  readonly client: Awaited<ReturnType<typeof connectAgent>>["client"];
  readonly close: () => Promise<void>;
  readonly seeded: SeededProject;
  readonly token: string;
}

/**
 * A project of its own, and an agent connected to it with the given
 * declaration.
 *
 * Each run gets its own project so that the two can be compared rather than
 * interfere: the loop below claims a review and moves a finding, which is a
 * one-way trip.
 */
async function run(
  slug: string,
  declaration: { readonly imageContent?: boolean; readonly resources?: boolean } = {},
): Promise<Agent> {
  const seeded = await seedProject(harness, { slug, reviewSlug: slug });
  const credential = await issueAgentCredential(harness, {
    organisationId: seeded.organisationId,
    projectIds: [seeded.projectId],
  });
  const agent = await connectAgent(harness, {
    token: credential.token,
    projectHint: seeded.projectSlug,
    ...(declaration.imageContent === undefined ? {} : { imageContent: declaration.imageContent }),
  });
  return { client: agent.client, close: agent.close, seeded, token: credential.token };
}

async function call(
  agent: Agent,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ envelope: Record<string, unknown>; result: unknown }> {
  const result = await agent.client.callTool({ name, arguments: args });
  return { envelope: envelopeOf(result), result };
}

function dataOf(envelope: Record<string, unknown>): Record<string, unknown> {
  return (envelope["data"] ?? {}) as Record<string, unknown>;
}

function warningCodes(envelope: Record<string, unknown>): string[] {
  return ((envelope["warnings"] ?? []) as { code: string }[]).map((warning) => warning.code);
}

/** What one run of the agent loop produced, for comparison against the other. */
interface Outcome {
  readonly imageResources: boolean;
  readonly otherCapabilities: Record<string, unknown>;
  readonly afterArtefactSha256: string;
  readonly afterArtefactPath: string;
  readonly screenshotWarnings: string[];
  readonly findingWarnings: string[];
  readonly findingLinks: string[];
  readonly verificationStatus: string;
  readonly finalFindingStatus: string;
  /** Every envelope the run produced, for the secret sweep. */
  readonly transcript: string;
}

/**
 * The whole agent loop, from claiming the review to `AWAITING_HUMAN_REVIEW`.
 *
 * The point of running the *whole* loop rather than one degraded read is that
 * degradation must not stop the agent finishing. A reduced client that could
 * read a finding but never submit evidence would pass a narrower test and be
 * useless.
 */
async function driveTheLoop(agent: Agent): Promise<Outcome> {
  const envelopes: Record<string, unknown>[] = [];
  const record = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ envelope: Record<string, unknown>; result: unknown }> => {
    const outcome = await call(agent, name, args);
    envelopes.push(outcome.envelope);
    assert.equal(outcome.envelope["ok"], true, `${name}: ${JSON.stringify(outcome.envelope)}`);
    return outcome;
  };

  const status = await record("agent_session_status", {});
  const capabilities = dataOf(status.envelope)["capabilities"] as Record<string, unknown>;
  const agentSessionId = dataOf(status.envelope)["agent_session_id"] as string;

  const review = await record("review_get", { review: agent.seeded.reviewId });
  const version = (dataOf(review.envelope)["review"] as { version: number }).version;
  await record("review_claim", {
    review_id: agent.seeded.reviewId,
    expected_version: version,
    idempotency_key: "degradation-claim-review",
  });
  await record("finding_claim", {
    finding_id: agent.seeded.findingId,
    expected_version: 1,
    idempotency_key: "degradation-claim-finding",
  });
  await record("finding_update_status", {
    finding_id: agent.seeded.findingId,
    expected_version: 2,
    status: "IN_PROGRESS",
    idempotency_key: "degradation-progress",
  });

  const finding = await record("finding_get", { finding_id: agent.seeded.findingId });

  const browser = await startBrowserSessionForAgent(harness, agent.seeded, agentSessionId);
  const shot = await record("browser_take_screenshot", {
    browser_session_id: browser.browserSessionId,
    control_epoch: browser.controlEpoch,
    purpose: "verification",
    idempotency_key: "degradation-shot",
  });
  const artefact = dataOf(shot.envelope)["artefact"] as { artefact_id: string };

  const submitted = await record("finding_submit_verification", {
    finding_id: agent.seeded.findingId,
    summary: "Changed the navigation collapse breakpoint to 900px.",
    branch: "redesign",
    commit: FIXED_COMMIT,
    tested_viewports: VIEWPORTS,
    checks: CHECKS,
    artefact_ids: [artefact.artefact_id],
    idempotency_key: "degradation-verify",
  });
  const awaiting = await record("finding_update_status", {
    finding_id: agent.seeded.findingId,
    expected_version: 4,
    status: "AWAITING_HUMAN_REVIEW",
    idempotency_key: "degradation-awaiting",
  });

  // The evidence itself, read as a resource. This is the read that branches on
  // the negotiated capability.
  const read = await agent.client.readResource({ uri: `screenshot://${artefact.artefact_id}` });
  const contents = read.contents[0] as { mimeType: string; blob?: string; text?: string };
  const described =
    contents.blob === undefined
      ? (JSON.parse(contents.text as string) as {
          sha256: string;
          content_path: string;
          degraded?: { reason: string; detail: string };
        })
      : null;

  // Whichever way it arrived, the artefact's identity comes from the control
  // plane's own row rather than from the response, so the comparison between
  // the two runs is against the stored fact and not against a claim.
  const stored = await postgres.pool.query<{ sha256: string }>(
    "SELECT sha256 FROM artefacts WHERE id = $1",
    [artefact.artefact_id],
  );
  const sha256 = stored.rows[0]?.sha256;
  assert.ok(typeof sha256 === "string" && sha256.length === 64);
  if (described !== null) {
    assert.equal(described.sha256, sha256, "the degraded read described a different artefact");
    assert.equal(described.degraded?.reason, "image_resources_unsupported");
    assert.ok(
      (described.degraded?.detail ?? "").length > 20,
      "a degraded read must say what the caller was given instead",
    );
  } else {
    assert.equal(contents.mimeType, "image/png");
  }

  const { image_resources: imageResources, ...otherCapabilities } = capabilities;
  return {
    imageResources: imageResources === true,
    otherCapabilities,
    afterArtefactSha256: sha256,
    afterArtefactPath: described?.content_path ?? `/api/v1/artefact-content/${artefact.artefact_id}`,
    screenshotWarnings: warningCodes(shot.envelope),
    findingWarnings: warningCodes(finding.envelope),
    findingLinks: resourceLinksOf(finding.result).map((link) => link.uri),
    verificationStatus: (dataOf(submitted.envelope)["verification"] as { status: string }).status,
    finalFindingStatus: (dataOf(awaiting.envelope)["finding"] as { status: string }).status,
    transcript: JSON.stringify(envelopes) + JSON.stringify(read),
  };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test("a client that declares no image capability completes the whole agent loop", async () => {
  const reduced = await run("degraded", { imageContent: false });
  try {
    const outcome = await driveTheLoop(reduced);
    assert.equal(outcome.imageResources, false, "image_resources should have negotiated to false");
    // The loop finished. This is the property the issue names: the agent path
    // degrades rather than failing.
    assert.equal(outcome.verificationStatus, "submitted");
    assert.equal(outcome.finalFindingStatus, "AWAITING_HUMAN_REVIEW");

    // And it was told what it was given instead, on both surfaces that carry
    // evidence, rather than being handed a silently emptier answer.
    assert.ok(
      outcome.findingWarnings.includes("image_content_unsupported"),
      `finding_get carried no degradation warning: ${outcome.findingWarnings.join(", ")}`,
    );
    assert.ok(
      outcome.screenshotWarnings.includes("image_content_unsupported"),
      `browser_take_screenshot carried no degradation warning: ${outcome.screenshotWarnings.join(", ")}`,
    );
    assert.ok(
      outcome.findingLinks.some((uri) => uri.startsWith("screenshot://")),
      "evidence must still arrive as resource links",
    );
    assert.match(outcome.afterArtefactPath, /^\/api\/v1\/artefact-content\//u);
  } finally {
    await reduced.close();
  }
});

test("the reduced run and the full run reach the same outcome with the same evidence", async () => {
  // Degradation is a comparison. Run both against identical fixtures and hold
  // them beside each other: everything except how the bytes were delivered must
  // be the same, and the artefact digest is read from the control plane's own
  // row so that "the same evidence" is a fact rather than a claim in a response.
  const full = await run("full");
  const reduced = await run("degraded", { imageContent: false });
  try {
    const withImages = await driveTheLoop(full);
    const withoutImages = await driveTheLoop(reduced);

    assert.equal(withImages.imageResources, true);
    assert.equal(withoutImages.imageResources, false);

    // Only `image_resources` differs. Degradation is per capability: a client
    // that cannot read images has not lost its inbox or its browser.
    assert.deepEqual(
      withoutImages.otherCapabilities,
      withImages.otherCapabilities,
      "declaring away image content changed a capability that has nothing to do with images",
    );

    assert.equal(withoutImages.verificationStatus, withImages.verificationStatus);
    assert.equal(withoutImages.finalFindingStatus, withImages.finalFindingStatus);
    assert.equal(
      withoutImages.afterArtefactSha256,
      withImages.afterArtefactSha256,
      "the two runs captured different evidence, so this is not the same work done two ways",
    );

    // The difference, stated: warnings and no inline bytes on one side, nothing
    // on the other. Asserting the *absence* on the full path is what stops a
    // change that degrades everybody from passing this file.
    assert.deepEqual(withImages.findingWarnings, []);
    assert.deepEqual(withImages.screenshotWarnings, []);
    assert.ok(withoutImages.findingWarnings.includes("image_content_unsupported"));

    // Both were given the links. The reduced client is not compensated with a
    // different route to the bytes; it is given the same one.
    assert.deepEqual(
      withoutImages.findingLinks.map((uri) => uri.split("//")[0]),
      withImages.findingLinks.map((uri) => uri.split("//")[0]),
    );
  } finally {
    await reduced.close();
    await full.close();
  }
});

test("either declaration negotiates image_resources away, and neither touches the rest", async () => {
  // `image_resources` is `resources && image_content` (`src/context.ts`), so
  // there are two ways to lose it and both are exercised. A negotiation that
  // read only `image_content` would tell a client with no resource support that
  // it could be handed an image resource.
  //
  // The value asserted is the **server's** answer, read back through
  // `agent_session_status` — where a client reads it (`docs/MCP_SPEC.md`
  // section 3) — rather than recomputed here from what the session row records.
  // Recomputing it would assert this test's arithmetic and nothing else.
  const seeded = await seedProject(harness);
  const credential = await issueAgentCredential(harness, {
    organisationId: seeded.organisationId,
    projectIds: [seeded.projectId],
  });

  const declarations: readonly {
    readonly what: string;
    readonly options: { readonly imageContent?: boolean; readonly resources?: boolean };
    readonly imageResources: boolean;
  }[] = [
    { what: "declaring nothing", options: {}, imageResources: true },
    { what: "image_content=false", options: { imageContent: false }, imageResources: false },
    { what: "resources=false", options: { resources: false }, imageResources: false },
    {
      what: "both false",
      options: { resources: false, imageContent: false },
      imageResources: false,
    },
  ];

  let baseline: Record<string, unknown> | null = null;
  for (const declaration of declarations) {
    const agent = await connectAgent(harness, {
      token: credential.token,
      clientName: `capability-gate-${declaration.what.replace(/\W/gu, "-")}`,
      ...declaration.options,
    });
    try {
      const status = envelopeOf(
        await agent.client.callTool({ name: "agent_session_status", arguments: {} }),
      );
      const capabilities = (status["data"] as Record<string, unknown>)["capabilities"] as Record<
        string,
        unknown
      >;
      assert.equal(
        capabilities["image_resources"],
        declaration.imageResources,
        `${declaration.what}: ${JSON.stringify(capabilities)}`,
      );

      // Degradation is per capability. Losing image support must not quietly
      // take the inbox, the browser or takeover with it.
      const { image_resources: _dropped, ...rest } = capabilities;
      baseline ??= rest;
      assert.deepEqual(
        rest,
        baseline,
        `${declaration.what} changed a capability that has nothing to do with images`,
      );
    } finally {
      await agent.close();
    }
  }
});

// ---------------------------------------------------------------------------
// No raw secret on either path
// ---------------------------------------------------------------------------

test("no raw credential appears in any response, log line or event on either path", async () => {
  const full = await run("full");
  const reduced = await run("degraded", { imageContent: false });
  let withImages: Outcome;
  let withoutImages: Outcome;
  try {
    withImages = await driveTheLoop(full);
    withoutImages = await driveTheLoop(reduced);
  } finally {
    await reduced.close();
    await full.close();
  }

  // Every credential in play. The agent tokens are the ones a degraded response
  // could plausibly carry, because a `content_path` is built next to the grant
  // that authorises it; the worker and bootstrap credentials are here because a
  // response assembled from a worker frame is assembled next to them.
  const secrets: readonly { readonly name: string; readonly value: string }[] = [
    { name: "the full client's agent token", value: full.token },
    { name: "the reduced client's agent token", value: reduced.token },
    { name: "the bootstrap token", value: BOOTSTRAP_TOKEN },
    { name: "the worker credential", value: WORKER_CREDENTIAL },
    { name: "the worker command credential", value: WORKER_COMMAND_CREDENTIAL },
  ];

  const events = await postgres.pool.query<{ type: string; payload: unknown }>(
    "SELECT type, payload FROM events",
  );
  assert.ok(events.rows.length > 0, "the runs recorded no events, so this sweep is empty");
  const eventText = JSON.stringify(events.rows);
  const logText = harness.logText();

  const haystacks: readonly { readonly what: string; readonly text: string }[] = [
    { what: "a response on the full path", text: withImages.transcript },
    { what: "a response on the reduced path", text: withoutImages.transcript },
    { what: "an event payload", text: eventText },
    { what: "a control-plane log line", text: logText },
  ];

  for (const secret of secrets) {
    // A prefix search as well as the whole value: a truncated token is still a
    // disclosure of most of one, and a log line that printed the first sixteen
    // characters would pass an equality search.
    const prefix = secret.value.slice(0, 16);
    assert.ok(prefix.length === 16, secret.name);
    for (const haystack of haystacks) {
      assert.ok(
        !haystack.text.includes(secret.value),
        `${secret.name} appears verbatim in ${haystack.what}`,
      );
      assert.ok(
        !haystack.text.includes(prefix),
        `the first 16 characters of ${secret.name} appear in ${haystack.what}`,
      );
    }
  }

  // The sweep has to have had something to search. A run that produced an empty
  // transcript would satisfy every assertion above.
  assert.ok(withImages.transcript.length > 2000, "the full path produced no transcript");
  assert.ok(withoutImages.transcript.length > 2000, "the reduced path produced no transcript");
  assert.ok(logText.length > 0, "the control plane logged nothing, so the log sweep is empty");
});
