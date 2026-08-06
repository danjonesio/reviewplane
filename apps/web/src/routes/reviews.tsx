/**
 * The review list, and the search of `docs/UX_FLOWS.md` section 16.
 *
 * A review is the durable object (ADR-0004), so this page is the one that
 * survives every browser session: it lists reviews by the name a human gave
 * them and the branch and commit they were captured from, which is what makes a
 * review judgeable against a later state of the code.
 *
 * **Filtering happens in the control plane, not here.** The terms go on the
 * query string and the server applies them in the same `WHERE` clause as the
 * tenancy terms. A page that fetched everything and filtered in the browser
 * would work at this scale and would be a page that has to read every review of
 * every project in order to show one — which is a privacy shape as much as a
 * performance one.
 *
 * Search returns durable reviews and never transient session frames, which is
 * section 16's other requirement and is a property of the endpoint rather than
 * of this page.
 */

import { Link, createRoute } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";

import { api, type Review, type ReviewFilters } from "../api/client.ts";
import { useSession } from "../auth/session.ts";
import { StatusBadge, type Tone } from "../components/StatusBadge.tsx";
import { REVIEW_STATUS_WORDS } from "./review.tsx";
import { rootRoute } from "./root.tsx";

const FIELD =
  "w-full rounded border border-slate-400 bg-white px-3 py-2 text-base dark:border-slate-600 dark:bg-slate-900";
const HINT = "text-xs text-slate-600 dark:text-slate-400";
const CARD =
  "rounded border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900";

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

const STATUSES: readonly string[] = Object.keys(TONE_FOR_REVIEW);
const SEVERITIES: readonly string[] = ["critical", "high", "medium", "low", "suggestion"];

function ReviewRow({ review }: { readonly review: Review }): ReactElement {
  return (
    <li
      data-review={review.id}
      className={CARD}
    >
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
        <StatusBadge
          tone={TONE_FOR_REVIEW[review.status] ?? "neutral"}
          label={review.status}
          detail={REVIEW_STATUS_WORDS[review.status] ?? review.status}
        />
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
          className="inline-block rounded border border-slate-400 px-3 py-2 text-sm font-medium dark:border-slate-600"
        >
          Open review
        </Link>
      </p>
    </li>
  );
}

function Reviews(): ReactElement {
  const session = useSession();
  const [filters, setFilters] = useState<ReviewFilters>({});
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.projects(),
    enabled: session.data !== undefined,
  });
  // There is no cross-project review endpoint, and there deliberately is not:
  // a review resolves inside one project. The fan-out is per project the
  // session can already see, so nothing here widens what a session may read.
  const reviewQueries = useQueries({
    queries: (projects.data ?? []).map((project) => ({
      queryKey: ["reviews", project.id, filters],
      queryFn: () => api.searchReviews(project.id, filters),
    })),
  });

  if (session.isPending) return <p role="status">Loading.</p>;

  const reviews = reviewQueries
    .flatMap((query) => query.data ?? [])
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  const searching = reviewQueries.some((query) => query.isFetching);
  const filtered = Object.values(filters).some(
    (value) => value !== undefined && value !== "",
  );

  const set = (change: Partial<ReviewFilters>): void => {
    setFilters((current) => ({ ...current, ...change }));
  };

  return (
    <section aria-labelledby="reviews-heading">
      <h1 id="reviews-heading" className="text-xl font-semibold">
        Reviews
      </h1>
      <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
        A review outlives the browser session it was captured from. Findings keep their screenshot,
        viewport and commit, so they can be reproduced later.
      </p>

      <search className="mt-4">
        <h2 id="review-search-heading" className="text-base font-semibold">
          Find a review
        </h2>
        <p className={`mt-1 ${HINT}`}>
          The text term matches a review&rsquo;s name, slug or description, and the title or
          description of any finding in it.
        </p>
        <div
          role="group"
          aria-labelledby="review-search-heading"
          className="mt-3 grid gap-3 sm:grid-cols-2"
        >
          <div className="flex flex-col gap-1">
            <label htmlFor="review-search-q" className="text-sm font-medium">
              Name, slug or finding text
            </label>
            <input
              id="review-search-q"
              data-review-filter="q"
              type="search"
              value={filters.q ?? ""}
              onChange={(event) => {
                set({ q: event.target.value });
              }}
              className={FIELD}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="review-search-status" className="text-sm font-medium">
              Status
            </label>
            <select
              id="review-search-status"
              data-review-filter="status"
              value={filters.status ?? ""}
              onChange={(event) => {
                set({ status: event.target.value });
              }}
              className={FIELD}
            >
              <option value="">Any status</option>
              {STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="review-search-severity" className="text-sm font-medium">
              Contains a finding of severity
            </label>
            <select
              id="review-search-severity"
              data-review-filter="severity"
              value={filters.severity ?? ""}
              onChange={(event) => {
                set({ severity: event.target.value });
              }}
              className={FIELD}
            >
              <option value="">Any severity</option>
              {SEVERITIES.map((severity) => (
                <option key={severity} value={severity}>
                  {severity}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="review-search-branch" className="text-sm font-medium">
              Captured branch
            </label>
            <input
              id="review-search-branch"
              data-review-filter="branch"
              type="text"
              value={filters.branch ?? ""}
              onChange={(event) => {
                set({ branch: event.target.value });
              }}
              className={FIELD}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="review-search-commit" className="text-sm font-medium">
              Captured commit starts with
            </label>
            <input
              id="review-search-commit"
              data-review-filter="commit"
              type="text"
              value={filters.commit ?? ""}
              onChange={(event) => {
                set({ commit: event.target.value });
              }}
              className={FIELD}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="review-search-since" className="text-sm font-medium">
              Created on or after
            </label>
            <input
              id="review-search-since"
              data-review-filter="created_since"
              type="date"
              value={filters.createdSince ?? ""}
              onChange={(event) => {
                set({ createdSince: event.target.value });
              }}
              className={FIELD}
            />
          </div>
        </div>
        <p className="mt-3">
          <button
            type="button"
            data-review-filter-clear="true"
            onClick={() => {
              setFilters({});
            }}
            className="rounded border border-slate-400 px-3 py-2 text-sm font-medium dark:border-slate-600"
          >
            Clear filters
          </button>
        </p>
      </search>

      <p className="mt-4 text-sm" role="status" aria-live="polite" data-review-count={reviews.length}>
        {searching
          ? "Searching."
          : `${String(reviews.length)} review${reviews.length === 1 ? "" : "s"}${
              filtered ? " match these filters" : ""
            }.`}
      </p>

      {reviews.length === 0 ? (
        <div className={`mt-3 ${CARD}`} data-reviews-empty="true">
          <h2 className="text-base font-semibold">
            {filtered ? "No review matches these filters" : "No review has been created yet"}
          </h2>
          <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
            {filtered
              ? "Clear the filters to see every review this session can read."
              : "A review appears here once a human annotates a live session and names the result."}
          </p>
        </div>
      ) : (
        <ul className="mt-3 flex flex-col gap-4">
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
