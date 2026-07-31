/**
 * The fixture the MCP tests work against: a project with the named review
 * `bugs-on-homepage` and one annotated, human-authored finding.
 *
 * It is built through the control-plane HTTP API rather than by inserting rows,
 * so the review an agent retrieves is a review a human could have created, and
 * the screenshot behind the finding has been through the digest verification of
 * `docs/API.md` section 15.
 */

import { encodeBrowserFrame } from "@reviewplane/protocol/browser";
import { newId } from "@reviewplane/server/domain";
import { sha256 } from "@reviewplane/server/testing/png";

import {
  ADMIN,
  CAPTURED_COMMIT,
  SCREENSHOT,
  WORKER_CREDENTIAL,
  type McpHarness,
} from "./harness.ts";

export interface SeededProject {
  readonly organisationId: string;
  readonly projectId: string;
  readonly projectSlug: string;
  readonly workerId: string;
  readonly browserSessionId: string;
  readonly reviewId: string;
  readonly findingId: string;
  readonly beforeArtefactId: string;
  readonly workspaceId: string;
}

export async function seedProject(
  harness: McpHarness,
  options: { readonly slug?: string; readonly reviewSlug?: string; readonly assignWorker?: boolean } = {},
): Promise<SeededProject> {
  const app = harness.control.app;
  const suffix = newId("").slice(0, 12).toLowerCase();

  const organisation = await app.inject({
    method: "POST",
    url: "/api/v1/organisations",
    headers: ADMIN,
    payload: { name: "Refresh", slug: `org-${suffix}` },
  });
  const organisationId = (organisation.json() as { data: { id: string } }).data.id;

  const projectSlug = options.slug ?? `refresh-surplus-${suffix}`;
  const project = await app.inject({
    method: "POST",
    url: `/api/v1/organisations/${organisationId}/projects`,
    headers: ADMIN,
    payload: { name: "Refresh Surplus", slug: projectSlug },
  });
  const projectId = (project.json() as { data: { id: string } }).data.id;

  const registration = await app.inject({
    method: "POST",
    url: "/internal/v1/workers/register",
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}`, "content-type": "application/json" },
    payload: encodeBrowserFrame({
      envelope: {
        protocol_version: 1,
        message_id: newId("msg_"),
        type: "worker.register",
        sent_at: new Date().toISOString(),
      },
      type: "worker.register",
      payload: {
        worker_name: "browser-worker-01",
        worker_version: "0.1.0",
        browser_type: "chromium",
        browser_version: "143.0.7499.4",
        capacity: 4,
        labels: ["chromium"],
        sandbox_enabled: true,
        started_at: new Date().toISOString(),
      },
    }),
  });
  const workerId = (registration.json() as { worker_id: string }).worker_id;

  const assignments = await app.inject({
    method: "GET",
    url: `/api/v1/browser-workers`,
    headers: ADMIN,
  });
  const existing = (assignments.json() as { data: { id: string }[] }).data;
  void existing;
  await app.inject({
    method: "PUT",
    url: `/api/v1/browser-workers/${workerId}/assignments`,
    headers: ADMIN,
    payload: { project_ids: await allAssignedProjects(harness, workerId, projectId) },
  });

  const workspace = await app.inject({
    method: "PUT",
    url: `/api/v1/projects/${projectId}/workspaces`,
    headers: ADMIN,
    payload: {
      root_path: `/workspace/${projectSlug}`,
      branch: "redesign",
      head_commit: CAPTURED_COMMIT,
      dirty: false,
    },
  });
  const workspaceId = (workspace.json() as { data: { id: string } }).data.id;

  const session = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/browser-sessions`,
    headers: ADMIN,
    payload: {
      organisation_id: organisationId,
      viewport: { width: 390, height: 844, device_scale_factor: 2 },
    },
  });
  const browserSessionId = (session.json() as { data: { id: string } }).data.id;

  const beforeArtefactId = await uploadScreenshot(harness, projectId, browserSessionId);

  const review = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/reviews`,
    headers: ADMIN,
    payload: {
      slug: options.reviewSlug ?? "bugs-on-homepage",
      title: "Bugs on homepage",
      description: "Three layout problems a customer reported on the homepage.",
      status: "READY",
      captured_branch: "redesign",
      captured_commit: CAPTURED_COMMIT,
      captured_workspace_id: workspaceId,
      source_browser_session_id: browserSessionId,
    },
  });
  const reviewId = (review.json() as { data: { id: string } }).data.id;

  const finding = await app.inject({
    method: "POST",
    url: `/api/v1/reviews/${reviewId}/findings`,
    headers: ADMIN,
    payload: {
      title: "Hero heading overlaps the navigation below 900px",
      description: "The collapse breakpoint is 768px but the navigation still wraps at 880px.",
      severity: "high",
      // No `source`: it is derived from the authenticated actor, and this
      // finding is created through the human API, so it is human-authored —
      // which is what makes the authority rule below it meaningful
      // (`docs/DOMAIN_MODEL.md` section 15).
      url: "https://route-id.internal.invalid/",
      viewport: { width: 390, height: 844, device_scale_factor: 2 },
      scroll_position: { x: 0, y: 0 },
      captured_commit: CAPTURED_COMMIT,
      screenshot_artefact_id: beforeArtefactId,
      acceptance_criteria: "No overlap between 768px and 1024px.",
      annotations: [
        {
          artefact_id: beforeArtefactId,
          type: "rectangle",
          geometry: { x: 0.08, y: 0.12, width: 0.84, height: 0.16 },
          label: "Heading text sits on top of the navigation links",
          marker_number: 1,
        },
      ],
    },
  });
  const findingId = (finding.json() as { data: { finding: { id: string } } }).data.finding.id;

  return {
    organisationId,
    projectId,
    projectSlug,
    workerId,
    browserSessionId,
    reviewId,
    findingId,
    beforeArtefactId,
    workspaceId,
  };
}

/**
 * Keeps the single Stage 0 worker assigned to every project a test created.
 * A second `seedProject` in one test would otherwise unassign the first.
 */
async function allAssignedProjects(
  harness: McpHarness,
  workerId: string,
  projectId: string,
): Promise<string[]> {
  const rows = await harness.control.workers.assignedProjects(workerId);
  return [...new Set([...rows, projectId])];
}

export async function uploadScreenshot(
  harness: McpHarness,
  projectId: string,
  browserSessionId: string,
  bytes: Buffer = SCREENSHOT,
): Promise<string> {
  const app = harness.control.app;
  const digest = sha256(bytes);
  const intent = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/artefacts/uploads`,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}` },
    payload: {
      kind: "screenshot",
      content_type: "image/png",
      size_bytes: bytes.byteLength,
      sha256: digest,
      browser_session_id: browserSessionId,
      retention_class: "verification_evidence",
    },
  });
  const artefactId = (intent.json() as { data: { artefact_id: string } }).data.artefact_id;
  await app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/content`,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}`, "content-type": "image/png" },
    payload: bytes,
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/artefacts/${artefactId}/complete`,
    headers: { authorization: `Bearer ${WORKER_CREDENTIAL}` },
    payload: { sha256: digest, size_bytes: bytes.byteLength },
  });
  return artefactId;
}

/** Issues an agent credential through the administrative API. */
export async function issueAgentCredential(
  harness: McpHarness,
  input: {
    readonly organisationId: string;
    readonly projectIds: readonly string[];
    readonly capabilities?: readonly string[];
    readonly ttlSeconds?: number;
  },
): Promise<{ token: string; credentialId: string }> {
  const response = await harness.control.app.inject({
    method: "POST",
    url: `/api/v1/organisations/${input.organisationId}/agent-credentials`,
    headers: ADMIN,
    payload: {
      project_ids: [...input.projectIds],
      ...(input.capabilities === undefined ? {} : { capabilities: [...input.capabilities] }),
      label: "claude-code on dev-ai-03",
      ...(input.ttlSeconds === undefined ? {} : { ttl_seconds: input.ttlSeconds }),
    },
  });
  const data = (response.json() as { data: { token: string; credential_id: string } }).data;
  return { token: data.token, credentialId: data.credential_id };
}

/**
 * Assigns a review to an agent session, as a human would, which is what
 * creates the inbox item (`docs/DOMAIN_MODEL.md` section 21).
 */
export async function assignReviewToAgent(
  harness: McpHarness,
  reviewId: string,
  agentSessionId: string,
  expectedVersion = 1,
): Promise<{ status: number; body: unknown }> {
  const response = await harness.control.app.inject({
    method: "POST",
    url: `/api/v1/reviews/${reviewId}/assign`,
    headers: ADMIN,
    payload: { expected_version: expectedVersion, assigned_agent_session_id: agentSessionId },
  });
  return { status: response.statusCode, body: response.json() };
}

/** Associates a browser session with an agent session, as a human would. */
export async function startBrowserSessionForAgent(
  harness: McpHarness,
  seeded: SeededProject,
  agentSessionId: string,
): Promise<{ browserSessionId: string; controlEpoch: number }> {
  const response = await harness.control.app.inject({
    method: "POST",
    url: `/api/v1/projects/${seeded.projectId}/browser-sessions`,
    headers: ADMIN,
    payload: {
      organisation_id: seeded.organisationId,
      viewport: { width: 390, height: 844, device_scale_factor: 2 },
      agent_session_id: agentSessionId,
      controller: { type: "agent", id: agentSessionId },
      retention_class: "verification_evidence",
    },
  });
  const data = (response.json() as { data: { id: string; control_epoch: number } }).data;
  return { browserSessionId: data.id, controlEpoch: data.control_epoch };
}
