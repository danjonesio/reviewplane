/**
 * An in-process S3-compatible endpoint, for the `s3` driver's conformance run.
 *
 * ADR-0012 requires the driver interface to be conformance-tested against both
 * drivers. That needs an endpoint, and the two ways to get one are a container
 * and this.
 *
 * **What this is.** A real HTTP server that speaks the subset of the S3 API the
 * driver uses — `PUT`, `GET`, `HEAD`, `DELETE` and `ListObjectsV2` — and that
 * **recomputes the AWS Signature Version 4 over every request it receives** and
 * refuses any request whose signature does not match. That last part is what
 * makes this a protocol test rather than a stub: an error in canonicalisation,
 * in the percent-encoding table, in the signed-header list or in the payload
 * digest produces a `403` here exactly as it would from a real service. A
 * presigned URL is verified the same way, including its expiry.
 *
 * **What this is not.** It is not a claim that the driver works against any
 * particular vendor. Multipart upload, versioning, lifecycle rules, server-side
 * encryption and the vendor-specific corners of `ListObjectsV2` are not
 * implemented, and testing the driver against an external service is Stage 2
 * work (`docs/DEPLOYMENT.md` §12). Set `REVIEWPLANE_TEST_S3_ENDPOINT`,
 * `_BUCKET`, `_ACCESS_KEY` and `_SECRET_KEY` and the conformance suite runs
 * against a real endpoint instead of this one, unchanged.
 */

import { createHmac, createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface StubS3Endpoint {
  readonly url: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  /** Objects currently held, keyed by object path inside the bucket. */
  readonly objects: Map<string, Buffer>;
  /** Every request the endpoint refused, with why. For assertions. */
  readonly refusals: string[];
  /** Makes the next `count` write attempts fail with 507, for fault injection. */
  failWrites(count: number): void;
  stop(): Promise<void>;
}

const ACCESS_KEY_ID = "reviewplane-test-access-key";
const SECRET_ACCESS_KEY = "reviewplane-test-secret-key-0123456789";
const REGION = "us-east-1";
const BUCKET = "reviewplane-test";

export async function startStubS3(): Promise<StubS3Endpoint> {
  const objects = new Map<string, Buffer>();
  const refusals: string[] = [];
  let writeFailures = 0;

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      response.writeHead(500).end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    const problem = verifySignature(request, url, body);
    if (problem !== null) {
      refusals.push(`${request.method ?? "?"} ${url.pathname}: ${problem}`);
      response.writeHead(403, { "content-type": "application/xml" });
      response.end(`<Error><Code>SignatureDoesNotMatch</Code><Message>${problem}</Message></Error>`);
      return;
    }

    const prefix = `/${BUCKET}`;
    if (!url.pathname.startsWith(prefix)) {
      response.writeHead(404).end();
      return;
    }
    const objectPath = decodeURIComponent(url.pathname.slice(prefix.length).replace(/^\//u, ""));

    if (url.searchParams.get("list-type") === "2") {
      response.writeHead(200, { "content-type": "application/xml" });
      response.end(listObjects(objects, url.searchParams.get("prefix") ?? ""));
      return;
    }

    switch (request.method) {
      case "PUT": {
        if (writeFailures > 0) {
          writeFailures -= 1;
          response.writeHead(507, { "content-type": "application/xml" });
          response.end("<Error><Code>InsufficientStorage</Code></Error>");
          return;
        }
        objects.set(objectPath, body);
        response.writeHead(200, { etag: `"${createHash("md5").update(body).digest("hex")}"` });
        response.end();
        return;
      }
      case "HEAD":
      case "GET": {
        const stored = objects.get(objectPath);
        if (stored === undefined) {
          response.writeHead(404, { "content-type": "application/xml" });
          response.end("<Error><Code>NoSuchKey</Code></Error>");
          return;
        }
        const headers: Record<string, string> = {
          "content-length": String(stored.byteLength),
          "content-type": url.searchParams.get("response-content-type") ?? "application/octet-stream",
        };
        const disposition = url.searchParams.get("response-content-disposition");
        if (disposition !== null) headers["content-disposition"] = disposition;
        response.writeHead(200, headers);
        response.end(request.method === "HEAD" ? undefined : stored);
        return;
      }
      case "DELETE": {
        objects.delete(objectPath);
        response.writeHead(204).end();
        return;
      }
      default:
        response.writeHead(405).end();
    }
  }

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    bucket: BUCKET,
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
    region: REGION,
    objects,
    refusals,
    failWrites(count: number): void {
      writeFailures = count;
    },
    async stop(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Recomputes the signature the client sent, and reports why it disagrees. */
function verifySignature(request: IncomingMessage, url: URL, body: Buffer): string | null {
  const presignedSignature = url.searchParams.get("X-Amz-Signature");
  return presignedSignature === null
    ? verifyHeaderSignature(request, url, body)
    : verifyPresigned(request, url, presignedSignature);
}

function verifyHeaderSignature(request: IncomingMessage, url: URL, body: Buffer): string | null {
  const authorization = request.headers.authorization;
  if (authorization === undefined) return "no Authorization header";
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/u.exec(
      authorization,
    );
  if (match === null) return "the Authorization header is not a version 4 signature";
  const [, accessKeyId, dateStamp, region, signedHeaders, signature] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (accessKeyId !== ACCESS_KEY_ID) return "unknown access key";

  const payloadHash = request.headers["x-amz-content-sha256"];
  if (typeof payloadHash !== "string") return "no x-amz-content-sha256 header";
  const actualPayloadHash = createHash("sha256").update(body).digest("hex");
  if (payloadHash !== actualPayloadHash) return "the payload digest does not cover the body";

  const amzDate = request.headers["x-amz-date"];
  if (typeof amzDate !== "string") return "no x-amz-date header";

  const canonicalHeaders = signedHeaders
    .split(";")
    .map((name) => {
      const value = request.headers[name];
      const text = Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
      return `${name}:${text.trim().replace(/\s+/gu, " ")}\n`;
    })
    .join("");

  const canonicalRequest = [
    request.method ?? "",
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams, new Set()),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const expected = sign(canonicalRequest, amzDate, dateStamp, region);
  return expected === signature ? null : "the signature does not match the canonical request";
}

function verifyPresigned(request: IncomingMessage, url: URL, signature: string): string | null {
  const credential = url.searchParams.get("X-Amz-Credential") ?? "";
  const [accessKeyId, dateStamp, region] = credential.split("/");
  if (accessKeyId !== ACCESS_KEY_ID) return "unknown access key";
  const amzDate = url.searchParams.get("X-Amz-Date") ?? "";
  const expiresIn = Number(url.searchParams.get("X-Amz-Expires") ?? "0");
  const signedAt = Date.parse(
    `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`,
  );
  if (!Number.isFinite(signedAt)) return "X-Amz-Date is not a timestamp";
  if (Date.now() > signedAt + expiresIn * 1000) return "the presigned URL has expired";

  const canonicalRequest = [
    request.method ?? "",
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams, new Set(["X-Amz-Signature"])),
    `host:${request.headers.host ?? ""}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const expected = sign(canonicalRequest, amzDate, dateStamp ?? "", region ?? REGION);
  return expected === signature ? null : "the presigned signature does not match";
}

function sign(
  canonicalRequest: string,
  amzDate: string,
  dateStamp: string,
  region: string,
): string {
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");
  const dateKey = createHmac("sha256", `AWS4${SECRET_ACCESS_KEY}`).update(dateStamp).digest();
  const regionKey = createHmac("sha256", dateKey).update(region).digest();
  const serviceKey = createHmac("sha256", regionKey).update("s3").digest();
  const signingKey = createHmac("sha256", serviceKey).update("aws4_request").digest();
  return createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
}

function uriEncode(value: string, keepSlashes: boolean): string {
  let out = "";
  for (const character of value) {
    const unreserved =
      /[A-Za-z0-9\-._~]/u.test(character) || (keepSlashes && character === "/");
    if (unreserved) {
      out += character;
      continue;
    }
    for (const byte of Buffer.from(character, "utf8")) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

function canonicalPath(pathname: string): string {
  return uriEncode(decodeURIComponent(pathname), true) || "/";
}

function canonicalQuery(query: URLSearchParams, exclude: ReadonlySet<string>): string {
  const pairs: Array<[string, string]> = [];
  for (const [name, value] of query) {
    if (exclude.has(name)) continue;
    pairs.push([uriEncode(name, false), uriEncode(value, false)]);
  }
  // Byte order, not locale order. `localeCompare` sorts case-insensitively,
  // which puts `response-content-type` before `X-Amz-Algorithm` and produces a
  // canonical request no client would ever build.
  const before = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
  pairs.sort((left, right) =>
    left[0] === right[0] ? before(left[1], right[1]) : before(left[0], right[0]),
  );
  return pairs.map(([name, value]) => `${name}=${value}`).join("&");
}

function listObjects(objects: ReadonlyMap<string, Buffer>, prefix: string): string {
  const entries = [...objects.entries()].filter(([key]) => key.startsWith(prefix));
  const contents = entries
    .map(
      ([key, value]) =>
        `<Contents><Key>${key}</Key><Size>${String(value.byteLength)}</Size></Contents>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated><KeyCount>${String(entries.length)}</KeyCount>${contents}</ListBucketResult>`;
}
