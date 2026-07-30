/**
 * A complete `ServerConfig` for tests.
 *
 * Every harness needs the whole shape, and repeating it in each of them means a
 * new setting has to be added in several places before anything compiles again.
 * The defaults here are deliberately inert: the gateway and worker endpoints are
 * unroutable, so a test that reaches one fails rather than talking to something
 * real, and the capability key is a fixed test key that signs nothing else.
 */

import type { ServerConfig } from "../../src/config.ts";

export const TEST_BOOTSTRAP_TOKEN = "bootstrap-administrator-token-for-tests";
export const TEST_WORKER_CREDENTIAL = "worker-credential-for-tests";
export const TEST_WORKER_COMMAND_CREDENTIAL = "worker-command-credential-tests";

/**
 * The capability signing key the tests use.
 *
 * It is exported so that a test can verify a capability the server minted with
 * the same keyring the tunnel gateway would use, rather than trusting the
 * server's own claim that it signed one.
 */
export const TEST_CAPABILITY_KEY_ID = "test-a";
export const TEST_CAPABILITY_KEY = new Uint8Array(32).fill(7);

export function testServerConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    databaseUrl: "unused-in-tests",
    bootstrapToken: TEST_BOOTSTRAP_TOKEN,
    host: "127.0.0.1",
    port: 0,
    logLevel: "silent",
    gatewayControlUrl: "http://tunnel-gateway.invalid:8445",
    gatewayControlToken: "test-gateway-control-token-0123456789",
    internalSuffix: "internal.invalid",
    capabilityKeyId: TEST_CAPABILITY_KEY_ID,
    capabilityKey: TEST_CAPABILITY_KEY,
    capabilityTtlSeconds: 300,
    routeTtlMaxSeconds: 8 * 60 * 60,
    workerCredential: TEST_WORKER_CREDENTIAL,
    workerCommandCredential: TEST_WORKER_COMMAND_CREDENTIAL,
    workerEndpoint: "http://browser-worker.invalid",
    artefactPath: "/nonexistent-artefact-root",
    artefactMaxBytes: 20_971_520,
    workerRequestTimeoutMs: 5000,
    // Same-origin only, which is what a gateway deployment has, and plain HTTP
    // in tests, so the viewer cookie is not marked Secure.
    allowedOrigins: [],
    secureCookies: false,
    ...overrides,
  };
}
