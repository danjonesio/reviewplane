/**
 * Unit layer: the Stage 0 administrator credential and the stable error
 * vocabulary.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { credentialMatches } from "../src/auth.ts";
import { loadServerConfig } from "../src/config.ts";
import { API_ERROR_CODES, isStableErrorCode } from "../src/errors.ts";

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
    () => loadServerConfig({}),
    (error: unknown) => {
      const message = String(error);
      for (const setting of [
        "DATABASE_URL",
        "BOOTSTRAP_TOKEN",
        "CAPABILITY_SIGNING_KEY",
        "WORKER_CREDENTIAL",
        "WORKER_COMMAND_CREDENTIAL",
      ]) {
        assert.ok(message.includes(setting), `the failure does not name ${setting}`);
      }
      return true;
    },
  );
});

/** Every required setting, at its documented minimum strength. */
const COMPLETE_ENVIRONMENT = {
  REVIEWPLANE_DATABASE_URL: "postgres://localhost/reviewplane",
  REVIEWPLANE_BOOTSTRAP_TOKEN: "a".repeat(40),
  REVIEWPLANE_TUNNEL_CONTROL_TOKEN: "b".repeat(40),
  REVIEWPLANE_CAPABILITY_SIGNING_KEY: Buffer.alloc(32).toString("base64"),
  REVIEWPLANE_WORKER_CREDENTIAL: "c".repeat(32),
  REVIEWPLANE_WORKER_COMMAND_CREDENTIAL: "d".repeat(32),
};

test("a short credential or signing key is refused", () => {
  assert.doesNotThrow(() => loadServerConfig(COMPLETE_ENVIRONMENT));
  for (const weakened of [
    { REVIEWPLANE_BOOTSTRAP_TOKEN: "short" },
    { REVIEWPLANE_TUNNEL_CONTROL_TOKEN: "short" },
    { REVIEWPLANE_WORKER_CREDENTIAL: "short" },
    { REVIEWPLANE_WORKER_COMMAND_CREDENTIAL: "short" },
    { REVIEWPLANE_CAPABILITY_SIGNING_KEY: Buffer.alloc(16).toString("base64") },
  ]) {
    assert.throws(
      () => loadServerConfig({ ...COMPLETE_ENVIRONMENT, ...weakened }),
      `${Object.keys(weakened)[0] ?? ""} was accepted`,
    );
  }
});

test("an unroutable worker endpoint is refused", () => {
  assert.throws(() =>
    loadServerConfig({ ...COMPLETE_ENVIRONMENT, REVIEWPLANE_WORKER_ENDPOINT: "browser-worker:8090" }),
  );
});

test("defaults are the documented ones", () => {
  const config = loadServerConfig(COMPLETE_ENVIRONMENT);
  assert.equal(config.internalSuffix, "internal.invalid");
  assert.equal(config.capabilityTtlSeconds, 300);
  assert.equal(config.routeTtlMaxSeconds, 8 * 60 * 60);
  assert.equal(config.port, 8080);
  assert.equal(config.workerEndpoint, "http://browser-worker:8090");
  assert.equal(config.artefactPath, "/var/lib/reviewplane/artefacts");
});
