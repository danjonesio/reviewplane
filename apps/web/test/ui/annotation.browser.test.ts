/**
 * The Stage 0 exit criterion: **a screenshot annotation aligns after UI
 * resize** (`docs/ROADMAP.md` section 2, `docs/TESTING.md` sections 7 and 15,
 * ADR-0006, ADR-0011).
 *
 * The trap this suite is built to avoid is a test that only proves the overlay
 * is *somewhere*. So every case measures two things and requires them to
 * agree:
 *
 *   1. where the mark sits, expressed as a fraction of the rendered content
 *      rectangle — which must equal the stored normalised geometry;
 *   2. what the screenshot actually shows at that same fraction — which must
 *      be the block of colour the fixture page painted there.
 *
 * The second check is what makes this an alignment test rather than a layout
 * test: the fixture page paints a distinctly coloured region, the annotation
 * claims exactly that region, and a mark that drifts by so much as a few per
 * cent lands on the dark background instead.
 *
 * The conditions are the ones `AGENTS.md` "Browser-facing work" requires:
 * 390x844 and 1440x900, device pixel ratio 1 and 2, an in-page container
 * resize, a scroll, and a zoom change.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { chromium, type Browser, type ConsoleMessage, type Page } from "playwright";

import {
  CAPTURE_VIEWPORT,
  MARKED_COLOUR,
  MARKED_REGION,
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

/**
 * How far a mark may sit from where its geometry says, as a fraction of the
 * content rectangle. Half a per cent of a 780-pixel-wide capture is under four
 * device pixels: tight enough that a forgotten letterbox offset or a stray
 * device-pixel-ratio multiplication fails, loose enough to survive subpixel
 * layout rounding.
 */
const TOLERANCE = 0.005;

let browser: Browser;
let stub: StubControlPlane;
const evidence: string[] = [];

before(async () => {
  browser = await chromium.launch();
  const screenshot = await renderFixtureScreenshot();
  stub = await startStubControlPlane({ distDirectory, frames: [], screenshot });
  await mkdir(evidenceDirectory, { recursive: true });
});

after(async () => {
  await stub?.stop();
  await browser?.close();
  await writeFile(
    join(evidenceDirectory, "annotation-evidence.txt"),
    [
      "ReviewPlane RVP-34 annotation alignment evidence",
      `annotation geometry: ${JSON.stringify(MARKED_REGION)}`,
      `content rectangle: ${String(CAPTURE_VIEWPORT.width * CAPTURE_VIEWPORT.device_scale_factor)}x${String(
        CAPTURE_VIEWPORT.height * CAPTURE_VIEWPORT.device_scale_factor,
      )} device pixels`,
      "",
      ...evidence,
      "",
    ].join("\n"),
    "utf8",
  );
});

/**
 * The screenshot the review is about.
 *
 * It is a real capture of a real page at the 390x844 preset and a device pixel
 * ratio of 2, so the stored artefact is 780x1688 device pixels — which is
 * exactly the case that catches an overlay normalised against the viewport
 * instead of against the artefact.
 */
async function renderFixtureScreenshot(): Promise<Uint8Array> {
  const context = await browser.newContext({
    viewport: { width: CAPTURE_VIEWPORT.width, height: CAPTURE_VIEWPORT.height },
    deviceScaleFactor: CAPTURE_VIEWPORT.device_scale_factor,
  });
  const page = await context.newPage();
  const colour = `rgb(${String(MARKED_COLOUR.r)}, ${String(MARKED_COLOUR.g)}, ${String(
    MARKED_COLOUR.b,
  )})`;
  await page.setContent(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
       html, body { margin:0; height:100%; background:#0f172a; color:#f8fafc;
                    font-family: system-ui, sans-serif; }
       #marked { position:absolute;
                 left:${String(MARKED_REGION.x * 100)}%;
                 top:${String(MARKED_REGION.y * 100)}%;
                 width:${String(MARKED_REGION.width * 100)}%;
                 height:${String(MARKED_REGION.height * 100)}%;
                 background:${colour}; }
       header { padding:16px; background:#1e293b; }
     </style></head><body>
       <header>Refresh Surplus</header>
       <div id="marked"></div>
     </body></html>`,
  );
  const bytes = await page.screenshot({ type: "png" });
  await context.close();
  return bytes;
}

interface Session {
  readonly page: Page;
  readonly errors: string[];
  close(): Promise<void>;
}

async function openReview(
  viewport: { width: number; height: number },
  deviceScaleFactor: number,
): Promise<Session> {
  const context = await browser.newContext({ viewport, deviceScaleFactor });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error: Error) => {
    errors.push(error.message);
  });

  await page.goto(stub.origin, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email address").fill(UI_SUITE_EMAIL);
  await page.getByLabel("Password").fill(UI_SUITE_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: "Live sessions" }).waitFor();
  errors.length = 0;

  await page.getByRole("link", { name: "Reviews" }).click();
  await page.getByRole("heading", { name: "Reviews", exact: true }).waitFor();
  await page.getByRole("link", { name: "Open review" }).first().click();
  await page.getByRole("heading", { name: "Bugs on homepage" }).waitFor();
  // The evidence lives on the finding page: a review with several findings,
  // each carrying a before-and-after pair, is not a page anybody can read at
  // 390 pixels (RVP-55).
  await page.getByRole("link", { name: "Open finding" }).first().click();
  await page
    .getByRole("heading", { name: "Hero heading overlaps the basket button" })
    .waitFor();
  // The overlay cannot be measured before the screenshot has decoded.
  await page.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>("[data-testid=artefact-image]");
    return image !== null && image.complete && image.naturalWidth > 0;
  }, undefined, { timeout: 20_000 });
  await page.locator("[data-annotation='ann_ui_suite_rectangle']").waitFor();

  return {
    page,
    errors,
    async close(): Promise<void> {
      await context.close();
    },
  };
}

interface Alignment {
  /** Where the mark sits, as a fraction of the rendered content rectangle. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The screenshot's own colour at the centre of the mark. */
  readonly colour: { readonly r: number; readonly g: number; readonly b: number };
  readonly contentWidth: number;
  readonly contentHeight: number;
  /** The image element's own box, which is the stage the overlay measures. */
  readonly imageWidth: number;
}

/**
 * Measures one mark independently of the application's own arithmetic.
 *
 * The contained-rectangle maths is recomputed here from `getBoundingClientRect`
 * and `naturalWidth` rather than read from the component, so a mistake shared
 * between the renderer and the test cannot cancel itself out.
 */
async function measure(page: Page, annotationId: string): Promise<Alignment> {
  return page.evaluate((id: string) => {
    const image = document.querySelector<HTMLImageElement>("[data-testid=artefact-image]");
    const mark = document.querySelector<HTMLElement>(`[data-annotation='${id}']`);
    if (image === null || mark === null) throw new Error("the overlay is not rendered");

    const box = image.getBoundingClientRect();
    const scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
    const contentWidth = image.naturalWidth * scale;
    const contentHeight = image.naturalHeight * scale;
    const contentLeft = box.left + (box.width - contentWidth) / 2;
    const contentTop = box.top + (box.height - contentHeight) / 2;

    const markBox = mark.getBoundingClientRect();
    const centreX = (markBox.left + markBox.width / 2 - contentLeft) / contentWidth;
    const centreY = (markBox.top + markBox.height / 2 - contentTop) / contentHeight;

    // What the picture shows where the mark is. The image is same-origin, so
    // the canvas is readable.
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no 2d context");
    context.drawImage(image, 0, 0);
    const pixel = context.getImageData(
      Math.round(centreX * image.naturalWidth),
      Math.round(centreY * image.naturalHeight),
      1,
      1,
    ).data;

    return {
      x: (markBox.left - contentLeft) / contentWidth,
      y: (markBox.top - contentTop) / contentHeight,
      width: markBox.width / contentWidth,
      height: markBox.height / contentHeight,
      colour: { r: pixel[0] ?? 0, g: pixel[1] ?? 0, b: pixel[2] ?? 0 },
      contentWidth,
      contentHeight,
      imageWidth: box.width,
    };
  }, annotationId);
}

/** The screenshot's own colour at a normalised point of the artefact. */
async function sampleColour(
  page: Page,
  x: number,
  y: number,
): Promise<{ r: number; g: number; b: number }> {
  return page.evaluate(
    ({ nx, ny }: { nx: number; ny: number }) => {
      const image = document.querySelector<HTMLImageElement>("[data-testid=artefact-image]");
      if (image === null) throw new Error("no artefact image");
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("no 2d context");
      context.drawImage(image, 0, 0);
      const pixel = context.getImageData(
        Math.round(nx * image.naturalWidth),
        Math.round(ny * image.naturalHeight),
        1,
        1,
      ).data;
      return { r: pixel[0] ?? 0, g: pixel[1] ?? 0, b: pixel[2] ?? 0 };
    },
    { nx: x, ny: y },
  );
}

function assertAligned(alignment: Alignment, label: string): void {
  const expected = MARKED_REGION;
  // A border draws outside the box, so the measured rectangle is a little
  // larger than the geometry; the centre is what must not move.
  const centreX = alignment.x + alignment.width / 2;
  const centreY = alignment.y + alignment.height / 2;
  assert.ok(
    Math.abs(centreX - (expected.x + expected.width / 2)) < TOLERANCE,
    `${label}: horizontal centre ${centreX.toFixed(4)} is not ${(expected.x + expected.width / 2).toFixed(4)}`,
  );
  assert.ok(
    Math.abs(centreY - (expected.y + expected.height / 2)) < TOLERANCE,
    `${label}: vertical centre ${centreY.toFixed(4)} is not ${(expected.y + expected.height / 2).toFixed(4)}`,
  );
  assert.ok(
    Math.abs(alignment.width - expected.width) < 0.02,
    `${label}: width ${alignment.width.toFixed(4)} is not ${expected.width.toFixed(4)}`,
  );

  // And the picture underneath is the region the human marked.
  assert.ok(
    Math.abs(alignment.colour.r - MARKED_COLOUR.r) < 24 &&
      Math.abs(alignment.colour.g - MARKED_COLOUR.g) < 24 &&
      Math.abs(alignment.colour.b - MARKED_COLOUR.b) < 24,
    `${label}: the mark is over rgb(${String(alignment.colour.r)}, ${String(
      alignment.colour.g,
    )}, ${String(alignment.colour.b)}), not the marked region`,
  );

  evidence.push(
    `${label}: content rectangle ${alignment.contentWidth.toFixed(1)}x${alignment.contentHeight.toFixed(
      1,
    )} CSS px, mark centre ${centreX.toFixed(4)}, ${centreY.toFixed(4)}, ` +
      `pixel rgb(${String(alignment.colour.r)}, ${String(alignment.colour.g)}, ${String(alignment.colour.b)})`,
  );
}

async function capture(page: Page, name: string): Promise<void> {
  const path = join(evidenceDirectory, name);
  await page.screenshot({ path });
  process.stdout.write(`EVIDENCE screenshot ${path}\n`);
}

test("the annotation aligns at 1440x900 and device pixel ratio 1", async () => {
  const session = await openReview(DESKTOP, 1);
  assertAligned(await measure(session.page, "ann_ui_suite_rectangle"), "1440x900 at dpr 1");
  await capture(session.page, "annotation-1440x900-dpr1.png");
  assert.deepEqual(session.errors, []);
  await session.close();
});

test("the annotation aligns at 1440x900 and device pixel ratio 2", async () => {
  const session = await openReview(DESKTOP, 2);
  assertAligned(await measure(session.page, "ann_ui_suite_rectangle"), "1440x900 at dpr 2");
  await capture(session.page, "annotation-1440x900-dpr2.png");
  assert.deepEqual(session.errors, []);
  await session.close();
});

test("the annotation aligns at 390x844 and device pixel ratio 1", async () => {
  const session = await openReview(MOBILE, 1);
  assertAligned(await measure(session.page, "ann_ui_suite_rectangle"), "390x844 at dpr 1");
  await capture(session.page, "annotation-390x844-dpr1.png");

  const overflow = await session.page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  assert.ok(
    overflow.documentWidth <= overflow.viewportWidth + 1,
    `the page scrolls horizontally at 390 px: ${String(overflow.documentWidth)}`,
  );
  assert.deepEqual(session.errors, []);
  await session.close();
});

test("the annotation aligns at 390x844 and device pixel ratio 2", async () => {
  const session = await openReview(MOBILE, 2);
  assertAligned(await measure(session.page, "ann_ui_suite_rectangle"), "390x844 at dpr 2");
  await capture(session.page, "annotation-390x844-dpr2.png");
  assert.deepEqual(session.errors, []);
  await session.close();
});

test("the annotation still aligns after an in-page container resize", async () => {
  const session = await openReview(DESKTOP, 1);
  const before = await measure(session.page, "ann_ui_suite_rectangle");
  assertAligned(before, "before resize");

  // The container is resized in the page, exactly as a split view or a
  // narrowed window would resize it. 200 px is narrow enough that width
  // becomes the limiting dimension, so the content rectangle really does
  // change shape rather than merely moving.
  await session.page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>("[data-testid=artefact-panel]");
    if (panel === null) throw new Error("no artefact panel");
    panel.style.width = "200px";
  });
  await session.page.waitForFunction(
    (previous: number) => {
      const image = document.querySelector<HTMLImageElement>("[data-testid=artefact-image]");
      return image !== null && Math.abs(image.getBoundingClientRect().width - previous) > 1;
    },
    before.imageWidth,
    { timeout: 5000 },
  );
  // One frame for the ResizeObserver callback to render.
  await session.page.waitForTimeout(150);

  const after = await measure(session.page, "ann_ui_suite_rectangle");
  assert.ok(
    Math.abs(after.contentWidth - before.contentWidth) > 1,
    `the content rectangle did not change: ${String(before.contentWidth)} to ${String(after.contentWidth)}`,
  );
  assertAligned(after, "after container resize");
  await capture(session.page, "annotation-after-container-resize.png");

  assert.deepEqual(session.errors, []);
  await session.close();
});

test("the annotation still aligns after scrolling and after a zoom change", async () => {
  const session = await openReview(DESKTOP, 1);

  // Zoom to 200%, which makes the stage larger than the panel and turns the
  // panel into a scrolling window onto the screenshot.
  await session.page.locator("[data-finding='fin_ui_suite_hero'] [data-zoom='200']").click();
  await session.page.waitForTimeout(200);
  const zoomed = await measure(session.page, "ann_ui_suite_rectangle");
  assertAligned(zoomed, "at 200% zoom");

  await session.page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>("[data-testid=artefact-panel]");
    if (panel === null) throw new Error("no artefact panel");
    panel.scrollTop = 240;
    panel.scrollLeft = 60;
  });
  await session.page.waitForTimeout(120);
  assertAligned(await measure(session.page, "ann_ui_suite_rectangle"), "after scrolling the panel");
  await capture(session.page, "annotation-zoomed-and-scrolled.png");

  // Back to fit, and the mark is where it started.
  await session.page.locator("[data-finding='fin_ui_suite_hero'] [data-zoom='fit']").click();
  await session.page.waitForTimeout(200);
  assertAligned(await measure(session.page, "ann_ui_suite_rectangle"), "back at fit");

  assert.deepEqual(session.errors, []);
  await session.close();
});

test("every annotation type lands on the region its geometry names", async () => {
  const session = await openReview(DESKTOP, 1);

  // A numbered marker is drawn around its point, so its box centre is the
  // point, and the point is the centre of the marked region.
  const marker = await measure(session.page, "ann_ui_suite_marker");
  const markerCentre = { x: marker.x + marker.width / 2, y: marker.y + marker.height / 2 };
  assert.ok(Math.abs(markerCentre.x - 0.4) < TOLERANCE, `marker x ${markerCentre.x.toFixed(4)}`);
  assert.ok(Math.abs(markerCentre.y - 0.36) < TOLERANCE, `marker y ${markerCentre.y.toFixed(4)}`);
  assert.ok(
    Math.abs(marker.colour.r - MARKED_COLOUR.r) < 24 &&
      Math.abs(marker.colour.g - MARKED_COLOUR.g) < 24,
    `the marker is over rgb(${String(marker.colour.r)}, ${String(marker.colour.g)}, ${String(marker.colour.b)})`,
  );

  // An arrow points up and to the right, so its head is the top-right corner
  // of its box — and the head is what has to be on the marked region.
  const arrow = await measure(session.page, "ann_ui_suite_arrow");
  const head = { x: arrow.x + arrow.width, y: arrow.y };
  assert.ok(Math.abs(head.x - 0.4) < 0.02, `arrow head x ${head.x.toFixed(4)}`);
  assert.ok(Math.abs(head.y - 0.42) < 0.02, `arrow head y ${head.y.toFixed(4)}`);
  const headColour = await sampleColour(session.page, head.x, head.y - 0.01);
  assert.ok(
    Math.abs(headColour.r - MARKED_COLOUR.r) < 24 && Math.abs(headColour.g - MARKED_COLOUR.g) < 24,
    `the arrow head is over rgb(${String(headColour.r)}, ${String(headColour.g)}, ${String(headColour.b)})`,
  );

  evidence.push(
    `numbered_marker: centre ${markerCentre.x.toFixed(4)}, ${markerCentre.y.toFixed(4)}, ` +
      `pixel rgb(${String(marker.colour.r)}, ${String(marker.colour.g)}, ${String(marker.colour.b)})`,
    `arrow: head ${head.x.toFixed(4)}, ${head.y.toFixed(4)}, ` +
      `pixel rgb(${String(headColour.r)}, ${String(headColour.g)}, ${String(headColour.b)})`,
  );

  assert.deepEqual(session.errors, []);
  await session.close();
});

test("the annotation list presents the same marks without the canvas", async () => {
  const session = await openReview(DESKTOP, 1);
  const list = session.page.locator("[data-testid=annotation-list]").first();
  await list.waitFor();
  const text = (await list.textContent()) ?? "";

  // Each mark's label and its position in words (`docs/UX_FLOWS.md` §19).
  assert.match(text, /Heading overlapping the basket button/u);
  assert.match(text, /rectangle at 25% across, 30% down, 30% wide and 12% tall/u);
  assert.match(text, /numbered marker at 40% across, 36% down/u);
  assert.match(text, /arrow from 10% across, 70% down to 40% across, 42% down/u);

  // Hiding the overlay leaves the screenshot and the list intact.
  await session.page.locator("[data-testid=toggle-annotations]").first().click();
  await session.page.waitForTimeout(100);
  assert.equal(await session.page.locator("[data-annotation]").count(), 0);
  await session.page.locator("[data-testid=artefact-image]").first().waitFor();
  assert.ok(((await list.textContent()) ?? "").includes("Heading overlapping"));

  assert.deepEqual(session.errors, []);
  await session.close();
});

test("an artefact with no measured content rectangle degrades to picture plus list", async () => {
  const session = await openReview(DESKTOP, 1);
  // The second finding's artefact was never measured, so the overlay cannot be
  // placed. The evidence must survive that (`docs/UX_FLOWS.md` section 18).
  const panel = session.page.locator("[data-finding='fin_ui_suite_unmeasured']");
  await panel.scrollIntoViewIfNeeded();
  const notice = panel.locator("[data-testid=overlay-degraded]");
  await notice.waitFor();
  assert.match((await notice.textContent()) ?? "", /no measured content rectangle/u);

  // The original screenshot is still shown.
  await panel.locator("[data-testid=artefact-image]").waitFor();
  // And the annotation list still names the mark.
  const list = panel.locator("[data-testid=annotation-list]");
  await list.waitFor();
  assert.match((await list.textContent()) ?? "", /Stale basket count/u);
  // No mark was drawn for it.
  assert.equal(await panel.locator("[data-annotation]").count(), 0);

  await capture(session.page, "annotation-degraded-viewer.png");
  assert.deepEqual(session.errors, []);
  await session.close();
});

test("annotation controls are reachable by keyboard and show visible focus", async () => {
  const session = await openReview(DESKTOP, 1);

  const reached: string[] = [];
  for (let step = 0; step < 30; step += 1) {
    await session.page.keyboard.press("Tab");
    const description = await session.page.evaluate(() => {
      const active = document.activeElement;
      if (active === null) return "";
      const annotation = active.getAttribute("data-annotation");
      const item = active.getAttribute("data-annotation-item");
      const zoom = active.getAttribute("data-zoom");
      const testid = active.getAttribute("data-testid");
      return [
        active.tagName.toLowerCase(),
        annotation ?? item ?? zoom ?? testid ?? (active.textContent ?? "").trim().slice(0, 30),
      ].join(":");
    });
    reached.push(description);
    if (description.startsWith("button:ann_ui_suite_rectangle")) break;
  }
  assert.ok(
    reached.some((entry) => entry.includes("fit")),
    `the zoom controls were not reachable: ${reached.join(" | ")}`,
  );
  assert.ok(
    reached.some((entry) => entry.startsWith("button:ann_ui_suite_rectangle")),
    `the annotation mark was not reachable: ${reached.join(" | ")}`,
  );

  const outline = await session.page.evaluate(() => {
    const active = document.activeElement;
    if (active === null) return null;
    const style = getComputedStyle(active);
    return { width: style.outlineWidth, style: style.outlineStyle };
  });
  assert.ok(outline !== null);
  assert.notEqual(outline.style, "none", "the focused annotation has no visible outline");
  assert.notEqual(outline.width, "0px", "the focused annotation's outline has no width");

  // Enter selects the mark, and the list shows the same selection: the canvas
  // and its text alternative are one control surface, not two.
  await session.page.keyboard.press("Enter");
  await session.page.waitForTimeout(80);
  assert.equal(
    await session.page
      .locator("[data-annotation-item='ann_ui_suite_rectangle']")
      .first()
      .getAttribute("aria-pressed"),
    "true",
  );

  assert.deepEqual(session.errors, []);
  await session.close();
});

test("the review page fetches nothing from another host", async () => {
  const context = await browser.newContext({ viewport: DESKTOP });
  const page = await context.newPage();
  const external: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "data:" || url.protocol === "blob:") return;
    if (url.host !== new URL(stub.origin).host) external.push(request.url());
  });
  await page.goto(`${stub.origin}/reviews`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  assert.deepEqual(external, [], "the page reached an external host");
  await context.close();
});
