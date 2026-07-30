/**
 * Server configuration, validated at startup (`docs/CONFIGURATION.md`
 * section 1). Secret material supports a `*_FILE` variant so it can be mounted
 * rather than exported (`docs/CONFIGURATION.md` section 7).
 */

import { readFileSync } from "node:fs";

export class ConfigurationError extends Error {}

export interface ServerConfig {
  readonly listenAddress: string;
  readonly port: number;
  readonly databaseUrl: string;
  /** Stage 0 administrator bootstrap token (`docs/ARCHITECTURE.md` §11). */
  readonly bootstrapToken: string;
  /** Credential the single Stage 0 browser worker presents to this server. */
  readonly workerCredential: string;
  /** Credential this server presents to the browser worker. */
  readonly workerCommandCredential: string;
  /** Base URL of the browser worker's internal listener. */
  readonly workerEndpoint: string;
  /** Filesystem artefact-store root (ADR-0012 default driver). */
  readonly artefactPath: string;
  readonly artefactMaxBytes: number;
  readonly workerRequestTimeoutMs: number;
}

export type Environment = Readonly<Record<string, string | undefined>>;

function secret(environment: Environment, key: string): string {
  const fileKey = `${key}_FILE`;
  const path = environment[fileKey];
  if (path !== undefined && path !== "") {
    try {
      const contents = readFileSync(path, "utf8").trim();
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
  if (value.length < 16) {
    throw new ConfigurationError(`${key} must be at least 16 characters`);
  }
  return value;
}

function text(environment: Environment, key: string, fallback: string): string {
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

export function loadServerConfig(environment: Environment = process.env): ServerConfig {
  const databaseUrl = (() => {
    const path = environment["REVIEWPLANE_DATABASE_URL_FILE"];
    if (path !== undefined && path !== "") return readFileSync(path, "utf8").trim();
    const value = environment["REVIEWPLANE_DATABASE_URL"];
    if (value === undefined || value === "") {
      throw new ConfigurationError(
        "REVIEWPLANE_DATABASE_URL is required (or REVIEWPLANE_DATABASE_URL_FILE)",
      );
    }
    return value;
  })();

  const workerEndpoint = text(environment, "REVIEWPLANE_WORKER_ENDPOINT", "http://browser-worker:8090");
  if (!/^https?:\/\/[!-~]+$/u.test(workerEndpoint)) {
    throw new ConfigurationError(
      `REVIEWPLANE_WORKER_ENDPOINT must be an http or https URL, got ${workerEndpoint}`,
    );
  }

  return {
    listenAddress: text(environment, "REVIEWPLANE_LISTEN_ADDRESS", "0.0.0.0"),
    port: integer(environment, "REVIEWPLANE_PORT", 8080, 1, 65535),
    databaseUrl,
    bootstrapToken: secret(environment, "REVIEWPLANE_BOOTSTRAP_TOKEN"),
    workerCredential: secret(environment, "REVIEWPLANE_WORKER_CREDENTIAL"),
    workerCommandCredential: secret(environment, "REVIEWPLANE_WORKER_COMMAND_CREDENTIAL"),
    workerEndpoint: workerEndpoint.replace(/\/+$/u, ""),
    artefactPath: text(environment, "REVIEWPLANE_ARTEFACT_PATH", "/var/lib/reviewplane/artefacts"),
    artefactMaxBytes: integer(
      environment,
      "REVIEWPLANE_ARTEFACT_MAX_BYTES",
      20971520,
      1024,
      104857600,
    ),
    workerRequestTimeoutMs: integer(
      environment,
      "REVIEWPLANE_WORKER_REQUEST_TIMEOUT_MS",
      150000,
      1000,
      600000,
    ),
  };
}
