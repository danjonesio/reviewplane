/**
 * The artefact storage-driver interface (ADR-0012).
 *
 * ADR-0012 makes storage reachable only through this interface, and fixes the
 * properties every driver has to hold regardless of what is behind it:
 *
 * * **keys are content-addressed** and never contain a user-entered name, so
 *   an uploader cannot choose where its bytes land or what they are called;
 * * **writes are atomic** — a reader sees either nothing or the whole
 *   artefact, never a prefix of it;
 * * **the driver is the only way to reach storage**, so a second driver can be
 *   added without the rest of the server learning about it.
 *
 * Path traversal is structurally impossible rather than filtered: a key is
 * derived from a SHA-256 digest the server computes itself, and every driver
 * refuses a key that is not one.
 *
 * The interface deliberately does **not** offer "write these bytes under this
 * name". There is no name to pass. That is what makes the traversal case in
 * `docs/TESTING.md` section 10 a property of the design rather than of a
 * validator somebody has to remember to call.
 */

import { createHash } from "node:crypto";

/** Driver names of ADR-0012. The value appears in configuration and status. */
export type ArtefactStorageDriver = "filesystem" | "s3";

export interface StoredObject {
  readonly key: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/** What the store holds, for `reviewplane status` (`docs/OPERATIONS.md` §3). */
export interface ArtefactStoreUsage {
  /** Distinct stored objects the driver can see. */
  readonly objectCount: number;
  readonly bytes: number;
  /**
   * True when the driver counted every object, false when it stopped at a
   * bound. An operator reading a total needs to know it is one.
   */
  readonly complete: boolean;
}

/** A short-lived, scoped URL a driver may issue instead of proxying bytes. */
export interface PresignedAccess {
  readonly url: string;
  readonly expiresAt: Date;
}

export interface ArtefactStore {
  readonly driver: ArtefactStorageDriver;
  /** Writes bytes atomically and returns their content-addressed key. */
  put(bytes: Buffer): Promise<StoredObject>;
  /** Reads an object back. Throws when the key is unknown or malformed. */
  get(key: string): Promise<Buffer>;
  /** Recomputes the digest of stored bytes, for verification. */
  verify(key: string): Promise<StoredObject>;
  delete(key: string): Promise<void>;
  /**
   * Proves the driver can complete a round trip now.
   *
   * `docs/OPERATIONS.md` §3 asks status for "artefact store availability", and
   * `docs/ARCHITECTURE.md` §14 requires an unavailable store to produce a clear
   * error rather than a falsely available artefact. A probe that only checked
   * for a directory would answer "available" for a read-only volume, so this
   * writes, reads and removes.
   */
  probe(): Promise<void>;
  /** What the store holds. Bounded: a driver may report a partial count. */
  usage(): Promise<ArtefactStoreUsage>;
  /**
   * A short-lived, scoped URL that serves one object, where the driver offers
   * one (ADR-0012, ADR-0019). Absent on a driver that proxies its bytes.
   */
  presignDownload?(
    key: string,
    options: {
      readonly ttlSeconds: number;
      readonly contentType: string;
      readonly contentDisposition: string;
    },
  ): Promise<PresignedAccess>;
}

export class ArtefactStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ArtefactStoreError";
  }
}

/** Shape of every content-addressed key. Nothing else is a key. */
export const ARTEFACT_KEY_PATTERN = /^sha256\/[0-9a-f]{2}\/[0-9a-f]{62}$/u;

/** Content-addressed key for a digest: `sha256/ab/cdef…`. */
export function keyForDigest(sha256: string): string {
  if (!/^[0-9a-f]{64}$/u.test(sha256)) {
    throw new ArtefactStoreError("an artefact key is derived from a lowercase SHA-256 digest");
  }
  return `sha256/${sha256.slice(0, 2)}/${sha256.slice(2)}`;
}

/** Refuses anything that is not a content-addressed key, before it is used. */
export function assertArtefactKey(key: string): string {
  if (!ARTEFACT_KEY_PATTERN.test(key)) {
    throw new ArtefactStoreError(`artefact key ${key} is not a content-addressed key`);
  }
  return key;
}

export function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
