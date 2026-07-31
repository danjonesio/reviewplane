/**
 * Artefact-module configuration (`docs/CONFIGURATION.md` §1: validate at
 * startup, fail clearly, publish defaults; ADR-0012).
 *
 * The driver is the only choice an operator makes here, and it is made once at
 * startup. `filesystem` is the default and needs one path. `s3` needs an
 * endpoint, a bucket and a credential pair, and every one of those is required
 * rather than defaulted: a deployment that half-configures external storage
 * should fail to start, not start and then fail on the first screenshot.
 *
 * Secrets are read through the `_FILE` indirection `docs/CONFIGURATION.md` §7
 * prefers, so Compose can mount them rather than export them into an
 * environment that ends up in a process listing.
 */

import {
  ConfigurationError,
  optionalString,
  readInteger,
  requireString,
  type Environment,
} from "../../config.ts";
import type { ArtefactStorageDriver } from "./store/driver.ts";

export interface S3DriverConfig {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly pathStyle: boolean;
  readonly prefix: string | undefined;
}

export interface ArtefactStoreConfig {
  readonly driver: ArtefactStorageDriver;
  /** Filesystem root. Read only by the `filesystem` driver. */
  readonly path: string;
  /** Read only by the `s3` driver. */
  readonly s3: S3DriverConfig;
  readonly maxBytes: number;
}

/** The `filesystem` values a deployment that runs `s3` never reads. */
const UNUSED_S3: S3DriverConfig = {
  endpoint: "",
  bucket: "",
  region: "",
  accessKeyId: "",
  secretAccessKey: "",
  pathStyle: true,
  prefix: undefined,
};

/**
 * Defaults for the two settings both this module and `src/config.ts` read.
 *
 * They are declared here because the artefact module owns them, and
 * `src/config.ts` cannot import them without a cycle: it is the file this one
 * imports its readers from. `test/artefact-store-stage-1.test.ts` asserts that
 * the two loaders agree on both values, so the duplication is guarded by a test
 * rather than by a comment asking somebody to remember.
 */
export const DEFAULT_ARTEFACT_PATH = "/var/lib/reviewplane/artefacts";
export const DEFAULT_ARTEFACT_MAX_BYTES = 20_971_520;

/**
 * Reads the artefact-module configuration.
 *
 * `defaults` lets a caller that has already loaded `ServerConfig` pass the
 * values it read rather than reading them twice. A caller that has not — the
 * `jobs` and `status` roles, which must start without a gateway, a worker
 * credential or a capability key — omits it and gets the same answer from the
 * same variables.
 */
export function loadArtefactStoreConfig(
  environment: Environment,
  defaults?: { readonly path: string; readonly maxBytes: number },
): ArtefactStoreConfig {
  const path =
    defaults?.path ??
    optionalString(environment, "REVIEWPLANE_ARTEFACT_PATH") ??
    DEFAULT_ARTEFACT_PATH;
  const maxBytes =
    defaults?.maxBytes ??
    readInteger(environment, "REVIEWPLANE_ARTEFACT_MAX_BYTES", DEFAULT_ARTEFACT_MAX_BYTES, {
      minimum: 1024,
      maximum: 104_857_600,
    });
  const name = optionalString(environment, "REVIEWPLANE_ARTEFACT_DRIVER") ?? "filesystem";
  if (name !== "filesystem" && name !== "s3") {
    throw new ConfigurationError(
      `REVIEWPLANE_ARTEFACT_DRIVER must be filesystem or s3, found ${JSON.stringify(name)} (ADR-0012)`,
    );
  }
  if (name === "filesystem") {
    return { driver: "filesystem", path, s3: UNUSED_S3, maxBytes };
  }

  const endpoint = requireString(environment, "REVIEWPLANE_S3_ENDPOINT");
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new ConfigurationError(
        "REVIEWPLANE_S3_ENDPOINT must be an http or https URL",
      );
    }
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(
      `REVIEWPLANE_S3_ENDPOINT must be a URL, found ${JSON.stringify(endpoint)}`,
    );
  }
  return {
    driver: "s3",
    path,
    maxBytes,
    s3: {
      endpoint,
      bucket: requireString(environment, "REVIEWPLANE_S3_BUCKET"),
      region: optionalString(environment, "REVIEWPLANE_S3_REGION") ?? "us-east-1",
      accessKeyId: requireString(environment, "REVIEWPLANE_S3_ACCESS_KEY"),
      secretAccessKey: requireString(environment, "REVIEWPLANE_S3_SECRET_KEY"),
      // Path style by default: most self-hosted S3-compatible services need it,
      // and virtual-host style would ask the operator for a wildcard
      // certificate covering every bucket name.
      pathStyle: (optionalString(environment, "REVIEWPLANE_S3_PATH_STYLE") ?? "true") !== "false",
      prefix: optionalString(environment, "REVIEWPLANE_S3_PREFIX"),
    },
  };
}

/**
 * Retention windows, in days, per `retention_class`
 * (`docs/CONFIGURATION.md` §1, `docs/SECURITY.md` §14).
 *
 * Stage 1 uses these to compute `expires_at` at intent and **runs no
 * deletion**. Storing the date without acting on it is the honest half of the
 * feature: a reader can see when retention becomes due, and nothing pretends
 * that anything has been removed. Stage 2's expiry job is what makes the date
 * operative.
 *
 * Zero disables expiry for a class, which is what `video: disabled` in the
 * sample configuration means.
 */
export interface RetentionWindows {
  readonly action_screenshots: number;
  readonly browser_traces: number;
  readonly session_video: number;
  readonly console_and_network_logs: number;
  readonly verification_evidence: number;
}

export const DEFAULT_RETENTION_DAYS: RetentionWindows = {
  action_screenshots: 30,
  browser_traces: 14,
  session_video: 0,
  console_and_network_logs: 14,
  // Verification evidence outlives the rest: it is what a human accepted a
  // finding on, and `docs/SECURITY.md` §14 keeps the record of an acceptance
  // longer than the incidental captures around it.
  verification_evidence: 365,
};

export function loadRetentionWindows(environment: Environment): RetentionWindows {
  const day = (name: keyof RetentionWindows, variable: string): number =>
    readInteger(environment, variable, DEFAULT_RETENTION_DAYS[name], { minimum: 0, maximum: 3650 });
  return {
    action_screenshots: day("action_screenshots", "REVIEWPLANE_RETENTION_ACTION_SCREENSHOTS_DAYS"),
    browser_traces: day("browser_traces", "REVIEWPLANE_RETENTION_BROWSER_TRACES_DAYS"),
    session_video: day("session_video", "REVIEWPLANE_RETENTION_SESSION_VIDEO_DAYS"),
    console_and_network_logs: day(
      "console_and_network_logs",
      "REVIEWPLANE_RETENTION_CONSOLE_AND_NETWORK_LOGS_DAYS",
    ),
    verification_evidence: day(
      "verification_evidence",
      "REVIEWPLANE_RETENTION_VERIFICATION_EVIDENCE_DAYS",
    ),
  };
}
