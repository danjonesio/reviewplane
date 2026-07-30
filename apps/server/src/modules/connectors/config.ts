/**
 * Connector-module configuration (`docs/CONFIGURATION.md` §1: validate at
 * startup, fail clearly, publish defaults).
 */

import {
  ConfigurationError,
  optionalString,
  readInteger,
  readList,
  type Environment,
} from "../../config.ts";

/** Channel paths on the connector listener. */
export const ENROLMENT_PATH = "/connector/v1/enrol";
export const CONTROL_PATH = "/connector/v1/control";
export const DATA_PATH = "/connector/v1/data";

export interface ConnectorModuleConfig {
  /**
   * The organisation this control plane enrols connectors into. Stage 0 is
   * single-organisation, so an enrolment token scoped to another organisation
   * is refused rather than silently honoured.
   */
  readonly organisationId: string;
  readonly organisationName: string;
  /** Port for the mutually authenticated connector listener. */
  readonly listenPort: number;
  readonly listenHost: string;
  /** Host names and addresses the listener certificate is valid for. */
  readonly tlsHosts: readonly string[];
  /** Operator-supplied listener certificate, if TLS is not terminated here. */
  readonly tlsCertificateFile: string | undefined;
  readonly tlsPrivateKeyFile: string | undefined;
  /**
   * Public `wss://host:port` base the registration response advertises. It may
   * differ from the listen address when a reverse proxy sits in front.
   */
  readonly publicUrl: string;
  /** Lifetime of an issued device identity. Identities are bounded in time. */
  readonly identityTtlDays: number;
  /** Expiry applied to an enrolment token when the request names none. */
  readonly defaultTokenTtlSeconds: number;
  /** Heartbeat interval the connector is expected to keep to. */
  readonly heartbeatIntervalSeconds: number;
  /** Silence after which an ACTIVE connector becomes DEGRADED. */
  readonly degradedAfterSeconds: number;
  /** Silence after which a DEGRADED connector becomes DISCONNECTED. */
  readonly disconnectedAfterSeconds: number;
  /** How often the heartbeat monitor sweeps. */
  readonly monitorIntervalSeconds: number;
}

export function loadConnectorModuleConfig(environment: Environment = process.env): ConnectorModuleConfig {
  const listenPort = readInteger(environment, "REVIEWPLANE_CONNECTOR_PORT", 8443, {
    minimum: 0,
    maximum: 65535,
  });
  const listenHost = optionalString(environment, "REVIEWPLANE_CONNECTOR_HOST") ?? "0.0.0.0";
  const tlsHosts = readList(environment, "REVIEWPLANE_CONNECTOR_TLS_HOSTS", ["localhost", "127.0.0.1"]);

  const certificateFile = optionalString(environment, "REVIEWPLANE_CONNECTOR_TLS_CERT_FILE");
  const privateKeyFile = optionalString(environment, "REVIEWPLANE_CONNECTOR_TLS_KEY_FILE");
  if ((certificateFile === undefined) !== (privateKeyFile === undefined)) {
    throw new ConfigurationError(
      "REVIEWPLANE_CONNECTOR_TLS_CERT_FILE and REVIEWPLANE_CONNECTOR_TLS_KEY_FILE must be set together",
    );
  }

  const publicUrl = optionalString(environment, "REVIEWPLANE_CONNECTOR_PUBLIC_URL");
  if (publicUrl !== undefined && !publicUrl.startsWith("wss://")) {
    throw new ConfigurationError(
      `REVIEWPLANE_CONNECTOR_PUBLIC_URL must use the wss scheme, found ${JSON.stringify(publicUrl)}`,
    );
  }

  const degradedAfterSeconds = readInteger(environment, "REVIEWPLANE_CONNECTOR_DEGRADED_AFTER_SECONDS", 45, {
    minimum: 1,
    maximum: 86_400,
  });
  const disconnectedAfterSeconds = readInteger(
    environment,
    "REVIEWPLANE_CONNECTOR_DISCONNECTED_AFTER_SECONDS",
    90,
    { minimum: 1, maximum: 86_400 },
  );
  if (disconnectedAfterSeconds <= degradedAfterSeconds) {
    throw new ConfigurationError(
      "REVIEWPLANE_CONNECTOR_DISCONNECTED_AFTER_SECONDS must be greater than " +
        "REVIEWPLANE_CONNECTOR_DEGRADED_AFTER_SECONDS",
    );
  }

  return {
    organisationId: optionalString(environment, "REVIEWPLANE_ORGANISATION_ID") ?? "org_default",
    organisationName: optionalString(environment, "REVIEWPLANE_ORGANISATION_NAME") ?? "ReviewPlane",
    listenPort,
    listenHost,
    tlsHosts,
    tlsCertificateFile: certificateFile,
    tlsPrivateKeyFile: privateKeyFile,
    publicUrl: publicUrl ?? `wss://${tlsHosts[0] ?? "localhost"}:${listenPort}`,
    identityTtlDays: readInteger(environment, "REVIEWPLANE_CONNECTOR_IDENTITY_TTL_DAYS", 365, {
      minimum: 1,
      maximum: 3650,
    }),
    defaultTokenTtlSeconds: readInteger(environment, "REVIEWPLANE_ENROLMENT_TOKEN_TTL_SECONDS", 3600, {
      minimum: 60,
      maximum: 604_800,
    }),
    heartbeatIntervalSeconds: readInteger(
      environment,
      "REVIEWPLANE_CONNECTOR_HEARTBEAT_INTERVAL_SECONDS",
      15,
      { minimum: 1, maximum: 300 },
    ),
    degradedAfterSeconds,
    disconnectedAfterSeconds,
    monitorIntervalSeconds: readInteger(environment, "REVIEWPLANE_CONNECTOR_MONITOR_INTERVAL_SECONDS", 5, {
      minimum: 1,
      maximum: 3600,
    }),
  };
}
