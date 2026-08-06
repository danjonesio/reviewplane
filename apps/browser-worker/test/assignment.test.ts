/**
 * The worker's copy of its project assignment, and the window before it
 * converges (ADR-0026, RVP-60).
 *
 * The assignment exists twice: in `browser_worker_projects`, written when an
 * administrator assigns, and in this process, restated on every heartbeat
 * acknowledgement. Only the second one decides whether an allocation reaching
 * this worker is accepted, and it converges up to one heartbeat interval after
 * the first. That window is designed — Stage 1 has no push channel — but it is
 * invisible from the control plane, where the row is already there and every
 * check already passes.
 *
 * `deploy/compose/e2e/run.sh` waited on the row and reported that the worker
 * had picked its assignment up, then allocated a session the worker refused
 * with `PROJECT_CONTEXT_MISMATCH` a second later. It cost a Compose stack and a
 * database session to work out which of two identically worded refusals had
 * fired. These tests make the same statement in milliseconds: the set is empty
 * until a heartbeat carries it, an allocation in that window is refused, and
 * the refusal tracks the set in both directions.
 *
 * The suite deliberately never launches Chromium: the assignment check runs
 * before a context is opened, so the refusal path is complete without one, and
 * a test that depended on a browser being installed would not run here at all
 * (`pnpm test:browser` is the suite that has one).
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  encodeBrowserFrame,
  type SessionAllocate,
} from "@reviewplane/protocol/browser";

import { loadWorkerConfig } from "../src/config.ts";
import { SessionManager, SessionRefusal } from "../src/session/manager.ts";
import { startWorker, type RunningWorker } from "../src/worker.ts";

const CREDENTIAL = "worker-credential-for-assignment-tests";
const PROJECT = "prj_fixture";
const OTHER_PROJECT = "prj_other";

let sessionRoot: string;

before(async () => {
  sessionRoot = await mkdtemp(join(tmpdir(), "reviewplane-assignment-"));
});

after(async () => {
  await rm(sessionRoot, { recursive: true, force: true });
});

/**
 * A port nothing is listening on.
 *
 * The worker's listener takes its port from configuration, which refuses 0, so
 * the port is discovered rather than requested. Two runs of this file in
 * parallel therefore get different ports instead of colliding on a constant.
 */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });
  return port;
}

function allocationFor(projectId: string): SessionAllocate {
  return {
    organisation_id: "org_fixture",
    project_id: projectId,
    viewport: { width: 1440, height: 900, device_scale_factor: 1 },
    control_epoch: 1,
    controller: { type: "agent", id: "ags_assignment" },
    limits: {
      max_duration_seconds: 300,
      default_timeout_ms: 15000,
      max_command_timeout_ms: 30000,
      screenshot_max_bytes: 20971520,
      snapshot_max_nodes: 60,
      snapshot_max_bytes: 4096,
    },
    retention_class: "verification_evidence",
  };
}

/** The code an allocation was refused with, or null if it was not refused. */
async function refusalCode(manager: SessionManager, projectId: string): Promise<string | null> {
  try {
    await manager.allocate(`brs_${Math.random().toString(36).slice(2)}`, allocationFor(projectId));
    return null;
  } catch (error) {
    if (error instanceof SessionRefusal) return error.error.code;
    // Anything else means the check under test let the request through and it
    // failed further on, which is not a refusal.
    return null;
  }
}

test("a worker that has not been told its assignment serves nothing", async () => {
  // "Not yet assigned" is not "anything": `docs/SECURITY.md` section 6.4. A
  // manager that has never been given a set refuses, rather than treating the
  // absence of a restriction as the absence of a rule.
  const manager = new SessionManager({
    config: loadWorkerConfig({
      REVIEWPLANE_WORKER_CREDENTIAL: CREDENTIAL,
      REVIEWPLANE_WORKER_COMMAND_CREDENTIAL: "command-credential-for-assignment-tests",
      REVIEWPLANE_WORKER_SESSION_ROOT: sessionRoot,
    }),
    artefacts: {
      upload: () => {
        throw new Error("no artefact upload is expected in this suite");
      },
    } as never,
    observer: { onStatus: () => undefined },
  });
  assert.deepEqual([...manager.assignedProjects], []);
  assert.equal(await refusalCode(manager, PROJECT), "PROJECT_CONTEXT_MISMATCH");
  await manager.shutdown();
});

test("a project assigned while the worker is running takes effect on its next heartbeat, and not before it", async () => {
  // The control plane's answers, changed between assertions the way an
  // administrator changes the assignment underneath a running worker.
  const state = {
    assignedProjects: [] as string[],
    answerHeartbeats: false,
    heartbeats: 0,
  };

  const fetchImplementation: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    if (url.pathname === "/internal/v1/workers/register") {
      return new Response(
        JSON.stringify({
          worker_id: "wkr_assignment_test",
          payload: {
            accepted: true,
            // The worker registers before the project is assigned to it, which
            // is the ordering the Compose scenario has: the container starts
            // with the control plane and the assignment is made later.
            assigned_projects: [...state.assignedProjects],
            session_limits: {
              max_duration_seconds: 7200,
              default_timeout_ms: 30000,
              max_command_timeout_ms: 120000,
              screenshot_max_bytes: 20971520,
              snapshot_max_nodes: 400,
              snapshot_max_bytes: 32768,
            },
            // Short enough to drive from a test and still a real interval: the
            // property is that the set converges on a heartbeat, not that it
            // converges quickly.
            heartbeat_interval_seconds: 0.05,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.pathname === "/internal/v1/workers/heartbeat") {
      state.heartbeats += 1;
      if (!state.answerHeartbeats) {
        // A heartbeat the control plane could not answer. ADR-0026: losing an
        // answer is not being told the set is empty.
        return new Response("", { status: 503 });
      }
      return new Response(
        encodeBrowserFrame({
          envelope: {
            protocol_version: 1,
            message_id: "msg_ack",
            type: "worker.heartbeat.ack",
            sent_at: new Date().toISOString(),
            worker_id: "wkr_assignment_test",
          },
          type: "worker.heartbeat.ack",
          payload: {
            assigned_projects: [...state.assignedProjects],
            // The schema floors this at 5 seconds and the worker decodes the
            // acknowledgement through it, so the ack carries a real value. The
            // timer is the registration ack's, above, which is not decoded —
            // and which is also the only one `worker.ts` ever reads, so a
            // cadence change here would not reach the timer anyway.
            heartbeat_interval_seconds: 5,
            observed_at: new Date().toISOString(),
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected control-plane call to ${url.pathname}`);
  };

  let worker: RunningWorker | undefined;
  try {
    worker = await startWorker({
      config: loadWorkerConfig({
        REVIEWPLANE_WORKER_CREDENTIAL: CREDENTIAL,
        REVIEWPLANE_WORKER_COMMAND_CREDENTIAL: "command-credential-for-assignment-tests",
        REVIEWPLANE_WORKER_SESSION_ROOT: sessionRoot,
        REVIEWPLANE_WORKER_PORT: String(await freePort()),
        REVIEWPLANE_CONTROL_PLANE_URL: "http://control-plane.invalid",
      }),
      fetchImplementation,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    });
    const { manager } = worker;

    // The assignment exists in the control plane from here on. The worker's
    // copy does not, and no number of heartbeats the control plane cannot
    // answer will change that.
    state.assignedProjects = [PROJECT];
    const before = state.heartbeats;
    await waitFor(() => state.heartbeats > before + 2, "heartbeats to be attempted");
    assert.deepEqual([...manager.assignedProjects], []);
    assert.equal(
      await refusalCode(manager, PROJECT),
      "PROJECT_CONTEXT_MISMATCH",
      "an allocation before the assignment has reached the worker must be refused",
    );

    // One answered heartbeat is the whole mechanism: no restart, no second
    // message, no acknowledgement of its own.
    state.answerHeartbeats = true;
    await waitFor(
      () => manager.assignedProjects.includes(PROJECT),
      "the assignment to reach the worker on a heartbeat",
    );
    assert.deepEqual([...manager.assignedProjects], [PROJECT]);

    // The refusal tracks the set rather than the registration: a project the
    // set never named is still refused, and one removed from it is refused
    // again without a restart.
    assert.equal(await refusalCode(manager, OTHER_PROJECT), "PROJECT_CONTEXT_MISMATCH");
    await manager.applyAssignment([]);
    assert.equal(await refusalCode(manager, PROJECT), "PROJECT_CONTEXT_MISMATCH");
  } finally {
    await worker?.stop();
  }
});

/** Polls a condition, failing with what it was waiting for rather than a timeout. */
async function waitFor(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}
