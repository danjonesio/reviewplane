/**
 * One review, its findings and the review-level decision.
 *
 * Each finding is summarised with the captured context that makes it
 * reproducible (`docs/UX_FLOWS.md` section 9) and its status in words. The
 * evidence comparison and the per-finding decision are one level down, on the
 * finding page: a review with several findings, each carrying a before-and-after
 * pair, is not a page anybody can read at 390 pixels, and the decision deserves
 * a URL that can be linked to.
 *
 * The review-level accept of `docs/UX_FLOWS.md` section 12 is here. It is
 * refused by the control plane unless every human-authored finding has reached
 * a final disposition, and the refusal names the one that has not — so this
 * page offers the control the transition table permits and lets the server
 * decide, rather than computing an eligibility rule of its own.
 */

import { Link, createRoute, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";

import { ApiFailure, api, type Finding, type ReviewExport } from "../api/client.ts";
import { AgentDeliveryPanel } from "../components/AgentDelivery.tsx";
import { CommentThread } from "../components/CommentThread.tsx";
import {
  DECISION_REFUSALS,
  ReviewDecisionActions,
} from "../components/DecisionActions.tsx";
import { RefusalPanel } from "../components/refusals.tsx";
import { StatusBadge, type Tone } from "../components/StatusBadge.tsx";
import { reviewDecisionsFrom, type ReviewDecision } from "../review-actions.ts";
import { FINDING_STATUS_WORDS } from "./finding.tsx";
import { rootRoute } from "./root.tsx";

const CARD =
  "rounded border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900";

const TONE_FOR_SEVERITY: Readonly<Record<string, Tone>> = {
  critical: "failed",
  high: "warning",
  medium: "waiting",
  low: "neutral",
  suggestion: "neutral",
};

/** What each review status means in words, so no status is a colour alone. */
export const REVIEW_STATUS_WORDS: Readonly<Record<string, string>> = {
  DRAFT: "not yet ready for anybody",
  READY: "ready to be picked up",
  ASSIGNED: "given to somebody",
  IN_PROGRESS: "being worked on",
  AWAITING_HUMAN_REVIEW: "an agent has requested review — not accepted",
  CHANGES_REQUESTED: "sent back for more work",
  ACCEPTED: "accepted by a human",
  CANCELLED: "withdrawn",
  ARCHIVED: "kept, not deleted",
};

function FindingSummary({
  finding,
  reviewId,
}: {
  readonly finding: Finding;
  readonly reviewId: string;
}): ReactElement {
  const claimedBy = finding.claimed_by ?? null;
  return (
    <li data-finding={finding.id} className={CARD}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold">
            <Link
              to="/reviews/$reviewId/findings/$findingId"
              params={{ reviewId, findingId: finding.id }}
              className="underline-offset-4 hover:underline"
            >
              {finding.title}
            </Link>
          </h3>
          <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">{finding.description}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusBadge
            tone={TONE_FOR_SEVERITY[finding.severity] ?? "neutral"}
            label={finding.severity}
            detail="severity"
          />
          <StatusBadge
            tone={finding.status === "RESOLVED" ? "live" : "warning"}
            label={finding.status}
            detail={FINDING_STATUS_WORDS[finding.status] ?? finding.status}
          />
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
        <div className="col-span-2 min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">URL</dt>
          <dd className="truncate font-mono">{finding.url}</dd>
        </div>
        <div>
          <dt className="text-slate-600 dark:text-slate-400">Viewport</dt>
          <dd className="font-mono">
            {finding.viewport.width}x{finding.viewport.height} @{" "}
            {finding.viewport.device_scale_factor}x
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
          <dd className="break-all font-mono" data-finding-claim={finding.id}>
            {claimedBy === null
              ? "Nobody"
              : `${claimedBy.type}${claimedBy.id === undefined ? "" : ` ${claimedBy.id}`}`}
          </dd>
        </div>
      </dl>

      <p className="mt-3">
        <Link
          to="/reviews/$reviewId/findings/$findingId"
          params={{ reviewId, findingId: finding.id }}
          data-open-finding={finding.id}
          className="inline-block rounded border border-slate-400 px-3 py-2 text-sm font-medium dark:border-slate-600"
        >
          Open finding
        </Link>
      </p>
    </li>
  );
}

function ReviewDetail(): ReactElement {
  const { reviewId } = useParams({ from: "/reviews/$reviewId" });
  const queryClient = useQueryClient();
  const review = useQuery({ queryKey: ["review", reviewId], queryFn: () => api.review(reviewId) });
  const findings = useQuery({
    queryKey: ["findings", reviewId],
    queryFn: () => api.findings(reviewId),
  });
  const comments = useQuery({
    queryKey: ["comments", reviewId],
    queryFn: () => api.reviewComments(reviewId),
  });

  const [decisionFailure, setDecisionFailure] = useState<unknown>(null);
  const [pendingDecision, setPendingDecision] = useState<ReviewDecision | null>(null);

  const decide = useMutation({
    // The version travels from the record this page rendered, for the reason
    // ADR-0035 gives about findings: a refetch at press time would send
    // whatever another writer had just produced.
    mutationFn: (input: {
      readonly decision: ReviewDecision;
      readonly reason: string;
      readonly expectedVersion: number;
    }) => api.transitionReview(reviewId, input.decision, input.expectedVersion, input.reason),
    onMutate: (input) => {
      setDecisionFailure(null);
      setPendingDecision(input.decision);
    },
    onError: (error: unknown) => {
      setDecisionFailure(error);
      setPendingDecision(null);
    },
    onSuccess: () => {
      setPendingDecision(null);
      void queryClient.invalidateQueries({ queryKey: ["review", reviewId] });
      void queryClient.invalidateQueries({ queryKey: ["findings", reviewId] });
      void queryClient.invalidateQueries({ queryKey: ["comments", reviewId] });
    },
  });

  const comment = useMutation({
    mutationFn: (body: string) => api.addComment({ reviewId }, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["comments", reviewId] });
    },
  });

  // The portable document of `docs/REVIEW_FORMAT.md`. It is a durable job, so
  // the request answers with the export's state rather than with bytes, and
  // asking again while a run is in flight joins that run.
  const [exported, setExported] = useState<ReviewExport | null>(null);
  const exportReview = useMutation({
    mutationFn: () => api.requestReviewExport(reviewId),
    onSuccess: (result: ReviewExport) => {
      setExported(result);
    },
  });

  if (review.isPending) return <p role="status">Loading the review.</p>;
  if (review.isError) {
    const failure = review.error;
    return (
      <section aria-labelledby="review-heading">
        <h1 id="review-heading" className="text-xl font-semibold">
          This review could not be loaded
        </h1>
        {failure instanceof ApiFailure ? (
          <RefusalPanel
            code={failure.code}
            message={failure.message}
            attribute="data-failure"
            table={DECISION_REFUSALS}
            surface="review"
          />
        ) : null}
        <p className="mt-2 text-sm">
          <Link to="/reviews" className="underline">
            Back to reviews
          </Link>
          .
        </p>
      </section>
    );
  }

  const record = review.data;

  return (
    <section aria-labelledby="review-heading">
      <p className="text-sm">
        <Link to="/reviews" className="underline underline-offset-4">
          Reviews
        </Link>
      </p>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <h1 id="review-heading" className="text-xl font-semibold">
          {record.title}
        </h1>
        <StatusBadge
          tone={record.status === "ACCEPTED" ? "live" : "warning"}
          label={record.status}
          detail={REVIEW_STATUS_WORDS[record.status] ?? record.status}
        />
      </div>
      <p className="mt-1 font-mono text-xs text-slate-600 dark:text-slate-400">{record.slug}</p>
      {record.description === undefined ? null : (
        <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">{record.description}</p>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-slate-600 dark:text-slate-400">Status</dt>
          <dd data-review-status={record.id}>{record.status}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Branch</dt>
          <dd className="truncate font-mono">{record.captured_branch}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Commit</dt>
          <dd className="truncate font-mono">{record.captured_commit.slice(0, 12)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Captured from</dt>
          <dd className="truncate font-mono">{record.source_browser_session_id}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Captured workspace</dt>
          <dd className="truncate font-mono">{record.captured_workspace_id}</dd>
        </div>
        <div>
          <dt className="text-slate-600 dark:text-slate-400">Priority</dt>
          <dd>{record.priority ?? "medium"}</dd>
        </div>
        <div>
          <dt className="text-slate-600 dark:text-slate-400">Version</dt>
          <dd className="font-mono" data-review-version={record.id}>
            {record.version}
          </dd>
        </div>
      </dl>

      <AgentDeliveryPanel review={record} />

      <div className={`mt-6 ${CARD}`}>
        <ReviewDecisionActions
          reviewId={record.id}
          decisions={reviewDecisionsFrom("human_user", record.status)}
          expectedVersion={record.version}
          pending={pendingDecision}
          failure={decisionFailure}
          onDecide={(decision, reason) => {
            decide.mutate({ decision, reason, expectedVersion: record.version });
          }}
          onReload={() => {
            setDecisionFailure(null);
            void queryClient.invalidateQueries({ queryKey: ["review", reviewId] });
          }}
        />

        <section aria-labelledby="review-export-heading" className="mt-5">
          <h2 id="review-export-heading" className="text-sm font-semibold">
            Export this review
          </h2>
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
            Produces the portable document of the review format: the review, its findings, their
            annotations and every verification, with the artefacts they name. It runs as a job, so
            the answer below is the export&rsquo;s state rather than the file.
          </p>
          <p className="mt-2">
            <button
              type="button"
              data-review-export={record.id}
              disabled={exportReview.isPending}
              onClick={() => {
                exportReview.mutate();
              }}
              className="rounded border border-slate-400 px-3 py-2 text-sm font-medium disabled:opacity-60 dark:border-slate-600"
            >
              {exportReview.isPending ? "Requesting the export" : "Request an export"}
            </button>
          </p>
          {exported === null ? null : (
            <p className="mt-2 text-sm" role="status" data-review-export-state={exported.status}>
              {exported.status === "ready"
                ? `Ready: artefact ${String(exported.artefact_id)}, ${String(
                    exported.size_bytes,
                  )} bytes, SHA-256 ${String(exported.sha256)}.`
                : exported.status === "failed"
                  ? `The export did not complete: ${exported.failure_reason ?? "no reason recorded"}. Nothing was produced.`
                  : "Queued. Ask again to see whether it has finished."}
            </p>
          )}
          {exportReview.error instanceof ApiFailure ? (
            <RefusalPanel
              code={exportReview.error.code}
              message={exportReview.error.message}
              attribute="data-refusal"
              table={DECISION_REFUSALS}
              surface="review-export"
            />
          ) : null}
        </section>

        <CommentThread
          surface={`review-${record.id}`}
          headingId={`comments-heading-${record.id}`}
          heading="Discussion on this review"
          comments={comments.data ?? []}
          pending={comment.isPending}
          failure={comment.error}
          onAdd={(body) => {
            comment.mutate(body);
          }}
        />
      </div>

      <h2 className="mt-6 text-lg font-semibold">Findings</h2>
      {findings.isPending ? <p role="status">Loading findings.</p> : null}
      {findings.data !== undefined && findings.data.length === 0 ? (
        <div className={`mt-3 ${CARD}`} data-findings-empty={record.id}>
          <h3 className="text-base font-semibold">This review has no findings</h3>
          <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
            A review is created from annotated findings, so an empty one is a review whose findings
            were withdrawn or never added. There is nothing to accept or reopen here.
          </p>
        </div>
      ) : null}
      <ul className="mt-3 flex flex-col gap-4">
        {(findings.data ?? []).map((finding) => (
          <FindingSummary key={finding.id} finding={finding} reviewId={reviewId} />
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
