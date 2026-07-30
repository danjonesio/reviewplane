/**
 * The filesystem artefact driver (ADR-0012). No database and no HTTP: these
 * are the properties the driver itself has to hold.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  ArtefactStoreError,
  FilesystemArtefactStore,
  keyForDigest,
} from "../src/modules/artefacts/store.ts";

let root: string;
let store: FilesystemArtefactStore;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "reviewplane-store-"));
  store = new FilesystemArtefactStore(root);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a key is derived from the content digest alone", () => {
  const digest = "a".repeat(64);
  assert.equal(keyForDigest(digest), `sha256/aa/${"a".repeat(62)}`);
});

test("a key cannot be derived from anything that is not a digest", () => {
  for (const candidate of ["", "../../etc/passwd", "A".repeat(64), "a".repeat(63)]) {
    assert.throws(() => keyForDigest(candidate), ArtefactStoreError);
  }
});

test("storing returns the content address and the bytes read back identically", async () => {
  const bytes = Buffer.from("browser evidence");
  const stored = await store.put(bytes);
  assert.equal(stored.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(stored.sizeBytes, bytes.byteLength);
  assert.equal(stored.key, keyForDigest(stored.sha256));
  assert.deepEqual(await store.get(stored.key), bytes);
});

test("storing the same bytes twice is idempotent and leaves one object", async () => {
  const bytes = Buffer.from("identical evidence");
  const first = await store.put(bytes);
  const second = await store.put(bytes);
  assert.equal(first.key, second.key);
  const shard = join(root, "sha256", first.sha256.slice(0, 2));
  const entries = await readdir(shard);
  assert.deepEqual(entries, [first.sha256.slice(2)]);
});

test("no temporary file survives a successful write", async () => {
  const stored = await store.put(Buffer.from("atomic write"));
  const shard = join(root, "sha256", stored.sha256.slice(0, 2));
  const entries = await readdir(shard);
  assert.equal(entries.some((entry) => entry.endsWith(".tmp")), false);
});

test("a traversal key is refused rather than resolved", async () => {
  for (const key of ["sha256/../../etc/passwd", "../etc/passwd", "sha256/aa/../../../etc/passwd"]) {
    await assert.rejects(() => store.get(key), ArtefactStoreError);
    await assert.rejects(() => store.verify(key), ArtefactStoreError);
    await assert.rejects(() => store.delete(key), ArtefactStoreError);
  }
});

test("verification recomputes the digest from what is on disk", async () => {
  const bytes = Buffer.from("verify me");
  const stored = await store.put(bytes);
  const verified = await store.verify(stored.key);
  assert.equal(verified.sha256, stored.sha256);
  assert.equal(verified.sizeBytes, bytes.byteLength);
});

test("verifying an object that is not stored fails", async () => {
  await assert.rejects(() => store.verify(keyForDigest("b".repeat(64))), ArtefactStoreError);
});

test("stored objects are not world-readable", async () => {
  const stored = await store.put(Buffer.from("permissions"));
  const entry = await stat(join(root, stored.key));
  assert.equal(entry.mode & 0o007, 0);
});
