/**
 * Environment configuration, validated at startup.
 *
 * `docs/DEVELOPMENT.md` §6 and `docs/CONFIGURATION.md` §1 require configuration
 * to be validated at startup and to fail with specific errors; §7 requires a
 * `_FILE` form for secret material so that Compose can mount it rather than
 * exporting it. Every reader here names the variable it read and what it
 * expected, and every problem is collected before the process gives up, so an
 * operator fixes one configuration rather than discovering the next fault on
 * each restart.
 *
 * This file holds only settings shared by the whole server. Domain settings
 * live with their module, for example `src/modules/connectors/config.ts`.
 */

import { readFileSync } from "node:fs";

/** A configuration problem an operator must fix before the server can start. */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Reads a required value, supporting the `*_FILE` indirection that
 * `docs/CONFIGURATION.md` §7 prefers for secret material.
 */
export function requireString(environment: Environment, name: string): string {
  const fromFile = environment[`${name}_FILE`];
  if (fromFile !== undefined && fromFile !== "") {
    try {
      const contents = readFileSync(fromFile, "utf8").trim();
      if (contents === "") throw new ConfigurationError(`${name}_FILE (${fromFile}) is empty`);
      return contents;
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;
      throw new ConfigurationError(`${name}_FILE (${fromFile}) could not be read: ${String(error)}`);
    }
  }
  const value = environment[name];
  if (value === undefined || value.trim() === "") {
    throw new ConfigurationError(`${name} is required (or ${name}_FILE naming a file that holds it)`);
  }
  return value.trim();
}

export function optionalString(environment: Environment, name: string): string | undefined {
  const value = environment[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

export function readInteger(
  environment: Environment,
  name: string,
  fallback: number,
  bounds: { readonly minimum: number; readonly maximum: number },
): number {
  const raw = optionalString(environment, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new ConfigurationError(`${name} must be an integer, found ${JSON.stringify(raw)}`);
  }
  if (value < bounds.minimum || value > bounds.maximum) {
    throw new ConfigurationError(
      `${name} must be between ${bounds.minimum} and ${bounds.maximum}, found ${value}`,
    );
  }
  return value;
}

export function readList(environment: Environment, name: string, fallback: readonly string[]): string[] {
  const raw = optionalString(environment, name);
  if (raw === undefined) return [...fallback];
  const values = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (values.length === 0) throw new ConfigurationError(`${name} must list at least one value`);
  return values;
}

/** Reads a secret and enforces a minimum length. Short secrets are guessable. */
export function requireSecret(environment: Environment, name: string, minimumLength: number): string {
  const value = requireString(environment, name);
  if (value.length < minimumLength) {
    throw new ConfigurationError(`${name} must be at least ${minimumLength} characters`);
  }
  return value;
}

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** A structured-log sink. Pino accepts any object with a `write` method. */
export interface LogDestination {
  write(line: string): void;
}

export interface ServerConfig {
  readonly databaseUrl: string;
  /**
   * The Stage 0 bootstrap administrator token. `docs/ARCHITECTURE.md` §11
   * permits it while multi-user authentication is not yet built. It is compared
   * in constant time and never logged.
   */
  readonly bootstrapToken: string;
  /** Address the HTTP API binds to. */
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
  /** Base URL of the tunnel gateway's control API. */
  readonly gatewayControlUrl: string;
  /** Bearer token for that API. */
  readonly gatewayControlToken: string;
  /** Domain the internal origin lives under. */
  readonly internalSuffix: string;
  /** Key identifier the control plane signs new capabilities with. */
  readonly capabilityKeyId: string;
  /** Signing key for that identifier. */
  readonly capabilityKey: Uint8Array;
  /** Default capability lifetime in seconds. */
  readonly capabilityTtlSeconds: number;
  /** Longest route lifetime a publication may request, in seconds. */
  readonly routeTtlMaxSeconds: number;
  /** Credential the Stage 0 browser worker presents to this server. */
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

/** Minimum bootstrap-token length. A short administrator token is guessable. */
export const MINIMUM_BOOTSTRAP_TOKEN_LENGTH = 32;

/** Minimum length of a machine-to-machine credential. */
export const MINIMUM_SERVICE_CREDENTIAL_LENGTH = 16;

/** Minimum decoded length of a capability signing key. */
export const MINIMUM_CAPABILITY_KEY_BYTES = 32;

/**
 * Collects configuration problems so that all of them are reported together.
 *
 * Each reader throws on the first fault it finds; `attempt` turns that into a
 * recorded problem and a placeholder, so the loader can carry on and name every
 * setting an operator has to fix.
 */
class Problems {
  readonly #messages: string[] = [];

  attempt<T>(read: () => T, fallback: T): T {
    try {
      return read();
    } catch (error) {
      if (error instanceof ConfigurationError) {
        this.#messages.push(error.message);
        return fallback;
      }
      throw error;
    }
  }

  add(message: string): void {
    this.#messages.push(message);
  }

  finish(): void {
    if (this.#messages.length > 0) {
      throw new ConfigurationError(`configuration is invalid: ${this.#messages.join("; ")}`);
    }
  }
}

export function loadServerConfig(environment: Environment = process.env): ServerConfig {
  const problems = new Problems();

  const logLevel = problems.attempt<LogLevel>(() => {
    const value = (optionalString(environment, "REVIEWPLANE_LOG_LEVEL") ?? "info") as LogLevel;
    if (!LOG_LEVELS.includes(value)) {
      throw new ConfigurationError(
        `REVIEWPLANE_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, found ${JSON.stringify(value)}`,
      );
    }
    return value;
  }, "info");

  const capabilityKey = problems.attempt<Uint8Array>(() => {
    const encoded = requireString(environment, "REVIEWPLANE_CAPABILITY_SIGNING_KEY");
    const decoded = new Uint8Array(Buffer.from(encoded, "base64"));
    if (decoded.length < MINIMUM_CAPABILITY_KEY_BYTES) {
      throw new ConfigurationError(
        `REVIEWPLANE_CAPABILITY_SIGNING_KEY must decode to at least ${MINIMUM_CAPABILITY_KEY_BYTES} bytes`,
      );
    }
    return decoded;
  }, new Uint8Array());

  const workerEndpoint = problems.attempt(() => {
    const value = optionalString(environment, "REVIEWPLANE_WORKER_ENDPOINT") ?? "http://browser-worker:8090";
    if (!/^https?:\/\/[!-~]+$/u.test(value)) {
      throw new ConfigurationError(
        `REVIEWPLANE_WORKER_ENDPOINT must be an http or https URL, found ${JSON.stringify(value)}`,
      );
    }
    return value.replace(/\/+$/u, "");
  }, "http://browser-worker:8090");

  const config: ServerConfig = {
    databaseUrl: problems.attempt(() => requireString(environment, "REVIEWPLANE_DATABASE_URL"), ""),
    bootstrapToken: problems.attempt(
      () => requireSecret(environment, "REVIEWPLANE_BOOTSTRAP_TOKEN", MINIMUM_BOOTSTRAP_TOKEN_LENGTH),
      "",
    ),
    host: optionalString(environment, "REVIEWPLANE_HOST") ?? "0.0.0.0",
    port: problems.attempt(
      () => readInteger(environment, "REVIEWPLANE_PORT", 8080, { minimum: 0, maximum: 65535 }),
      8080,
    ),
    logLevel,
    gatewayControlUrl:
      optionalString(environment, "REVIEWPLANE_TUNNEL_CONTROL_URL") ?? "http://tunnel-gateway:8445",
    gatewayControlToken: problems.attempt(
      () => requireSecret(environment, "REVIEWPLANE_TUNNEL_CONTROL_TOKEN", 32),
      "",
    ),
    internalSuffix: optionalString(environment, "REVIEWPLANE_INTERNAL_SUFFIX") ?? "internal.invalid",
    capabilityKeyId: optionalString(environment, "REVIEWPLANE_CAPABILITY_KEY_ID") ?? "stage0-a",
    capabilityKey,
    capabilityTtlSeconds: problems.attempt(
      () =>
        readInteger(environment, "REVIEWPLANE_CAPABILITY_TTL_SECONDS", 300, {
          minimum: 1,
          maximum: 86_400,
        }),
      300,
    ),
    routeTtlMaxSeconds: problems.attempt(
      () =>
        readInteger(environment, "REVIEWPLANE_ROUTE_TTL_MAX_SECONDS", 8 * 60 * 60, {
          minimum: 1,
          maximum: 86_400,
        }),
      8 * 60 * 60,
    ),
    workerCredential: problems.attempt(
      () =>
        requireSecret(environment, "REVIEWPLANE_WORKER_CREDENTIAL", MINIMUM_SERVICE_CREDENTIAL_LENGTH),
      "",
    ),
    workerCommandCredential: problems.attempt(
      () =>
        requireSecret(
          environment,
          "REVIEWPLANE_WORKER_COMMAND_CREDENTIAL",
          MINIMUM_SERVICE_CREDENTIAL_LENGTH,
        ),
      "",
    ),
    workerEndpoint,
    artefactPath:
      optionalString(environment, "REVIEWPLANE_ARTEFACT_PATH") ?? "/var/lib/reviewplane/artefacts",
    artefactMaxBytes: problems.attempt(
      () =>
        readInteger(environment, "REVIEWPLANE_ARTEFACT_MAX_BYTES", 20_971_520, {
          minimum: 1024,
          maximum: 104_857_600,
        }),
      20_971_520,
    ),
    workerRequestTimeoutMs: problems.attempt(
      () =>
        readInteger(environment, "REVIEWPLANE_WORKER_REQUEST_TIMEOUT_MS", 150_000, {
          minimum: 1000,
          maximum: 600_000,
        }),
      150_000,
    ),
  };

  problems.finish();
  return config;
}
