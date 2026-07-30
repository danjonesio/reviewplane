/**
 * The Stage 0 connector certificate authority (ADR-0014).
 *
 * `docs/ARCHITECTURE.md` §11 requires the connector to receive an "issued
 * client certificate or equivalent signed identity" and to connect over mTLS.
 * This module is where that identity is minted: a control-plane CA, generated
 * once at bootstrap, signs one short-lived X.509 client certificate per
 * connector, binding the connector's locally generated public key to its
 * connector ID.
 *
 * The CA private key never leaves the server. It is not returned by any API,
 * never logged, and never sent to a connector or to the tunnel gateway; the
 * gateway verifies connector certificates against the CA *certificate* alone.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as signBuffer,
  createHash,
  X509Certificate,
  type KeyObject,
} from "node:crypto";

import {
  algorithmIdentifier,
  bitString,
  boolean,
  contextConstructed,
  contextExplicit,
  contextPrimitive,
  directoryString,
  octetString,
  objectIdentifier,
  positiveInteger,
  relativeDistinguishedName,
  sequence,
  smallInteger,
  time,
} from "./der.ts";

/** Object identifiers used by the certificates this module issues. */
const OID = {
  commonName: "2.5.4.3",
  organizationName: "2.5.4.10",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  ecPublicKey: "1.2.840.10045.2.1",
  prime256v1: "1.2.840.10045.3.1.7",
  secp384r1: "1.3.132.0.34",
  subjectKeyIdentifier: "2.5.29.14",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  extKeyUsage: "2.5.29.37",
  authorityKeyIdentifier: "2.5.29.35",
  serverAuth: "1.3.6.1.5.5.7.3.1",
  clientAuth: "1.3.6.1.5.5.7.3.2",
} as const;

/** Curves accepted for a connector device key. */
const ACCEPTED_CURVE_OIDS = new Set<string>([OID.prime256v1, OID.secp384r1]);

/** KeyUsage bit positions from RFC 5280 §4.2.1.3. */
const KEY_USAGE = {
  digitalSignature: 0,
  keyCertSign: 5,
  cRLSign: 6,
} as const;

export interface KeyPair {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
}

export interface IssuedCertificate {
  readonly der: Buffer;
  readonly pem: string;
  /** `sha256:<hex>`, matching the schema's digest definition. */
  readonly fingerprint: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly serial: string;
}

/** The sha256 certificate fingerprint recorded on a connector record. */
export function certificateFingerprint(der: Buffer): string {
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

export function toPem(der: Buffer, label: string): string {
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${body}${body.endsWith("\n") ? "" : "\n"}-----END ${label}-----\n`;
}

function keyUsageExtension(bits: readonly number[]): Buffer {
  const highest = Math.max(...bits);
  const byteCount = Math.floor(highest / 8) + 1;
  const octets = Buffer.alloc(byteCount);
  for (const bit of bits) {
    const index = Math.floor(bit / 8);
    octets[index] = (octets[index] ?? 0) | (0x80 >> bit % 8);
  }
  let unusedBits = 0;
  const last = octets[byteCount - 1] ?? 0;
  while (unusedBits < 8 && ((last >> unusedBits) & 1) === 0) unusedBits += 1;
  return extension(OID.keyUsage, true, bitString(octets, unusedBits));
}

function extension(oid: string, critical: boolean, value: Buffer): Buffer {
  const parts = critical
    ? [objectIdentifier(oid), boolean(true), octetString(value)]
    : [objectIdentifier(oid), octetString(value)];
  return sequence(...parts);
}

/**
 * The RFC 5280 §4.2.1.2 key identifier: SHA-1 of the subject public key bit
 * string. SHA-1 is used as a name here, never as a signature digest.
 */
function keyIdentifier(spkiDer: Buffer): Buffer {
  const certificate = readSubjectPublicKeyBits(spkiDer);
  return createHash("sha1").update(certificate).digest();
}

/** Extracts the BIT STRING contents of a SubjectPublicKeyInfo. */
function readSubjectPublicKeyBits(spkiDer: Buffer): Buffer {
  const parsed = parseSubjectPublicKeyInfo(spkiDer);
  return parsed.publicKeyBits;
}

interface ParsedSpki {
  readonly algorithmOid: string;
  readonly curveOid: string | null;
  readonly publicKeyBits: Buffer;
}

/**
 * A deliberately small SubjectPublicKeyInfo reader. It exists so that a
 * connector's public key is validated before it is signed: the control plane
 * must know it is signing an EC key on an accepted curve, not an arbitrary
 * blob.
 */
function parseSubjectPublicKeyInfo(der: Buffer): ParsedSpki {
  let offset = 0;
  const readHeader = (expectedTag: number): { start: number; length: number } => {
    const tag = der[offset];
    if (tag !== expectedTag) {
      throw new Error(`x509: expected tag 0x${expectedTag.toString(16)} at offset ${offset}`);
    }
    offset += 1;
    const first = der[offset];
    if (first === undefined) throw new Error("x509: truncated SubjectPublicKeyInfo");
    offset += 1;
    let length: number;
    if (first < 0x80) {
      length = first;
    } else {
      const count = first & 0x7f;
      if (count === 0 || count > 4) throw new Error("x509: unsupported length encoding");
      length = 0;
      for (let index = 0; index < count; index += 1) {
        const octet = der[offset + index];
        if (octet === undefined) throw new Error("x509: truncated length");
        length = length * 256 + octet;
      }
      offset += count;
    }
    const start = offset;
    offset += length;
    if (offset > der.length) throw new Error("x509: SubjectPublicKeyInfo is truncated");
    return { start, length };
  };

  const outer = readHeader(0x30);
  if (outer.start + outer.length !== der.length) {
    throw new Error("x509: SubjectPublicKeyInfo carries trailing data");
  }
  offset = outer.start;
  const algorithm = readHeader(0x30);
  const algorithmEnd = algorithm.start + algorithm.length;
  offset = algorithm.start;
  const algorithmOidHeader = readHeader(0x06);
  const algorithmOid = decodeObjectIdentifier(
    der.subarray(algorithmOidHeader.start, algorithmOidHeader.start + algorithmOidHeader.length),
  );
  let curveOid: string | null = null;
  if (offset < algorithmEnd && der[offset] === 0x06) {
    const curveHeader = readHeader(0x06);
    curveOid = decodeObjectIdentifier(der.subarray(curveHeader.start, curveHeader.start + curveHeader.length));
  }
  offset = algorithmEnd;
  const keyHeader = readHeader(0x03);
  const bits = der.subarray(keyHeader.start, keyHeader.start + keyHeader.length);
  if (bits.length === 0 || bits[0] !== 0x00) {
    throw new Error("x509: the public key bit string has unused bits");
  }
  return { algorithmOid, curveOid, publicKeyBits: Buffer.from(bits.subarray(1)) };
}

function decodeObjectIdentifier(content: Buffer): string {
  const first = content[0];
  if (first === undefined) throw new Error("x509: empty object identifier");
  const parts = [Math.floor(first / 40), first % 40];
  let value = 0;
  for (let index = 1; index < content.length; index += 1) {
    const octet = content[index] ?? 0;
    value = value * 128 + (octet & 0x7f);
    if ((octet & 0x80) === 0) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join(".");
}

/**
 * Validates a connector's SubjectPublicKeyInfo before it is signed. A key the
 * control plane cannot classify is refused rather than certified.
 */
export function assertAcceptableDeviceKey(spkiDer: Buffer): void {
  const parsed = parseSubjectPublicKeyInfo(spkiDer);
  if (parsed.algorithmOid !== OID.ecPublicKey) {
    throw new Error("the device public key is not an elliptic-curve key");
  }
  if (parsed.curveOid === null || !ACCEPTED_CURVE_OIDS.has(parsed.curveOid)) {
    throw new Error("the device public key uses an unsupported curve");
  }
  // A final check through Node's own parser, so that a key this module accepts
  // is certainly one the TLS stack can use.
  createPublicKey({ key: spkiDer, format: "der", type: "spki" });
}

interface CertificateRequest {
  readonly subjectCommonName: string;
  readonly subjectOrganization?: string;
  readonly issuerCommonName: string;
  readonly issuerOrganization?: string;
  readonly subjectPublicKeyInfo: Buffer;
  readonly issuerPrivateKey: KeyObject;
  readonly issuerSubjectPublicKeyInfo: Buffer;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly isCertificateAuthority: boolean;
  readonly keyUsage: readonly number[];
  readonly extendedKeyUsage: readonly string[];
  readonly dnsNames?: readonly string[];
  readonly ipAddresses?: readonly string[];
}

function name(commonName: string, organization?: string): Buffer {
  const parts = [relativeDistinguishedName(OID.commonName, directoryString(commonName))];
  if (organization !== undefined) {
    parts.push(relativeDistinguishedName(OID.organizationName, directoryString(organization)));
  }
  return sequence(...parts);
}

function subjectAltNameExtension(dnsNames: readonly string[], ipAddresses: readonly string[]): Buffer {
  const entries: Buffer[] = [];
  for (const dnsName of dnsNames) entries.push(contextPrimitive(2, Buffer.from(dnsName, "ascii")));
  for (const address of ipAddresses) entries.push(contextPrimitive(7, encodeIpAddress(address)));
  return extension(OID.subjectAltName, false, sequence(...entries));
}

function encodeIpAddress(address: string): Buffer {
  if (address.includes(":")) {
    const groups = expandIpv6(address);
    const octets = Buffer.alloc(16);
    groups.forEach((group, index) => octets.writeUInt16BE(group, index * 2));
    return octets;
  }
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error(`x509: ${address} is not an IP address`);
  }
  return Buffer.from(parts);
}

function expandIpv6(address: string): number[] {
  const [head, tail] = address.split("::");
  const parse = (section: string | undefined): number[] =>
    section === undefined || section === ""
      ? []
      : section.split(":").map((group) => {
          const value = Number.parseInt(group, 16);
          if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
            throw new Error(`x509: ${address} is not an IP address`);
          }
          return value;
        });
  const left = parse(head);
  const right = parse(tail);
  if (tail === undefined) {
    if (left.length !== 8) throw new Error(`x509: ${address} is not an IP address`);
    return left;
  }
  const middle = new Array<number>(8 - left.length - right.length).fill(0);
  if (middle.length < 0) throw new Error(`x509: ${address} is not an IP address`);
  return [...left, ...middle, ...right];
}

function createCertificate(request: CertificateRequest): IssuedCertificate {
  const serialBytes = randomBytes(16);
  const signatureAlgorithm = algorithmIdentifier(OID.ecdsaWithSha256);

  const extensions: Buffer[] = [
    extension(
      OID.basicConstraints,
      true,
      request.isCertificateAuthority ? sequence(boolean(true)) : sequence(),
    ),
    keyUsageExtension(request.keyUsage),
    extension(OID.subjectKeyIdentifier, false, octetString(keyIdentifier(request.subjectPublicKeyInfo))),
    extension(
      OID.authorityKeyIdentifier,
      false,
      sequence(contextPrimitive(0, keyIdentifier(request.issuerSubjectPublicKeyInfo))),
    ),
  ];
  if (request.extendedKeyUsage.length > 0) {
    extensions.push(
      extension(
        OID.extKeyUsage,
        false,
        sequence(...request.extendedKeyUsage.map((oid) => objectIdentifier(oid))),
      ),
    );
  }
  const dnsNames = request.dnsNames ?? [];
  const ipAddresses = request.ipAddresses ?? [];
  if (dnsNames.length > 0 || ipAddresses.length > 0) {
    extensions.push(subjectAltNameExtension(dnsNames, ipAddresses));
  }

  const tbsCertificate = sequence(
    contextExplicit(0, smallInteger(2)), // v3
    positiveInteger(serialBytes),
    signatureAlgorithm,
    name(request.issuerCommonName, request.issuerOrganization),
    sequence(time(request.notBefore), time(request.notAfter)),
    name(request.subjectCommonName, request.subjectOrganization),
    request.subjectPublicKeyInfo,
    contextConstructed(3, sequence(...extensions)),
  );

  const signature = signBuffer("sha256", tbsCertificate, request.issuerPrivateKey);
  const der = sequence(tbsCertificate, signatureAlgorithm, bitString(Buffer.from(signature)));

  return {
    der,
    pem: toPem(der, "CERTIFICATE"),
    fingerprint: certificateFingerprint(der),
    notBefore: request.notBefore,
    notAfter: request.notAfter,
    serial: serialBytes.toString("hex"),
  };
}

/** Generates the control-plane connector CA. Called once, at bootstrap. */
export function generateCertificateAuthority(options: {
  readonly commonName: string;
  readonly organization: string;
  readonly notAfter: Date;
  readonly now?: Date;
}): KeyPair & { readonly fingerprint: string; readonly notAfter: Date } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = Buffer.from(publicKey.export({ type: "spki", format: "der" }));
  const now = options.now ?? new Date();
  const certificate = createCertificate({
    subjectCommonName: options.commonName,
    subjectOrganization: options.organization,
    issuerCommonName: options.commonName,
    issuerOrganization: options.organization,
    subjectPublicKeyInfo: spki,
    issuerPrivateKey: privateKey,
    issuerSubjectPublicKeyInfo: spki,
    notBefore: new Date(now.getTime() - 60_000),
    notAfter: options.notAfter,
    isCertificateAuthority: true,
    keyUsage: [KEY_USAGE.keyCertSign, KEY_USAGE.cRLSign],
    extendedKeyUsage: [],
  });
  return {
    certificatePem: certificate.pem,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    fingerprint: certificate.fingerprint,
    notAfter: certificate.notAfter,
  };
}

export interface Authority {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
}

function authorityMaterial(authority: Authority): {
  privateKey: KeyObject;
  spki: Buffer;
  commonName: string;
  organization: string | undefined;
} {
  const parsed = new X509Certificate(authority.certificatePem);
  const privateKey = createPrivateKey(authority.privateKeyPem);
  const spki = Buffer.from(parsed.publicKey.export({ type: "spki", format: "der" }));
  const subject = Object.fromEntries(
    parsed.subject.split("\n").map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
  );
  return {
    privateKey,
    spki,
    commonName: subject["CN"] ?? "ReviewPlane connector CA",
    organization: subject["O"],
  };
}

/**
 * Issues the signed device identity returned in the registration response.
 *
 * The subject common name is the connector ID, which is how the tunnel gateway
 * and the control channel identify the peer after the TLS handshake, alongside
 * the certificate fingerprint recorded on the connector record.
 */
export function issueConnectorCertificate(options: {
  readonly authority: Authority;
  readonly connectorId: string;
  readonly organization: string;
  readonly subjectPublicKeyInfo: Buffer;
  readonly notAfter: Date;
  readonly now?: Date;
}): IssuedCertificate {
  assertAcceptableDeviceKey(options.subjectPublicKeyInfo);
  const issuer = authorityMaterial(options.authority);
  const now = options.now ?? new Date();
  return createCertificate({
    subjectCommonName: options.connectorId,
    subjectOrganization: options.organization,
    issuerCommonName: issuer.commonName,
    ...(issuer.organization === undefined ? {} : { issuerOrganization: issuer.organization }),
    subjectPublicKeyInfo: options.subjectPublicKeyInfo,
    issuerPrivateKey: issuer.privateKey,
    issuerSubjectPublicKeyInfo: issuer.spki,
    notBefore: new Date(now.getTime() - 60_000),
    notAfter: options.notAfter,
    isCertificateAuthority: false,
    keyUsage: [KEY_USAGE.digitalSignature],
    extendedKeyUsage: [OID.clientAuth],
  });
}

/**
 * Issues the connector listener's own server certificate from the same CA, so
 * that a self-hosted deployment has one trust anchor to distribute rather than
 * two. An operator who terminates TLS elsewhere supplies their own certificate
 * instead.
 */
export function issueListenerCertificate(options: {
  readonly authority: Authority;
  readonly hosts: readonly string[];
  readonly organization: string;
  readonly notAfter: Date;
  readonly now?: Date;
}): KeyPair & { readonly notAfter: Date } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = Buffer.from(publicKey.export({ type: "spki", format: "der" }));
  const issuer = authorityMaterial(options.authority);
  const now = options.now ?? new Date();
  const dnsNames = options.hosts.filter((host) => !isIpAddress(host));
  const ipAddresses = options.hosts.filter((host) => isIpAddress(host));
  const primary = options.hosts[0];
  if (primary === undefined) throw new Error("x509: the listener certificate needs at least one host");

  const certificate = createCertificate({
    subjectCommonName: primary,
    subjectOrganization: options.organization,
    issuerCommonName: issuer.commonName,
    ...(issuer.organization === undefined ? {} : { issuerOrganization: issuer.organization }),
    subjectPublicKeyInfo: spki,
    issuerPrivateKey: issuer.privateKey,
    issuerSubjectPublicKeyInfo: issuer.spki,
    notBefore: new Date(now.getTime() - 60_000),
    notAfter: options.notAfter,
    isCertificateAuthority: false,
    keyUsage: [KEY_USAGE.digitalSignature],
    extendedKeyUsage: [OID.serverAuth],
    dnsNames,
    ipAddresses,
  });
  return {
    certificatePem: certificate.pem,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    notAfter: certificate.notAfter,
  };
}

function isIpAddress(host: string): boolean {
  return /^[0-9.]+$/.test(host) || host.includes(":");
}
