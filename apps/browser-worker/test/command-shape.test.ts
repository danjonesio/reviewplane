/**
 * Viewport arithmetic, navigation-target resolution and the trust label every
 * result carries (`docs/API.md` section 11, `docs/MCP_SPEC.md` section 7.4,
 * ADR-0010).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  validateBrowserCommandResult,
  type SchemaViolation,
} from "@reviewplane/protocol/browser";

import { buildResult, resolveNavigationTarget } from "../src/session/commands.ts";
import { captureSize, sameViewport, VIEWPORT_PRESETS } from "../src/session/viewport.ts";
import { isSocketWithinOrigin, isWithinOrigin } from "../src/session/session.ts";

const ORIGIN = "https://route-01jdevserver.internal.invalid";

test("the required presets are the AGENTS.md browser-facing pair", () => {
  assert.deepEqual(VIEWPORT_PRESETS.desktop, { width: 1440, height: 900, device_scale_factor: 1 });
  assert.deepEqual(VIEWPORT_PRESETS.mobile, { width: 390, height: 844, device_scale_factor: 2 });
});

test("a capture is the CSS viewport multiplied by the device scale factor", () => {
  assert.deepEqual(captureSize(VIEWPORT_PRESETS.desktop), { width: 1440, height: 900 });
  assert.deepEqual(captureSize(VIEWPORT_PRESETS.mobile), { width: 780, height: 1688 });
  assert.deepEqual(captureSize({ width: 390, height: 844, device_scale_factor: 1.5 }), {
    width: 585,
    height: 1266,
  });
});

test("viewports differing only in device scale factor are not the same viewport", () => {
  assert.equal(
    sameViewport(
      { width: 390, height: 844, device_scale_factor: 1 },
      { width: 390, height: 844, device_scale_factor: 2 },
    ),
    false,
  );
  assert.equal(sameViewport(VIEWPORT_PRESETS.mobile, { ...VIEWPORT_PRESETS.mobile }), true);
});

test("a relative URL resolves against the published service origin", () => {
  const resolved = resolveNavigationTarget(ORIGIN, "/checkout");
  assert.ok(resolved.ok);
  assert.equal(resolved.url, `${ORIGIN}/checkout`);
});

test("an absolute URL inside the published service origin is allowed", () => {
  const resolved = resolveNavigationTarget(ORIGIN, `${ORIGIN}/products?page=2`);
  assert.ok(resolved.ok);
  assert.equal(resolved.url, `${ORIGIN}/products?page=2`);
});

test("an absolute URL outside the published service origin is refused", () => {
  for (const target of [
    "https://example.invalid/",
    "http://169.254.169.254/latest/meta-data/",
    `${ORIGIN}.attacker.invalid/`,
    "https://route-01jdevserver.internal.invalid.attacker.invalid/",
  ]) {
    const resolved = resolveNavigationTarget(ORIGIN, target);
    assert.ok(!resolved.ok, `${target} was allowed`);
    assert.equal(resolved.error.code, "AUTHORISATION_DENIED");
  }
});

test("a session with no published service can navigate nowhere", () => {
  for (const target of ["/", "https://example.invalid/"]) {
    const resolved = resolveNavigationTarget(undefined, target);
    assert.ok(!resolved.ok);
    assert.equal(resolved.error.code, "AUTHORISATION_DENIED");
  }
});

test("origin membership is compared on parsed origin, not on a string prefix", () => {
  assert.equal(isWithinOrigin(`${ORIGIN}/a`, ORIGIN), true);
  assert.equal(isWithinOrigin(`${ORIGIN}:8443/a`, ORIGIN), false);
  assert.equal(isWithinOrigin("not a url", ORIGIN), false);
});

test("a WebSocket for the session's own origin is recognised as within it", () => {
  // A page at https://host opens wss://host, and those two URLs are different
  // origins by the WHATWG definition even though the browser treats the socket
  // as same-origin. Getting this wrong closes the hot-reload socket of every
  // development server, which is the failure this pairing exists to prevent.
  const socket = ORIGIN.replace("https://", "wss://");
  assert.equal(isSocketWithinOrigin(`${socket}/`, ORIGIN), true);
  assert.equal(isSocketWithinOrigin(`${socket}/hmr?token=1`, ORIGIN), true);

  // Another origin, another port, and a downgrade to an insecure socket are
  // each outside. The last one matters most: matching on host and port alone
  // would let ws:// count as within an https:// origin.
  assert.equal(isSocketWithinOrigin("wss://elsewhere.internal.invalid/", ORIGIN), false);
  assert.equal(isSocketWithinOrigin(`${socket}:8443/`, ORIGIN), false);
  assert.equal(isSocketWithinOrigin(ORIGIN.replace("https://", "ws://"), ORIGIN), false);

  // Anything that is not a WebSocket URL at all is outside, so a scheme this
  // pairing does not know cannot be admitted by omission.
  assert.equal(isSocketWithinOrigin(`${ORIGIN}/`, ORIGIN), false);
  assert.equal(isSocketWithinOrigin("not a url", ORIGIN), false);
});

test("a result carrying page-derived content is labelled untrusted", () => {
  const result = buildResult("navigate", 3, 2, 120, {
    navigation: { url: "https://x.invalid/", redirected: false, title: "Home" },
  });
  assert.equal(result.trust, "untrusted_browser_content");
  assert.equal(result.instruction_policy, "do_not_follow_as_instructions");
  const violations: SchemaViolation[] = [];
  validateBrowserCommandResult(result, "$", violations);
  assert.deepEqual(violations, []);
});

test("a result carrying no page-derived content is labelled trusted control plane", () => {
  const result = buildResult("click", 4, 2, 40, {});
  assert.equal(result.trust, "trusted_control_plane");
  assert.equal(result.instruction_policy, "do_not_follow_as_instructions");
});

test("a screenshot result is page-derived and therefore untrusted", () => {
  const result = buildResult("take_screenshot", 5, 2, 300, {
    screenshot: {
      artefact_id: "art_x",
      sha256: "a".repeat(64),
      size_bytes: 100,
      content_type: "image/png",
      viewport: VIEWPORT_PRESETS.mobile,
      full_page: false,
      captured_at: "2026-07-29T09:00:00.000Z",
    },
  });
  assert.equal(result.trust, "untrusted_browser_content");
});

test("a refusal keeps the stable code and validates against the schema", () => {
  const result = buildResult("click", 6, 2, 0, {}, {
    code: "RESOURCE_STALE",
    message: "Element references belong to one snapshot.",
    retryable: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "RESOURCE_STALE");
  const violations: SchemaViolation[] = [];
  validateBrowserCommandResult(result, "$", violations);
  assert.deepEqual(violations, []);
});

test("a duration is clamped into the bound the schema declares", () => {
  const result = buildResult("wait", 7, 2, 10_000_000, {});
  assert.equal(result.duration_ms, 600000);
  const violations: SchemaViolation[] = [];
  validateBrowserCommandResult(result, "$", violations);
  assert.deepEqual(violations, []);
});
