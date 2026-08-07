/**
 * The review workspace in a real browser (`docs/UX_FLOWS.md` §12, §13, §16,
 * §19 and §20; `docs/TESTING.md` §15; RVP-55).
 *
 * This suite owns the half of the product's central invariant that no server
 * test can reach. `apps/server/test/accept-evidence-integrity.test.ts` proves
 * that the control plane refuses an accept carrying a superseded claim; what it
 * says it cannot prove is that a **client** sends the claim it rendered rather
 * than one it fetched when the button was pressed. That is the whole of RVP-89,
 * and the case below is the only place it is observable: the comparison is
 * opened, an agent supersedes the evidence underneath it, Accept is pressed,
 * and the request the browser actually sent is read out of the stub's
 * transcript.
 *
 * Three further properties are asserted against the **rendered DOM** rather
 * than against component source, because each of them has a source-level shape
 * that looks correct and is not:
 *
 *   * **The §13 assurance split.** Two arrays rendered through one list with
 *     one marker satisfies any reading of the source. The assertions below take
 *     the two groups apart by their accessible text, so a merged list fails.
 *   * **An agent's summary rendering inert.** A page that stripped the markup
 *     would show no element and look safe while having changed what was stored.
 *     Both halves are asserted: the characters are visible, and the element the
 *     markup names never exists.
 *   * **Statuses readable without colour.** The word and its meaning are read
 *     out of the badge's text.
 *
 * Every case runs at 1440x900 and 390x844, `docs/UX_FLOWS.md` §20 requiring
 * accepting findings to work on a phone, and every case ends by asserting that
 * the page logged no console error and made no failed request.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { chromium, type Browser, type ConsoleMessage, type Page, type Request } from "playwright";

import {
  AGENT_SUMMARY_WITH_MARKUP,
  ASSERTED_BY_AGENT,
  CAPTURE_VIEWPORT,
  UI_SUITE_EMAIL,
  UI_SUITE_PASSWORD,
  VERIFIED_BY_CONTROL_PLANE,
  startStubControlPlane,
  type StubControlPlane,
} from "./stub-control-plane.ts";

const here = dirname(fileURLToPath(import.meta.url));
const distDirectory = join(here, "..", "..", "dist");
const evidenceDirectory = join(here, "..", "..", "test-results");

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const VIEWPORTS = [
  ["1440x900", DESKTOP],
  ["390x844", MOBILE],
] as const;

const HERO_FINDING = "fin_ui_suite_hero";
const SEEDED_CLAIM = "ver_ui_suite";

/**
 * The console line Chromium writes for a refusal the workspace produces on
 * purpose: `VERSION_CONFLICT` (409) and `EVIDENCE_REQUIRED` or `POLICY_DENIED`
 * (422). Nothing else is excused.
 */
const EXPECTED_REFUSAL_LOG =
  /Failed to load resource: the server responded with a status of (?:409|422)\b/u;

let browser: Browser;
let stub: StubControlPlane;
const evidence: string[] = [];

before(async () => {
  browser = await chromium.launch();
  stub = await startStubControlPlane({
    distDirectory,
    frames: [],
    screenshot: await renderCapture("#0f172a", "#f97316"),
    afterScreenshot: await renderCapture("#052e16", "#22c55e"),
  });
  await mkdir(evidenceDirectory, { recursive: true });
});

after(async () => {
  await stub?.stop();
  await browser?.close();
  await writeFile(
    join(evidenceDirectory, "review-workspace-evidence.txt"),
    ["ReviewPlane RVP-55 review workspace evidence", "", ...evidence, ""].join("\n"),
    "utf8",
  );
});

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

async function signIn(viewport: { width: number; height: number }): Promise<Session> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    // Chromium logs a console entry for every non-2xx fetch, so a refusal this
    // workspace exists to produce and recover from arrives here as an "error"
    // that is not one. The two statuses are named rather than a blanket filter
    // applied, so a 500 or a 404 still fails the case; and each refusal is
    // separately asserted where it happens, so suppressing the log line here
    // cannot hide one that did not occur.
    if (EXPECTED_REFUSAL_LOG.test(message.text())) return;
    errors.push(message.text());
  });
  page.on("pageerror", (error: Error) => {
    errors.push(error.message);
  });
  page.on("requestfailed", (request: Request) => {
    failedRequests.push(`${request.method()} ${request.url()}`);
  });
  page.on("response", (response) => {
    // A 409 or a 422 is a refusal the workspace is supposed to produce, and it
    // is asserted where it happens. Anything else at 400 or above is a defect.
    const status = response.status();
    if (status >= 400 && status !== 409 && status !== 422) {
      failedRequests.push(`${String(status)} ${response.url()}`);
    }
  });

  await page.goto(stub.origin, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email address").fill(UI_SUITE_EMAIL);
  await page.getByLabel("Password").fill(UI_SUITE_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: "Live sessions" }).waitFor();
  // The signed-out probe on the first paint is expected.
  errors.length = 0;
  failedRequests.length = 0;

  return {
    page,
    errors,
    failedRequests,
    async close(): Promise<void> {
      await context.close();
    },
  };
}

/** Reviews -> the review -> the finding awaiting a human decision. */
async function openFinding(viewport: { width: number; height: number }): Promise<Session> {
  const session = await signIn(viewport);
  await session.page.getByRole("link", { name: "Reviews" }).click();
  await session.page.getByRole("heading", { name: "Reviews", exact: true }).waitFor();
  await session.page.getByRole("link", { name: "Open review" }).first().click();
  await session.page.getByRole("heading", { name: "Bugs on homepage" }).waitFor();
  await session.page.getByRole("link", { name: "Open finding" }).first().click();
  await session.page
    .getByRole("heading", { name: "Hero heading overlaps the basket button" })
    .waitFor();
  await session.page.locator(`[data-verification-panel='${HERO_FINDING}']`).waitFor();
  await session.page.locator(`[data-agent-summary='${HERO_FINDING}']`).waitFor();
  return session;
}

function clean(session: Session, where: string): void {
  assert.deepEqual(session.errors, [], `console errors at ${where}`);
  assert.deepEqual(session.failedRequests, [], `failed network requests at ${where}`);
}

async function shot(page: Page, name: string): Promise<void> {
  const file = join(evidenceDirectory, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  evidence.push(`screenshot ${file}`);
  process.stdout.write(`EVIDENCE screenshot ${file}\n`);
}

/** Tabs until the element carrying this attribute has focus. */
async function tabTo(page: Page, attribute: string, value: string, limit = 120): Promise<boolean> {
  for (let step = 0; step < limit; step += 1) {
    await page.keyboard.press("Tab");
    const found = await page.evaluate(
      ([name, wanted]) => document.activeElement?.getAttribute(name as string) === wanted,
      [attribute, value],
    );
    if (found) return true;
  }
  return false;
}

// ---------------------------------------------------------------- rendering

for (const [name, viewport] of VIEWPORTS) {
  test(`the review list finds a review by name, status and branch at ${name}`, async () => {
    const session = await signIn(viewport);
    try {
      await session.page.getByRole("link", { name: "Reviews" }).click();
      await session.page.getByRole("heading", { name: "Reviews", exact: true }).waitFor();
      await session.page.locator("[data-review='rev_ui_suite_bugs']").waitFor();

      // Every dimension `docs/UX_FLOWS.md` §16 names has a control, and the
      // terms reach the control plane rather than being applied in the page.
      for (const dimension of ["q", "status", "severity", "branch", "commit", "created_since"]) {
        assert.equal(
          await session.page.locator(`[data-review-filter='${dimension}']`).count(),
          1,
          `a control exists for ${dimension}`,
        );
      }

      await session.page.locator("[data-review-filter='q']").fill("basket");
      await session.page.waitForFunction(() =>
        (globalThis as unknown as { performance: Performance }).performance
          .getEntriesByType("resource")
          .some((entry) => entry.name.includes("q=basket")),
      );
      const sent = await session.page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .filter((url) => url.includes("/reviews?")),
      );
      assert.ok(
        sent.some((url) => url.includes("q=basket")),
        `the term went to the control plane: ${sent.join(", ")}`,
      );

      await session.page.locator("[data-review-filter='q']").fill("");
      await session.page.locator("[data-review-filter='status']").selectOption("READY");
      await session.page.locator("[data-review-filter='branch']").fill("feat/homepage-refresh");
      await session.page.waitForFunction(() =>
        performance
          .getEntriesByType("resource")
          .some((entry) => entry.name.includes("branch=feat")),
      );

      // The status is a word beside its badge and never a colour alone.
      const badge = await session.page
        .locator("[data-review='rev_ui_suite_bugs']")
        .locator("text=READY")
        .first()
        .textContent();
      assert.ok((badge ?? "").includes("READY"), `the status word is on screen: ${String(badge)}`);

      await shot(session.page, `review-list-${name}`);
      clean(session, `the review list at ${name}`);
    } finally {
      await session.close();
    }
  });

  test(`the finding card and the verification comparison render at ${name}`, async () => {
    const session = await openFinding(viewport);
    const page = session.page;
    try {
      // §12: the captured context that makes a finding reproducible.
      assert.match(
        (await page.locator(`[data-finding-url='${HERO_FINDING}']`).textContent()) ?? "",
        /route-ui-suite\.internal\.invalid/u,
      );
      assert.match(
        (await page.locator(`[data-finding-viewport='${HERO_FINDING}']`).textContent()) ?? "",
        /390x844/u,
      );
      assert.match(
        (await page.locator(`[data-finding-commit='${HERO_FINDING}']`).textContent()) ?? "",
        /^4a45b94f1c2d$/u,
      );
      assert.equal(
        await page.locator(`[data-finding-source='${HERO_FINDING}']`).textContent(),
        "a human",
      );
      // The position §14 reserves, with no verdict computed.
      assert.match(
        (await page.locator(`[data-staleness='${HERO_FINDING}']`).textContent()) ?? "",
        /does not yet compute/u,
      );

      // §12: statuses readable, never colour alone. The one that matters is
      // that a request for review is not read as an acceptance.
      const statusText = (await page.locator("h1 ~ div").first().textContent()) ?? "";
      assert.match(statusText, /AWAITING_HUMAN_REVIEW/u);
      assert.match(statusText, /has requested review — not accepted/u);

      // §13: the before and after pair, from the pinned claim.
      await page.waitForFunction(() => {
        const image = document.querySelector<HTMLImageElement>("[data-testid=artefact-image]");
        return image !== null && image.complete && image.naturalWidth > 0;
      }, undefined, { timeout: 20_000 });
      assert.equal(await page.locator("[data-testid=artefact-compare-image]").count(), 1);
      assert.equal(await page.locator("[data-testid=artefact-compare-slider]").count(), 1);
      assert.match(
        (await page.locator(`[data-verification-id='${HERO_FINDING}']`).textContent()) ?? "",
        new RegExp(SEEDED_CLAIM, "u"),
      );

      // §13: the viewports the claim covers.
      const viewports =
        (await page.locator(`[data-verified-viewports='${HERO_FINDING}']`).textContent()) ?? "";
      assert.match(viewports, /390x844/u);
      assert.match(viewports, /1440x900/u);

      await shot(page, `finding-detail-${name}`);
      clean(session, `the finding card at ${name}`);
    } finally {
      await session.close();
    }
  });

  test(`the two assurance groups are two groups in the rendered DOM at ${name}`, async () => {
    const session = await openFinding(viewport);
    const page = session.page;
    try {
      const verified = page.locator("[data-assurance='verified']");
      const asserted = page.locator("[data-assurance='asserted']");
      assert.equal(await verified.count(), 1, "one control-plane group");
      assert.equal(await asserted.count(), 1, "one agent-assertion group");

      const verifiedText = (await verified.textContent()) ?? "";
      const assertedText = (await asserted.textContent()) ?? "";

      // The headings say who established what, in the words §13 requires.
      assert.match(verifiedText, /Verified by the control plane/u);
      assert.match(assertedText, /Asserted by the agent \(claude-code\), not confirmed/u);

      // Every member is in exactly one group, and never in the other. This is
      // the assertion two arrays rendered through one list would fail.
      for (const label of VERIFIED_BY_CONTROL_PLANE) {
        assert.ok(verifiedText.includes(label), `"${label}" is a control-plane check`);
        assert.ok(!assertedText.includes(label), `"${label}" is not an agent assertion`);
      }
      for (const label of ASSERTED_BY_AGENT) {
        assert.ok(assertedText.includes(label), `"${label}" is an agent assertion`);
        assert.ok(!verifiedText.includes(label), `"${label}" is not a control-plane check`);
      }

      // A screen reader hears the distinction, not only sees it: the marker is
      // a glyph and the words beside it say which kind of statement it is.
      const verifiedRows = await page
        .locator("[data-assurance-item='verified'] .visually-hidden")
        .allTextContents();
      const assertedRows = await page
        .locator("[data-assurance-item='asserted'] .visually-hidden")
        .allTextContents();
      assert.equal(verifiedRows.length, VERIFIED_BY_CONTROL_PLANE.length);
      assert.equal(assertedRows.length, ASSERTED_BY_AGENT.length);
      assert.ok(verifiedRows.every((row) => row.startsWith("Verified by the control plane")));
      assert.ok(assertedRows.every((row) => row.startsWith("Asserted, not confirmed")));
      // And the two announcements are different, which is the property a merged
      // list would break while still rendering two arrays.
      assert.notEqual(verifiedRows[0], assertedRows[0]);

      await shot(page, `assurance-split-${name}`);
      clean(session, `the assurance split at ${name}`);
    } finally {
      await session.close();
    }
  });

  test(`an agent summary carrying markup renders inert at ${name}`, async () => {
    const session = await openFinding(viewport);
    const page = session.page;
    try {
      const summary =
        (await page.locator(`[data-agent-summary='${HERO_FINDING}']`).textContent()) ?? "";
      // The characters are on screen: stored byte for byte, rendered as text.
      assert.equal(summary, AGENT_SUMMARY_WITH_MARKUP);
      // And nothing executed. The element the markup names never exists, and
      // the global its handler would have set is absent.
      assert.equal(
        await page.locator(`[data-agent-summary='${HERO_FINDING}'] img`).count(),
        0,
        "the markup did not become an element",
      );
      assert.equal(
        await page.evaluate(
          () => (globalThis as unknown as Record<string, unknown>)["__reviewplane_pwned"],
        ),
        undefined,
        "the handler did not run",
      );
      clean(session, `the agent summary at ${name}`);
    } finally {
      await session.close();
    }
  });
}

// -------------------------------------------------------- the decision path

for (const [name, viewport] of VIEWPORTS) {
  test(`a human accepts a finding at ${name}`, async () => {
    const session = await openFinding(viewport);
    const page = session.page;
    try {
      // The controls come from the shared transition table, so a finding
      // awaiting a human offers exactly the three human dispositions.
      for (const decision of ["accept", "reopen", "wont-fix"]) {
        assert.equal(
          await page.locator(`[data-decision='${decision}']`).count(),
          1,
          `${decision} is offered`,
        );
      }

      await page.locator("[data-decision='accept']").click();
      // The two values the decision will carry are stated before it is sent.
      const inputs =
        (await page.locator(`[data-decision-inputs='${HERO_FINDING}']`).textContent()) ?? "";
      assert.match(inputs, new RegExp(SEEDED_CLAIM, "u"));

      await page.locator(`[data-decision-submit='${HERO_FINDING}']`).click();
      await page.waitForFunction(
        () =>
          document.querySelector("[data-finding-source]") !== null &&
          (document.body.textContent ?? "").includes("RESOLVED"),
        undefined,
        { timeout: 15_000 },
      );

      assert.equal(stub.findingStatus(HERO_FINDING), "RESOLVED");
      // The claim carries the decision, which is what names the evidence a
      // human accepted (ADR-0035, RVP-93).
      assert.equal(stub.verificationStatus(HERO_FINDING, SEEDED_CLAIM), "accepted");

      const sent = stub.requests.filter((entry) =>
        entry.path.endsWith(`/findings/${HERO_FINDING}/accept`),
      );
      assert.equal(sent.length, 1, "one accept was sent");
      const body = sent[0]?.body as { verification_id?: string; expected_version?: number };
      assert.equal(body.verification_id, SEEDED_CLAIM, "the accept named the claim rendered");
      assert.equal(body.expected_version, 1, "the accept carried the version rendered");
      // The identifier the panel was comparing, read off the page rather than
      // assumed: a decision must name what the reader was looking at, and the
      // two values are derived independently in the component tree.
      assert.match(inputs, new RegExp(SEEDED_CLAIM, "u"));

      evidence.push(`accept at ${name}: ${JSON.stringify(body)}`);
      await shot(page, `accept-${name}`);
      clean(session, `the accept at ${name}`);
    } finally {
      await session.close();
      await resetStub();
    }
  });

  test(`a human reopens a finding, and the reason is required at ${name}`, async () => {
    const session = await openFinding(viewport);
    const page = session.page;
    try {
      await page.locator("[data-decision='reopen']").click();
      // The form asks before the request rather than after the refusal
      // (ADR-0036), and it will not send an empty statement.
      assert.equal(
        await page.locator(`[data-decision-reason-missing='${HERO_FINDING}']`).count(),
        1,
      );
      assert.equal(
        await page.locator(`[data-decision-submit='${HERO_FINDING}']`).isDisabled(),
        true,
        "a reopen with nothing said cannot be sent",
      );

      await page
        .locator(`[data-decision-reason='${HERO_FINDING}']`)
        .fill("Still overlaps at 390px; the breakpoint moved the wrong way.");
      await page.locator(`[data-decision-submit='${HERO_FINDING}']`).click();
      await page.waitForFunction(
        () => (document.body.textContent ?? "").includes("REOPENED"),
        undefined,
        { timeout: 15_000 },
      );

      assert.equal(stub.findingStatus(HERO_FINDING), "REOPENED");
      assert.equal(stub.verificationStatus(HERO_FINDING, SEEDED_CLAIM), "rejected");

      // The reason is in the discussion, where the agent reads it, and not
      // only in an event payload.
      await page.waitForFunction(
        () =>
          (document.body.textContent ?? "").includes(
            "Still overlaps at 390px; the breakpoint moved the wrong way.",
          ),
        undefined,
        { timeout: 15_000 },
      );
      const comment = page.locator("[data-comment-author='human_user']").first();
      assert.match((await comment.textContent()) ?? "", /Still overlaps at 390px/u);

      await shot(page, `reopen-${name}`);
      clean(session, `the reopen at ${name}`);
    } finally {
      await session.close();
      await resetStub();
    }
  });
}

// --------------------------------------------------------------- RVP-89
//
// The case this suite exists for, and the one the server suite says it cannot
// reach.

test("evidence swapped under an open comparison cannot be accepted", async () => {
  const session = await openFinding(DESKTOP);
  const page = session.page;
  try {
    // The reviewer is looking at the seeded claim.
    assert.match(
      (await page.locator(`[data-verification-id='${HERO_FINDING}']`).textContent()) ?? "",
      new RegExp(SEEDED_CLAIM, "u"),
    );
    await page.locator("[data-decision='accept']").click();

    // The agent replaces the evidence while the comparison is open.
    const swapped = stub.supersedeEvidence(HERO_FINDING);
    evidence.push(`evidence superseded under an open comparison: ${SEEDED_CLAIM} -> ${swapped}`);

    // The reviewer presses Accept.
    await page.locator(`[data-decision-submit='${HERO_FINDING}']`).click();
    await page.locator("[data-refusal='VERSION_CONFLICT']").waitFor({ timeout: 15_000 });

    // Nothing was accepted, and the claim the reviewer never saw was not
    // decided either.
    assert.equal(stub.findingStatus(HERO_FINDING), "AWAITING_HUMAN_REVIEW");
    assert.equal(stub.verificationStatus(HERO_FINDING, SEEDED_CLAIM), "superseded");
    assert.equal(stub.verificationStatus(HERO_FINDING, swapped), "submitted");

    // The proof: the request the browser sent named the claim it had rendered,
    // not the one that had just replaced it. A client that re-read the finding
    // when the button was pressed would have sent `swapped` here and the
    // control plane would have accepted it.
    const sent = stub.requests.filter((entry) =>
      entry.path.endsWith(`/findings/${HERO_FINDING}/accept`),
    );
    assert.equal(sent.length, 1);
    const body = sent[0]?.body as { verification_id?: string; expected_version?: number };
    assert.equal(body.verification_id, SEEDED_CLAIM, "the client sent what it rendered");
    assert.notEqual(body.verification_id, swapped, "the client did not refetch");
    assert.equal(body.expected_version, 1, "the version was the rendered one, not the refetched one");
    evidence.push(`accept after the swap sent: ${JSON.stringify(body)}`);

    // The recovery path is named, and it is a reload rather than a retry.
    const refusal = (await page.locator("[data-refusal='VERSION_CONFLICT']").textContent()) ?? "";
    assert.match(refusal, /changed while you were reading it/u);
    assert.match(refusal, /nothing was written/iu);
    assert.equal(await page.locator(`[data-decision-reload='${HERO_FINDING}']`).count(), 1);
    assert.equal(
      await page.locator(`[data-decision-submit='${HERO_FINDING}']`).isDisabled(),
      true,
      "a conflicted decision cannot be resent without reloading",
    );

    await shot(page, "version-conflict-recovery");

    // Reloading shows the claim that is actually current, so the reviewer
    // reads the new evidence before deciding again.
    await page.locator(`[data-decision-reload='${HERO_FINDING}']`).click();
    await page.waitForFunction(
      (identifier) =>
        (document.querySelector("[data-verification-id]")?.textContent ?? "").includes(
          identifier as string,
        ),
      swapped,
      { timeout: 15_000 },
    );

    clean(session, "the version-conflict recovery");
  } finally {
    await session.close();
    await resetStub();
  }
});

test("every claim a finding has accumulated is reachable", async () => {
  // `docs/DOMAIN_MODEL.md` §19: a repeatedly-reopened finding must not read as
  // a first attempt.
  const swapped = stub.supersedeEvidence(HERO_FINDING);
  const session = await openFinding(DESKTOP);
  const page = session.page;
  try {
    await page.locator(`[data-verification-history='${HERO_FINDING}']`).waitFor();
    assert.equal(await page.locator(`[data-verification-item='${SEEDED_CLAIM}']`).count(), 1);
    assert.equal(await page.locator(`[data-verification-item='${swapped}']`).count(), 1);

    // The superseded record says so in words, not by position.
    const earlier =
      (await page.locator(`[data-verification-item='${SEEDED_CLAIM}']`).textContent()) ?? "";
    assert.match(earlier, /superseded/u);
    assert.match(earlier, /replaced by a later claim/u);

    // Selecting the earlier claim renders its comparison, so "reachable" means
    // reachable rather than listed.
    await page.locator(`[data-verification-item='${SEEDED_CLAIM}']`).click();
    await page.waitForFunction(
      (identifier) =>
        (document.querySelector("[data-verification-id]")?.textContent ?? "").includes(
          identifier as string,
        ),
      SEEDED_CLAIM,
      { timeout: 15_000 },
    );
    assert.match(
      (await page.locator(`[data-verification-id='${HERO_FINDING}']`).textContent()) ?? "",
      /no longer the current one/u,
    );

    // And no decision can be taken from here. This is the assertion the first
    // version of this suite stopped one step short of, and the gap it left was
    // real: the panel said "no decision can be taken on it" while the Accept
    // button stayed live and decided the *other* claim — a reviewer's name on
    // evidence they had not read, which is RVP-89's harm reached from the
    // client rather than by an agent's write.
    await page.locator(`[data-decisions-withheld='${HERO_FINDING}']`).waitFor();
    assert.equal(
      await page.locator("[data-decision='accept']").count(),
      0,
      "no decision control is offered for a claim that is not under review",
    );
    assert.equal(await page.locator(`[data-decision-submit='${HERO_FINDING}']`).count(), 0);
    assert.match(
      (await page.locator(`[data-decisions-withheld='${HERO_FINDING}']`).textContent()) ?? "",
      /no decision can be taken from here/u,
    );

    await shot(page, "verification-history");

    // The way back is named rather than left to the reader to find, and taking
    // it restores the decision on the claim actually under review.
    await page.locator(`[data-decision-show-current='${HERO_FINDING}']`).click();
    await page.waitForFunction(
      (identifier) =>
        (document.querySelector("[data-verification-id]")?.textContent ?? "").includes(
          identifier as string,
        ),
      swapped,
      { timeout: 15_000 },
    );
    await page.locator("[data-decision='accept']").waitFor();
    assert.equal(await page.locator(`[data-decisions-withheld='${HERO_FINDING}']`).count(), 0);

    clean(session, "the verification history");
  } finally {
    await session.close();
    await resetStub();
  }
});

// ---------------------------------------------------------- accessibility

test("the decision path is operable by keyboard with visible focus", async () => {
  const session = await openFinding(DESKTOP);
  const page = session.page;
  try {
    // Reached by Tab rather than by focus(), because `:focus-visible` is what
    // draws the ring and only keyboard interaction matches it.
    const reached = await tabTo(page, "data-decision", "accept");
    assert.ok(reached, "Accept is reachable by keyboard");

    const outline = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (element === null) return "";
      const style = globalThis.getComputedStyle(element);
      return `${style.outlineStyle} ${style.outlineWidth}`;
    });
    assert.notEqual(outline.split(" ")[0], "none", `focus is visible: ${outline}`);
    evidence.push(`keyboard focus on Accept: outline ${outline}`);

    await page.keyboard.press("Enter");
    await page.locator(`[data-decision-reason='${HERO_FINDING}']`).waitFor();
    assert.equal(
      await page.locator("[data-decision='accept']").getAttribute("aria-pressed"),
      "true",
      "the chosen decision is announced, not signalled by colour",
    );

    // The claim list is operable the same way: it is a list of buttons.
    const claimReachable = await tabTo(page, "data-verification-item", SEEDED_CLAIM);
    assert.ok(claimReachable, "each claim is reachable by keyboard");

    await shot(page, "keyboard-navigation");
    clean(session, "keyboard navigation");
  } finally {
    await session.close();
    await resetStub();
  }
});

test("the finding page does not scroll horizontally at 390x844", async () => {
  const session = await openFinding(MOBILE);
  try {
    const overflow = await session.page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
    assert.ok(
      overflow.documentWidth <= overflow.viewportWidth + 1,
      `the page scrolls horizontally at 390px: ${JSON.stringify(overflow)}`,
    );
    clean(session, "the mobile layout");
  } finally {
    await session.close();
  }
});

test("the review offers only the decisions the transition table permits", async () => {
  // `READY` is not a status a human can accept a review from
  // (`docs/DOMAIN_MODEL.md` section 14), so the page offers nothing rather than
  // a control that would certainly be refused. The assertion is that the
  // absence comes from the table: the same page shows the accept control once
  // the review reaches `AWAITING_HUMAN_REVIEW` in the case below.
  const session = await signIn(DESKTOP);
  const page = session.page;
  try {
    await page.getByRole("link", { name: "Reviews" }).click();
    await page.getByRole("link", { name: "Open review" }).first().click();
    await page.getByRole("heading", { name: "Bugs on homepage" }).waitFor();

    await page.locator("[data-review-decisions-empty='rev_ui_suite_bugs']").waitFor();
    assert.equal(await page.locator("[data-review-decision='accept']").count(), 0);
    assert.equal(await page.locator("[data-review-decision='archive']").count(), 0);

    // The review's status reads as words rather than as a colour.
    const status = (await page.locator("h1 ~ span").first().textContent()) ?? "";
    assert.match(status, /READY/u);
    assert.match(status, /ready to be picked up/u);

    await shot(page, "review-detail-1440x900");
    clean(session, "the review page at READY");
  } finally {
    await session.close();
  }
});

test("a review awaiting a human cannot be accepted while a finding is outstanding", async () => {
  await restartStub({ reviewAwaitingReview: true });
  const session = await signIn(DESKTOP);
  const page = session.page;
  try {
    await page.getByRole("link", { name: "Reviews" }).click();
    await page.getByRole("link", { name: "Open review" }).first().click();
    await page.getByRole("heading", { name: "Bugs on homepage" }).waitFor();

    // Now the table permits it, so the control is there.
    await page.locator("[data-review-decision='accept']").click();
    await page.locator("[data-review-decision-submit='rev_ui_suite_bugs']").click();
    await page.locator("[data-refusal='POLICY_DENIED']").waitFor({ timeout: 15_000 });

    // And the control plane refuses it, naming the finding that has not been
    // disposed of. Offering a control is never granting the decision
    // (`docs/SECURITY.md` section 7).
    const refusal = (await page.locator("[data-refusal='POLICY_DENIED']").textContent()) ?? "";
    assert.match(refusal, /lifecycle does not allow this decision from here/u);
    evidence.push("review accept refused while a human-authored finding is outstanding");
    await shot(page, "review-accept-refused");
    clean(session, "the review-level accept");
  } finally {
    await session.close();
    await restartStub({});
  }
});

/**
 * A fresh stub between decision cases.
 *
 * The workspace state is deliberately mutable, so a case that accepts a finding
 * must not leave it accepted for the next one. Restarting on the same port
 * keeps the origin stable for the browser contexts that follow.
 */
async function resetStub(): Promise<void> {
  await restartStub({});
}

async function restartStub(extra: { readonly reviewAwaitingReview?: boolean }): Promise<void> {
  const port = stub.port;
  await stub.stop();
  stub = await startStubControlPlane({
    distDirectory,
    frames: [],
    port,
    screenshot: await renderCapture("#0f172a", "#f97316"),
    afterScreenshot: await renderCapture("#052e16", "#22c55e"),
    ...extra,
  });
}
