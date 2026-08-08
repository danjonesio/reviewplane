/**
 * The `filesystem` artefact driver: ADR-0012's default (`docs/DEPLOYMENT.md`
 * §5's `artefact_data` volume).
 *
 * It exists so that a single-host installation stores evidence on a disk the
 * control-plane server already owns, with no extra container, no credential
 * pair and no bucket bootstrap. The server is the data path under this driver,
 * which ADR-0012 accepts and records as its cost.
 *
 * **Atomicity** is a temporary file plus a rename, as ADR-0012 requires. A
 * rename within one filesystem is atomic, so a concurrent reader sees either no
 * file or the whole file — never the prefix a partially completed write would
 * leave. The temporary name carries random bytes so two uploads of identical
 * content cannot collide on it, and a failed rename removes it rather than
 * leaving a fragment behind for an operator to wonder about.
 *
 * **Traversal** is impossible rather than filtered: `#resolve` refuses anything
 * that is not a content-addressed key, and no caller can supply one — the key
 * comes from a digest this file computes.
 */

import { mkdir, mkdtemp, opendir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ArtefactStoreError,
  assertArtefactKey,
  digestOf,
  keyForDigest,
  type ArtefactStore,
  type ArtefactStoreUsage,
  type StoredObject,
} from "./driver.ts";

/**
 * How many stored objects a usage sweep will walk.
 *
 * `docs/OPERATIONS.md` §3 wants storage use in a status command, and a status
 * command must return. A deployment past this bound gets a partial figure
 * marked partial rather than an unbounded directory walk.
 */
const USAGE_OBJECT_LIMIT = 200_000;

export class FilesystemArtefactStore implements ArtefactStore {
  readonly driver = "filesystem" as const;
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  get root(): string {
    return this.#root;
  }

  #resolve(key: string): string {
    return join(this.#root, assertArtefactKey(key));
  }

  async put(bytes: Buffer): Promise<StoredObject> {
    const sha256 = digestOf(bytes);
    const key = keyForDigest(sha256);
    const target = this.#resolve(key);
    const directory = join(this.#root, "sha256", sha256.slice(0, 2));
    try {
      await mkdir(directory, { recursive: true });
    } catch (error) {
      throw new ArtefactStoreError(
        `the artefact directory could not be created: ${describe(error)}`,
        { cause: error },
      );
    }

    // Temporary file plus rename: a reader sees either nothing or the whole
    // artefact, never a prefix of it.
    const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, bytes, { mode: 0o640 });
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new ArtefactStoreError(`artefact could not be stored: ${describe(error)}`, {
        cause: error,
      });
    }
    return { key, sizeBytes: bytes.byteLength, sha256 };
  }

  async get(key: string): Promise<Buffer> {
    const path = this.#resolve(key);
    try {
      return await readFile(path);
    } catch (error) {
      throw new ArtefactStoreError(`artefact ${key} could not be read: ${describe(error)}`, {
        cause: error,
      });
    }
  }

  async verify(key: string): Promise<StoredObject> {
    const path = this.#resolve(key);
    const entry = await stat(path).catch(() => null);
    if (entry === null) throw new ArtefactStoreError(`artefact ${key} is not stored`);
    const bytes = await readFile(path);
    return { key, sizeBytes: bytes.byteLength, sha256: digestOf(bytes) };
  }

  async delete(key: string): Promise<void> {
    await rm(this.#resolve(key), { force: true });
  }

  /**
   * The root is present and this process can list it.
   *
   * A volume that has gone — unmounted, renamed, never mounted — fails here,
   * which is the condition a reader has to know about. A read-only mount does
   * not, and must not: serving evidence from one is the deliberate arrangement
   * the MCP endpoint runs under.
   *
   * The content-addressed subtree is absent on a fresh installation that has
   * stored nothing, so the root rather than `sha256/` is what is opened;
   * treating "nothing stored yet" as unreadable would refuse the first
   * verification of every new deployment.
   */
  async probeReadable(): Promise<void> {
    try {
      const entry = await stat(this.#root);
      if (!entry.isDirectory()) {
        throw new Error("it is not a directory");
      }
      await opendir(this.#root).then(async (directory) => directory.close());
    } catch (error) {
      throw new ArtefactStoreError(
        `the filesystem artefact store at ${this.#root} is not readable: ${describe(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * A real round trip, outside the content-addressed tree.
   *
   * Writing under `sha256/` would create an object with a key no artefact
   * claims, which a later usage sweep would count and an operator would find
   * without an explanation. The probe directory is its own, and the probe
   * removes what it wrote.
   */
  async probe(): Promise<void> {
    const directory = join(this.#root, "probe");
    const path = join(directory, `probe-${randomBytes(8).toString("hex")}`);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(path, "reviewplane", { mode: 0o600 });
      const read = await readFile(path, "utf8");
      if (read !== "reviewplane") {
        throw new Error("the probe read back different bytes than it wrote");
      }
    } catch (error) {
      throw new ArtefactStoreError(
        `the filesystem artefact store at ${this.#root} is not writable: ${describe(error)}`,
        { cause: error },
      );
    } finally {
      await rm(path, { force: true }).catch(() => undefined);
    }
  }

  async usage(): Promise<ArtefactStoreUsage> {
    let objectCount = 0;
    let bytes = 0;
    let complete = true;
    const root = join(this.#root, "sha256");
    let directory;
    try {
      directory = await opendir(root, { recursive: true });
    } catch {
      // No tree yet is an empty store, not a failure: a fresh installation has
      // stored nothing.
      return { objectCount: 0, bytes: 0, complete: true };
    }
    for await (const entry of directory) {
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".tmp")) continue;
      if (objectCount >= USAGE_OBJECT_LIMIT) {
        complete = false;
        break;
      }
      const measured = await stat(join(entry.parentPath, entry.name)).catch(() => null);
      if (measured === null) continue;
      objectCount += 1;
      bytes += measured.size;
    }
    return { objectCount, bytes, complete };
  }
}

/** A store rooted in a fresh temporary directory. For tests and probes. */
export async function temporaryArtefactStore(): Promise<FilesystemArtefactStore> {
  return new FilesystemArtefactStore(await mkdtemp(join(tmpdir(), "reviewplane-artefacts-")));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
