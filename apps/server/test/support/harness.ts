/**
 * A running control plane backed by a real PostgreSQL, for component and
 * security tests.
 *
 * Both listeners bind to ephemeral ports on the loopback interface, so tests
 * run in parallel without colliding and nothing is exposed off the machine.
 */

import { createServer } from "node:net";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";

import { buildApp, type BuiltApp } from "../../src/app.ts";
import type { ServerConfig } from "../../src/config.ts";
import { migrate } from "../../src/db/migrate.ts";
import { createPool, type Pool } from "../../src/db/pool.ts";
import { loadConnectorModuleConfig, type ConnectorModuleConfig } from "../../src/modules/connectors/index.ts";
import { startPostgres, type TestDatabase } from "./postgres.ts";

export const BOOTSTRAP_TOKEN = "test-bootstrap-token-0123456789abcdef";

export interface LogRecord {
  readonly level: number;
  readonly msg?: string;
  readonly [key: string]: unknown;
}

export interface Harness {
  readonly pool: Pool;
  readonly built: BuiltApp;
  readonly config: ServerConfig;
  readonly connectorConfig: ConnectorModuleConfig;
  /** `http://127.0.0.1:<port>` for the human API. */
  readonly apiUrl: string;
  /** `wss://127.0.0.1:<port>` for the connector listener. */
  readonly connectorUrl: string;
  /** Path to the connector CA certificate, for `--ca-file`. */
  readonly caFile: string;
  /** Everything both Fastify instances have logged. */
  logs(): LogRecord[];
  /** Every log line as one string, for "no secrets in logs" assertions. */
  logText(): string;
  /** Restarts both listeners, keeping the database, as a control-plane restart. */
  restart(): Promise<void>;
  stop(): Promise<void>;
}

/** Collects log output so that tests can assert what is and is not in it. */
class LogCollector {
  readonly records: LogRecord[] = [];
  readonly raw: string[] = [];

  write(line: string): void {
    this.raw.push(line);
    try {
      this.records.push(JSON.parse(line) as LogRecord);
    } catch {
      // A non-JSON line is still evidence for the "no secrets in logs" test.
    }
  }

  text(): string {
    return this.raw.join("\n");
  }
}

/**
 * Reserves a free loopback port. The connector listener needs a known port
 * before it starts, because the registration response advertises it as the
 * control URL and the Go connector dials exactly that.
 */
async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not reserve a port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

function environmentFor(
  database: TestDatabase,
  connectorPort: number,
  overrides: Record<string, string>,
): Record<string, string> {
  return {
    REVIEWPLANE_DATABASE_URL: database.url,
    REVIEWPLANE_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    REVIEWPLANE_HOST: "127.0.0.1",
    REVIEWPLANE_PORT: "0",
    REVIEWPLANE_CONNECTOR_HOST: "127.0.0.1",
    REVIEWPLANE_CONNECTOR_PORT: String(connectorPort),
    REVIEWPLANE_CONNECTOR_TLS_HOSTS: "localhost,127.0.0.1",
    REVIEWPLANE_LOG_LEVEL: "debug",
    ...overrides,
  };
}

export interface HarnessOptions {
  /** Extra environment for the connector module, such as short thresholds. */
  readonly connectorEnvironment?: Record<string, string>;
  /** Reuse an already running database. */
  readonly database?: TestDatabase;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const database = options.database ?? (await startPostgres());
  const ownsDatabase = options.database === undefined;
  const collector = new LogCollector();

  const pool = createPool(database.url);
  await migrate(pool);

  const reserved = await reservePort();
  const environment = environmentFor(database, reserved, {
    REVIEWPLANE_CONNECTOR_PUBLIC_URL: `wss://127.0.0.1:${String(reserved)}`,
    ...(options.connectorEnvironment ?? {}),
  });
  const connectorConfig = loadConnectorModuleConfig(environment);
  const config: ServerConfig = {
    databaseUrl: database.url,
    bootstrapToken: BOOTSTRAP_TOKEN,
    host: "127.0.0.1",
    port: 0,
    logLevel: "debug",
  };

  let built = await buildApp({ config, pool, connectorConfig, logDestination: collector });
  await built.start();

  const directory = await mkdtemp(join(tmpdir(), "reviewplane-harness-"));
  const caFile = join(directory, "connector-ca.pem");
  await writeFile(caFile, built.connectors.authority.certificatePem, { mode: 0o600 });

  const apiPort = (): number => {
    const address = built.app.server.address();
    if (address === null || typeof address === "string") throw new Error("the API listener has no port");
    return address.port;
  };
  const connectorPort = (): number => {
    const address = built.connectors.listener.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the connector listener has no port");
    }
    return address.port;
  };

  const harness: Harness = {
    pool,
    get built() {
      return built;
    },
    config,
    connectorConfig,
    get apiUrl() {
      return `http://127.0.0.1:${String(apiPort())}`;
    },
    get connectorUrl() {
      return `wss://127.0.0.1:${String(connectorPort())}`;
    },
    caFile,
    logs: () => collector.records,
    logText: () => collector.text(),
    async restart(): Promise<void> {
      // A control-plane restart: both listeners stop and come back on the same
      // ports, so an established connector must reconnect.
      const previousConnectorPort = connectorPort();
      await built.stop();
      const restarted: ConnectorModuleConfig = { ...connectorConfig, listenPort: previousConnectorPort };
      built = await buildApp({ config, pool, connectorConfig: restarted, logDestination: collector });
      await built.start();
    },
    async stop(): Promise<void> {
      await built.stop();
      await pool.end();
      if (ownsDatabase) await database.stop();
    },
  };
  return harness;
}

export interface IssuedToken {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly maxUses: number;
}

/** Issues an enrolment token through the real administrative endpoint. */
export async function issueEnrolmentToken(
  harness: Harness,
  body: Record<string, unknown> = {},
  token: string = BOOTSTRAP_TOKEN,
): Promise<IssuedToken> {
  const response = await fetch(`${harness.apiUrl}/api/v1/connectors/enrolment-tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (response.status !== 201) {
    throw new Error(`issuing an enrolment token returned ${String(response.status)}: ${await response.text()}`);
  }
  const payload = (await response.json()) as {
    data: { id: string; enrolment_token: string; expires_at: string; max_uses: number };
  };
  return {
    id: payload.data.id,
    token: payload.data.enrolment_token,
    expiresAt: payload.data.expires_at,
    maxUses: payload.data.max_uses,
  };
}
