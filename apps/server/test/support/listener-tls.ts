/**
 * A loopback TLS listener certificate for tests, and its ADR-0015 pin.
 *
 * ADR-0015 says a browser worker reaches an internal origin by resolver rule
 * and public-key pin rather than by DNS and a trusted certificate authority. A
 * test that wants a real browser to load a real page at an internal origin
 * therefore needs the same two things a deployment has: a listener with a
 * certificate, and the base64 SHA-256 of that certificate's
 * SubjectPublicKeyInfo to pin it by.
 *
 * The certificate is issued by the same code the control plane issues its own
 * listener certificate with, so a test cannot be passing against a certificate
 * shape the product would refuse.
 */

import { createHash, X509Certificate } from "node:crypto";

import {
  generateCertificateAuthority,
  issueListenerCertificate,
} from "../../src/modules/connectors/x509.ts";

export interface LoopbackTls {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  /**
   * The pin Chromium is started with
   * (`--ignore-certificate-errors-spki-list`): base64 of the SHA-256 digest of
   * the leaf's SubjectPublicKeyInfo, which is what ADR-0015 authorises — one
   * key, rather than an authority that could vouch for any name.
   */
  readonly certificateSpki: string;
}

/** Issues a leaf for `hosts`, valid for an hour, and returns its pin. */
export function issueLoopbackTls(hosts: readonly string[]): LoopbackTls {
  const notAfter = new Date(Date.now() + 60 * 60 * 1000);
  const authority = generateCertificateAuthority({
    commonName: "ReviewPlane Test Listener CA",
    organization: "ReviewPlane",
    notAfter,
  });
  const leaf = issueListenerCertificate({
    authority: {
      certificatePem: authority.certificatePem,
      privateKeyPem: authority.privateKeyPem,
    },
    hosts,
    organization: "ReviewPlane",
    notAfter,
  });
  const publicKeyDer = new X509Certificate(leaf.certificatePem).publicKey.export({
    type: "spki",
    format: "der",
  });
  return {
    certificatePem: leaf.certificatePem,
    privateKeyPem: leaf.privateKeyPem,
    certificateSpki: createHash("sha256").update(publicKeyDer).digest("base64"),
  };
}
