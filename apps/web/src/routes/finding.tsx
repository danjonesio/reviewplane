/**
 * One finding, and the decision a human takes on it.
 *
 * This is the surface `docs/UX_FLOWS.md` sections 12 and 13 describe and the
 * one the product's central invariant ends at: an agent submits verification
 * and requests review, and a person accepts or reopens. Everything below the
 * browser already refuses an agent this decision — the transport by token
 * shape, the domain by actor type, and migration 0151 in the database. None of
 * that is restated here. What is here is the reader's half: showing what was
 * claimed, showing who claimed it, and sending a decision about the evidence
 * that was actually on the screen.
 *
 * **The claim is pinned.** The comparison renders from a named verification and
 * the decision carries that identifier (ADR-0035). The whole page is built from
 * one read; a decision sends the version and the claim it rendered from, and
 * nothing re-reads either when a button is pressed. That is deliberate to the
 * point of being awkward: the natural implementation — refetch, then send the
 * fresh version — is precisely the defect (RVP-89), so the values travel as
 * props from the query that drew the page and there is no other path to them.
 *
 * **Staleness is not computed** (`docs/DOMAIN_MODEL.md` section 24). The
 * captured branch and commit are stated and the panel position section 14
 * reserves is left for Stage 2. Printing a freshness verdict this deployment
 * cannot calculate would be worse than printing none.
 */

import { Link, createRoute, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";

import { ApiFailure, api, type Finding } from "../api/client.ts";
import { CommentThread } from "../components/CommentThread.tsx";
import {
  DECISION_REFUSALS,
  FindingDecisionActions,
} from "../components/DecisionActions.tsx";
import { RefusalPanel } from "../components/refusals.tsx";
import { StatusBadge, type Tone } from "../components/StatusBadge.tsx";
import { VerificationPanel } from "../components/VerificationPanel.tsx";
import { findingDecisionsFrom, type FindingDecision } from "../review-actions.ts";
import { rootRoute } from "./root.tsx";

const CARD =
  "rounded border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900";
const HINT = "text-xs text-slate-600 dark:text-slate-400";

const TONE_FOR_SEVERITY: Readonly<Record<string, Tone>> = {
  critical: "failed",
  high: "warning",
  medium: "waiting",
  low: "neutral",
  suggestion: "neutral",
};

/**
 * What each finding status means in words.
 *
 * `docs/UX_FLOWS.md` section 12 requires statuses to be readable and not to
 * rely on colour alone, so every badge carries its status word and this
 * sentence beside it. `AWAITING_HUMAN_REVIEW` is the one that must not be
 * mistaken for an acceptance: the agent has asked, and asking is not granting.
 */
export const FINDING_STATUS_WORDS: Readonly<Record<string, string>> = {
  OPEN: "reported, nobody working on it",
  CLAIMED: "an actor has taken it",
  IN_PROGRESS: "being worked on",
  BLOCKED: "waiting on somebody",
  FIXED_UNVERIFIED: "an agent believes it is fixed, no review requested",
  AWAITING_HUMAN_REVIEW: "an agent has requested review — not accepted",
  RESOLVED: "accepted by a human",
  REOPENED: "sent back for more work",
  WONT_FIX: "waived by a human",
  DUPLICATE: "closed as a duplicate",
};

function FindingFacts({ finding }: { readonly finding: Finding }): ReactElement {
  const claimedBy = finding.claimed_by ?? null;
  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
      <div className="col-span-2 min-w-0">
        <dt className="text-slate-600 dark:text-slate-400">URL</dt>
        {/* Page-derived, so it is text and never a link the page controls. */}
        <dd className="truncate font-mono" data-finding-url={finding.id}>
          {finding.url}
        </dd>
      </div>
      <div>
        <dt className="text-slate-600 dark:text-slate-400">Viewport</dt>
        <dd className="font-mono" data-finding-viewport={finding.id}>
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
        <dt className="text-slate-600 dark:text-slate-400">Captured at commit</dt>
        <dd className="truncate font-mono" data-finding-commit={finding.id}>
          {finding.captured_commit.slice(0, 12)}
        </dd>
      </div>
      <div>
        <dt className="text-slate-600 dark:text-slate-400">Reported by</dt>
        <dd data-finding-source={finding.id}>
          {finding.source === "human" ? "a human" : "an agent"}
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-slate-600 dark:text-slate-400">Worked by</dt>
        <dd className="break-all font-mono" data-finding-claim={finding.id}>
          {claimedBy === null
            ? "Nobody"
            : `${claimedBy.type}${claimedBy.id === undefined ? "" : ` ${claimedBy.id}`}`}
        </dd>
      </div>
      <div className="col-span-2 min-w-0">
        <dt className="text-slate-600 dark:text-slate-400">Version</dt>
        <dd className="font-mono" data-finding-version={finding.id}>
          {finding.version}
        </dd>
      </div>
    </dl>
  );
}

function FindingDetail(): ReactElement {
  const { reviewId, findingId } = useParams({ from: "/reviews/$reviewId/findings/$findingId" });
  const queryClient = useQueryClient();

  /**
   * The page is a **snapshot**, and refreshing it is a decision the reader
   * takes.
   *
   * The application's default is to refetch on focus and after two seconds of
   * staleness, which is right for a dashboard and wrong here. A comparison that
   * quietly replaced itself when an agent submitted again would move the
   * evidence under a reader between reading the summary and pressing Accept —
   * the same harm as a refetch at press time (RVP-89), arriving by a different
   * route. So these three queries hold what they loaded until the reader asks
   * for more, and a decision taken against evidence that has since moved is
   * refused by the control plane and offered a reload.
   */
  const snapshot = {
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  } as const;

  const finding = useQuery({
    queryKey: ["finding", findingId],
    queryFn: () => api.finding(findingId),
    ...snapshot,
  });
  const annotations = useQuery({
    queryKey: ["annotations", findingId],
    queryFn: () => api.annotations(findingId),
    ...snapshot,
  });
  const claims = useQuery({
    queryKey: ["finding-verifications", findingId],
    queryFn: () => api.findingVerifications(findingId),
    ...snapshot,
  });
  const comments = useQuery({
    queryKey: ["finding-comments", findingId],
    queryFn: () => api.findingComments(findingId),
  });

  // Which claim the comparison shows. `chosen` is set only by a reader picking
  // one from the history; otherwise the newest claim of the snapshot is shown.
  // Deriving rather than storing means a reload lands on the claim that is now
  // current instead of on the one an effect happened to write first.
  const [chosen, setChosen] = useState<string | null>(null);
  const newest = claims.data?.[0]?.verification_id ?? null;
  const selected = chosen ?? newest;

  const verification = useQuery({
    queryKey: ["verification-review", findingId, selected],
    queryFn: () => api.verificationReview(findingId, selected as string),
    enabled: selected !== null,
    ...snapshot,
  });

  const [decisionFailure, setDecisionFailure] = useState<unknown>(null);
  const [pendingDecision, setPendingDecision] = useState<FindingDecision | null>(null);

  const decide = useMutation({
    mutationFn: (input: {
      readonly decision: FindingDecision;
      readonly reason: string;
      // Both carried in the request rather than read inside it. This is the
      // shape ADR-0035 requires of a client: what was rendered, not what is
      // current at the moment of the press.
      readonly expectedVersion: number;
      readonly verificationId: string | null;
    }) =>
      api.decideFinding(findingId, input.decision, {
        expectedVersion: input.expectedVersion,
        verificationId: input.verificationId,
        reason: input.reason,
      }),
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
      void queryClient.invalidateQueries({ queryKey: ["finding", findingId] });
      void queryClient.invalidateQueries({ queryKey: ["finding-verifications", findingId] });
      void queryClient.invalidateQueries({ queryKey: ["finding-comments", findingId] });
      void queryClient.invalidateQueries({ queryKey: ["findings", reviewId] });
      void queryClient.invalidateQueries({ queryKey: ["review", reviewId] });
    },
  });

  const comment = useMutation({
    mutationFn: (body: string) => api.addComment({ findingId }, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["finding-comments", findingId] });
    },
  });

  if (finding.isPending) return <p role="status">Loading the finding.</p>;
  if (finding.isError) {
    const failure = finding.error;
    return (
      <section aria-labelledby="finding-heading">
        <h1 id="finding-heading" className="text-xl font-semibold">
          This finding could not be loaded
        </h1>
        {failure instanceof ApiFailure ? (
          <RefusalPanel
            code={failure.code}
            message={failure.message}
            attribute="data-failure"
            table={DECISION_REFUSALS}
            surface="finding"
          />
        ) : null}
        <p className="mt-2 text-sm">
          <Link to="/reviews/$reviewId" params={{ reviewId }} className="underline">
            Back to the review
          </Link>
        </p>
      </section>
    );
  }

  const record = finding.data;
  // The current claim, which is the only one a decision may be taken on. It
  // comes from the list the page rendered, never from a read taken when the
  // button is pressed.
  const currentClaim =
    (claims.data ?? []).find((entry) => entry.status === "submitted")?.verification_id ?? null;
  /**
   * Whether the comparison on screen **is** the claim a decision would decide.
   *
   * These were two independent values until the adversarial review of RVP-55
   * found what that costs. `selected` is what the panel renders and
   * `currentClaim` is what the server will accept; they agree until a reviewer
   * clicks a prior claim in the history list — the affordance
   * `docs/DOMAIN_MODEL.md` §19 requires — and then the page shows one claim's
   * before-and-after pair, summary, viewports and assurance split while the
   * Accept button decides a different one.
   *
   * `expected_version` cannot catch it. Both values come from one snapshot, so
   * the request is entirely legitimate at the server: it names the current
   * claim and carries the current version. The harm is RVP-89's — a reviewer's
   * name recorded on evidence they did not read — reached from the client side
   * instead of by an agent's write.
   *
   * So the decision is offered only when the two agree. `verificationId` below
   * is `selected` rather than `currentClaim`, so that even if a control were
   * somehow pressed it would name what was on screen and be refused, and the
   * disabled state is what tells the reader why rather than leaving them to
   * diff two identifiers by eye.
   */
  // `claims.isPending` is part of it: before the list has loaded, `selected`
  // and `currentClaim` are both null and would agree by accident, so a reader
  // fast enough to press Accept would send no claim and be refused for a reason
  // that is about timing rather than about evidence. Nothing is decided
  // wrongly either way; the state is simply not one to offer.
  const renderedClaimIsDecidable = !claims.isPending && selected === currentClaim;
  const decisions = findingDecisionsFrom("human_user", record.status);

  return (
    <section aria-labelledby="finding-heading">
      <p className="text-sm">
        <Link to="/reviews" className="underline underline-offset-4">
          Reviews
        </Link>
        {" / "}
        <Link
          to="/reviews/$reviewId"
          params={{ reviewId }}
          className="underline underline-offset-4"
        >
          Review
        </Link>
      </p>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <h1 id="finding-heading" className="text-xl font-semibold">
          {record.title}
        </h1>
        <div className="flex flex-wrap gap-2">
          <StatusBadge
            tone={TONE_FOR_SEVERITY[record.severity] ?? "neutral"}
            label={record.severity}
            detail="severity"
          />
          <StatusBadge
            tone={record.status === "RESOLVED" ? "live" : "warning"}
            label={record.status}
            detail={FINDING_STATUS_WORDS[record.status] ?? record.status}
          />
        </div>
      </div>

      <div className={`mt-4 ${CARD}`}>
        <h2 className="text-base font-semibold">What was reported</h2>
        <p className="mt-1 whitespace-pre-wrap text-sm" data-finding-description={record.id}>
          {record.description}
        </p>
        <FindingFacts finding={record} />
        {/*
          The position `docs/UX_FLOWS.md` section 14 reserves for the stale
          review panel. Stage 1 states the captured context and computes no
          verdict against it (`docs/DOMAIN_MODEL.md` section 24).
        */}
        <p className={`mt-3 ${HINT}`} data-staleness={record.id}>
          This finding was captured at commit{" "}
          <span className="font-mono">{record.captured_commit.slice(0, 12)}</span>. This deployment
          does not yet compute whether the workspace has moved since, so reproduce it before
          judging the claim.
        </p>
      </div>

      <div className="mt-6">
        <VerificationPanel
          findingId={record.id}
          findingTitle={record.title}
          beforeArtefactId={record.screenshot_artefact_id}
          annotations={annotations.data ?? []}
          captureScale={record.viewport.device_scale_factor}
          beforeCaption={`Screenshot of ${record.url} at ${String(
            record.viewport.width,
          )} by ${String(record.viewport.height)} CSS pixels, captured for the finding "${
            record.title
          }".`}
          claims={claims.data ?? []}
          review={verification.data ?? null}
          selectedVerificationId={selected}
          onSelectVerification={setChosen}
        />

        <div className={`mt-4 ${CARD}`}>
          <FindingDecisionActions
            findingId={record.id}
            decisions={decisions}
            expectedVersion={record.version}
            // What is on screen, not what the server happens to accept. The two
            // are equal whenever a decision is offered at all.
            verificationId={selected}
            claimIsDecidable={renderedClaimIsDecidable}
            currentVerificationId={currentClaim}
            onShowCurrentClaim={() => {
              setChosen(null);
            }}
            pending={pendingDecision}
            failure={decisionFailure}
            onDecide={(decision, reason) => {
              decide.mutate({
                decision,
                reason,
                // Read from the record this page rendered.
                expectedVersion: record.version,
                verificationId: selected,
              });
            }}
            onReload={() => {
              // A reload drops any hand-picked claim, so the comparison lands
              // on what is now current rather than on what the reader was
              // looking at when the refusal arrived.
              setDecisionFailure(null);
              setChosen(null);
              void queryClient.invalidateQueries({ queryKey: ["finding", findingId] });
              void queryClient.invalidateQueries({
                queryKey: ["finding-verifications", findingId],
              });
              void queryClient.invalidateQueries({ queryKey: ["verification-review", findingId] });
            }}
          />

          <CommentThread
            surface={`finding-${record.id}`}
            headingId={`comments-heading-${record.id}`}
            heading="Discussion"
            comments={comments.data ?? []}
            pending={comment.isPending}
            failure={comment.error}
            onAdd={(body) => {
              comment.mutate(body);
            }}
          />
        </div>
      </div>
    </section>
  );
}

export const findingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reviews/$reviewId/findings/$findingId",
  component: FindingDetail,
});
