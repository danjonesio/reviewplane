/**
 * Starting a central browser session, and pausing, resuming and ending one
 * (`docs/UX_FLOWS.md` sections 6, 7, 18, 19 and 20; `docs/API.md` section 11;
 * `docs/TESTING.md` section 15; RVP-30's user-interface requirements).
 *
 * The suite is built around three claims the surface makes that could each be
 * false while everything still looked right.
 *
 * The first is topological. A central browser is indistinguishable on screen
 * from a tab on the reader's own machine, so section 6 requires the interface to
 * say where Chromium runs and how it reaches the application. That is asserted
 * as words, because only words can be wrong.
 *
 * The second is capacity. `BROWSER_CAPACITY_EXHAUSTED` is the failure a busy
 * deployment meets and the one most easily read as a fault, so the case asserts
 * the copy — that there is no free slot, and the three things the reader can do
 * — rather than that some error appeared. A panel that rendered the code as
 * "something went wrong" would satisfy a weaker assertion and would send a
 * reader to look for a broken control plane.
 *
 * The third is control. Exactly one controller drives a browser at a time, and a
 * stale epoch means control moved rather than that this page failed. The case
 * drives that with the stub taking control elsewhere and then asserts two
 * things: that the refusal says control changed, and that the epoch and the
 * controller on screen afterwards are the ones that are now current — because a
 * page that explained the refusal and left the old numbers up would invite a
 * second request refused for the same reason.
 *
 * Everything runs at both required viewports, in a real Chromium, against the
 * stub control plane, and every case asserts an empty console, no page error and
 * no failed request apart from the single refusal each refusal case asked the
 * stub for. It runs inside the browser-worker image; see
 * `scripts/run-ui-tests.sh`.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { chromium, type Browser, type ConsoleMessage, type Page } from "playwright";

import {
  AGENT_SESSION_ID,
  REFUSAL_STATUS,
  SESSION,
  UI_SUITE_EMAIL,
  UI_SUITE_PASSWORD,
  startStubControlPlane,
  type StubControlPlane,
} from "./stub-control-plane.ts";

const here = dirname(fileURLToPath(import.meta.url));
const distDirectory = join(here, "..", "..", "dist");
const evidenceDirectory = join(here, "..", "..", "test-results");

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

let browser: Browser;
const captured: string[] = [];

before(async () => {
  browser = await chromium.launch();
  await mkdir(evidenceDirectory, { recursive: true });
});

after(async () => {
  await browser?.close();
});

interface Session {
  readonly page: Page;
  readonly errors: string[];
  readonly stub: StubControlPlane;
  close(): Promise<void>;
}

interface OpenOptions {
  /** Refuse every start with this stable code, as the deliberate case. */
  readonly startRefusal?: { readonly code: string; readonly message: string };
  /** Take browser control elsewhere before the first pause is answered. */
  readonly staleControlEpoch?: boolean;
  /** Start with one carried route, so a session has something to reach. */
  readonly routePublished?: boolean;
}

/** One refused response a case has asked the stub for, by status and by path. */
interface Allowance {
  readonly status: number;
  readonly suffix: string;
}

function allowances(options: OpenOptions): readonly Allowance[] {
  const allowed: Allowance[] = [];
  if (options.startRefusal !== undefined) {
    allowed.push({
      status: REFUSAL_STATUS[options.startRefusal.code] ?? 503,
      suffix: "/browser-sessions",
    });
  }
  if (options.staleControlEpoch === true) {
    allowed.push({ status: REFUSAL_STATUS["CONTROL_EPOCH_STALE"] ?? 409, suffix: "/pause" });
  }
  return allowed;
}

async function open(
  viewport: { width: number; height: number },
  options: OpenOptions = {},
): Promise<Session> {
  const stub = await startStubControlPlane({
    distDirectory,
    frames: [],
    connectorConnected: true,
    ...(options.startRefusal === undefined ? {} : { startRefusal: options.startRefusal }),
    ...(options.staleControlEpoch === undefined
      ? {}
      : { staleControlEpoch: options.staleControlEpoch }),
    ...(options.routePublished === undefined ? {} : { routePublished: options.routePublished }),
  });
  const context = await browser.newContext({ viewport, locale: "en-GB" });
  const page = await context.newPage();
  const errors: string[] = [];
  const expected = allowances(options);

  const isExpected = (status: number, url: string): boolean =>
    expected.some((entry) => entry.status === status && url.endsWith(entry.suffix));

  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    // The first load probes the session endpoint and is answered 401 until
    // sign-in. That is the correct answer, and the browser logs it regardless.
    if (/status of 401/u.test(message.text())) return;
    // A refused fetch is logged by the browser whether or not the page handled
    // it. The path is in the message on some builds and in the location on
    // others, so both are consulted rather than one being assumed.
    const where = `${message.text()} ${message.location().url}`;
    if (
      expected.some(
        (entry) =>
          new RegExp(`status of ${String(entry.status)}`, "u").test(message.text()) &&
          where.includes(entry.suffix),
      )
    ) {
      return;
    }
    errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error: Error) => {
    errors.push(`page error: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    if ((request.failure()?.errorText ?? "").includes("ERR_ABORTED")) return;
    errors.push(`request failed: ${request.url()}`);
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status < 400 || status === 401) return;
    if (isExpected(status, response.url())) return;
    errors.push(`response ${String(status)}: ${response.url()}`);
  });

  await page.goto(stub.origin, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email address").fill(UI_SUITE_EMAIL);
  await page.getByLabel("Password").fill(UI_SUITE_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: "Live sessions" }).waitFor();
  errors.length = 0;

  return {
    page,
    errors,
    stub,
    async close(): Promise<void> {
      await context.close();
      await stub.stop();
    },
  };
}

async function withSession(
  viewport: { width: number; height: number },
  options: OpenOptions,
  body: (session: Session) => Promise<void>,
): Promise<void> {
  const session = await open(viewport, options);
  try {
    await body(session);
  } finally {
    await session.close();
  }
}

async function evidence(page: Page, name: string): Promise<void> {
  const path = join(evidenceDirectory, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  captured.push(`${name}.png`);
  process.stdout.write(`EVIDENCE screenshot ${path}\n`);
}

/** The document must never scroll sideways (`docs/UX_FLOWS.md` section 20). */
async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  assert.ok(
    overflow.documentWidth <= overflow.viewportWidth + 1,
    `the page scrolls horizontally: ${String(overflow.documentWidth)} > ${String(overflow.viewportWidth)}`,
  );
}

/** The focused element must show a focus ring of its own. */
async function assertVisibleFocus(page: Page): Promise<void> {
  const focus = await page.evaluate(() => {
    const active = document.activeElement;
    if (active === null) return null;
    const style = getComputedStyle(active);
    return {
      description: `${active.tagName.toLowerCase()}#${active.id}`,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
  assert.ok(focus !== null, "nothing has focus");
  assert.notEqual(focus.outlineStyle, "none", `${focus.description} has no visible outline`);
  assert.notEqual(focus.outlineWidth, "0px", `${focus.description}'s outline has no width`);
}

const livePath = `/projects/${SESSION.project_id}/live`;
const roomPath = `/sessions/${SESSION.id}`;

async function openLive(session: Session): Promise<void> {
  await session.page.goto(`${session.stub.origin}${livePath}`, { waitUntil: "domcontentloaded" });
  await session.page.getByRole("heading", { name: "Start a browser session" }).waitFor();
}

async function openRoom(session: Session): Promise<void> {
  await session.page.goto(`${session.stub.origin}${roomPath}`, { waitUntil: "domcontentloaded" });
  await session.page.getByRole("heading", { name: "Live browser" }).waitFor();
}

for (const [label, viewport] of [
  ["1440x900", DESKTOP],
  ["390x844", MOBILE],
] as const) {
  test(`the start form offers both required viewports and states where Chromium runs at ${label}`, async () => {
    await withSession(viewport, { routePublished: true }, async (session) => {
      await openLive(session);

      // A landmark with a name, not a heading floating in the page
      // (`docs/UX_FLOWS.md` section 19).
      const region = session.page.getByRole("region", { name: "Start a browser session" });
      await region.waitFor();
      const activity = session.page.locator("#start-browser-session-activity");
      assert.equal(await activity.getAttribute("role"), "status");
      assert.equal(await activity.getAttribute("aria-live"), "polite");

      await evidence(session.page, `rvp30-start-session-${label}`);

      // Section 6 requires the interface to say where the browser runs and how
      // it reaches the application.
      const topology =
        (await session.page.locator("#start-browser-session-topology").textContent()) ?? "";
      assert.match(topology, /Chromium runs centrally/u, topology);
      assert.match(topology, /not in this browser and not on the development machine/u, topology);
      assert.match(topology, /private connector route/u, topology);
      assert.match(topology, /nothing there listens publicly/u, topology);

      // Both required presets are offered whatever the project configured.
      assert.equal(
        await session.page.locator("#start-viewport-1440x900").count(),
        1,
        "the 1440x900 preset is not offered",
      );
      assert.equal(
        await session.page.locator("#start-viewport-390x844").count(),
        1,
        "the 390x844 preset is not offered",
      );
      assert.equal(
        await session.page.locator("input[name='start-viewport']:checked").count(),
        1,
        "no viewport preset is chosen",
      );

      // The route is offered by what it reaches, and the explicit no-route
      // choice is a choice rather than a blank control.
      const services = (await session.page.locator("#start-service").textContent()) ?? "";
      assert.match(services, /internal\.invalid/u, `the carried route is not offered: ${services}`);
      assert.match(services, /No published service \(the session will reach nothing\)/u, services);

      // Step 3 of the flow is present, disabled and honest about why.
      assert.equal(await session.page.locator("#start-trace").isDisabled(), true);
      assert.equal(await session.page.locator("#start-video").isDisabled(), true);
      assert.equal(await session.page.locator("#start-trace").isChecked(), false);
      const capture = (await session.page.locator("#start-capture-hint").textContent()) ?? "";
      assert.match(capture, /not available in this stage/u, capture);
      assert.match(capture, /neither is requested when a session starts/u, capture);

      // The submit control is reachable by keyboard with a focus ring the page
      // provides itself (`docs/UX_FLOWS.md` section 19).
      await session.page.locator("#start-submit").focus();
      await assertVisibleFocus(session.page);

      const body = (await session.page.textContent("body")) ?? "";
      assert.ok(!/something went wrong/iu.test(body), "the page shrugs somewhere");

      await assertNoHorizontalOverflow(session.page);
      assert.deepEqual(session.errors, [], session.errors.join(" | "));
    });
  });

  test(`starting a session announces it and links to the session room at ${label}`, async () => {
    await withSession(viewport, { routePublished: true }, async (session) => {
      await openLive(session);
      await session.page.locator("#start-submit").click();

      const link = session.page.locator("[data-started-session]");
      await link.waitFor({ timeout: 20_000 });
      await link.scrollIntoViewIfNeeded();

      // The outcome is announced, so a reader who cannot see the list change is
      // still told what starting did.
      const announced =
        (await session.page.locator("#start-browser-session-activity").textContent()) ?? "";
      assert.match(announced, /Browser session brs_ui_started_1 is READY/u, announced);
      assert.match(announced, /at 1440x900/u, announced);
      assert.match(announced, /internal\.invalid/u, announced);
      assert.match(announced, /over the connector's private route/u, announced);

      // And step 5 of the flow is the link it leaves behind.
      const started = (await link.getAttribute("data-started-session")) ?? "";
      assert.equal(started, "brs_ui_started_1");
      await link.getByRole("link", { name: "Open the session room" }).click();
      await session.page.getByRole("heading", { name: "Live browser" }).waitFor();
      await session.page.getByRole("heading", { name: started }).waitFor();

      await assertNoHorizontalOverflow(session.page);
      assert.deepEqual(session.errors, [], session.errors.join(" | "));
    });
  });

  test(`BROWSER_CAPACITY_EXHAUSTED names the capacity state at ${label}`, async () => {
    await withSession(
      viewport,
      {
        startRefusal: {
          code: "BROWSER_CAPACITY_EXHAUSTED",
          message: "No browser worker has a free session slot.",
        },
      },
      async (session) => {
        await openLive(session);
        await session.page.locator("#start-submit").click();

        const refusal = session.page.locator(
          "[data-surface='start-browser-session'][data-refusal='BROWSER_CAPACITY_EXHAUSTED']",
        );
        await refusal.waitFor({ timeout: 20_000 });
        await refusal.scrollIntoViewIfNeeded();
        await evidence(session.page, `rvp30-start-session-capacity-${label}`);

        const text = (await refusal.textContent()) ?? "";
        // The state, in the reader's terms: the deployment is full, not broken.
        assert.match(text, /This deployment has no free browser slot/u, text);
        assert.match(text, /at its session limit, or no worker is reporting at all/u, text);
        assert.match(text, /no session was created/u, text);
        // And the three things the reader can actually do about it.
        assert.match(text, /Wait for a running session to end/u, text);
        assert.match(text, /end one from the list below/u, text);
        assert.match(text, /reviewplane status/u, text);
        assert.match(text, /BROWSER_CAPACITY_EXHAUSTED/u, "the stable code is not named");
        assert.equal(await refusal.getAttribute("role"), "alert");

        // Nothing was started, so nothing is offered to open.
        assert.equal(
          await session.page.locator("[data-started-session]").count(),
          0,
          "a refused start still offers a session room",
        );

        const body = (await session.page.textContent("body")) ?? "";
        assert.ok(!/something went wrong/iu.test(body), "the refusal shrugs");

        await assertNoHorizontalOverflow(session.page);
        assert.deepEqual(session.errors, [], session.errors.join(" | "));
      },
    );
  });

  test(`pause and resume round-trip in the session room at ${label}`, async () => {
    await withSession(viewport, { routePublished: true }, async (session) => {
      await openRoom(session);

      // The controller is stated beside the epoch: an epoch nobody holds is a
      // number without a subject.
      const controller = (await session.page.locator("#session-controller").textContent()) ?? "";
      assert.match(controller, /agent_session/u, controller);
      assert.ok(controller.includes(AGENT_SESSION_ID), `the controller is not named: ${controller}`);
      assert.equal(await session.page.locator("#session-control-epoch").textContent(), "1");

      await evidence(session.page, `rvp30-session-room-${label}`);

      // An ACTIVE session offers Pause and End, and does not offer Resume.
      await session.page.locator("#session-pause").waitFor();
      assert.equal(await session.page.locator("#session-resume").count(), 0);
      assert.equal(await session.page.locator("#session-end").count(), 1);
      await session.page.locator("#session-pause").focus();
      await assertVisibleFocus(session.page);

      await session.page.locator("#session-pause").click();
      await session.page.locator("#session-resume").waitFor({ timeout: 20_000 });
      assert.equal(
        await session.page.locator("#session-pause").count(),
        0,
        "a paused session still offers Pause",
      );
      const paused =
        (await session.page.locator("#session-control-activity").textContent()) ?? "";
      assert.match(paused, /The browser session was paused/u, paused);
      assert.match(paused, /now PAUSED/u, paused);
      assert.match(paused, /control epoch 1/u, paused);

      await session.page.locator("#session-resume").click();
      await session.page.locator("#session-pause").waitFor({ timeout: 20_000 });
      assert.equal(
        await session.page.locator("#session-resume").count(),
        0,
        "a resumed session still offers Resume",
      );
      const resumed =
        (await session.page.locator("#session-control-activity").textContent()) ?? "";
      assert.match(resumed, /The browser session was resumed/u, resumed);
      assert.match(resumed, /now ACTIVE/u, resumed);

      // Nothing was refused along the way.
      assert.equal(await session.page.locator("[data-surface='session-control']").count(), 0);

      await assertNoHorizontalOverflow(session.page);
      assert.deepEqual(session.errors, [], session.errors.join(" | "));
    });
  });

  test(`a stale control epoch is explained and the session is read again at ${label}`, async () => {
    await withSession(
      viewport,
      { routePublished: true, staleControlEpoch: true },
      async (session) => {
        await openRoom(session);
        assert.equal(await session.page.locator("#session-control-epoch").textContent(), "1");

        await session.page.locator("#session-pause").click();

        const refusal = session.page.locator(
          "[data-surface='session-control'][data-refusal='CONTROL_EPOCH_STALE']",
        );
        await refusal.waitFor({ timeout: 20_000 });
        await refusal.scrollIntoViewIfNeeded();
        await evidence(session.page, `rvp30-session-room-stale-epoch-${label}`);

        const text = (await refusal.textContent()) ?? "";
        assert.match(text, /Browser control changed/u, text);
        assert.match(text, /no longer current/u, text);
        assert.match(text, /refused before it reached the worker/u, text);
        assert.match(text, /CONTROL_EPOCH_STALE/u, "the stable code is not named");
        assert.equal(await refusal.getAttribute("role"), "alert");

        // The refusal is not the whole obligation: the page must read the
        // session again rather than leave the epoch it was refused for on
        // screen. Both the epoch and the controller are now the current ones.
        await session.page.waitForFunction(
          () => document.querySelector("#session-control-epoch")?.textContent === "2",
          undefined,
          { timeout: 20_000 },
        );
        const controller = (await session.page.locator("#session-controller").textContent()) ?? "";
        assert.match(controller, /human_user vwr_other/u, controller);

        const body = (await session.page.textContent("body")) ?? "";
        assert.ok(!/something went wrong/iu.test(body), "the refusal shrugs");

        await assertNoHorizontalOverflow(session.page);
        assert.deepEqual(session.errors, [], session.errors.join(" | "));
      },
    );
  });
}

after(async () => {
  await writeFile(
    join(evidenceDirectory, "browser-session-evidence.txt"),
    [
      "ReviewPlane RVP-30 user-interface evidence",
      "starting a central browser session, and pausing, resuming and ending one,",
      "at 390x844 and 1440x900.",
      "",
      "properties asserted:",
      "- the start form is a named landmark whose status text is a polite live region",
      "- the interface states that Chromium runs centrally on the deployment and",
      "  reaches the application over a private connector route",
      "- 1440x900 and 390x844 are both offered whatever the project configured, and",
      "  one preset is always chosen",
      "- the route choice offers the carried route and an explicit no-route option,",
      "  never a blank control",
      "- trace and video are present, disabled and stated to be unavailable at this",
      "  stage rather than omitted",
      "- a successful start is announced with the session, its viewport and what it",
      "  reaches, and leaves a link to the session room that opens it",
      "- BROWSER_CAPACITY_EXHAUSTED is named as a deployment with no free browser",
      "  slot, with the three actions a reader can take, and nothing is offered to",
      "  open",
      "- the session room states the current controller beside the control epoch",
      "- pause then resume round-trips and the two controls swap",
      "- CONTROL_EPOCH_STALE is explained as browser control having changed, and the",
      "  session is read again so the epoch and controller on screen are current",
      "- no console error, no page error and no failed request in any case, except",
      "  the single refusal each refusal case asked the stub for",
      "",
      ...captured.map((name) => `screenshot: ${name}`),
      "",
    ].join("\n"),
    "utf8",
  );
});
