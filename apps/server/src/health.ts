/**
 * Health and version endpoints (`docs/OPERATIONS.md` section 2,
 * `docs/ARCHITECTURE.md` section 15).
 *
 * ```text
 * /health/live    should this process be restarted?
 * /health/ready   can it safely receive new work?
 * /version        what is running?
 * ```
 *
 * The distinction is the whole value of having two. Liveness asks only whether
 * the process is still itself, so it touches nothing external: a database outage
 * must not cause an orchestrator to kill every API container, which is precisely
 * what a liveness probe that queried PostgreSQL would do.
 *
 * Readiness asks whether this process can serve correctly, and
 * `docs/DEPLOYMENT.md` section 11 fixes one of its answers: readiness MUST fail
 * when required migrations are missing. A process whose code expects a column
 * the database does not have would otherwise take traffic and fail request by
 * request, which is worse than reporting itself unready and being left out of
 * the rotation.
 *
 * This module is registered by every process role — `api`, `mcp` and `jobs` —
 * from one definition, because three roles answering the same three routes in
 * three slightly different shapes is how an operator's dashboard comes to mean
 * different things for different containers. The `api` and `mcp` roles register
 * it on the listener they already have; the `jobs` role has no other listener
 * and opens one for these routes alone (`src/cli.ts`).
 */

import type { FastifyInstance } from "fastify";

import type { Pool } from "./db/pool.ts";
import { migrationState, MIGRATIONS_DIRECTORY } from "./db/migrate.ts";

/** Process roles of `docs/ARCHITECTURE.md` section 4.2. */
export const PROCESS_ROLES = ["api", "mcp", "jobs"] as const;

export type ProcessRole = (typeof PROCESS_ROLES)[number];

/**
 * The build this process is running.
 *
 * Read from the environment because a container image is what carries the
 * answer: the git revision and the build time are stamped in at image build,
 * and a value the source could compute would only ever describe the source.
 */
export interface BuildInfo {
  readonly version: string;
  readonly revision: string;
  readonly builtAt: string;
}

export function readBuildInfo(environment: NodeJS.ProcessEnv = process.env): BuildInfo {
  return {
    version: environment["REVIEWPLANE_VERSION"] ?? "0.0.0-dev",
    revision: environment["REVIEWPLANE_REVISION"] ?? "unknown",
    builtAt: environment["REVIEWPLANE_BUILT_AT"] ?? "unknown",
  };
}

export interface HealthRoutesOptions {
  readonly role: ProcessRole;
  readonly pool: Pool;
  readonly build?: BuildInfo;
  readonly migrationsDirectory?: string;
  /**
   * Extra readiness checks the role owns. The `jobs` role adds its runner, and
   * a role with nothing to add passes none: a check that always returns true
   * would say nothing and would still have to be read.
   */
  readonly checks?: readonly ReadinessCheck[];
}

export interface ReadinessCheck {
  readonly name: string;
  run(): Promise<{ readonly ready: boolean; readonly detail?: string }>;
}

interface ReadinessReport {
  readonly status: "ready" | "not_ready";
  readonly role: ProcessRole;
  readonly checks: Record<string, { status: "pass" | "fail"; detail?: string }>;
  readonly schema_version: string | null;
  readonly pending_migrations: number;
}

export function registerHealthRoutes(app: FastifyInstance, options: HealthRoutesOptions): void {
  const build = options.build ?? readBuildInfo();
  const directory = options.migrationsDirectory ?? MIGRATIONS_DIRECTORY;

  // Liveness touches nothing but this process. A dependency outage must not be
  // reported as "restart me": restarting would not fix it and would remove the
  // process that is about to recover.
  app.get("/health/live", async () => ({ status: "live", role: options.role }));

  app.get("/health/ready", async (_request, reply) => {
    const checks: Record<string, { status: "pass" | "fail"; detail?: string }> = {};
    let ready = true;
    let schemaVersion: string | null = null;
    let pending = 0;

    try {
      const state = await migrationState(options.pool, directory);
      schemaVersion = state.schemaVersion;
      pending = state.pending.length;
      if (pending > 0) {
        ready = false;
        checks["migrations"] = {
          status: "fail",
          // The names, not just the count: an operator reading this is deciding
          // whether to run `reviewplane migrate`, and the file names are what
          // they will look for in the repository.
          detail: `${String(pending)} pending: ${state.pending.slice(0, 5).join(", ")}`,
        };
      } else {
        checks["migrations"] = { status: "pass" };
      }
      checks["database"] = { status: "pass" };
    } catch (error) {
      ready = false;
      checks["database"] = { status: "fail", detail: describeFailure(error) };
      checks["migrations"] = { status: "fail", detail: "the schema state could not be read" };
    }

    for (const check of options.checks ?? []) {
      try {
        const result = await check.run();
        checks[check.name] = result.ready
          ? { status: "pass", ...(result.detail === undefined ? {} : { detail: result.detail }) }
          : { status: "fail", ...(result.detail === undefined ? {} : { detail: result.detail }) };
        if (!result.ready) ready = false;
      } catch (error) {
        checks[check.name] = { status: "fail", detail: describeFailure(error) };
        ready = false;
      }
    }

    const body: ReadinessReport = {
      status: ready ? "ready" : "not_ready",
      role: options.role,
      checks,
      schema_version: schemaVersion,
      pending_migrations: pending,
    };
    return reply.code(ready ? 200 : 503).send(body);
  });

  app.get("/version", async () => ({
    version: build.version,
    revision: build.revision,
    built_at: build.builtAt,
    role: options.role,
    protocol_version: 1,
  }));
}

/**
 * Socket and resolver failure codes whose operand is a network address.
 *
 * Anchoring on these rather than trying to recognise an address anywhere in
 * arbitrary text is deliberate: the shape `<syscall> <CODE> <address>` is what
 * Node's `net` and `dns` layers emit and what the PostgreSQL driver passes
 * through unchanged, and a rule that matched addresses in free text would
 * eventually mangle a message that merely looked like one.
 */
const ADDRESS_BEARING_CODES = [
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EHOSTDOWN",
  "EADDRNOTAVAIL",
  "ETIMEDOUT",
  "ECONNRESET",
] as const;

const ADDRESS_OPERAND = new RegExp(`\\b(${ADDRESS_BEARING_CODES.join("|")})\\s+\\S+`, "gu");

/**
 * Renders a failure for an operator without echoing a connection string, a
 * credential, a network address or a stack trace (`docs/SECURITY.md`
 * section 18).
 *
 * The address matters as well as the credential. `/health/ready` is the least
 * protected endpoint the process serves — a probe reaches it without
 * authenticating — and a driver's message routinely names the host it failed to
 * reach, with a port (`connect ECONNREFUSED 10.0.3.7:5432`) or without one
 * (`getaddrinfo ENOTFOUND db-primary.internal`). That is internal topology, and
 * an unauthenticated caller learning where the database lives is a disclosure
 * even though it is not a secret.
 *
 * Two properties survive the scrubbing, and both are load-bearing: no
 * credential reaches the response, and the **failure class** does. An operator
 * diagnosing this needs to know that the name did not resolve rather than that
 * the port refused the connection; the address itself is in their own
 * configuration.
 */
export function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const maximum = 200;
  const scrubbed = message
    // A connection string, which carries the credential as well as the address.
    .replaceAll(/(postgres(?:ql)?:\/\/)[^\s"']+/giu, "$1[redacted]")
    // The operand of a socket or resolver failure: a host, with or without a
    // port, in IPv4, bracketed IPv6 or hostname form.
    .replaceAll(ADDRESS_OPERAND, "$1 [address redacted]")
    // Belt and braces for an address quoted outside that shape. Both forms are
    // unambiguous: a dotted or bracketed host followed by a port.
    .replaceAll(/\[[0-9A-Fa-f:]+\]:\d{1,5}/gu, "[address redacted]")
    .replaceAll(/\b(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}\b/gu, "[address redacted]")
    .replaceAll(/\b[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+:\d{1,5}\b/gu, "[address redacted]");
  return scrubbed.length > maximum ? `${scrubbed.slice(0, maximum)}...` : scrubbed;
}
