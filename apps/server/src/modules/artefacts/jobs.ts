/**
 * The artefact module's durable background work (`docs/ARCHITECTURE.md` §4.8).
 *
 * One handler so far: thumbnail generation. It is a job rather than something
 * done inline on completion because the upload path must not wait on image
 * work — a screenshot is evidence the moment it is verified, and a thumbnail is
 * a convenience — and because a failed thumbnail must not fail the upload that
 * produced it.
 *
 * The runner hands the handler a client inside a transaction, so the thumbnail
 * artefact, the state written on its source and both events commit together or
 * not at all.
 */

import type { JobHandler, JobKind } from "../../jobs/runner.ts";
import type { ArtefactService } from "./service.ts";

export function artefactJobHandlers(
  artefacts: ArtefactService,
): Readonly<Partial<Record<JobKind, JobHandler>>> {
  return {
    artefact_thumbnail: async (job, client) => {
      const artefactId = job.payload["artefact_id"];
      if (typeof artefactId !== "string") {
        throw new Error("artefact_thumbnail: the job payload names no artefact");
      }
      await artefacts.runThumbnailJob(artefactId, client);
    },
  };
}
