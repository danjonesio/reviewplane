/**
 * Artefact upload: intent, content, completion (`docs/API.md` section 15).
 *
 * The rule the whole flow exists to enforce is one line of
 * `docs/ARCHITECTURE.md` section 14: "Never record an artefact as available
 * before integrity verification." So:
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
 */

import { randomBytes } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { inTransaction } from "../../db/pool.ts";
import { appendEvent, type ActorType, type EventActor } from "../../events/append.ts";
import { ApiError, notFound } from "../../errors.ts";
import { newId } from "../../ids.ts";
import { isSafeFilenameLabel, measureImage, sniffContentType } from "./image.ts";
import { keyForDigest, type ArtefactStore } from "./store.ts";

export type ArtefactState = "pending" | "uploaded" | "available" | "failed";

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
  readonly browser_session_id: string | null;
  readonly created_at: string;
  readonly available_at: string | null;
}

export interface UploadIntentInput {
  readonly organisationId: string;
  readonly projectId: string;
  readonly kind: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly retentionClass: string;
  readonly browserSessionId?: string;
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
}

/** `docs/SECURITY.md` section 13: short-lived. Two minutes is a page load. */
export const ARTEFACT_GRANT_TTL_SECONDS = 120;

const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg"]);
const IMAGE_CONTENT_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg"]);

function toRecord(row: Record<string, unknown>): ArtefactRecord {
  return {
    id: row["id"] as string,
    organisation_id: row["organisation_id"] as string,
    project_id: row["project_id"] as string,
    kind: row["kind"] as string,
    state: row["state"] as ArtefactState,
    content_type: row["content_type"] as string,
    declared_size_bytes: Number(row["declared_size_bytes"]),
    declared_sha256: row["declared_sha256"] as string,
    size_bytes: row["size_bytes"] === null ? null : Number(row["size_bytes"]),
    sha256: (row["sha256"] as string | null) ?? null,
    storage_key: (row["storage_key"] as string | null) ?? null,
    content_width_px:
      row["content_width_px"] === null || row["content_width_px"] === undefined
        ? null
        : Number(row["content_width_px"]),
    content_height_px:
      row["content_height_px"] === null || row["content_height_px"] === undefined
        ? null
        : Number(row["content_height_px"]),
    filename_label: (row["filename_label"] as string | null) ?? null,
    redaction_state: row["redaction_state"] as string,
    retention_class: row["retention_class"] as string,
    browser_session_id: (row["browser_session_id"] as string | null) ?? null,
    created_at: (row["created_at"] as Date).toISOString(),
    available_at:
      row["available_at"] === null ? null : (row["available_at"] as Date).toISOString(),
  };
}

export class ArtefactService {
  readonly #pool: Pool;
  readonly #store: ArtefactStore;
  readonly #maxBytes: number;

  constructor(pool: Pool, store: ArtefactStore, maxBytes: number) {
    this.#pool = pool;
    this.#store = store;
    this.#maxBytes = maxBytes;
  }

  /** Step 1: record the intent and the values that will be verified. */
  async createIntent(input: UploadIntentInput): Promise<ArtefactRecord> {
    if (!ALLOWED_CONTENT_TYPES.has(input.contentType)) {
      throw new ApiError(
        "UNSUPPORTED_CAPABILITY",
        `Stage 0 stores ${[...ALLOWED_CONTENT_TYPES].join(", ")} artefacts only.`,
      );
    }
    if (input.sizeBytes <= 0 || input.sizeBytes > this.#maxBytes) {
      throw new ApiError(
        "POLICY_DENIED",
        `An artefact must be between 1 and ${String(this.#maxBytes)} bytes.`,
      );
    }
    if (!/^[0-9a-f]{64}$/u.test(input.sha256)) {
      throw new ApiError("UNSUPPORTED_CAPABILITY", "sha256 must be 64 lowercase hexadecimal characters.");
    }
    if (input.filenameLabel !== undefined && !isSafeFilenameLabel(input.filenameLabel)) {
      // The key is content-addressed, so this value never reaches a path. It
      // is refused anyway (`docs/TESTING.md` section 10, path traversal in
      // filename metadata).
      throw new ApiError(
        "UNSUPPORTED_CAPABILITY",
        "filename is display metadata: it must be a plain name, not a path.",
        { field: "filename" },
      );
    }

    return inTransaction(this.#pool, async (client) => {
      const id = newId("art_");
      const inserted = await client.query(
        `INSERT INTO artefacts (
            id, organisation_id, project_id, kind, state, content_type,
            declared_size_bytes, declared_sha256, retention_class,
            browser_session_id, created_by_actor_type, created_by_actor_id,
            filename_label
         ) VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          id,
          input.organisationId,
          input.projectId,
          input.kind,
          input.contentType,
          input.sizeBytes,
          input.sha256,
          input.retentionClass,
          input.browserSessionId ?? null,
          input.actor.type,
          input.actor.id ?? null,
          input.filenameLabel ?? null,
        ],
      );
      await appendEvent(client, {
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
      });
      return toRecord(inserted.rows[0] as Record<string, unknown>);
    });
  }

  /** Step 2 and 3: store the bytes. The row stays unavailable until verified. */
  async storeContent(artefactId: string, bytes: Buffer): Promise<ArtefactRecord> {
    const existing = await this.get(artefactId);
    if (existing.state === "available") {
      throw new ApiError(
        "IDEMPOTENCY_CONFLICT",
        "This artefact has already been completed and cannot be rewritten.",
      );
    }
    if (bytes.byteLength > this.#maxBytes) {
      throw new ApiError("POLICY_DENIED", "The uploaded content exceeds the artefact size limit.");
    }

    // The declared content type is a claim; the leading bytes are evidence.
    // Refusing here means an SVG or an HTML document uploaded as an image
    // never becomes an artefact at all, so there is nothing for a viewer to be
    // persuaded to render as active content (`docs/SECURITY.md` section 13).
    const sniffed = sniffContentType(bytes);
    if (sniffed !== existing.content_type) {
      await this.#markFailed(
        existing,
        `The uploaded bytes are ${sniffed}, not the declared ${existing.content_type}.`,
        { type: "system", display: "artefact verification" },
      );
      throw new ApiError(
        "UNSUPPORTED_CAPABILITY",
        `The uploaded bytes are ${sniffed}, not the declared ${existing.content_type}.`,
        { field: "content_type" },
      );
    }

    const stored = await this.#store.put(bytes);
    await this.#pool.query(
      "UPDATE artefacts SET state = 'uploaded', storage_key = $2 WHERE id = $1",
      [artefactId, stored.key],
    );
    return this.get(artefactId);
  }

  /**
   * Step 4 and 5: verify the stored bytes against the declared and observed
   * values, then make the artefact available.
   */
  async complete(
    artefactId: string,
    observed: { sha256: string; sizeBytes?: number },
    actor: EventActor,
  ): Promise<ArtefactRecord> {
    const record = await this.get(artefactId);
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

    // The authoritative check: what is actually on disk.
    const stored = await this.#store.verify(record.storage_key).catch(() => null);
    if (stored === null) {
      return fail("The stored artefact could not be read back for verification.");
    }
    if (stored.sha256 !== record.declared_sha256) {
      return fail("The stored bytes do not match the declared digest.");
    }
    if (stored.sizeBytes !== record.declared_size_bytes) {
      return fail("The stored bytes do not match the declared size.");
    }
    if (record.storage_key !== keyForDigest(stored.sha256)) {
      return fail("The stored artefact is not filed under its content address.");
    }

    // The artefact content rectangle (`docs/DOMAIN_MODEL.md` section 16) is
    // measured from the bytes the server verified, never taken from the
    // uploader: it is the reference frame every annotation on this artefact is
    // normalised against, so an uploader that could choose it could move every
    // existing mark.
    const bytes = await this.#store.get(record.storage_key).catch(() => null);
    if (bytes === null) return fail("The stored artefact could not be read back for measurement.");
    const sniffed = sniffContentType(bytes);
    if (sniffed !== record.content_type) {
      return fail(`The stored bytes are ${sniffed}, not the declared ${record.content_type}.`);
    }
    let dimensions: { widthPx: number; heightPx: number } | null = null;
    if (IMAGE_CONTENT_TYPES.has(record.content_type)) {
      dimensions = measureImage(record.content_type, bytes);
      if (dimensions === null) {
        return fail("The stored image could not be measured, so it has no content rectangle.");
      }
    }

    return inTransaction(this.#pool, async (client) => {
      const updated = await client.query(
        `UPDATE artefacts
            SET state = 'available', sha256 = $2, size_bytes = $3, available_at = now(),
                content_width_px = $4, content_height_px = $5
          WHERE id = $1
          RETURNING *`,
        [
          artefactId,
          stored.sha256,
          stored.sizeBytes,
          dimensions?.widthPx ?? null,
          dimensions?.heightPx ?? null,
        ],
      );
      const contentRectangle =
        dimensions === null
          ? {}
          : {
              content_rectangle: { width_px: dimensions.widthPx, height_px: dimensions.heightPx },
            };
      await appendEvent(client, {
        type: "artefact.upload_completed",
        organisationId: record.organisation_id,
        projectId: record.project_id,
        actor,
        correlation: {
          artefact_id: artefactId,
          ...(record.browser_session_id === null
            ? {}
            : { browser_session_id: record.browser_session_id }),
        },
        payload: {
          artefact_id: artefactId,
          kind: record.kind,
          sha256: stored.sha256,
          size_bytes: stored.sizeBytes,
          storage_key: record.storage_key,
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
          correlation: {
            artefact_id: artefactId,
            ...(record.browser_session_id === null
              ? {}
              : { browser_session_id: record.browser_session_id }),
          },
          payload: {
            artefact_id: artefactId,
            sha256: stored.sha256,
            size_bytes: stored.sizeBytes,
            content_rectangle: { width_px: dimensions.widthPx, height_px: dimensions.heightPx },
          },
        });
      }
      return toRecord(updated.rows[0] as Record<string, unknown>);
    });
  }

  async #markFailed(record: ArtefactRecord, reason: string, actor: EventActor): Promise<void> {
    await inTransaction(this.#pool, async (client: PoolClient) => {
      await client.query("UPDATE artefacts SET state = 'failed' WHERE id = $1", [record.id]);
      await appendEvent(client, {
        type: "artefact.upload_failed",
        organisationId: record.organisation_id,
        projectId: record.project_id,
        actor,
        correlation: { artefact_id: record.id },
        payload: { artefact_id: record.id, reason, code: "ARTEFACT_UPLOAD_INCOMPLETE" },
      });
    });
  }

  async get(artefactId: string): Promise<ArtefactRecord> {
    const found = await this.#pool.query("SELECT * FROM artefacts WHERE id = $1", [artefactId]);
    const row = found.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) throw notFound("The artefact");
    return toRecord(row);
  }

  /** Content is served only for a verified artefact. */
  async readContent(artefactId: string): Promise<{ record: ArtefactRecord; bytes: Buffer }> {
    const record = await this.get(artefactId);
    if (record.state !== "available" || record.storage_key === null) {
      throw new ApiError(
        "ARTEFACT_UPLOAD_INCOMPLETE",
        "This artefact has not been verified and is not available.",
      );
    }
    return { record, bytes: await this.#store.get(record.storage_key) };
  }

  /**
   * Mints a short-lived grant for one artefact (ADR-0019).
   *
   * The grant is bound to a subject, so possession of the identifier is not
   * enough: the caller must still authenticate as that subject when it
   * presents it. That is what lets the identifier travel in a URL — which an
   * `<img>` element requires — while `docs/SECURITY.md` section 18's rule
   * against credentials in URLs still holds.
   *
   * Reading evidence is an audited access (`docs/SECURITY.md` section 16), so
   * minting a grant records an event.
   */
  async grantAccess(input: {
    readonly artefactId: string;
    readonly subjectType: ActorType;
    readonly subjectId: string;
    readonly actor: EventActor;
    readonly ttlSeconds?: number;
  }): Promise<ArtefactGrant> {
    const record = await this.get(input.artefactId);
    if (record.state !== "available") {
      throw new ApiError(
        "ARTEFACT_UPLOAD_INCOMPLETE",
        "This artefact has not been verified and is not available.",
      );
    }
    const id = `agr_${randomBytes(24).toString("base64url")}`;
    const expiresAt = new Date(
      Date.now() + (input.ttlSeconds ?? ARTEFACT_GRANT_TTL_SECONDS) * 1000,
    );
    return inTransaction(this.#pool, async (client) => {
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
      await appendEvent(client, {
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
      });
      return {
        id,
        artefact_id: record.id,
        organisation_id: record.organisation_id,
        project_id: record.project_id,
        subject_type: input.subjectType,
        subject_id: input.subjectId,
        expires_at: expiresAt.toISOString(),
      };
    });
  }

  /**
   * Resolves a grant. Returns null for anything that is not live, so the
   * caller reports one refusal for an unknown, expired or revoked grant and
   * does not tell an unauthenticated client which it was
   * (`docs/SECURITY.md` section 5).
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
}
