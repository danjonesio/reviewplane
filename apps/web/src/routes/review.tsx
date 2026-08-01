/**
 * One review and its findings.
 *
 * Each finding is shown with the captured context that makes it reproducible
 * (`docs/UX_FLOWS.md` section 9) and with its original screenshot under an
 * annotation overlay. The context is not decoration: a reader deciding whether
 * a finding is still real needs the URL, the viewport, the scroll position and
 * the commit as much as the picture.
 *
 * Nothing here can accept or reopen anything. That is Stage 1
 * (`docs/UX_FLOWS.md` section 13), and the server would refuse an agent
 * attempting it in any case.
 */

import { Link, createRoute, useParams } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { api, type Annotation, type Finding } from "../api/client.ts";
import { AgentDeliveryPanel } from "../components/AgentDelivery.tsx";
import { ArtefactViewer } from "../components/ArtefactViewer.tsx";
import { StatusBadge, type Tone } from "../components/StatusBadge.tsx";
import { rootRoute } from "./root.tsx";

const TONE_FOR_SEVERITY: Readonly<Record<string, Tone>> = {
  critical: "failed",
  high: "warning",
  medium: "waiting",
  low: "neutral",
  suggestion: "neutral",
};

function FindingPanel({
  finding,
  annotations,
}: {
  readonly finding: Finding;
  readonly annotations: readonly Annotation[];
}): ReactElement {
  // The before-and-after comparison of `docs/UX_FLOWS.md` section 17 is a pair
  // of artefacts recorded on a verification submission
  // (`docs/DOMAIN_MODEL.md` section 19). There is none until an agent submits
  // one, and the viewer says so rather than offering a control that compares
  // nothing.
  const verification = useQuery({
    queryKey: ["finding-verification", finding.id],
    queryFn: () => api.findingVerification(finding.id),
  });
  // Absence arrives as `null` from the API and as an absent member in the
  // schema, and both mean nobody has claimed this finding.
  const claimedBy = finding.claimed_by ?? null;
  return (
    <li
      data-finding={finding.id}
      className="rounded border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold">{finding.title}</h3>
          <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">{finding.description}</p>
        </div>
        <div className="flex gap-2">
          <StatusBadge
            tone={TONE_FOR_SEVERITY[finding.severity] ?? "neutral"}
            label={finding.severity}
          />
          <StatusBadge tone="neutral" label={finding.status} />
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
        <div className="col-span-2 min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">URL</dt>
          {/* Page-derived, so it is text and never a link the page controls. */}
          <dd className="truncate font-mono">{finding.url}</dd>
        </div>
        <div>
          <dt className="text-slate-600 dark:text-slate-400">Viewport</dt>
          <dd className="font-mono">
            {finding.viewport.width}x{finding.viewport.height} @{" "}
            {finding.viewport.device_scale_factor}x
          </dd>
        </div>
        <div>
          <dt className="text-slate-600 dark:text-slate-400">Scroll</dt>
          <dd className="font-mono">
            {finding.scroll_position.x}, {finding.scroll_position.y}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Commit</dt>
          <dd className="truncate font-mono">{finding.captured_commit.slice(0, 12)}</dd>
        </div>
        <div>
          <dt className="text-slate-600 dark:text-slate-400">Reported by</dt>
          <dd>{finding.source === "human" ? "a human" : "an agent"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Worked by</dt>
          {/*
            Who holds the claim, as the actor the control plane recorded
            (`docs/UX_FLOWS.md` section 12). Nothing resolves an actor
            identifier to a name, so the identifier is what is shown.
          */}
          <dd className="break-all font-mono" data-finding-claim={finding.id}>
            {claimedBy === null
              ? "Nobody"
              : `${claimedBy.type}${claimedBy.id === undefined ? "" : ` ${claimedBy.id}`}`}
          </dd>
        </div>
      </dl>

      <div className="mt-4">
        <ArtefactViewer
          artefactId={finding.screenshot_artefact_id}
          annotations={annotations}
          compareArtefactId={verification.data?.after_artefact_id ?? null}
          captureScale={finding.viewport.device_scale_factor}
          caption={`Screenshot of ${finding.url} at ${String(finding.viewport.width)} by ${String(
            finding.viewport.height,
          )} CSS pixels, captured for the finding "${finding.title}".`}
        />
      </div>
    </li>
  );
}

function ReviewDetail(): ReactElement {
  const { reviewId } = useParams({ from: "/reviews/$reviewId" });
  const review = useQuery({ queryKey: ["review", reviewId], queryFn: () => api.review(reviewId) });
  const findings = useQuery({
    queryKey: ["findings", reviewId],
    queryFn: () => api.findings(reviewId),
  });
  const annotationQueries = useQueries({
    queries: (findings.data ?? []).map((finding) => ({
      queryKey: ["annotations", finding.id],
      queryFn: () => api.annotations(finding.id),
    })),
  });

  if (review.isPending) return <p role="status">Loading the review.</p>;
  if (review.isError) {
    return (
      <section aria-labelledby="review-heading">
        <h1 id="review-heading" className="text-xl font-semibold">
          This review could not be loaded
        </h1>
        <p className="mt-2 text-sm">
          It may belong to a project this session is not authorised for.{" "}
          <Link to="/reviews" className="underline">
            Back to reviews
          </Link>
          .
        </p>
      </section>
    );
  }

  const annotationsByFinding = new Map<string, readonly Annotation[]>();
  (findings.data ?? []).forEach((finding, index) => {
    annotationsByFinding.set(finding.id, annotationQueries[index]?.data ?? []);
  });

  return (
    <section aria-labelledby="review-heading">
      <p className="text-sm">
        <Link to="/reviews" className="underline underline-offset-4">
          Reviews
        </Link>
      </p>
      <h1 id="review-heading" className="mt-2 text-xl font-semibold">
        {review.data.title}
      </h1>
      <p className="mt-1 font-mono text-xs text-slate-600 dark:text-slate-400">
        {review.data.slug}
      </p>
      {review.data.description === undefined ? null : (
        <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">{review.data.description}</p>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-slate-600 dark:text-slate-400">Status</dt>
          <dd>{review.data.status}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Branch</dt>
          <dd className="truncate font-mono">{review.data.captured_branch}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Commit</dt>
          <dd className="truncate font-mono">{review.data.captured_commit.slice(0, 12)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Captured from</dt>
          <dd className="truncate font-mono">{review.data.source_browser_session_id}</dd>
        </div>
      </dl>

      <AgentDeliveryPanel review={review.data} />

      <h2 className="mt-6 text-lg font-semibold">Findings</h2>
      {findings.isPending ? <p role="status">Loading findings.</p> : null}
      {findings.data !== undefined && findings.data.length === 0 ? (
        <p className="mt-2 text-sm">This review has no findings yet.</p>
      ) : null}
      <ul className="mt-3 flex flex-col gap-6">
        {(findings.data ?? []).map((finding) => (
          <FindingPanel
            key={finding.id}
            finding={finding}
            annotations={annotationsByFinding.get(finding.id) ?? []}
          />
        ))}
      </ul>
    </section>
  );
}

export const reviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reviews/$reviewId",
  component: ReviewDetail,
});
