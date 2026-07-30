/**
 * Unit tests for the Stage 0 connector certificate authority (ADR-0014).
 *
 * The decisive assertions are the real TLS handshakes: a certificate this
 * module issues must be accepted by OpenSSL for client authentication against
 * the CA that signed it, and a certificate from another CA must be refused. A
 * hand-written DER encoder is only as good as that proof.
 */

import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import { connect as tlsConnect, createServer as createTlsServer, type TLSSocket } from "node:tls";
import { after, describe, test } from "node:test";

import { certificateFingerprint } from "../src/modules/connectors/x509.ts";
import {
  assertAcceptableDeviceKey,
  generateCertificateAuthority,
  issueConnectorCertificate,
  issueListenerCertificate,
} from "../src/modules/connectors/x509.ts";

function inOneYear(): Date {
  return new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
}

function newAuthority() {
  return generateCertificateAuthority({
    commonName: "ReviewPlane connector CA",
    organization: "ReviewPlane",
    notAfter: new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000),
  });
}

function deviceKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    spki: Buffer.from(publicKey.export({ type: "spki", format: "der" })),
  };
}

describe("connector certificate authority", () => {
  test("the authority is a self-signed CA with the extensions RFC 5280 requires", () => {
    const authority = newAuthority();
    const certificate = new X509Certificate(authority.certificatePem);

    assert.equal(certificate.ca, true, "the authority must be marked as a CA");
    assert.equal(certificate.verify(certificate.publicKey), true, "the authority must be self-signed");
    assert.match(certificate.subject, /CN=ReviewPlane connector CA/);
    assert.equal(certificate.subject, certificate.issuer);
    assert.equal(certificate.keyUsage, undefined);
    assert.ok(certificate.validToDate.getTime() > Date.now(), "the authority must not be expired");
    assert.match(authority.fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.match(authority.privateKeyPem, /^-----BEGIN PRIVATE KEY-----/);
  });

  test("an issued connector certificate names the connector and is signed by the authority", () => {
    const authority = newAuthority();
    const device = deviceKey();
    const notAfter = inOneYear();
    const issued = issueConnectorCertificate({
      authority,
      connectorId: "con_abcdefghijklmnopqrstuv",
      organization: "ReviewPlane",
      subjectPublicKeyInfo: device.spki,
      notAfter,
    });

    const certificate = new X509Certificate(issued.der);
    const authorityCertificate = new X509Certificate(authority.certificatePem);

    assert.equal(certificate.ca, false, "a device identity must not be a CA");
    assert.match(certificate.subject, /CN=con_abcdefghijklmnopqrstuv/);
    assert.match(certificate.issuer, /CN=ReviewPlane connector CA/);
    assert.equal(certificate.checkIssued(authorityCertificate), true);
    assert.equal(certificate.verify(authorityCertificate.publicKey), true);
    assert.equal(
      certificate.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      device.spki.toString("base64"),
      "the certificate must carry the connector's own public key",
    );
    assert.equal(
      Math.floor(certificate.validToDate.getTime() / 1000),
      Math.floor(notAfter.getTime() / 1000),
      "the identity must expire when the response says it does",
    );
    assert.equal(issued.fingerprint, certificateFingerprint(issued.der));
    assert.match(issued.serial, /^[0-9a-f]{32}$/);
  });

  test("the schema's certificate bound accommodates an issued identity", () => {
    const authority = newAuthority();
    const issued = issueConnectorCertificate({
      authority,
      connectorId: "con_abcdefghijklmnopqrstuv",
      organization: "ReviewPlane",
      subjectPublicKeyInfo: deviceKey().spki,
      notAfter: inOneYear(),
    });
    const encoded = issued.der.toString("base64");
    // The protocol schema bounds `certificate` to 8192 base64 characters and to
    // the standard base64 character class.
    assert.ok(encoded.length <= 8192, `the certificate encodes to ${String(encoded.length)} characters`);
    assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/);
    // The fingerprint must satisfy the schema's `digest` definition.
    assert.ok(issued.fingerprint.length <= 128);
    assert.match(issued.fingerprint, /^[A-Za-z0-9:._-]+$/);
  });

  test("a device key that is not an accepted elliptic-curve key is refused", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const spki = Buffer.from(rsa.publicKey.export({ type: "spki", format: "der" }));
    assert.throws(() => assertAcceptableDeviceKey(spki), /not an elliptic-curve key/);

    const ed25519 = generateKeyPairSync("ed25519");
    assert.throws(
      () => assertAcceptableDeviceKey(Buffer.from(ed25519.publicKey.export({ type: "spki", format: "der" }))),
      /not an elliptic-curve key/,
    );

    const secp = generateKeyPairSync("ec", { namedCurve: "secp521r1" });
    assert.throws(
      () => assertAcceptableDeviceKey(Buffer.from(secp.publicKey.export({ type: "spki", format: "der" }))),
      /unsupported curve/,
    );

    assert.throws(() => assertAcceptableDeviceKey(Buffer.from("not a key")), /expected tag/);
    assert.throws(
      () => assertAcceptableDeviceKey(Buffer.concat([deviceKey().spki, Buffer.from([0x00])])),
      /trailing data/,
    );
  });

  test("P-384 device keys are accepted", () => {
    const authority = newAuthority();
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    const spki = Buffer.from(publicKey.export({ type: "spki", format: "der" }));
    const issued = issueConnectorCertificate({
      authority,
      connectorId: "con_p384",
      organization: "ReviewPlane",
      subjectPublicKeyInfo: spki,
      notAfter: inOneYear(),
    });
    assert.equal(new X509Certificate(issued.der).ca, false);
  });
});

/**
 * The end-to-end proof: OpenSSL, not this test suite, decides whether the
 * encoder produced a usable certificate.
 */
describe("mutual TLS with issued certificates", () => {
  const servers: ReturnType<typeof createTlsServer>[] = [];
  after(() => {
    for (const server of servers) server.close();
  });

  async function handshake(options: {
    readonly serverAuthority: ReturnType<typeof newAuthority>;
    readonly clientCertificatePem: string | undefined;
    readonly clientPrivateKeyPem: string | undefined;
  }): Promise<{ authorized: boolean; authorizationError: string | null; peerSubject: string | null }> {
    const listener = issueListenerCertificate({
      authority: options.serverAuthority,
      hosts: ["localhost", "127.0.0.1"],
      organization: "ReviewPlane",
      notAfter: inOneYear(),
    });

    return new Promise((resolve, reject) => {
      let observed: { authorized: boolean; error: string | null; subject: string | null } | null = null;
      const server = createTlsServer(
        {
          cert: listener.certificatePem,
          key: listener.privateKeyPem,
          ca: options.serverAuthority.certificatePem,
          requestCert: true,
          rejectUnauthorized: false,
          minVersion: "TLSv1.2",
        },
        (socket: TLSSocket) => {
          const peer = socket.getPeerCertificate();
          observed = {
            authorized: socket.authorized,
            error: socket.authorizationError === undefined ? null : String(socket.authorizationError),
            subject: peer.subject === undefined ? null : String(peer.subject.CN ?? ""),
          };
          socket.end();
        },
      );
      servers.push(server);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("the test server has no port"));
          return;
        }
        const client = tlsConnect({
          host: "127.0.0.1",
          port: address.port,
          servername: "localhost",
          ca: options.serverAuthority.certificatePem,
          ...(options.clientCertificatePem === undefined
            ? {}
            : { cert: options.clientCertificatePem, key: options.clientPrivateKeyPem }),
          minVersion: "TLSv1.2",
        });
        client.on("secureConnect", () => client.end());
        client.on("close", () => {
          server.close();
          resolve({
            authorized: observed?.authorized ?? false,
            authorizationError: observed?.error ?? null,
            peerSubject: observed?.subject ?? null,
          });
        });
        client.on("error", reject);
      });
    });
  }

  test("a connector certificate authenticates against its own authority", async () => {
    const authority = newAuthority();
    const device = deviceKey();
    const issued = issueConnectorCertificate({
      authority,
      connectorId: "con_handshake",
      organization: "ReviewPlane",
      subjectPublicKeyInfo: device.spki,
      notAfter: inOneYear(),
    });
    const result = await handshake({
      serverAuthority: authority,
      clientCertificatePem: issued.pem,
      clientPrivateKeyPem: device.privateKeyPem,
    });
    assert.equal(result.authorized, true, `handshake failed: ${String(result.authorizationError)}`);
    assert.equal(result.peerSubject, "con_handshake");
  });

  test("a certificate from another authority is not authorised", async () => {
    const ours = newAuthority();
    const theirs = newAuthority();
    const device = deviceKey();
    const foreign = issueConnectorCertificate({
      authority: theirs,
      connectorId: "con_foreign",
      organization: "ReviewPlane",
      subjectPublicKeyInfo: device.spki,
      notAfter: inOneYear(),
    });
    const result = await handshake({
      serverAuthority: ours,
      clientCertificatePem: foreign.pem,
      clientPrivateKeyPem: device.privateKeyPem,
    });
    assert.equal(result.authorized, false, "a foreign certificate must not authorise");
  });

  test("a connection with no client certificate is not authorised", async () => {
    const authority = newAuthority();
    const result = await handshake({
      serverAuthority: authority,
      clientCertificatePem: undefined,
      clientPrivateKeyPem: undefined,
    });
    assert.equal(result.authorized, false);
  });

  test("an expired identity is refused by the TLS stack", async () => {
    const authority = newAuthority();
    const device = deviceKey();
    const expired = issueConnectorCertificate({
      authority,
      connectorId: "con_expired",
      organization: "ReviewPlane",
      subjectPublicKeyInfo: device.spki,
      notAfter: new Date(Date.now() - 60_000),
      now: new Date(Date.now() - 3_600_000),
    });
    const result = await handshake({
      serverAuthority: authority,
      clientCertificatePem: expired.pem,
      clientPrivateKeyPem: device.privateKeyPem,
    });
    assert.equal(result.authorized, false, "an expired identity must not authorise");
    assert.match(String(result.authorizationError), /expired/i);
  });

  test("the private key the authority holds matches its certificate", () => {
    const authority = newAuthority();
    const key = createPrivateKey(authority.privateKeyPem);
    const certificate = new X509Certificate(authority.certificatePem);
    assert.equal(certificate.checkPrivateKey(key), true);
  });
});
