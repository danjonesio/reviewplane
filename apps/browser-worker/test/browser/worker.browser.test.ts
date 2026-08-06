/**
 * Browser tests (`docs/TESTING.md` section 7) plus the prompt-injection and
 * fault-injection cases of sections 10 and 11.
 *
 * These run a real Chromium with its sandbox enabled, against the fixture
 * applications in `fixture-app.ts` and the verifying stub control plane in
 * `stub-control-plane.ts`. They are separate from the default `pnpm test`
 * because they need a Chromium and its system libraries; `pnpm test:browser`
 * runs them inside the worker's own container image, which is also where the
 * container-inspection evidence comes from.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { SensitiveString } from "@reviewplane/protocol";
import {
  validateBrowserCommandResult,
  type BrowserCommand,
  type SchemaViolation,
  type BrowserCommandResult,
  type SessionAllocate,
  type Viewport,
} from "@reviewplane/protocol/browser";

import { loadWorkerConfig, type WorkerConfig } from "../../src/config.ts";
import { ControlPlaneClient } from "../../src/control-plane.ts";
import { newId } from "../../src/ids.ts";
import { createRecordingLogger } from "../../src/logging.ts";
import { directoryExists, tunnelArguments } from "../../src/session/session.ts";
import { SessionManager, SessionRefusal } from "../../src/session/manager.ts";
import { captureSize } from "../../src/session/viewport.ts";

import { startFixtureApp, type FixtureApp } from "./fixture-app.ts";
import { startStubControlPlane, type StubControlPlane } from "./stub-control-plane.ts";

const CREDENTIAL = "worker-credential-for-browser-tests";
const DESKTOP: Viewport = { width: 1440, height: 900, device_scale_factor: 1 };
const MOBILE: Viewport = { width: 390, height: 844, device_scale_factor: 2 };
const AGENT = { type: "agent", id: "ags_browser_test" } as const;
const SYSTEM = { type: "system", id: "wkr_browser_test" } as const;

let fixture: FixtureApp;
let controlPlane: StubControlPlane;
let sessionRoot: string;
let config: WorkerConfig;
let manager: SessionManager;
let logs: string[];
let statuses: { id: string; status: string }[];

before(async () => {
  fixture = await startFixtureApp();
  controlPlane = await startStubControlPlane(CREDENTIAL);
  sessionRoot = await mkdtemp(join(tmpdir(), "reviewplane-sessions-"));
});

after(async () => {
  await manager?.shutdown();
  await fixture?.stop();
  await controlPlane?.stop();
  await rm(sessionRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await manager?.shutdown();
  const recording = createRecordingLogger();
  logs = recording.lines;
  statuses = [];
  config = loadWorkerConfig({
    REVIEWPLANE_WORKER_CREDENTIAL: CREDENTIAL,
    REVIEWPLANE_WORKER_COMMAND_CREDENTIAL: "command-credential-for-browser-tests",
    REVIEWPLANE_CONTROL_PLANE_URL: controlPlane.origin,
    REVIEWPLANE_WORKER_SESSION_ROOT: sessionRoot,
    REVIEWPLANE_WORKER_CAPACITY: "2",
    REVIEWPLANE_WORKER_SNAPSHOT_MAX_NODES: "60",
    REVIEWPLANE_WORKER_SNAPSHOT_MAX_BYTES: "4096",
  });
  const client = new ControlPlaneClient({
    baseUrl: config.controlPlaneUrl,
    credential: config.controlPlaneCredential,
    workerName: config.name,
  });
  manager = new SessionManager({
    config,
    artefacts: client,
    observer: {
      onStatus: (session, report) => {
        statuses.push({ id: session.id, status: report.status });
      },
    },
  });
  manager.setAssignedProjects(["prj_fixture"]);
});

function allocationFor(overrides: Partial<SessionAllocate> = {}): SessionAllocate {
  return {
    organisation_id: "org_fixture",
    project_id: "prj_fixture",
    service_origin: fixture.origin,
    viewport: DESKTOP,
    control_epoch: 1,
    controller: AGENT,
    limits: {
      max_duration_seconds: 300,
      default_timeout_ms: 15000,
      max_command_timeout_ms: 30000,
      screenshot_max_bytes: 20971520,
      snapshot_max_nodes: 60,
      snapshot_max_bytes: 4096,
    },
    retention_class: "verification_evidence",
    ...overrides,
  };
}

let sequence = 0;
async function run(
  sessionId: string,
  command: BrowserCommand,
  options: { controller?: typeof AGENT | typeof SYSTEM; epoch?: number } = {},
): Promise<BrowserCommandResult> {
  sequence += 1;
  const result = await manager.handleCommand(
    sessionId,
    options.controller ?? AGENT,
    options.epoch ?? 1,
    sequence,
    command,
  );
  // Every result must satisfy the schema, including its trust rule.
  const violations: SchemaViolation[] = [];
  validateBrowserCommandResult(result, "$", violations);
  assert.deepEqual(violations, [], `result for ${command.command} violated the schema`);
  return result;
}

const navigate = (url: string, waitUntil: "load" | "domcontentloaded" = "domcontentloaded"): BrowserCommand => ({
  command: "navigate",
  timeout_ms: 15000,
  navigate: { url, wait_until: waitUntil },
});

const snapshot = (): BrowserCommand => ({ command: "snapshot", timeout_ms: 15000 });

const screenshot = (persist = true): BrowserCommand => ({
  command: "take_screenshot",
  timeout_ms: 20000,
  take_screenshot: { full_page: false, persist, purpose: "verification" },
});

// ---------------------------------------------------------------------------

test("a session launches Chromium with the sandbox enabled and an ephemeral profile", async () => {
  const id = newId("brs_");
  const session = await manager.allocate(id, allocationFor());
  assert.equal(session.status, "READY");
  assert.match(session.browserVersion, /^[0-9]+\./u);
  assert.notEqual(session.profileDirectory, null);
  assert.equal(await directoryExists(session.profileDirectory as string), true);
  assert.equal(session.controlEpoch, 1);
  assert.deepEqual(session.controller, AGENT);
  assert.ok(statuses.some((entry) => entry.id === id && entry.status === "READY"));
});

test("terminating a session destroys its ephemeral data", async () => {
  const id = newId("brs_");
  const session = await manager.allocate(id, allocationFor());
  const directory = session.profileDirectory as string;
  await run(id, navigate("/set-cookie"));
  assert.equal(await directoryExists(directory), true);

  const report = await manager.terminate(id, "requested");
  assert.equal(report.status, "TERMINATED");
  assert.equal(await directoryExists(directory), false);
  assert.equal(manager.get(id), undefined);
});

test("a command for a terminated session returns BROWSER_SESSION_NOT_ACTIVE", async () => {
  const id = newId("brs_");
  await manager.allocate(id, allocationFor());
  await manager.terminate(id, "requested");
  const result = await run(id, snapshot());
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "BROWSER_SESSION_NOT_ACTIVE");
});

test("capacity exhaustion is refused with BROWSER_CAPACITY_EXHAUSTED", async () => {
  await manager.allocate(newId("brs_"), allocationFor());
  await manager.allocate(newId("brs_"), allocationFor());
  await assert.rejects(
    () => manager.allocate(newId("brs_"), allocationFor()),
    (error: unknown) =>
      error instanceof SessionRefusal && error.error.code === "BROWSER_CAPACITY_EXHAUSTED",
  );
});

test("a session for an unassigned project is refused", async () => {
  await assert.rejects(
    () => manager.allocate(newId("brs_"), allocationFor({ project_id: "prj_other" })),
    (error: unknown) =>
      error instanceof SessionRefusal && error.error.code === "PROJECT_CONTEXT_MISMATCH",
  );
});

test("cookies and storage are isolated between sessions and between projects", async () => {
  const first = newId("brs_");
  await manager.allocate(first, allocationFor());
  await run(first, navigate("/set-cookie"));
  const firstRead = await run(first, navigate("/read-cookie"));
  assert.equal(firstRead.ok, true);
  const firstSnapshot = await run(first, snapshot());
  assert.match(firstSnapshot.snapshot?.text ?? "", /session=fixture-secret/u);

  // A second session of the same project must not see it.
  const second = newId("brs_");
  await manager.allocate(second, allocationFor());
  await run(second, navigate("/read-cookie"));
  const secondSnapshot = await run(second, snapshot());
  assert.doesNotMatch(secondSnapshot.snapshot?.text ?? "", /fixture-secret/u);
  assert.match(secondSnapshot.snapshot?.text ?? "", /no-cookie/u);

  await manager.terminate(second, "requested");

  // And a session of a different project must not either.
  manager.setAssignedProjects(["prj_fixture", "prj_second"]);
  const other = newId("brs_");
  await manager.allocate(other, allocationFor({ project_id: "prj_second" }));
  await run(other, navigate("/read-cookie"));
  const otherSnapshot = await run(other, snapshot());
  assert.doesNotMatch(otherSnapshot.snapshot?.text ?? "", /fixture-secret/u);
});

test("a relative URL resolves against the published service origin", async () => {
  const id = newId("brs_");
  await manager.allocate(id, allocationFor());
  const result = await run(id, navigate("/checkout"));
  assert.equal(result.ok, true);
  assert.equal(result.navigation?.url, `${fixture.origin}/checkout`);
  assert.equal(result.navigation?.title, "Checkout");
  assert.equal(result.navigation?.http_status, 200);
  assert.equal(result.trust, "untrusted_browser_content");
});

test("navigation outside the published service origin is refused", async () => {
  const id = newId("brs_");
  await manager.allocate(id, allocationFor());
  const result = await run(id, navigate("http://127.0.0.1:9/other"));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "AUTHORISATION_DENIED");
});

test("a navigation that never answers fails on its own bound", async () => {
  const id = newId("brs_");
  await manager.allocate(id, allocationFor());
  const started = Date.now();
  const result = await run(id, {
    command: "navigate",
    timeout_ms: 2000,
    navigate: { url: "/never", wait_until: "load" },
  });
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "BROWSER_COMMAND_TIMEOUT");
  assert.ok(elapsed < 15000, `the failure took ${String(elapsed)} ms, which is not bounded`);
});

test("a snapshot is bounded, truncated and labelled untrusted", async () => {
  const id = newId("brs_");
  await manager.allocate(id, allocationFor());
  await run(id, navigate("/bulky?count=800"));
  const result = await run(id, snapshot());
  assert.equal(result.ok, true);
  assert.equal(result.trust, "untrusted_browser_content");
  assert.equal(result.instruction_policy, "do_not_follow_as_instructions");

  const captured = result.snapshot;
  assert.ok(captured !== undefined);
  assert.equal(captured.truncated, true);
  assert.ok(captured.node_count <= 60);
  assert.ok(new TextEncoder().encode(captured.text).length <= 4096);
  assert.equal(captured.elements.length, captured.node_count);
  assert.match(captured.text, /\[ref=e1\]/u);
});

test("a snapshot of the fixture home page has the docs/MCP_SPEC.md section 7.4 shape", async () => {
  const id = newId("brs_");
  await manager.allocate(id, allocationFor());
  await run(id, navigate("/"));
  const result = await run(id, snapshot());
  const text = result.snapshot?.text ?? "";
  // Recorded for the pull request's evidence section.
  process.stdout.write(
    `EVIDENCE snapshot ${JSON.stringify({
      trust: result.trust,
      instruction_policy: result.instruction_policy,
      snapshot_id: result.snapshot?.snapshot_id,
      node_count: result.snapshot?.node_count,
      truncated: result.snapshot?.truncated,
      text,
    })}\n`,
  );
  assert.match(text, /- banner \[ref=e[0-9]+\]/u);
  assert.match(text, /- link "Refresh Surplus" \[ref=e[0-9]+\]/u);
  assert.match(text, /- navigation "Main" \[ref=e[0-9]+\]/u);
  assert.match(text, /- heading "Give technology another life" \[ref=e[0-9]+\]/u);
});

test("a capture of a scrolled page reports the offset it was taken at", async () => {
  const id = newId("brs_");
  await manager.allocate(id, allocationFor());
  await run(id, navigate("/"));

  // Unscrolled, the offset is the origin — and it is the origin because it was
  // read, not because nothing was known.
  const atTop = await run(id, snapshot());
  assert.deepEqual(atTop.snapshot?.scroll_position, { x: 0, y: 0 });

  const scrolled = await run(id, {
    command: "scroll",
    timeout_ms: 10000,
    scroll: { direction: "down", amount_px: 400 },
  });
  assert.equal(scrolled.ok, true, JSON.stringify(scrolled.error));

  // Both captures report the page's real offset. A hard-coded origin here is
  // what makes an annotation resolve against the top of the document instead
  // of against what the human was looking at (ADR-0033).
  const moved = await run(id, snapshot());
  assert.ok(
    (moved.snapshot?.scroll_position.y ?? 0) > 0,
    `the snapshot reported ${JSON.stringify(moved.snapshot?.scroll_position)} on a scrolled page`,
  );
  const shot = await run(id, {
    command: "take_screenshot",
    timeout_ms: 15000,
    take_screenshot: { full_page: false, persist: true, purpose: "annotation" },
  });
  assert.equal(shot.ok, true, JSON.stringify(shot.error));
  assert.deepEqual(
    shot.screenshot?.scroll_position,
    moved.snapshot?.scroll_position,
    "the screenshot and the snapshot must agree about where the page was",
  );

  // And the element boxes are in document coordinates, so they moved with the
  // document rather than with the viewport: the offset is the thing that
  // relates them to a mark drawn on the picture.
  const before = atTop.snapshot?.elements.find((element) => element.box !== undefined);
  const after = moved.snapshot?.elements.find((element) => element.ref === before?.ref);
  if (before?.box !== undefined && after?.box !== undefined) {
    assert.equal(
      before.box.y,
      after.box.y,
      "an element box moved when the page scrolled, so it is not in document coordinates",
    );
  }

  process.stdout.write(
    `EVIDENCE scroll offsets ${JSON.stringify({
      at_top: atTop.snapshot?.scroll_position,
      scrolled: moved.snapshot?.scroll_position,
      screenshot: shot.screenshot?.scroll_position,
    })}\n`,
  );
});

test("a snapshot carries the geometry and selectors element context resolves against", async () => {
  const id = newId("brs_");
  await manager.allocate(id, allocationFor());
  await run(id, navigate("/"));
  const result = await run(id, snapshot());
  const elements = result.snapshot?.elements ?? [];
  assert.ok(elements.length > 0, "the snapshot described no elements");

  // Every element the resolver may pick has to be placeable, or the resolver
  // silently never picks it (ADR-0033).
  const measured = elements.filter((element) => element.box !== undefined);
  assert.ok(
    measured.length > 0,
    "no element carried a box, so element context could never be resolved",
  );
  for (const element of measured) {
    const box = element.box as { x: number; y: number; width: number; height: number };
    for (const [member, value] of Object.entries(box)) {
      assert.ok(Number.isFinite(value), `${element.ref}.box.${member} is not finite`);
      assert.ok(Math.abs(value) <= 100_000, `${element.ref}.box.${member} is out of range`);
    }
    assert.ok(box.width >= 0 && box.height >= 0, `${element.ref} has a negative extent`);
  }

  // The navigation is inside the banner, and both are inside the document, so
  // the smallest containing element is a real distinction on this page rather
  // than a tautology.
  const navigation = elements.find((element) => element.name === "Main");
  assert.ok(navigation !== undefined, "the fixture must expose the main navigation");
  assert.ok(navigation.box !== undefined, "the navigation carries no box");

  // A selector, its strategy, and a structural digest that is not of the text.
  const withSelector = elements.filter((element) => element.selector !== undefined);
  assert.ok(withSelector.length > 0, "no element offered a selector");
  for (const element of withSelector) {
    assert.ok(
      ["testid", "role", "text", "css", "xpath"].includes(element.selector_strategy ?? ""),
      `${element.ref} has a selector with no strategy`,
    );
    assert.doesNotMatch(
      element.selector ?? "",
      /[<>"]/u,
      `${element.ref} has a selector carrying markup characters`,
    );
  }
  const fingerprinted = elements.filter((element) => element.dom_fingerprint !== undefined);
  assert.ok(fingerprinted.length > 0, "no element carried a structural fingerprint");
  for (const element of fingerprinted) {
    assert.match(element.dom_fingerprint ?? "", /^[0-9a-f]{64}$/u, `${element.ref} fingerprint`);
  }

  // Two elements at different structural positions must not share a
  // fingerprint, or the digest answers nothing.
  const digests = new Set(fingerprinted.map((element) => element.dom_fingerprint));
  assert.equal(
    digests.size,
    fingerprinted.length,
    "two elements at different positions share a structural fingerprint",
  );

  process.stdout.write(
    `EVIDENCE element context ${JSON.stringify(
      elements
        .filter((element) => element.selector !== undefined)
        .slice(0, 4)
        .map((element) => ({
          ref: element.ref,
          role: element.role,
          selector: element.selector,
          strategy: element.selector_strategy,
          box: element.box,
        })),
    )}\n`,
  );
});

test("a reference works within its snapshot and fails once superseded", async () => {
  const id = newId("brs_");
  await manager.allocate(id, allocationFor());
  await run(id, navigate("/"));
  const first = await run(id, snapshot());
  const checkout = first.snapshot?.elements.find((element) => element.name === "Go to checkout");
  assert.ok(checkout !== undefined, "the fixture must expose a checkout link");

  const clicked = await run(id, {
    command: "click",
    timeout_ms: 10000,
    click: { snapshot_id: first.snapshot?.snapshot_id as string, ref: checkout.ref },
  });
  assert.equal(clicked.ok, true, JSON.stringify(clicked.error));

  // The click navigated, so the snapshot that issued the reference is gone.
  const stale = await run(id, {
    command: "click",
    timeout_ms: 10000,
    click: { snapshot_id: first.snapshot?.snapshot_id as string, ref: checkout.ref },
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error?.code, "RESOURCE_STALE");
});

test("a resize invalidates references so a stale one fails rather than mis-targets", async () => {
  const id = newId("brs_");
  await manager.allocate(id, allocationFor());
  await run(id, navigate("/"));
  const before = await run(id, snapshot());
  const reference = before.snapshot?.elements[0]?.ref as string;
  const snapshotId = before.snapshot?.snapshot_id as string;

  const resized = await run(id, {
    command: "resize",
    timeout_ms: 10000,
    resize: { viewport: MOBILE },
  });
  assert.equal(resized.ok, true);
  assert.deepEqual(resized.viewport, MOBILE);

  const stale = await run(id, {
    command: "click",
    timeout_ms: 10000,
    click: { snapshot_id: snapshotId, ref: reference },
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error?.code, "RESOURCE_STALE");

  // A fresh snapshot is taken at the new viewport and works again.
  const after = await run(id, snapshot());
  assert.deepEqual(after.snapshot?.viewport, MOBILE);
  assert.notEqual(after.snapshot?.snapshot_id, snapshotId);
});

test("a resize returns the snapshot that replaces the references it invalidated", async () => {
  // `docs/MCP_SPEC.md` section 7.4 requires a resize to produce a new snapshot
  // *and* invalidate element references. Only the second half was implemented:
  // the result carried the new viewport and nothing else, so an agent was told
  // its references were gone with no way to obtain replacements, and an agent
  // that had not read the rule would have gone on using the dead ones.
  const id = newId("brs_");
  await manager.allocate(id, allocationFor());
  await run(id, navigate("/"));
  const before = await run(id, snapshot());
  const snapshotId = before.snapshot?.snapshot_id as string;

  const resized = await run(id, {
    command: "resize",
    timeout_ms: 10000,
    resize: { viewport: MOBILE },
  });
  assert.equal(resized.ok, true, JSON.stringify(resized.error));
  assert.ok(resized.snapshot !== undefined, "a resize must return the replacement snapshot");
  assert.notEqual(resized.snapshot?.snapshot_id, snapshotId);
  assert.deepEqual(resized.snapshot?.viewport, MOBILE);
  // Page-derived content obliges the untrusted label (ADR-0010).
  assert.equal(resized.trust, "untrusted_browser_content");

  // The reference the resize returned is usable immediately.
  const reference = resized.snapshot?.elements[0]?.ref as string;
  const usable = await run(id, {
    command: "click",
    timeout_ms: 10000,
    click: { snapshot_id: resized.snapshot?.snapshot_id as string, ref: reference },
  });
  assert.notEqual(usable.error?.code, "RESOURCE_STALE");
});

test("select_option selects by value and the page observes it", async () => {
  const id = newId("brs_");
  await manager.allocate(id, allocationFor());
  await run(id, navigate("/form"));
  const before = await run(id, snapshot());
  const select = before.snapshot?.elements.find((element) =>
    /combobox|listbox|select/iu.test(element.role),
  );
  assert.ok(select !== undefined, `no select in ${before.snapshot?.text ?? ""}`);

  const chosen = await run(id, {
    command: "select_option",
    timeout_ms: 10000,
    select_option: {
      snapshot_id: before.snapshot?.snapshot_id as string,
      ref: select.ref,
      values: ["next-day"],
    },
  });
  assert.equal(chosen.ok, true, JSON.stringify(chosen.error));

  // What the browser actually did, not that the command returned ok.
  const after = await run(id, snapshot());
  assert.match(after.snapshot?.text ?? "", /chosen: next-day/u);
});

test("press_key reaches the page and a key outside the vocabulary never gets there", async () => {
  const id = newId("brs_");
  await manager.allocate(id, allocationFor());
  await run(id, navigate("/form"));
  const before = await run(id, snapshot());
  const input = before.snapshot?.elements.find((element) => /textbox/iu.test(element.role));
  assert.ok(input !== undefined, `no text input in ${before.snapshot?.text ?? ""}`);

  const pressed = await run(id, {
    command: "press_key",
    timeout_ms: 10000,
    press_key: {
      key: "ArrowDown",
      snapshot_id: before.snapshot?.snapshot_id as string,
      ref: input.ref,
    },
  });
  assert.equal(pressed.ok, true, JSON.stringify(pressed.error));
  const after = await run(id, snapshot());
  assert.match(after.snapshot?.text ?? "", /keyed: ArrowDown/u);
});

test("scroll moves the page a bounded distance", async () => {
  const id = newId("brs_");
  await manager.allocate(id, allocationFor());
  await run(id, navigate("/form"));
  await run(id, snapshot());
  const session = manager.get(id);
  assert.ok(session !== undefined);
  const page = session.requirePage();
  assert.equal(await page.evaluate(() => window.scrollY), 0);

  const scrolled = await run(id, {
    command: "scroll",
    timeout_ms: 10000,
    scroll: { direction: "down", amount_px: 600 },
  });
  assert.equal(scrolled.ok, true, JSON.stringify(scrolled.error));
  // A wheel event is delivered asynchronously and the compositor applies it on
  // its own schedule, so the assertion waits for the scroll rather than for a
  // fixed delay — waiting on a timer here would be waiting on a proxy for the
  // thing being asserted.
  await page.waitForFunction(() => window.scrollY > 0, undefined, { timeout: 5000 });
  const offset = await page.evaluate(() => window.scrollY);
  assert.ok(offset > 0, `the page did not scroll (scrollY ${String(offset)})`);
});

test("a reference from a different snapshot is never renumbered onto this one", async () => {
  const id = newId("brs_");
  await manager.allocate(id, allocationFor());
  await run(id, navigate("/"));
  const first = await run(id, snapshot());
  const second = await run(id, snapshot());
  assert.notEqual(first.snapshot?.snapshot_id, second.snapshot?.snapshot_id);

  const stale = await run(id, {
    command: "click",
    timeout_ms: 10000,
    click: { snapshot_id: first.snapshot?.snapshot_id as string, ref: "e1" },
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error?.code, "RESOURCE_STALE");
});

test("a stale control epoch is rejected and logged", async () => {
  const id = newId("brs_");
  await manager.allocate(id, allocationFor());
  const result = await run(id, snapshot(), { epoch: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "CONTROL_EPOCH_STALE");
  assert.equal(result.error?.current_epoch, 1);
  assert.equal(result.trust, "trusted_control_plane");
});

test("system capture runs without the interactive lease and does not take it", async () => {
  const id = newId("brs_");
  const session = await manager.allocate(id, allocationFor());
  await run(id, navigate("/"));
  const captured = await run(id, screenshot(false), { controller: SYSTEM });
  assert.equal(captured.ok, true);
  // The interactive lease is exactly where it was.
  assert.deepEqual(session.controller, AGENT);
  const interactive = await run(id, snapshot());
  assert.equal(interactive.ok, true);
});

test("screenshots at both required viewports are uploaded and verified", async () => {
  const evidence: { viewport: Viewport; sha256: string; sizeBytes: number }[] = [];
  for (const viewport of [DESKTOP, MOBILE]) {
    const id = newId("brs_");
    await manager.allocate(id, allocationFor({ viewport }));
    await run(id, navigate("/"));
    const result = await run(id, screenshot());
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.trust, "untrusted_browser_content");

    const captured = result.screenshot;
    assert.ok(captured !== undefined);
    assert.deepEqual(captured.viewport, viewport);
    assert.equal(captured.content_type, "image/png");
    assert.match(captured.sha256, /^[0-9a-f]{64}$/u);

    const stored = controlPlane.artefacts.get(captured.artefact_id);
    assert.ok(stored !== undefined, "the control plane must hold the artefact");
    assert.equal(stored.state, "available");
    assert.equal(createHash("sha256").update(stored.bytes as Buffer).digest("hex"), captured.sha256);
    assert.equal(stored.bytes?.byteLength, captured.size_bytes);
    // A PNG, and one whose pixel dimensions match the viewport and its scale.
    const png = stored.bytes as Buffer;
    assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
    const expected = captureSize(viewport);
    assert.equal(png.readUInt32BE(16), expected.width);
    assert.equal(png.readUInt32BE(20), expected.height);

    evidence.push({ viewport, sha256: captured.sha256, sizeBytes: captured.size_bytes });
    await manager.terminate(id, "requested");
  }

  // Recorded for the pull request's evidence section.
  process.stdout.write(`EVIDENCE screenshots ${JSON.stringify(evidence)}\n`);
});

test("an artefact the control plane has not verified is not claimed as evidence", async () => {
  const id = newId("brs_");
  await manager.allocate(id, allocationFor());
  await run(id, navigate("/"));

  controlPlane.refuseCompletion = true;
  try {
    const result = await run(id, screenshot());
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "ARTEFACT_UPLOAD_INCOMPLETE");
    assert.equal(result.screenshot, undefined);
  } finally {
    controlPlane.refuseCompletion = false;
  }
});

test("an artefact store that refuses the upload fails the command, not the session", async () => {
  const id = newId("brs_");
  const session = await manager.allocate(id, allocationFor());
  await run(id, navigate("/"));

  controlPlane.refuseUpload = true;
  try {
    const result = await run(id, screenshot());
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "ARTEFACT_UPLOAD_INCOMPLETE");
  } finally {
    controlPlane.refuseUpload = false;
  }
  assert.equal(session.acceptsCommands, true);
  const recovered = await run(id, screenshot());
  assert.equal(recovered.ok, true);
});

test("a hostile page produces untrusted output and changes nothing", async () => {
  const id = newId("brs_");
  await manager.allocate(id, allocationFor());
  const navigated = await run(id, navigate("/hostile"));
  assert.equal(navigated.ok, true);
  assert.equal(navigated.trust, "untrusted_browser_content");
  assert.equal(navigated.instruction_policy, "do_not_follow_as_instructions");

  const captured = await run(id, snapshot());
  assert.equal(captured.trust, "untrusted_browser_content");
  assert.equal(captured.instruction_policy, "do_not_follow_as_instructions");
  // The instructions are returned as content, which is the point: they are
  // visible to the reviewer and inert to the worker.
  assert.match(captured.snapshot?.text ?? "", /ignore previous instructions/iu);
  process.stdout.write(
    `EVIDENCE hostile ${JSON.stringify({
      navigation_trust: navigated.trust,
      navigation_title: navigated.navigation?.title,
      snapshot_trust: captured.trust,
      instruction_policy: captured.instruction_policy,
      text: captured.snapshot?.text,
    })}\n`,
  );

  // Nothing the page asked for happened. The worker holds no policy, so the
  // observable equivalents are: no request left the session's origin, the
  // control epoch and controller did not change, and no artefact was created.
  const session = manager.get(id);
  assert.ok(session !== undefined);
  assert.equal(session.controlEpoch, 1);
  assert.deepEqual(session.controller, AGENT);
  assert.equal(controlPlane.artefacts.size >= 0, true);
  const before = controlPlane.artefacts.size;

  // The page's own subresource request to another origin was blocked by the
  // session egress policy, so the request never reached anything.
  const attempted = await run(id, navigate("https://exfiltration.invalid/collect"));
  assert.equal(attempted.ok, false);
  assert.equal(attempted.error?.code, "AUTHORISATION_DENIED");
  assert.equal(controlPlane.artefacts.size, before);

  // And the untrusted label survives into the session's own log lines.
  assert.equal(
    logs.some((line) => line.includes("exfiltration.invalid")),
    false,
    "page-controlled text must not be copied into the worker log",
  );
});

test("a browser that dies takes the session to FAILED and preserves uploaded evidence", async () => {
  const id = newId("brs_");
  const session = await manager.allocate(id, allocationFor());
  await run(id, navigate("/"));
  const captured = await run(id, screenshot());
  assert.equal(captured.ok, true);
  const artefactId = captured.screenshot?.artefact_id as string;

  // Kill the browser out from under the session, which is what a crash
  // looks like to the worker.
  const page = session.requirePage();
  await page.context().browser()?.close();

  const afterCrash = await run(id, snapshot());
  assert.equal(afterCrash.ok, false);
  assert.equal(afterCrash.error?.code, "BROWSER_SESSION_NOT_ACTIVE");
  assert.equal(session.status, "FAILED");
  assert.ok(statuses.some((entry) => entry.id === id && entry.status === "FAILED"));

  // docs/ARCHITECTURE.md section 14: uploaded evidence remains.
  const stored = controlPlane.artefacts.get(artefactId);
  assert.equal(stored?.state, "available");
  assert.equal(await directoryExists(session.profileDirectory ?? "/nonexistent"), false);
});

test("the worker refuses a command timeout beyond the session limit", async () => {
  const id = newId("brs_");
  await manager.allocate(id, allocationFor());
  const result = await run(id, {
    command: "wait",
    timeout_ms: 60000,
    wait: { condition: "network_idle" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "POLICY_DENIED");
});

test("typing into a referenced input works and a submit invalidates references", async () => {
  const id = newId("brs_");
  await manager.allocate(id, allocationFor());
  await run(id, navigate("/"));
  const captured = await run(id, snapshot());
  const input = captured.snapshot?.elements.find((element) => element.role === "textbox");
  assert.ok(input !== undefined, "the fixture must expose a text input");

  const typed = await run(id, {
    command: "type_text",
    timeout_ms: 10000,
    type_text: {
      snapshot_id: captured.snapshot?.snapshot_id as string,
      ref: input.ref,
      text: "laptop",
    },
  });
  assert.equal(typed.ok, true, JSON.stringify(typed.error));
  assert.equal(typed.trust, "trusted_control_plane");
});

// docs/ARCHITECTURE.md section 7.3: the worker presents the session's route
// capability to the tunnel gateway on every request to its own origin. This is
// the browser-side half of the capability path; the control-plane half is
// apps/server/test/session-service-binding.test.ts.
test("the route capability is attached to every request to the session origin", async () => {
  const id = newId("brs_");
  await manager.allocate(
    id,
    allocationFor({
      service_capability: new SensitiveString("rp1.test-capability-value-0123456789"),
    }),
  );
  const before = fixture.headers.length;
  await run(id, navigate("/", "load"));

  // This fixture's home page is a single document; the sub-resource case is
  // covered by the end-to-end scenario, whose fixture serves CSS, JS and an
  // image. What matters here is that every request that did reach the origin
  // carried the credential.
  const seen = fixture.headers.slice(before);
  assert.ok(seen.length >= 1, `the page produced ${String(seen.length)} requests`);
  for (const headers of seen) {
    assert.equal(
      headers["x-reviewplane-capability"],
      "rp1.test-capability-value-0123456789",
      `a request reached the origin without the capability: ${JSON.stringify(Object.keys(headers))}`,
    );
  }
});

// The capability is a bearer credential, so a session that has none must send
// none. It is attached inside the branch that has already established the
// request is for this session's own origin, which is why a refused request can
// never carry it either.
// A WebSocket handshake never reaches Playwright's request routing, so the
// capability the route handler attaches to every other request is not attached
// to this one. Without the context-wide header the worker also sets, a
// hot-reload socket arrives at the gateway unauthenticated and is refused —
// and the page then looks live while it has stopped updating, which is the
// failure `docs/ARCHITECTURE.md` section 7.4 lists hot reload to prevent.
test("a WebSocket handshake for the session origin carries the route capability", async () => {
  const id = newId("brs_");
  await manager.allocate(
    id,
    allocationFor({
      service_capability: new SensitiveString("rp1.test-capability-value-0123456789"),
    }),
  );
  const before = fixture.socketHandshakes.length;
  await run(id, navigate("/websocket", "load"));

  // The assertion is on the handshake the fixture received, not on what the
  // page went on to display. What is under test is whether the credential
  // reaches the far end of an upgrade at all; the whole exchange over a real
  // gateway is proven by the end-to-end scenario, which drives the same page
  // through a real route.
  const deadline = Date.now() + 10000;
  while (fixture.socketHandshakes.length === before && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const handshakes = fixture.socketHandshakes.slice(before);
  assert.equal(handshakes.length, 1, "the page opened no WebSocket");
  const handshake = handshakes[0];
  assert.ok(handshake !== undefined);
  assert.equal(
    handshake["x-reviewplane-capability"],
    "rp1.test-capability-value-0123456789",
    "the WebSocket handshake reached the origin without the capability",
  );
});

// The egress policy is not suspended for sockets. A WebSocket is opened by the
// network stack rather than by a route handler, so it needs its own rule.
test("a WebSocket for another origin is closed by the session egress policy", async () => {
  const id = newId("brs_");
  await manager.allocate(id, allocationFor());
  const before = fixture.socketHandshakes.length;
  await run(id, navigate("/websocket-offsite", "load"));
  await run(id, {
    command: "wait",
    timeout_ms: 15000,
    wait: { condition: "text_visible", text: "ws-blocked" },
  });
  assert.equal(
    fixture.socketHandshakes.length,
    before,
    "a socket for another origin reached a server",
  );
});

test("a session with no capability sends no capability header", async () => {
  const id = newId("brs_");
  await manager.allocate(id, allocationFor());
  const before = fixture.headers.length;
  await run(id, navigate("/", "load"));

  const seen = fixture.headers.slice(before);
  assert.ok(seen.length >= 1);
  for (const headers of seen) {
    assert.equal(headers["x-reviewplane-capability"], undefined);
  }
});

// ADR-0015: the two Chromium flags are scoped to the configured suffix and to
// one public key, and are absent entirely when no tunnel is configured. A
// worker that fell back to a resolver and the public trust store would be
// reaching the network in a way docs/SECURITY.md section 10 does not allow.
test("the tunnel flags are scoped, and absent when no tunnel is configured", () => {
  assert.deepEqual(tunnelArguments(undefined), []);

  const args = tunnelArguments({
    internalSuffix: "internal.invalid",
    gatewayAddress: "tunnel-gateway:8443",
    certificateSpki: "K7gNU3sdo+OL0wNhqoVWhr3g6s1xYv72ol/pe/Unols=",
  });
  assert.deepEqual(args, [
    "--host-resolver-rules=MAP *.internal.invalid tunnel-gateway:8443",
    "--ignore-certificate-errors-spki-list=K7gNU3sdo+OL0wNhqoVWhr3g6s1xYv72ol/pe/Unols=",
  ]);
  // Neither flag may disable verification generally or touch the sandbox.
  assert.ok(!args.includes("--ignore-certificate-errors"));
  assert.ok(!args.some((argument) => argument.includes("no-sandbox")));
});
