/**
 * Worker configuration, validated at startup.
 *
 * `docs/CONFIGURATION.md` section 1 requires validation at startup and a clear
 * failure on an invalid setting, and section 7 requires `*_FILE` support for
 * secret material so a credential never has to sit in an ordinary environment
 * variable. Nothing here has a silent default that weakens isolation: the
 * Chromium sandbox setting is `required` unless an operator writes an explicit
 * high-risk value, and the credentials have no defaults at all.
 */

import { readFileSync } from "node:fs";

export class ConfigurationError extends Error {}

export type SandboxMode = "required" | "disabled_high_risk";

export interface WorkerConfig {
  /** Operator-assigned worker name (`docs/CONFIGURATION.md` section 3). */
  readonly name: string;
  readonly listenAddress: string;
  readonly port: number;
  /** Concurrent browser sessions accepted before `BROWSER_CAPACITY_EXHAUSTED`. */
  readonly capacity: number;
  readonly labels: readonly string[];
  readonly sandbox: SandboxMode;
  /** Root under which each session's ephemeral profile directory is created. */
  readonly sessionRoot: string;
  /** Base URL of the control-plane API, used for artefact upload and status. */
  readonly controlPlaneUrl: string;
  /** Credential the worker presents to the control plane. */
  readonly controlPlaneCredential: string;
  /** Credential the control plane must present to this worker. */
  readonly commandCredential: string;
  readonly defaultTimeoutMs: number;
  readonly maxCommandTimeoutMs: number;
  readonly maxSessionDurationSeconds: number;
  readonly screenshotMaxBytes: number;
  readonly snapshotMaxNodes: number;
  readonly snapshotMaxBytes: number;
  /** Whether to register with the control plane on start. */
  readonly registerOnStart: boolean;
  readonly heartbeatIntervalSeconds: number;
}

export type Environment = Readonly<Record<string, string | undefined>>;

function requiredValue(environment: Environment, key: string): string {
  const fileKey = `${key}_FILE`;
  const filePath = environment[fileKey];
  if (filePath !== undefined && filePath !== "") {
    try {
      const contents = readFileSync(filePath, "utf8").trim();
      if (contents === "") throw new ConfigurationError(`${fileKey} names an empty file`);
      return contents;
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;
      throw new ConfigurationError(`${fileKey} could not be read: ${String(error)}`);
    }
  }
  const value = environment[key];
  if (value === undefined || value === "") {
    throw new ConfigurationError(`${key} is required (or ${fileKey} naming a secret file)`);
  }
  return value;
}

function optionalString(environment: Environment, key: string, fallback: string): string {
  const value = environment[key];
  return value === undefined || value === "" ? fallback : value;
}

function integer(
  environment: Environment,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(
      `${key} must be an integer between ${String(minimum)} and ${String(maximum)}, got ${raw}`,
    );
  }
  return value;
}

const WORKER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

export function loadWorkerConfig(environment: Environment = process.env): WorkerConfig {
  const name = optionalString(environment, "REVIEWPLANE_WORKER_NAME", "browser-worker-01");
  if (!WORKER_NAME_PATTERN.test(name)) {
    throw new ConfigurationError(
      `REVIEWPLANE_WORKER_NAME must match ${String(WORKER_NAME_PATTERN)}, got ${name}`,
    );
  }

  const sandboxRaw = optionalString(environment, "REVIEWPLANE_WORKER_SANDBOX", "required");
  if (sandboxRaw !== "required" && sandboxRaw !== "disabled_high_risk") {
    throw new ConfigurationError(
      "REVIEWPLANE_WORKER_SANDBOX must be required, or disabled_high_risk to acknowledge the " +
        "unsupported configuration warning of docs/SECURITY.md section 10",
    );
  }

  const labels = optionalString(environment, "REVIEWPLANE_WORKER_LABELS", "chromium")
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label !== "");
  for (const label of labels) {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(label)) {
      throw new ConfigurationError(`REVIEWPLANE_WORKER_LABELS holds an invalid label: ${label}`);
    }
  }

  const controlPlaneUrl = optionalString(
    environment,
    "REVIEWPLANE_CONTROL_PLANE_URL",
    "http://server:8080",
  );
  if (!/^https?:\/\/[!-~]+$/u.test(controlPlaneUrl)) {
    throw new ConfigurationError(
      `REVIEWPLANE_CONTROL_PLANE_URL must be an http or https URL, got ${controlPlaneUrl}`,
    );
  }

  const defaultTimeoutMs = integer(environment, "REVIEWPLANE_WORKER_DEFAULT_TIMEOUT_MS", 30000, 100, 120000);
  const maxCommandTimeoutMs = integer(
    environment,
    "REVIEWPLANE_WORKER_MAX_COMMAND_TIMEOUT_MS",
    120000,
    100,
    120000,
  );
  if (defaultTimeoutMs > maxCommandTimeoutMs) {
    throw new ConfigurationError(
      "REVIEWPLANE_WORKER_DEFAULT_TIMEOUT_MS must not exceed REVIEWPLANE_WORKER_MAX_COMMAND_TIMEOUT_MS",
    );
  }

  return {
    name,
    listenAddress: optionalString(environment, "REVIEWPLANE_WORKER_LISTEN_ADDRESS", "127.0.0.1"),
    port: integer(environment, "REVIEWPLANE_WORKER_PORT", 8090, 1, 65535),
    capacity: integer(environment, "REVIEWPLANE_WORKER_CAPACITY", 4, 1, 64),
    labels,
    sandbox: sandboxRaw,
    sessionRoot: optionalString(
      environment,
      "REVIEWPLANE_WORKER_SESSION_ROOT",
      "/var/lib/reviewplane/browser-sessions",
    ),
    controlPlaneUrl: controlPlaneUrl.replace(/\/+$/u, ""),
    controlPlaneCredential: requiredValue(environment, "REVIEWPLANE_WORKER_CREDENTIAL"),
    commandCredential: requiredValue(environment, "REVIEWPLANE_WORKER_COMMAND_CREDENTIAL"),
    defaultTimeoutMs,
    maxCommandTimeoutMs,
    maxSessionDurationSeconds: integer(
      environment,
      "REVIEWPLANE_WORKER_SESSION_DURATION_SECONDS",
      7200,
      60,
      28800,
    ),
    screenshotMaxBytes: integer(
      environment,
      "REVIEWPLANE_WORKER_SCREENSHOT_MAX_BYTES",
      20971520,
      65536,
      20971520,
    ),
    snapshotMaxNodes: integer(environment, "REVIEWPLANE_WORKER_SNAPSHOT_MAX_NODES", 400, 1, 500),
    snapshotMaxBytes: integer(
      environment,
      "REVIEWPLANE_WORKER_SNAPSHOT_MAX_BYTES",
      32768,
      1024,
      65536,
    ),
    registerOnStart:
      optionalString(environment, "REVIEWPLANE_WORKER_REGISTER_ON_START", "true") !== "false",
    heartbeatIntervalSeconds: integer(
      environment,
      "REVIEWPLANE_WORKER_HEARTBEAT_SECONDS",
      15,
      5,
      300,
    ),
  };
}
