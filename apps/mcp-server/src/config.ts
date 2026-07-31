/**
 * MCP-server configuration (`docs/CONFIGURATION.md` section 1).
 *
 * The MCP server is a separate process from the control-plane API and shares
 * its image (`docs/ARCHITECTURE.md` section 4.4), so it reads the same secret
 * files by the same names. It deliberately does **not** read
 * `REVIEWPLANE_BOOTSTRAP_TOKEN`: the agent-facing process has no use for an
 * administrator credential, and a process that cannot read one cannot leak one.
 */

import { readFileSync } from "node:fs";

export class ConfigurationError extends Error {}

export interface McpServerConfig {
  readonly listenAddress: string;
  readonly port: number;
  readonly databaseUrl: string;
  /** Credential this process presents to the browser worker. */
  readonly workerCommandCredential: string;
  readonly workerEndpoint: string;
  readonly workerRequestTimeoutMs: number;
  /** Filesystem artefact-store root (ADR-0012 default driver). */
  readonly artefactPath: string;
  readonly artefactMaxBytes: number;
  /**
   * Path prefix the control-plane API is reachable at, used to build the
   * `content_path` an agent fetches evidence from. It is a path and not an
   * origin: the gateway serves both processes, so an agent uses the same origin
   * it is already talking to.
   */
  readonly apiPathPrefix: string;
  /** Route the MCP endpoint is served on (`docs/API.md` section 3). */
  readonly mcpPath: string;
  /**
   * The tunnel gateway's control listener, for the published-service tools of
   * `docs/MCP_SPEC.md` section 7.2.
   *
   * Revocation must reach the gateway to be a revocation at all: the gateway
   * verifies a capability from its signature without a database read, so a
   * record marked revoked while the gateway still carried the route would be a
   * revocation of nothing. Publication does not need this listener — the `api`
   * process finishes a requested route (ADR-0021) — but withdrawal does, and it
   * must be immediate.
   */
  readonly tunnelControlUrl: string;
  readonly tunnelControlToken: string;
  /** Suffix the internal route origin is built from (`docs/ARCHITECTURE.md` section 7.3). */
  readonly internalSuffix: string;
  /** Longest route lifetime this deployment permits. */
  readonly routeTtlMaxSeconds: number;
  /**
   * How long `development_service_publish` waits for a requested route to
   * become `ready` or `failed`.
   *
   * It is bounded, and it ends in the record as it stands rather than in a
   * timeout: `docs/CONNECTOR_PROTOCOL.md` section 11 gives the connector a ten
   * second startup grace, so a wait shorter than that would report `requested`
   * for a route that was about to work.
   */
  readonly publishWaitMs: number;
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
  if (value.length < 16) throw new ConfigurationError(`${key} must be at least 16 characters`);
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

export function loadMcpServerConfig(environment: Environment = process.env): McpServerConfig {
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

  const workerEndpoint = text(
    environment,
    "REVIEWPLANE_WORKER_ENDPOINT",
    "http://browser-worker:8090",
  );
  if (!/^https?:\/\/[!-~]+$/u.test(workerEndpoint)) {
    throw new ConfigurationError(
      `REVIEWPLANE_WORKER_ENDPOINT must be an http or https URL, got ${workerEndpoint}`,
    );
  }

  const mcpPath = text(environment, "REVIEWPLANE_MCP_PATH", "/mcp/v1");
  if (!mcpPath.startsWith("/mcp/")) {
    // docs/API.md section 3 reserves `/mcp/...` for the agent endpoint. Serving
    // it anywhere else would put the agent surface behind a gateway rule
    // written for the human API.
    throw new ConfigurationError(`REVIEWPLANE_MCP_PATH must start with /mcp/, got ${mcpPath}`);
  }

  return {
    listenAddress: text(environment, "REVIEWPLANE_MCP_LISTEN_ADDRESS", "0.0.0.0"),
    port: integer(environment, "REVIEWPLANE_MCP_PORT", 8081, 1, 65535),
    databaseUrl,
    workerCommandCredential: secret(environment, "REVIEWPLANE_WORKER_COMMAND_CREDENTIAL"),
    workerEndpoint: workerEndpoint.replace(/\/+$/u, ""),
    workerRequestTimeoutMs: integer(
      environment,
      "REVIEWPLANE_WORKER_REQUEST_TIMEOUT_MS",
      150000,
      1000,
      600000,
    ),
    artefactPath: text(environment, "REVIEWPLANE_ARTEFACT_PATH", "/var/lib/reviewplane/artefacts"),
    artefactMaxBytes: integer(
      environment,
      "REVIEWPLANE_ARTEFACT_MAX_BYTES",
      20971520,
      1024,
      104857600,
    ),
    apiPathPrefix: text(environment, "REVIEWPLANE_API_PATH_PREFIX", "/api/v1").replace(/\/+$/u, ""),
    mcpPath: mcpPath.replace(/\/+$/u, ""),
    tunnelControlUrl: text(
      environment,
      "REVIEWPLANE_TUNNEL_CONTROL_URL",
      "http://tunnel-gateway:8445",
    ).replace(/\/+$/u, ""),
    tunnelControlToken: secret(environment, "REVIEWPLANE_TUNNEL_CONTROL_TOKEN"),
    internalSuffix: text(environment, "REVIEWPLANE_INTERNAL_SUFFIX", "internal.invalid"),
    routeTtlMaxSeconds: integer(environment, "REVIEWPLANE_ROUTE_TTL_MAX_SECONDS", 28800, 60, 86400),
    publishWaitMs: integer(environment, "REVIEWPLANE_MCP_PUBLISH_WAIT_MS", 15000, 1000, 60000),
  };
}
