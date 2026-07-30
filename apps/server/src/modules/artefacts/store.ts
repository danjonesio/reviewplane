/**
 * The artefact storage driver interface and its filesystem implementation
 * (ADR-0012).
 *
 * ADR-0012 fixes three properties that this file is responsible for:
 *
 * * keys are content-addressed and never contain a user-entered name, so an
 *   uploader cannot choose where its bytes land or what they are called;
 * * writes are atomic — a temporary file and a rename — so a reader never sees
 *   a partially written artefact;
 * * the driver is the only way to reach storage, so the `s3` driver can be
 *   added later without the rest of the server learning about it.
 *
 * Path traversal is structurally impossible rather than filtered: the key is
 * derived from a SHA-256 digest the server computes itself, and `resolve`
 * rejects anything that is not 64 lowercase hexadecimal characters.
 */

import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat, unlink, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface StoredObject {
  readonly key: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface ArtefactStore {
  /** Writes bytes atomically and returns their content-addressed key. */
  put(bytes: Buffer): Promise<StoredObject>;
  /** Reads an object back. Throws when the key is unknown or malformed. */
  get(key: string): Promise<Buffer>;
  /** Recomputes the digest of stored bytes, for verification. */
  verify(key: string): Promise<StoredObject>;
  delete(key: string): Promise<void>;
}

export class ArtefactStoreError extends Error {}

const KEY_PATTERN = /^sha256\/[0-9a-f]{2}\/[0-9a-f]{62}$/u;

/** Content-addressed key for a digest: `sha256/ab/cdef…`. */
export function keyForDigest(sha256: string): string {
  if (!/^[0-9a-f]{64}$/u.test(sha256)) {
    throw new ArtefactStoreError("an artefact key is derived from a lowercase SHA-256 digest");
  }
  return `sha256/${sha256.slice(0, 2)}/${sha256.slice(2)}`;
}

export class FilesystemArtefactStore implements ArtefactStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  #resolve(key: string): string {
    if (!KEY_PATTERN.test(key)) {
      throw new ArtefactStoreError(`artefact key ${key} is not a content-addressed key`);
    }
    return join(this.#root, key);
  }

  async put(bytes: Buffer): Promise<StoredObject> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const key = keyForDigest(sha256);
    const target = this.#resolve(key);
    const directory = join(this.#root, "sha256", sha256.slice(0, 2));
    await mkdir(directory, { recursive: true });

    // Temporary file plus rename: a reader sees either nothing or the whole
    // artefact, never a prefix of it.
    const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o640 });
    try {
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new ArtefactStoreError(
        `artefact could not be stored: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { key, sizeBytes: bytes.byteLength, sha256 };
  }

  async get(key: string): Promise<Buffer> {
    const path = this.#resolve(key);
    try {
      return await readFile(path);
    } catch (error) {
      throw new ArtefactStoreError(
        `artefact ${key} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async verify(key: string): Promise<StoredObject> {
    const path = this.#resolve(key);
    const entry = await stat(path).catch(() => null);
    if (entry === null) throw new ArtefactStoreError(`artefact ${key} is not stored`);
    const bytes = await readFile(path);
    return {
      key,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  async delete(key: string): Promise<void> {
    await rm(this.#resolve(key), { force: true });
  }
}
