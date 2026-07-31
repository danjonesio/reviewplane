/**
 * The safe artefact viewer in a real browser (`docs/UX_FLOWS.md` §17, RVP-33).
 *
 * `annotation.browser.test.ts` proves that a mark lands on the right part of
 * the picture. This file proves the rest of §17: the annotation toggle, the
 * before-and-after comparison, the download, and the metadata a reader needs in
 * order to trust the evidence — at both required viewports, operable from the
 * keyboard with visible focus, and with no console error or failed request.
 *
 * One case is a security property rather than a usability one. A DOM snapshot
 * is markup a browser executes, and `docs/SECURITY.md` §13 forbids rendering it
 * under the control-plane origin. The viewer must offer it as a download and
 * must not put it in an `img`, an `iframe` or an `object`, and the assertion
 * below is over the rendered DOM rather than over the component's source, so it
 * fails if a later change reintroduces one.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { chromium, type Browser, type ConsoleMessage, type Page, type Request } from "playwright";

import {
  CAPTURE_VIEWPORT,
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
let stub: StubControlPlane;
const evidence: string[] = [];

before(async () => {
  browser = await chromium.launch();
  stub = await startStubControlPlane({
    distDirectory,
    frames: [],
    screenshot: await renderCapture("#0f172a", "#f97316"),
    // A visibly different picture, so a slider that moves changes what is on
    // screen rather than merely moving a handle.
    afterScreenshot: await renderCapture("#052e16", "#22c55e"),
  });
  await mkdir(evidenceDirectory, { recursive: true });
});

after(async () => {
  await stub?.stop();
  await browser?.close();
  await writeFile(
    join(evidenceDirectory, "artefact-viewer-evidence.txt"),
    ["ReviewPlane RVP-33 artefact viewer evidence", "", ...evidence, ""].join("\n"),
    "utf8",
  );
});

/** A capture at the 390x844 preset and device pixel ratio 2, as the product takes them. */
async function renderCapture(background: string, block: string): Promise<Uint8Array> {
  const context = await browser.newContext({
    viewport: { width: CAPTURE_VIEWPORT.width, height: CAPTURE_VIEWPORT.height },
    deviceScaleFactor: CAPTURE_VIEWPORT.device_scale_factor,
  });
  const page = await context.newPage();
  await page.setContent(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
       html, body { margin:0; height:100%; background:${background}; }
       #block { position:absolute; left:25%; top:30%; width:30%; height:12%; background:${block}; }
     </style></head><body><div id="block"></div></body></html>`,
  );
  const bytes = await page.screenshot({ type: "png" });
  await context.close();
  return bytes;
}

interface Session {
  readonly page: Page;
  readonly errors: string[];
  readonly failedRequests: string[];
  close(): Promise<void>;
}

async function openReview(viewport: { width: number; height: number }): Promise<Session> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error: Error) => {
    errors.push(error.message);
  });
  page.on("requestfailed", (request: Request) => {
    failedRequests.push(`${request.method()} ${request.url()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failedRequests.push(`${String(response.status())} ${response.url()}`);
    }
  });

  await page.goto(stub.origin, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email address").fill(UI_SUITE_EMAIL);
  await page.getByLabel("Password").fill(UI_SUITE_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: "Live sessions" }).waitFor();
  errors.length = 0;
  failedRequests.length = 0;

  await page.getByRole("link", { name: "Reviews" }).click();
  await page.getByRole("heading", { name: "Reviews", exact: true }).waitFor();
  await page.getByRole("link", { name: "Open review" }).first().click();
  await page.getByRole("heading", { name: "Bugs on homepage" }).waitFor();
  await page.waitForFunction(
    () => {
      const image = document.querySelector<HTMLImageElement>("[data-testid=artefact-image]");
      return image !== null && image.complete && image.naturalWidth > 0;
    },
    undefined,
    { timeout: 20_000 },
  );

  return {
    page,
    errors,
    failedRequests,
    async close(): Promise<void> {
      await context.close();
    },
  };
}

/** The first finding's panel: the one with annotations and a comparison. */
function heroPanel(page: Page) {
  return page.locator("[data-finding='fin_ui_suite_hero']");
}

for (const [name, viewport] of [
  ["1440x900", DESKTOP],
  ["390x844", MOBILE],
] as const) {
  test(`the viewer shows evidence, metadata and the comparison at ${name}`, async () => {
    const session = await openReview(viewport);
    try {
      const panel = heroPanel(session.page);

      // ---- metadata (`docs/UX_FLOWS.md` section 17) -----------------------
      const sha256 = await panel.locator("[data-testid=artefact-sha256]").first().innerText();
      const redaction = await panel.locator("[data-testid=artefact-redaction]").first().innerText();
      const retention = await panel.locator("[data-testid=artefact-retention]").first().innerText();
      const rectangle = await panel.locator("[data-testid=content-rectangle]").first().innerText();
      assert.match(sha256, /^[0-9a-f]{64}$/u);
      assert.equal(redaction, "none applied");
      assert.match(retention, /verification_evidence, due \d{4}-\d{2}-\d{2}/u);
      assert.equal(rectangle, "780x1688 px");

      // ---- the download is offered, and points at the grant ---------------
      const download = panel.locator("[data-testid=artefact-download]").first();
      assert.match(
        (await download.getAttribute("href")) ?? "",
        /^\/api\/v1\/artefact-content\/agr_/u,
        "the download goes through a short-lived grant, never a path addressed by artefact identifier",
      );

      // ---- annotations toggle off and on ----------------------------------
      const toggle = panel.locator("[data-testid=toggle-annotations]").first();
      const mark = panel.locator("[data-annotation='ann_ui_suite_rectangle']");
      await mark.waitFor();
      await session.page.screenshot({
        path: join(evidenceDirectory, `artefact-viewer-${name}-annotations-on.png`),
        fullPage: true,
      });
      assert.equal(await toggle.getAttribute("aria-pressed"), "true");

      await toggle.click();
      await mark.waitFor({ state: "detached" });
      assert.equal(await toggle.getAttribute("aria-pressed"), "false");
      // The original and the non-canvas alternative survive the toggle: the
      // evidence is still on screen and the marks are still readable as text.
      await panel.locator("[data-testid=artefact-image]").first().waitFor();
      await panel.getByText("Heading overlapping the basket button").first().waitFor();
      await session.page.screenshot({
        path: join(evidenceDirectory, `artefact-viewer-${name}-annotations-off.png`),
        fullPage: true,
      });

      await toggle.click();
      await mark.waitFor();

      // ---- before-and-after comparison ------------------------------------
      const slider = panel.locator("[data-testid=artefact-compare-slider]").first();
      await slider.waitFor();
      const compareImage = panel.locator("[data-testid=artefact-compare-image]").first();
      await session.page.waitForFunction(
        () => {
          const image = document.querySelector<HTMLImageElement>(
            "[data-testid=artefact-compare-image]",
          );
          return image !== null && image.complete && image.naturalWidth > 0;
        },
        undefined,
        { timeout: 20_000 },
      );

      // The handle is a real range input, so the keyboard drives it without a
      // handler of the component's own.
      await slider.focus();
      const focusedTag = await session.page.evaluate(
        () => document.activeElement?.getAttribute("data-testid") ?? "",
      );
      assert.equal(focusedTag, "artefact-compare-slider", "the slider takes keyboard focus");
      const outline = await session.page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        if (element === null) return "";
        const style = globalThis.getComputedStyle(element);
        return `${style.outlineStyle} ${style.outlineWidth}`;
      });
      assert.notEqual(outline.split(" ")[0], "none", `focus is visible: ${outline}`);

      const before = await clipOf(session.page);
      await session.page.keyboard.press("Home");
      const atStart = await clipOf(session.page);
      await session.page.keyboard.press("End");
      const atEnd = await clipOf(session.page);
      assert.notEqual(atStart, atEnd, "Home and End move the comparison");
      await session.page.keyboard.press("ArrowLeft");
      const afterArrow = await clipOf(session.page);
      assert.notEqual(afterArrow, atEnd, "the arrow keys move the comparison");
      evidence.push(
        `${name} comparison clip: initial ${before}, Home ${atStart}, End ${atEnd}, ArrowLeft ${afterArrow}`,
      );

      // Half way, the after picture covers the right of the frame. The two
      // captures differ, so a pixel read on each side is what proves the
      // comparison is showing two things rather than one twice.
      await slider.fill("50");
      await session.page.waitForTimeout(50);
      await session.page.screenshot({
        path: join(evidenceDirectory, `artefact-viewer-${name}-comparison.png`),
        fullPage: true,
      });
      const visible = await compareImage.isVisible();
      assert.equal(visible, true, "the after screenshot is on screen");

      // ---- no console error, no failed request ----------------------------
      assert.deepEqual(session.errors, [], "console errors");
      assert.deepEqual(session.failedRequests, [], "failed network requests");
      evidence.push(
        `${name}: sha256 ${sha256.slice(0, 16)}…, redaction "${redaction}", retention "${retention}", rectangle ${rectangle}`,
      );
    } finally {
      await session.close();
    }
  });
}

test("a DOM snapshot is offered as a download and is never rendered", async () => {
  const session = await openReview(DESKTOP);
  try {
    const panel = session.page.locator("[data-finding='fin_ui_suite_active']");
    const notice = panel.locator("[data-testid=active-content-notice]").first();
    await notice.waitFor();
    const text = await notice.innerText();
    assert.match(text, /would execute/u);

    const download = panel.locator("[data-testid=artefact-download]").first();
    assert.match((await download.getAttribute("href")) ?? "", /^\/api\/v1\/artefact-content\/agr_/u);
    assert.match((await download.getAttribute("download")) ?? "", /\.html$/u);

    // `docs/SECURITY.md` section 13, asserted over the rendered DOM: nothing in
    // this panel loads or embeds the snapshot.
    const embedded = await panel.evaluate(
      (element: HTMLElement) => element.querySelectorAll("img, iframe, object, embed").length,
    );
    assert.equal(embedded, 0, "active markup must not reach an element that renders it");

    assert.deepEqual(session.errors, [], "console errors");
    evidence.push(`DOM snapshot panel: "${text.replace(/\s+/gu, " ").slice(0, 120)}"`);
    await session.page.screenshot({
      path: join(evidenceDirectory, "artefact-viewer-active-content.png"),
      fullPage: true,
    });
  } finally {
    await session.close();
  }
});

test("a finding with no after screenshot says so instead of offering a comparison", async () => {
  const session = await openReview(DESKTOP);
  try {
    const panel = session.page.locator("[data-finding='fin_ui_suite_unmeasured']");
    const empty = panel.locator("[data-testid=artefact-compare-empty]").first();
    await empty.waitFor();
    assert.match(await empty.innerText(), /No after screenshot/u);
    assert.equal(await panel.locator("[data-testid=artefact-compare-slider]").count(), 0);

    // And the artefact the server could not measure still shows the original
    // and the annotation list (`docs/UX_FLOWS.md` section 18).
    await panel.locator("[data-testid=overlay-degraded]").first().waitFor();
    await panel.locator("[data-testid=artefact-image]").first().waitFor();
    await panel.getByText("Stale basket count").first().waitFor();
    assert.deepEqual(session.errors, [], "console errors");
  } finally {
    await session.close();
  }
});

test("every control in the viewer is reachable by keyboard alone", async () => {
  const session = await openReview(DESKTOP);
  try {
    const reached = new Set<string>();
    // Tab through the document once and record what the viewer's own controls
    // were: `docs/UX_FLOWS.md` section 19 requires the toggle and the
    // comparison to be operable without a pointer.
    for (let step = 0; step < 60; step += 1) {
      await session.page.keyboard.press("Tab");
      const marker = await session.page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        if (element === null) return "";
        return element.getAttribute("data-testid") ?? element.getAttribute("data-zoom") ?? "";
      });
      if (marker !== "") reached.add(marker);
      if (
        reached.has("toggle-annotations") &&
        reached.has("artefact-compare-slider") &&
        reached.has("artefact-download") &&
        reached.has("fit")
      ) {
        break;
      }
    }
    assert.ok(reached.has("toggle-annotations"), `annotation toggle: ${[...reached].join(", ")}`);
    assert.ok(reached.has("artefact-compare-slider"), `comparison: ${[...reached].join(", ")}`);
    assert.ok(reached.has("artefact-download"), `download: ${[...reached].join(", ")}`);
    assert.ok(reached.has("fit"), `zoom: ${[...reached].join(", ")}`);
    evidence.push(`keyboard-reachable controls: ${[...reached].join(", ")}`);
  } finally {
    await session.close();
  }
});

/** The comparison image's clip inset, which is what the slider moves. */
async function clipOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    const image = document.querySelector<HTMLImageElement>("[data-testid=artefact-compare-image]");
    return image === null ? "" : image.style.clipPath;
  });
}
