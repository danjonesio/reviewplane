/**
 * `reviewplane status` — one screen that answers `docs/OPERATIONS.md` section 1.
 *
 * Section 3 fixes the fields: version, database connectivity and schema,
 * artefact-store availability, active connectors, browser-worker capacity,
 * active sessions, queue depth, storage use and certificate expiry warnings.
 * This module gathers exactly those and nothing else, because a status command
 * that grows a field per release becomes a dashboard nobody reads.
 *
 * Three properties are deliberate:
 *
 *   * **Every section is gathered independently.** A database that is down must
 *     not stop the command reporting the version, the artefact store and the
 *     certificate — those are what an operator diagnosing the outage needs.
 *     Each section therefore carries its own failure rather than throwing.
 *   * **A failure detail never carries a credential, a connection string or an
 *     address.** `describeFailure` is the same scrubber `/health/ready` uses
 *     (`docs/SECURITY.md` section 18); status output is pasted into issues.
 *   * **Zero is not a failure.** A fresh installation has no connectors and no
 *     sessions, and reporting that as unhealthy would train an operator to
 *     ignore the command. Only the database, the schema and the artefact store
 *     can fail; capacity and certificate expiry are warnings.
 */

import { randomBytes } from "node:crypto";
import { mkdir, rm, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";

import { migrationState } from "../../db/migrate.ts";
import type { Pool } from "../../db/pool.ts";
import { describeFailure, readBuildInfo, type BuildInfo } from "../../health.ts";

/** Days before expiry at which a certificate becomes a warning. */
export const CERTIFICATE_WARNING_DAYS = 30;

/**
 * Silence after which a browser worker's capacity stops being counted.
 *
 * A worker heartbeats every fifteen seconds — the interval the control plane
 * advertises in its registration acknowledgement — so this is three missed
 * heartbeats, the same margin `REVIEWPLANE_CONNECTOR_DEGRADED_AFTER_SECONDS`
 * gives a connector.
 *
 * It is applied here, in the reporting, and nowhere else. Nothing reaps a
 * stopped worker's row: it stays `active` in `browser_workers` until something
 * marks it otherwise, which is worker-lifecycle work this command does not do.
 * What this command must not do is answer "four slots free" about a container
 * that is gone — an operator asking why a session will not start would read
 * that as the scheduler's problem and look in the wrong place. The row is still
 * reported, as `stale_workers`, because "a worker registered and went quiet" and
 * "no worker ever registered" are different faults with different fixes.
 */
export const WORKER_STALE_AFTER_SECONDS = 45;

export interface DatabaseStatus {
  readonly reachable: boolean;
  readonly schema_version: string | null;
  readonly pending_migrations: number;
  readonly detail: string | null;
}

export interface ArtefactStoreStatus {
  readonly driver: "filesystem";
  readonly available: boolean;
  readonly path: string;
  readonly detail: string | null;
}

export interface ConnectorStatus {
  readonly enrolled: number;
  readonly active: number;
  readonly degraded: number;
  readonly disconnected: number;
  readonly detail: string | null;
}

export interface BrowserCapacityStatus {
  /** Workers heard from within {@link WORKER_STALE_AFTER_SECONDS}. */
  readonly workers: number;
  /**
   * Workers still marked active in the database that have not been heard from
   * inside that window. Their capacity is not counted.
   */
  readonly stale_workers: number;
  readonly capacity: number;
  readonly in_use: number;
  readonly available: number;
  readonly sandboxed_workers: number;
  /**
   * The silence the counts above were computed with, in seconds. It is reported
   * rather than assumed so that the report says what it measured, and so that
   * the rendered line and the warning quote the threshold actually applied
   * rather than the default constant.
   */
  readonly stale_after_seconds: number;
  readonly detail: string | null;
}

export interface SessionStatus {
  readonly active: number;
  readonly detail: string | null;
}

export interface QueueStatus {
  readonly pending: number;
  readonly running: number;
  readonly failed: number;
  readonly detail: string | null;
}

export interface StorageStatus {
  readonly artefact_objects: number;
  readonly artefact_bytes: number;
  readonly database_bytes: number | null;
  readonly volume_free_bytes: number | null;
  readonly volume_total_bytes: number | null;
  readonly detail: string | null;
}

export interface CertificateStatus {
  /** `false` when no endpoint is configured, which is not a failure. */
  readonly checked: boolean;
  readonly endpoint: string | null;
  readonly subject: string | null;
  readonly not_after: string | null;
  readonly days_remaining: number | null;
  /**
   * The certificate's whole lifetime, which is what decides whether an expiry
   * is worth telling an operator about. See {@link certificateStatus}.
   */
  readonly validity_days: number | null;
  readonly warning: string | null;
  readonly detail: string | null;
}

/**
 * The version block, in the shape `/version` reports it
 * (`docs/OPERATIONS.md` section 2).
 *
 * Snake case throughout, because the rest of this report is snake case and an
 * automation interface with two conventions in it is one an author has to
 * remember rather than read.
 */
export interface VersionStatus {
  readonly version: string;
  readonly revision: string;
  readonly built_at: string;
  readonly protocol_version: number;
}

export interface StatusReport {
  readonly status: "ok" | "degraded";
  readonly version: VersionStatus;
  readonly database: DatabaseStatus;
  readonly artefact_store: ArtefactStoreStatus;
  readonly connectors: ConnectorStatus;
  readonly browser_capacity: BrowserCapacityStatus;
  readonly sessions: SessionStatus;
  readonly queue: QueueStatus;
  readonly storage: StorageStatus;
  readonly certificate: CertificateStatus;
  readonly warnings: readonly string[];
}

export interface StatusOptions {
  readonly pool: Pool;
  readonly artefactPath: string;
  /**
   * `host:port` of the TLS listener whose certificate expiry is reported. In
   * the Compose stack this is the edge gateway, which the `api` role reaches
   * over the `edge` network. A deployment that terminates TLS in front of the
   * stack leaves it unset, and the section reports "not configured" rather than
   * inventing a failure.
   */
  readonly tlsEndpoint?: string | undefined;
  /** Name presented in SNI; a named site serves no certificate without it. */
  readonly tlsServerName?: string | undefined;
  readonly build?: BuildInfo;
  readonly now?: Date;
  /** Bound on the artefact-store write probe. Tests set it to prove the bound. */
  readonly artefactProbeTimeoutMs?: number;
  /** Overrides {@link WORKER_STALE_AFTER_SECONDS}, so a test need not wait it out. */
  readonly workerStaleAfterSeconds?: number;
}

/** Milliseconds the certificate probe waits before giving up. */
const TLS_TIMEOUT_MS = 5_000;

export async function gatherStatus(options: StatusOptions): Promise<StatusReport> {
  const build = options.build ?? readBuildInfo();
  const now = options.now ?? new Date();

  const database = await databaseStatus(options.pool);
  const [artefactStore, connectors, browserCapacity, sessions, queue, storage, certificate] =
    await Promise.all([
      artefactStoreStatus(options.artefactPath, options.artefactProbeTimeoutMs),
      connectorStatus(options.pool),
      browserCapacityStatus(options.pool, options.workerStaleAfterSeconds),
      sessionStatus(options.pool),
      queueStatus(options.pool),
      storageStatus(options.pool, options.artefactPath),
      certificateStatus(options.tlsEndpoint, options.tlsServerName, now),
    ]);

  const warnings: string[] = [];
  if (database.reachable && database.pending_migrations > 0) {
    warnings.push(
      `${String(database.pending_migrations)} migration(s) pending; run reviewplane migrate`,
    );
  }
  if (database.reachable && browserCapacity.available === 0) {
    warnings.push(
      browserCapacity.workers > 0
        ? "browser capacity is exhausted; new sessions will queue or be refused"
        : browserCapacity.stale_workers > 0
          ? // Two different faults with two different fixes: a worker that
            // registered and stopped answering is a container to restart; no
            // worker at all is a stack that was never brought up completely.
            `${String(browserCapacity.stale_workers)} registered browser worker(s) have not been heard from in ${String(browserCapacity.stale_after_seconds)}s; browser sessions cannot be allocated`
          : "no browser worker has registered; browser sessions cannot be allocated",
    );
  }
  if (
    database.reachable &&
    browserCapacity.workers > browserCapacity.sandboxed_workers &&
    browserCapacity.workers > 0
  ) {
    warnings.push(
      "a registered browser worker reports the Chromium sandbox disabled; this is a high-risk configuration (docs/SECURITY.md section 10)",
    );
  }
  if (certificate.warning !== null) warnings.push(certificate.warning);

  // Only the three things a deployment cannot work without are failures.
  // An installation with no connectors, no sessions and no queued work is a
  // healthy fresh installation, and saying otherwise teaches an operator to
  // ignore the answer.
  const failed =
    !database.reachable || database.pending_migrations > 0 || !artefactStore.available;

  return {
    status: failed ? "degraded" : "ok",
    version: {
      version: build.version,
      revision: build.revision,
      built_at: build.builtAt,
      protocol_version: 1,
    },
    database,
    artefact_store: artefactStore,
    connectors,
    browser_capacity: browserCapacity,
    sessions,
    queue,
    storage,
    certificate,
    warnings,
  };
}

async function databaseStatus(pool: Pool): Promise<DatabaseStatus> {
  try {
    const state = await migrationState(pool);
    return {
      reachable: true,
      schema_version: state.schemaVersion,
      pending_migrations: state.pending.length,
      detail:
        state.pending.length === 0
          ? null
          : `pending: ${state.pending.slice(0, 5).join(", ")}`,
    };
  } catch (error) {
    return {
      reachable: false,
      schema_version: null,
      pending_migrations: 0,
      detail: describeFailure(error),
    };
  }
}

/** How long the artefact-store write probe is given before it is a failure. */
export const ARTEFACT_PROBE_TIMEOUT_MS = 5_000;

/**
 * Availability is a write probe, not a directory listing, and it is bounded.
 *
 * `docs/OPERATIONS.md` section 7 alerts on "artefact store unavailable", and
 * the failure an operator actually meets is a volume that mounted read-only or
 * filled up — both of which a read succeeds against. The probe writes a byte
 * and removes it, which is the operation the store performs on every capture.
 *
 * The bound matters as much as the probe. A filesystem call is not guaranteed
 * to return: a wedged network mount blocks in the kernel, and so does `mkdir`
 * on some virtual filesystems. A status command that hung on the store it was
 * asked about would be useless in exactly the outage it exists for, so the
 * probe races a timer and reports the timeout as unavailability.
 */
async function artefactStoreStatus(
  path: string,
  timeoutMs: number | undefined = ARTEFACT_PROBE_TIMEOUT_MS,
): Promise<ArtefactStoreStatus> {
  timeoutMs ??= ARTEFACT_PROBE_TIMEOUT_MS;
  const probe = join(path, `.status-probe-${randomBytes(8).toString("hex")}`);
  const write = async (): Promise<ArtefactStoreStatus> => {
    try {
      await mkdir(path, { recursive: true });
      await writeFile(probe, "reviewplane status probe");
      return { driver: "filesystem", available: true, path, detail: null };
    } catch (error) {
      return { driver: "filesystem", available: false, path, detail: describeFailure(error) };
    } finally {
      await rm(probe, { force: true }).catch(() => undefined);
    }
  };

  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<ArtefactStoreStatus>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        driver: "filesystem",
        available: false,
        path,
        detail: `the write probe did not complete within ${String(timeoutMs)}ms`,
      });
    }, timeoutMs);
    timer.unref();
  });

  try {
    return await Promise.race([write(), expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function connectorStatus(pool: Pool): Promise<ConnectorStatus> {
  try {
    const result = await pool.query<{ status: string; count: string }>(
      "select status, count(*)::text as count from connectors group by status",
    );
    const counts = new Map(result.rows.map((row) => [row.status, Number(row.count)]));
    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
    return {
      enrolled: total,
      active: counts.get("ACTIVE") ?? 0,
      degraded: counts.get("DEGRADED") ?? 0,
      disconnected: counts.get("DISCONNECTED") ?? 0,
      detail: null,
    };
  } catch (error) {
    return {
      enrolled: 0,
      active: 0,
      degraded: 0,
      disconnected: 0,
      detail: describeFailure(error),
    };
  }
}

async function browserCapacityStatus(
  pool: Pool,
  staleAfterSeconds: number | undefined = WORKER_STALE_AFTER_SECONDS,
): Promise<BrowserCapacityStatus> {
  staleAfterSeconds ??= WORKER_STALE_AFTER_SECONDS;
  try {
    // `greatest(last_heartbeat_at, registered_at)`: `greatest` ignores nulls, so
    // a worker that has registered and not yet reached its first heartbeat
    // counts from its registration. Without that a freshly started stack would
    // report no capacity for the first fifteen seconds, which is a false alarm
    // in exactly the minute an operator is watching the installation come up.
    const result = await pool.query<{
      workers: string;
      stale: string;
      capacity: string;
      in_use: string;
      sandboxed: string;
    }>(
      `select count(*) filter (where live)::text                              as workers,
              count(*) filter (where not live)::text                          as stale,
              coalesce(sum(capacity) filter (where live), 0)::text            as capacity,
              coalesce(sum(active_sessions) filter (where live), 0)::text     as in_use,
              count(*) filter (where live and sandbox_enabled)::text          as sandboxed
         from (
           select capacity,
                  active_sessions,
                  sandbox_enabled,
                  greatest(last_heartbeat_at, registered_at)
                    > now() - make_interval(secs => $1::double precision) as live
             from browser_workers
            where status in ('active', 'degraded')
         ) as worker`,
      [staleAfterSeconds],
    );
    const row = result.rows[0];
    const capacity = Number(row?.capacity ?? 0);
    const inUse = Number(row?.in_use ?? 0);
    return {
      workers: Number(row?.workers ?? 0),
      stale_workers: Number(row?.stale ?? 0),
      capacity,
      in_use: inUse,
      available: Math.max(capacity - inUse, 0),
      sandboxed_workers: Number(row?.sandboxed ?? 0),
      stale_after_seconds: staleAfterSeconds,
      detail: null,
    };
  } catch (error) {
    return {
      workers: 0,
      stale_workers: 0,
      capacity: 0,
      in_use: 0,
      available: 0,
      sandboxed_workers: 0,
      stale_after_seconds: staleAfterSeconds,
      detail: describeFailure(error),
    };
  }
}

async function sessionStatus(pool: Pool): Promise<SessionStatus> {
  try {
    const result = await pool.query<{ active: string }>(
      `select count(*)::text as active
         from browser_sessions
        where ended_at is null
          and status not in ('TERMINATED', 'FAILED')`,
    );
    return { active: Number(result.rows[0]?.active ?? 0), detail: null };
  } catch (error) {
    return { active: 0, detail: describeFailure(error) };
  }
}

async function queueStatus(pool: Pool): Promise<QueueStatus> {
  try {
    const result = await pool.query<{ status: string; count: string }>(
      "select status, count(*)::text as count from jobs group by status",
    );
    const counts = new Map(result.rows.map((row) => [row.status, Number(row.count)]));
    return {
      pending: counts.get("pending") ?? 0,
      running: counts.get("running") ?? 0,
      failed: counts.get("failed") ?? 0,
      detail: null,
    };
  } catch (error) {
    return { pending: 0, running: 0, failed: 0, detail: describeFailure(error) };
  }
}

async function storageStatus(pool: Pool, artefactPath: string): Promise<StorageStatus> {
  let objects = 0;
  let bytes = 0;
  let databaseBytes: number | null = null;
  const details: string[] = [];

  try {
    const result = await pool.query<{ objects: string; bytes: string }>(
      `select count(*)::text                          as objects,
              coalesce(sum(size_bytes), 0)::text      as bytes
         from artefacts
        where state = 'available'`,
    );
    objects = Number(result.rows[0]?.objects ?? 0);
    bytes = Number(result.rows[0]?.bytes ?? 0);
  } catch (error) {
    details.push(describeFailure(error));
  }

  try {
    const result = await pool.query<{ bytes: string }>(
      "select pg_database_size(current_database())::text as bytes",
    );
    databaseBytes = Number(result.rows[0]?.bytes ?? 0);
  } catch (error) {
    details.push(describeFailure(error));
  }

  let free: number | null = null;
  let total: number | null = null;
  try {
    const stats = await statfs(artefactPath);
    free = Number(stats.bavail) * Number(stats.bsize);
    total = Number(stats.blocks) * Number(stats.bsize);
  } catch (error) {
    details.push(describeFailure(error));
  }

  return {
    artefact_objects: objects,
    artefact_bytes: bytes,
    database_bytes: databaseBytes,
    volume_free_bytes: free,
    volume_total_bytes: total,
    detail: details.length === 0 ? null : details.join("; "),
  };
}

/**
 * Reads the expiry of the certificate a TLS listener actually serves.
 *
 * It presents the site's name in SNI and does not verify the chain. Both are
 * deliberate: a named Caddy site serves no certificate to a probe that asks for
 * a different name, and the default installation uses Caddy's internal
 * authority, which is not in the image's trust store. What the section reports
 * is when the served certificate expires, which does not depend on who signed
 * it.
 *
 * A warning is raised only for a certificate a human could act on. Caddy's
 * internal authority issues **twelve-hour** leaves and renews them itself, so a
 * "expires in 0 days" warning on the default installation would fire on every
 * healthy deployment, every day — which is how an operator learns to stop
 * reading warnings. The rule is therefore: a certificate whose whole lifetime is
 * shorter than the warning threshold is automatically managed by something, and
 * is reported without a warning; one that has already expired is always a
 * warning, because that is a deployment that has stopped serving.
 */
async function certificateStatus(
  endpoint: string | undefined,
  serverName: string | undefined,
  now: Date,
): Promise<CertificateStatus> {
  const absent: CertificateStatus = {
    checked: false,
    endpoint: null,
    subject: null,
    not_after: null,
    days_remaining: null,
    validity_days: null,
    warning: null,
    detail: "no TLS endpoint is configured; set REVIEWPLANE_STATUS_TLS_ENDPOINT",
  };
  if (endpoint === undefined || endpoint === "") return absent;

  const separator = endpoint.lastIndexOf(":");
  if (separator <= 0) {
    return { ...absent, checked: false, detail: "REVIEWPLANE_STATUS_TLS_ENDPOINT must be host:port" };
  }
  const host = endpoint.slice(0, separator);
  const port = Number(endpoint.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ...absent, checked: false, detail: "REVIEWPLANE_STATUS_TLS_ENDPOINT must be host:port" };
  }

  // RFC 6066 forbids an IP address in SNI, and Node warns and will eventually
  // ignore it. So the name is sent only when there is a name to send: a probe
  // to `127.0.0.1:8443` asks for no server name, which is correct rather than a
  // degradation, because a listener with one certificate serves it anyway.
  const sni =
    serverName !== undefined && serverName !== ""
      ? serverName
      : /^[0-9.]+$|:/u.test(host)
        ? undefined
        : host;

  try {
    const certificate = await new Promise<{ subject: string; validFrom: string; validTo: string }>(
      (resolve, reject) => {
        const socket = tlsConnect(
          {
            host,
            port,
            ...(sni === undefined ? {} : { servername: sni }),
            rejectUnauthorized: false,
            timeout: TLS_TIMEOUT_MS,
          },
          () => {
            const peer = socket.getPeerCertificate();
            socket.end();
            if (peer.valid_to === undefined) {
              reject(new Error("the listener presented no certificate"));
              return;
            }
            // `CN` is `string | string[]`: a distinguished name may repeat an
            // attribute, and Node hands back every value when it does.
            const commonName = peer.subject?.CN;
            resolve({
              subject: Array.isArray(commonName)
                ? (commonName[0] ?? "(unnamed)")
                : (commonName ?? peer.subjectaltname ?? "(unnamed)"),
              validFrom: peer.valid_from,
              validTo: peer.valid_to,
            });
          },
        );
        socket.on("timeout", () => {
          socket.destroy(new Error("the TLS probe timed out"));
        });
        socket.on("error", reject);
      },
    );

    const notAfter = new Date(certificate.validTo);
    const notBefore = new Date(certificate.validFrom);
    const days = Math.floor((notAfter.getTime() - now.getTime()) / 86_400_000);
    const validityDays = Number.isNaN(notBefore.getTime())
      ? null
      : Math.max((notAfter.getTime() - notBefore.getTime()) / 86_400_000, 0);
    // A certificate whose whole life is shorter than the threshold is renewed
    // by something rather than by a human, so an expiry warning on it is noise
    // an operator would learn to ignore. An expired one is a warning whatever
    // issued it.
    const shortLived = validityDays !== null && validityDays <= CERTIFICATE_WARNING_DAYS;
    const warning =
      notAfter.getTime() < now.getTime()
        ? `the TLS certificate served on ${endpoint} has expired`
        : days <= CERTIFICATE_WARNING_DAYS && !shortLived
          ? `the TLS certificate served on ${endpoint} expires in ${String(days)} day(s)`
          : null;
    return {
      checked: true,
      endpoint,
      subject: certificate.subject,
      not_after: notAfter.toISOString(),
      days_remaining: days,
      validity_days: validityDays === null ? null : Math.round(validityDays * 100) / 100,
      warning,
      detail: shortLived
        ? "the certificate is short-lived and renewed automatically, so its expiry is not warned about"
        : null,
    };
  } catch (error) {
    return {
      checked: false,
      endpoint,
      subject: null,
      not_after: null,
      days_remaining: null,
      validity_days: null,
      warning: null,
      detail: describeFailure(error),
    };
  }
}

/** Human-readable byte count. Storage numbers are read, not parsed. */
export function formatBytes(value: number | null): string {
  if (value === null) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? String(Math.round(size)) : size.toFixed(1)} ${units[unit] ?? "B"}`;
}

/**
 * The default rendering: one line per section, aligned, no colour.
 *
 * `--json` is the automation interface (`docs/OPERATIONS.md` section 14); this
 * is the one an operator reads over SSH, so every line names its section and
 * carries its own failure rather than deferring to a legend.
 */
export function renderStatus(report: StatusReport): string {
  const lines: string[] = [];
  // Wide enough for the longest label plus a space: "browser capacity" is
  // sixteen characters, and padding to sixteen ran the label into its value.
  const row = (label: string, value: string): void => {
    lines.push(`${label.padEnd(18)}${value}`);
  };

  lines.push(
    `reviewplane ${report.version.version} (revision ${report.version.revision}, built ${report.version.built_at})`,
  );
  lines.push("");

  row(
    "database",
    report.database.reachable
      ? `reachable, schema ${report.database.schema_version ?? "(none applied)"}, ${String(report.database.pending_migrations)} pending`
      : `unreachable: ${report.database.detail ?? "unknown"}`,
  );
  row(
    "artefact store",
    report.artefact_store.available
      ? `${report.artefact_store.driver} at ${report.artefact_store.path}: writable`
      : `${report.artefact_store.driver} at ${report.artefact_store.path}: unavailable — ${report.artefact_store.detail ?? "unknown"}`,
  );
  row(
    "connectors",
    report.connectors.detail === null
      ? `${String(report.connectors.active)} active, ${String(report.connectors.degraded)} degraded, ${String(report.connectors.disconnected)} disconnected, ${String(report.connectors.enrolled)} enrolled`
      : `unavailable: ${report.connectors.detail}`,
  );
  row(
    "browser capacity",
    report.browser_capacity.detail === null
      ? `${String(report.browser_capacity.workers)} worker(s), ${String(report.browser_capacity.available)} of ${String(report.browser_capacity.capacity)} slot(s) free, ${String(report.browser_capacity.sandboxed_workers)} sandboxed` +
        (report.browser_capacity.stale_workers > 0
          ? `, ${String(report.browser_capacity.stale_workers)} not heard from in ${String(report.browser_capacity.stale_after_seconds)}s`
          : "")
      : `unavailable: ${report.browser_capacity.detail}`,
  );
  row(
    "sessions",
    report.sessions.detail === null
      ? `${String(report.sessions.active)} active`
      : `unavailable: ${report.sessions.detail}`,
  );
  row(
    "queue",
    report.queue.detail === null
      ? `${String(report.queue.pending)} pending, ${String(report.queue.running)} running, ${String(report.queue.failed)} failed`
      : `unavailable: ${report.queue.detail}`,
  );
  row(
    "storage",
    `artefacts ${formatBytes(report.storage.artefact_bytes)} in ${String(report.storage.artefact_objects)} object(s), database ${formatBytes(report.storage.database_bytes)}, volume ${formatBytes(report.storage.volume_free_bytes)} free of ${formatBytes(report.storage.volume_total_bytes)}`,
  );
  row(
    "certificate",
    report.certificate.checked
      ? `${report.certificate.endpoint ?? ""} ${report.certificate.subject ?? ""} expires ${report.certificate.not_after ?? ""} (${String(report.certificate.days_remaining)} day(s))`
      : (report.certificate.detail ?? "not checked"),
  );

  if (report.warnings.length > 0) {
    lines.push("");
    for (const warning of report.warnings) lines.push(`warning: ${warning}`);
  }

  lines.push("");
  lines.push(report.status === "ok" ? "status: ok" : "status: degraded");
  return lines.join("\n");
}
