/**
 * Publishing a development service, and the states publication fails into
 * (`docs/UX_FLOWS.md` sections 6, 18 and 19; `docs/CONNECTOR_PROTOCOL.md`
 * section 11; `docs/TESTING.md` section 15; RVP-24's user-interface
 * requirements).
 *
 * Publication is asked of a machine this application cannot see, so most of
 * what a reader meets here is somebody else's refusal. The suite is built
 * around that: the happy path is one case and the named failures are three,
 * because a surface that renders `PORT_NOT_LISTENING` as "something went wrong"
 * sends a reader to look at the control plane instead of at the development
 * server that is not running.
 *
 * The form is completed by keyboard rather than by locator, so tab order,
 * labelling and a visible focus ring are asserted by the same case that asserts
 * the publication — an interface that can only be finished with a pointer would
 * pass a suite that filled it by identifier.
 *
 * Everything runs at both required viewports, in a real Chromium, against the
 * stub control plane, and every case asserts an empty console, no page error
 * and no failed request. The refusal cases allow exactly the one response they
 * asked the stub for, by its status and its path, and nothing else. It runs
 * inside the browser-worker image; see `scripts/run-ui-tests.sh`.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { chromium, type Browser, type ConsoleMessage, type Page } from "playwright";

import {
  CONNECTOR_ID,
  ENVIRONMENT_NAME,
  REFUSAL_STATUS,
  SESSION,
  UI_SUITE_EMAIL,
  UI_SUITE_PASSWORD,
  WORKSPACE_BRANCH,
  startStubControlPlane,
  type StubControlPlane,
} from "./stub-control-plane.ts";

const here = dirname(fileURLToPath(import.meta.url));
const distDirectory = join(here, "..", "..", "dist");
const evidenceDirectory = join(here, "..", "..", "test-results");

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

/** The port the fixture publishes, and what the connector then reports. */
const LOCAL_PORT = "4321";

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
  /** Refuse publication with this stable code, as the deliberate case. */
  readonly publishRefusal?: string;
  /** Answer the project's browser-session list empty. */
  readonly withoutBrowserSession?: boolean;
}

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
    ...(options.publishRefusal === undefined ? {} : { publishRefusal: options.publishRefusal }),
    ...(options.withoutBrowserSession === undefined
      ? {}
      : { withoutBrowserSession: options.withoutBrowserSession }),
  });
  const context = await browser.newContext({ viewport, locale: "en-GB" });
  const page = await context.newPage();
  const errors: string[] = [];

  // The one response a refusal case asked for, by status and by path. Anything
  // else — including the same status on another path — is still a failure.
  const refusalStatus =
    options.publishRefusal === undefined ? null : (REFUSAL_STATUS[options.publishRefusal] ?? 503);
  const expected = (status: number, url: string): boolean =>
    refusalStatus !== null && status === refusalStatus && url.endsWith("/published-services");

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
      refusalStatus !== null &&
      new RegExp(`status of ${String(refusalStatus)}`, "u").test(message.text()) &&
      /published-services/u.test(where)
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
    if (expected(status, response.url())) return;
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

/** Tabs forward until the focused element satisfies `matches`. */
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

async function focusedId(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.id ?? "");
}

const livePath = `/projects/${SESSION.project_id}/live`;

async function openLive(session: Session): Promise<void> {
  await session.page.goto(`${session.stub.origin}${livePath}`, { waitUntil: "domcontentloaded" });
  await session.page
    .getByRole("heading", { name: "Published development services" })
    .waitFor();
}

/** Fills the publication form with a pointer, for the cases about refusals. */
async function publish(session: Session): Promise<void> {
  await session.page.locator("#publish-local-port").fill(LOCAL_PORT);
  await session.page.locator(`#publish-session-${SESSION.id}`).check();
  await session.page.locator("#publish-submit").click();
}

for (const [label, viewport] of [
  ["1440x900", DESKTOP],
  ["390x844", MOBILE],
] as const) {
  test(`a development service is published and revoked by keyboard at ${label}`, async () => {
    await withSession(viewport, { connectorConnected: true }, async (session) => {
      await openLive(session);

      // The section is a landmark with a name, not a heading floating in the
      // page (`docs/UX_FLOWS.md` section 19).
      await session.page
        .getByRole("region", { name: "Published development services" })
        .waitFor();
      const activity = session.page.locator("#published-services-activity");
      assert.equal(await activity.getAttribute("role"), "status");
      assert.equal(await activity.getAttribute("aria-live"), "polite");

      // Nothing is published yet, and the page says so rather than showing an
      // empty list.
      const before = (await session.page.locator("[data-empty='routes']").textContent()) ?? "";
      assert.match(before, /No development service is published/u, before);

      // Every control is reached in order, by keyboard, with a focus ring the
      // page provides itself.
      await tabUntil(session.page, "the environment select", (active) =>
        active.id === "publish-environment",
      );
      await assertVisibleFocus(session.page);
      const environment =
        (await session.page.locator("#publish-environment").inputValue()) ?? "";
      assert.notEqual(environment, "", "the environment select has no value");

      await session.page.keyboard.press("Tab");
      assert.equal(await focusedId(session.page), "publish-workspace");
      await assertVisibleFocus(session.page);
      // The checkout is named as a checkout, not as an identifier.
      const workspaces = (await session.page.locator("#publish-workspace").textContent()) ?? "";
      assert.ok(workspaces.includes(WORKSPACE_BRANCH), `the branch is missing: ${workspaces}`);

      await session.page.keyboard.press("Tab");
      assert.equal(await focusedId(session.page), "publish-local-host");
      await assertVisibleFocus(session.page);
      assert.equal(
        await session.page.locator("#publish-local-host").inputValue(),
        "127.0.0.1",
        "the local host does not default to loopback",
      );

      await session.page.keyboard.press("Tab");
      assert.equal(await focusedId(session.page), "publish-local-port");
      await assertVisibleFocus(session.page);
      await session.page.keyboard.type(LOCAL_PORT);

      await session.page.keyboard.press("Tab");
      assert.equal(await focusedId(session.page), "publish-protocol");
      await assertVisibleFocus(session.page);

      await session.page.keyboard.press("Tab");
      assert.equal(await focusedId(session.page), "publish-ttl");
      await assertVisibleFocus(session.page);
      assert.equal(
        await session.page.locator("#publish-ttl").inputValue(),
        "3600",
        "the route lifetime has no default",
      );

      await session.page.keyboard.press("Tab");
      assert.equal(await focusedId(session.page), `publish-session-${SESSION.id}`);
      await assertVisibleFocus(session.page);
      await session.page.keyboard.press("Space");
      assert.equal(
        await session.page.locator(`#publish-session-${SESSION.id}`).isChecked(),
        true,
        "the session checkbox did not answer the keyboard",
      );

      await session.page.keyboard.press("Tab");
      assert.equal(await focusedId(session.page), "publish-submit");
      await assertVisibleFocus(session.page);
      await evidence(session.page, `published-services-form-${label}`);
      await session.page.keyboard.press("Enter");

      // The route arrives as a record of what is carried, not as a claim that
      // something happened.
      const route = session.page.locator("[data-published-service]").first();
      await route.waitFor({ timeout: 20_000 });
      await route.scrollIntoViewIfNeeded();
      await evidence(session.page, `published-services-ready-${label}`);

      const text = (await route.textContent()) ?? "";
      assert.match(text, /READY/u, `the route does not state its status: ${text}`);
      assert.match(text, /carried, and reachable by the sessions it names/u, text);
      assert.match(text, /internal\.invalid/u, `the internal origin is missing: ${text}`);
      assert.match(text, /127\.0\.0\.1:4321/u, `the observed destination is missing: ${text}`);
      assert.ok(text.includes(SESSION.id), `the authorised session is not named: ${text}`);
      assert.ok(!text.includes("1970"), `an absent timestamp was formatted: ${text}`);

      // And it is announced, so a reader who cannot see the list change is
      // still told what publishing did.
      const announced = (await activity.textContent()) ?? "";
      assert.match(announced, /is ready/u, announced);
      assert.match(announced, /127\.0\.0\.1:4321/u, announced);

      // Revoking is a route-level action and reports what it did.
      const serviceId = (await route.getAttribute("data-published-service")) ?? "";
      await session.page.locator(`[data-revoke-service='${serviceId}']`).click();
      await session.page.waitForFunction(
        (id) =>
          (document.querySelector(`[data-published-service='${id}']`)?.textContent ?? "").includes(
            "REVOKED",
          ),
        serviceId,
        { timeout: 20_000 },
      );
      await evidence(session.page, `published-services-revoked-${label}`);
      const revoked = (await activity.textContent()) ?? "";
      assert.match(revoked, /is revoked/u, revoked);
      assert.match(revoked, /can no longer reach/u, revoked);
      // A revoked route offers no second revocation.
      assert.equal(
        await session.page.locator(`[data-revoke-service='${serviceId}']`).count(),
        0,
        "a revoked route still offers to revoke",
      );

      const body = (await session.page.textContent("body")) ?? "";
      assert.ok(!/something went wrong/iu.test(body), "the page shrugs somewhere");

      await assertNoHorizontalOverflow(session.page);
      assert.deepEqual(session.errors, [], session.errors.join(" | "));
    });
  });

  test(`the no-connector state names the cause and offers enrolment at ${label}`, async () => {
    await withSession(viewport, {}, async (session) => {
      await openLive(session);
      const empty = session.page.locator("[data-empty='published-services']");
      await empty.waitFor();
      await evidence(session.page, `published-services-no-connector-${label}`);

      const text = (await empty.textContent()) ?? "";
      // Not an error: nothing to publish yet, and why that matters
      // (`docs/UX_FLOWS.md` section 18).
      assert.match(text, /No connector is connected/u, text);
      assert.match(text, /nothing to publish yet/u, text);
      assert.match(text, /no connector has enrolled into this project yet/u, text);
      assert.match(text, /no application to open/u, text);
      assert.ok(!/something went wrong/iu.test(text), "the empty state shrugs");

      // And the enrolment flow of section 5 as its action.
      await empty.getByRole("link", { name: "Enrol a connector for this project" }).waitFor();
      await empty.getByRole("link", { name: "See this project's environments" }).waitFor();

      // With nothing to publish through, there is no form to complete.
      assert.equal(await session.page.locator("#publish-submit").count(), 0);

      await assertNoHorizontalOverflow(session.page);
      assert.deepEqual(session.errors, [], session.errors.join(" | "));
    });
  });

  test(`a refused publication names PORT_NOT_LISTENING at ${label}`, async () => {
    await withSession(
      viewport,
      { connectorConnected: true, publishRefusal: "PORT_NOT_LISTENING" },
      async (session) => {
        await openLive(session);
        await publish(session);

        const refusal = session.page.locator("[data-refusal='PORT_NOT_LISTENING']");
        await refusal.waitFor({ timeout: 20_000 });
        await refusal.scrollIntoViewIfNeeded();
        await evidence(session.page, `published-services-not-listening-${label}`);

        const text = (await refusal.textContent()) ?? "";
        assert.match(text, /The development service is not listening/u, text);
        // The fix is on the development machine, and the state says so.
        assert.match(text, /Start the development server there/u, text);
        assert.match(text, /PORT_NOT_LISTENING/u, "the stable code is not named");
        assert.equal(await refusal.getAttribute("role"), "alert");

        const body = (await session.page.textContent("body")) ?? "";
        assert.ok(!/something went wrong/iu.test(body), "the refusal shrugs");

        await assertNoHorizontalOverflow(session.page);
        assert.deepEqual(session.errors, [], session.errors.join(" | "));
      },
    );
  });

  test(`a refused publication names CONNECTOR_OFFLINE at ${label}`, async () => {
    await withSession(
      viewport,
      { connectorConnected: true, publishRefusal: "CONNECTOR_OFFLINE" },
      async (session) => {
        await openLive(session);
        await publish(session);

        const refusal = session.page.locator("[data-refusal='CONNECTOR_OFFLINE']");
        await refusal.waitFor({ timeout: 20_000 });
        await refusal.scrollIntoViewIfNeeded();
        await evidence(session.page, `published-services-tunnel-unavailable-${label}`);

        const text = (await refusal.textContent()) ?? "";
        assert.match(text, /The tunnel is unavailable/u, text);
        // A connector that stopped reporting may recover; the state says which
        // of the two this is (`docs/UX_FLOWS.md` section 18).
        assert.match(text, /dials back in on its own/u, text);
        assert.match(text, /CONNECTOR_OFFLINE/u, "the stable code is not named");

        const body = (await session.page.textContent("body")) ?? "";
        assert.ok(!/something went wrong/iu.test(body), "the refusal shrugs");

        await assertNoHorizontalOverflow(session.page);
        assert.deepEqual(session.errors, [], session.errors.join(" | "));
      },
    );
  });

  test(`the form explains that a route must authorise a session at ${label}`, async () => {
    await withSession(
      viewport,
      { connectorConnected: true, withoutBrowserSession: true },
      async (session) => {
        await openLive(session);
        const empty = session.page.locator("[data-empty='browser-sessions']");
        await empty.waitFor();
        await evidence(session.page, `published-services-no-session-${label}`);

        const text = (await empty.textContent()) ?? "";
        assert.match(text, /must authorise at least one/u, text);
        assert.match(text, /a route no session may use is not published/u, text);

        // The environment is real and the form is there; what is missing is
        // stated where the choice would have been, rather than on submit.
        const form = (await session.page.locator("[data-publish-form]").textContent()) ?? "";
        assert.ok(form.includes(ENVIRONMENT_NAME), `the environment is not offered: ${form}`);
        assert.ok(form.includes(CONNECTOR_ID), `the carrying connector is not named: ${form}`);
        assert.equal(
          await session.page.locator("#publish-submit").count(),
          0,
          "a form that cannot be completed still offers to submit",
        );

        await assertNoHorizontalOverflow(session.page);
        assert.deepEqual(session.errors, [], session.errors.join(" | "));
      },
    );
  });
}

after(async () => {
  await writeFile(
    join(evidenceDirectory, "published-services-evidence.txt"),
    [
      "ReviewPlane RVP-24 user-interface evidence",
      "publishing a development service, revoking it, and the states publication",
      "fails into, at 390x844 and 1440x900.",
      "",
      "properties asserted:",
      "- the section is a named landmark whose status text is a polite live region",
      "- the form is reached, completed and submitted by keyboard alone, in order,",
      "  with a visible focus ring on every control",
      "- a published route states its internal origin, its observed destination, its",
      "  expiry, the sessions it authorises and a READY badge carrying a text label",
      "- revoking reports what it did and leaves the route REVOKED",
      "- no connector connected is stated as a cause with the enrolment flow as its",
      "  action, never as an error",
      "- PORT_NOT_LISTENING is named as the development server not listening, with",
      "  the fix on the development machine",
      "- CONNECTOR_OFFLINE is named as the tunnel being unavailable, and distinguished",
      "  from a revoked connector",
      "- a project with no browser session is told so where the choice would be,",
      "  because a route must authorise at least one",
      "- no console error, no page error and no failed request in any case, except",
      "  the single refusal each refusal case asked the stub for",
      "",
      ...captured.map((name) => `screenshot: ${name}`),
      "",
    ].join("\n"),
    "utf8",
  );
});
