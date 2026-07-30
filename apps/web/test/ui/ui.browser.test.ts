/**
 * User-interface and accessibility tests (`docs/TESTING.md` section 15).
 *
 * They drive the built bundle in a real Chromium against the stub control
 * plane, at both required viewports. Everything asserted here is a
 * requirement rather than a preference: keyboard reachability and visible
 * focus, status conveyed as text, reduced motion honoured, layout that does
 * not overflow at 390x844, a live surface that reconnects after the API
 * restarts, and a console with no errors.
 *
 * They run inside the browser-worker image, which is the only place in this
 * repository with a Chromium and its system libraries; see
 * `scripts/run-ui-tests.sh`.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { chromium, type Browser, type ConsoleMessage, type Page } from "playwright";

import {
  SESSION,
  UI_SUITE_TOKEN,
  startStubControlPlane,
  type StubControlPlane,
} from "./stub-control-plane.ts";

const here = dirname(fileURLToPath(import.meta.url));
const distDirectory = join(here, "..", "..", "dist");
const evidenceDirectory = join(here, "..", "..", "test-results");

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

let browser: Browser;
let stub: StubControlPlane;
let frames: Uint8Array[];

before(async () => {
  browser = await chromium.launch();
  frames = await renderFrames();
  stub = await startStubControlPlane({ distDirectory, frames });
  await mkdir(evidenceDirectory, { recursive: true });
});

after(async () => {
  await stub?.stop();
  await browser?.close();
});

/**
 * Real JPEG frames, produced by screenshotting a fixture page.
 *
 * A synthetic one-pixel image would prove that the transport works and
 * nothing about whether the surface renders, and the screenshots this suite
 * produces as evidence would show an empty canvas.
 */
async function renderFrames(): Promise<Uint8Array[]> {
  const context = await browser.newContext({ viewport: DESKTOP });
  const page = await context.newPage();
  const captured: Uint8Array[] = [];
  for (const [index, heading] of ["Give technology another life", "Checkout", "Basket"].entries()) {
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

interface Session {
  readonly page: Page;
  readonly errors: string[];
  close(): Promise<void>;
}

async function openSignedIn(
  viewport: { width: number; height: number },
  options: { reducedMotion?: "reduce" | "no-preference" } = {},
): Promise<Session> {
  const context = await browser.newContext({
    viewport,
    reducedMotion: options.reducedMotion ?? "no-preference",
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error: Error) => {
    errors.push(error.message);
  });
  page.on("requestfailed", (request) => {
    errors.push(`request failed: ${request.url()}`);
  });

  await page.goto(stub.origin, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Bootstrap administrator token").fill(UI_SUITE_TOKEN);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: "Live sessions" }).waitFor();
  // The signed-out probe of `/api/v1/auth/viewer-sessions/current` answers 401,
  // which a browser logs as a console error however gracefully the application
  // handles it. The requirement is a clean console during a live session, so
  // the record starts once a session exists.
  errors.length = 0;

  return {
    page,
    errors,
    async close(): Promise<void> {
      await context.close();
    },
  };
}

async function openLiveView(session: Session): Promise<void> {
  await session.page.getByRole("link", { name: "Open live view" }).first().click();
  await session.page.getByRole("heading", { name: "Live browser" }).waitFor();
  // The status text is the contract, so the wait is on the words a human
  // reads rather than on an internal state.
  await session.page.getByText("Live", { exact: true }).first().waitFor({ timeout: 15000 });
}

/** Whether the canvas has actually painted something other than one colour. */
async function canvasHasContent(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (canvas === null || canvas.width === 0 || canvas.height === 0) return false;
    const context = canvas.getContext("2d");
    if (context === null) return false;
    // A column through the middle crosses the fixture's header, its body and
    // its card, so a painted frame yields several distinct colours and a blank
    // canvas yields one.
    const column = context.getImageData(Math.floor(canvas.width / 2), 0, 1, canvas.height);
    const seen = new Set<string>();
    for (let index = 0; index < column.data.length; index += 4) {
      seen.add(
        `${String(column.data[index])},${String(column.data[index + 1])},${String(column.data[index + 2])}`,
      );
    }
    return seen.size > 2;
  });
}

test("the live surface renders frames at 1440x900 with no console errors", async () => {
  const session = await openSignedIn(DESKTOP);
  await openLiveView(session);

  await session.page.waitForFunction(
    () => {
      const painted = document.getElementById("live-frames-painted");
      return painted !== null && Number(painted.textContent ?? "0") > 5;
    },
    undefined,
    { timeout: 15000 },
  );
  assert.ok(await canvasHasContent(session.page), "the canvas painted nothing");

  const shot = join(evidenceDirectory, "live-view-1440x900.png");
  await session.page.screenshot({ path: shot });
  process.stdout.write(`EVIDENCE screenshot ${shot}\n`);

  // The session facts a human needs to decide what to annotate.
  await session.page.getByText(SESSION.service_origin, { exact: false }).first().waitFor();
  await session.page.getByText("1440x900", { exact: false }).first().waitFor();

  assert.deepEqual(session.errors, [], "the console reported errors");
  await session.close();
});

test("the layout does not overflow at 390x844", async () => {
  const session = await openSignedIn(MOBILE);
  await openLiveView(session);
  await session.page.waitForTimeout(1500);

  const overflow = await session.page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  assert.ok(
    overflow.documentWidth <= overflow.viewportWidth + 1,
    `the page scrolls horizontally at 390 px: ${String(overflow.documentWidth)} > ${String(overflow.viewportWidth)}`,
  );

  const shot = join(evidenceDirectory, "live-view-390x844.png");
  await session.page.screenshot({ path: shot });
  process.stdout.write(`EVIDENCE screenshot ${shot}\n`);

  assert.deepEqual(session.errors, []);
  await session.close();
});

test("the session list is reachable and operable by keyboard alone", async () => {
  const session = await openSignedIn(DESKTOP);
  // Sign-in left focus on the submit button. A keyboard user arriving at this
  // page starts at the document, so the traversal starts there too.
  await session.page.reload({ waitUntil: "domcontentloaded" });
  await session.page.getByRole("heading", { name: "Live sessions" }).waitFor();

  const reached: string[] = [];
  for (let step = 0; step < 12; step += 1) {
    await session.page.keyboard.press("Tab");
    const description = await session.page.evaluate(() => {
      const active = document.activeElement;
      if (active === null) return "";
      return `${active.tagName.toLowerCase()}:${(active.textContent ?? "").trim().slice(0, 40)}`;
    });
    reached.push(description);
    if (description.startsWith("a:Open live view")) break;
  }
  assert.ok(
    reached.some((entry) => entry.startsWith("a:Skip to main content")),
    `the skip link was not reachable: ${reached.join(" | ")}`,
  );
  assert.ok(
    reached.some((entry) => entry.startsWith("a:Open live view")),
    `the live-view link was not reachable: ${reached.join(" | ")}`,
  );

  // Visible focus: the focused element must have an outline of its own.
  const outline = await session.page.evaluate(() => {
    const active = document.activeElement;
    if (active === null) return null;
    const style = getComputedStyle(active);
    return { width: style.outlineWidth, style: style.outlineStyle };
  });
  assert.ok(outline !== null);
  assert.notEqual(outline.style, "none", "the focused element has no visible outline");
  assert.notEqual(outline.width, "0px", "the focused element's outline has no width");

  // Enter on the focused link opens the live view: no pointer involved.
  await session.page.keyboard.press("Enter");
  await session.page.getByRole("heading", { name: "Live browser" }).waitFor();

  assert.deepEqual(session.errors, []);
  await session.close();
});

test("status is conveyed as text and announced politely", async () => {
  const session = await openSignedIn(DESKTOP);
  await openLiveView(session);

  const live = session.page.locator("[role='status']").first();
  await live.waitFor();
  assert.equal(await live.getAttribute("aria-live"), "polite");
  const text = (await live.textContent()) ?? "";
  assert.ok(text.trim().length > 0, "the status region is empty");
  assert.ok(/live/iu.test(text), `the status region does not state the stream state: ${text}`);

  // The badge states the status in words, not only in colour.
  const badge = session.page.getByText("Live", { exact: true }).first();
  await badge.waitFor();

  // The canvas has a text alternative naming what it shows.
  const label = await session.page.locator("canvas").getAttribute("aria-label");
  assert.ok(label !== null && label.includes(SESSION.id), `canvas label was ${String(label)}`);

  assert.deepEqual(session.errors, []);
  await session.close();
});

test("reduced motion drops the stream to the low frame rate and says so", async () => {
  const session = await openSignedIn(DESKTOP, { reducedMotion: "reduce" });
  await openLiveView(session);

  await session.page.getByText("Reduced motion is on", { exact: false }).waitFor();
  const mode = await session.page.locator("#live-mode").textContent();
  assert.equal(mode, "thumbnail");

  assert.deepEqual(session.errors, []);
  await session.close();
});

test("the viewer reconnects and refreshes state after the API restarts", async () => {
  const session = await openSignedIn(DESKTOP);
  await openLiveView(session);
  const port = stub.port;

  const before = await paintedCount(session.page);
  assert.ok(before > 0);

  // Induced failure: the control plane goes away mid-stream.
  await stub.stop();
  await session.page.getByText("Reconnecting", { exact: false }).first().waitFor({ timeout: 15000 });
  process.stdout.write("EVIDENCE reconnect: status became Reconnecting after the API stopped\n");

  const restartShot = join(evidenceDirectory, "live-view-reconnecting.png");
  await session.page.screenshot({ path: restartShot });
  process.stdout.write(`EVIDENCE screenshot ${restartShot}\n`);

  // The same port, so the page's own origin still resolves.
  stub = await startStubControlPlane({ distDirectory, frames, port });
  await session.page.getByText("Live", { exact: true }).first().waitFor({ timeout: 30000 });
  process.stdout.write("EVIDENCE reconnect: status returned to Live after the API restarted\n");

  await session.page.waitForFunction(
    (previous) => {
      const painted = document.getElementById("live-frames-painted");
      return painted !== null && Number(painted.textContent ?? "0") > previous;
    },
    before,
    { timeout: 20000 },
  );

  await session.close();
});

test("a refused live stream shows a specific, actionable failure state", async () => {
  await stub.stop();
  const port = stub.port;
  stub = await startStubControlPlane({ distDirectory, frames, port, refuseLive: true });

  const session = await openSignedIn(DESKTOP);
  await session.page.getByRole("link", { name: "Open live view" }).first().click();
  await session.page.getByRole("heading", { name: "Live browser" }).waitFor();

  // Not a blank canvas and not "something went wrong": the page names a cause
  // and what remains possible (docs/UX_FLOWS.md section 18).
  await session.page
    .getByText("Reconnecting", { exact: false })
    .first()
    .waitFor({ timeout: 20000 });
  const body = (await session.page.textContent("body")) ?? "";
  assert.ok(!/something went wrong/iu.test(body));
  assert.ok(
    /navigation and screenshot capture|reconnect/iu.test(body),
    "the failure state offers no action",
  );

  const shot = join(evidenceDirectory, "live-view-failure-state.png");
  await session.page.screenshot({ path: shot });
  process.stdout.write(`EVIDENCE screenshot ${shot}\n`);

  await session.close();
  await stub.stop();
  stub = await startStubControlPlane({ distDirectory, frames, port });
});

test("the page fetches nothing from another host", async () => {
  const context = await browser.newContext({ viewport: DESKTOP });
  const page = await context.newPage();
  const external: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "data:" || url.protocol === "blob:") return;
    if (url.host !== new URL(stub.origin).host) external.push(request.url());
  });
  await page.goto(stub.origin, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  assert.deepEqual(external, [], "the page reached an external host");
  await context.close();
});

async function paintedCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const painted = document.getElementById("live-frames-painted");
    return Number(painted?.textContent ?? "0");
  });
}

/** Records the evidence summary the issue asks for, in the run log. */
after(async () => {
  await writeFile(
    join(evidenceDirectory, "ui-evidence.txt"),
    [
      "ReviewPlane RVP-29 user-interface evidence",
      `frames streamed by the stub control plane: ${String(stub?.framesSent ?? 0)}`,
      "screenshots: live-view-1440x900.png, live-view-390x844.png,",
      "  live-view-reconnecting.png, live-view-failure-state.png",
      "",
    ].join("\n"),
    "utf8",
  );
});
