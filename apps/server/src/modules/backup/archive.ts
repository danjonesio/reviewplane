/**
 * The backup archive container: a POSIX `ustar` tar stream inside a zstd frame
 * (`docs/DEPLOYMENT.md` §16, "a single archive").
 *
 * Both halves are written here rather than taken from a library for one
 * reason: the reader is a security boundary. A restore reads an archive an
 * operator may have moved between machines, and the two ways a tar reader is
 * dangerous — a member whose path escapes the destination, and a member whose
 * size the reader trusts — are refused here by construction. `..`, an absolute
 * path, a backslash, a symbolic link, a device node and a directory entry are
 * all refused; only regular files with a bounded relative path are accepted.
 *
 * Truncation is caught by whichever of three layers the cut lands in, and the
 * point is that none of them can be missed: zstd checks its own frame, this
 * reader refuses a stream that ends without the two zero blocks that end a tar
 * or inside a member it was told the length of, and the manifest's per-member
 * digests catch a member that decompressed cleanly and is not the member that
 * was written. Which layer reports it depends on where the copy stopped; that
 * it is reported does not.
 *
 * The writer never writes the destination path until it is complete. It writes
 * `<output>.partial`, closes it, and renames — so an interrupted backup leaves
 * a `.partial` file that no restore will read, rather than an archive that
 * looks finished (`docs/TESTING.md` §11).
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdCompress, createZstdDecompress } from "node:zlib";

/** Tar block size. Every header is one block and every payload is padded to it. */
const BLOCK = 512;

/**
 * Longest member path the writer accepts.
 *
 * `ustar` splits a longer path across `prefix` and `name`, and this writer does
 * not: the paths it writes are `manifest.json`, `configuration.json`,
 * `database/<table>.jsonl` and `artefacts/sha256/<2>/<62>`, whose longest form
 * is 82 bytes. Refusing at the bound is honest; silently truncating a name
 * would produce an archive that restores the wrong file.
 */
const MAX_PATH_BYTES = 100;

/** Bound on a single member, so a hostile size field cannot ask for unbounded memory. */
const MAX_MEMBER_BYTES = 64 * 1024 * 1024 * 1024;

/** Path shape a member must have. Enforced on write and on read. */
const MEMBER_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u;

export class ArchiveError extends Error {}

/** A member the reader has reached, before its bytes are delivered. */
export interface ArchiveMember {
  readonly path: string;
  readonly bytes: number;
}

/**
 * Where a reader sends one member's bytes.
 *
 * Returning `null` from {@link EntrySink.begin} skips the member: the reader
 * discards its bytes and keeps its place in the stream. That is how the
 * integrity pass reads an archive without writing anything, and how the apply
 * pass ignores members it has already handled.
 */
export interface EntryWriter {
  write(chunk: Buffer): void | Promise<void>;
  end(): void | Promise<void>;
}

export type EntrySink = (member: ArchiveMember) => Promise<EntryWriter | null>;

function assertMemberPath(path: string): void {
  if (!MEMBER_PATH.test(path)) {
    throw new ArchiveError(`archive member path is not accepted: ${JSON.stringify(path)}`);
  }
  // The pattern already excludes a leading slash and a backslash. This refuses
  // the two remaining traversal shapes, stated as their own check because a
  // regular expression that has to be read as a security control is one nobody
  // can review.
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ArchiveError(`archive member path traverses or is empty: ${JSON.stringify(path)}`);
  }
  if (Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) {
    throw new ArchiveError(
      `archive member path is longer than ${String(MAX_PATH_BYTES)} bytes: ${JSON.stringify(path)}`,
    );
  }
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function header(path: string, bytes: number, modifiedAt: number): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  block.write(path, 0, 100, "utf8");
  block.write(octal(0o600, 8), 100, 8, "ascii");
  block.write(octal(0, 8), 108, 8, "ascii");
  block.write(octal(0, 8), 116, 8, "ascii");
  block.write(octal(bytes, 12), 124, 12, "ascii");
  block.write(octal(Math.floor(modifiedAt / 1000), 12), 136, 12, "ascii");
  block.write("        ", 148, 8, "ascii"); // checksum placeholder
  block.write("0", 156, 1, "ascii"); // regular file
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

function padding(bytes: number): number {
  const remainder = bytes % BLOCK;
  return remainder === 0 ? 0 : BLOCK - remainder;
}

/** A member that has been written, with the digest the manifest binds it to. */
export interface WrittenMember {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * Writes a backup archive.
 *
 * Every member's size is known before its header is written, which is why the
 * backup stages the database export on disk first: tar cannot describe a member
 * whose length it has not yet seen, and buffering a whole installation's rows
 * in memory to find out is not an option.
 */
export class ArchiveWriter {
  readonly #compressor = createZstdCompress();
  readonly #meter = new PassThrough();
  readonly #digest = createHash("sha256");
  readonly #done: Promise<void>;
  /** `null` when the archive is being streamed rather than written to a file. */
  readonly #partialPath: string | null;
  readonly #finalPath: string | null;
  readonly #modifiedAt = Date.now();
  #bytes = 0;
  #closed = false;

  private constructor(destination: Writable, finalPath: string | null, partialPath: string | null) {
    this.#finalPath = finalPath;
    this.#partialPath = partialPath;
    // The digest is taken from the bytes on their way out, so the archive is
    // never read a second time to find out what was written — which matters
    // most in the streaming case, where there is nothing to read back.
    this.#meter.on("data", (chunk: Buffer) => {
      this.#bytes += chunk.length;
      this.#digest.update(chunk);
    });
    this.#done = pipeline(this.#compressor, this.#meter, destination);
  }

  /** Writes to a file, published at `finalPath` only when it is complete. */
  static open(finalPath: string): ArchiveWriter {
    const partial = `${finalPath}.partial`;
    return new ArchiveWriter(createWriteStream(partial, { mode: 0o600 }), finalPath, partial);
  }

  /**
   * Writes to a stream, which is how `--output -` reaches the operator's shell.
   *
   * Nothing is renamed, because there is nothing to rename: the destination is
   * the operator's redirection, and an interrupted stream leaves a truncated
   * file that {@link readArchive} refuses. That is a weaker guarantee than the
   * file form's rename and is documented as such in `docs/DEPLOYMENT.md` §16.
   */
  static toStream(destination: Writable): ArchiveWriter {
    return new ArchiveWriter(destination, null, null);
  }

  /** The path bytes are being written to while the archive is incomplete. */
  get partialPath(): string | null {
    return this.#partialPath;
  }

  async #push(chunk: Buffer): Promise<void> {
    if (!this.#compressor.write(chunk)) {
      await new Promise<void>((resolve, reject) => {
        this.#compressor.once("drain", resolve);
        this.#compressor.once("error", reject);
      });
    }
  }

  /** Adds a member whose bytes are already in memory. */
  async addBuffer(path: string, data: Buffer): Promise<WrittenMember> {
    assertMemberPath(path);
    await this.#push(header(path, data.length, this.#modifiedAt));
    await this.#push(data);
    const pad = padding(data.length);
    if (pad > 0) await this.#push(Buffer.alloc(pad, 0));
    return {
      path,
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  }

  /**
   * Adds a member by streaming a file, and returns the digest of what was
   * actually written.
   *
   * The size is taken once, before the header, and the copy is required to
   * produce exactly that many bytes. A file that grew or shrank between the
   * two would otherwise be written into a member whose header disagrees with
   * its content, which a reader would report as a corrupt archive at restore
   * time rather than as a defect here.
   */
  async addFile(path: string, source: string): Promise<WrittenMember> {
    assertMemberPath(path);
    const info = await stat(source);
    const bytes = info.size;
    if (bytes > MAX_MEMBER_BYTES) {
      throw new ArchiveError(`${path} is larger than this archive format carries`);
    }
    await this.#push(header(path, bytes, this.#modifiedAt));
    const digest = createHash("sha256");
    let written = 0;
    for await (const chunk of createReadStream(source)) {
      const buffer = chunk as Buffer;
      written += buffer.length;
      if (written > bytes) {
        throw new ArchiveError(`${source} grew while it was being archived`);
      }
      digest.update(buffer);
      await this.#push(buffer);
    }
    if (written !== bytes) {
      throw new ArchiveError(`${source} shrank while it was being archived`);
    }
    const pad = padding(bytes);
    if (pad > 0) await this.#push(Buffer.alloc(pad, 0));
    return { path, bytes, sha256: digest.digest("hex") };
  }

  /**
   * Finishes the archive and publishes it at its final path.
   *
   * The rename is the last thing that happens, so the destination either does
   * not exist or is a complete archive. It is also what makes "an interrupted
   * backup leaves no partial archive presented as valid" a property of the
   * writer rather than of the caller's error handling.
   */
  async close(): Promise<{ path: string | null; bytes: number; sha256: string }> {
    if (this.#closed) throw new ArchiveError("the archive is already closed");
    this.#closed = true;
    await this.#push(Buffer.alloc(BLOCK * 2, 0));
    this.#compressor.end();
    await this.#done;
    const written = { bytes: this.#bytes, sha256: this.#digest.digest("hex") };
    if (this.#partialPath === null || this.#finalPath === null) {
      return { path: null, ...written };
    }
    await rename(this.#partialPath, this.#finalPath);
    return { path: this.#finalPath, ...written };
  }

  /** Abandons an incomplete archive, leaving nothing at the destination. */
  async abort(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#compressor.destroy();
      await this.#done.catch(() => undefined);
    }
    if (this.#partialPath !== null) await rm(this.#partialPath, { force: true });
  }
}

/**
 * A bounded byte queue over the decompressed stream.
 *
 * The reader needs exact-length reads over chunks it did not choose the
 * boundaries of, and it must never accumulate more than the caller asked for.
 */
class ByteReader {
  #buffered: Buffer[] = [];
  #length = 0;
  readonly #source: AsyncIterator<Buffer>;

  constructor(source: AsyncIterable<Buffer>) {
    this.#source = source[Symbol.asyncIterator]();
  }

  async #fill(bytes: number): Promise<boolean> {
    while (this.#length < bytes) {
      const next = await this.#source.next();
      if (next.done === true) return false;
      this.#buffered.push(next.value);
      this.#length += next.value.length;
    }
    return true;
  }

  #take(bytes: number): Buffer {
    const out = Buffer.allocUnsafe(bytes);
    let filled = 0;
    while (filled < bytes) {
      const head = this.#buffered[0] as Buffer;
      const usable = Math.min(head.length, bytes - filled);
      head.copy(out, filled, 0, usable);
      filled += usable;
      if (usable === head.length) this.#buffered.shift();
      else this.#buffered[0] = head.subarray(usable);
    }
    this.#length -= bytes;
    return out;
  }

  /** Exactly `bytes`, or `null` at a clean end of stream. */
  async exact(bytes: number): Promise<Buffer | null> {
    if (!(await this.#fill(bytes))) {
      if (this.#length === 0) return null;
      throw new ArchiveError("the archive ends in the middle of a record; it is truncated");
    }
    return this.#take(bytes);
  }

  /** Up to `bytes`, never more, and never zero before the end of the stream. */
  async some(bytes: number): Promise<Buffer | null> {
    if (this.#length === 0 && !(await this.#fill(1))) return null;
    return this.#take(Math.min(bytes, this.#length));
  }
}

function readOctal(block: Buffer, offset: number, width: number): number {
  const raw = block.subarray(offset, offset + width).toString("ascii").replace(/\0.*$/u, "").trim();
  if (raw === "") return 0;
  if (!/^[0-7]+$/u.test(raw)) throw new ArchiveError("the archive has a malformed header field");
  return Number.parseInt(raw, 8);
}

function verifyChecksum(block: Buffer): void {
  const declared = readOctal(block, 148, 8);
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (block[index] as number);
  }
  if (sum !== declared) {
    throw new ArchiveError("an archive header failed its checksum; the archive is corrupt");
  }
}

/**
 * Reads an archive, handing each member to `sink`.
 *
 * Nothing about a member is trusted before it is checked: the header checksum,
 * the type flag, the path shape and the size bound are all verified before a
 * single byte is delivered, and a member the sink declines is drained rather
 * than skipped by seeking, because a seek would trust the size field it was
 * refusing to act on.
 */
export async function readArchive(path: string, sink: EntrySink): Promise<void> {
  const decompressed = createReadStream(path).pipe(createZstdDecompress());
  const reader = new ByteReader(decompressed as unknown as AsyncIterable<Buffer>);
  let zeroBlocks = 0;
  try {
    for (;;) {
      const block = await reader.exact(BLOCK);
      if (block === null) {
        throw new ArchiveError("the archive ends without its end-of-archive marker; it is truncated");
      }
      if (block.every((byte) => byte === 0)) {
        zeroBlocks += 1;
        if (zeroBlocks === 2) return;
        continue;
      }
      if (zeroBlocks > 0) {
        throw new ArchiveError("the archive has data after its end-of-archive marker");
      }
      verifyChecksum(block);
      const type = block.subarray(156, 157).toString("ascii");
      if (type !== "0" && type !== "\0") {
        throw new ArchiveError(
          `the archive holds a member of type ${JSON.stringify(type)}; only regular files are accepted`,
        );
      }
      const memberPath = block.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
      assertMemberPath(memberPath);
      const bytes = readOctal(block, 124, 12);
      if (bytes > MAX_MEMBER_BYTES) {
        throw new ArchiveError(`${memberPath} declares a size this reader refuses`);
      }
      const writer = await sink({ path: memberPath, bytes });
      let remaining = bytes;
      while (remaining > 0) {
        const chunk = await reader.some(remaining);
        if (chunk === null) {
          throw new ArchiveError(`the archive ends inside ${memberPath}; it is truncated`);
        }
        remaining -= chunk.length;
        if (writer !== null) await writer.write(chunk);
      }
      if (writer !== null) await writer.end();
      const pad = padding(bytes);
      if (pad > 0 && (await reader.exact(pad)) === null) {
        throw new ArchiveError(`the archive ends inside ${memberPath}; it is truncated`);
      }
    }
  } finally {
    decompressed.destroy();
  }
}

/**
 * Spools a stream to a file so that it can be read twice.
 *
 * A restore reads its archive twice on purpose — once to prove it, once to
 * apply it — and standard input can only be read once. An operator piping an
 * archive in therefore lands it on disk first. The destination is a directory
 * the caller chooses because the one writable volume a control-plane container
 * has is the artefact volume, which is also the volume already sized for the
 * evidence the archive carries.
 */
export async function spoolToFile(source: Readable, destination: string): Promise<number> {
  let bytes = 0;
  const meter = new PassThrough();
  meter.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
  });
  await pipeline(source, meter, createWriteStream(destination, { mode: 0o600 }));
  return bytes;
}

/** The digest of a whole archive file, which is what an operator records. */
export async function digestFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    digest.update(buffer);
  }
  return { bytes, sha256: digest.digest("hex") };
}
