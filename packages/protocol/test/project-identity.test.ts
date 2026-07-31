/**
 * Unit layer for repository identity and project settings (`docs/TESTING.md`
 * section 2: "Protocol validation", and the unit requirements of RVP-12).
 *
 * Both are normalisation rather than transport, so the corpus cannot express
 * them: what has to hold is that several spellings of one repository reduce to
 * one stored value, that two spellings of *different* repositories never do,
 * that a credential pasted into a clone URL is dropped instead of stored, and
 * that a viewport a browser session would refuse cannot be saved as a project
 * default.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_VALIDATION_VIEWPORTS,
  canonicaliseCloneUrl,
  defaultProjectSettings,
  formatViewport,
  normaliseProjectSettings,
  normaliseRepositoryIdentity,
  sanitiseCloneUrl,
} from "../src/platform.ts";

test("every spelling of one repository reduces to one canonical identity", () => {
  const spellings = [
    "git@github.com:example/refresh-surplus.git",
    "https://github.com/example/refresh-surplus.git",
    "https://github.com/example/refresh-surplus",
    "https://GitHub.com/example/refresh-surplus/",
    "ssh://git@github.com:22/example/refresh-surplus.git",
    "github.com/example/refresh-surplus",
  ];
  for (const spelling of spellings) {
    const result = canonicaliseCloneUrl(spelling);
    assert.ok(result.ok, `${spelling} was refused`);
    assert.equal(result.value, "github.com/example/refresh-surplus", `${spelling} normalised wrongly`);
  }
});

test("the path keeps its case and the host does not", () => {
  // Most forges treat the path as case-sensitive, so Example/Repo and
  // example/repo may be two repositories; a host never is.
  const upper = canonicaliseCloneUrl("https://GITHUB.com/Example/Refresh-Surplus.git");
  assert.ok(upper.ok);
  assert.equal(upper.value, "github.com/Example/Refresh-Surplus");
});

test("a non-default port survives normalisation and a default one does not", () => {
  const explicit = canonicaliseCloneUrl("ssh://git@git.example.internal:2222/platform/api.git");
  assert.ok(explicit.ok);
  assert.equal(explicit.value, "git.example.internal:2222/platform/api");

  const standard = canonicaliseCloneUrl("https://git.example.internal:443/platform/api.git");
  assert.ok(standard.ok);
  assert.equal(standard.value, "git.example.internal/platform/api");
});

test("a credential in a clone URL is dropped rather than stored", () => {
  // docs/SECURITY.md section 18 does not stop applying because somebody pasted
  // a token into a form.
  const result = normaliseRepositoryIdentity("https://someone:ghp_secretvalue@github.com/example/api.git");
  assert.ok(result.ok);
  assert.equal(result.value.canonical, "github.com/example/api");
  assert.ok(
    !JSON.stringify(result.value).includes("ghp_secretvalue"),
    "the stored identity carried the credential from the URL",
  );
});

test("a bare token in a non-SSH clone URL is dropped, and an SSH account name is not", () => {
  // The regression this exists for: `https://<token>@host/…` is how every forge
  // documents cloning with a personal access token, and a rule that only
  // stripped `user:password` kept it — in a stored, API-returned field.
  //
  // `git://` is the third round of the same defect. It was stored verbatim
  // because the rule named http and https and so treated `git` like `ssh`; but
  // the git daemon protocol is unauthenticated and has no credential mechanism,
  // so a userinfo there cannot be an account to log in as. Only SSH keeps one.
  for (const url of [
    "https://ghp_SUPERSECRETTOKEN1234567890@github.com/example/leak.git",
    "http://glpat_SUPERSECRETTOKEN1234567890@git.example.internal/example/leak.git",
    "HTTPS://ghp_SUPERSECRETTOKEN1234567890@github.com/example/leak.git",
    "git://ghp_SUPERSECRETTOKEN1234567890@github.com/example/leak.git",
    "GIT://ghp_SUPERSECRETTOKEN1234567890@github.com/example/leak.git",
    "git://ghp_SUPERSECRETTOKEN1234567890@git.example.internal:9418/example/leak.git",
  ]) {
    const sanitised = sanitiseCloneUrl(url);
    assert.ok(
      !/SUPERSECRETTOKEN/u.test(sanitised),
      `the token survived sanitisation of ${url}: ${sanitised}`,
    );

    const stored = normaliseRepositoryIdentity(url);
    assert.ok(stored.ok);
    assert.ok(
      !/SUPERSECRETTOKEN/u.test(JSON.stringify(stored.value)),
      `the token reached the stored identity for ${url}`,
    );
  }

  // The account name in an SSH remote is not a credential — the secret is a key
  // on disk — and dropping it would store a URL that does not clone.
  assert.equal(
    sanitiseCloneUrl("git@github.com:example/api.git"),
    "git@github.com:example/api.git",
  );
  assert.equal(
    sanitiseCloneUrl("ssh://git@github.com/example/api.git"),
    "ssh://git@github.com/example/api.git",
  );
  // A password in an SSH URL is still a credential.
  assert.equal(
    sanitiseCloneUrl("ssh://git:hunter2@github.com/example/api.git"),
    "ssh://github.com/example/api.git",
  );
  // The exact value that was stored verbatim, so the scheme this suite added
  // last is asserted as itself and not only through the loop above.
  assert.equal(
    sanitiseCloneUrl("git://ghp_SECRETTOKEN123@github.com/example/i.git"),
    "git://github.com/example/i.git",
  );
  // A scheme nothing accepts yet is treated as secret-bearing, because the
  // predicate asks whether the URL is SSH rather than listing what leaks.
  assert.equal(
    sanitiseCloneUrl("ftps://ghp_SECRETTOKEN123@example.internal/example/i.git"),
    "ftps://example.internal/example/i.git",
  );
});

test("deep paths and self-hosted group hierarchies normalise", () => {
  const nested = canonicaliseCloneUrl("git@gitlab.example.internal:group/subgroup/service.git");
  assert.ok(nested.ok);
  assert.equal(nested.value, "gitlab.example.internal/group/subgroup/service");
});

test("values that are not a repository are refused with a stable reason", () => {
  assert.deepEqual(canonicaliseCloneUrl(""), { ok: false, reason: "empty" });
  assert.deepEqual(canonicaliseCloneUrl("   "), { ok: false, reason: "empty" });
  assert.deepEqual(canonicaliseCloneUrl("file:///srv/git/repo.git"), {
    ok: false,
    reason: "unsupported_scheme",
  });
  assert.deepEqual(canonicaliseCloneUrl("https://github.com"), { ok: false, reason: "missing_path" });
  assert.deepEqual(canonicaliseCloneUrl("github.com/example/re po"), {
    ok: false,
    reason: "invalid_characters",
  });
  assert.deepEqual(canonicaliseCloneUrl(`https://github.com/${"a".repeat(600)}`), {
    ok: false,
    reason: "too_long",
  });
});

test("clone URLs for different repositories are refused rather than silently reduced", () => {
  const result = normaliseRepositoryIdentity({
    clone_urls: [
      "git@github.com:example/refresh-surplus.git",
      "git@github.com:example/something-else.git",
    ],
  });
  assert.deepEqual(result, { ok: false, reason: "inconsistent_urls" });
});

test("the stored identity records the supplied forms and not a repeat of the canonical one", () => {
  const result = normaliseRepositoryIdentity({
    clone_urls: [
      "git@github.com:example/refresh-surplus.git",
      "https://github.com/example/refresh-surplus.git",
      "github.com/example/refresh-surplus",
    ],
  });
  assert.ok(result.ok);
  assert.equal(result.value.canonical, "github.com/example/refresh-surplus");
  assert.deepEqual(result.value.clone_urls, [
    "git@github.com:example/refresh-surplus.git",
    "https://github.com/example/refresh-surplus.git",
  ]);
});

test("project settings default to the two viewports every surface is checked at", () => {
  assert.deepEqual(
    [...DEFAULT_VALIDATION_VIEWPORTS],
    [
      { width: 390, height: 844 },
      { width: 1440, height: 900 },
    ],
  );
  assert.deepEqual(normaliseProjectSettings(undefined), { ok: true, value: defaultProjectSettings() });
  assert.deepEqual(normaliseProjectSettings({}), { ok: true, value: defaultProjectSettings() });
});

test("a viewport outside the browser's bounds cannot be stored as a project default", () => {
  const tooSmall = normaliseProjectSettings({ default_validation_viewports: [{ width: 100, height: 100 }] });
  assert.ok(!tooSmall.ok);
  assert.equal(tooSmall.violations[0]?.code, "too_small");

  const tooLarge = normaliseProjectSettings({
    default_validation_viewports: [{ width: 8000, height: 900 }],
  });
  assert.ok(!tooLarge.ok);
  assert.equal(tooLarge.violations[0]?.code, "too_large");

  const none = normaliseProjectSettings({ default_validation_viewports: [] });
  assert.ok(!none.ok);
  assert.equal(none.violations[0]?.code, "too_few_items");

  const unknown = normaliseProjectSettings({ retention: "forever" });
  assert.ok(!unknown.ok);
  assert.equal(unknown.violations[0]?.code, "unknown_property");
});

test("a device pixel ratio of 1 is dropped, so one viewport cannot be stored twice", () => {
  const normalised = normaliseProjectSettings({
    default_validation_viewports: [{ width: 390, height: 844, device_scale_factor: 1 }],
  });
  assert.ok(normalised.ok);
  assert.deepEqual(normalised.value.default_validation_viewports, [{ width: 390, height: 844 }]);

  const duplicated = normaliseProjectSettings({
    default_validation_viewports: [
      { width: 390, height: 844 },
      { width: 390, height: 844, device_scale_factor: 1 },
    ],
  });
  assert.ok(!duplicated.ok);
  assert.equal(duplicated.violations[0]?.code, "duplicate_items");

  // A ratio other than 1 is a different viewport and survives.
  const retina = normaliseProjectSettings({
    default_validation_viewports: [{ width: 390, height: 844, device_scale_factor: 2 }],
  });
  assert.ok(retina.ok);
  assert.equal(formatViewport(retina.value.default_validation_viewports[0] as never), "390x844@2x");
});
