/**
 * The `s3` artefact driver: any S3-compatible endpoint (ADR-0012).
 *
 * It exists for customer-owned storage and for the multi-node stages, where a
 * shared volume is not available. ADR-0012 keeps the Compose default on
 * `filesystem`; this driver is implemented and conformance-tested against the
 * same suite so that the interface has two real implementations rather than one
 * and a promise.
 *
 * Three things are worth stating about the shape.
 *
 * **The bucket is private and no credential leaves this process.** Browser
 * workers upload through the control-plane artefact API, so nothing outside the
 * control plane ever holds a storage key (ADR-0012, `docs/SECURITY.md` §13).
 * The only value this driver ever hands out is a presigned URL that is scoped
 * to one object and expires.
 *
 * **Atomicity is a property of the protocol rather than of a rename.** A `PUT`
 * of an object is atomic in S3 and every compatible implementation: a
 * concurrent reader sees the previous object or the new one. There is nothing
 * to do here to obtain what the filesystem driver obtains with a rename.
 *
 * **Overwriting an existing key is not an error.** Keys are content-addressed,
 * so a second `put` of the same bytes writes the same bytes to the same place.
 * The conformance suite requires both drivers to behave that way, because the
 * upload flow retries.
 */

import {
  ArtefactStoreError,
  assertArtefactKey,
  digestOf,
  keyForDigest,
  type ArtefactStore,
  type ArtefactStoreUsage,
  type PresignedAccess,
  type StoredObject,
} from "./driver.ts";
import { presign, signRequest, type S3Credentials } from "./sigv4.ts";

export interface S3ArtefactStoreOptions {
  /** Base endpoint, for example `https://s3.example.internal`. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string | undefined;
  /**
   * Path-style addressing (`https://host/bucket/key`) rather than virtual-host
   * style (`https://bucket.host/key`). Path style is the default because most
   * self-hosted S3-compatible services need it and a wildcard certificate for
   * every bucket name is not something an operator should have to arrange.
   */
  readonly pathStyle?: boolean;
  /** Object-key prefix inside the bucket, for a shared bucket. */
  readonly prefix?: string | undefined;
  /** Bound on one request, so a hung endpoint fails rather than blocks. */
  readonly requestTimeoutMs?: number;
  /** Injected in tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const USAGE_OBJECT_LIMIT = 200_000;
const LIST_PAGE_SIZE = 1_000;

export class S3ArtefactStore implements ArtefactStore {
  readonly driver = "s3" as const;
  readonly #options: S3ArtefactStoreOptions;
  readonly #credentials: S3Credentials;
  readonly #fetch: typeof fetch;
  readonly #prefix: string;

  constructor(options: S3ArtefactStoreOptions) {
    this.#options = options;
    this.#credentials = {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      region: options.region,
      sessionToken: options.sessionToken,
    };
    this.#fetch = options.fetch ?? fetch;
    const prefix = (options.prefix ?? "").replace(/^\/+|\/+$/gu, "");
    this.#prefix = prefix === "" ? "" : `${prefix}/`;
  }

  /**
   * The URL for one object key.
   *
   * The key is validated before it is joined to anything, so a traversal
   * attempt is refused rather than normalised away by `URL`. The prefix is
   * operator configuration and is not a caller's value.
   */
  #url(key: string, query?: Readonly<Record<string, string>>): URL {
    assertArtefactKey(key);
    return this.#urlForPath(`${this.#prefix}${key}`, query);
  }

  #urlForPath(objectPath: string, query?: Readonly<Record<string, string>>): URL {
    const base = new URL(this.#options.endpoint);
    const pathStyle = this.#options.pathStyle ?? true;
    if (pathStyle) {
      base.pathname = `${trimSlashes(base.pathname)}/${this.#options.bucket}/${objectPath}`.replace(
        /\/{2,}/gu,
        "/",
      );
    } else {
      base.host = `${this.#options.bucket}.${base.host}`;
      base.pathname = `/${objectPath}`;
    }
    for (const [name, value] of Object.entries(query ?? {})) base.searchParams.set(name, value);
    return base;
  }

  async #send(
    method: string,
    url: URL,
    body: Buffer,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<Response> {
    const signed = signRequest({
      method,
      url,
      headers,
      body,
      credentials: this.#credentials,
    });
    const controller = new AbortController();
    const timeout = setTimeout(
      () => {
        controller.abort();
      },
      this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    try {
      return await this.#fetch(signed.url, {
        method,
        headers: signed.headers,
        ...(method === "GET" || method === "HEAD" || method === "DELETE"
          ? {}
          : { body: new Uint8Array(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new ArtefactStoreError(
        `the s3 artefact store did not answer a ${method}: ${describe(error)}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async put(bytes: Buffer): Promise<StoredObject> {
    const sha256 = digestOf(bytes);
    const key = keyForDigest(sha256);
    const response = await this.#send("PUT", this.#url(key), bytes, {
      "content-length": String(bytes.byteLength),
      "content-type": "application/octet-stream",
    });
    if (!response.ok) {
      throw new ArtefactStoreError(
        `artefact could not be stored: the s3 endpoint answered ${String(response.status)} ${await shortBody(response)}`,
      );
    }
    return { key, sizeBytes: bytes.byteLength, sha256 };
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.#send("GET", this.#url(key), Buffer.alloc(0));
    if (!response.ok) {
      throw new ArtefactStoreError(
        `artefact ${key} could not be read: the s3 endpoint answered ${String(response.status)}`,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Recomputes the digest from the stored bytes.
   *
   * It reads the object rather than trusting the endpoint's `ETag`. An `ETag`
   * is an MD5 for a single-part upload and something else for a multipart one,
   * so it is neither the digest this product verifies against nor reliably
   * comparable between implementations.
   */
  async verify(key: string): Promise<StoredObject> {
    const bytes = await this.get(key);
    return { key, sizeBytes: bytes.byteLength, sha256: digestOf(bytes) };
  }

  async delete(key: string): Promise<void> {
    const response = await this.#send("DELETE", this.#url(key), Buffer.alloc(0));
    // 404 is the outcome a delete wanted.
    if (!response.ok && response.status !== 404) {
      throw new ArtefactStoreError(
        `artefact ${key} could not be deleted: the s3 endpoint answered ${String(response.status)}`,
      );
    }
  }

  /**
   * The bucket answers a listing under this prefix, and nothing is written.
   *
   * An empty result is a pass: a fresh installation has stored nothing, and a
   * reader that treated "no objects" as "no store" would refuse the first
   * verification of every new deployment. What this catches is the endpoint
   * being unreachable and the credential no longer being able to read.
   */
  async probeReadable(): Promise<void> {
    const url = this.#urlForPath("");
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", this.#prefix);
    url.searchParams.set("max-keys", "1");
    const response = await this.#send("GET", url, Buffer.alloc(0));
    if (!response.ok) {
      throw new ArtefactStoreError(
        `the s3 artefact store is not readable: the endpoint answered ${String(response.status)} ${await shortBody(response)}`,
      );
    }
    await response.arrayBuffer();
  }

  async probe(): Promise<void> {
    const path = `${this.#prefix}probe/probe-${digestOf(Buffer.from(String(Date.now()))).slice(0, 16)}`;
    const url = this.#urlForPath(path);
    const body = Buffer.from("reviewplane", "utf8");
    const written = await this.#send("PUT", url, body, {
      "content-length": String(body.byteLength),
      "content-type": "text/plain",
    });
    if (!written.ok) {
      throw new ArtefactStoreError(
        `the s3 artefact store is not writable: the endpoint answered ${String(written.status)} ${await shortBody(written)}`,
      );
    }
    try {
      const read = await this.#send("GET", url, Buffer.alloc(0));
      if (!read.ok) {
        throw new ArtefactStoreError(
          `the s3 artefact store is not readable: the endpoint answered ${String(read.status)}`,
        );
      }
      if (Buffer.from(await read.arrayBuffer()).toString("utf8") !== "reviewplane") {
        throw new ArtefactStoreError("the s3 artefact store read back different bytes than it wrote");
      }
    } finally {
      await this.#send("DELETE", url, Buffer.alloc(0)).catch(() => undefined);
    }
  }

  async usage(): Promise<ArtefactStoreUsage> {
    let objectCount = 0;
    let bytes = 0;
    let complete = true;
    let continuationToken: string | undefined;
    for (;;) {
      const query: Record<string, string> = {
        "list-type": "2",
        prefix: `${this.#prefix}sha256/`,
        "max-keys": String(LIST_PAGE_SIZE),
      };
      if (continuationToken !== undefined) query["continuation-token"] = continuationToken;
      const url = this.#urlForPath("", query);
      // Listing addresses the bucket, not an object, so the trailing separator
      // the object path builder leaves behind is removed.
      url.pathname = url.pathname.replace(/\/$/u, "");
      const response = await this.#send("GET", url, Buffer.alloc(0));
      if (!response.ok) {
        throw new ArtefactStoreError(
          `the s3 artefact store could not be listed: the endpoint answered ${String(response.status)}`,
        );
      }
      const body = await response.text();
      for (const size of body.matchAll(/<Size>(\d+)<\/Size>/gu)) {
        if (objectCount >= USAGE_OBJECT_LIMIT) {
          complete = false;
          break;
        }
        objectCount += 1;
        bytes += Number(size[1]);
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/u.test(body);
      const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/u.exec(body);
      if (!complete || !truncated || next === null) {
        if (truncated && complete) complete = false;
        break;
      }
      continuationToken = decodeXmlText(next[1] ?? "");
    }
    return { objectCount, bytes, complete };
  }

  /**
   * A presigned `GET` for one object (ADR-0012, ADR-0019).
   *
   * The disposition and the content type are pinned in the query so that the
   * object is served the way the control plane decided and not the way the
   * bucket's stored metadata happens to say. That is what keeps the active-
   * content rule of `docs/SECURITY.md` §13 true under this driver: a DOM
   * snapshot reached through a presigned URL is still an attachment.
   */
  async presignDownload(
    key: string,
    options: {
      readonly ttlSeconds: number;
      readonly contentType: string;
      readonly contentDisposition: string;
    },
  ): Promise<PresignedAccess> {
    const url = this.#url(key, {
      "response-content-type": options.contentType,
      "response-content-disposition": options.contentDisposition,
    });
    const signed = presign({
      method: "GET",
      url,
      credentials: this.#credentials,
      expiresInSeconds: options.ttlSeconds,
    });
    return await Promise.resolve({ url: signed.url, expiresAt: signed.expiresAt });
  }
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/gu, "");
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'");
}

/** A bounded fragment of an error body, for a diagnosable message. */
async function shortBody(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.slice(0, 200);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
