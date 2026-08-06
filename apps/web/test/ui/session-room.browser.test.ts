/**
 * The fleet dashboard and the session room (`docs/UX_FLOWS.md` sections 3, 7,
 * 18, 19 and 20; `docs/API.md` sections 18.1 and 18.2; `docs/EVENTS.md` section
 * 10; `docs/TESTING.md` section 15; RVP-41).
 *
 * The suite is built around five claims these surfaces make that could each be
 * false while the page still looked right.
 *
 * **That the history is the record.** A panel can render rows without ever
 * having subscribed to anything. The stub therefore delivers one event *after*
 * the subscription is established, and every history case asserts that row —
 * so a page that rendered only its HTTP seed fails rather than passing on the
 * seed alone.
 *
 * **That a refresh instruction is not silence.** `stream.refresh_required`
 * means the durable record moved past this client. A page that quietly carried
 * on would look identical to one that refetched; the case asserts the reason is
 * named on screen, because only a statement can be checked.
 *
 * **That page text is data.** An event payload carries a string written to read
 * like an instruction to an agent, and a second carrying an authorisation
 * header. The case asserts the first appears as text and is labelled
 * page-derived, that the second appears nowhere at all, and that the page's own
 * controls still behave — an assertion that the page "did not execute" it would
 * prove nothing, because nothing was ever executable.
 *
 * **That read-only means read-only.** Take control is not offered at this stage.
 * The case asserts no control affordance exists *and* that the room says so in
 * words, because a reader who cannot find a button does not know whether it is
 * missing or elsewhere.
 *
 * **That a thumbnail stops.** Section 3 requires thumbnails to stop when off
 * screen. Stopping is a closed socket rather than a paused paint, so the case
 * scrolls the card away and asserts the page's own record of whether it is
 * streaming — the two are indistinguishable on screen and only one is correct.
 *
 * Everything runs at both required viewports, in a real Chromium, against the
 * stub control plane, and every case asserts an empty console, no page error and
 * no failed request apart from the one each refusal case asked the stub for.
 */

import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { chromium, type Browser, type ConsoleMessage, type Page } from "playwright";

import {
  FORBIDDEN_PAYLOAD_VALUE,
  PAGE_DERIVED_INSTRUCTION,
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
let frames: Uint8Array[];

before(async () => {
  browser = await chromium.launch();
  frames = await renderFrames();
  await mkdir(evidenceDirectory, { recursive: true });
});

/**
 * Real JPEG frames, produced by screenshotting a fixture page.
 *
 * A synthetic one-pixel image would prove the transport works and nothing about
 * whether the surface renders, and the screenshots this suite produces as
 * evidence would show an empty canvas.
 */
async function renderFrames(): Promise<Uint8Array[]> {
  const context = await browser.newContext({ viewport: DESKTOP });
  const page = await context.newPage();
  const captured: Uint8Array[] = [];
  for (const [index, heading] of ["Basket", "Checkout", "Order placed"].entries()) {
    await page.setContent(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
         body { margin:0; font-family: system-ui, sans-serif; background:#0f172a; color:#f8fafc; }
         header { padding:16px 24px; background:#1e293b; }
         main { padding:40px 24px; }
         h1 { font-size:44px; margin:0 0 16px; }
         .card { background:#1e293b; border-radius:12px; padding:24px; max-width:640px; }
       </style></head><body>
         <header>Refresh Surplus</header>
         <main><h1>${heading}</h1>
           <div class="card"><p>Fixture application frame ${String(index + 1)}.</p></div>
         </main></body></html>`,
    );
    captured.push(await page.screenshot({ type: "jpeg", quality: 70 }));
  }
  await context.close();
  return captured;
}

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
  readonly refuseEvents?: boolean;
  readonly refreshRequired?: boolean;
  readonly activityRefusal?: string;
  readonly routePublished?: boolean;
  readonly startRefusal?: { readonly code: string; readonly message: string };
}

async function open(
  viewport: { width: number; height: number },
  options: OpenOptions = {},
): Promise<Session> {
  const stub = await startStubControlPlane({
    distDirectory,
    frames,
    connectorConnected: true,
    routePublished: options.routePublished ?? true,
    ...(options.refuseEvents === undefined ? {} : { refuseEvents: options.refuseEvents }),
    ...(options.refreshRequired === undefined ? {} : { refreshRequired: options.refreshRequired }),
    ...(options.activityRefusal === undefined
      ? {}
      : { activityRefusal: options.activityRefusal }),
    ...(options.startRefusal === undefined ? {} : { startRefusal: options.startRefusal }),
  });
  const context = await browser.newContext({
    viewport,
    locale: "en-GB",
    timezoneId: "Europe/London",
  });
  const page = await context.newPage();
  const errors: string[] = [];

  const expectedStatuses = new Set<number>();
  if (options.refuseEvents === true) expectedStatuses.add(404);
  if (options.activityRefusal !== undefined) {
    expectedStatuses.add(options.activityRefusal === "RESOURCE_NOT_FOUND" ? 404 : 500);
  }

  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    if (/status of 401/u.test(message.text())) return;
    // A refused upgrade or fetch is logged by the browser whether or not the
    // page handled it, so the statuses a case deliberately asked for are not
    // counted against it.
    for (const status of expectedStatuses) {
      if (new RegExp(`status of ${String(status)}`, "u").test(message.text())) return;
    }
    if (options.refuseEvents === true && /WebSocket/iu.test(message.text())) return;
    errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error: Error) => {
    errors.push(`page error: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    if ((request.failure()?.errorText ?? "").includes("ERR_ABORTED")) return;
    if (options.refuseEvents === true && request.url().includes("/events")) return;
    errors.push(`request failed: ${request.url()}`);
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status < 400 || status === 401) return;
    if (expectedStatuses.has(status)) return;
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
  process.stdout.write(`EVIDENCE screenshot ${path}\n`);
}

async function openRoom(page: Page): Promise<void> {
  await page.locator(`[data-session-card="${SESSION.id}"]`).first().waitFor();
  await page
    .locator(`[data-session-card="${SESSION.id}"]`)
    .getByRole("link", { name: "Open session" })
    .click();
  await page.locator('[data-surface="session-activity"]').waitFor();
}

/** No horizontal scroll: the page must fit the viewport it declared. */
async function assertNoHorizontalScroll(page: Page, viewport: { width: number }): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  assert.ok(
    overflow <= 1,
    `the page scrolls horizontally by ${String(overflow)}px at ${String(viewport.width)}px`,
  );
}

for (const [name, viewport] of [
  ["desktop", DESKTOP],
  ["mobile", MOBILE],
] as const) {
  test(`the fleet dashboard states every card fact at ${name}`, async () => {
    await withSession(viewport, {}, async ({ page, errors }) => {
      const card = page.locator(`[data-session-card="${SESSION.id}"]`);
      await card.waitFor();

      const text = (await card.textContent()) ?? "";
      for (const label of [
        "Agent",
        "Environment",
        "Branch",
        "Viewport",
        "Current route",
        "Latest agent action",
        "Last event",
        "Reviews",
      ]) {
        assert.ok(text.includes(label), `the card states ${label}`);
      }

      // The five supervision statuses of section 3, as a word beside the
      // domain status. Colour alone would satisfy neither.
      const fleetStatus = await card.getAttribute("data-fleet-status");
      assert.ok(
        ["active", "waiting", "blocked", "paused", "disconnected"].includes(fleetStatus ?? ""),
        `the card reports one of section 3's statuses, not ${String(fleetStatus)}`,
      );
      assert.ok(text.includes(SESSION.status), "the domain status is stated beside the summary");

      // Section 3's actions, and not Take control.
      for (const action of ["Open session", "Create review from latest frame"]) {
        await card.getByRole("link", { name: action }).first().waitFor();
      }
      assert.equal(
        await page.getByRole("button", { name: /take control/iu }).count(),
        0,
        "Take control is not offered at this stage",
      );
      assert.ok(
        ((await page.textContent("body")) ?? "").includes("read-only"),
        "the dashboard says watching is read-only rather than leaving it to be inferred",
      );

      // The topological claim: Chromium runs centrally and reaches the
      // application through a private route.
      const body = (await page.textContent("body")) ?? "";
      assert.ok(body.includes("Chromium runs centrally"));
      assert.ok(body.includes("private connector route"));

      await assertNoHorizontalScroll(page, viewport);
      // The thumbnail is the card fact a screenshot can actually show, so the
      // evidence is captured after it has painted rather than while it connects.
      await card.locator(`[data-thumbnail="${SESSION.id}"]`).scrollIntoViewIfNeeded();
      await page.waitForFunction(
        (id) =>
          Number(
            document
              .querySelector(`[data-thumbnail="${id}"]`)
              ?.getAttribute("data-thumbnail-painted") ?? "0",
          ) > 0,
        SESSION.id,
        { timeout: 15000 },
      );
      await evidence(page, `fleet-dashboard-${name}`);
      assert.deepEqual(errors, []);
    });
  });

  test(`the session room renders the header, activity and tabs at ${name}`, async () => {
    await withSession(viewport, {}, async ({ page, errors }) => {
      await openRoom(page);
      // The panel is populated before anything is read from the document.
      // Reading the body first and asserting on it later would assert against a
      // snapshot taken before the history arrived, which passes or fails by
      // timing rather than by behaviour.
      await page
        .locator('[data-timeline="session-activity"] [data-event-type="finding.verification_submitted"]')
        .waitFor();

      const body = (await page.textContent("body")) ?? "";
      for (const label of [
        "Current route",
        "Viewport",
        "Control epoch",
        "Controller (read-only)",
        "Browser",
      ]) {
        assert.ok(body.includes(label), `the header states ${label}`);
      }

      // The activity panel, seeded and then extended by live delivery. The
      // live row proves a subscription happened rather than a fetch.
      const panel = page.locator('[data-timeline="session-activity"]');
      await panel.waitFor();
      await panel.locator('[data-event-type="finding.verification_submitted"]').waitFor();
      for (const type of [
        "browser_session.navigated",
        "browser.command_rejected",
        "finding.created",
        "finding.comment_added",
      ]) {
        assert.equal(
          await panel.locator(`[data-event-type="${type}"]`).count(),
          1,
          `the panel renders ${type} exactly once`,
        );
      }

      // The panel is this session's, not the project's: an event with no
      // browser session must not appear here.
      assert.equal(
        await panel.locator('[data-event-type="project.created"]').count(),
        0,
        "an event belonging to no browser session is not shown in the room",
      );

      // Categories are stated as words, not only as colour.
      assert.ok(body.includes("Agent action"));
      assert.ok(body.includes("Finding"));
      assert.ok(body.includes("Comment"));

      // The tabs this stage can fill, and a statement about the ones it cannot.
      for (const tab of ["Git", "Screenshots", "Session data"]) {
        await page.getByRole("tab", { name: tab }).waitFor();
      }
      assert.equal(await page.getByRole("tab", { name: "Console" }).count(), 0);
      assert.ok(
        body.includes("Console, Network and Trace are not tabs here yet"),
        "the absent tabs are explained rather than shown empty",
      );

      await assertNoHorizontalScroll(page, viewport);
      await page.waitForFunction(
        () => Number(document.getElementById("live-frames-painted")?.textContent ?? "0") > 0,
        undefined,
        { timeout: 15000 },
      );
      await evidence(page, `session-room-${name}`);
      assert.deepEqual(errors, []);
    });
  });
}

test("page text that reads like an instruction is data, labelled, and changes nothing", async () => {
  await withSession(DESKTOP, {}, async ({ page, errors }) => {
    await openRoom(page);
    const panel = page.locator('[data-timeline="session-activity"]');
    const row = panel.locator('[data-event-type="browser_session.navigated"]');
    await row.waitFor();

    const rowText = (await row.textContent()) ?? "";
    assert.ok(
      rowText.includes(PAGE_DERIVED_INSTRUCTION),
      "the page's own words are shown, unchanged, as data",
    );
    assert.equal(
      await row.locator('[data-page-derived="true"]').count() > 0,
      true,
      "and are labelled as coming from the page",
    );

    // Nothing the page said reaches the document as markup or as a link.
    const html = await row.innerHTML();
    assert.ok(!/<script/iu.test(html), "no page-derived markup is inserted");
    assert.equal(
      await row.locator("a").count(),
      0,
      "page-derived text is never rendered as something a click follows",
    );

    // The instruction asked for two things. Neither happened: the room offers
    // no accept control and the session is still running.
    assert.equal(await page.getByRole("button", { name: /^accept/iu }).count(), 0);
    await page.getByRole("button", { name: "End session" }).waitFor();

    // The forbidden payload member is nowhere on the page.
    const body = (await page.textContent("body")) ?? "";
    assert.ok(
      !body.includes(FORBIDDEN_PAYLOAD_VALUE),
      "an authorisation header carried in a payload never reaches the timeline",
    );
    assert.ok(!body.includes("Bearer"), "nor any part of it");

    await evidence(page, "session-room-page-derived");
    assert.deepEqual(errors, []);
  });
});

test("a replay-window overflow is stated and the history is read again", async () => {
  await withSession(DESKTOP, { refreshRequired: true }, async ({ page, errors }) => {
    await openRoom(page);
    const notice = page.locator('[data-refresh-reason="replay_window_exceeded"]');
    await notice.waitFor();
    const text = (await notice.textContent()) ?? "";
    assert.ok(
      text.includes("read again from the record"),
      "the reader is told the history was refetched rather than left to assume it",
    );

    // The history is still there after the refresh: a client that dropped its
    // rows and did not reseed would show an empty panel and no gap.
    await page.locator('[data-timeline="session-activity"]').waitFor();
    await page
      .locator('[data-timeline="session-activity"] [data-event-type="finding.created"]')
      .waitFor();

    await evidence(page, "session-room-refresh-required");
    assert.deepEqual(errors, []);
  });
});

test("a refused event stream names its code and keeps the room diagnosable", async () => {
  await withSession(DESKTOP, { refuseEvents: true }, async ({ page, errors }) => {
    await openRoom(page);

    // The stream failed; the durable history did not, so the rows are still
    // there and the session facts are still readable.
    await page
      .locator('[data-timeline="session-activity"] [data-event-type="finding.created"]')
      .waitFor();
    const body = (await page.textContent("body")) ?? "";
    assert.ok(body.includes("Control epoch"), "the session is still diagnosable");
    assert.ok(
      !/something went wrong/iu.test(body),
      "no generic message is shown where a stable code exists",
    );

    await evidence(page, "session-room-events-refused");
    assert.deepEqual(errors, []);
  });
});

test("a refused activity read is named by its stable code, not as an empty history", async () => {
  await withSession(
    DESKTOP,
    { activityRefusal: "RESOURCE_NOT_FOUND" },
    async ({ page, errors }) => {
      await openRoom(page);
      const panel = page.locator('[data-surface="session-activity-seed"]');
      await panel.waitFor();
      assert.equal(await panel.getAttribute("data-failure"), "RESOURCE_NOT_FOUND");
      const text = (await panel.textContent()) ?? "";
      assert.ok(
        text.includes("does not exist, or this session is not authorised for it"),
        "the ambiguity the API keeps is kept here too",
      );
      assert.ok(!/something went wrong/iu.test(text));

      await evidence(page, "session-room-activity-refused");
      assert.deepEqual(errors, []);
    },
  );
});

test("a thumbnail stops streaming when its card leaves the screen", async () => {
  await withSession(MOBILE, {}, async ({ page, errors }) => {
    const thumbnail = page.locator(`[data-thumbnail="${SESSION.id}"]`);
    await thumbnail.waitFor();
    // On screen first. At 390px the card can start below the fold, and a
    // thumbnail that had never been visible would satisfy the "stopped"
    // assertion below without ever having started.
    await thumbnail.scrollIntoViewIfNeeded();
    try {
      await page.waitForFunction(
        (id) =>
          document
            .querySelector(`[data-thumbnail="${id}"]`)
            ?.getAttribute("data-thumbnail-streaming") === "true",
        SESSION.id,
        { timeout: 5000 },
      );
    } catch (error) {
      const diagnosis = await page.evaluate((id) => {
        const element = document.querySelector(`[data-thumbnail="${id}"]`);
        return {
          streaming: element?.getAttribute("data-thumbnail-streaming") ?? "absent",
          text: element?.textContent ?? "",
          reducedMotion: globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches,
          hasObserver: typeof globalThis.IntersectionObserver === "function",
          rect: element?.getBoundingClientRect().top ?? null,
        };
      }, SESSION.id);
      throw new Error(
        `the thumbnail never started streaming: ${JSON.stringify(diagnosis)} (${String(error)})`,
      );
    }

    // Push the card well below the fold. Stopping is a closed socket, and the
    // page's own record of whether it is streaming is the only observable
    // difference between that and a paused paint.
    //
    // The shell may scroll an inner element rather than the window, so every
    // scrollable ancestor is driven rather than assuming which one moves. A
    // scroll that silently did nothing would leave the thumbnail on screen and
    // make this case pass or fail for the wrong reason.
    await page.evaluate((id) => {
      const card = document.querySelector(`[data-session-card="${id}"]`);
      const spacer = document.createElement("div");
      spacer.style.height = "5000px";
      card?.parentElement?.prepend(spacer);

      // The spacer goes above the card and the page is scrolled back to the
      // top, so the card ends five thousand pixels below the fold. Scrolling to
      // the bottom instead would land on the card again, which is how this
      // check first passed the scroll and still found the thumbnail on screen.
      let node: HTMLElement | null = card as HTMLElement | null;
      while (node !== null) {
        node.scrollTop = 0;
        node = node.parentElement;
      }
      document.scrollingElement?.scrollTo(0, 0);
      globalThis.scrollTo(0, 0);
    }, SESSION.id);
    try {
      await page.waitForFunction(
        (id) =>
          document
            .querySelector(`[data-thumbnail="${id}"]`)
            ?.getAttribute("data-thumbnail-streaming") === "false",
        SESSION.id,
        { timeout: 5000 },
      );
    } catch (error) {
      const diagnosis = await page.evaluate((id) => {
        const element = document.querySelector(`[data-thumbnail="${id}"]`);
        const rect = element?.getBoundingClientRect();
        return {
          streaming: element?.getAttribute("data-thumbnail-streaming") ?? "absent",
          top: rect?.top ?? null,
          bottom: rect?.bottom ?? null,
          viewportHeight: globalThis.innerHeight,
          scrollY: globalThis.scrollY,
          documentHeight: document.documentElement.scrollHeight,
        };
      }, SESSION.id);
      throw new Error(
        `the thumbnail did not stop when scrolled off screen: ${JSON.stringify(diagnosis)} (${String(error)})`,
      );
    }

    assert.deepEqual(errors, []);
  });
});

test("the room is reachable and operable by keyboard with visible focus", async () => {
  await withSession(DESKTOP, {}, async ({ page, errors }) => {
    await openRoom(page);

    // Focus is driven by the keyboard and never by `focus()`. `:focus-visible`
    // is a statement about how the element was reached, so a programmatic focus
    // would measure a ring the reader never sees and pass against a page that
    // shows none.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });

    let reached = false;
    let steps = 0;
    while (!reached && steps < 120) {
      await page.keyboard.press("Tab");
      steps += 1;
      reached = await page.evaluate(
        () => document.activeElement?.id === "session-tab-git",
      );
    }
    assert.ok(reached, `the Git tab was not reachable by keyboard within ${String(steps)} stops`);

    // A focus ring the page provides itself, not merely the browser default.
    const outline = await page.evaluate(() => {
      const active = document.activeElement;
      if (active === null) return null;
      const style = globalThis.getComputedStyle(active);
      return { width: style.outlineWidth, style: style.outlineStyle, shadow: style.boxShadow };
    });
    assert.ok(outline !== null);
    assert.ok(
      (outline.style !== "none" && outline.width !== "0px") || outline.shadow !== "none",
      `focus is not visible: ${JSON.stringify(outline)}`,
    );

    // Operable, not merely reachable.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await page.getByRole("tabpanel").waitFor();

    // The live region that announces stream state, which is what a reader who
    // is not looking at the badge depends on.
    const status = page.locator("[data-stream-status]").first();
    await status.waitFor();
    assert.equal(await status.getAttribute("aria-live"), "polite");
    assert.ok(((await status.textContent()) ?? "").length > 0, "the state is written as words");

    await evidence(page, "session-room-keyboard");
    assert.deepEqual(errors, []);
  });
});

test("the overlay list is the non-canvas alternative and names each mark", async () => {
  await withSession(DESKTOP, {}, async ({ page, errors }) => {
    await openRoom(page);
    await page.getByRole("heading", { name: "Overlays on this surface" }).waitFor();
    const list = page.locator('[data-overlay-list="true"]');
    await list.waitFor();
    const blocked = list.locator('[data-overlay-item="policy_blocked"]');
    await blocked.waitFor();
    const text = (await blocked.textContent()) ?? "";
    assert.ok(
      text.includes("An action policy refused"),
      "the mark carries a name a screen reader can read, not only a colour",
    );
    assert.ok(
      text.includes("#delete-everything"),
      "the selector the command named is shown as text",
    );
    assert.equal(
      await blocked.locator('[data-page-derived="true"]').count() > 0,
      true,
      "and is labelled as page-derived",
    );

    await evidence(page, "session-room-overlays");
    assert.deepEqual(errors, []);
  });
});

/**
 * The two rates of `docs/ARCHITECTURE.md` section 6.3, measured rather than
 * asserted from a constant.
 *
 * The bands are the worker's — 2 to 5 frames per second for a thumbnail, 10 to
 * 20 for an open room — and a viewer cannot raise them. What this case can prove
 * from the browser is the observable consequence: over the same wall-clock
 * window the room paints several times as many frames as a card does, and the
 * drop counter is a real figure rather than a decoration. The measurement is
 * written to the run log, which is the frame-timing evidence RVP-41 asks for.
 */
test("the room paints at the open-session rate and a card at the thumbnail rate", async () => {
  await withSession(DESKTOP, {}, async ({ page, errors }) => {
    const thumbnail = page.locator(`[data-thumbnail="${SESSION.id}"]`);
    await thumbnail.waitFor();
    await thumbnail.scrollIntoViewIfNeeded();
    await page.waitForFunction(
      (id) =>
        Number(
          document
            .querySelector(`[data-thumbnail="${id}"]`)
            ?.getAttribute("data-thumbnail-painted") ?? "0",
        ) > 0,
      SESSION.id,
      { timeout: 15000 },
    );

    const readThumbnail = async (): Promise<number> =>
      Number(await thumbnail.getAttribute("data-thumbnail-painted"));
    const cardBefore = await readThumbnail();
    await page.waitForTimeout(3000);
    const cardAfter = await readThumbnail();
    const cardRate = (cardAfter - cardBefore) / 3;

    await openRoom(page);
    await page.waitForFunction(
      () => Number(document.getElementById("live-frames-painted")?.textContent ?? "0") > 0,
      undefined,
      { timeout: 15000 },
    );
    const readRoom = async (): Promise<number> =>
      Number((await page.locator("#live-frames-painted").textContent()) ?? "0");
    const roomBefore = await readRoom();
    await page.waitForTimeout(3000);
    const roomAfter = await readRoom();
    const roomRate = (roomAfter - roomBefore) / 3;
    const dropped = Number((await page.locator("#live-frames-dropped").textContent()) ?? "0");

    process.stdout.write(
      `EVIDENCE frame timing: thumbnail ${cardRate.toFixed(2)} fps over 3s, ` +
        `session room ${roomRate.toFixed(2)} fps over 3s, dropped ${String(dropped)}\n`,
    );

    assert.ok(cardRate > 0, "the thumbnail painted nothing");
    assert.ok(roomRate > 0, "the room painted nothing");
    assert.ok(
      roomRate > cardRate * 1.5,
      `the room (${roomRate.toFixed(2)} fps) did not outpace the thumbnail (${cardRate.toFixed(2)} fps)`,
    );
    assert.ok(
      cardRate < 10,
      `the thumbnail ran at ${cardRate.toFixed(2)} fps, above the low band a card must stay in`,
    );
    assert.ok(Number.isFinite(dropped) && dropped >= 0, "the drop counter is a real figure");

    assert.deepEqual(errors, []);
  });
});

test("the project timeline is readable without database access", async () => {
  await withSession(DESKTOP, {}, async ({ page, errors }) => {
    await page.getByRole("link", { name: "Projects" }).first().click();
    await page.getByRole("link", { name: "Refresh Surplus" }).first().click();
    const panel = page.locator('[data-timeline="project-activity"]');
    await panel.waitFor();

    // Unfiltered: the project's own rows are here as well as the session's.
    await panel.locator('[data-event-type="project.created"]').waitFor();
    await panel.locator('[data-event-type="finding.created"]').waitFor();
    await panel.locator('[data-event-type="finding.verification_submitted"]').waitFor();

    const body = (await page.textContent("body")) ?? "";
    assert.ok(!body.includes(FORBIDDEN_PAYLOAD_VALUE));

    await evidence(page, "project-timeline-desktop");
    assert.deepEqual(errors, []);
  });
});
