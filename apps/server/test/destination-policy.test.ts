/**
 * Security layer (`docs/TESTING.md` sections 6 and 10): the destination policy
 * is the SSRF control of `docs/SECURITY.md` section 9, and it is enforced in
 * the control plane, the tunnel gateway and the connector. All three run this
 * corpus, so a case only one of them refuses fails the build.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  evaluateDestination,
  normaliseAddress,
  parsePortRange,
  STAGE_0_DESTINATION_POLICY,
} from "../src/modules/published-services/destination-policy.ts";
import type { DestinationPolicy } from "../src/modules/published-services/destination-policy.ts";

interface PolicyFixture {
  readonly allowed_hosts: readonly string[];
  readonly allowed_ports: readonly string[];
  readonly allowed_protocols: readonly string[];
  readonly allow_non_loopback: boolean;
  readonly allow_link_local: boolean;
}

interface CaseFixture {
  readonly name: string;
  readonly policy: string;
  readonly host: string;
  readonly port: number;
  readonly protocol: string;
  readonly expect: string;
}

interface Corpus {
  readonly policies: Readonly<Record<string, PolicyFixture>>;
  readonly cases: readonly CaseFixture[];
}

// The corpus lives with the gateway because the gateway is its primary
// enforcement point. Reading it across the workspace is deliberate: a copy here
// would be a second source that could drift.
const CORPUS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "services",
  "tunnel-gateway",
  "testdata",
  "destination-policy.json",
);

const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as Corpus;

function buildPolicy(fixture: PolicyFixture): DestinationPolicy {
  return {
    allowedHosts: fixture.allowed_hosts,
    allowedPorts: fixture.allowed_ports.map(parsePortRange),
    allowedProtocols: fixture.allowed_protocols,
    allowNonLoopback: fixture.allow_non_loopback,
    allowLinkLocal: fixture.allow_link_local,
  };
}

test("the shared destination-policy corpus holds", () => {
  assert.ok(corpus.cases.length > 0, "the corpus is empty");
  for (const testCase of corpus.cases) {
    const fixture = corpus.policies[testCase.policy];
    assert.ok(fixture !== undefined, `the corpus names no policy ${testCase.policy}`);
    const rejection = evaluateDestination(buildPolicy(fixture), {
      host: testCase.host,
      port: testCase.port,
      protocol: testCase.protocol,
    });
    if (testCase.expect === "allowed") {
      assert.equal(rejection, null, `${testCase.name} must be allowed`);
      continue;
    }
    assert.equal(rejection, testCase.expect, `${testCase.name} must be refused as ${testCase.expect}`);
  }
});

test("the Stage 0 policy matches the documented connector allow-list", () => {
  // `docs/CONNECTOR_PROTOCOL.md` section 20 is the reference configuration.
  for (const destination of [
    { host: "127.0.0.1", port: 3000, protocol: "http" },
    { host: "127.0.0.1", port: 4321, protocol: "http" },
    { host: "127.0.0.1", port: 5173, protocol: "http" },
    { host: "::1", port: 3500, protocol: "http" },
  ]) {
    assert.equal(
      evaluateDestination(STAGE_0_DESTINATION_POLICY, destination),
      null,
      `${destination.host}:${String(destination.port)} was refused`,
    );
  }
});

test("address normalisation makes two spellings of one address compare equal", () => {
  // Without this, `::ffff:127.0.0.1` would be a different string from
  // `127.0.0.1` and an allow-list check on the text would be a bypass.
  assert.equal(normaliseAddress("::ffff:127.0.0.1"), normaliseAddress("127.0.0.1"));
  assert.equal(normaliseAddress("::1"), normaliseAddress("0:0:0:0:0:0:0:1"));
  assert.equal(normaliseAddress("FE80::1"), normaliseAddress("fe80:0:0:0:0:0:0:1"));
  assert.equal(normaliseAddress("localhost"), null);
  assert.equal(normaliseAddress("127.0.0.1.evil.example"), null);
  assert.equal(normaliseAddress(""), null);
});

test("port ranges parse and refuse", () => {
  assert.deepEqual(parsePortRange("4321"), { low: 4321, high: 4321 });
  assert.deepEqual(parsePortRange("3000-3999"), { low: 3000, high: 3999 });
  assert.deepEqual(parsePortRange(" 5173 "), { low: 5173, high: 5173 });
  for (const invalid of ["", "0", "65536", "3999-3000", "http", "3000-", "3000-3999-4000"]) {
    assert.throws(() => parsePortRange(invalid), Error, `${invalid} was accepted`);
  }
});

test("an empty policy allows nothing", () => {
  // Deny by default (`docs/SECURITY.md` section 5) has to hold without any
  // configuration at all.
  const empty: DestinationPolicy = {
    allowedHosts: [],
    allowedPorts: [],
    allowedProtocols: [],
    allowNonLoopback: false,
    allowLinkLocal: false,
  };
  assert.equal(
    evaluateDestination(empty, { host: "127.0.0.1", port: 5173, protocol: "http" }),
    "host_not_in_allow_list",
  );
});
