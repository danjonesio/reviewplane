/**
 * Bootstrap and storage of the Stage 0 connector certificate authority
 * (ADR-0014).
 *
 * The CA is generated once, on first start, and persisted server-side. Its
 * private key is read only by this process, is returned by no API and appears
 * in no log. The CA *certificate* is exportable, because the tunnel gateway
 * needs it as a trust anchor to verify the same connector certificates.
 */

import { readFile } from "node:fs/promises";

import type { Pool } from "../../db/pool.ts";
import { withTransaction } from "../../db/pool.ts";
import type { ConnectorModuleConfig } from "./config.ts";
import { generateCertificateAuthority, issueListenerCertificate, type Authority } from "./x509.ts";

const CA_PURPOSE = "certificate_authority";
const LISTENER_PURPOSE = "listener";

/** CA lifetime. It outlives every identity it issues. */
const CA_TTL_DAYS = 3650;
/** Listener certificate lifetime. Short enough that rotation is exercised. */
const LISTENER_TTL_DAYS = 365;

export interface TlsMaterial {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly notAfter: Date;
}

interface MaterialRow {
  certificate_pem: string;
  private_key_pem: string;
  not_after: Date;
}

async function readMaterial(pool: Pool, purpose: string): Promise<TlsMaterial | null> {
  const result = await pool.query<MaterialRow>(
    "select certificate_pem, private_key_pem, not_after from connector_tls_material where purpose = $1",
    [purpose],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    certificatePem: row.certificate_pem,
    privateKeyPem: row.private_key_pem,
    notAfter: row.not_after,
  };
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

/**
 * Returns the connector CA, generating it on first start.
 *
 * The insert is guarded by `on conflict do nothing` inside a transaction, so
 * two servers starting together end up with one authority rather than two.
 */
export async function ensureCertificateAuthority(pool: Pool): Promise<TlsMaterial> {
  const existing = await readMaterial(pool, CA_PURPOSE);
  if (existing !== null) return existing;

  const generated = generateCertificateAuthority({
    commonName: "ReviewPlane connector CA",
    organization: "ReviewPlane",
    notAfter: daysFromNow(CA_TTL_DAYS),
  });
  await withTransaction(pool, async (client) => {
    await client.query(
      `insert into connector_tls_material (purpose, certificate_pem, private_key_pem, not_after)
         values ($1, $2, $3, $4)
       on conflict (purpose) do nothing`,
      [CA_PURPOSE, generated.certificatePem, generated.privateKeyPem, generated.notAfter],
    );
  });
  const stored = await readMaterial(pool, CA_PURPOSE);
  if (stored === null) throw new Error("connectors: the certificate authority could not be persisted");
  return stored;
}

/**
 * Returns the connector listener's server certificate.
 *
 * An operator who supplies their own certificate files takes precedence;
 * otherwise one is issued from the same CA, so a self-hosted deployment has a
 * single trust anchor to distribute.
 */
export async function ensureListenerCertificate(
  pool: Pool,
  config: ConnectorModuleConfig,
  authority: Authority,
): Promise<TlsMaterial> {
  if (config.tlsCertificateFile !== undefined && config.tlsPrivateKeyFile !== undefined) {
    const [certificatePem, privateKeyPem] = await Promise.all([
      readFile(config.tlsCertificateFile, "utf8"),
      readFile(config.tlsPrivateKeyFile, "utf8"),
    ]);
    return { certificatePem, privateKeyPem, notAfter: daysFromNow(LISTENER_TTL_DAYS) };
  }

  const existing = await readMaterial(pool, LISTENER_PURPOSE);
  if (existing !== null && existing.notAfter.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
    return existing;
  }

  const issued = issueListenerCertificate({
    authority,
    hosts: config.tlsHosts,
    organization: "ReviewPlane",
    notAfter: daysFromNow(LISTENER_TTL_DAYS),
  });
  await withTransaction(pool, async (client) => {
    await client.query(
      `insert into connector_tls_material (purpose, certificate_pem, private_key_pem, not_after)
         values ($1, $2, $3, $4)
       on conflict (purpose) do update
         set certificate_pem = excluded.certificate_pem,
             private_key_pem = excluded.private_key_pem,
             not_after       = excluded.not_after`,
      [LISTENER_PURPOSE, issued.certificatePem, issued.privateKeyPem, issued.notAfter],
    );
  });
  const stored = await readMaterial(pool, LISTENER_PURPOSE);
  if (stored === null) throw new Error("connectors: the listener certificate could not be persisted");
  return stored;
}
