/**
 * The artefact storage-driver conformance suite (ADR-0012).
 *
 * ADR-0012 records "two drivers must be tested; the driver interface needs
 * conformance tests run against both" as a consequence of the decision, so this
 * file is that requirement rather than a convenience: **every case below runs
 * against `filesystem` and against `s3`**, from one list, so a property that
 * holds for the default driver and not for the other is a failure rather than
 * an omission nobody noticed.
 *
 * The `s3` driver runs against an in-process S3-compatible endpoint that
 * recomputes the AWS Signature Version 4 over every request and refuses one
 * that does not match (`test/support/s3-endpoint.ts`). That makes the run a
 * protocol test of the driver's signing, canonicalisation and encoding, not an
 * exercise against a mock that agrees with whatever it is sent. Testing against
 * an external service is Stage 2 (`docs/DEPLOYMENT.md` §12); setting
 * `REVIEWPLANE_TEST_S3_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY` and `_SECRET_KEY`
 * points this same suite at one.
 *
 * No database and no HTTP API: these are the properties the driver itself holds.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import {
  ArtefactStoreError,
  FilesystemArtefactStore,
  S3ArtefactStore,
  keyForDigest,
  type ArtefactStore,
} from "../src/modules/artefacts/store/index.ts";
import { startStubS3, type StubS3Endpoint } from "./support/s3-endpoint.ts";

/** The two drivers, and what each needs to be started and stopped. */
interface DriverUnderTest {
  readonly name: "filesystem" | "s3";
  start(): Promise<ArtefactStore>;
  stop(): Promise<void>;
  /** Objects the driver currently holds, for the "one object" assertions. */
  objectKeys(): Promise<string[]>;
  /** Makes the next write fail, for the disk-full and endpoint-full cases. */
  breakWrites(): Promise<void>;
}

let filesystemRoot: string;
let stub: StubS3Endpoint | null = null;

const external = {
  endpoint: process.env["REVIEWPLANE_TEST_S3_ENDPOINT"],
  bucket: process.env["REVIEWPLANE_TEST_S3_BUCKET"],
  accessKey: process.env["REVIEWPLANE_TEST_S3_ACCESS_KEY"],
  secretKey: process.env["REVIEWPLANE_TEST_S3_SECRET_KEY"],
};

const filesystemDriver: DriverUnderTest = {
  name: "filesystem",
  async start() {
    filesystemRoot = await mkdtemp(join(tmpdir(), "reviewplane-store-"));
    return new FilesystemArtefactStore(filesystemRoot);
  },
  async stop() {
    await rm(filesystemRoot, { recursive: true, force: true });
  },
  async objectKeys() {
    const keys: string[] = [];
    const shards = await readdir(join(filesystemRoot, "sha256"), { withFileTypes: true }).catch(
      () => [],
    );
    for (const shard of shards) {
      if (!shard.isDirectory()) continue;
      for (const entry of await readdir(join(filesystemRoot, "sha256", shard.name))) {
        keys.push(`sha256/${shard.name}/${entry}`);
      }
    }
    return keys.sort();
  },
  async breakWrites() {
    // A directory the process cannot write to is the closest reproduction of a
    // full or read-only volume that does not need a real one
    // (`docs/TESTING.md` §11, "disk full").
    await rm(filesystemRoot, { recursive: true, force: true });
    const { mkdir, chmod } = await import("node:fs/promises");
    await mkdir(filesystemRoot, { recursive: true });
    await chmod(filesystemRoot, 0o500);
  },
};

const s3Driver: DriverUnderTest = {
  name: "s3",
  async start() {
    if (external.endpoint !== undefined) {
      return new S3ArtefactStore({
        endpoint: external.endpoint,
        bucket: external.bucket ?? "reviewplane",
        region: process.env["REVIEWPLANE_TEST_S3_REGION"] ?? "us-east-1",
        accessKeyId: external.accessKey ?? "",
        secretAccessKey: external.secretKey ?? "",
        prefix: `conformance-${String(Date.now())}`,
      });
    }
    stub = await startStubS3();
    return new S3ArtefactStore({
      endpoint: stub.url,
      bucket: stub.bucket,
      region: stub.region,
      accessKeyId: stub.accessKeyId,
      secretAccessKey: stub.secretAccessKey,
    });
  },
  async stop() {
    await stub?.stop();
    stub = null;
  },
  async objectKeys() {
    if (stub === null) return [];
    return [...stub.objects.keys()].filter((key) => key.startsWith("sha256/")).sort();
  },
  async breakWrites() {
    stub?.failWrites(1);
    await Promise.resolve();
  },
};

const DRIVERS: readonly DriverUnderTest[] = [filesystemDriver, s3Driver];

// Key derivation is driver-independent: it is the property that makes traversal
// impossible rather than filtered, and it belongs to the interface.
test("a key is derived from the content digest alone", () => {
  const digest = "a".repeat(64);
  assert.equal(keyForDigest(digest), `sha256/aa/${"a".repeat(62)}`);
});

test("a key cannot be derived from anything that is not a digest", () => {
  for (const candidate of ["", "../../etc/passwd", "A".repeat(64), "a".repeat(63)]) {
    assert.throws(() => keyForDigest(candidate), ArtefactStoreError);
  }
});

for (const driver of DRIVERS) {
  describe(`the ${driver.name} artefact driver`, () => {
    let store: ArtefactStore;

    before(async () => {
      store = await driver.start();
    });

    after(async () => {
      await driver.stop();
    });

    test("reports its own name", () => {
      assert.equal(store.driver, driver.name);
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
      const bytes = Buffer.from(`identical evidence for ${driver.name}`);
      const first = await store.put(bytes);
      const second = await store.put(bytes);
      assert.equal(first.key, second.key);
      const keys = await driver.objectKeys();
      assert.equal(
        keys.filter((key) => key === first.key).length,
        1,
        "an upload retried with the same bytes must not produce a second object",
      );
    });

    test("a traversal key is refused rather than resolved", async () => {
      for (const key of [
        "sha256/../../etc/passwd",
        "../etc/passwd",
        "sha256/aa/../../../etc/passwd",
        "sha256/aa/",
        "",
      ]) {
        await assert.rejects(() => store.get(key), ArtefactStoreError);
        await assert.rejects(() => store.verify(key), ArtefactStoreError);
        await assert.rejects(() => store.delete(key), ArtefactStoreError);
      }
    });

    test("verification recomputes the digest from what is stored", async () => {
      const bytes = Buffer.from(`verify me on ${driver.name}`);
      const stored = await store.put(bytes);
      const verified = await store.verify(stored.key);
      assert.equal(verified.sha256, stored.sha256);
      assert.equal(verified.sizeBytes, bytes.byteLength);
    });

    test("verifying an object that is not stored fails", async () => {
      await assert.rejects(() => store.verify(keyForDigest("b".repeat(64))), ArtefactStoreError);
    });

    test("reading an object that is not stored fails", async () => {
      await assert.rejects(() => store.get(keyForDigest("c".repeat(64))), ArtefactStoreError);
    });

    test("deleting removes the object, and deleting again is not an error", async () => {
      const stored = await store.put(Buffer.from(`delete me on ${driver.name}`));
      await store.delete(stored.key);
      await assert.rejects(() => store.get(stored.key), ArtefactStoreError);
      await store.delete(stored.key);
    });

    test("a probe proves a round trip and leaves nothing behind", async () => {
      const before = await driver.objectKeys();
      await store.probe();
      assert.deepEqual(await driver.objectKeys(), before);
    });

    test("usage counts the objects that are stored", async () => {
      const bytes = Buffer.from(`usage on ${driver.name}`.padEnd(97, "."));
      await store.put(bytes);
      const usage = await store.usage();
      assert.equal(usage.complete, true);
      assert.ok(usage.objectCount >= 1, "at least the object just stored");
      assert.ok(usage.bytes >= bytes.byteLength, `usage ${String(usage.bytes)} bytes`);
    });
  });
}

/**
 * The `s3` driver's presigned download, which the `filesystem` driver does not
 * offer and is not required to (ADR-0012: the filesystem driver serves through
 * the server with equivalent short-lived access tokens instead).
 */
describe("the s3 driver's short-lived scoped access", () => {
  let endpoint: StubS3Endpoint;
  let store: S3ArtefactStore;

  before(async () => {
    endpoint = await startStubS3();
    store = new S3ArtefactStore({
      endpoint: endpoint.url,
      bucket: endpoint.bucket,
      region: endpoint.region,
      accessKeyId: endpoint.accessKeyId,
      secretAccessKey: endpoint.secretAccessKey,
    });
  });

  after(async () => {
    await endpoint.stop();
  });

  test("a presigned URL serves the object and pins its disposition", async () => {
    const bytes = Buffer.from("<!doctype html><p>dom snapshot</p>", "utf8");
    const stored = await store.put(bytes);
    const presigned = await store.presignDownload(stored.key, {
      ttlSeconds: 120,
      contentType: "text/html",
      contentDisposition: 'attachment; filename="art_1.html"',
    });

    const response = await fetch(presigned.url);
    assert.equal(response.status, 200, `${presigned.url}\n${endpoint.refusals.join("\n")}`);
    // The control plane decided how these bytes are served, not the bucket's
    // stored metadata: active markup stays an attachment under this driver too
    // (`docs/SECURITY.md` §13).
    assert.equal(response.headers.get("content-disposition"), 'attachment; filename="art_1.html"');
    assert.equal(response.headers.get("content-type"), "text/html");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.ok(presigned.expiresAt.getTime() > Date.now(), "a live grant has not expired");
  });

  test("an expired presigned URL is refused", async () => {
    const stored = await store.put(Buffer.from("expiring evidence"));
    const presigned = await store.presignDownload(stored.key, {
      ttlSeconds: 1,
      contentType: "application/octet-stream",
      contentDisposition: "attachment",
    });
    // The endpoint decides on the signed expiry, so the assertion is about the
    // signature and not about this process's clock: a URL signed one second ago
    // with a one-second life is already outside it.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const response = await fetch(presigned.url);
    assert.equal(response.status, 403);
    assert.match(endpoint.refusals.join("\n"), /expired/u);
  });

  test("a presigned URL whose signature is altered is refused", async () => {
    const stored = await store.put(Buffer.from("tamper evidence"));
    const presigned = await store.presignDownload(stored.key, {
      ttlSeconds: 120,
      contentType: "application/octet-stream",
      contentDisposition: "attachment",
    });
    const tampered = new URL(presigned.url);
    tampered.searchParams.set("response-content-disposition", "inline");
    const response = await fetch(tampered.toString());
    assert.equal(
      response.status,
      403,
      "the disposition is inside the signature, so changing it invalidates the URL",
    );
  });
});

/**
 * `docs/TESTING.md` §11: the store cannot take the bytes.
 *
 * The driver must report it rather than pretend, under both drivers, because
 * `docs/ARCHITECTURE.md` §14 forbids recording an artefact as available when
 * the store did not accept it.
 */
describe("a store that cannot accept a write", () => {
  test("the filesystem driver reports a write it could not make", async () => {
    const store = await filesystemDriver.start();
    try {
      await filesystemDriver.breakWrites();
      await assert.rejects(() => store.put(Buffer.from("disk full")), ArtefactStoreError);
      await assert.rejects(() => store.probe(), ArtefactStoreError);
    } finally {
      const { chmod } = await import("node:fs/promises");
      await chmod(filesystemRoot, 0o700).catch(() => undefined);
      await filesystemDriver.stop();
    }
  });

  test("the s3 driver reports an endpoint that refused the object", async () => {
    const endpoint = await startStubS3();
    try {
      const store = new S3ArtefactStore({
        endpoint: endpoint.url,
        bucket: endpoint.bucket,
        region: endpoint.region,
        accessKeyId: endpoint.accessKeyId,
        secretAccessKey: endpoint.secretAccessKey,
      });
      endpoint.failWrites(1);
      await assert.rejects(
        () => store.put(Buffer.from("bucket full")),
        (error: unknown) =>
          error instanceof ArtefactStoreError && /507|InsufficientStorage/u.test(error.message),
      );
    } finally {
      await endpoint.stop();
    }
  });

  test("the s3 driver reports an endpoint that is not there", async () => {
    const store = new S3ArtefactStore({
      // A port nothing listens on: the driver must produce its own error rather
      // than let a `fetch` rejection reach a caller as an unhandled failure.
      endpoint: "http://127.0.0.1:1",
      bucket: "reviewplane",
      region: "us-east-1",
      accessKeyId: "key",
      secretAccessKey: "secret",
      requestTimeoutMs: 2_000,
    });
    await assert.rejects(() => store.put(Buffer.from("nowhere")), ArtefactStoreError);
  });
});

/** A property only the filesystem driver can have, and must. */
describe("the filesystem driver's own guarantees", () => {
  let store: FilesystemArtefactStore;

  before(async () => {
    store = (await filesystemDriver.start()) as FilesystemArtefactStore;
  });

  after(async () => {
    await filesystemDriver.stop();
  });

  test("no temporary file survives a successful write", async () => {
    const stored = await store.put(Buffer.from("atomic write"));
    const shard = join(filesystemRoot, "sha256", stored.sha256.slice(0, 2));
    const entries = await readdir(shard);
    assert.equal(
      entries.some((entry) => entry.endsWith(".tmp")),
      false,
      "ADR-0012's atomic write is a temporary file plus a rename, and the temporary must be gone",
    );
  });

  test("stored objects are not world-readable", async () => {
    const stored = await store.put(Buffer.from("permissions"));
    const entry = await stat(join(filesystemRoot, stored.key));
    assert.equal(entry.mode & 0o007, 0);
  });
});
