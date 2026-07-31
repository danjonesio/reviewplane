/**
 * Contract layer (`docs/TESTING.md` section 2): the connector reduces a
 * checkout's remote to a canonical repository identity in Go, and the control
 * plane reduces what an operator typed in TypeScript, so both languages run
 * this corpus.
 *
 * Two implementations of "the same repository" would eventually disagree, and
 * the disagreement would not look like a normalisation bug: a connector whose
 * observation never matches its project's stored identity looks like a project
 * that has quietly forgotten its code. The corpus is what stops that, and the
 * Go half in `platformv1/repository_identity_test.go` reads this same file.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { PLATFORM_CORPUS } from "../src/fixtures.ts";
import { canonicaliseCloneUrl, sanitiseCloneUrl } from "../src/repository-identity.ts";
import type { RepositoryIdentityFailure } from "../src/repository-identity.ts";

interface CorpusCase {
  readonly name: string;
  readonly input: string;
  readonly expect_canonical?: string;
  readonly expect_reason?: RepositoryIdentityFailure;
  readonly expect_sanitised: string;
  readonly note: string;
}

interface Corpus {
  readonly description: string;
  readonly cases: readonly CorpusCase[];
}

const corpus = JSON.parse(
  readFileSync(join(PLATFORM_CORPUS.directory, "repository-identity.json"), "utf8"),
) as Corpus;

test("the corpus records both an outcome and a sanitised form for every case", () => {
  assert.ok(corpus.cases.length > 0, "the repository-identity corpus is empty");
  const names = new Set<string>();
  for (const fixture of corpus.cases) {
    assert.ok(!names.has(fixture.name), `${fixture.name} appears twice`);
    names.add(fixture.name);
    const outcomes = [fixture.expect_canonical, fixture.expect_reason].filter(
      (value) => value !== undefined,
    );
    assert.equal(
      outcomes.length,
      1,
      `${fixture.name} must record exactly one of expect_canonical and expect_reason`,
    );
    assert.equal(typeof fixture.expect_sanitised, "string", `${fixture.name} records no sanitised form`);
    assert.ok(fixture.note.length > 0, `${fixture.name} records no note`);
  }
});

test("canonicalisation matches the corpus", () => {
  for (const fixture of corpus.cases) {
    const result = canonicaliseCloneUrl(fixture.input);
    if (fixture.expect_canonical !== undefined) {
      assert.ok(result.ok, `${fixture.name} was refused: ${JSON.stringify(result)}`);
      assert.equal(result.value, fixture.expect_canonical, `${fixture.name} normalised wrongly`);
    } else {
      assert.ok(!result.ok, `${fixture.name} was accepted as ${JSON.stringify(result)}`);
      assert.equal(result.reason, fixture.expect_reason, `${fixture.name} was refused for the wrong reason`);
    }
  }
});

test("sanitisation matches the corpus", () => {
  for (const fixture of corpus.cases) {
    assert.equal(
      sanitiseCloneUrl(fixture.input),
      fixture.expect_sanitised,
      `${fixture.name} sanitised wrongly`,
    );
  }
});

test("no corpus case leaks a credential through either function", () => {
  // The corpus deliberately carries values shaped like personal access tokens
  // and passwords. Neither the stored identity nor the recorded clone URL may
  // contain one (`docs/SECURITY.md` section 18).
  for (const fixture of corpus.cases) {
    if (!/SUPERSECRETTOKEN|hunter2/u.test(fixture.input)) continue;
    const sanitised = sanitiseCloneUrl(fixture.input);
    const result = canonicaliseCloneUrl(fixture.input);
    const canonical = result.ok ? result.value : "";
    for (const secret of ["SUPERSECRETTOKEN", "hunter2"]) {
      if (!fixture.input.includes(secret)) continue;
      assert.ok(!sanitised.includes(secret), `${fixture.name} kept ${secret} in the sanitised URL`);
      assert.ok(!canonical.includes(secret), `${fixture.name} kept ${secret} in the canonical identity`);
    }
  }
});
