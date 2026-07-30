/**
 * Minimal DER encoder for the X.509 structures the Stage 0 connector CA issues.
 *
 * Node's `crypto` can parse and verify certificates but cannot create them, and
 * `docs/ARCHITECTURE.md` §12 requires an ADR for a library that shapes a public
 * interface — which a certificate-issuance library would, because every
 * connector and the tunnel gateway depend on the certificates it produces.
 * ADR-0014 records the decision to encode the small, fixed set of structures
 * here instead. The correctness proof is not this file: it is the real TLS
 * handshakes in the test suite, which fail if a single byte is wrong.
 *
 * Only the constructs RFC 5280 needs for a client certificate are implemented,
 * and every one of them is length-definite DER.
 */

/** ASN.1 universal tags used by these structures. */
const TAG = {
  boolean: 0x01,
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  null: 0x05,
  objectIdentifier: 0x06,
  utf8String: 0x0c,
  printableString: 0x13,
  ia5String: 0x16,
  utcTime: 0x17,
  generalizedTime: 0x18,
  sequence: 0x30,
  set: 0x31,
} as const;

/** DER length octets: short form below 128, long form above. */
function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const octets: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    octets.unshift(remaining & 0xff);
    remaining >>>= 8;
  }
  if (octets.length > 4) throw new Error("der: length is out of range");
  return Buffer.from([0x80 | octets.length, ...octets]);
}

/** One tag-length-value triple. */
export function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

export function sequence(...parts: Buffer[]): Buffer {
  return tlv(TAG.sequence, Buffer.concat(parts));
}

export function set(...parts: Buffer[]): Buffer {
  return tlv(TAG.set, Buffer.concat(parts));
}

/**
 * A positive INTEGER in minimal two's-complement form. A leading zero is added
 * when the high bit is set, so that the value is never read as negative.
 */
export function positiveInteger(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0x00) start += 1;
  let trimmed = value.subarray(start);
  if (trimmed.length === 0) trimmed = Buffer.from([0x00]);
  const first = trimmed[0] ?? 0;
  const content = (first & 0x80) !== 0 ? Buffer.concat([Buffer.from([0x00]), trimmed]) : trimmed;
  return tlv(TAG.integer, content);
}

export function smallInteger(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff) {
    throw new Error(`der: ${value} is not a small non-negative integer`);
  }
  const octets: number[] = [];
  let remaining = value;
  do {
    octets.unshift(remaining & 0xff);
    remaining >>>= 8;
  } while (remaining > 0);
  const first = octets[0] ?? 0;
  if ((first & 0x80) !== 0) octets.unshift(0x00);
  return tlv(TAG.integer, Buffer.from(octets));
}

export function boolean(value: boolean): Buffer {
  return tlv(TAG.boolean, Buffer.from([value ? 0xff : 0x00]));
}

export function bitString(content: Buffer, unusedBits = 0): Buffer {
  return tlv(TAG.bitString, Buffer.concat([Buffer.from([unusedBits]), content]));
}

export function octetString(content: Buffer): Buffer {
  return tlv(TAG.octetString, content);
}

export function utf8String(value: string): Buffer {
  return tlv(TAG.utf8String, Buffer.from(value, "utf8"));
}

const PRINTABLE = /^[A-Za-z0-9 '()+,\-./:=?]*$/;

/**
 * PrintableString where the value allows it, UTF8String otherwise. RFC 5280
 * §4.1.2.4 prefers PrintableString for legacy interoperability.
 */
export function directoryString(value: string): Buffer {
  return PRINTABLE.test(value) ? tlv(TAG.printableString, Buffer.from(value, "ascii")) : utf8String(value);
}

export function ia5String(value: string): Buffer {
  return tlv(TAG.ia5String, Buffer.from(value, "ascii"));
}

/** An OBJECT IDENTIFIER from its dotted form. */
export function objectIdentifier(dotted: string): Buffer {
  const parts = dotted.split(".").map((part) => {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0) throw new Error(`der: ${dotted} is not an OID`);
    return value;
  });
  const [first, second, ...rest] = parts;
  if (first === undefined || second === undefined) throw new Error(`der: ${dotted} is too short for an OID`);
  const octets: number[] = [first * 40 + second];
  for (const component of rest) {
    const base128: number[] = [];
    let remaining = component;
    do {
      base128.unshift(remaining & 0x7f);
      remaining = Math.floor(remaining / 128);
    } while (remaining > 0);
    for (let index = 0; index < base128.length - 1; index += 1) {
      base128[index] = (base128[index] ?? 0) | 0x80;
    }
    octets.push(...base128);
  }
  return tlv(TAG.objectIdentifier, Buffer.from(octets));
}

/** An explicitly tagged context-specific value. */
export function contextExplicit(number: number, content: Buffer): Buffer {
  return tlv(0xa0 | number, content);
}

/** An implicitly tagged, primitive context-specific value. */
export function contextPrimitive(number: number, content: Buffer): Buffer {
  return tlv(0x80 | number, content);
}

/** An implicitly tagged, constructed context-specific value. */
export function contextConstructed(number: number, content: Buffer): Buffer {
  return tlv(0xa0 | number, content);
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * RFC 5280 §4.1.2.5 requires UTCTime for dates through 2049 and
 * GeneralizedTime after that. Encoding the wrong one is accepted by some
 * parsers and rejected by others, so the boundary is honoured exactly.
 */
export function time(at: Date): Buffer {
  const year = at.getUTCFullYear();
  const body =
    pad(at.getUTCMonth() + 1, 2) +
    pad(at.getUTCDate(), 2) +
    pad(at.getUTCHours(), 2) +
    pad(at.getUTCMinutes(), 2) +
    pad(at.getUTCSeconds(), 2) +
    "Z";
  if (year >= 1950 && year <= 2049) {
    return tlv(TAG.utcTime, Buffer.from(pad(year % 100, 2) + body, "ascii"));
  }
  return tlv(TAG.generalizedTime, Buffer.from(pad(year, 4) + body, "ascii"));
}

/** AlgorithmIdentifier with no parameters, as ECDSA signature algorithms use. */
export function algorithmIdentifier(oid: string): Buffer {
  return sequence(objectIdentifier(oid));
}

/** One RelativeDistinguishedName holding a single attribute. */
export function relativeDistinguishedName(typeOid: string, value: Buffer): Buffer {
  return set(sequence(objectIdentifier(typeOid), value));
}
