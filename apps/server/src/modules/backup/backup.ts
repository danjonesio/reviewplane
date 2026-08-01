/**
 * `reviewplane backup` (`docs/DEPLOYMENT.md` §16, `docs/OPERATIONS.md` §11).
 *
 * One command, one archive. Under the default `filesystem` driver a complete
 * single-host backup is the database plus one directory, which is the
 * operational simplification ADR-0012 was chosen for, so the default mode
 * carries both. An installation whose artefacts live in external storage backs
 * the database up alone and records that it did, because a manifest that did
 * not say which mode produced it would make a database-only archive
 * indistinguishable from a truncated full one.
 *
 * Three properties are load-bearing:
 *
 *   * **Key material is excluded unless the operator opts in.**
 *     `connector_tls_material` holds a signing key, and a backup is a file
 *     somebody copies to another machine (`docs/SECURITY.md` §20). The opt-in
 *     prints a warning and the manifest and the audit event both record which
 *     way round it was.
 *   * **Nothing is presented as valid until it is complete.** The archive is
 *     written to `<output>.partial` and renamed at the end, so an interrupted
 *     backup leaves no file a restore would read.
 *   * **Secrets never reach the output or the log.** The configuration member
 *     records the name of every setting and the value of the ones that are not
 *     credentials; a credential-shaped setting is recorded as present and
 *     redacted.
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Writable } from "node:stream";

import type {
  BackupArtefactDriver,
  BackupEntry,
  BackupManifest,
  BackupMode,
  BackupTable,
} from "@reviewplane/protocol/platform";

import { migrationState } from "../../db/migrate.ts";
import type { Pool } from "../../db/pool.ts";
import { inTransaction } from "../../db/pool.ts";
import { appendEvent } from "../../events/append.ts";
import { readBuildInfo } from "../../health.ts";
import {
  ARTEFACT_PREFIX,
  CONFIGURATION_PATH,
  MANIFEST_PATH,
  MANIFEST_VERSION,
  renderManifest,
  tableMemberPath,
} from "./manifest.ts";
import { ArchiveWriter, digestFile } from "./archive.ts";
import {
  beginSnapshot,
  exportTable,
  KEY_MATERIAL_TABLES,
  listTables,
} from "./tables.ts";

/** Event types this module writes (`docs/EVENTS.md` §7, `docs/SECURITY.md` §16). */
export const BACKUP_CREATED_EVENT = "backup.created";
export const BACKUP_RESTORED_EVENT = "backup.restored";

/**
 * The warning the opt-in path prints.
 *
 * It is a constant so the security test can assert the exact words rather than
 * asserting that "a warning" was printed, which is a test that passes when the
 * warning becomes an empty string.
 */
export const KEY_MATERIAL_WARNING = [
  "WARNING: this archive will contain key material.",
  "  The connector certificate authority's private key travels in the archive.",
  "  Anyone holding the file can issue connector identities this installation trusts.",
  "  Store it encrypted, transfer it encrypted, and delete it when the restore is done",
  "  (docs/SECURITY.md section 20).",
].join("\n");

export interface BackupOptions {
  readonly pool: Pool;
  /**
   * Where the finished archive is published: a path, or a stream.
   *
   * A stream is how `--output -` works, and it is what makes the command
   * usable in a container: the archive lands in the operator's own shell
   * redirection on the host rather than in a volume they then have to copy it
   * out of (`docs/DEPLOYMENT.md` §16).
   */
  readonly output: string | { readonly stream: Writable };
  readonly mode: BackupMode;
  /** `docs/SECURITY.md` §20: never the default, always explicit. */
  readonly includeKeyMaterial?: boolean;
  /** Filesystem artefact-store root, read in `full` mode. */
  readonly artefactPath: string;
  readonly artefactDriver: BackupArtefactDriver;
  /** The environment the configuration record is taken from. */
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
}

export interface BackupResult {
  /** The published path, or `null` when the archive was streamed. */
  readonly archive: string | null;
  /** Size of the compressed archive on disk. */
  readonly bytes: number;
  /** Digest of the whole archive, which is what an operator records. */
  readonly sha256: string;
  readonly manifest: BackupManifest;
  /** Storage keys the metadata referenced and the store did not hold. */
  readonly missingArtefacts: readonly string[];
}

export class BackupError extends Error {}

/**
 * Settings whose value is a credential, matched on the name.
 *
 * A deny-list on names is a heuristic, so it is not the only defence: a value
 * carrying URL user information is redacted whatever the setting is called,
 * which is what catches `REVIEWPLANE_DATABASE_URL`.
 */
const CREDENTIAL_NAME = /(password|secret|token|credential|private_key|_key$|_key_|api_key)/iu;

/** `scheme://user:password@host` — the shape a connection string hides a secret in. */
const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/iu;

export interface ConfigurationSetting {
  readonly name: string;
  readonly value?: string;
  /** Present, and withheld. Stated so a restore can tell "unset" from "secret". */
  readonly redacted?: true;
}

/**
 * The configuration half of the archive
 * (`docs/DEPLOYMENT.md` §16: "configuration excluding secret values where
 * possible").
 *
 * It records every `REVIEWPLANE_` setting the process was started with. A
 * setting whose name or value looks like a credential is recorded as present
 * and redacted, because "this deployment sets a database password" is what a
 * restore needs to know and the password itself is what it must not carry.
 */
export function describeConfiguration(
  environment: NodeJS.ProcessEnv,
): { readonly settings: readonly ConfigurationSetting[] } {
  const settings: ConfigurationSetting[] = [];
  for (const name of Object.keys(environment).sort()) {
    if (!name.startsWith("REVIEWPLANE_")) continue;
    const value = environment[name];
    if (value === undefined) continue;
    if (CREDENTIAL_NAME.test(name) || URL_USERINFO.test(value)) {
      settings.push({ name, redacted: true });
      continue;
    }
    settings.push({ name, value });
  }
  return { settings };
}

/** The store root's content-addressed keys, as `sha256/<xx>/<62 hex>`. */
export async function listStoredObjects(artefactPath: string): Promise<string[]> {
  const root = join(artefactPath, "sha256");
  let shards: string[];
  try {
    shards = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const keys: string[] = [];
  for (const shard of shards.sort()) {
    if (!/^[0-9a-f]{2}$/u.test(shard)) continue;
    const names = await readdir(join(root, shard));
    for (const name of names.sort()) {
      if (!/^[0-9a-f]{62}$/u.test(name)) continue;
      keys.push(`sha256/${shard}/${name}`);
    }
  }
  return keys;
}

/** The digest a content-addressed key states its own bytes have. */
function digestFromKey(key: string): string {
  const parts = key.split("/");
  return `${parts[1] ?? ""}${parts[2] ?? ""}`;
}

/** Whether a column exists, so a backup can run against an older schema. */
async function hasColumn(pool: Pool, table: string, column: string): Promise<boolean> {
  const { rows } = await pool.query<{ present: boolean }>(
    `select count(*) > 0 as present
       from information_schema.columns
      where table_schema = 'public' and table_name = $1 and column_name = $2`,
    [table, column],
  );
  return rows[0]?.present === true;
}

/** Storage keys the metadata says must exist, and the key references it names. */
async function readArtefactMetadata(
  pool: Pool,
): Promise<{ storageKeys: string[]; keyReferences: string[] }> {
  if (!(await hasColumn(pool, "artefacts", "storage_key"))) {
    return { storageKeys: [], keyReferences: [] };
  }
  const live = (await hasColumn(pool, "artefacts", "deleted_at")) ? "and deleted_at is null" : "";
  const keys = await pool.query<{ storage_key: string }>(
    `select distinct storage_key from artefacts where storage_key is not null ${live}`,
  );
  const references = (await hasColumn(pool, "artefacts", "encryption_key_reference"))
    ? await pool.query<{ encryption_key_reference: string }>(
        `select distinct encryption_key_reference from artefacts
          where encryption_key_reference is not null
          order by encryption_key_reference`,
      )
    : { rows: [] as { encryption_key_reference: string }[] };
  return {
    storageKeys: keys.rows.map((row) => row.storage_key),
    keyReferences: references.rows.map((row) => row.encryption_key_reference),
  };
}

/**
 * Writes one backup archive.
 *
 * The order is deliberate: everything the archive will contain is measured
 * first, the manifest is built from the measurements, and only then is the
 * archive written — with each member's digest checked against the manifest as
 * it goes. That is what makes the manifest the first member without making it a
 * promise nothing verifies.
 */
export async function createBackup(options: BackupOptions): Promise<BackupResult> {
  const log = options.log ?? ((): void => undefined);
  const now = options.now ?? ((): Date => new Date());
  const environment = options.environment ?? process.env;
  const includeKeyMaterial = options.includeKeyMaterial === true;

  const state = await migrationState(options.pool);
  if (state.schemaVersion === null) {
    throw new BackupError(
      "this database has no schema; there is nothing to back up. Run reviewplane migrate first.",
    );
  }
  if (options.mode === "full" && options.artefactDriver !== "filesystem") {
    throw new BackupError(
      `this installation stores artefacts with the ${options.artefactDriver} driver, whose objects are not on a volume this command can read. Take a database-only backup with --mode database and protect the bucket separately (docs/DEPLOYMENT.md section 12).`,
    );
  }
  if (includeKeyMaterial) log(KEY_MATERIAL_WARNING);

  // The staging directory holds the per-table exports while their sizes are
  // measured: `tar` cannot describe a member whose length it has not seen, and
  // holding an installation's rows in memory to find out is not an option. It
  // sits beside the output when there is one, so the operator's chosen volume
  // is the one that has to have room; a streamed archive stages beside the
  // artefact store, which is the writable volume a container has.
  const stagingBase =
    typeof options.output === "string" ? options.output : join(options.artefactPath, ".backup");
  await mkdir(dirname(stagingBase), { recursive: true });
  const staging = await mkdtemp(`${stagingBase}.staging-`);
  const writer =
    typeof options.output === "string"
      ? ArchiveWriter.open(options.output)
      : ArchiveWriter.toStream(options.output.stream);
  try {
    const excludedTables = includeKeyMaterial ? [] : [...KEY_MATERIAL_TABLES];
    const client = await options.pool.connect();
    const tables: BackupTable[] = [];
    const staged: { table: string; file: string; bytes: number }[] = [];
    try {
      await beginSnapshot(client);
      for (const table of await listTables(client)) {
        const file = join(staging, `${table}.jsonl`);
        const sink = createWriteStream(file, { mode: 0o600 });
        let rows = 0;
        try {
          if (!excludedTables.includes(table)) {
            rows = await exportTable(client, table, async (line) => {
              if (!sink.write(`${line}\n`)) {
                await new Promise<void>((resolve, reject) => {
                  sink.once("drain", resolve);
                  sink.once("error", reject);
                });
              }
            });
          }
        } finally {
          await new Promise<void>((resolve, reject) => {
            sink.end((error?: Error | null) => {
              if (error === undefined || error === null) resolve();
              else reject(error);
            });
          });
        }
        tables.push({ name: table, rows });
        staged.push({ table, file, bytes: (await stat(file)).size });
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const metadata = await readArtefactMetadata(options.pool);
    const stored = options.mode === "full" ? await listStoredObjects(options.artefactPath) : [];
    const storedSet = new Set(stored);
    const missing =
      options.mode === "full"
        ? metadata.storageKeys.filter((key) => !storedSet.has(key)).sort()
        : [];

    const configuration = Buffer.from(
      `${JSON.stringify(describeConfiguration(environment), null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(staging, "configuration.json"), configuration, { mode: 0o600 });

    let artefactBytes = 0;
    const artefactEntries: BackupEntry[] = [];
    for (const key of stored) {
      const info = await stat(join(options.artefactPath, key));
      artefactBytes += info.size;
      artefactEntries.push({
        path: `${ARTEFACT_PREFIX}${key}`,
        bytes: info.size,
        sha256: digestFromKey(key),
      });
    }

    const build = readBuildInfo();
    const hostname = environment["REVIEWPLANE_GATEWAY_DOMAIN"];
    const manifest: BackupManifest = {
      manifest_version: MANIFEST_VERSION,
      created_at: now().toISOString(),
      mode: options.mode,
      product: { version: build.version, revision: build.revision, built_at: build.builtAt },
      schema_version: state.schemaVersion,
      source: {
        ...(hostname === undefined || hostname === "" ? {} : { hostname }),
        artefact_driver: options.artefactDriver,
      },
      tables,
      artefact_objects: artefactEntries.length,
      artefact_bytes: artefactBytes,
      ...(missing.length === 0 ? {} : { artefacts_missing: missing }),
      key_material: { included: includeKeyMaterial, excluded_tables: excludedTables },
      key_references: metadata.keyReferences,
      configuration_included: true,
      checksum_algorithm: "sha256",
      entries: [
        {
          path: CONFIGURATION_PATH,
          bytes: configuration.length,
          sha256: createHash("sha256").update(configuration).digest("hex"),
        },
        ...staged.map((entry) => ({
          path: tableMemberPath(entry.table),
          bytes: entry.bytes,
          // Filled in below; the archive writer is the one that reads the file.
          sha256: "0".repeat(64),
        })),
        ...artefactEntries,
      ],
    };

    // The staged table files are digested by the writer as it copies them, so
    // the manifest records what was written rather than what was intended.
    const digests = new Map<string, string>();
    for (const entry of staged) {
      const { sha256, bytes } = await digestFile(entry.file);
      digests.set(tableMemberPath(entry.table), sha256);
      if (bytes !== entry.bytes) {
        throw new BackupError(`${entry.table} changed while it was being staged`);
      }
    }
    const entries = manifest.entries.map((entry) => {
      const digest = digests.get(entry.path);
      return digest === undefined ? entry : { ...entry, sha256: digest };
    });
    const finalManifest: BackupManifest = { ...manifest, entries };

    await writer.addBuffer(MANIFEST_PATH, renderManifest(finalManifest));
    const expected = new Map(finalManifest.entries.map((entry) => [entry.path, entry]));
    /**
     * Checks a written member against the manifest, and names the *reason*.
     *
     * An artefact object's expected digest is its content-addressed key rather
     * than something measured a moment earlier, so a mismatch there is almost
     * never "the file changed": it is a stored object whose bytes no longer
     * hash to the key the store filed them under — bit rot, or a store somebody
     * has written into by hand. Reporting that as a race told an operator to
     * look for a concurrent writer, and left them with no way to take any
     * backup at all until they found the object themselves. It now names the
     * object, the digest it should have and the digest it has.
     */
    const check = (written: { path: string; bytes: number; sha256: string }): void => {
      const declared = expected.get(written.path);
      if (declared === undefined) throw new BackupError(`${written.path} is not in the manifest`);
      if (declared.sha256 === written.sha256 && declared.bytes === written.bytes) return;
      if (written.path.startsWith(ARTEFACT_PREFIX)) {
        throw new BackupError(
          `${written.path} does not hold the bytes its content-addressed key names: the store has ${written.sha256} (${String(written.bytes)} bytes) where it should have ${declared.sha256} (${String(declared.bytes)} bytes). The stored object is corrupt; the backup has been abandoned rather than recording the wrong bytes under the right digest. Remove or replace the object and run the backup again.`,
        );
      }
      throw new BackupError(
        `${written.path} changed while the archive was being written (${String(declared.bytes)} bytes became ${String(written.bytes)})`,
      );
    };
    check(await writer.addBuffer(CONFIGURATION_PATH, configuration));
    for (const entry of staged) {
      check(await writer.addFile(tableMemberPath(entry.table), entry.file));
    }
    for (const entry of artefactEntries) {
      const key = entry.path.slice(ARTEFACT_PREFIX.length);
      check(await writer.addFile(entry.path, join(options.artefactPath, key)));
    }
    const finished = await writer.close();

    await recordBackupEvent(options.pool, finalManifest, finished.sha256, missing.length);

    return {
      archive: finished.path,
      bytes: finished.bytes,
      sha256: finished.sha256,
      manifest: finalManifest,
      missingArtefacts: missing,
    };
  } catch (error) {
    await writer.abort();
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Records that a backup was taken (`docs/SECURITY.md` §16: audit must cover
 * export and backup operations).
 *
 * The event carries the archive's digest, the mode, the schema version and
 * whether key material rode along. It never carries the output path: an
 * operator's chosen destination is not information the audit trail needs, and a
 * path is the one field of this operation most likely to name a mount, a host
 * or a share.
 */
async function recordBackupEvent(
  pool: Pool,
  manifest: BackupManifest,
  archiveDigest: string,
  missing: number,
): Promise<void> {
  const organisation = await pool.query<{ id: string }>(
    "select id from organisations order by created_at limit 1",
  );
  const organisationId = organisation.rows[0]?.id;
  if (organisationId === undefined) return;
  // Upgrading from Stage 0 begins by backing up a Stage 0 database, whose
  // schema predates `event_outbox` (migration `0056`). The audit record is
  // still written — it is what the upgrade preflight reads to answer "is there
  // something to roll back to" — and only the delivery obligation is skipped,
  // because there is no table to record one in and no subscriber to deliver to.
  const outbox = await pool.query<{ present: boolean }>(
    "select to_regclass('event_outbox') is not null as present",
  );
  await inTransaction(pool, async (client) => {
    await appendEvent(client, {
      type: BACKUP_CREATED_EVENT,
      organisationId,
      enqueueOutbox: outbox.rows[0]?.present === true,
      actor: { type: "system", display: "reviewplane backup" },
      payload: {
        mode: manifest.mode,
        schema_version: manifest.schema_version,
        product_version: manifest.product.version,
        archive_sha256: archiveDigest,
        tables: manifest.tables.length,
        rows: manifest.tables.reduce((total, table) => total + table.rows, 0),
        artefact_objects: manifest.artefact_objects,
        artefact_bytes: manifest.artefact_bytes,
        artefacts_missing: missing,
        key_material_included: manifest.key_material.included,
      },
    });
  });
}
