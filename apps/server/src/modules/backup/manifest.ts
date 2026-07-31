/**
 * The backup manifest (`docs/DEPLOYMENT.md` §16), and the layout of an archive.
 *
 * The manifest is the first member of the archive, so a reader learns what it
 * is holding before it reads anything else, and it is validated against the
 * shared schema in `packages/protocol` on the way in as well as on the way out.
 * Validating it on the way in is the point: a restore is asked to read a file
 * an operator moved between machines, and "the manifest says so" is only a
 * safe sentence when the manifest has been checked against a schema neither
 * side can quietly widen.
 */

import { validateBackupManifest, type BackupManifest, type SchemaViolation } from "@reviewplane/protocol/platform";

/** The manifest's own member path. It is always written first. */
export const MANIFEST_PATH = "manifest.json";

/** Where the non-secret configuration record lives inside the archive. */
export const CONFIGURATION_PATH = "configuration.json";

/** Prefix for the per-table row exports. */
export const DATABASE_PREFIX = "database/";

/**
 * Prefix for artefact objects.
 *
 * The remainder of the path is the store's own content-addressed key, so a
 * member's path states the digest its bytes must have and a restore can check
 * one against the other without consulting the database (ADR-0012).
 */
export const ARTEFACT_PREFIX = "artefacts/";

/** The manifest structure this build writes and is able to read. */
export const MANIFEST_VERSION = 1;

export class ManifestError extends Error {}

/** The member path a table's rows are written to. */
export function tableMemberPath(table: string): string {
  return `${DATABASE_PREFIX}${table}.jsonl`;
}

/** The table a database member path names, or `null` when it names none. */
export function tableFromMemberPath(path: string): string | null {
  if (!path.startsWith(DATABASE_PREFIX) || !path.endsWith(".jsonl")) return null;
  return path.slice(DATABASE_PREFIX.length, -".jsonl".length);
}

/** The storage key an artefact member path names, or `null`. */
export function storageKeyFromMemberPath(path: string): string | null {
  if (!path.startsWith(ARTEFACT_PREFIX)) return null;
  return path.slice(ARTEFACT_PREFIX.length);
}

/**
 * Parses and validates a manifest read out of an archive.
 *
 * It refuses an unknown `manifest_version` before anything else, so a future
 * archive is reported as "written by a newer build" rather than as a list of
 * schema violations an operator cannot act on.
 */
export function parseManifest(raw: Buffer | string): BackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch (error) {
    throw new ManifestError(`the archive's manifest is not JSON: ${String(error)}`);
  }
  const version = (value as { manifest_version?: unknown } | null)?.manifest_version;
  if (version !== MANIFEST_VERSION) {
    throw new ManifestError(
      `the archive declares manifest version ${JSON.stringify(version)}; this build reads version ${String(MANIFEST_VERSION)}`,
    );
  }
  const violations: SchemaViolation[] = [];
  validateBackupManifest(value, "manifest", violations);
  const first = violations[0];
  if (first !== undefined) {
    throw new ManifestError(
      `the archive's manifest is not a valid backup manifest: ${first.path} ${first.message}`,
    );
  }
  return value as BackupManifest;
}

/** Serialises a manifest, validating it before it is written. */
export function renderManifest(manifest: BackupManifest): Buffer {
  const violations: SchemaViolation[] = [];
  validateBackupManifest(manifest, "manifest", violations);
  const first = violations[0];
  if (first !== undefined) {
    throw new ManifestError(
      `refusing to write an invalid backup manifest: ${first.path} ${first.message}`,
    );
  }
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
