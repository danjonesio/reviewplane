/**
 * Unit layer: the Stage 0 administrator credential and the stable error
 * vocabulary.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { credentialMatches } from "../src/auth/bootstrap-token.ts";
import { loadConfig } from "../src/config.ts";
import { API_ERROR_CODES, isStableErrorCode } from "../src/modules/published-services/errors.ts";

test("credential comparison accepts only the exact value", () => {
  const token = "administrator-token-0123456789abcdef";
  assert.equal(credentialMatches(token, token), true);
  for (const wrong of [
    "",
    token.slice(0, -1),
    `${token}x`,
    token.toUpperCase(),
    token.replace("0", "1"),
  ]) {
    assert.equal(credentialMatches(wrong, token), false, `${wrong} was accepted`);
  }
});

test("every code this API answers with is from a documented vocabulary", () => {
  // `docs/MCP_SPEC.md` section 12 and `docs/CONNECTOR_PROTOCOL.md` section 21
  // are the two vocabularies. A third would make a caller's error handling
  // guesswork.
  for (const code of API_ERROR_CODES) {
    assert.ok(isStableErrorCode(code), `${code} is not recognised`);
  }
  for (const connectorClass of [
    "DESTINATION_NOT_ALLOWED",
    "PORT_NOT_LISTENING",
    "ROUTE_LIMIT_EXCEEDED",
    "ROUTE_EXPIRED",
    "STREAM_LIMIT_EXCEEDED",
  ]) {
    assert.ok(isStableErrorCode(connectorClass), `${connectorClass} is not recognised`);
  }
  assert.equal(isStableErrorCode("SOMETHING_WENT_WRONG"), false);
});

test("configuration is validated at startup and names every problem", () => {
  assert.throws(
    () => loadConfig({}),
    (error: unknown) => {
      const message = String(error);
      for (const setting of ["DATABASE_URL", "BOOTSTRAP_TOKEN", "CAPABILITY_SIGNING_KEY"]) {
        assert.ok(message.includes(setting), `the failure does not name ${setting}`);
      }
      return true;
    },
  );
});

test("a short administrator token or signing key is refused", () => {
  const base = {
    REVIEWPLANE_DATABASE_URL: "postgres://localhost/reviewplane",
    REVIEWPLANE_BOOTSTRAP_TOKEN: "a".repeat(40),
    REVIEWPLANE_TUNNEL_CONTROL_TOKEN: "b".repeat(40),
    REVIEWPLANE_CAPABILITY_SIGNING_KEY: Buffer.alloc(32).toString("base64"),
  };
  assert.doesNotThrow(() => loadConfig(base));
  assert.throws(() => loadConfig({ ...base, REVIEWPLANE_BOOTSTRAP_TOKEN: "short" }));
  assert.throws(() =>
    loadConfig({ ...base, REVIEWPLANE_CAPABILITY_SIGNING_KEY: Buffer.alloc(16).toString("base64") }),
  );
});

test("defaults are the documented ones", () => {
  const config = loadConfig({
    REVIEWPLANE_DATABASE_URL: "postgres://localhost/reviewplane",
    REVIEWPLANE_BOOTSTRAP_TOKEN: "a".repeat(40),
    REVIEWPLANE_TUNNEL_CONTROL_TOKEN: "b".repeat(40),
    REVIEWPLANE_CAPABILITY_SIGNING_KEY: Buffer.alloc(32).toString("base64"),
  });
  assert.equal(config.internalSuffix, "internal.invalid");
  assert.equal(config.capabilityTtlSeconds, 300);
  assert.equal(config.routeTtlMaxSeconds, 8 * 60 * 60);
  assert.equal(config.port, 8080);
});
