/**
 * First run, sign-in, project creation and the project switcher
 * (`docs/TESTING.md` section 15; RVP-12's user-interface and accessibility
 * requirements).
 *
 * These are the screens every user of a fresh installation meets, in the order
 * they meet them, so they are the ones where an accessibility failure costs the
 * most: a keyboard user who cannot complete the first-run form cannot use the
 * product at all. Each case drives the real bundle in a real Chromium, at both
 * required viewports, and asserts properties rather than pixels — a label for
 * every control, a visible focus ring, an `alert` for a failure, no horizontal
 * overflow at 390px, and a console and network log with nothing in them.
 *
 * It runs inside the browser-worker image; see `scripts/run-ui-tests.sh`.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { chromium, type Browser, type ConsoleMessage, type Page } from "playwright";

import {
  UI_SUITE_EMAIL,
  UI_SUITE_INSTALL_TOKEN,
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
  readonly problems: string[];
  readonly stub: StubControlPlane;
  close(): Promise<void>;
}

/** Opens the application against its own stub, recording every complaint. */
async function open(
  viewport: { width: number; height: number },
  options: { bootstrapRequired?: boolean } = {},
): Promise<Session> {
  const stub = await startStubControlPlane({
    distDirectory,
    frames: [],
    ...(options.bootstrapRequired === undefined
      ? {}
      : { bootstrapRequired: options.bootstrapRequired }),
  });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    // A page that has not signed in probes `/api/v1/auth/sessions/current` and
    // is answered 401. That is the correct answer and the application handles
    // it, but a browser logs every 4xx as a console error regardless, so the
    // one expected refusal is not counted as a fault.
    if (/status of 401/u.test(message.text())) return;
    problems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error: Error) => {
    problems.push(`page error: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    // Signing out clears the query cache, which aborts the session refetch that
    // was already in flight. A cancelled request is the application deciding it
    // no longer wants an answer, not a network failure.
    if ((request.failure()?.errorText ?? "").includes("ERR_ABORTED")) return;
    problems.push(`request failed: ${request.url()}`);
  });
  page.on("response", (response) => {
    // A 401 before signing in is the expected answer; anything else at or above
    // 400 is a failed network request.
    if (response.status() >= 400 && response.status() !== 401) {
      problems.push(`response ${String(response.status())}: ${response.url()}`);
    }
  });

  await page.goto(stub.origin, { waitUntil: "domcontentloaded" });
  return {
    page,
    problems,
    stub,
    async close(): Promise<void> {
      await context.close();
      await stub.stop();
    },
  };
}

/**
 * Runs a body against a fresh session and always tears it down.
 *
 * A failed assertion that leaked a stub leaves the run hanging after it has
 * finished, which is the least useful way for a suite to report a problem.
 */
async function withSession(
  viewport: { width: number; height: number },
  options: { bootstrapRequired?: boolean },
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

/**
 * Tabs forward until the element with `id` has focus, or — for `null` — until
 * the focused element is a button.
 *
 * Counting keystrokes would make this depend on how many controls the header
 * happens to hold, which is a test that breaks for the wrong reason.
 */
async function tabUntil(page: Page, id: string | null): Promise<void> {
  for (let step = 0; step < 20; step += 1) {
    await page.keyboard.press("Tab");
    const reached = await page.evaluate((wanted) => {
      const active = document.activeElement as HTMLElement | null;
      if (active === null) return false;
      if (wanted === null) return active.tagName.toLowerCase() === "button";
      return active.id === wanted;
    }, id);
    if (reached) return;
  }
  assert.fail(`tabbing never reached ${id ?? "a button"}`);
}

/** The focused element must show a focus ring of its own. */
async function assertVisibleFocus(page: Page): Promise<void> {
  const focus = await page.evaluate(() => {
    const active = document.activeElement;
    if (active === null) return null;
    const style = getComputedStyle(active);
    return {
      tag: active.tagName.toLowerCase(),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow,
    };
  });
  assert.ok(focus !== null, "nothing has focus");
  const ringed =
    (focus.outlineStyle !== "none" && focus.outlineWidth !== "0px") ||
    (focus.boxShadow !== "none" && focus.boxShadow !== "");
  assert.ok(ringed, `the focused ${focus.tag} shows no focus ring`);
}

/** Signs in with the password form and waits for the shell. */
async function signIn(session: Session): Promise<void> {
  await session.page.getByLabel("Email address").fill(UI_SUITE_EMAIL);
  await session.page.getByLabel("Password").fill(UI_SUITE_PASSWORD);
  await session.page.getByRole("button", { name: "Sign in" }).click();
  await session.page.getByRole("heading", { name: "Live sessions" }).waitFor();
}

for (const [label, viewport] of [
  ["1440x900", DESKTOP],
  ["390x844", MOBILE],
] as const) {
  test(`first run claims the installation at ${label}`, async () => {
    await withSession(viewport, { bootstrapRequired: true }, async (session) => {
      await session.page.getByRole("heading", { name: "Set up this installation" }).waitFor();
      await evidence(session.page, `first-run-${label}`);
      await assertNoHorizontalOverflow(session.page);

      // Every control is reachable by its label alone, which is what a screen
      // reader and a keyboard user both depend on.
      await session.page.getByLabel("Installation token").fill(UI_SUITE_INSTALL_TOKEN);
      await session.page.getByLabel("Email address").fill(UI_SUITE_EMAIL);
      await session.page.getByLabel("Password").fill(UI_SUITE_PASSWORD);
      await session.page.getByRole("button", { name: "Create administrator" }).click();

      await session.page.getByRole("heading", { name: "Live sessions" }).waitFor();
      // The shell now names who is signed in.
      await session.page.getByText(UI_SUITE_EMAIL).first().waitFor();
      await evidence(session.page, `signed-in-${label}`);

      assert.deepEqual(session.problems, [], session.problems.join(" | "));
    });
  });

  test(`signing in and creating a project works at ${label}`, async () => {
    await withSession(viewport, {}, async (session) => {
      await session.page.getByRole("heading", { name: "Sign in" }).waitFor();
      await evidence(session.page, `sign-in-${label}`);
      await assertNoHorizontalOverflow(session.page);
      await signIn(session);

      await session.page.getByRole("link", { name: "Projects" }).click();
      await session.page.getByRole("heading", { name: "Projects" }).waitFor();
      await session.page.getByRole("link", { name: "New project" }).click();
      await session.page.getByRole("heading", { name: "New project" }).waitFor();
      await assertNoHorizontalOverflow(session.page);

      await session.page.getByLabel("Project name").fill("Internal Tools");
      await session.page
        .getByLabel("Repository (optional)")
        .fill("git@github.com:example/internal-tools.git");
      await evidence(session.page, `project-create-${label}`);

      await session.page.getByRole("button", { name: "Create project" }).click();
      await session.page.getByRole("heading", { name: "Internal Tools is ready" }).waitFor();
      // The next thing a human needs is the connector command, not a redirect.
      await session.page.getByText("reviewplane-connector enrol").waitFor();
      await evidence(session.page, `project-created-${label}`);
      await assertNoHorizontalOverflow(session.page);

      // The switcher now holds both projects and moves between them.
      const switcher = session.page.getByLabel("Project", { exact: true });
      await switcher.waitFor();
      const options = await switcher.locator("option").allTextContents();
      assert.ok(options.includes("Internal Tools"), options.join(", "));
      assert.ok(options.includes("Refresh Surplus"), options.join(", "));

      await switcher.selectOption({ label: "Refresh Surplus" });
      await session.page.getByRole("heading", { name: "Refresh Surplus" }).waitFor();
      await evidence(session.page, `project-switcher-${label}`);
      await assertNoHorizontalOverflow(session.page);

      // The documented within-project information architecture is present, and
      // the surfaces that do not exist yet are absent rather than broken. The
      // locator is scoped to the project navigation, because "Reviews" is also
      // a primary-navigation link and the two are different destinations.
      const projectNav = session.page.getByRole("navigation", { name: "Project" });
      for (const tab of ["Overview", "Live", "Reviews", "Environments", "Settings"]) {
        await projectNav.getByRole("link", { name: tab, exact: true }).waitFor();
      }
      assert.equal(await projectNav.getByRole("link", { name: "Policies" }).count(), 0);

      assert.deepEqual(session.problems, [], session.problems.join(" | "));
    });
  });
}

test("the project form can be completed with the keyboard alone, with visible focus", async () => {
  await withSession(DESKTOP, {}, async (session) => {
    // No pointer is used from here on. The traversal starts at the document,
    // which is where a keyboard user arriving at the page starts.
    await tabUntil(session.page, "email");
    await assertVisibleFocus(session.page);
    await session.page.keyboard.type(UI_SUITE_EMAIL);
    await tabUntil(session.page, "password");
    await session.page.keyboard.type(UI_SUITE_PASSWORD);
    await tabUntil(session.page, null);
    await assertVisibleFocus(session.page);
    await session.page.keyboard.press("Enter");
    await session.page.getByRole("heading", { name: "Live sessions" }).waitFor();

    await session.page.goto(`${session.stub.origin}/projects/new`, {
      waitUntil: "domcontentloaded",
    });
    await session.page.getByRole("heading", { name: "New project" }).waitFor();

    await tabUntil(session.page, "project-name");
    await assertVisibleFocus(session.page);
    await session.page.keyboard.type("Keyboard Only");
    await tabUntil(session.page, null);
    await assertVisibleFocus(session.page);
    await session.page.keyboard.press("Enter");
    await session.page.getByRole("heading", { name: "Keyboard Only is ready" }).waitFor();
    await evidence(session.page, "project-created-keyboard-only");

    assert.deepEqual(session.problems, [], session.problems.join(" | "));
  });
});

test("a wrong password is announced as an alert and never shown back", async () => {
  await withSession(DESKTOP, {}, async (session) => {
    await session.page.getByLabel("Email address").fill(UI_SUITE_EMAIL);
    await session.page.getByLabel("Password").fill("not the passphrase");
    await session.page.getByRole("button", { name: "Sign in" }).click();

    const alert = session.page.getByRole("alert");
    await alert.waitFor();
    const text = (await alert.textContent()) ?? "";
    assert.match(text, /do not match an account/u);
    assert.ok(!text.includes("not the passphrase"), "the refusal echoed the password back");
    await evidence(session.page, "sign-in-refused");

    // A refusal is not a dead end (`docs/UX_FLOWS.md` section 18): the form is
    // still usable and the next attempt works.
    await session.page.getByLabel("Password").fill(UI_SUITE_PASSWORD);
    await session.page.getByRole("button", { name: "Sign in" }).click();
    await session.page.getByRole("heading", { name: "Live sessions" }).waitFor();
  });
});

test("signing out revokes the session and returns to the sign-in screen", async () => {
  await withSession(DESKTOP, {}, async (session) => {
    await signIn(session);

    // The stub refuses a sign-out that arrives without the CSRF header, so a
    // 204 here is proof that the application really sends it.
    const [response] = await Promise.all([
      session.page.waitForResponse(
        (candidate) =>
          candidate.url().endsWith("/api/v1/auth/sessions/current") &&
          candidate.request().method() === "DELETE",
      ),
      session.page.getByRole("button", { name: "Sign out" }).click(),
    ]);
    assert.equal(response.status(), 204, "the sign-out was refused");

    await session.page.getByRole("heading", { name: "Sign in" }).waitFor();
    assert.deepEqual(session.problems, [], session.problems.join(" | "));
  });
});

after(async () => {
  await writeFile(
    join(evidenceDirectory, "identity-evidence.txt"),
    [
      "ReviewPlane RVP-12 user-interface evidence",
      "first-run login, sign-in, project creation and the project switcher,",
      "at 390x844 and 1440x900, plus keyboard-only completion.",
      "",
      ...captured.map((name) => `screenshot: ${name}`),
      "",
    ].join("\n"),
    "utf8",
  );
});
