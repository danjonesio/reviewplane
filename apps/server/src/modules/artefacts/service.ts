/**
 * Artefact upload: intent, content, completion, retrieval and deletion
 * (`docs/API.md` §15, ADR-0012, ADR-0019).
 *
 * The rule the whole flow exists to enforce is one line of
 * `docs/ARCHITECTURE.md` §14: "Never record an artefact as available before
 * integrity verification." So:
 *
 * 1. the intent declares kind, size and digest, and creates a `pending` row;
 * 2. the content is uploaded and stored under a key derived from the digest
 *    the *server* computes, not the one the client claimed;
 * 3. completion re-reads the stored bytes, recomputes the digest, and compares
 *    it with both the declared and the observed value. Only then does the row
 *    become `available`.
 *
 * A mismatch at any point leaves the artefact unavailable and reports
 * `ARTEFACT_UPLOAD_INCOMPLETE`. The database constraint
 * `artefacts_available_is_verified` means that even a bug here cannot produce
 * an available artefact whose digest was never checked.
 *
 * **Failure is split into two kinds, deliberately.** Bytes that do not match
 * what was declared are the uploader's fault, and the artefact is marked
 * `failed`: retrying the same intent would be wrong, because the intent
 * describes something the uploader did not send. A store that cannot be written
 * to or read from is not the uploader's fault, and the artefact stays `pending`
 * so that the same intent — and the same idempotency key — can be retried once
 * the store returns. Marking a store outage `failed` would turn a transient
 * fault into lost evidence.
 *
 * **Every lookup that authorises carries its scope in the query.** `getInScope`
 * puts the identifier, the project scope and the organisation in one predicate,
 * so a row belonging to another tenant is not returned and then rejected; a
 * foreign identifier and an unknown one produce the same `RESOURCE_NOT_FOUND`,
 * byte for byte, which is what `docs/TESTING.md` §10 requires of a
 * cross-project read.
 */

import { createHash, randomBytes } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { inTransaction } from "../../db/pool.ts";
import {
  appendEvent,
  recordStateChange,
  type ActorType,
  type EventActor,
  type EventPublisher,
} from "../../events/append.ts";
import { ApiError, notFound } from "../../errors.ts";
import { newId } from "../../ids.ts";
import { enqueueJob } from "../../jobs/runner.ts";
import { contentTypeMismatch, isSafeFilenameLabel, measureImage } from "./content.ts";
import {
  acceptedContentTypes,
  contentTypesForKind,
  defaultRetentionClassForKind,
  dispositionFor,
  isActiveContentType,
  isDeferredKind,
  isStage1Kind,
  kindWantsThumbnail,
  IMAGE_CONTENT_TYPES,
  type ArtefactDisposition,
} from "./kinds.ts";
import { renderThumbnail, UnsupportedImageError } from "./thumbnail.ts";
import {
  ArtefactStoreError,
  keyForDigest,
  type ArtefactStorageDriver,
  type ArtefactStore,
} from "./store/index.ts";
import type { RetentionWindows } from "./config.ts";

export type ArtefactState = "pending" | "uploaded" | "available" | "failed";
export type ThumbnailState = "not_requested" | "pending" | "generated" | "unsupported" | "failed";

export interface ArtefactRecord {
  readonly id: string;
  readonly organisation_id: string;
  readonly project_id: string;
  readonly kind: string;
  readonly state: ArtefactState;
  readonly content_type: string;
  readonly declared_size_bytes: number;
  readonly declared_sha256: string;
  readonly size_bytes: number | null;
  readonly sha256: string | null;
  readonly storage_key: string | null;
  readonly content_width_px: number | null;
  readonly content_height_px: number | null;
  readonly filename_label: string | null;
  readonly redaction_state: string;
  readonly retention_class: string;
  readonly encryption_key_reference: string | null;
  readonly source_artefact_id: string | null;
  readonly thumbnail_state: ThumbnailState;
  readonly thumbnail_artefact_id: string | null;
  readonly browser_session_id: string | null;
  readonly created_at: string;
  readonly available_at: string | null;
  readonly expires_at: string | null;
  readonly deleted_at: string | null;
}

/**
 * The rows a caller is allowed to see.
 *
 * `null` means unrestricted on that axis: an organisation-wide human session
 * has no project restriction, and the bootstrap administrator has neither. A
 * principal that carries an organisation always has it compared, which is the
 * defence-in-depth column `docs/DOMAIN_MODEL.md` §3 requires.
 */
export interface ArtefactScope {
  readonly organisationId: string | null;
  readonly projectIds: readonly string[] | null;
}

/** Every artefact in the deployment. Only for a principal entitled to that. */
export const UNRESTRICTED_SCOPE: ArtefactScope = { organisationId: null, projectIds: null };

export interface UploadIntentInput {
  readonly organisationId: string;
  readonly projectId: string;
  readonly kind: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly retentionClass?: string;
  readonly browserSessionId?: string;
  readonly sourceArtefactId?: string;
  /** Display metadata only. It never reaches the storage key (ADR-0012). */
  readonly filenameLabel?: string;
  readonly actor: EventActor;
}

/**
 * A short-lived, subject-scoped admission to one artefact's bytes (ADR-0019).
 * The identifier travels in a URL; the credential does not.
 */
export interface ArtefactGrant {
  readonly id: string;
  readonly artefact_id: string;
  readonly organisation_id: string;
  readonly project_id: string;
  readonly subject_type: ActorType;
  readonly subject_id: string;
  readonly expires_at: string;
  /**
   * Where the bytes are, when the driver issues a presigned URL rather than
   * serving them itself (ADR-0012, ADR-0019). Absent under the `filesystem`
   * driver, where the control plane is the data path.
   */
  readonly presigned_url?: string;
}

/** `docs/SECURITY.md` §13: short-lived. Two minutes is a page load. */
export const ARTEFACT_GRANT_TTL_SECONDS = 120;

/** What `reviewplane status` reports about the store (`docs/OPERATIONS.md` §3). */
export interface ArtefactStoreStatus {
  readonly driver: ArtefactStorageDriver;
  readonly available: boolean;
  readonly detail?: string;
  readonly artefact_count: number;
  readonly stored_bytes: number;
  readonly pending_bytes: number;
}

const SELECT_COLUMNS = `id, organisation_id, project_id, kind, state, content_type,
       declared_size_bytes, declared_sha256, size_bytes, sha256, storage_key,
       content_width_px, content_height_px, filename_label, redaction_state,
       retention_class, encryption_key_reference, source_artefact_id,
       thumbnail_state, thumbnail_artefact_id, browser_session_id,
       created_at, available_at, expires_at, deleted_at`;

function toRecord(row: Record<string, unknown>): ArtefactRecord {
  const number = (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value);
  const time = (value: unknown): string | null =>
    value === null || value === undefined ? null : (value as Date).toISOString();
  return {
    id: row["id"] as string,
    organisation_id: row["organisation_id"] as string,
    project_id: row["project_id"] as string,
    kind: row["kind"] as string,
    state: row["state"] as ArtefactState,
    content_type: row["content_type"] as string,
    declared_size_bytes: Number(row["declared_size_bytes"]),
    declared_sha256: row["declared_sha256"] as string,
    size_bytes: number(row["size_bytes"]),
    sha256: (row["sha256"] as string | null) ?? null,
    storage_key: (row["storage_key"] as string | null) ?? null,
    content_width_px: number(row["content_width_px"]),
    content_height_px: number(row["content_height_px"]),
    filename_label: (row["filename_label"] as string | null) ?? null,
    redaction_state: row["redaction_state"] as string,
    retention_class: row["retention_class"] as string,
    encryption_key_reference: (row["encryption_key_reference"] as string | null) ?? null,
    source_artefact_id: (row["source_artefact_id"] as string | null) ?? null,
    thumbnail_state: (row["thumbnail_state"] as ThumbnailState | null) ?? "not_requested",
    thumbnail_artefact_id: (row["thumbnail_artefact_id"] as string | null) ?? null,
    browser_session_id: (row["browser_session_id"] as string | null) ?? null,
    created_at: (row["created_at"] as Date).toISOString(),
    available_at: time(row["available_at"]),
    expires_at: time(row["expires_at"]),
    deleted_at: time(row["deleted_at"]),
  };
}

export interface ArtefactServiceOptions {
  readonly retention?: RetentionWindows;
  readonly publisher?: EventPublisher;
}

export class ArtefactService {
  readonly #pool: Pool;
  readonly #store: ArtefactStore;
  readonly #maxBytes: number;
  readonly #retention: RetentionWindows | undefined;
  readonly #publisher: EventPublisher | undefined;

  constructor(
    pool: Pool,
    store: ArtefactStore,
    maxBytes: number,
    options: ArtefactServiceOptions = {},
  ) {
    this.#pool = pool;
    this.#store = store;
    this.#maxBytes = maxBytes;
    this.#retention = options.retention;
    this.#publisher = options.publisher;
  }

  get maxBytes(): number {
    return this.#maxBytes;
  }

  get driver(): ArtefactStorageDriver {
    return this.#store.driver;
  }

  /** Step 1: record the intent and the values that will be verified. */
  async createIntent(input: UploadIntentInput): Promise<ArtefactRecord> {
    if (!isStage1Kind(input.kind)) {
      throw new ApiError(
        "UNSUPPORTED_CAPABILITY",
        isDeferredKind(input.kind)
          ? `Artefacts of kind ${input.kind} are not captured yet; this build stores none.`
          : `${input.kind === "" ? "An unstated kind" : input.kind} is not an artefact kind.`,
        { field: "kind" },
      );
    }
    const allowed = contentTypesForKind(input.kind);
    if (!allowed.includes(input.contentType)) {
      throw new ApiError(
        "UNSUPPORTED_CAPABILITY",
        `A ${input.kind} artefact holds ${allowed.join(" or ")}, not ${
          input.contentType === "" ? "an unstated media type" : input.contentType
        }. This store accepts ${acceptedContentTypes().join(", ")}.`,
        { field: "content_type" },
      );
    }
    if (
      !Number.isInteger(input.sizeBytes) ||
      input.sizeBytes <= 0 ||
      input.sizeBytes > this.#maxBytes
    ) {
      throw new ApiError(
        "POLICY_DENIED",
        `An artefact must be between 1 and ${String(this.#maxBytes)} bytes.`,
        { field: "size_bytes", max_bytes: this.#maxBytes },
      );
    }
    if (!/^[0-9a-f]{64}$/u.test(input.sha256)) {
      throw new ApiError(
        "UNSUPPORTED_CAPABILITY",
        "sha256 must be 64 lowercase hexadecimal characters.",
        { field: "sha256" },
      );
    }
    if (input.filenameLabel !== undefined && !isSafeFilenameLabel(input.filenameLabel)) {
      // The key is content-addressed, so this value never reaches a path. It is
      // refused anyway (`docs/TESTING.md` §10, path traversal in filename
      // metadata).
      throw new ApiError(
        "UNSUPPORTED_CAPABILITY",
        "filename is display metadata: it must be a plain name, not a path.",
        { field: "filename" },
      );
    }
    const retentionClass = input.retentionClass ?? defaultRetentionClassForKind(input.kind);
    const expiresAt = this.#expiryFor(retentionClass);

    const id = newId("art_");
    const { result } = await recordStateChange(
      this.#pool,
      {
        type: "artefact.upload_started",
        organisationId: input.organisationId,
        projectId: input.projectId,
        actor: input.actor,
        correlation: {
          artefact_id: id,
          ...(input.browserSessionId === undefined
            ? {}
            : { browser_session_id: input.browserSessionId }),
        },
        payload: {
          artefact_id: id,
          kind: input.kind,
          declared_size_bytes: input.sizeBytes,
          declared_sha256: input.sha256,
          content_type: input.contentType,
        },
      },
      async (client) => {
        const inserted = await client.query(
          `INSERT INTO artefacts (
              id, organisation_id, project_id, kind, state, content_type,
              declared_size_bytes, declared_sha256, retention_class,
              browser_session_id, created_by_actor_type, created_by_actor_id,
              filename_label, source_artefact_id, expires_at
           ) VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           RETURNING ${SELECT_COLUMNS}`,
          [
            id,
            input.organisationId,
            input.projectId,
            input.kind,
            input.contentType,
            input.sizeBytes,
            input.sha256,
            retentionClass,
            input.browserSessionId ?? null,
            input.actor.type,
            input.actor.id ?? null,
            input.filenameLabel ?? null,
            input.sourceArtefactId ?? null,
            expiresAt,
          ],
        );
        return toRecord(inserted.rows[0] as Record<string, unknown>);
      },
      this.#publisher,
    );
    return result;
  }

  /**
   * When retention becomes due for a class (`docs/SECURITY.md` §14).
   *
   * Stage 1 records the date and deletes nothing. A class configured to zero
   * days has no expiry at all, which is what `video: disabled` in the sample
   * configuration means.
   */
  #expiryFor(retentionClass: string): Date | null {
    const windows = this.#retention;
    if (windows === undefined) return null;
    const days = windows[retentionClass as keyof RetentionWindows];
    if (days === undefined || days <= 0) return null;
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  /** Step 2 and 3: store the bytes. The row stays unavailable until verified. */
  async storeContent(
    record: ArtefactRecord,
    bytes: Buffer,
    actor: EventActor,
  ): Promise<ArtefactRecord> {
    if (record.state === "available") {
      throw new ApiError(
        "IDEMPOTENCY_CONFLICT",
        "This artefact has already been completed and cannot be rewritten.",
      );
    }
    if (record.state === "failed") {
      throw new ApiError(
        "ARTEFACT_UPLOAD_INCOMPLETE",
        "This artefact failed verification. Create a new upload intent rather than rewriting it.",
      );
    }
    if (bytes.byteLength > this.#maxBytes) {
      throw new ApiError("POLICY_DENIED", "The uploaded content exceeds the artefact size limit.", {
        max_bytes: this.#maxBytes,
      });
    }

    // The declared content type is a claim; the bytes are evidence. Refusing
    // here means an SVG or an HTML document uploaded as an image never becomes
    // an artefact at all, so there is nothing for a viewer to be persuaded to
    // render as active content (`docs/SECURITY.md` §13).
    const mismatch = contentTypeMismatch(record.content_type, bytes);
    if (mismatch !== null) {
      await this.#markFailed(record, mismatch, actor);
      throw new ApiError("UNSUPPORTED_CAPABILITY", mismatch, { field: "content_type" });
    }

    let storedKey: string;
    try {
      storedKey = (await this.#store.put(bytes)).key;
    } catch (error) {
      // A store that will not take the bytes is not the uploader's fault. The
      // artefact stays `pending`, so the same intent and idempotency key remain
      // retryable, and nothing anywhere records it as available
      // (`docs/ARCHITECTURE.md` §14).
      throw storeUnavailable(error, "The artefact store could not accept the content.");
    }
    const updated = await this.#pool.query(
      `UPDATE artefacts SET state = 'uploaded', storage_key = $2
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING ${SELECT_COLUMNS}`,
      [record.id, storedKey],
    );
    const row = updated.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) throw notFound("The artefact");
    return toRecord(row);
  }

  /**
   * Step 4 and 5: verify the stored bytes against the declared and observed
   * values, then make the artefact available.
   */
  async complete(
    record: ArtefactRecord,
    observed: { sha256: string; sizeBytes?: number },
    actor: EventActor,
  ): Promise<ArtefactRecord> {
    if (record.state === "available") return record;
    if (record.storage_key === null) {
      throw new ApiError(
        "ARTEFACT_UPLOAD_INCOMPLETE",
        "No content has been uploaded for this artefact.",
      );
    }

    const fail = async (message: string): Promise<never> => {
      await this.#markFailed(record, message, actor);
      throw new ApiError("ARTEFACT_UPLOAD_INCOMPLETE", message);
    };

    if (observed.sha256 !== record.declared_sha256) {
      return fail("The digest reported on completion differs from the one declared on intent.");
    }
    if (observed.sizeBytes !== undefined && observed.sizeBytes !== record.declared_size_bytes) {
      return fail("The size reported on completion differs from the one declared on intent.");
    }

    // The authoritative check: what is actually in the store. A store that
    // cannot answer is a fault rather than a verification failure, so it leaves
    // the artefact retryable instead of marking it failed.
    let bytes: Buffer;
    try {
      bytes = await this.#store.get(record.storage_key);
    } catch (error) {
      throw storeUnavailable(
        error,
        "The stored artefact could not be read back for verification, so it is not available.",
      );
    }
    const storedSha256 = createHash("sha256").update(bytes).digest("hex");

    if (storedSha256 !== record.declared_sha256) {
      return fail("The stored bytes do not match the declared digest.");
    }
    if (bytes.byteLength !== record.declared_size_bytes) {
      return fail("The stored bytes do not match the declared size.");
    }
    if (record.storage_key !== keyForDigest(storedSha256)) {
      return fail("The stored artefact is not filed under its content address.");
    }
    const mismatch = contentTypeMismatch(record.content_type, bytes);
    if (mismatch !== null) return fail(mismatch);

    // The artefact content rectangle (`docs/DOMAIN_MODEL.md` §16) is measured
    // from the bytes the server verified, never taken from the uploader: it is
    // the reference frame every annotation on this artefact is normalised
    // against, so an uploader that could choose it could move every existing
    // mark.
    let dimensions: { widthPx: number; heightPx: number } | null = null;
    if (IMAGE_CONTENT_TYPES.has(record.content_type)) {
      dimensions = measureImage(record.content_type, bytes);
      if (dimensions === null) {
        return fail("The stored image could not be measured, so it has no content rectangle.");
      }
    }

    const wantsThumbnail = kindWantsThumbnail(record.kind) && dimensions !== null;
    const sizeBytes = bytes.byteLength;
    const storageKey = record.storage_key;

    return inTransaction(this.#pool, async (client) => {
      const updated = await client.query(
        `UPDATE artefacts
            SET state = 'available', sha256 = $2, size_bytes = $3, available_at = now(),
                content_width_px = $4, content_height_px = $5, thumbnail_state = $6
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING ${SELECT_COLUMNS}`,
        [
          record.id,
          storedSha256,
          sizeBytes,
          dimensions?.widthPx ?? null,
          dimensions?.heightPx ?? null,
          wantsThumbnail ? "pending" : record.thumbnail_state,
        ],
      );
      const row = updated.rows[0] as Record<string, unknown> | undefined;
      if (row === undefined) throw notFound("The artefact");

      const contentRectangle =
        dimensions === null
          ? {}
          : {
              content_rectangle: { width_px: dimensions.widthPx, height_px: dimensions.heightPx },
            };
      const correlation = {
        artefact_id: record.id,
        ...(record.browser_session_id === null
          ? {}
          : { browser_session_id: record.browser_session_id }),
      };
      await appendEvent(client, {
        type: "artefact.upload_completed",
        organisationId: record.organisation_id,
        projectId: record.project_id,
        actor,
        correlation,
        payload: {
          artefact_id: record.id,
          kind: record.kind,
          sha256: storedSha256,
          size_bytes: sizeBytes,
          storage_key: storageKey,
          redaction_state: record.redaction_state,
          ...contentRectangle,
        },
      });
      if (record.kind === "screenshot" && dimensions !== null) {
        await appendEvent(client, {
          type: "screenshot.captured",
          organisationId: record.organisation_id,
          projectId: record.project_id,
          actor,
          correlation,
          payload: {
            artefact_id: record.id,
            sha256: storedSha256,
            size_bytes: sizeBytes,
            content_rectangle: { width_px: dimensions.widthPx, height_px: dimensions.heightPx },
          },
        });
      }
      if (wantsThumbnail) {
        // Enqueued in the same transaction as the availability transition, so a
        // thumbnail job never exists for an artefact that did not become
        // available and an available artefact never silently lacks its job.
        await enqueueJob(client, {
          organisationId: record.organisation_id,
          projectId: record.project_id,
          kind: "artefact_thumbnail",
          payload: { artefact_id: record.id },
          idempotencyKey: `artefact_thumbnail:${record.id}`,
        });
      }
      return toRecord(row);
    });
  }

  async #markFailed(record: ArtefactRecord, reason: string, actor: EventActor): Promise<void> {
    await recordStateChange(
      this.#pool,
      {
        type: "artefact.upload_failed",
        organisationId: record.organisation_id,
        projectId: record.project_id,
        actor,
        correlation: { artefact_id: record.id },
        payload: { artefact_id: record.id, reason, code: "ARTEFACT_UPLOAD_INCOMPLETE" },
      },
      async (client: PoolClient) => {
        await client.query("UPDATE artefacts SET state = 'failed' WHERE id = $1", [record.id]);
      },
      this.#publisher,
    );
  }

  /**
   * Resolves an artefact inside the caller's scope.
   *
   * The identifier, the project scope and the organisation are all in the
   * predicate, so a row that satisfies one and not the others is never
   * returned. A foreign artefact and an unknown one produce the same refusal
   * (`docs/TESTING.md` §10, `docs/API.md` §5): a distinct one would confirm
   * that the identifier exists, which is exactly the enumeration a
   * cross-project caller wants.
   *
   * A deleted artefact is absent. Its metadata row is retained so the audit
   * trail still resolves the identifier, but no read path may reach it.
   */
  async getInScope(artefactId: string, scope: ArtefactScope): Promise<ArtefactRecord> {
    const rows = await this.#pool.query(
      `SELECT ${SELECT_COLUMNS}
         FROM artefacts
        WHERE id = $1
          AND deleted_at IS NULL
          AND ($2::text[] IS NULL OR project_id = ANY($2))
          AND ($3::text IS NULL OR organisation_id = $3)`,
      [artefactId, scope.projectIds === null ? null : [...scope.projectIds], scope.organisationId],
    );
    const row = rows.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) throw notFound("The artefact");
    return toRecord(row);
  }

  /**
   * Reads a record without a scope.
   *
   * **Never an authorisation path.** It exists for the job runner, which acts
   * as the system on an artefact handed to it by a committed transaction, and
   * for tests. Anything reached by a request uses {@link getInScope}.
   */
  async getInternal(artefactId: string): Promise<ArtefactRecord | null> {
    const rows = await this.#pool.query(`SELECT ${SELECT_COLUMNS} FROM artefacts WHERE id = $1`, [
      artefactId,
    ]);
    const row = rows.rows[0] as Record<string, unknown> | undefined;
    return row === undefined ? null : toRecord(row);
  }

  /** Content is served only for a verified artefact. */
  async readContent(record: ArtefactRecord): Promise<Buffer> {
    if (record.state !== "available" || record.storage_key === null) {
      throw new ApiError(
        "ARTEFACT_UPLOAD_INCOMPLETE",
        "This artefact has not been verified and is not available.",
      );
    }
    try {
      return await this.#store.get(record.storage_key);
    } catch (error) {
      throw storeUnavailable(error, "The stored artefact could not be read.");
    }
  }

  /**
   * Mints a short-lived grant for one artefact (ADR-0019).
   *
   * The grant is bound to a subject, so possession of the identifier is not
   * enough: the caller must still authenticate as that subject when it presents
   * it. That is what lets the identifier travel in a URL — which an `<img>`
   * element requires — while `docs/SECURITY.md` §18's rule against credentials
   * in URLs still holds.
   *
   * Under the `s3` driver the same call returns a presigned URL instead of a
   * path this server serves, which ADR-0019 states explicitly: the driver
   * decides what the URL points at and the caller sees one flow. The grant row
   * is written and audited either way — the record of who read what is the
   * point, and it must not depend on which driver a deployment runs.
   */
  async grantAccess(input: {
    readonly record: ArtefactRecord;
    readonly subjectType: ActorType;
    readonly subjectId: string;
    readonly actor: EventActor;
    readonly ttlSeconds?: number;
  }): Promise<ArtefactGrant> {
    const record = input.record;
    if (record.state !== "available" || record.storage_key === null) {
      throw new ApiError(
        "ARTEFACT_UPLOAD_INCOMPLETE",
        "This artefact has not been verified and is not available.",
      );
    }
    const ttlSeconds = input.ttlSeconds ?? ARTEFACT_GRANT_TTL_SECONDS;
    const id = `agr_${randomBytes(24).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    let presignedUrl: string | undefined;
    if (this.#store.presignDownload !== undefined) {
      const presigned = await this.#store.presignDownload(record.storage_key, {
        ttlSeconds,
        contentType: record.content_type,
        contentDisposition: `${dispositionFor(record.content_type)}; filename="${record.id}"`,
      });
      presignedUrl = presigned.url;
    }

    const { result } = await recordStateChange(
      this.#pool,
      {
        type: "artefact.access_granted",
        organisationId: record.organisation_id,
        projectId: record.project_id,
        actor: input.actor,
        correlation: { artefact_id: record.id },
        payload: {
          artefact_id: record.id,
          grant_id: id,
          subject: {
            type: input.subjectType,
            id: input.subjectId,
            ...(input.actor.display === undefined ? {} : { display: input.actor.display }),
          },
          expires_at: expiresAt.toISOString(),
        },
      },
      async (client) => {
        await client.query(
          `INSERT INTO artefact_access_grants
             (id, artefact_id, organisation_id, project_id, subject_type, subject_id, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            id,
            record.id,
            record.organisation_id,
            record.project_id,
            input.subjectType,
            input.subjectId,
            expiresAt.toISOString(),
          ],
        );
        const grant: ArtefactGrant = {
          id,
          artefact_id: record.id,
          organisation_id: record.organisation_id,
          project_id: record.project_id,
          subject_type: input.subjectType,
          subject_id: input.subjectId,
          expires_at: expiresAt.toISOString(),
          ...(presignedUrl === undefined ? {} : { presigned_url: presignedUrl }),
        };
        return grant;
      },
      this.#publisher,
    );
    return result;
  }

  /**
   * Resolves a grant. Returns null for anything that is not live, so the caller
   * reports one refusal for an unknown, expired or revoked grant and does not
   * tell an unauthenticated client which it was (`docs/SECURITY.md` §5).
   */
  async resolveGrant(grantId: string): Promise<ArtefactGrant | null> {
    const rows = await this.#pool.query<{
      id: string;
      artefact_id: string;
      organisation_id: string;
      project_id: string;
      subject_type: ActorType;
      subject_id: string;
      expires_at: Date;
    }>(
      `SELECT id, artefact_id, organisation_id, project_id, subject_type, subject_id, expires_at
         FROM artefact_access_grants
        WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [grantId],
    );
    const row = rows.rows[0];
    if (row === undefined) return null;
    await this.#pool.query(
      "UPDATE artefact_access_grants SET use_count = use_count + 1, last_used_at = now() WHERE id = $1",
      [row.id],
    );
    return { ...row, expires_at: row.expires_at.toISOString() };
  }

  /**
   * Deletes one artefact.
   *
   * The metadata row is retained with `deleted_at` set. The identifier appears
   * in events, in exports and in MCP responses, and an audit trail whose
   * identifiers stop resolving is worse than a row recording that the bytes are
   * gone. Every read path treats a deleted artefact as absent.
   *
   * The stored object is removed **only when no other live artefact shares its
   * key**. Keys are content-addressed (ADR-0012), so two artefacts holding
   * identical bytes — a before and an after screenshot of an unchanged region,
   * say — are one stored object, and removing it for one of them would destroy
   * evidence the other still references. The check and the metadata write share
   * a transaction, and the object is removed after it commits: a crash between
   * the two leaves an unreferenced object, which is wasted disk, rather than a
   * live artefact whose bytes have gone.
   */
  async delete(
    record: ArtefactRecord,
    actor: EventActor,
    reason?: string,
  ): Promise<{ readonly record: ArtefactRecord; readonly bytesRemoved: boolean }> {
    const { result } = await recordStateChange<{
      record: ArtefactRecord;
      bytesRemoved: boolean;
    }>(
      this.#pool,
      (outcome) => ({
        type: "artefact.deleted",
        organisationId: record.organisation_id,
        projectId: record.project_id,
        actor,
        correlation: { artefact_id: record.id },
        payload: {
          artefact_id: record.id,
          kind: record.kind,
          ...(record.sha256 === null ? {} : { sha256: record.sha256 }),
          ...(record.size_bytes === null ? {} : { size_bytes: record.size_bytes }),
          bytes_removed: outcome.bytesRemoved,
          ...(reason === undefined ? {} : { reason }),
        },
      }),
      async (client) => {
        const updated = await client.query(
          `UPDATE artefacts
              SET deleted_at = now(), deleted_reason = $2
            WHERE id = $1 AND deleted_at IS NULL
            RETURNING ${SELECT_COLUMNS}`,
          [record.id, reason ?? null],
        );
        const row = updated.rows[0] as Record<string, unknown> | undefined;
        if (row === undefined) throw notFound("The artefact");
        let bytesRemoved = false;
        if (record.storage_key !== null) {
          const shared = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM artefacts
              WHERE storage_key = $1 AND deleted_at IS NULL AND id <> $2`,
            [record.storage_key, record.id],
          );
          bytesRemoved = shared.rows[0]?.count === "0";
        }
        return { record: toRecord(row), bytesRemoved };
      },
      this.#publisher,
    );

    if (result.bytesRemoved && record.storage_key !== null) {
      await this.#store.delete(record.storage_key).catch(() => undefined);
    }
    return result;
  }

  /**
   * The durable thumbnail job (`docs/ARCHITECTURE.md` §4.8).
   *
   * Every outcome is recorded on the source artefact and evented, including the
   * ones that produce no thumbnail: `docs/UX_FLOWS.md` §18 requires a viewer to
   * be able to say which of not-yet, not-possible and failed applies, and a job
   * that only wrote a row on success would leave the other two
   * indistinguishable.
   *
   * A source this build cannot decode is `unsupported`, which is terminal. A
   * transient failure is thrown, so the runner's backoff retries it.
   */
  async runThumbnailJob(
    artefactId: string,
    client: PoolClient,
  ): Promise<{ readonly state: ThumbnailState; readonly thumbnailId: string | null }> {
    const record = await this.getInternal(artefactId);
    if (
      record === null ||
      record.deleted_at !== null ||
      record.state !== "available" ||
      record.storage_key === null
    ) {
      // The artefact went away or never became evidence between the enqueue and
      // the run. There is nothing to do, and nothing to record against a row
      // that is not there.
      return { state: "not_requested", thumbnailId: null };
    }

    const finish = async (
      state: ThumbnailState,
      thumbnailId: string | null,
      detail?: { readonly reason?: string; readonly width?: number; readonly height?: number },
    ): Promise<{ state: ThumbnailState; thumbnailId: string | null }> => {
      await client.query(
        "UPDATE artefacts SET thumbnail_state = $2, thumbnail_artefact_id = $3 WHERE id = $1",
        [record.id, state, thumbnailId],
      );
      await appendEvent(client, {
        type: "artefact.thumbnail_generated",
        organisationId: record.organisation_id,
        projectId: record.project_id,
        actor: { type: "system", display: "job runner" },
        correlation: { artefact_id: record.id },
        payload: {
          artefact_id: record.id,
          state,
          ...(thumbnailId === null ? {} : { thumbnail_artefact_id: thumbnailId }),
          ...(detail?.width === undefined || detail.height === undefined
            ? {}
            : { content_rectangle: { width_px: detail.width, height_px: detail.height } }),
          ...(detail?.reason === undefined ? {} : { reason: detail.reason }),
        },
      });
      return { state, thumbnailId };
    };

    // A transient store fault is thrown so the runner retries it; only a source
    // this build cannot decode is terminal.
    const bytes = await this.#store.get(record.storage_key);

    let rendered;
    try {
      rendered = renderThumbnail(record.content_type, bytes);
    } catch (error) {
      if (error instanceof UnsupportedImageError) {
        return await finish("unsupported", null, { reason: error.message });
      }
      throw error;
    }
    if (rendered === null) {
      return await finish("unsupported", null, {
        reason: `this build generates thumbnails for image/png only, and the source is ${record.content_type}`,
      });
    }

    // The thumbnail is a separate artefact with its own digest and its own
    // verified metadata (ADR-0006); the original is never rewritten. It is
    // inserted `available` because the bytes were produced here and read back
    // here: the round trip below is the verification, and the row is written
    // only after it agrees.
    const stored = await this.#store.put(rendered.bytes);
    const verified = await this.#store.verify(stored.key);
    if (verified.sha256 !== stored.sha256 || verified.sizeBytes !== rendered.bytes.byteLength) {
      return await finish("failed", null, {
        reason: "the generated thumbnail did not read back as it was written",
      });
    }

    const thumbnailId = newId("art_");
    await client.query(
      `INSERT INTO artefacts (
          id, organisation_id, project_id, kind, state, content_type,
          declared_size_bytes, declared_sha256, size_bytes, sha256, storage_key,
          content_width_px, content_height_px, retention_class,
          browser_session_id, created_by_actor_type, created_by_actor_id,
          source_artefact_id, available_at, expires_at
       ) VALUES ($1, $2, $3, 'thumbnail', 'available', 'image/png',
                 $4, $5, $4, $5, $6, $7, $8, $9, $10, 'system', NULL, $11, now(), $12)`,
      [
        thumbnailId,
        record.organisation_id,
        record.project_id,
        rendered.bytes.byteLength,
        stored.sha256,
        stored.key,
        rendered.width,
        rendered.height,
        record.retention_class,
        record.browser_session_id,
        record.id,
        this.#expiryFor(record.retention_class),
      ],
    );
    await appendEvent(client, {
      type: "artefact.upload_completed",
      organisationId: record.organisation_id,
      projectId: record.project_id,
      actor: { type: "system", display: "job runner" },
      correlation: { artefact_id: thumbnailId },
      payload: {
        artefact_id: thumbnailId,
        kind: "thumbnail",
        sha256: stored.sha256,
        size_bytes: rendered.bytes.byteLength,
        storage_key: stored.key,
        redaction_state: "not_applied",
        content_rectangle: { width_px: rendered.width, height_px: rendered.height },
      },
    });
    return await finish("generated", thumbnailId, {
      width: rendered.width,
      height: rendered.height,
    });
  }

  /**
   * Artefact-store figures for `reviewplane status`
   * (`docs/OPERATIONS.md` §3, §11).
   *
   * The totals come from PostgreSQL rather than from the driver, because
   * metadata is authoritative for availability (ADR-0012) and a driver total
   * would also count objects belonging to deleted artefacts. Each
   * content-addressed key is counted once: two artefacts with identical bytes
   * are one stored object, so summing per artefact would overstate what an
   * operator has to back up.
   */
  async storeStatus(): Promise<ArtefactStoreStatus> {
    let available = true;
    let detail: string | undefined;
    try {
      await this.#store.probe();
    } catch (error) {
      available = false;
      detail = error instanceof Error ? error.message : String(error);
    }
    const rows = await this.#pool.query<{
      artefact_count: string;
      stored_bytes: string;
      pending_bytes: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM artefacts
           WHERE state = 'available' AND deleted_at IS NULL) AS artefact_count,
         (SELECT coalesce(sum(size_bytes), 0)::text FROM (
             SELECT DISTINCT ON (storage_key) storage_key, size_bytes
               FROM artefacts
              WHERE state = 'available' AND deleted_at IS NULL AND storage_key IS NOT NULL
           ) AS distinct_objects) AS stored_bytes,
         (SELECT coalesce(sum(declared_size_bytes), 0)::text FROM artefacts
           WHERE state IN ('pending', 'uploaded') AND deleted_at IS NULL) AS pending_bytes`,
    );
    const row = rows.rows[0];
    return {
      driver: this.#store.driver,
      available,
      ...(detail === undefined ? {} : { detail }),
      artefact_count: Number(row?.artefact_count ?? 0),
      stored_bytes: Number(row?.stored_bytes ?? 0),
      pending_bytes: Number(row?.pending_bytes ?? 0),
    };
  }
}

/**
 * The refusal an unreachable store produces.
 *
 * Two decisions here, both of which the first version of this function got
 * wrong.
 *
 * **The code says what happened.** `ARTEFACT_STORE_UNAVAILABLE`, not
 * `ARTEFACT_UPLOAD_INCOMPLETE`: an artefact whose upload completed and whose
 * digest was verified is complete, and telling an operator otherwise sends them
 * to look at an uploader that did nothing wrong. The resolution is to retry,
 * which is what a 503 says.
 *
 * **The driver's own words never reach the caller.** A filesystem error names
 * an absolute path on the server; an S3 error names the bucket endpoint and
 * carries a fragment of the service's XML. `docs/SECURITY.md` §18 requires a
 * stable code rather than free text exactly so that a failure is diagnosable
 * without a response carrying deployment data, and an agent session or a
 * browser worker reaches this path. The detail travels as the `diagnostic`,
 * which the error hook logs and never renders.
 */
function storeUnavailable(error: unknown, message: string): ApiError {
  return new ApiError(
    "ARTEFACT_STORE_UNAVAILABLE",
    message,
    { reason: "artefact_store_unavailable", retryable: true },
    undefined,
    error instanceof ArtefactStoreError ? error.message : String(error),
  );
}

/** How the bytes of this artefact are served (`docs/SECURITY.md` §13). */
export function dispositionOf(record: ArtefactRecord): ArtefactDisposition {
  return dispositionFor(record.content_type);
}

/** True for an artefact whose bytes a browser would execute if it rendered them. */
export function artefactIsActiveContent(record: ArtefactRecord): boolean {
  return isActiveContentType(record.content_type);
}
