/**
 * `reviewplane restore` (`docs/DEPLOYMENT.md` §17, `docs/OPERATIONS.md` §11).
 *
 * Restore is the half of the pair that has to be right. A backup that fails is
 * noticed; a restore that reports success while a review's evidence is missing
 * is discovered by the person who needed the evidence. So every step here fails
 * closed:
 *
 *   * The archive is read twice. The first pass writes nothing and checks every
 *     member against the manifest's digest, so a truncated, altered or
 *     incomplete archive is refused before the installation is touched.
 *   * An archive whose schema version this build does not have is refused. It
 *     was written by a newer release, and its rows name columns these
 *     migrations have not created.
 *   * The target must be an empty installation. Restore is not a merge, and a
 *     merge is what a restore over existing data would silently be.
 *   * The whole database load is one transaction with foreign keys deferred, so
 *     a load that would leave a dangling reference aborts and writes nothing.
 *     An interrupted restore leaves an installation with a schema and no data,
 *     which the command says in as many words.
 *   * After the load, every artefact the metadata references is checked against
 *     the store. Application metadata is authoritative for availability
 *     (ADR-0012), so a row without bytes is missing evidence and is reported
 *     rather than presented as a review that is intact.
 *
 * Restore is a privileged local operation. It is reachable from the operator
 * command line inside the container and from nowhere else: no HTTP route
 * constructs it, and `apps/server/test/backup-security.test.ts` asserts that
 * the API surface offers no path that does.
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { BackupManifest } from "@reviewplane/protocol/platform";

import { listMigrations, migrate, migrationState, MIGRATIONS_DIRECTORY } from "../../db/migrate.ts";
import type { Pool, PoolClient } from "../../db/pool.ts";
import { inTransaction } from "../../db/pool.ts";
import { appendEvent } from "../../events/append.ts";
import { readArchive, type ArchiveMember, type EntryWriter } from "./archive.ts";
import {
  MANIFEST_PATH,
  parseManifest,
  storageKeyFromMemberPath,
  tableFromMemberPath,
} from "./manifest.ts";
import { BACKUP_RESTORED_EVENT } from "./backup.ts";
import {
  listTables,
  RUNNER_OWNED_TABLES,
  TableLoader,
  withDeferredForeignKeys,
} from "./tables.ts";

export class RestoreError extends Error {}

/** The archive is not readable as an archive, or does not match its manifest. */
export class ArchiveIntegrityError extends RestoreError {}

/** The archive was written by a build this one cannot restore. */
export class IncompatibleArchiveError extends RestoreError {}

/** The installation is not in a state a restore may write to. */
export class InstallationNotEmptyError extends RestoreError {}

export interface RestoreOptions {
  readonly pool: Pool;
  readonly archive: string;
  readonly artefactPath: string;
  /** Report the plan and write nothing. */
  readonly dryRun?: boolean;
  /**
   * The host the restored installation will be served under
   * (`docs/DEPLOYMENT.md` §17: "New hostname configuration").
   */
  readonly hostname?: string;
  readonly migrationsDirectory?: string;
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
}

/** What a restore would do, or did. */
export interface RestorePlan {
  readonly manifest: BackupManifest;
  /** Rows the archive carries, summed across tables. */
  readonly rows: number;
  readonly artefactObjects: number;
  readonly artefactBytes: number;
  /** Migrations this build applies to reach the archive's schema version. */
  readonly migrationsToApply: readonly string[];
  /** Migrations that remain pending after the restore, for `reviewplane migrate`. */
  readonly migrationsPendingAfter: readonly string[];
  /** Reasons a real restore would refuse. Empty when it would proceed. */
  readonly blockers: readonly string[];
}

export interface RestoreResult {
  readonly plan: RestorePlan;
  readonly applied: boolean;
  /** Storage keys the restored metadata references that the store does not hold. */
  readonly missingArtefacts: readonly string[];
  /** Connector identities the restored installation cannot serve, and why. */
  readonly connectorsNeedingReEnrolment: number;
  /** Credentials a hostname change invalidated. */
  readonly invalidated: {
    readonly humanSessions: number;
    readonly installTokens: number;
    readonly agentCredentials: number;
  };
}

interface ArchiveInspection {
  readonly manifest: BackupManifest;
  /** Migration file names the archive's own `schema_migrations` recorded. */
  readonly archivedMigrations: readonly string[];
}

/** Collects a member's bytes without keeping them, and digests them. */
function digestingSink(onDone: (digest: string, bytes: number) => void): EntryWriter {
  const hash = createHash("sha256");
  let bytes = 0;
  return {
    write(chunk: Buffer): void {
      hash.update(chunk);
      bytes += chunk.length;
    },
    end(): void {
      onDone(hash.digest("hex"), bytes);
    },
  };
}

/** Reads whole small members into memory, bounded by the manifest's own size. */
function bufferingSink(limit: number, onDone: (data: Buffer) => void): EntryWriter {
  const parts: Buffer[] = [];
  let bytes = 0;
  return {
    write(chunk: Buffer): void {
      bytes += chunk.length;
      if (bytes > limit) throw new ArchiveIntegrityError("an archive member is longer than declared");
      parts.push(chunk);
    },
    end(): void {
      onDone(Buffer.concat(parts));
    },
  };
}

/** Largest member the integrity pass will hold in memory: the manifest. */
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

/**
 * Reads the archive without writing anything, and proves it is the archive its
 * manifest describes.
 *
 * Every failure here is a refusal rather than a warning: a member missing, a
 * member nobody declared, a digest that disagrees, a size that disagrees, a
 * manifest that is not the first member. The last is not pedantry — a reader
 * that accepted a manifest found anywhere would be a reader that could be
 * handed one after the members it was supposed to describe.
 */
export async function inspectArchive(path: string): Promise<ArchiveInspection> {
  // A holder rather than a local, because the assignment happens inside a
  // callback and TypeScript's narrowing cannot see across one.
  const found: { manifest: BackupManifest | null; migrations: Buffer | null } = {
    manifest: null,
    migrations: null,
  };
  let first = true;
  const seen = new Map<string, { bytes: number; sha256: string }>();
  const archivedMigrations: string[] = [];

  await readArchive(path, async (member: ArchiveMember) => {
    if (first) {
      first = false;
      if (member.path !== MANIFEST_PATH) {
        throw new ArchiveIntegrityError(
          `the archive's first member is ${member.path}, not ${MANIFEST_PATH}; it is not a reviewplane backup`,
        );
      }
      if (member.bytes > MAX_MANIFEST_BYTES) {
        throw new ArchiveIntegrityError("the archive's manifest is implausibly large");
      }
      return bufferingSink(MAX_MANIFEST_BYTES, (data) => {
        found.manifest = parseManifest(data);
      });
    }
    if (found.manifest === null) throw new ArchiveIntegrityError("the archive has no manifest");
    if (member.path === MANIFEST_PATH) {
      throw new ArchiveIntegrityError("the archive holds more than one manifest");
    }
    if (seen.has(member.path)) {
      throw new ArchiveIntegrityError(`the archive holds ${member.path} twice`);
    }
    if (tableFromMemberPath(member.path) === "schema_migrations") {
      return bufferingSink(MAX_MANIFEST_BYTES, (data) => {
        found.migrations = data;
        seen.set(member.path, {
          bytes: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
        });
      });
    }
    return digestingSink((sha256, bytes) => {
      seen.set(member.path, { sha256, bytes });
    });
  });

  const parsed = found.manifest;
  if (parsed === null) throw new ArchiveIntegrityError("the archive has no manifest");

  const declared = new Map(parsed.entries.map((entry) => [entry.path, entry]));
  for (const [path, actual] of seen) {
    const entry = declared.get(path);
    if (entry === undefined) {
      throw new ArchiveIntegrityError(`the archive holds ${path}, which its manifest does not declare`);
    }
    if (entry.bytes !== actual.bytes) {
      throw new ArchiveIntegrityError(
        `${path} is ${String(actual.bytes)} bytes; the manifest declares ${String(entry.bytes)}`,
      );
    }
    if (entry.sha256 !== actual.sha256) {
      throw new ArchiveIntegrityError(`${path} does not match the digest the manifest records`);
    }
  }
  for (const entry of parsed.entries) {
    if (!seen.has(entry.path)) {
      throw new ArchiveIntegrityError(
        `the manifest declares ${entry.path}, which the archive does not hold`,
      );
    }
  }

  const migrationsBuffer = found.migrations;
  if (migrationsBuffer !== null) {
    for (const line of migrationsBuffer.toString("utf8").split("\n")) {
      if (line.trim() === "") continue;
      const row = JSON.parse(line) as { filename?: unknown };
      if (typeof row.filename === "string") archivedMigrations.push(row.filename);
    }
    archivedMigrations.sort();
  }

  return { manifest: parsed, archivedMigrations };
}

/** The plan a dry run prints, and the plan a real restore then carries out. */
async function buildPlan(
  options: RestoreOptions,
  inspection: ArchiveInspection,
): Promise<RestorePlan> {
  const directory = options.migrationsDirectory ?? MIGRATIONS_DIRECTORY;
  const available = await listMigrations(directory);
  const manifest = inspection.manifest;
  const blockers: string[] = [];

  const head = available.indexOf(manifest.schema_version);
  if (head === -1) {
    throw new IncompatibleArchiveError(
      `the archive was written at schema version ${manifest.schema_version}, which this build does not have. It was produced by a newer release; restore it with that release (docs/DEPLOYMENT.md section 17).`,
    );
  }
  const unknown = inspection.archivedMigrations.filter((file) => !available.includes(file));
  if (unknown.length > 0) {
    throw new IncompatibleArchiveError(
      `the archive records ${String(unknown.length)} migration(s) this build does not have, beginning with ${unknown[0] ?? ""}; its schema history is not this product's.`,
    );
  }

  const existing = await listTables(options.pool);
  if (existing.length > 0) {
    blockers.push(
      `the target installation already has ${String(existing.length)} table(s); restore writes into an empty installation only`,
    );
  }

  return {
    manifest,
    rows: manifest.tables.reduce((total, table) => total + table.rows, 0),
    artefactObjects: manifest.artefact_objects,
    artefactBytes: manifest.artefact_bytes,
    migrationsToApply: available.slice(0, head + 1),
    migrationsPendingAfter: available.slice(head + 1),
    blockers,
  };
}

/**
 * Restores an archive, or reports what restoring it would do.
 *
 * The integrity pass runs in both cases, so `--dry-run` is a real answer to
 * "will this archive restore" rather than a summary of its manifest.
 */
export async function restoreBackup(options: RestoreOptions): Promise<RestoreResult> {
  const log = options.log ?? ((): void => undefined);
  const now = options.now ?? ((): Date => new Date());
  const directory = options.migrationsDirectory ?? MIGRATIONS_DIRECTORY;

  // The path is not logged. It is either the operator's own argument, which
  // they can see, or the spool the command line made, which would read as the
  // archive being somewhere it is not.
  log("verifying the archive against its manifest");
  const inspection = await inspectArchive(options.archive);
  const plan = await buildPlan(options, inspection);
  const manifest = plan.manifest;
  log(
    `archive: ${manifest.mode} backup of ${manifest.product.version} at ${manifest.schema_version}, ` +
      `taken ${manifest.created_at}`,
  );
  log(
    `contents: ${String(plan.rows)} row(s) in ${String(manifest.tables.length)} table(s), ` +
      `${String(plan.artefactObjects)} artefact object(s), ${String(plan.artefactBytes)} byte(s)`,
  );
  log(
    `plan: apply ${String(plan.migrationsToApply.length)} migration(s) to reach ${manifest.schema_version}, ` +
      `then ${String(plan.migrationsPendingAfter.length)} migration(s) remain pending for reviewplane migrate`,
  );
  log(
    `key material: ${manifest.key_material.included ? "included in this archive" : `excluded (${manifest.key_material.excluded_tables.join(", ") || "none"})`}`,
  );
  if ((manifest.artefacts_missing ?? []).length > 0) {
    log(
      `note: the backup recorded ${String((manifest.artefacts_missing ?? []).length)} artefact(s) whose bytes were already missing when it was taken`,
    );
  }

  if (options.dryRun === true) {
    for (const blocker of plan.blockers) log(`would refuse: ${blocker}`);
    log(
      plan.blockers.length === 0
        ? "dry run: the archive is intact and this installation would accept it. Nothing was written."
        : "dry run: the archive is intact and this installation would refuse it. Nothing was written.",
    );
    return {
      plan,
      applied: false,
      missingArtefacts: [],
      connectorsNeedingReEnrolment: 0,
      invalidated: { humanSessions: 0, installTokens: 0, agentCredentials: 0 },
    };
  }

  const blocker = plan.blockers[0];
  if (blocker !== undefined) throw new InstallationNotEmptyError(blocker);

  log(`applying ${String(plan.migrationsToApply.length)} migration(s) to reach ${manifest.schema_version}`);
  await migrate(options.pool, directory, { through: manifest.schema_version });
  const reached = await migrationState(options.pool, directory);
  const applied = [...reached.applied].sort();
  const archived = [...inspection.archivedMigrations];
  if (archived.length > 0 && JSON.stringify(applied) !== JSON.stringify(archived)) {
    throw new IncompatibleArchiveError(
      "the migrations this build applied are not the migrations the archive recorded; the archive's schema history is not this product's",
    );
  }

  const client = await options.pool.connect();
  const loaded = new Map<string, number>();
  let artefactObjects = 0;
  try {
    await client.query("begin");
    // The migrations seed an organisation and a user on a fresh database
    // (0055). The archive is the authority for every row, so the seed is
    // removed before the load rather than merged with it: two organisations
    // called `org_default` is not a restore, it is a collision.
    const tables = (await listTables(client)).filter(
      (table) => !RUNNER_OWNED_TABLES.includes(table),
    );
    if (tables.length > 0) {
      await client.query(
        `truncate ${tables.map((table) => `"${table}"`).join(", ")} restart identity cascade`,
      );
    }
    await withDeferredForeignKeys(client, async () => {
      artefactObjects = await loadArchive(options, client, manifest, loaded, log);
    });
    await verifyRowCounts(client, manifest, loaded);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    log("restore did not complete: the database was rolled back and holds no restored data.");
    log(`The installation is at schema ${manifest.schema_version} with an empty dataset; rerun the restore.`);
    throw error;
  } finally {
    client.release();
  }

  const invalidated = await applyHostname(options, manifest, log);
  const missingArtefacts = await verifyArtefacts(options, manifest, log);
  const connectors = await countConnectorsNeedingReEnrolment(options.pool, manifest, log);

  await recordRestoreEvent(options.pool, manifest, {
    now,
    hostnameChanged: invalidated.hostnameChanged,
    missing: missingArtefacts.length,
    rows: plan.rows,
    artefactObjects,
  });

  if (plan.migrationsPendingAfter.length > 0) {
    log(
      `${String(plan.migrationsPendingAfter.length)} migration(s) are now pending; run reviewplane migrate to bring the schema to this build.`,
    );
  }

  return {
    plan,
    applied: true,
    missingArtefacts,
    connectorsNeedingReEnrolment: connectors,
    invalidated: {
      humanSessions: invalidated.humanSessions,
      installTokens: invalidated.installTokens,
      agentCredentials: invalidated.agentCredentials,
    },
  };
}

/**
 * The second pass: the one that writes.
 *
 * Rows are loaded before artefact objects because the transaction is open
 * across both. A failure while writing objects therefore rolls the database
 * back, leaving an empty installation and some content-addressed files a rerun
 * overwrites with identical bytes — rather than a populated database whose
 * evidence is half there.
 */
async function loadArchive(
  options: RestoreOptions,
  client: PoolClient,
  manifest: BackupManifest,
  loaded: Map<string, number>,
  log: (line: string) => void,
): Promise<number> {
  const known = new Set(manifest.tables.map((table) => table.name));
  let objects = 0;
  await readArchive(options.archive, async (member) => {
    const table = tableFromMemberPath(member.path);
    if (table !== null) {
      if (RUNNER_OWNED_TABLES.includes(table)) return null;
      if (!known.has(table)) {
        throw new ArchiveIntegrityError(`the archive holds rows for ${table}, which its manifest does not list`);
      }
      const loader = new TableLoader(client, table);
      return lineSink(loader, (count) => loaded.set(table, count));
    }
    const key = storageKeyFromMemberPath(member.path);
    if (key !== null) {
      objects += 1;
      return artefactSink(options.artefactPath, key, member.bytes);
    }
    return null;
  });
  const rows = [...loaded.values()].reduce((total, count) => total + count, 0);
  // The count excludes `schema_migrations`, whose rows the migration runner
  // wrote by applying the migrations rather than by loading them. Saying so
  // stops the figure reading as rows the restore dropped.
  log(
    `loaded ${String(rows)} row(s) and ${String(objects)} artefact object(s) ` +
      `(schema_migrations is written by the migration runner and is not loaded)`,
  );
  return objects;
}

/** Splits a member into JSON Lines and feeds them to a loader. */
function lineSink(loader: TableLoader, onDone: (rows: number) => void): EntryWriter {
  let remainder = "";
  return {
    async write(chunk: Buffer): Promise<void> {
      const text = remainder + chunk.toString("utf8");
      const lines = text.split("\n");
      remainder = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") continue;
        await loader.push(line);
      }
    },
    async end(): Promise<void> {
      if (remainder.trim() !== "") await loader.push(remainder);
      await loader.flush();
      onDone(loader.inserted);
    },
  };
}

/**
 * Writes one artefact object, and refuses one whose bytes are not what its key
 * says they are.
 *
 * The key is the digest (ADR-0012), so this check needs no database and no
 * manifest: a member that decompressed cleanly, matched its manifest digest and
 * still is not the object the key names would mean the archive was built
 * wrongly, and writing it would put the wrong bytes behind a review's evidence.
 */
function artefactSink(artefactPath: string, key: string, bytes: number): EntryWriter {
  const parts = key.split("/");
  if (parts.length !== 3 || parts[0] !== "sha256" || !/^[0-9a-f]{2}$/u.test(parts[1] ?? "") || !/^[0-9a-f]{62}$/u.test(parts[2] ?? "")) {
    throw new ArchiveIntegrityError(`the archive holds an artefact key it should not: ${key}`);
  }
  const destination = join(artefactPath, key);
  const temporary = `${destination}.restoring`;
  const hash = createHash("sha256");
  let written = 0;
  let stream: ReturnType<typeof createWriteStream> | null = null;
  return {
    async write(chunk: Buffer): Promise<void> {
      if (stream === null) {
        await mkdir(dirname(destination), { recursive: true });
        stream = createWriteStream(temporary, { mode: 0o600 });
      }
      hash.update(chunk);
      written += chunk.length;
      if (!stream.write(chunk)) {
        await new Promise<void>((resolve, reject) => {
          stream?.once("drain", resolve);
          stream?.once("error", reject);
        });
      }
    },
    async end(): Promise<void> {
      if (stream === null) {
        await mkdir(dirname(destination), { recursive: true });
        stream = createWriteStream(temporary, { mode: 0o600 });
      }
      const open = stream;
      await new Promise<void>((resolve, reject) => {
        open.end((error?: Error | null) => {
          if (error === undefined || error === null) resolve();
          else reject(error);
        });
      });
      const digest = hash.digest("hex");
      if (digest !== `${parts[1] ?? ""}${parts[2] ?? ""}` || written !== bytes) {
        await rm(temporary, { force: true });
        throw new ArchiveIntegrityError(
          `artefact ${key} does not hold the bytes its content-addressed key names`,
        );
      }
      await rename(temporary, destination);
    },
  };
}

/**
 * Compares what was loaded with what the manifest said the archive carried.
 *
 * A restore that inserted fewer rows than the archive holds has silently
 * dropped evidence, and the point of recording per-table counts is that the
 * silence is impossible.
 */
async function verifyRowCounts(
  client: PoolClient,
  manifest: BackupManifest,
  loaded: Map<string, number>,
): Promise<void> {
  const problems: string[] = [];
  for (const table of manifest.tables) {
    if (RUNNER_OWNED_TABLES.includes(table.name)) continue;
    const inserted = loaded.get(table.name) ?? 0;
    if (inserted !== table.rows) {
      problems.push(`${table.name}: loaded ${String(inserted)}, archive holds ${String(table.rows)}`);
      continue;
    }
    const { rows } = await client.query<{ count: string }>(
      `select count(*)::text as count from "${table.name}"`,
    );
    if (Number(rows[0]?.count ?? "-1") !== table.rows) {
      problems.push(
        `${table.name}: holds ${rows[0]?.count ?? "?"} rows after the load, archive holds ${String(table.rows)}`,
      );
    }
  }
  if (problems.length > 0) {
    throw new RestoreError(
      `the restore did not reproduce the archive's row counts and has been rolled back:\n  ${problems.join("\n  ")}`,
    );
  }
}

/**
 * Reports every artefact the restored metadata references and the store does
 * not hold.
 *
 * This is the "report missing evidence rather than presenting a review as
 * intact" requirement, and it is a report rather than a failure on purpose: a
 * database-only restore beside external object storage is a supported mode, and
 * so is a restore whose operator knows an artefact was already lost. What is
 * not supported is finding out later.
 */
async function verifyArtefacts(
  options: RestoreOptions,
  manifest: BackupManifest,
  log: (line: string) => void,
): Promise<string[]> {
  const present = await options.pool.query<{ present: boolean }>(
    `select count(*) > 0 as present
       from information_schema.columns
      where table_schema = 'public' and table_name = 'artefacts' and column_name = 'storage_key'`,
  );
  if (present.rows[0]?.present !== true) return [];
  const live = await options.pool.query<{ present: boolean }>(
    `select count(*) > 0 as present
       from information_schema.columns
      where table_schema = 'public' and table_name = 'artefacts' and column_name = 'deleted_at'`,
  );
  const filter = live.rows[0]?.present === true ? "and deleted_at is null" : "";
  const { rows } = await options.pool.query<{ storage_key: string }>(
    `select distinct storage_key from artefacts where storage_key is not null ${filter} order by storage_key`,
  );
  const missing: string[] = [];
  for (const row of rows) {
    try {
      await stat(join(options.artefactPath, row.storage_key));
    } catch {
      missing.push(row.storage_key);
    }
  }
  if (missing.length === 0) {
    log(`every artefact the restored metadata references is present (${String(rows.length)} object(s))`);
    return missing;
  }
  if (manifest.mode === "database") {
    log(
      `this was a database-only archive: ${String(missing.length)} referenced artefact(s) are not on this host and must come from the external store the manifest records (${manifest.source.artefact_driver}).`,
    );
  } else {
    log(`MISSING EVIDENCE: ${String(missing.length)} artefact(s) the restored metadata references are not in the store.`);
    for (const key of missing.slice(0, 10)) log(`  ${key}`);
    if (missing.length > 10) log(`  ... and ${String(missing.length - 10)} more`);
  }
  return missing;
}

/**
 * Applies a hostname change (`docs/DEPLOYMENT.md` §17).
 *
 * Moving an installation to another host is the ordinary reason to restore one,
 * and the credentials it holds name the host it was reached at: a browser
 * session cookie, an unspent installation token and an agent credential were
 * all issued for the old origin. Carrying them across would be "restore into a
 * new hostname silently reusing credentials that should be rotated", so they
 * are revoked and the count is reported.
 *
 * The hostname itself is configuration the control plane reads at startup, not
 * a row: this command cannot set `REVIEWPLANE_GATEWAY_DOMAIN` for the container
 * that will run next, so it says which setting to change rather than pretending
 * to have changed it.
 */
async function applyHostname(
  options: RestoreOptions,
  manifest: BackupManifest,
  log: (line: string) => void,
): Promise<{
  hostnameChanged: boolean;
  humanSessions: number;
  installTokens: number;
  agentCredentials: number;
}> {
  const none = {
    hostnameChanged: false,
    humanSessions: 0,
    installTokens: 0,
    agentCredentials: 0,
  };
  const hostname = options.hostname;
  if (hostname === undefined || hostname === "") return none;
  const previous = manifest.source.hostname;
  if (previous === hostname) {
    log(`the archive was taken from ${hostname}; nothing to rotate`);
    return none;
  }

  const exists = async (table: string): Promise<boolean> => {
    const { rows } = await options.pool.query<{ present: boolean }>(
      "select to_regclass($1) is not null as present",
      [table],
    );
    return rows[0]?.present === true;
  };
  const revoke = async (sql: string, table: string): Promise<number> => {
    if (!(await exists(table))) return 0;
    const result = await options.pool.query(sql);
    return result.rowCount ?? 0;
  };

  const humanSessions = await revoke(
    `update viewer_sessions
        set revoked_at = now(), revocation_reason = 'revoked_by_administrator'
      where revoked_at is null`,
    "viewer_sessions",
  );
  const installTokens = await revoke(
    "update install_tokens set consumed_at = now() where consumed_at is null",
    "install_tokens",
  );
  const agentCredentials = await revoke(
    "update agent_credentials set revoked_at = now() where revoked_at is null",
    "agent_credentials",
  );

  log(`restored to ${hostname}${previous === undefined ? "" : ` (was ${previous})`}`);
  log(
    `revoked ${String(humanSessions)} sign-in session(s), ${String(installTokens)} installation token(s) and ${String(agentCredentials)} agent credential(s): they were issued for the previous host.`,
  );
  log(`Set REVIEWPLANE_GATEWAY_DOMAIN and REVIEWPLANE_PUBLIC_ORIGIN to ${hostname} before starting the stack, then run reviewplane install-token --force to sign in.`);
  return { hostnameChanged: true, humanSessions, installTokens, agentCredentials };
}

/**
 * Reports connectors the restored installation cannot serve.
 *
 * A connector's identity is signed by the certificate authority in
 * `connector_tls_material`, which a backup excludes unless the operator opted
 * in. Without it the restored control plane generates a new authority on first
 * start, and every identity it issued before is one the tunnel gateway will not
 * trust. That is the correct outcome — a signing key in a backup file is worse —
 * but it is only safe if the restore says so.
 */
async function countConnectorsNeedingReEnrolment(
  pool: Pool,
  manifest: BackupManifest,
  log: (line: string) => void,
): Promise<number> {
  if (manifest.key_material.included) return 0;
  const { rows } = await pool.query<{ present: boolean }>(
    "select to_regclass('connectors') is not null as present",
  );
  if (rows[0]?.present !== true) return 0;
  const counted = await pool.query<{ count: string }>(
    "select count(*)::text as count from connectors where revoked_at is null",
  );
  const count = Number(counted.rows[0]?.count ?? "0");
  if (count > 0) {
    log(
      `${String(count)} connector identity(ies) were signed by an authority whose private key this archive deliberately excludes; the restored installation generates a new authority and those connectors must be re-enrolled (docs/DEPLOYMENT.md section 13).`,
    );
  }
  return count;
}

/** `docs/SECURITY.md` §16: audit must cover export and backup operations. */
async function recordRestoreEvent(
  pool: Pool,
  manifest: BackupManifest,
  detail: {
    now: () => Date;
    hostnameChanged: boolean;
    missing: number;
    rows: number;
    artefactObjects: number;
  },
): Promise<void> {
  const organisation = await pool.query<{ id: string }>(
    "select id from organisations order by created_at limit 1",
  );
  const organisationId = organisation.rows[0]?.id;
  if (organisationId === undefined) return;
  await inTransaction(pool, async (client) => {
    await appendEvent(client, {
      type: BACKUP_RESTORED_EVENT,
      organisationId,
      actor: { type: "system", display: "reviewplane restore" },
      occurredAt: detail.now(),
      payload: {
        mode: manifest.mode,
        schema_version: manifest.schema_version,
        product_version: manifest.product.version,
        backup_created_at: manifest.created_at,
        rows: detail.rows,
        artefact_objects: detail.artefactObjects,
        artefacts_missing: detail.missing,
        key_material_included: manifest.key_material.included,
        hostname_changed: detail.hostnameChanged,
      },
    });
  });
}
