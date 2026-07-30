/**
 * Server configuration, read from the environment and validated at startup.
 *
 * `docs/CONFIGURATION.md` section 1 requires validation at startup, a clear
 * failure on an invalid setting and documented defaults; section 7 requires a
 * `_FILE` form for secret material so that Compose can mount it rather than
 * putting it in an environment variable.
 *
 * Every problem is collected before the process gives up, so an operator fixes
 * one configuration rather than discovering the next fault on each restart.
 */

import { readFileSync } from "node:fs";

export interface ServerConfig {
  /** Address the HTTP API binds to. */
  readonly host: string;
  readonly port: number;
  /** PostgreSQL connection string. */
  readonly databaseUrl: string;
  /**
   * Stage 0 administrator bearer token (`docs/ARCHITECTURE.md` section 11,
   * "optional bootstrap administrator token"). Compared in constant time and
   * never logged.
   */
  readonly bootstrapToken: string;
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
  readonly logLevel: string;
}

const PREFIX = "REVIEWPLANE_";

class ConfigLoader {
  readonly #source: NodeJS.ProcessEnv;
  readonly #problems: string[] = [];

  constructor(source: NodeJS.ProcessEnv) {
    this.#source = source;
  }

  text(name: string, fallback?: string): string {
    const value = this.#source[PREFIX + name]?.trim();
    if (value !== undefined && value !== "") return value;
    if (fallback !== undefined) return fallback;
    this.#problems.push(`${PREFIX}${name} must be set`);
    return "";
  }

  number(name: string, fallback: number): number {
    const raw = this.#source[PREFIX + name]?.trim();
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
      this.#problems.push(`${PREFIX}${name} must be a positive integer`);
      return fallback;
    }
    return value;
  }

  /** Prefers the `_FILE` form, so that the material can be mounted. */
  secret(name: string, minimumLength = 1): string {
    const path = this.#source[`${PREFIX}${name}_FILE`]?.trim();
    let value: string | undefined;
    if (path !== undefined && path !== "") {
      try {
        value = readFileSync(path, "utf8").trim();
      } catch {
        this.#problems.push(`${PREFIX}${name}_FILE cannot be read`);
        return "";
      }
    } else {
      value = this.#source[PREFIX + name]?.trim();
    }
    if (value === undefined || value === "") {
      this.#problems.push(`${PREFIX}${name} or ${PREFIX}${name}_FILE must be set`);
      return "";
    }
    if (value.length < minimumLength) {
      this.#problems.push(`${PREFIX}${name} must be at least ${String(minimumLength)} characters`);
      return "";
    }
    return value;
  }

  problem(message: string): void {
    this.#problems.push(message);
  }

  finish(): void {
    if (this.#problems.length > 0) {
      throw new Error(`config: ${this.#problems.join("; ")}`);
    }
  }
}

/** Reads and validates the configuration. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): ServerConfig {
  const loader = new ConfigLoader(source);
  const capabilityKeyEncoded = loader.secret("CAPABILITY_SIGNING_KEY");
  let capabilityKey = new Uint8Array();
  if (capabilityKeyEncoded !== "") {
    capabilityKey = new Uint8Array(Buffer.from(capabilityKeyEncoded, "base64"));
    if (capabilityKey.length < 32) {
      loader.problem(`${PREFIX}CAPABILITY_SIGNING_KEY must decode to at least 32 bytes`);
    }
  }
  const config: ServerConfig = {
    host: loader.text("HOST", "0.0.0.0"),
    port: loader.number("PORT", 8080),
    databaseUrl: loader.secret("DATABASE_URL"),
    bootstrapToken: loader.secret("BOOTSTRAP_TOKEN", 32),
    gatewayControlUrl: loader.text("TUNNEL_CONTROL_URL", "http://tunnel-gateway:8445"),
    gatewayControlToken: loader.secret("TUNNEL_CONTROL_TOKEN", 32),
    internalSuffix: loader.text("INTERNAL_SUFFIX", "internal.invalid"),
    capabilityKeyId: loader.text("CAPABILITY_KEY_ID", "stage0-a"),
    capabilityKey,
    capabilityTtlSeconds: loader.number("CAPABILITY_TTL_SECONDS", 300),
    routeTtlMaxSeconds: loader.number("ROUTE_TTL_MAX_SECONDS", 8 * 60 * 60),
    logLevel: loader.text("LOG_LEVEL", "info"),
  };
  loader.finish();
  return config;
}
