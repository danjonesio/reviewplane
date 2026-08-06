/**
 * Annotated finding capture and named review creation, in a real browser
 * (`docs/TESTING.md` sections 7 and 15, `docs/UX_FLOWS.md` sections 9, 10 and
 * 19, RVP-45).
 *
 * `annotation.browser.test.ts` owns alignment of a **stored** overlay. This
 * suite owns the other half: that a mark a human *draws* lands where they drew
 * it, survives the four changes `AGENTS.md` requires an overlay to survive, and
 * is sent to the control plane as normalised geometry rather than as pixels.
 *
 * The trap here is a suite that proves a form exists. So every case checks the
 * outcome rather than the affordance:
 *
 *   * a drawn mark is measured against the picture, and the picture's own
 *     colour is sampled under it — a mark that drifts lands on the background;
 *   * the request the bundle actually sent is read out of the stub, so a
 *     component that computed the right geometry and sent something else fails;
 *   * the keyboard case places a mark with no pointer at all, and asserts the
 *     geometry it produced, not that a key was accepted.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { chromium, type Browser, type ConsoleMessage, type Page } from "playwright";

import {
  CAPTURE_SCROLL,
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

/** As in the alignment suite: half a per cent of the content rectangle. */
const TOLERANCE = 0.006;

let browser: Browser;
let screenshot: Uint8Array;
const notes: string[] = [];

before(async () => {
  browser = await chromium.launch();
  screenshot = await renderFixtureScreenshot();
  await mkdir(evidenceDirectory, { recursive: true });
});

after(async () => {
  await browser?.close();
  await writeFile(
    join(evidenceDirectory, "capture-evidence.txt"),
    ["ReviewPlane RVP-45 capture evidence", "", ...notes, ""].join("\n"),
    "utf8",
  );
});

/** The same fixture picture the alignment suite uses: 780x1688 device pixels. */
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
       html, body { margin:0; height:100%; background:#0f172a; }
       #marked { position:absolute;
                 left:${String(MARKED_REGION.x * 100)}%;
                 top:${String(MARKED_REGION.y * 100)}%;
                 width:${String(MARKED_REGION.width * 100)}%;
                 height:${String(MARKED_REGION.height * 100)}%;
                 background:${colour}; }
     </style></head><body><div id="marked"></div></body></html>`,
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
  readonly deviceScaleFactor?: number;
  readonly captureFails?: boolean;
  readonly slugInUse?: string;
}

async function open(
  viewport: { width: number; height: number },
  options: OpenOptions = {},
): Promise<Session> {
  const stub = await startStubControlPlane({
    distDirectory,
    frames: [],
    screenshot,
    connectorConnected: true,
    // The workspace is what a review's branch and commit come from, so the
    // capture surface needs one present rather than absent.
    connectorAppearsAfterMs: 0,
    ...(options.captureFails === undefined ? {} : { captureFails: options.captureFails }),
    ...(options.slugInUse === undefined ? {} : { slugInUse: options.slugInUse }),
  });
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: options.deviceScaleFactor ?? 1,
    locale: "en-GB",
    timezoneId: "Europe/London",
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    if (/status of 401/u.test(message.text())) return;
    if (options.captureFails === true && /status of 5\d\d/u.test(message.text())) return;
    if (options.slugInUse !== undefined && /status of 409/u.test(message.text())) return;
    errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error: Error) => {
    errors.push(`page error: ${error.message}`);
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status < 400 || status === 401) return;
    if (options.slugInUse !== undefined && status === 409) return;
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

async function capture(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Open session" }).first().click();
  await page.locator("[data-testid=capture-panel]").waitFor();
  await page.locator("#capture-screenshot").click();
  await page.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>("[data-testid=capture-image]");
    return image !== null && image.complete && image.naturalWidth > 0;
  }, undefined, { timeout: 20_000 });
}

async function evidenceShot(page: Page, name: string): Promise<void> {
  const path = join(evidenceDirectory, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  process.stdout.write(`EVIDENCE screenshot ${path}\n`);
}

/**
 * Drags across the canvas, in the fractions of the *content rectangle* the
 * caller names.
 *
 * The conversion from fraction to client coordinates is done here, from the
 * image's own measured box, rather than by asking the component where to
 * click: a test that used the component's arithmetic to decide where to press
 * would agree with a broken component.
 */
async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  /**
   * A capture of a 390x844 page is more than twice as tall as it is wide, so
   * most of it is below the fold at either viewport. The pointer only reaches
   * what is on screen, so the region is scrolled into view first and the
   * client coordinates are read **after** the scroll — reading them before it
   * would drive the mouse to where the mark used to be.
   */
  const read = async (): Promise<[{ x: number; y: number }, { x: number; y: number }]> =>
    page.evaluate(
      ([a, b]: [{ x: number; y: number }, { x: number; y: number }]) => {
        const image = document.querySelector<HTMLImageElement>("[data-testid=capture-image]");
        if (image === null) throw new Error("no capture image");
        const box = image.getBoundingClientRect();
        const scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
        const width = image.naturalWidth * scale;
        const height = image.naturalHeight * scale;
        const left = box.left + (box.width - width) / 2;
        const top = box.top + (box.height - height) / 2;
        return [
          { x: left + a.x * width, y: top + a.y * height },
          { x: left + b.x * width, y: top + b.y * height },
        ] as [{ x: number; y: number }, { x: number; y: number }];
      },
      [from, to] as [{ x: number; y: number }, { x: number; y: number }],
    );

  const first = await read();
  const midpoint = ((first[0].y + first[1].y) / 2);
  await page.evaluate((offset: number) => {
    globalThis.scrollBy(0, offset);
  }, midpoint - (page.viewportSize()?.height ?? 900) / 2);
  await page.waitForTimeout(80);

  const points = await read();
  const start = points[0];
  const end = points[1];
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 4 });
  await page.mouse.move(end.x, end.y, { steps: 4 });
  await page.mouse.up();
}

interface Alignment {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly colour: { readonly r: number; readonly g: number; readonly b: number };
}

/** Measures a drawn mark against the picture, with the maths recomputed here. */
async function measure(page: Page, index = 0): Promise<Alignment> {
  return page.evaluate((which: number) => {
    const image = document.querySelector<HTMLImageElement>("[data-testid=capture-image]");
    const marks = document.querySelectorAll<HTMLElement>("[data-annotation]");
    const mark = marks[which];
    if (image === null || mark === undefined) throw new Error("the drawn mark is not rendered");

    const box = image.getBoundingClientRect();
    const scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
    const contentWidth = image.naturalWidth * scale;
    const contentHeight = image.naturalHeight * scale;
    const contentLeft = box.left + (box.width - contentWidth) / 2;
    const contentTop = box.top + (box.height - contentHeight) / 2;

    const markBox = mark.getBoundingClientRect();
    const centreX = (markBox.left + markBox.width / 2 - contentLeft) / contentWidth;
    const centreY = (markBox.top + markBox.height / 2 - contentTop) / contentHeight;

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
    };
  }, index);
}

function assertOverMarkedRegion(alignment: Alignment, what: string): void {
  assert.ok(
    Math.abs(alignment.x - MARKED_REGION.x) < TOLERANCE,
    `${what}: x is ${alignment.x.toFixed(4)}, expected ${String(MARKED_REGION.x)}`,
  );
  assert.ok(
    Math.abs(alignment.y - MARKED_REGION.y) < TOLERANCE,
    `${what}: y is ${alignment.y.toFixed(4)}, expected ${String(MARKED_REGION.y)}`,
  );
  assert.ok(
    Math.abs(alignment.width - MARKED_REGION.width) < TOLERANCE,
    `${what}: width is ${alignment.width.toFixed(4)}`,
  );
  // The picture's own colour under the mark. A mark that drifted by a few per
  // cent lands on the dark background instead of the painted band.
  assert.ok(
    Math.abs(alignment.colour.r - MARKED_COLOUR.r) < 12 &&
      Math.abs(alignment.colour.g - MARKED_COLOUR.g) < 12 &&
      Math.abs(alignment.colour.b - MARKED_COLOUR.b) < 12,
    `${what}: the mark sits over rgb(${String(alignment.colour.r)}, ${String(
      alignment.colour.g,
    )}, ${String(alignment.colour.b)}) rather than over the marked region`,
  );
  notes.push(
    `${what}: x=${alignment.x.toFixed(4)} y=${alignment.y.toFixed(4)} w=${alignment.width.toFixed(
      4,
    )} h=${alignment.height.toFixed(4)} colour=rgb(${String(alignment.colour.r)},${String(
      alignment.colour.g,
    )},${String(alignment.colour.b)})`,
  );
}

// ---------------------------------------------------------------------------
// Alignment of a drawn mark, at both viewports and both device pixel ratios
// ---------------------------------------------------------------------------

for (const [name, viewport, dpr] of [
  ["1440x900-dpr1", DESKTOP, 1],
  ["1440x900-dpr2", DESKTOP, 2],
  ["390x844-dpr1", MOBILE, 1],
  ["390x844-dpr2", MOBILE, 2],
] as const) {
  test(`a mark drawn at ${name} lands on the region it was drawn over`, async () => {
    await withSession(viewport, { deviceScaleFactor: dpr }, async (session) => {
      await capture(session.page);
      await drag(
        session.page,
        { x: MARKED_REGION.x, y: MARKED_REGION.y },
        { x: MARKED_REGION.x + MARKED_REGION.width, y: MARKED_REGION.y + MARKED_REGION.height },
      );
      await session.page.locator("[data-annotation]").first().waitFor();
      assertOverMarkedRegion(await measure(session.page), `drawn at ${name}`);
      await evidenceShot(session.page, `capture-${name}`);

      if (viewport === MOBILE) {
        const overflow = await session.page.evaluate(() => ({
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: globalThis.innerWidth,
        }));
        assert.ok(
          overflow.documentWidth <= overflow.viewportWidth + 1,
          `the page scrolls horizontally at 390 px: ${String(overflow.documentWidth)}`,
        );
      }
      assert.deepEqual(session.errors, [], "console errors");
    });
  });
}

test("a drawn mark stays aligned after a window resize, a scroll and a ratio change", async () => {
  await withSession(DESKTOP, {}, async (session) => {
    await capture(session.page);
    await drag(
      session.page,
      { x: MARKED_REGION.x, y: MARKED_REGION.y },
      { x: MARKED_REGION.x + MARKED_REGION.width, y: MARKED_REGION.y + MARKED_REGION.height },
    );
    await session.page.locator("[data-annotation]").first().waitFor();
    assertOverMarkedRegion(await measure(session.page), "before the resize");

    // A window resize. The stage is measured rather than assumed, so a new
    // box produces a new content rectangle and the same normalised geometry.
    await session.page.setViewportSize({ width: 900, height: 780 });
    await session.page.waitForTimeout(120);
    assertOverMarkedRegion(await measure(session.page), "after the window resize");

    // A container resize inside the page, which no window event reports.
    await session.page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>("[data-testid=capture-panel]");
      if (panel !== null) panel.style.width = "360px";
    });
    await session.page.waitForTimeout(160);
    assertOverMarkedRegion(await measure(session.page), "after the container resize");
    await session.page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>("[data-testid=capture-panel]");
      if (panel !== null) panel.style.width = "";
    });
    await session.page.waitForTimeout(160);

    // A scroll. Marks are children of the stage, so they move with the
    // picture rather than being positioned against the viewport.
    await session.page.evaluate(() => {
      globalThis.scrollTo(0, 260);
    });
    await session.page.waitForTimeout(120);
    assertOverMarkedRegion(await measure(session.page), "after the scroll");
    await evidenceShot(session.page, "capture-after-scroll");

    // A device-pixel-ratio change. The ratio never enters the arithmetic, so
    // the overlay is unmoved by it; the raster the browser paints is not.
    await session.page.evaluate(() => {
      globalThis.scrollTo(0, 0);
    });
    const session2 = await open(DESKTOP, { deviceScaleFactor: 3 });
    try {
      await capture(session2.page);
      await drag(
        session2.page,
        { x: MARKED_REGION.x, y: MARKED_REGION.y },
        { x: MARKED_REGION.x + MARKED_REGION.width, y: MARKED_REGION.y + MARKED_REGION.height },
      );
      await session2.page.locator("[data-annotation]").first().waitFor();
      assertOverMarkedRegion(await measure(session2.page), "at a device pixel ratio of 3");
      await evidenceShot(session2.page, "capture-dpr3");
      assert.deepEqual(session2.errors, [], "console errors at ratio 3");
    } finally {
      await session2.close();
    }

    assert.deepEqual(session.errors, [], "console errors");
  });
});

// ---------------------------------------------------------------------------
// Every shape, and the transcript the control plane receives
// ---------------------------------------------------------------------------

test("all six shapes can be drawn, and each is described in the list as text", async () => {
  await withSession(DESKTOP, {}, async (session) => {
    const { page } = session;
    await capture(page);

    const drawn: string[] = [];
    for (const [tool, from, to] of [
      ["rectangle", { x: 0.1, y: 0.1 }, { x: 0.3, y: 0.2 }],
      ["ellipse", { x: 0.4, y: 0.1 }, { x: 0.6, y: 0.2 }],
      ["arrow", { x: 0.1, y: 0.5 }, { x: 0.5, y: 0.6 }],
      ["point", { x: 0.7, y: 0.5 }, { x: 0.7, y: 0.5 }],
      ["numbered_marker", { x: 0.8, y: 0.6 }, { x: 0.8, y: 0.6 }],
      ["freehand", { x: 0.2, y: 0.75 }, { x: 0.6, y: 0.85 }],
    ] as const) {
      await page.locator(`[data-annotation-tool=${tool}]`).click();
      await drag(page, from, to);
      await page.locator(`[data-annotation-type=${tool}]`).first().waitFor();
      drawn.push(tool);
    }

    // Every shape rendered on the canvas.
    for (const tool of drawn) {
      assert.equal(
        await page.locator(`[data-annotation-type=${tool}]`).count(),
        1,
        `${tool} was not drawn`,
      );
    }

    // And every shape present in the list, described rather than depicted.
    const items = await page
      .locator("[data-testid=capture-annotation-list] li")
      .allInnerTexts();
    assert.equal(items.length, 6, `the list holds ${String(items.length)} of six marks`);
    assert.ok(items.some((text) => /rectangle .*% across/u.test(text)), "no rectangle description");
    assert.ok(items.some((text) => /ellipse .*% across/u.test(text)), "no ellipse description");
    assert.ok(items.some((text) => /arrow from .*% across/u.test(text)), "no arrow description");
    assert.ok(items.some((text) => /point at .*% across/u.test(text)), "no point description");
    assert.ok(
      items.some((text) => /numbered marker at .*% across/u.test(text)),
      "no numbered-marker description",
    );
    assert.ok(
      items.some((text) => /freehand stroke of \d+ points/u.test(text)),
      "no freehand description",
    );
    notes.push(`six shapes, as the list states them:\n  ${items.join("\n  ")}`);
    await evidenceShot(page, "capture-annotation-list");
    assert.deepEqual(session.errors, [], "console errors");
  });
});

test("the request the control plane receives carries normalised geometry and the captured context", async () => {
  await withSession(DESKTOP, {}, async (session) => {
    const { page } = session;
    await capture(page);
    await drag(
      page,
      { x: MARKED_REGION.x, y: MARKED_REGION.y },
      { x: MARKED_REGION.x + MARKED_REGION.width, y: MARKED_REGION.y + MARKED_REGION.height },
    );
    await page.locator("[data-annotation]").first().waitFor();

    await page.locator("#finding-title").fill("Hero heading overlaps the basket button");
    await page.locator("#finding-comment").fill("At 390x844 the heading wraps onto the button.");
    await page.locator("#finding-severity").selectOption("high");
    await page.locator("#save-draft-finding").click();
    await page.locator("[data-testid=draft-findings]").waitFor();

    await page.locator("#review-title").fill("Bugs on homepage");
    await page.locator("#review-mark-ready").click();
    await page.locator("[data-testid=review-created]").waitFor();

    const findingRequest = session.stub.requests.find((entry) =>
      /\/findings$/u.test(entry.path),
    );
    assert.ok(findingRequest !== undefined, "no finding was sent to the control plane");
    const body = findingRequest.body as Record<string, unknown>;

    // Every field of the `docs/UX_FLOWS.md` §9 captured-context list.
    assert.equal(body["screenshot_artefact_id"], "art_ui_suite_measured");
    assert.deepEqual(body["viewport"], CAPTURE_VIEWPORT);
    // The offset the worker measured, not a hard-coded origin. The fixture
    // page is scrolled, so a flow that discarded this would send {0, 0} here
    // and would resolve the element below to the header at the top of the
    // document instead of to the navigation the mark actually covers.
    assert.deepEqual(
      body["scroll_position"],
      CAPTURE_SCROLL,
      "the finding recorded a scroll offset the capture did not have",
    );
    assert.equal(typeof body["url"], "string");
    assert.match(String(body["captured_commit"]), /^[0-9a-f]{7,64}$/u);

    const annotations = body["annotations"] as { type: string; geometry: Record<string, number> }[];
    assert.equal(annotations.length, 1);
    const geometry = annotations[0]?.geometry as Record<string, number>;
    // Normalised, not pixels. A component that sent CSS pixels would send
    // numbers in the hundreds here.
    for (const [member, value] of Object.entries(geometry)) {
      assert.ok(
        value >= 0 && value <= 1,
        `geometry.${member} is ${String(value)}, which is not normalised`,
      );
    }
    assert.ok(Math.abs((geometry["x"] ?? -1) - MARKED_REGION.x) < TOLERANCE, "geometry.x");
    assert.ok(Math.abs((geometry["y"] ?? -1) - MARKED_REGION.y) < TOLERANCE, "geometry.y");
    assert.ok(
      Math.abs((geometry["width"] ?? -1) - MARKED_REGION.width) < TOLERANCE,
      "geometry.width",
    );

    // No `source`: it is derived from the authenticated actor.
    assert.equal(body["source"], undefined, "the page sent a source claim");

    // The element context the snapshot resolved: the smallest containing
    // element rather than the document, and resolved in the frame the capture
    // was actually taken in. The header sits at the top of the *document*, so
    // it is what a flow that dropped the scroll offset would name here.
    const context = body["element_context"] as Record<string, unknown> | undefined;
    assert.deepEqual(
      context?.["selector"],
      "[data-testid=main-navigation]",
      `element context resolved to ${JSON.stringify(context)}`,
    );
    assert.deepEqual(context?.["text_excerpt"], "Shop Sell About");

    const reviewRequest = session.stub.requests.find((entry) => /\/reviews$/u.test(entry.path));
    assert.ok(reviewRequest !== undefined, "no review was created");
    assert.ok(
      (reviewRequest.idempotencyKey ?? "") !== "",
      "the review was created without an idempotency key, so a double submit would create two",
    );

    notes.push(
      `API transcript:\n${session.stub.requests
        .map((entry) => `  ${entry.method} ${entry.path} ${JSON.stringify(entry.body)}`)
        .join("\n")}`,
    );
    assert.deepEqual(session.errors, [], "console errors");
  });
});

// ---------------------------------------------------------------------------
// Keyboard, and the non-canvas alternative
// ---------------------------------------------------------------------------

test("a finding can be created by keyboard alone, with visible focus throughout", async () => {
  await withSession(DESKTOP, {}, async (session) => {
    const { page } = session;
    await capture(page);

    // Reach the toolbar by tabbing, never by focus(): `:focus-visible` is what
    // draws the ring, and it only matches keyboard interaction.
    let reached = false;
    for (let press = 0; press < 60 && !reached; press += 1) {
      await page.keyboard.press("Tab");
      reached =
        (await page.evaluate(
          () => document.activeElement?.getAttribute("data-annotation-tool") ?? null,
        )) === "rectangle";
    }
    assert.ok(reached, "the rectangle tool is not reachable by Tab");

    const outline = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (element === null) return "";
      const style = globalThis.getComputedStyle(element);
      return `${style.outlineStyle} ${style.outlineWidth}`;
    });
    assert.notEqual(outline.split(" ")[0], "none", `focus is visible: ${outline}`);
    await evidenceShot(page, "capture-keyboard-focus");

    await page.keyboard.press("Enter");
    assert.equal(
      await page.locator("[data-annotation-tool=rectangle]").getAttribute("aria-pressed"),
      "true",
    );

    // Tab on to the canvas itself and place a mark with the arrow keys.
    let onCanvas = false;
    for (let press = 0; press < 20 && !onCanvas; press += 1) {
      await page.keyboard.press("Tab");
      onCanvas =
        (await page.evaluate(
          () => document.activeElement?.getAttribute("data-testid") ?? null,
        )) === "annotation-canvas";
    }
    assert.ok(onCanvas, "the canvas is not reachable by Tab");

    // From the centre (50%, 50%), five presses left and right of the coarse
    // 2% step put the first corner at 40%, 40% and the second at 50%, 50%.
    for (let press = 0; press < 5; press += 1) await page.keyboard.press("ArrowLeft");
    for (let press = 0; press < 5; press += 1) await page.keyboard.press("ArrowUp");
    const position = await page.locator("[data-testid=annotation-cursor-position]").innerText();
    assert.match(position, /40% across, 40% down/u, `cursor position reads: ${position}`);
    await page.keyboard.press("Enter");
    for (let press = 0; press < 5; press += 1) await page.keyboard.press("ArrowRight");
    for (let press = 0; press < 5; press += 1) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    await page.locator("[data-annotation-type=rectangle]").first().waitFor();
    const listed = await page.locator("[data-testid=capture-annotation-list] li").innerText();
    assert.match(
      listed,
      /rectangle at 40% across, 40% down, 10% wide and 10% tall/u,
      `the keyboard-placed mark reads: ${listed}`,
    );
    notes.push(`keyboard-placed mark: ${listed}`);

    // And on through the form to a saved draft, still without a pointer.
    await page.locator("#finding-title").fill("Placed without a pointer");
    await page.locator("#save-draft-finding").click();
    await page.locator("[data-testid=draft-findings]").waitFor();
    assert.match(
      await page.locator("[data-testid=draft-findings]").innerText(),
      /Placed without a pointer/u,
    );
    await evidenceShot(page, "capture-keyboard-draft");
    assert.deepEqual(session.errors, [], "console errors");
  });
});

test("the annotation list is a complete alternative and can remove a mark", async () => {
  await withSession(MOBILE, {}, async (session) => {
    const { page } = session;
    await capture(page);
    await drag(page, { x: 0.1, y: 0.1 }, { x: 0.3, y: 0.2 });
    await drag(page, { x: 0.4, y: 0.4 }, { x: 0.6, y: 0.5 });
    await page.locator("[data-testid=capture-annotation-list]").waitFor();
    assert.equal(await page.locator("[data-testid=capture-annotation-list] li").count(), 2);

    // The list conveys position, not just existence.
    const first = await page
      .locator("[data-testid=capture-annotation-list] li")
      .first()
      .innerText();
    assert.match(first, /10% across, 10% down, 20% wide and 10% tall/u, first);

    // Selecting in the list selects on the canvas: one selection, two views.
    await page.locator("[data-annotation-item]").first().click();
    assert.equal(
      await page.locator("[data-annotation-item]").first().getAttribute("aria-pressed"),
      "true",
    );

    await page.locator("[data-annotation-remove]").first().click();
    assert.equal(await page.locator("[data-testid=capture-annotation-list] li").count(), 1);
    assert.equal(await page.locator("[data-annotation]").count(), 1);
    await evidenceShot(page, "capture-list-alternative-390x844");
    assert.deepEqual(session.errors, [], "console errors");
  });
});

// ---------------------------------------------------------------------------
// The named review, its command, and the two refusals
// ---------------------------------------------------------------------------

for (const [name, viewport] of [
  ["1440x900", DESKTOP],
  ["390x844", MOBILE],
] as const) {
  test(`the review form offers a copyable command and claims no injection at ${name}`, async () => {
    await withSession(viewport, {}, async (session) => {
      const { page } = session;
      await capture(page);
      await drag(page, { x: 0.2, y: 0.2 }, { x: 0.4, y: 0.3 });
      await page.locator("#finding-title").fill("Hero heading overlaps the basket button");
      await page.locator("#save-draft-finding").click();
      await page.locator("[data-testid=create-review-form]").waitFor();

      await page.locator("#review-title").fill("Bugs on homepage");
      await page.locator("#review-priority").selectOption("high");
      await page
        .locator("#review-instruction")
        .fill("Fix these before continuing with the product page.");

      // The slug preview is the durable handle, and the command quotes it in
      // the documented form.
      assert.equal(await page.locator("#review-slug").getAttribute("placeholder"), "bugs-on-homepage");
      assert.equal(
        await page.locator("[data-testid=review-cli-command]").innerText(),
        'Review and resolve control-plane review "bugs-on-homepage".',
      );

      // §11 forbids a claim that the control plane typed into a terminal, and
      // only an affirmative sentence can be tested for.
      assert.match(
        await page.locator("[data-testid=no-terminal-injection]").innerText(),
        /does not type into an agent's terminal/u,
      );
      await evidenceShot(page, `capture-review-form-${name}`);

      if (viewport === MOBILE) {
        const overflow = await page.evaluate(() => ({
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: globalThis.innerWidth,
        }));
        assert.ok(
          overflow.documentWidth <= overflow.viewportWidth + 1,
          `the page scrolls horizontally at 390 px: ${String(overflow.documentWidth)}`,
        );
      }
      assert.deepEqual(session.errors, [], "console errors");
    });
  });
}

test("a capture whose evidence never completed says so and creates no draft", async () => {
  await withSession(DESKTOP, { captureFails: true }, async (session) => {
    const { page } = session;
    await page.getByRole("link", { name: "Open session" }).first().click();
    await page.locator("[data-testid=capture-panel]").waitFor();
    await page.locator("#capture-screenshot").click();

    const refusal = page.locator('[data-failure="ARTEFACT_UPLOAD_INCOMPLETE"]');
    await refusal.waitFor();
    assert.match(await refusal.innerText(), /Evidence upload incomplete/u);

    // No canvas, no form, no draft: a finding is never silently created
    // without its evidence.
    assert.equal(await page.locator("[data-testid=annotation-canvas]").count(), 0);
    assert.equal(await page.locator("[data-testid=draft-finding-form]").count(), 0);
    assert.equal(await page.locator("[data-testid=draft-findings]").count(), 0);
    await evidenceShot(page, "capture-evidence-incomplete");
    notes.push(`evidence upload incomplete: ${await refusal.innerText()}`);
  });
});

test("a slug already in use is refused with a message the reader can act on", async () => {
  await withSession(DESKTOP, { slugInUse: "bugs-on-homepage" }, async (session) => {
    const { page } = session;
    await capture(page);
    await drag(page, { x: 0.2, y: 0.2 }, { x: 0.4, y: 0.3 });
    await page.locator("#finding-title").fill("Hero heading overlaps the basket button");
    await page.locator("#save-draft-finding").click();
    await page.locator("[data-testid=create-review-form]").waitFor();
    await page.locator("#review-title").fill("Bugs on homepage");
    await page.locator("#review-mark-ready").click();

    const refusal = page.locator('[data-failure="IDEMPOTENCY_CONFLICT"]');
    await refusal.waitFor();
    const text = await refusal.innerText();
    assert.match(text, /already in use/u);
    assert.match(text, /Choose a different slug/u, "the refusal names no action");

    // The drafts survive the refusal: a collision is a rename, not a loss.
    assert.equal(await page.locator("[data-draft-finding]").count(), 1);
    await evidenceShot(page, "capture-slug-collision");
    notes.push(`slug collision: ${text.replace(/\n/gu, " ")}`);
  });
});

test("draft findings are recovered after a reload rather than silently lost", async () => {
  await withSession(DESKTOP, {}, async (session) => {
    const { page } = session;
    await capture(page);
    await drag(page, { x: 0.2, y: 0.2 }, { x: 0.4, y: 0.3 });
    await page.locator("#finding-title").fill("Survives a reload");
    await page.locator("#save-draft-finding").click();
    await page.locator("[data-testid=draft-findings]").waitFor();

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("[data-testid=draft-findings]").waitFor();
    assert.match(
      await page.locator("[data-testid=draft-findings]").innerText(),
      /Survives a reload/u,
      "a draft finding was lost on reload",
    );
    // And it still says plainly that nothing has been saved.
    assert.match(
      await page.locator("[data-testid=draft-findings]").innerText(),
      /has been saved to the control plane yet/u,
    );
    assert.deepEqual(session.errors, [], "console errors");
  });
});
