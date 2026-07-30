/**
 * Configuration validation and the command-credential check
 * (`docs/CONFIGURATION.md` section 1, `docs/SECURITY.md` sections 6.4 and 10).
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConfigurationError, loadWorkerConfig } from "../src/config.ts";
import { bearerToken, credentialMatches } from "../src/http-server.ts";

const BASE = {
  REVIEWPLANE_WORKER_CREDENTIAL: "worker-credential-value",
  REVIEWPLANE_WORKER_COMMAND_CREDENTIAL: "command-credential-value",
};

test("the sandbox defaults to required", () => {
  assert.equal(loadWorkerConfig(BASE).sandbox, "required");
});

test("disabling the sandbox needs the explicit high-risk value", () => {
  assert.throws(
    () => loadWorkerConfig({ ...BASE, REVIEWPLANE_WORKER_SANDBOX: "false" }),
    ConfigurationError,
  );
  assert.equal(
    loadWorkerConfig({ ...BASE, REVIEWPLANE_WORKER_SANDBOX: "disabled_high_risk" }).sandbox,
    "disabled_high_risk",
  );
});

test("credentials have no default", () => {
  assert.throws(() => loadWorkerConfig({}), ConfigurationError);
  assert.throws(
    () => loadWorkerConfig({ REVIEWPLANE_WORKER_CREDENTIAL: "x" }),
    ConfigurationError,
  );
});

test("a credential can be mounted as a file rather than exported", () => {
  const directory = mkdtempSync(join(tmpdir(), "reviewplane-worker-"));
  const path = join(directory, "worker_credential");
  writeFileSync(path, "file-sourced-credential\n", "utf8");
  const config = loadWorkerConfig({
    REVIEWPLANE_WORKER_CREDENTIAL_FILE: path,
    REVIEWPLANE_WORKER_COMMAND_CREDENTIAL: "command-credential-value",
  });
  assert.equal(config.controlPlaneCredential, "file-sourced-credential");
});

test("an out-of-range numeric setting fails at startup rather than being clamped", () => {
  assert.throws(
    () => loadWorkerConfig({ ...BASE, REVIEWPLANE_WORKER_CAPACITY: "0" }),
    ConfigurationError,
  );
  assert.throws(
    () => loadWorkerConfig({ ...BASE, REVIEWPLANE_WORKER_SNAPSHOT_MAX_BYTES: "1048576" }),
    ConfigurationError,
  );
});

test("a default timeout above the maximum command timeout is refused", () => {
  assert.throws(
    () =>
      loadWorkerConfig({
        ...BASE,
        REVIEWPLANE_WORKER_DEFAULT_TIMEOUT_MS: "90000",
        REVIEWPLANE_WORKER_MAX_COMMAND_TIMEOUT_MS: "30000",
      }),
    ConfigurationError,
  );
});

test("a control-plane URL that is not http or https is refused", () => {
  assert.throws(
    () => loadWorkerConfig({ ...BASE, REVIEWPLANE_CONTROL_PLANE_URL: "file:///etc" }),
    ConfigurationError,
  );
});

test("a bearer header is parsed strictly", () => {
  assert.equal(bearerToken("Bearer abc123"), "abc123");
  assert.equal(bearerToken("bearer abc123"), null);
  assert.equal(bearerToken("Basic abc123"), null);
  assert.equal(bearerToken(undefined), null);
  assert.equal(bearerToken("Bearer "), null);
});

test("credential comparison rejects a prefix and a different length", () => {
  assert.equal(credentialMatches("command-credential-value", "command-credential-value"), true);
  assert.equal(credentialMatches("command-credential-valu", "command-credential-value"), false);
  assert.equal(credentialMatches("command-credential-valueX", "command-credential-value"), false);
  assert.equal(credentialMatches("", "command-credential-value"), false);
});
