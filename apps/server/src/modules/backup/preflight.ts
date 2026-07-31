/**
 * The upgrade preflight (`docs/OPERATIONS.md` §12, `docs/DEPLOYMENT.md` §15
 * step 5).
 *
 * Six checks, in the order the document lists them, and every one of them
 * reported — including the ones that passed. A preflight that printed only its
 * problems would be a preflight an operator could not tell from one that never
 * ran, and the report is the evidence the upgrade sequence was followed.
 *
 * The distinction between `fail` and `warn` is the whole interface. `fail` is
 * "this upgrade would not work or would not be recoverable": no backup to roll
 * back to, no disk to migrate into, another process already migrating, a
 * database this build cannot read. `warn` is "this will work and you should
 * know": a connector that will be told to upgrade, a browser worker running a
 * different build, a backup that is older than the window. Nothing is silently
 * omitted, because a missing check reads as a check that passed.
 */

import { statfs } from "node:fs/promises";

import type {
  CompatibilityCheck,
  CompatibilityReport,
  CompatibilityStatus,
} from "@reviewplane/protocol/platform";

import {
  listMigrations,
  migrationState,
  MIGRATION_LOCK_KEY,
  MIGRATIONS_DIRECTORY,
} from "../../db/migrate.ts";
import type { Pool } from "../../db/pool.ts";
import { classifyUpgrade } from "../connectors/reconciliation.ts";
import { readBuildInfo } from "../../health.ts";
import { BACKUP_CREATED_EVENT } from "./backup.ts";

/** How old a backup may be before the preflight says so. */
export const DEFAULT_BACKUP_MAX_AGE_HOURS = 24;

/** Free space below which a migration is refused outright. */
export const MINIMUM_FREE_BYTES = 1024 * 1024 * 1024;

export interface PreflightOptions {
  readonly pool: Pool;
  /** The volume the artefact store is on, which is the one this can measure. */
  readonly artefactPath: string;
  readonly migrationsDirectory?: string;
  readonly backupMaxAgeHours?: number;
  readonly minimumConnectorVersion?: string;
  readonly recommendedConnectorVersion?: string;
  readonly now?: () => Date;
}

function check(
  name: CompatibilityCheck["name"],
  status: CompatibilityStatus,
  detail: string,
): CompatibilityCheck {
  // The bound is the protocol's; truncating here keeps a long PostgreSQL
  // message from turning a report into a schema violation.
  return { name, status, detail: detail.slice(0, 512) };
}

/**
 * Whether the schema this database is at is one this build can carry forward.
 *
 * Migrations are forward-only and complete from `0001`, so every version this
 * build has a file for is a supported source. A version it has no file for was
 * written by a newer release, and that is the unsupported direction.
 */
async function sourceVersion(options: PreflightOptions): Promise<CompatibilityCheck> {
  const directory = options.migrationsDirectory ?? MIGRATIONS_DIRECTORY;
  try {
    const state = await migrationState(options.pool, directory);
    const available = await listMigrations(directory);
    if (state.schemaVersion === null) {
      return check(
        "source_version",
        "pass",
        `this database has no schema yet; reviewplane migrate applies all ${String(available.length)} migration(s)`,
      );
    }
    if (!available.includes(state.schemaVersion)) {
      return check(
        "source_version",
        "fail",
        `the database is at ${state.schemaVersion}, which this build does not have; it was written by a newer release`,
      );
    }
    return check(
      "source_version",
      "pass",
      `source schema ${state.schemaVersion} is supported; ${String(state.pending.length)} migration(s) pending`,
    );
  } catch (error) {
    return check("source_version", "fail", `the schema could not be read: ${describe(error)}`);
  }
}

/**
 * How long ago this installation last recorded a backup.
 *
 * The audit event is the source, not a file on disk: a backup is only useful if
 * it was taken from this installation, and the event is the record that it was
 * (`docs/SECURITY.md` §16). An operator who backed up with their own tooling and
 * never told the control plane gets a `fail` telling them to run
 * `reviewplane backup`, which is the right answer to "prove you can roll back".
 */
export async function lastBackup(pool: Pool): Promise<{ at: Date; mode: string } | null> {
  const present = await pool.query<{ present: boolean }>(
    "select to_regclass('events') is not null as present",
  );
  if (present.rows[0]?.present !== true) return null;
  const { rows } = await pool.query<{ recorded_at: Date; mode: string | null }>(
    `select recorded_at, payload ->> 'mode' as mode
       from events
      where type = $1
      order by recorded_at desc
      limit 1`,
    [BACKUP_CREATED_EVENT],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return { at: row.recorded_at, mode: row.mode ?? "unknown" };
}

async function backupFreshness(options: PreflightOptions): Promise<CompatibilityCheck> {
  const now = (options.now ?? ((): Date => new Date()))();
  const maxAge = options.backupMaxAgeHours ?? DEFAULT_BACKUP_MAX_AGE_HOURS;
  try {
    const latest = await lastBackup(options.pool);
    if (latest === null) {
      return check(
        "backup_freshness",
        "fail",
        "this installation has never recorded a backup; run reviewplane backup before upgrading (docs/DEPLOYMENT.md section 15)",
      );
    }
    const hours = (now.getTime() - latest.at.getTime()) / 3_600_000;
    if (hours > maxAge) {
      return check(
        "backup_freshness",
        "warn",
        `the last recorded backup is ${hours.toFixed(1)} hours old, older than the ${String(maxAge)}-hour window; take a fresh one so the rollback artefact matches the data`,
      );
    }
    return check(
      "backup_freshness",
      "pass",
      `a ${latest.mode} backup was recorded ${hours.toFixed(1)} hours ago`,
    );
  } catch (error) {
    return check("backup_freshness", "fail", `backup history could not be read: ${describe(error)}`);
  }
}

async function diskSpace(options: PreflightOptions): Promise<CompatibilityCheck> {
  try {
    const stats = await statfs(options.artefactPath);
    const free = stats.bavail * stats.bsize;
    const { rows } = await options.pool.query<{ bytes: string }>(
      "select pg_database_size(current_database())::text as bytes",
    );
    const database = Number(rows[0]?.bytes ?? "0");
    const required = Math.max(MINIMUM_FREE_BYTES, database);
    if (free < required) {
      return check(
        "disk_space",
        "fail",
        `${gib(free)} free on the artefact volume, below the ${gib(required)} a migration of a ${gib(database)} database needs`,
      );
    }
    if (free < database * 3) {
      return check(
        "disk_space",
        "warn",
        `${gib(free)} free on the artefact volume against a ${gib(database)} database; a migration that rewrites a large table may not fit`,
      );
    }
    return check("disk_space", "pass", `${gib(free)} free, database ${gib(database)}`);
  } catch (error) {
    return check("disk_space", "fail", `free space could not be measured: ${describe(error)}`);
  }
}

/**
 * How enrolled connectors fare across the upgrade
 * (`docs/CONNECTOR_PROTOCOL.md` §19, `docs/OPERATIONS.md` §12: "rolling
 * compatibility should permit old connectors within a documented support
 * window").
 *
 * The classification is the same function the reconnect exchange uses, against
 * the same configured policy, so the preflight cannot say a connector is fine
 * and the control plane then refuse it.
 */
async function connectorCompatibility(options: PreflightOptions): Promise<CompatibilityCheck> {
  const policy = {
    minimumVersion: options.minimumConnectorVersion ?? "0.0.0",
    recommendedVersion: options.recommendedConnectorVersion ?? "0.0.0",
  };
  try {
    const present = await options.pool.query<{ present: boolean }>(
      "select to_regclass('connectors') is not null as present",
    );
    if (present.rows[0]?.present !== true) {
      return check("connector_compatibility", "pass", "this schema has no connector table yet");
    }
    const { rows } = await options.pool.query<{ version: string }>(
      "select version from connectors where revoked_at is null",
    );
    if (rows.length === 0) {
      return check("connector_compatibility", "pass", "no connector is enrolled");
    }
    const classified = rows.map((row) => classifyUpgrade(row.version, policy));
    const refused = classified.filter((value) => value === "upgrade_required" || value === "unsupported");
    const recommended = classified.filter((value) => value === "upgrade_recommended");
    if (refused.length > 0) {
      return check(
        "connector_compatibility",
        "warn",
        `${String(refused.length)} of ${String(rows.length)} enrolled connector(s) are below the minimum ${policy.minimumVersion} and will be refused with UPGRADE_REQUIRED after the upgrade; upgrade them on the development machines`,
      );
    }
    if (recommended.length > 0) {
      return check(
        "connector_compatibility",
        "warn",
        `${String(recommended.length)} of ${String(rows.length)} enrolled connector(s) are below the recommended ${policy.recommendedVersion} and will keep running with an upgrade recommendation`,
      );
    }
    return check(
      "connector_compatibility",
      "pass",
      `${String(rows.length)} enrolled connector(s) are within the support window`,
    );
  } catch (error) {
    return check("connector_compatibility", "fail", `connectors could not be read: ${describe(error)}`);
  }
}

/**
 * Browser workers running a build other than this one.
 *
 * In the Compose deployment the worker image is pinned beside the API image and
 * is restarted with it, so a mismatch here means a worker that was not
 * restarted. It is a warning rather than a failure: the control plane keeps
 * scheduling, and the worker is the component whose sessions are ephemeral.
 */
async function workerCompatibility(options: PreflightOptions): Promise<CompatibilityCheck> {
  try {
    const present = await options.pool.query<{ present: boolean }>(
      "select to_regclass('browser_workers') is not null as present",
    );
    if (present.rows[0]?.present !== true) {
      return check("worker_compatibility", "pass", "this schema has no browser-worker table yet");
    }
    const { rows } = await options.pool.query<{ worker_version: string; workers: string }>(
      `select worker_version, count(*)::text as workers
         from browser_workers
        where status = 'active'
        group by worker_version
        order by worker_version`,
    );
    if (rows.length === 0) return check("worker_compatibility", "pass", "no browser worker is registered");
    const build = readBuildInfo().version;
    const different = rows.filter((row) => row.worker_version !== build);
    if (different.length > 0) {
      return check(
        "worker_compatibility",
        "warn",
        `browser worker(s) report ${different.map((row) => row.worker_version).join(", ")} against control plane ${build}; restart the worker containers with the rest of the stack`,
      );
    }
    return check("worker_compatibility", "pass", `every registered browser worker reports ${build}`);
  } catch (error) {
    return check("worker_compatibility", "fail", `browser workers could not be read: ${describe(error)}`);
  }
}

/**
 * Whether the migration lock is free.
 *
 * It is taken and released rather than held, because the preflight must not
 * become the process that blocks the migration it is clearing the way for. The
 * window between this check and the migration is real and is not pretended
 * away: the migration runner takes the same lock, so two concurrent upgrades
 * still cannot both apply a file — this check exists so the second one is told
 * why it is waiting rather than appearing to hang.
 */
async function migrationLock(options: PreflightOptions): Promise<CompatibilityCheck> {
  const client = await options.pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock($1) as locked",
      [MIGRATION_LOCK_KEY],
    );
    if (rows[0]?.locked !== true) {
      return check(
        "migration_lock",
        "fail",
        "another process holds the migration lock; a migration is already running or a process that took it has not exited",
      );
    }
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    return check("migration_lock", "pass", "the migration lock is available");
  } catch (error) {
    return check("migration_lock", "fail", `the migration lock could not be tested: ${describe(error)}`);
  } finally {
    client.release();
  }
}

function gib(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

/**
 * A failure detail never carries a connection string, a credential or an
 * address (`docs/SECURITY.md` §18): preflight output is pasted into issues.
 */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/giu, "[endpoint]")
    .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/gu, "[address]")
    .slice(0, 300);
}

/** Runs every check and reports all of them. */
export async function runPreflight(options: PreflightOptions): Promise<CompatibilityReport> {
  const now = (options.now ?? ((): Date => new Date()))();
  const checks = [
    await sourceVersion(options),
    await backupFreshness(options),
    await diskSpace(options),
    await connectorCompatibility(options),
    await workerCompatibility(options),
    await migrationLock(options),
  ];
  return {
    ok: !checks.some((entry) => entry.status === "fail"),
    checked_at: now.toISOString(),
    checks,
  };
}

/** One line per check, for a human reading over SSH. */
export function renderPreflight(report: CompatibilityReport): string {
  const lines = [`preflight: ${report.ok ? "ok" : "FAILED"}  (${report.checked_at})`, ""];
  for (const entry of report.checks) {
    lines.push(`  ${entry.status.padEnd(4)}  ${entry.name.padEnd(24)}  ${entry.detail}`);
  }
  return lines.join("\n");
}
