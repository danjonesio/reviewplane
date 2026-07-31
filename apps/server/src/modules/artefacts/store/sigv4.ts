/**
 * AWS Signature Version 4, for the `s3` artefact driver (ADR-0012).
 *
 * Two hundred lines of well-specified arithmetic, against a vendor SDK that
 * would bring a dependency tree, a credential-provider chain that reaches for
 * instance metadata and environment variables the operator did not configure,
 * and a release cadence this project would have to track. `AGENTS.md` — "avoid
 * adding infrastructure systems unless a measured requirement justifies them" —
 * and the self-hosting guarantee both point the same way: the driver talks to
 * any S3-compatible endpoint over `fetch`, and nothing in it can decide to
 * authenticate as something the operator did not name.
 *
 * Two signing forms are implemented, because S3 needs both.
 *
 * **Header signing** (`signRequest`) puts the signature in `Authorization` and
 * is what the server uses for its own requests. The payload digest is always
 * computed and sent as `x-amz-content-sha256`: `UNSIGNED-PAYLOAD` is available
 * in the specification and is not used, because an artefact store whose writes
 * are not covered by the signature is one where a proxy can alter bytes in
 * flight without the signature noticing.
 *
 * **Query signing** (`presign`) puts it in the query string, which is what a
 * presigned URL is. ADR-0019 accepted this shape for the `s3` driver
 * explicitly: the URL is short-lived and scoped to one object, and it points at
 * the storage origin rather than at the control plane.
 */

import { createHash, createHmac } from "node:crypto";

export interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  /** Session token for temporary credentials, where the operator uses them. */
  readonly sessionToken?: string | undefined;
}

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

/**
 * Percent-encoding as S3 canonicalisation defines it, which is not
 * `encodeURIComponent`.
 *
 * `!`, `'`, `(`, `)` and `*` are unreserved to `encodeURIComponent` and
 * reserved here, and a path segment keeps `/` while a query value does not. A
 * signature computed with the wrong table is refused by the endpoint with a
 * message that names neither, so it is worth doing exactly.
 */
export function uriEncode(value: string, keepSlashes: boolean): string {
  let out = "";
  for (const character of value) {
    const isUnreserved =
      (character >= "A" && character <= "Z") ||
      (character >= "a" && character <= "z") ||
      (character >= "0" && character <= "9") ||
      character === "-" ||
      character === "." ||
      character === "_" ||
      character === "~";
    if (isUnreserved || (keepSlashes && character === "/")) {
      out += character;
      continue;
    }
    for (const byte of Buffer.from(character, "utf8")) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/** `20260731T101112Z` and `20260731`, the two forms every signature needs. */
export function timestamps(now: Date): { readonly amzDate: string; readonly dateStamp: string } {
  const amzDate = `${now.toISOString().replace(/[-:]/gu, "").slice(0, 15)}Z`;
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function signingKey(credentials: S3Credentials, dateStamp: string): Buffer {
  const dateKey = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, credentials.region);
  const serviceKey = hmac(regionKey, SERVICE);
  return hmac(serviceKey, "aws4_request");
}

function canonicalQuery(query: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  for (const [name, value] of query) pairs.push([uriEncode(name, false), uriEncode(value, false)]);
  pairs.sort((left, right) =>
    left[0] === right[0]
      ? left[1] < right[1]
        ? -1
        : left[1] > right[1]
          ? 1
          : 0
      : left[0] < right[0]
        ? -1
        : 1,
  );
  return pairs.map(([name, value]) => `${name}=${value}`).join("&");
}

function canonicalPath(pathname: string): string {
  return uriEncode(decodeURIComponent(pathname), true) || "/";
}

export interface SignedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

/**
 * Signs a request with the signature in the `Authorization` header.
 *
 * `body` may be empty; its digest is signed either way, so a request that
 * claims to carry nothing cannot be given something on the way.
 */
export function signRequest(input: {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
  readonly credentials: S3Credentials;
  readonly now?: Date;
}): SignedRequest {
  const { amzDate, dateStamp } = timestamps(input.now ?? new Date());
  const payloadHash = sha256Hex(input.body);

  const headers: Record<string, string> = {
    ...input.headers,
    host: input.url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (input.credentials.sessionToken !== undefined) {
    headers["x-amz-security-token"] = input.credentials.sessionToken;
  }

  const sortedNames = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const lowercased = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const canonicalHeaders = sortedNames
    .map((name) => `${name}:${(lowercased.get(name) ?? "").trim().replace(/\s+/gu, " ")}\n`)
    .join("");
  const signedHeaders = sortedNames.join(";");

  const canonicalRequest = [
    input.method,
    canonicalPath(input.url.pathname),
    canonicalQuery(input.url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.credentials.region}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(input.credentials, dateStamp))
    .update(stringToSign, "utf8")
    .digest("hex");

  headers["authorization"] =
    `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url: input.url.toString(), method: input.method, headers };
}

/**
 * Builds a presigned URL: the signature travels in the query string and the
 * request carries no credential header at all.
 *
 * `expiresInSeconds` is bounded by the caller, not here; ADR-0012 requires the
 * URL to be short-lived and the driver applies the deployment's bound.
 */
export function presign(input: {
  readonly method: string;
  readonly url: URL;
  readonly credentials: S3Credentials;
  readonly expiresInSeconds: number;
  readonly now?: Date;
}): { readonly url: string; readonly expiresAt: Date } {
  const issuedAt = input.now ?? new Date();
  const { amzDate, dateStamp } = timestamps(issuedAt);
  const scope = `${dateStamp}/${input.credentials.region}/${SERVICE}/aws4_request`;

  const url = new URL(input.url.toString());
  url.searchParams.set("X-Amz-Algorithm", ALGORITHM);
  url.searchParams.set("X-Amz-Credential", `${input.credentials.accessKeyId}/${scope}`);
  url.searchParams.set("X-Amz-Date", amzDate);
  url.searchParams.set("X-Amz-Expires", String(input.expiresInSeconds));
  url.searchParams.set("X-Amz-SignedHeaders", "host");
  if (input.credentials.sessionToken !== undefined) {
    url.searchParams.set("X-Amz-Security-Token", input.credentials.sessionToken);
  }

  const canonicalRequest = [
    input.method,
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    `host:${url.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(input.credentials, dateStamp))
    .update(stringToSign, "utf8")
    .digest("hex");
  url.searchParams.set("X-Amz-Signature", signature);

  return {
    url: url.toString(),
    expiresAt: new Date(issuedAt.getTime() + input.expiresInSeconds * 1000),
  };
}
