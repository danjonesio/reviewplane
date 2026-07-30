/**
 * Contract layer (`docs/TESTING.md` section 2): the control plane mints route
 * capabilities in TypeScript and the tunnel gateway verifies them in Go, so
 * both languages run this corpus. A token that only one language produces is a
 * broken deployment, not a style difference.
 */

import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";

import {
  CapabilityError,
  MAX_CAPABILITY_IDENTIFIER_LENGTH,
  MAX_CAPABILITY_TOKEN_LENGTH,
  MIN_CAPABILITY_SIGNING_KEY_BYTES,
  mintCapability,
  verifyCapability,
} from "../src/capability.ts";
import type { CapabilityKeyring } from "../src/capability.ts";
import { loadCapabilityManifest } from "../src/fixtures.ts";
import { REDACTED } from "../src/sensitive.ts";
import { validateSessionCapability } from "../src/generated/connector/v1/validate.ts";

const manifest = loadCapabilityManifest();

function key(keyId: string): Uint8Array {
  const encoded = manifest.keys[keyId];
  assert.ok(encoded !== undefined, `corpus has no key ${keyId}`);
  return new Uint8Array(Buffer.from(encoded, "base64"));
}

function keyring(): CapabilityKeyring {
  return new Map(manifest.verifier_keyring.map((keyId) => [keyId, key(keyId)]));
}

function rejectionOf(error: unknown): string {
  assert.ok(error instanceof CapabilityError, `expected a CapabilityError, got ${inspect(error)}`);
  return error.rejection;
}

test("the corpus mints its golden tokens", () => {
  assert.ok(manifest.mint.length > 0, "the capability corpus is empty");
  for (const fixture of manifest.mint) {
    const token = mintCapability(key(fixture.key_id), {
      keyId: fixture.key_id,
      capabilityId: fixture.capability_id,
      routeId: fixture.route_id,
      projectId: fixture.project_id,
      browserSessionId: fixture.browser_session_id,
      issuedAt: fixture.issued_at,
      expiresAt: fixture.expires_at,
    });
    assert.equal(token.reveal(), fixture.token, `${fixture.name} does not match the corpus`);
    assert.ok(
      fixture.token.length <= MAX_CAPABILITY_TOKEN_LENGTH,
      `${fixture.name} exceeds the schema bound`,
    );
    // The token must satisfy the schema's session_capability pattern, because
    // that is the field it travels in.
    const violations: Parameters<typeof validateSessionCapability>[2] = [];
    validateSessionCapability(fixture.token, "$", violations);
    assert.deepEqual(violations, [], `${fixture.name} is not a valid session_capability`);
  }
});

test("the corpus verification outcomes hold", () => {
  const keys = keyring();
  for (const fixture of manifest.verify) {
    if (fixture.expect === "valid") {
      const claims = verifyCapability(keys, fixture.token, fixture.now);
      assert.ok(fixture.claims !== undefined, `${fixture.name} accepts but records no claims`);
      assert.deepEqual(
        {
          key_id: claims.keyId,
          capability_id: claims.capabilityId,
          route_id: claims.routeId,
          project_id: claims.projectId,
          browser_session_id: claims.browserSessionId,
          issued_at: claims.issuedAt,
          expires_at: claims.expiresAt,
        },
        fixture.claims,
        `${fixture.name} claims do not match the corpus`,
      );
      continue;
    }
    assert.throws(
      () => verifyCapability(keys, fixture.token, fixture.now),
      (error: unknown) => rejectionOf(error) === fixture.expect,
      `${fixture.name} must be refused as ${fixture.expect}`,
    );
  }
});

test("a capability signed with another key is refused", () => {
  // The attacker owns a key, and names a key identifier the verifier trusts.
  // Only the MAC decides.
  const forged = mintCapability(key("k"), {
    keyId: "stage0-a",
    capabilityId: "cap_x",
    routeId: "svc_x",
    projectId: "prj_x",
    browserSessionId: "brs_x",
    issuedAt: 1000,
    expiresAt: 2000,
  });
  const keys: CapabilityKeyring = new Map([["stage0-a", key("stage0-a")]]);
  assert.throws(
    () => verifyCapability(keys, forged.reveal(), 1500),
    (error: unknown) => rejectionOf(error) === "bad_signature",
  );
});

test("a minted capability is redacted in every default representation", () => {
  const fixture = manifest.mint[0];
  assert.ok(fixture !== undefined);
  const token = mintCapability(key(fixture.key_id), {
    keyId: fixture.key_id,
    capabilityId: fixture.capability_id,
    routeId: fixture.route_id,
    projectId: fixture.project_id,
    browserSessionId: fixture.browser_session_id,
    issuedAt: fixture.issued_at,
    expiresAt: fixture.expires_at,
  });
  const representations: Record<string, string> = {
    toString: token.toString(),
    "String()": String(token),
    template: `${token}`,
    "JSON.stringify": JSON.stringify(token),
    "JSON.stringify(containing)": JSON.stringify({ capability: token }),
    inspect: inspect(token),
    "inspect(containing)": inspect({ capability: token }),
  };
  for (const [name, representation] of Object.entries(representations)) {
    assert.ok(!representation.includes(fixture.token), `${name} leaked the capability`);
    assert.ok(representation.includes(REDACTED), `${name} is not redacted`);
  }
  assert.equal(token.reveal(), fixture.token, "reveal() must still produce the wire value");
});

test("short signing keys are refused rather than downgraded", () => {
  const claims = {
    keyId: "k",
    capabilityId: "c",
    routeId: "r",
    projectId: "p",
    browserSessionId: "b",
    issuedAt: 1,
    expiresAt: 2,
  };
  assert.throws(() =>
    mintCapability(new Uint8Array(MIN_CAPABILITY_SIGNING_KEY_BYTES - 1), claims),
  );
  const token = mintCapability(new Uint8Array(MIN_CAPABILITY_SIGNING_KEY_BYTES), claims);
  const short: CapabilityKeyring = new Map([
    ["k", new Uint8Array(MIN_CAPABILITY_SIGNING_KEY_BYTES - 1)],
  ]);
  assert.throws(
    () => verifyCapability(short, token.reveal(), 1),
    (error: unknown) => rejectionOf(error) === "unknown_key",
  );
});

test("claims that break the codec's bounds are refused at minting", () => {
  const signingKey = new Uint8Array(MIN_CAPABILITY_SIGNING_KEY_BYTES);
  const base = {
    keyId: "k",
    capabilityId: "c",
    routeId: "r",
    projectId: "p",
    browserSessionId: "b",
    issuedAt: 100,
    expiresAt: 200,
  };
  assert.throws(() => mintCapability(signingKey, { ...base, expiresAt: base.issuedAt }));
  assert.throws(() =>
    mintCapability(signingKey, {
      ...base,
      routeId: "r".repeat(MAX_CAPABILITY_IDENTIFIER_LENGTH + 1),
    }),
  );
  assert.throws(() => mintCapability(signingKey, { ...base, projectId: "" }));
});
