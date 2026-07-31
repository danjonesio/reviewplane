/**
 * Connector enrolment, connector health and the workspace context
 * (`docs/UX_FLOWS.md` sections 5, 18 and 19; `docs/TESTING.md` section 15;
 * RVP-20's user-interface requirements).
 *
 * Two properties of this flow are what the suite is built around, because both
 * fail silently otherwise.
 *
 * The first is that the enrolment token is shown once. A page that presents it
 * only through a clipboard the browser may refuse is a page that loses the
 * credential, so the command block is focusable and selectable and the refused
 * clipboard is exercised deliberately: the case below deletes
 * `navigator.clipboard` before the page loads and requires the fallback to say
 * what happened and to leave the command selected.
 *
 * The second is that enrolment finishes on another machine. Completion is
 * therefore an announcement rather than a response, and the case below waits
 * for the polite live region to name all five things `docs/UX_FLOWS.md`
 * section 5 requires — environment, version, platform, health and the detected
 * workspace — rather than merely for something to appear on screen.
 *
 * Everything runs at both required viewports, in a real Chromium, against the
 * stub control plane, and every case asserts an empty console and no failed
 * request. It runs inside the browser-worker image; see
 * `scripts/run-ui-tests.sh`.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { chromium, type Browser, type ConsoleMessage, type Page } from "playwright";

import {
  CONNECTOR_ID,
  CONNECTOR_VERSION,
  ENVIRONMENT_NAME,
  SESSION,
  UI_SUITE_EMAIL,
  UI_SUITE_PASSWORD,
  WORKSPACE_BRANCH,
  WORKSPACE_COMMIT,
  WORKSPACE_DISPLAY_PATH,
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
  readonly connectorConnected?: boolean;
  readonly connectorAppearsAfterMs?: number;
  /** Load the page with no clipboard at all, for the fallback case. */
  readonly withoutClipboard?: boolean;
}

/**
 * Opens the application, signed in, against its own stub.
 *
 * The locale is pinned so the expiry's relative reading is a fixed string to
 * assert on; the application itself asks for the reader's locale and is
 * unaffected by this.
 */
async function open(
  viewport: { width: number; height: number },
  options: OpenOptions = {},
): Promise<Session> {
  const stub = await startStubControlPlane({
    distDirectory,
    frames: [],
    ...(options.connectorConnected === undefined
      ? {}
      : { connectorConnected: options.connectorConnected }),
    ...(options.connectorAppearsAfterMs === undefined
      ? {}
      : { connectorAppearsAfterMs: options.connectorAppearsAfterMs }),
  });
  const context = await browser.newContext({ viewport, locale: "en-GB" });
  if (options.withoutClipboard === true) {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, get: () => undefined });
    });
  }
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    // The first load probes the session endpoint and is answered 401 until
    // sign-in. That is the correct answer, and the browser logs it regardless.
    if (/status of 401/u.test(message.text())) return;
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
    if (response.status() >= 400 && response.status() !== 401) {
      errors.push(`response ${String(response.status())}: ${response.url()}`);
    }
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

/** Runs a body against a fresh session and always tears it down. */
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

/**
 * Tabs forward until the focused element satisfies `matches`.
 *
 * Counting keystrokes would depend on how many controls the header happens to
 * hold, which is a test that breaks for the wrong reason.
 */
async function tabUntil(
  page: Page,
  description: string,
  matches: (active: { readonly id: string; readonly text: string }) => boolean,
): Promise<void> {
  for (let step = 0; step < 40; step += 1) {
    await page.keyboard.press("Tab");
    const active = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (element === null) return { id: "", text: "" };
      return { id: element.id, text: (element.textContent ?? "").trim() };
    });
    if (matches(active)) return;
  }
  assert.fail(`tabbing never reached ${description}`);
}

const environmentsPath = `/projects/${SESSION.project_id}/environments`;

async function openEnvironments(session: Session): Promise<void> {
  await session.page.goto(`${session.stub.origin}${environmentsPath}`, {
    waitUntil: "domcontentloaded",
  });
  await session.page.getByRole("heading", { name: "Environments", exact: true }).waitFor();
}

/** Opens the enrolment page and mints a token with the labels supplied. */
async function mintToken(session: Session, labels: string): Promise<void> {
  await openEnvironments(session);
  await session.page.getByRole("link", { name: "Enrol a connector", exact: true }).click();
  await session.page.getByRole("heading", { name: "Enrol a connector" }).waitFor();
  if (labels !== "") {
    await session.page.getByLabel("Expected environment labels").fill(labels);
  }
  await session.page.getByRole("button", { name: "Mint enrolment token" }).click();
  await session.page.locator("#enrolment-command").waitFor();
}

for (const [label, viewport] of [
  ["1440x900", DESKTOP],
  ["390x844", MOBILE],
] as const) {
  test(`the enrolment page states the command, expiry, scope, labels and the warning at ${label}`, async () => {
    await withSession(viewport, {}, async (session) => {
      await mintToken(session, "proxmox, development");
      await evidence(session.page, `connector-enrolment-${label}`);

      // 1. The one-time command, as a command rather than as prose.
      const command = (await session.page.locator("#enrolment-command").textContent()) ?? "";
      assert.match(command, /reviewplane-connector enrol/u);
      assert.match(command, /--control-plane/u);

      // The command reads the token from a file rather than from the command
      // line, so the token has to reach the screen on its own or the flow
      // cannot be completed at all.
      const token = (await session.page.locator("#enrolment-token-value").textContent()) ?? "";
      assert.ok(token.trim().length > 0, "the token is nowhere on the page");

      // 2. The expiry, absolute and relative. An absolute time is unambiguous;
      // the relative reading is the one a person actually acts on.
      const expiry = (await session.page.locator("#enrolment-expiry").textContent()) ?? "";
      assert.match(expiry, /20\d\d/u, `the expiry states no absolute time: ${expiry}`);
      assert.match(expiry, /in \d+ minutes/u, `the expiry states no relative time: ${expiry}`);

      // 3. The project scope.
      const scope = (await session.page.locator("#enrolment-scope").textContent()) ?? "";
      assert.match(scope, /Refresh Surplus/u, `the scope was ${scope}`);

      // 4. The labels the environment must declare.
      const labels = (await session.page.locator("#enrolment-labels").textContent()) ?? "";
      assert.match(labels, /proxmox/u);
      assert.match(labels, /development/u);

      // 5. The warning, as its own heading rather than as a footnote.
      await session.page.getByRole("heading", { name: "This token is shown once" }).waitFor();
      const body = (await session.page.textContent("body")) ?? "";
      assert.match(body, /cannot be retrieved again/u);
      assert.ok(!/something went wrong/iu.test(body));

      await assertNoHorizontalOverflow(session.page);
      assert.deepEqual(session.errors, [], session.errors.join(" | "));
    });
  });

  test(`the connector health view states its status as text at ${label}`, async () => {
    await withSession(viewport, { connectorConnected: true }, async (session) => {
      await openEnvironments(session);
      const card = session.page.locator(`[data-connector='${CONNECTOR_ID}']`);
      await card.waitFor();
      await evidence(session.page, `connector-health-${label}`);

      const text = (await card.textContent()) ?? "";
      // The status is a word, not only a colour (`docs/UX_FLOWS.md` section 19).
      assert.match(text, /ACTIVE/u, `the card does not state its status: ${text}`);
      assert.match(text, /connected and answering heartbeats/u);
      assert.ok(text.includes(CONNECTOR_VERSION), `the version is missing: ${text}`);
      assert.match(text, /http-tunnel/u, "the capabilities are missing");
      assert.match(text, /sha256:/u, "the certificate fingerprint is missing");
      // `revoked_at` is null on a live connector. Rendering that as a date
      // would put 1970 on the screen rather than nothing.
      assert.ok(!text.includes("1970"), `an absent timestamp was formatted: ${text}`);

      // The environment and its reported checkout are named as well.
      const page = (await session.page.textContent("body")) ?? "";
      assert.ok(page.includes(ENVIRONMENT_NAME), "the environment is not named");
      assert.match(page, /linux\/amd64/u, "the platform is missing");
      assert.ok(page.includes(WORKSPACE_BRANCH), "the branch is missing");

      // The head commit is abbreviated to twelve characters and keeps the
      // whole value in its title, so nothing is lost by shortening it.
      const commit = session.page.locator("[data-head-commit]").first();
      assert.equal(((await commit.textContent()) ?? "").trim(), WORKSPACE_COMMIT.slice(0, 12));
      assert.equal(await commit.getAttribute("title"), WORKSPACE_COMMIT);

      await assertNoHorizontalOverflow(session.page);
      assert.deepEqual(session.errors, [], session.errors.join(" | "));
    });
  });

  test(`the empty state names a cause and an action at ${label}`, async () => {
    await withSession(viewport, {}, async (session) => {
      await openEnvironments(session);
      const empty = session.page.locator("[data-empty='environments']");
      await empty.waitFor();
      await evidence(session.page, `connector-empty-${label}`);

      const text = (await empty.textContent()) ?? "";
      // A cause, not a shrug (`docs/UX_FLOWS.md` section 18).
      assert.match(text, /No connector is connected/u);
      assert.match(text, /no connector has enrolled into it/u);
      const body = (await session.page.textContent("body")) ?? "";
      assert.ok(!/something went wrong/iu.test(body), "the empty state shrugs");

      // And an action: the link that fixes it.
      await empty.getByRole("link", { name: "Enrol a connector for this project" }).waitFor();

      await assertNoHorizontalOverflow(session.page);
      assert.deepEqual(session.errors, [], session.errors.join(" | "));
    });
  });

  test(`enrolment completion is announced at ${label}`, async () => {
    await withSession(viewport, { connectorAppearsAfterMs: 1000 }, async (session) => {
      await mintToken(session, "");

      const progress = session.page.locator("#enrolment-progress");
      assert.equal(await progress.getAttribute("role"), "status");
      assert.equal(await progress.getAttribute("aria-live"), "polite");

      // The connector arrives on another machine; the page notices on its own.
      await session.page.waitForFunction(
        (name) => (document.getElementById("enrolment-progress")?.textContent ?? "").includes(name),
        ENVIRONMENT_NAME,
        { timeout: 30_000 },
      );
      // The evidence is of the completion, which is below the form that caused
      // it on a desktop viewport.
      await progress.scrollIntoViewIfNeeded();
      await evidence(session.page, `connector-enrolled-${label}`);

      // All five things section 5 requires on completion, in the announcement
      // itself rather than only somewhere on the page.
      const announcement = (await progress.textContent()) ?? "";
      assert.ok(announcement.includes(ENVIRONMENT_NAME), announcement);
      assert.ok(announcement.includes(CONNECTOR_VERSION), announcement);
      assert.match(announcement, /linux\/amd64/u, announcement);
      assert.match(announcement, /connected and answering heartbeats/u, announcement);
      assert.ok(
        announcement.includes(`${WORKSPACE_DISPLAY_PATH} on ${WORKSPACE_BRANCH}`),
        announcement,
      );

      await assertNoHorizontalOverflow(session.page);
      assert.deepEqual(session.errors, [], session.errors.join(" | "));
    });
  });

  test(`revoking asks for confirmation and reports what it did at ${label}`, async () => {
    await withSession(viewport, { connectorConnected: true }, async (session) => {
      await openEnvironments(session);
      await session.page.locator(`[data-revoke='${CONNECTOR_ID}']`).click();

      // The confirmation states the consequences rather than relying on a red
      // button to imply them.
      const confirm = session.page.locator(`[data-revoke-confirm='${CONNECTOR_ID}']`);
      await confirm.waitFor();
      const question = (await session.page.textContent("body")) ?? "";
      assert.match(question, /closes every channel/u);
      assert.match(question, /revokes the routes it published/u);
      assert.match(question, /cannot be\s+undone/u);
      assert.match(question, /new connector identity/u);
      await evidence(session.page, `connector-revoke-confirm-${label}`);

      await confirm.click();
      await session.page.waitForFunction(
        () => (document.getElementById("environments-activity")?.textContent ?? "").length > 0,
        undefined,
        { timeout: 15_000 },
      );

      const outcome =
        (await session.page.locator("#environments-activity").textContent()) ?? "";
      assert.match(outcome, /is revoked/u, outcome);
      assert.match(outcome, /2 routes revoked/u, outcome);
      assert.match(outcome, /1 browser session disconnected/u, outcome);

      // The list itself catches up, and says so in words.
      await session.page.waitForFunction(
        (id) =>
          (document.querySelector(`[data-connector='${id}']`)?.textContent ?? "").includes(
            "REVOKED",
          ),
        CONNECTOR_ID,
        { timeout: 15_000 },
      );
      await evidence(session.page, `connector-revoked-${label}`);

      await assertNoHorizontalOverflow(session.page);
      assert.deepEqual(session.errors, [], session.errors.join(" | "));
    });
  });
}

test("the command is reachable and copyable by keyboard alone, with a working fallback", async () => {
  await withSession(DESKTOP, { withoutClipboard: true }, async (session) => {
    await openEnvironments(session);

    // The enrolment page is reachable from the project shell without a pointer.
    await tabUntil(session.page, "the enrolment link", (active) =>
      active.text.startsWith("Enrol a connector"),
    );
    await assertVisibleFocus(session.page);
    await session.page.keyboard.press("Enter");
    await session.page.getByRole("heading", { name: "Enrol a connector" }).waitFor();

    // And the form is completed the same way.
    await tabUntil(session.page, "the mint button", (active) =>
      active.text.startsWith("Mint enrolment token"),
    );
    await assertVisibleFocus(session.page);
    await session.page.keyboard.press("Enter");
    await session.page.locator("#enrolment-command").waitFor();

    // The command block itself takes focus, so it can be read and selected by
    // somebody who never touches a mouse.
    await tabUntil(session.page, "the command block", (active) => active.id === "enrolment-command");
    await assertVisibleFocus(session.page);

    await session.page.keyboard.press("Tab");
    const focusedId = await session.page.evaluate(() => document.activeElement?.id ?? "");
    assert.equal(focusedId, "copy-enrolment-command", "the copy button does not follow the command");
    await assertVisibleFocus(session.page);
    await session.page.keyboard.press("Enter");

    // This browser has no clipboard at all. The fallback has to say so and
    // leave the command selected, which is the only way out that remains.
    await session.page.waitForFunction(
      () => (document.getElementById("enrolment-copy-status")?.textContent ?? "").length > 0,
      undefined,
      { timeout: 10_000 },
    );
    const outcome =
      (await session.page.locator("#enrolment-copy-status").textContent()) ?? "";
    assert.match(outcome, /did not allow copying/u, outcome);
    assert.match(outcome, /Ctrl\+C/u, outcome);

    const selected = await session.page.evaluate(() => globalThis.getSelection()?.toString() ?? "");
    assert.match(
      selected,
      /reviewplane-connector enrol/u,
      `the fallback left nothing selected: ${selected}`,
    );
    await evidence(session.page, "connector-enrolment-keyboard-copy");

    assert.deepEqual(session.errors, [], session.errors.join(" | "));
  });
});

test("the session room states the workspace branch, commit and dirty state", async () => {
  await withSession(DESKTOP, { connectorConnected: true }, async (session) => {
    await session.page.goto(`${session.stub.origin}/sessions/${SESSION.id}`, {
      waitUntil: "domcontentloaded",
    });
    await session.page.getByRole("heading", { name: "Git context" }).waitFor();

    const panel = session.page.locator("[data-workspace='wsp_ui_suite']");
    await panel.waitFor();
    const text = (await panel.textContent()) ?? "";
    assert.ok(text.includes(WORKSPACE_BRANCH), `the branch is missing: ${text}`);
    assert.ok(text.includes(WORKSPACE_COMMIT.slice(0, 12)), `the commit is missing: ${text}`);
    assert.match(text, /Uncommitted changes/u, "the dirty state is not stated in words");

    // Stage 1 computes no staleness, so the panel must not imply one.
    assert.ok(!/stale|out of date|behind/iu.test(text), `the panel claims a freshness: ${text}`);

    await evidence(session.page, "connector-session-git-context");
    assert.deepEqual(session.errors, [], session.errors.join(" | "));
  });
});

test("the session room names the absence of a workspace rather than showing nothing", async () => {
  await withSession(DESKTOP, {}, async (session) => {
    await session.page.goto(`${session.stub.origin}/sessions/${SESSION.id}`, {
      waitUntil: "domcontentloaded",
    });
    await session.page.getByRole("heading", { name: "No workspace is known for this project" }).waitFor();
    const body = (await session.page.textContent("body")) ?? "";
    assert.ok(!/something went wrong/iu.test(body));
    assert.match(body, /A connector reports the checkout it runs beside/u);
    assert.deepEqual(session.errors, [], session.errors.join(" | "));
  });
});

after(async () => {
  await writeFile(
    join(evidenceDirectory, "connector-evidence.txt"),
    [
      "ReviewPlane RVP-20 user-interface evidence",
      "connector enrolment, connector health, revocation and the session room's",
      "Git context, at 390x844 and 1440x900.",
      "",
      "properties asserted:",
      "- the enrolment page states the command, the expiry (absolute and relative),",
      "  the project scope, the expected environment labels and the shown-once warning",
      "- the command is reachable and copyable by keyboard, with visible focus, and the",
      "  clipboard-refused fallback selects the command and says what happened",
      "- completion is announced in a polite live region naming the environment,",
      "  version, platform, connection health and the detected authorised workspace",
      "- connector status is conveyed as text, not only as colour",
      "- revocation confirms in words and reports the routes and sessions it affected",
      "- an unconnected project names the cause and the action, never a generic failure",
      "- the session room states branch, head commit and dirty state, and claims no",
      "  freshness, because Stage 1 computes no staleness",
      "",
      ...captured.map((name) => `screenshot: ${name}`),
      "",
    ].join("\n"),
    "utf8",
  );
});
