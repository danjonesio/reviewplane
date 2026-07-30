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

import type { Pool, PoolClient } from "pg";

import { inTransaction } from "../../db/pool.ts";
import { appendEvent, type EventActor } from "../../events.ts";
import { ApiError, notFound } from "../../errors.ts";
import { newId } from "../../ids.ts";
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
  readonly actor: EventActor;
}

const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set(["image/png"]);

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

    return inTransaction(this.#pool, async (client) => {
      const id = newId("art_");
      const inserted = await client.query(
        `INSERT INTO artefacts (
            id, organisation_id, project_id, kind, state, content_type,
            declared_size_bytes, declared_sha256, retention_class,
            browser_session_id, created_by_actor_type, created_by_actor_id
         ) VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, $11)
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
          kind: input.kind,
          declared_size_bytes: input.sizeBytes,
          declared_sha256: input.sha256,
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

    return inTransaction(this.#pool, async (client) => {
      const updated = await client.query(
        `UPDATE artefacts
            SET state = 'available', sha256 = $2, size_bytes = $3, available_at = now()
          WHERE id = $1
          RETURNING *`,
        [artefactId, stored.sha256, stored.sizeBytes],
      );
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
        payload: { sha256: stored.sha256, size_bytes: stored.sizeBytes, kind: record.kind },
      });
      if (record.kind === "screenshot") {
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
          payload: { sha256: stored.sha256, size_bytes: stored.sizeBytes },
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
        payload: { reason },
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
}
