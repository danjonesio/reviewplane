/**
 * The enrolment exchange (`docs/CONNECTOR_PROTOCOL.md` §4,
 * `docs/SECURITY.md` §6.2).
 *
 * The administrator creates a one-time token; the connector generates a key
 * pair locally and exchanges the token plus its public key for a signed device
 * identity; the token is consumed; every later connection is mutually
 * authenticated. A token that is consumed, expired, revoked or scoped
 * elsewhere is refused with `ENROLMENT_TOKEN_INVALID` — one class for all four,
 * so that a caller cannot use the refusal to distinguish "wrong token" from
 * "expired token".
 */

import { createHash } from "node:crypto";

import {
  encodeControlFrame,
  type ConnectorFrame,
  type RegistrationRequest,
  type RegistrationResponse,
} from "@reviewplane/protocol";

import type { Pool } from "../../db/pool.ts";
import { inTransaction } from "../../db/pool.ts";
import { appendEvent } from "../../events/append.ts";
import type { TlsMaterial } from "./certificate-authority.ts";
import { CONTROL_PATH, type ConnectorModuleConfig } from "./config.ts";
import { hashEnrolmentToken, newConnectorId, newEnvironmentId, newMessageId } from "./identifiers.ts";
import {
  consumeEnrolmentToken,
  insertConnector,
  insertEnvironment,
  lockEnrolmentTokenByHash,
} from "./repository.ts";
import { issueConnectorCertificate } from "./x509.ts";

/**
 * A refusal carrying a stable wire error class
 * (`docs/CONNECTOR_PROTOCOL.md` §21). `reason` is for the server log only: the
 * connector receives the class alone, so that a probing client learns nothing
 * about which check failed.
 */
export class EnrolmentRefused extends Error {
  readonly errorClass: "ENROLMENT_TOKEN_INVALID" | "PROTOCOL_UNSUPPORTED";
  readonly reason: string;

  constructor(errorClass: "ENROLMENT_TOKEN_INVALID" | "PROTOCOL_UNSUPPORTED", reason: string) {
    super(`${errorClass}: ${reason}`);
    this.name = "EnrolmentRefused";
    this.errorClass = errorClass;
    this.reason = reason;
  }
}

export interface EnrolmentOutcome {
  readonly connectorId: string;
  readonly environmentId: string;
  readonly certificateFingerprint: string;
  readonly response: RegistrationResponse;
  readonly frame: string;
}

function rfc3339(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

/** Bounds the identity to the configured lifetime, truncated to whole seconds. */
function identityExpiry(config: ConnectorModuleConfig, now: Date): Date {
  const expiry = new Date(now.getTime() + config.identityTtlDays * 24 * 60 * 60 * 1000);
  expiry.setUTCMilliseconds(0);
  return expiry;
}

export interface EnrolContext {
  readonly pool: Pool;
  readonly config: ConnectorModuleConfig;
  readonly authority: TlsMaterial;
}

/**
 * Redeems an enrolment token and issues a device identity.
 *
 * Token validation, token consumption, environment creation, connector creation
 * and the `connector.enrolled` event all commit in one transaction, so an
 * interrupted enrolment leaves neither a consumed token without an identity nor
 * an identity without an audit record.
 */
export async function enrol(
  context: EnrolContext,
  request: RegistrationRequest,
  metadata: { readonly requestId: string },
): Promise<EnrolmentOutcome> {
  const { pool, config, authority } = context;
  const tokenHash = hashEnrolmentToken(request.enrolment_token.reveal());
  const publicKeyDer = decodePublicKey(request.public_key);

  return inTransaction(pool, async (client) => {
    const token = await lockEnrolmentTokenByHash(client, tokenHash);
    const now = new Date();

    if (token === null) {
      throw new EnrolmentRefused("ENROLMENT_TOKEN_INVALID", "no enrolment token matches the presented value");
    }
    if (token.revokedAt !== null) {
      throw new EnrolmentRefused("ENROLMENT_TOKEN_INVALID", "the enrolment token was revoked");
    }
    if (token.expiresAt.getTime() <= now.getTime()) {
      throw new EnrolmentRefused("ENROLMENT_TOKEN_INVALID", "the enrolment token expired");
    }
    if (token.uses >= token.maxUses) {
      throw new EnrolmentRefused("ENROLMENT_TOKEN_INVALID", "the enrolment token was already consumed");
    }
    // Stage 0 is single-organisation. A token minted for another organisation
    // is out of scope for this control plane and is refused, not honoured.
    if (token.organisationId !== config.organisationId) {
      throw new EnrolmentRefused(
        "ENROLMENT_TOKEN_INVALID",
        "the enrolment token is scoped to another organisation",
      );
    }
    // A token may pin the environment labels it expects
    // (docs/CONNECTOR_PROTOCOL.md section 4.1). A connector that does not
    // declare them is enrolling into the wrong place.
    const declared = new Set(request.environment.labels ?? []);
    const missing = token.environmentLabels.filter((label) => !declared.has(label));
    if (missing.length > 0) {
      throw new EnrolmentRefused(
        "ENROLMENT_TOKEN_INVALID",
        "the environment does not carry the labels the enrolment token requires",
      );
    }

    await consumeEnrolmentToken(client, token.id);

    const connectorId = newConnectorId();
    const environmentId = newEnvironmentId();
    const notAfter = identityExpiry(config, now);
    const certificate = issueConnectorCertificate({
      authority: { certificatePem: authority.certificatePem, privateKeyPem: authority.privateKeyPem },
      connectorId,
      organization: "ReviewPlane",
      subjectPublicKeyInfo: publicKeyDer,
      notAfter,
      now,
    });

    await insertEnvironment(client, {
      id: environmentId,
      organisationId: token.organisationId,
      projectId: token.projectId,
      name: request.environment.name,
      platform: request.environment.platform,
      architecture: request.environment.architecture,
      labels: request.environment.labels ?? [],
    });
    await insertConnector(client, {
      id: connectorId,
      organisationId: token.organisationId,
      environmentId,
      projectId: token.projectId,
      enrolmentTokenId: token.id,
      certificateFingerprint: certificate.fingerprint,
      certificateSerial: certificate.serial,
      certificateNotAfter: certificate.notAfter,
      publicKey: request.public_key,
      version: request.connector.version,
      capabilities: request.connector.capabilities,
    });

    await appendEvent(client, {
      type: "connector.enrolled",
      organisationId: token.organisationId,
      projectId: token.projectId,
      actor: { type: "connector", id: connectorId },
      correlation: {
        request_id: metadata.requestId,
        connector_id: connectorId,
        environment_id: environmentId,
      },
      payload: {
        new_status: "PENDING_ENROLMENT",
        environment_name: request.environment.name,
        platform: request.environment.platform,
        architecture: request.environment.architecture,
        connector_version: request.connector.version,
        capabilities: request.connector.capabilities,
        certificate_fingerprint: certificate.fingerprint,
        identity_expires_at: notAfter.toISOString(),
        enrolment_token_id: token.id,
      },
    });

    const response: RegistrationResponse = {
      connector_id: connectorId,
      signed_identity: {
        certificate: certificate.der.toString("base64"),
        certificate_fingerprint: certificate.fingerprint,
        expires_at: rfc3339(notAfter),
      },
      control_plane_endpoints: {
        control_url: `${config.publicUrl}${CONTROL_PATH}`,
        data_url: config.dataUrl,
      },
      policy_digest: emptyPolicyDigest(),
    };
    const frame: ConnectorFrame = {
      envelope: {
        protocol_version: 1,
        message_id: newMessageId(),
        type: "connector.registration.response",
        sent_at: rfc3339(now),
        correlation_id: metadata.requestId,
      },
      type: "connector.registration.response",
      payload: response,
    };
    return {
      connectorId,
      environmentId,
      certificateFingerprint: certificate.fingerprint,
      response,
      frame: encodeControlFrame(frame),
    };
  });
}

/**
 * Stage 0 has no organisation policy document, so the digest is of the empty
 * policy. It is a real digest rather than a placeholder, so a connector that
 * starts comparing it will not have to change shape when policy arrives.
 */
const EMPTY_POLICY_DIGEST = `sha256:${createHash("sha256").update("{}", "utf8").digest("hex")}`;

function emptyPolicyDigest(): string {
  return EMPTY_POLICY_DIGEST;
}

/** Decodes and bounds the connector's SubjectPublicKeyInfo. */
function decodePublicKey(base64: string): Buffer {
  const der = Buffer.from(base64, "base64");
  if (der.length === 0) {
    throw new EnrolmentRefused("PROTOCOL_UNSUPPORTED", "the registration request carries no public key");
  }
  return der;
}
