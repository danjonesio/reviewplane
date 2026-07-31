/**
 * Choosing the artefact driver (ADR-0012).
 *
 * One place decides, from configuration validated at startup, so that no module
 * anywhere else asks which driver is running. The rest of the server holds an
 * `ArtefactStore` and cannot tell.
 */

import { FilesystemArtefactStore } from "./filesystem.ts";
import { S3ArtefactStore } from "./s3.ts";
import type { ArtefactStore } from "./driver.ts";
import type { ArtefactStoreConfig } from "../config.ts";

export {
  ARTEFACT_KEY_PATTERN,
  ArtefactStoreError,
  assertArtefactKey,
  digestOf,
  keyForDigest,
  type ArtefactStorageDriver,
  type ArtefactStore,
  type ArtefactStoreUsage,
  type PresignedAccess,
  type StoredObject,
} from "./driver.ts";
export { FilesystemArtefactStore, temporaryArtefactStore } from "./filesystem.ts";
export { S3ArtefactStore, type S3ArtefactStoreOptions } from "./s3.ts";

export function createArtefactStore(config: ArtefactStoreConfig): ArtefactStore {
  if (config.driver === "s3") {
    return new S3ArtefactStore({
      endpoint: config.s3.endpoint,
      bucket: config.s3.bucket,
      region: config.s3.region,
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
      pathStyle: config.s3.pathStyle,
      prefix: config.s3.prefix,
    });
  }
  return new FilesystemArtefactStore(config.path);
}
