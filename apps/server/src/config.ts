/**
 * Environment configuration, validated at startup.
 *
 * `docs/DEVELOPMENT.md` §6 and `docs/CONFIGURATION.md` §1 require configuration
 * to be validated at startup and to fail with specific errors. Every reader
 * here names the variable it read and what it expected.
 *
 * This file holds only settings shared by the whole server. Domain settings
 * live with their module, for example
 * `src/modules/connectors/config.ts`.
 */

import { readFileSync } from "node:fs";

/** A configuration problem an operator must fix before the server can start. */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export type Environment = Record<string, string | undefined>;

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
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
}

/** Minimum bootstrap-token length. A short administrator token is guessable. */
export const MINIMUM_BOOTSTRAP_TOKEN_LENGTH = 32;

export function loadServerConfig(environment: Environment = process.env): ServerConfig {
  const bootstrapToken = requireString(environment, "REVIEWPLANE_BOOTSTRAP_TOKEN");
  if (bootstrapToken.length < MINIMUM_BOOTSTRAP_TOKEN_LENGTH) {
    throw new ConfigurationError(
      `REVIEWPLANE_BOOTSTRAP_TOKEN must be at least ${MINIMUM_BOOTSTRAP_TOKEN_LENGTH} characters`,
    );
  }
  const logLevel = (optionalString(environment, "REVIEWPLANE_LOG_LEVEL") ?? "info") as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new ConfigurationError(
      `REVIEWPLANE_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, found ${JSON.stringify(logLevel)}`,
    );
  }
  return {
    databaseUrl: requireString(environment, "REVIEWPLANE_DATABASE_URL"),
    bootstrapToken,
    host: optionalString(environment, "REVIEWPLANE_HOST") ?? "0.0.0.0",
    port: readInteger(environment, "REVIEWPLANE_PORT", 8080, { minimum: 0, maximum: 65535 }),
    logLevel,
  };
}
