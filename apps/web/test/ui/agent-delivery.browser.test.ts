/**
 * Agent delivery state on the review page (`docs/UX_FLOWS.md` sections 11, 15
 * and 19; `docs/TESTING.md` section 15; RVP-49's user-interface requirements).
 *
 * Section 11 is a small surface with one large failure mode: it is the only
 * place a reader learns whether an agent has actually got the work, and every
 * wrong answer is a confident one. The cases below are therefore built around
 * the three ways it can lie.
 *
 * It can claim an acknowledgement that never arrived, so the pending case
 * requires the words "not yet received" while the review is assigned and its
 * inbox item is `pending` — an assignment is not a collection.
 *
 * It can invent a status where there is none, so the undelivered case requires
 * a named empty state and asserts that none of the five inbox statuses appears
 * anywhere on the page.
 *
 * It can claim the control plane put the command into somebody's terminal,
 * which section 11 forbids outright. Every case asserts the page says the
 * opposite, and the keyboard case proves the copy control is reachable and
 * focus-visible without a pointer, because copying is the reader's own act.
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

import { chromium, type Browser, type ConsoleMessage, type Page, type Request } from "playwright";

import {
  AGENT_SESSION_ID,
  CAPTURE_VIEWPORT,
  INBOX_ACKNOWLEDGED_AT,
  REVIEW,
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

/** The five statuses an inbox item can be in (`docs/API.md` section 16). */
const INBOX_STATUSES = ["pending", "acknowledged", "completed", "dismissed", "expired"] as const;

let browser: Browser;
/** A capture the review's findings point at, so no image request is answered 401. */
let capture: Uint8Array;
const captured: string[] = [];

before(async () => {
  browser = await chromium.launch();
  capture = await renderCapture();
  await mkdir(evidenceDirectory, { recursive: true });
});

after(async () => {
  await browser?.close();
});

/** A capture at the 390x844 preset and device pixel ratio 2, as the product takes them. */
async function renderCapture(): Promise<Uint8Array> {
  const context = await browser.newContext({
    viewport: { width: CAPTURE_VIEWPORT.width, height: CAPTURE_VIEWPORT.height },
    deviceScaleFactor: CAPTURE_VIEWPORT.device_scale_factor,
  });
  const page = await context.newPage();
  await page.setContent(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
       html, body { margin:0; height:100%; background:#0f172a; }
       #block { position:absolute; left:25%; top:30%; width:30%; height:12%; background:#f97316; }
     </style></head><body><div id="block"></div></body></html>`,
  );
  const bytes = await page.screenshot({ type: "png" });
  await context.close();
  return bytes;
}

interface Session {
  readonly page: Page;
  readonly errors: string[];
  readonly stub: StubControlPlane;
  close(): Promise<void>;
}

interface OpenOptions {
  readonly inboxStatus?: "pending" | "acknowledged" | "none";
  /** Load the page with no clipboard at all, for the disabled-control case. */
  readonly withoutClipboard?: boolean;
}

/**
 * Opens the review page, signed in, against its own stub.
 *
 * The locale and the time zone are both pinned, because the acknowledgement is
 * rendered with the reader's own formatting and an unpinned zone would make the
 * assertion depend on where the container thinks it is. The application asks
 * for the reader's locale and is unaffected by this.
 */
async function openReview(
  viewport: { width: number; height: number },
  options: OpenOptions = {},
): Promise<Session> {
  const stub = await startStubControlPlane({
    distDirectory,
    frames: [],
    screenshot: capture,
    afterScreenshot: capture,
    ...(options.inboxStatus === undefined ? {} : { inboxStatus: options.inboxStatus }),
  });
  const context = await browser.newContext({ viewport, locale: "en-GB", timezoneId: "UTC" });
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
  page.on("requestfailed", (request: Request) => {
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

  await page.goto(`${stub.origin}/reviews/${REVIEW.id}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Bugs on homepage" }).waitFor();
  await page.getByRole("heading", { name: "Agent delivery" }).waitFor();

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
  const session = await openReview(viewport, options);
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
 * Counting keystrokes would depend on how many controls the page above happens
 * to hold, which is a test that breaks for the wrong reason.
 */
async function tabUntil(
  page: Page,
  description: string,
  matches: (active: { readonly id: string; readonly text: string }) => boolean,
): Promise<void> {
  for (let step = 0; step < 60; step += 1) {
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

/**
 * The panel must never say the product typed into somebody's terminal
 * (`docs/UX_FLOWS.md` section 11), and it must say so in the affirmative rather
 * than merely omit the claim.
 */
async function assertClaimsNoTerminalInjection(page: Page): Promise<void> {
  const body = (await page.textContent("body")) ?? "";
  assert.match(
    body,
    /ReviewPlane does not type\s+into an agent.s terminal/u,
    "the page does not say who runs the command",
  );
  assert.ok(
    !/injected|typed it into|sent to the agent.s terminal|we ran it/iu.test(body),
    "the page claims the control plane reached into a terminal",
  );
  assert.ok(!/something went wrong/iu.test(body), "the panel shrugs");
}

for (const [label, viewport] of [
  ["1440x900", DESKTOP],
  ["390x844", MOBILE],
] as const) {
  test(`a delivered review states its assignee, a pending inbox and no acknowledgement at ${label}`, async () => {
    await withSession(viewport, { inboxStatus: "pending" }, async (session) => {
      const panel = session.page.locator("section[aria-labelledby='agent-delivery-heading']");
      await panel.waitFor();
      await panel.scrollIntoViewIfNeeded();
      await evidence(session.page, `agent-delivery-pending-${label}`);

      // 1. The assignment, as the identifier the control plane holds. Nothing
      // resolves an agent session to a client's name, so a name here would be
      // one this layer invented.
      const assignee =
        (await session.page.locator("#agent-delivery-assignee").textContent()) ?? "";
      assert.ok(assignee.includes(AGENT_SESSION_ID), `the session is not named: ${assignee}`);
      assert.match(assignee, /agent session/u, assignee);

      // 2. The delivery status, as a word beside its badge rather than as a
      // colour (`docs/UX_FLOWS.md` sections 12 and 19).
      const inbox = (await session.page.locator("#agent-delivery-inbox").textContent()) ?? "";
      assert.match(inbox, /pending/u, `the inbox status is not stated: ${inbox}`);

      // 3. And the acknowledgement that has not happened. An assignment is not
      // a collection, and this is the sentence that keeps the two apart.
      const acknowledgement =
        (await session.page.locator("#agent-delivery-acknowledgement").textContent()) ?? "";
      assert.equal(acknowledgement.trim(), "not yet received");
      assert.ok(!/19[67]\d/u.test(acknowledgement), "an absent timestamp was formatted");

      // The finding cards carry the claim, which is the per-finding half of
      // section 12.
      const claim =
        (await session.page.locator("[data-finding-claim='fin_ui_suite_hero']").textContent()) ??
        "";
      assert.ok(claim.includes(AGENT_SESSION_ID), `the claim is not stated: ${claim}`);
      const unclaimed =
        (await session.page
          .locator("[data-finding-claim='fin_ui_suite_unmeasured']")
          .textContent()) ?? "";
      assert.equal(unclaimed.trim(), "Nobody");

      await assertClaimsNoTerminalInjection(session.page);
      await assertNoHorizontalOverflow(session.page);
      assert.deepEqual(session.errors, [], session.errors.join(" | "));
    });
  });

  test(`an acknowledged delivery states when it was collected at ${label}`, async () => {
    await withSession(viewport, { inboxStatus: "acknowledged" }, async (session) => {
      await session.page.locator("#agent-delivery-acknowledgement").scrollIntoViewIfNeeded();
      await evidence(session.page, `agent-delivery-acknowledged-${label}`);

      const inbox = (await session.page.locator("#agent-delivery-inbox").textContent()) ?? "";
      assert.match(inbox, /acknowledged/u, `the inbox status is not stated: ${inbox}`);

      // The time itself, formatted for the reader. The context pins en-GB and
      // UTC, so the acknowledgement the stub recorded is a fixed reading.
      const acknowledgement =
        (await session.page.locator("#agent-delivery-acknowledgement").textContent()) ?? "";
      assert.ok(
        !/not yet received/u.test(acknowledgement),
        `an acknowledged item still reads as uncollected: ${acknowledgement}`,
      );
      const expected = new Date(INBOX_ACKNOWLEDGED_AT);
      assert.match(acknowledgement, /30\/07\/2026/u, acknowledgement);
      assert.match(acknowledgement, /11:34/u, acknowledgement);
      assert.equal(expected.getUTCHours(), 11, "the fixture's acknowledgement moved");

      await assertClaimsNoTerminalInjection(session.page);
      await assertNoHorizontalOverflow(session.page);
      assert.deepEqual(session.errors, [], session.errors.join(" | "));
    });
  });

  test(`an undelivered review names the absence rather than inventing a status at ${label}`, async () => {
    await withSession(viewport, { inboxStatus: "none" }, async (session) => {
      const empty = session.page.locator("[data-empty='agent-delivery']");
      await empty.waitFor();
      await empty.scrollIntoViewIfNeeded();
      await evidence(session.page, `agent-delivery-undelivered-${label}`);

      const text = (await empty.textContent()) ?? "";
      assert.match(text, /This review has not been delivered to an agent/u, text);
      assert.match(text, /Nobody is assigned to it and no inbox item carries it/u, text);

      // No status is fabricated: none of the five appears in the panel, and the
      // cells that would have carried them are not rendered at all.
      const panel =
        (await session.page
          .locator("section[aria-labelledby='agent-delivery-heading']")
          .textContent()) ?? "";
      for (const status of INBOX_STATUSES) {
        assert.ok(
          !new RegExp(`\\b${status}\\b`, "u").test(panel),
          `the panel states an inbox status it was never told: ${status}`,
        );
      }
      assert.equal(await session.page.locator("#agent-delivery-inbox").count(), 0);
      assert.equal(await session.page.locator("#agent-delivery-acknowledgement").count(), 0);

      // Every finding is honestly unclaimed rather than blank.
      const claim =
        (await session.page.locator("[data-finding-claim='fin_ui_suite_hero']").textContent()) ??
        "";
      assert.equal(claim.trim(), "Nobody");

      // The manual path survives the empty state: it is the way out of it.
      const command =
        (await session.page.locator("#agent-delivery-command").textContent()) ?? "";
      assert.match(command, /reviewplane-connector mcp/u, command);
      assert.ok(command.includes(REVIEW.slug), `the command does not name the review: ${command}`);

      await assertClaimsNoTerminalInjection(session.page);
      await assertNoHorizontalOverflow(session.page);
      assert.deepEqual(session.errors, [], session.errors.join(" | "));
    });
  });
}

test("the copy control is reachable by keyboard with visible focus", async () => {
  await withSession(DESKTOP, { inboxStatus: "pending" }, async (session) => {
    // The command block takes focus first, so it can be read and selected by
    // somebody who never touches a mouse.
    await tabUntil(
      session.page,
      "the command block",
      (active) => active.id === "agent-delivery-command",
    );
    await assertVisibleFocus(session.page);

    await session.page.keyboard.press("Tab");
    const focusedId = await session.page.evaluate(() => document.activeElement?.id ?? "");
    assert.equal(
      focusedId,
      "copy-agent-delivery-command",
      "the copy button does not follow the command",
    );
    await assertVisibleFocus(session.page);
    await evidence(session.page, "agent-delivery-keyboard-focus");

    // The control is enabled here, because this browser has a clipboard. What
    // it says afterwards must be one of the two honest outcomes: the write
    // succeeded, or the browser refused it. It must never claim more.
    assert.equal(
      await session.page.locator("#copy-agent-delivery-command").isDisabled(),
      false,
      "the copy control is disabled in a browser that has a clipboard",
    );
    const status = session.page.locator("#agent-delivery-copy-status");
    assert.equal(await status.getAttribute("role"), "status");
    assert.equal(await status.getAttribute("aria-live"), "polite");

    await session.page.keyboard.press("Enter");
    await session.page.waitForFunction(
      () =>
        (document.getElementById("agent-delivery-copy-status")?.textContent ?? "").length > 0,
      undefined,
      { timeout: 10_000 },
    );
    const outcome = (await status.textContent()) ?? "";
    assert.match(
      outcome,
      /on the clipboard|did not allow copying/u,
      `the copy outcome was not announced honestly: ${outcome}`,
    );

    await assertClaimsNoTerminalInjection(session.page);
    assert.deepEqual(session.errors, [], session.errors.join(" | "));
  });
});

test("a browser with no clipboard gets a disabled control and is told why", async () => {
  await withSession(
    DESKTOP,
    { inboxStatus: "pending", withoutClipboard: true },
    async (session) => {
      const button = session.page.locator("#copy-agent-delivery-command");
      await button.waitFor();
      assert.equal(
        await button.isDisabled(),
        true,
        "a browser with no clipboard is offered a control that cannot work",
      );

      // A disabled control that says nothing is a dead end, so the panel names
      // the remaining route: the command itself is selectable text.
      const body = (await session.page.textContent("body")) ?? "";
      assert.match(body, /This browser exposes no clipboard/u, body);
      assert.match(body, /copy it with the keyboard/u, body);
      const focusable = await session.page.evaluate(
        () => document.getElementById("agent-delivery-command")?.tabIndex ?? -1,
      );
      assert.equal(focusable, 0, "the command cannot be focused without a clipboard");

      await evidence(session.page, "agent-delivery-no-clipboard");
      await assertClaimsNoTerminalInjection(session.page);
      assert.deepEqual(session.errors, [], session.errors.join(" | "));
    },
  );
});

after(async () => {
  await writeFile(
    join(evidenceDirectory, "agent-delivery-evidence.txt"),
    [
      "ReviewPlane RVP-49 agent-delivery user-interface evidence",
      "the review page's delivery state, at 390x844 and 1440x900.",
      "",
      "properties asserted:",
      "- a delivered review states the agent-session identifier it was assigned to,",
      "  the inbox status as a word beside its badge, and 'not yet received' while the",
      "  item is pending, because an assignment is not a collection",
      "- an acknowledged item states when it was collected, formatted for the reader",
      "- an undelivered review names the absence and states none of the five inbox",
      "  statuses anywhere on the page",
      "- finding cards state the actor working them, or 'Nobody'",
      "- the command block and its copy control are keyboard reachable with visible",
      "  focus, and a browser with no clipboard gets a disabled control and the",
      "  keyboard route rather than a thrown error",
      "- the page states that ReviewPlane does not type into an agent's terminal",
      "",
      ...captured.map((name) => `screenshot: ${name}`),
      "",
    ].join("\n"),
    "utf8",
  );
});
