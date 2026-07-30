/**
 * The review list.
 *
 * A review is the durable object (ADR-0004), so this page is the one that
 * survives every browser session: it lists reviews by the name a human gave
 * them and the branch and commit they were captured from, which is what makes
 * a review judgeable against a later state of the code.
 */

import { Link, createRoute } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { api, type Review } from "../api/client.ts";
import { StatusBadge, type Tone } from "../components/StatusBadge.tsx";
import { rootRoute } from "./root.tsx";

const TONE_FOR_REVIEW: Readonly<Record<string, Tone>> = {
  DRAFT: "neutral",
  READY: "waiting",
  ASSIGNED: "waiting",
  IN_PROGRESS: "live",
  AWAITING_HUMAN_REVIEW: "warning",
  CHANGES_REQUESTED: "warning",
  ACCEPTED: "live",
  CANCELLED: "neutral",
  ARCHIVED: "neutral",
};

function ReviewRow({ review }: { readonly review: Review }): ReactElement {
  return (
    <li className="rounded border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold">
            <Link
              to="/reviews/$reviewId"
              params={{ reviewId: review.id }}
              className="underline-offset-4 hover:underline"
            >
              {review.title}
            </Link>
          </h3>
          <p className="mt-1 break-all font-mono text-xs text-slate-600 dark:text-slate-400">
            {review.slug}
          </p>
        </div>
        <StatusBadge tone={TONE_FOR_REVIEW[review.status] ?? "neutral"} label={review.status} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Branch</dt>
          <dd className="truncate font-mono">{review.captured_branch}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Commit</dt>
          <dd className="truncate font-mono">{review.captured_commit.slice(0, 12)}</dd>
        </div>
        <div>
          <dt className="text-slate-600 dark:text-slate-400">Findings</dt>
          <dd>{review.finding_count ?? 0}</dd>
        </div>
      </dl>
      <p className="mt-3">
        <Link
          to="/reviews/$reviewId"
          params={{ reviewId: review.id }}
          className="inline-block rounded border border-slate-400 px-3 py-2 text-sm font-medium"
        >
          Open review
        </Link>
      </p>
    </li>
  );
}

function Reviews(): ReactElement {
  const viewer = useQuery({ queryKey: ["viewer"], queryFn: () => api.currentViewer(), retry: false });
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.projects(),
    enabled: viewer.data !== undefined,
  });
  const reviewQueries = useQueries({
    queries: (projects.data ?? []).map((project) => ({
      queryKey: ["reviews", project.id],
      queryFn: () => api.reviews(project.id),
    })),
  });

  if (viewer.isPending) return <p role="status">Loading.</p>;
  if (viewer.isError) {
    return (
      <section aria-labelledby="reviews-heading">
        <h1 id="reviews-heading" className="text-xl font-semibold">
          Reviews
        </h1>
        <p className="mt-2 text-sm">Sign in from the live sessions page to read reviews.</p>
      </section>
    );
  }

  const reviews = reviewQueries
    .flatMap((query) => query.data ?? [])
    .sort((left, right) => right.created_at.localeCompare(left.created_at));

  return (
    <section aria-labelledby="reviews-heading">
      <h1 id="reviews-heading" className="text-xl font-semibold">
        Reviews
      </h1>
      <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
        A review outlives the browser session it was captured from. Findings keep their
        screenshot, viewport and commit, so they can be reproduced later.
      </p>

      {reviews.length === 0 ? (
        <div className="mt-6 rounded border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
          <h2 className="text-base font-semibold">No review has been created yet</h2>
          <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
            A review appears here once a human annotates a live session and names the result.
          </p>
        </div>
      ) : (
        <ul className="mt-6 flex flex-col gap-4">
          {reviews.map((review) => (
            <ReviewRow key={review.id} review={review} />
          ))}
        </ul>
      )}
    </section>
  );
}

export const reviewsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reviews",
  component: Reviews,
});
