/**
 * The review-export job (`docs/API.md` section 12, `docs/REVIEW_FORMAT.md`).
 *
 * Exporting a review is background work by design. A review with a hundred
 * findings, their comments and an artefact manifest is not something to build
 * while a caller holds a socket open, and a durable job survives the
 * control-plane restart that a long request would not
 * (`docs/ARCHITECTURE.md` section 4.8).
 *
 * Two properties are what make a retry safe.
 *
 * **The whole attempt is one transaction.** `JobRunner` wraps the handler in
 * `inTransaction`, so the artefact row, the export row and both artefact events
 * commit together or not at all. An attempt that dies half way leaves the
 * export `pending` and no artefact — never a `ready` export pointing at bytes
 * that were never written, which is what `docs/TESTING.md` section 11 asks of a
 * failed export run.
 *
 * **The stored object is content-addressed.** A retry that produces the same
 * document writes the same key, so the store holds one copy however many
 * attempts it took. A retry that produces a *different* document — because a
 * finding moved between attempts — writes a new key and the export names the
 * one that succeeded. Either way there is no partial artefact.
 */

import { Buffer } from "node:buffer";

import type { PoolClient } from "../../db/pool.ts";
import type { EventActor } from "../../events/append.ts";
import type { JobHandler, JobRecord } from "../../jobs/runner.ts";
import type { ArtefactService } from "../artefacts/service.ts";
import type { ReviewService } from "./service.ts";

/** Media type of the portable review format (`docs/REVIEW_FORMAT.md` section 2). */
export const REVIEW_EXPORT_CONTENT_TYPE = "application/vnd.reviewplane.review+json;version=1";

/** The actor an export is attributed to when the job runs it. */
const EXPORTER: EventActor = { type: "system", display: "review export" };

export interface ReviewExportJobOptions {
  readonly reviews: ReviewService;
  readonly artefacts: ArtefactService;
}

/**
 * Builds the handler the job runner registers for `review_export`.
 *
 * A job whose payload names an export that has gone — the review was archived
 * and purged, say — is a completed attempt rather than a failure to retry:
 * there is nothing to produce and nothing a retry would change.
 */
export function reviewExportHandler(options: ReviewExportJobOptions): JobHandler {
  return async (job: JobRecord, client: PoolClient): Promise<void> => {
    const exportId = job.payload["review_export_id"];
    const reviewId = job.payload["review_id"];
    if (typeof exportId !== "string" || typeof reviewId !== "string") {
      throw new Error("review_export job payload must name review_export_id and review_id");
    }
    if (job.projectId === null) {
      throw new Error("a review_export job must be scoped to a project");
    }

    const claimed = await client.query<{ id: string }>(
      `SELECT id FROM review_exports
        WHERE id = $1 AND organisation_id = $2 AND project_id = $3 AND status = 'pending'
        FOR UPDATE`,
      [exportId, job.organisationId, job.projectId],
    );
    if (claimed.rows[0] === undefined) return;

    const scope = { organisationId: job.organisationId, projectId: job.projectId };
    const document = await options.reviews.buildExportDocument(scope, reviewId);
    // Two spaces, sorted by nothing: the document is read by people as well as
    // by importers, and `docs/REVIEW_FORMAT.md` section 3 fixes the member
    // order by listing it rather than by sorting.
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");

    const artefact = await options.artefacts.storeGenerated(client, {
      organisationId: job.organisationId,
      projectId: job.projectId,
      kind: "review_export",
      contentType: REVIEW_EXPORT_CONTENT_TYPE,
      retentionClass: "review_export",
      bytes,
      filenameLabel: `${String((document["review"] as { slug?: string }).slug ?? "review")}.review.json`,
      actor: EXPORTER,
    });

    await options.reviews.completeExport(
      exportId,
      {
        artefactId: artefact.id,
        sha256: artefact.sha256 ?? "",
        sizeBytes: artefact.size_bytes ?? bytes.byteLength,
      },
      client,
    );
  };
}
