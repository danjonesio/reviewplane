/**
 * `[Accept] [Reopen] [Won't fix]` and the comment composer of
 * `docs/UX_FLOWS.md` section 13, plus the review-level pair of section 12.
 *
 * This is where the product's authority boundary meets a person, so four
 * decisions here are the whole file.
 *
 * **The version and the claim are the ones that were rendered.** Both are
 * props. Nothing in this component fetches anything when a button is pressed;
 * it sends what the page was built from. A control that re-read the record "to
 * get the current version" would send a version matching whatever an agent had
 * just written, and accept evidence the reviewer never saw (ADR-0035, RVP-89).
 * That is the single mistake this design exists to make unwritable, so the
 * inputs arrive from above and there is no query client in scope.
 *
 * **Which controls appear comes from the shared transition table** (ADR-0024,
 * `../review-actions.ts`), never from a list written here. And appearing is not
 * permission: the control plane refuses whatever it should refuse whether or
 * not a button was drawn (`docs/SECURITY.md` section 7). Hiding a control is a
 * courtesy to the reader and never a control.
 *
 * **A reopen asks for its reason before the request.** The server requires it
 * (ADR-0036); asking here means a reviewer is told what is needed rather than
 * refused for it. The form does not enforce the rule — a request that skipped
 * this form is refused just the same — it only stops the refusal being the
 * first the reader hears of it.
 *
 * **A `VERSION_CONFLICT` is a recovery path, not an error toast.** It means the
 * record changed under the reader, so the panel says what happened, offers a
 * reload, and refuses to retry silently. Retrying with a refreshed version is
 * exactly the overwrite the check exists to prevent.
 */

import { useState, type ReactElement } from "react";

import { ApiFailure } from "../api/client.ts";
import {
  decisionNeedsClaim,
  FINDING_DECISION_LABEL,
  FINDING_DECISION_REQUIRES_REASON,
  REVIEW_DECISION_LABEL,
  REVIEW_DECISION_REQUIRES_REASON,
  type FindingDecision,
  type ReviewDecision,
} from "../review-actions.ts";
import { RefusalPanel, SHARED_REFUSALS, type RefusalTable } from "./refusals.tsx";

const FIELD =
  "w-full rounded border border-slate-400 bg-white px-3 py-2 text-base dark:border-slate-600 dark:bg-slate-900";
const HINT = "text-xs text-slate-600 dark:text-slate-400";
const PRIMARY =
  "rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-60";
const CONTROL =
  "rounded border border-slate-400 px-3 py-2 text-sm font-medium disabled:opacity-60 dark:border-slate-600";

/**
 * What each refusal of a decision means, and what the reader can do about it.
 *
 * `docs/UX_FLOWS.md` section 18 forbids "something went wrong" where a stable
 * code exists, and every one of these has a different action behind it — which
 * is the reason they are separate entries rather than one apology.
 */
export const DECISION_REFUSALS: RefusalTable = {
  ...SHARED_REFUSALS,
  VERSION_CONFLICT: {
    title: "This finding changed while you were reading it",
    action:
      "Somebody or something wrote to this finding after the page was loaded — most often an agent replacing the evidence. Reload the finding and read the claim again before deciding. Your decision was not applied and nothing was written.",
  },
  EVIDENCE_REQUIRED: {
    title: "This decision needs something it did not carry",
    action:
      "A reopen and a won't-fix each require a reason, and a decision about a finding under review must name the claim it is about. Fill in what is missing and try again.",
  },
  AUTHORISATION_DENIED: {
    title: "This session may not take this decision",
    action:
      "Accepting or reopening a finding is a human decision on an authorised session. Sign in as a user with reviewer permission for this project.",
  },
  POLICY_DENIED: {
    title: "The lifecycle does not allow this decision from here",
    action:
      "The finding or review has moved since the page was loaded, or the decision is not available from its current status. Reload and look again.",
  },
  UNSUPPORTED_CAPABILITY: {
    title: "The request was not in a shape the control plane accepts",
    action: "Reload the page. If it happens again the client and the server disagree about the API.",
  },
};

export interface FindingDecisionActionsProps {
  readonly findingId: string;
  readonly decisions: readonly FindingDecision[];
  /** The version the page rendered from. Never refetched at press time. */
  readonly expectedVersion: number;
  /** The claim the comparison rendered, or null where the finding holds none. */
  readonly verificationId: string | null;
  readonly disabled?: boolean;
  readonly pending: FindingDecision | null;
  readonly failure: unknown;
  readonly onDecide: (decision: FindingDecision, reason: string) => void;
  readonly onReload: () => void;
}

export function FindingDecisionActions({
  findingId,
  decisions,
  expectedVersion,
  verificationId,
  disabled = false,
  pending,
  failure,
  onDecide,
  onReload,
}: FindingDecisionActionsProps): ReactElement {
  const [chosen, setChosen] = useState<FindingDecision | null>(null);
  const [reason, setReason] = useState("");

  const refusal = failure instanceof ApiFailure ? failure : null;
  const conflicted = refusal?.code === "VERSION_CONFLICT";
  const needsReason = chosen === null ? false : FINDING_DECISION_REQUIRES_REASON[chosen];
  const reasonMissing = needsReason && reason.trim() === "";

  if (decisions.length === 0) {
    return (
      <p className="mt-4 text-sm" data-decisions-empty={findingId}>
        No decision is available on this finding from its current status.
      </p>
    );
  }

  return (
    <section
      aria-labelledby={`decision-heading-${findingId}`}
      data-decisions={findingId}
      className="mt-4"
    >
      <h5 id={`decision-heading-${findingId}`} className="text-sm font-semibold">
        Your decision
      </h5>
      <p className={`mt-1 ${HINT}`}>
        Accepting is a human act. An agent has requested review; it has not granted it.
      </p>

      <div role="group" aria-label="Decision" className="mt-2 flex flex-wrap gap-2">
        {decisions.map((decision) => (
          <button
            key={decision}
            type="button"
            data-decision={decision}
            aria-pressed={chosen === decision}
            disabled={disabled || conflicted}
            onClick={() => {
              setChosen(decision);
            }}
            className={
              chosen === decision
                ? `${CONTROL} border-sky-700 bg-sky-50 dark:border-sky-500 dark:bg-sky-950`
                : CONTROL
            }
          >
            {FINDING_DECISION_LABEL[decision]}
          </button>
        ))}
      </div>

      {chosen === null ? null : (
        <div className="mt-3 flex flex-col gap-2">
          <label htmlFor={`decision-reason-${findingId}`} className="text-sm font-medium">
            {needsReason ? "Reason (required)" : "Reason (optional)"}
          </label>
          <p className={HINT} id={`decision-reason-hint-${findingId}`}>
            {needsReason
              ? "A reopen or a won't-fix is work somebody has to act on. The reason is recorded as a comment on the finding, where the agent reads it."
              : "Recorded on the decision and, where you write one, as a comment on the finding."}
          </p>
          <textarea
            id={`decision-reason-${findingId}`}
            data-decision-reason={findingId}
            aria-describedby={`decision-reason-hint-${findingId}`}
            required={needsReason}
            value={reason}
            rows={3}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            className={FIELD}
          />
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-decision-submit={findingId}
              disabled={disabled || conflicted || reasonMissing || pending !== null}
              onClick={() => {
                onDecide(chosen, reason);
              }}
              className={PRIMARY}
            >
              {pending === null
                ? `${FINDING_DECISION_LABEL[chosen]} this finding`
                : "Recording your decision"}
            </button>
            {/*
              The two values the decision carries, shown rather than implied.
              A reviewer refused for a superseded claim can see which identifier
              was sent, which is the difference between a recoverable refusal
              and a mystery.
            */}
            <p className={HINT} data-decision-inputs={findingId}>
              Sending version {expectedVersion}
              {decisionNeedsClaim(verificationId) ? `, claim ${String(verificationId)}` : ""}
            </p>
          </div>
          {reasonMissing ? (
            <p className="text-sm" role="status" data-decision-reason-missing={findingId}>
              This decision requires a reason before it can be sent.
            </p>
          ) : null}
        </div>
      )}

      {refusal === null ? null : (
        <>
          <RefusalPanel
            code={refusal.code}
            message={refusal.message}
            attribute="data-refusal"
            table={DECISION_REFUSALS}
            surface="finding-decision"
          />
          {conflicted ? (
            <p className="mt-2">
              <button
                type="button"
                data-decision-reload={findingId}
                onClick={onReload}
                className={CONTROL}
              >
                Reload this finding
              </button>
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

export interface ReviewDecisionActionsProps {
  readonly reviewId: string;
  readonly decisions: readonly ReviewDecision[];
  readonly expectedVersion: number;
  readonly pending: ReviewDecision | null;
  readonly failure: unknown;
  readonly onDecide: (decision: ReviewDecision, reason: string) => void;
  readonly onReload: () => void;
}

export function ReviewDecisionActions({
  reviewId,
  decisions,
  expectedVersion,
  pending,
  failure,
  onDecide,
  onReload,
}: ReviewDecisionActionsProps): ReactElement {
  const [chosen, setChosen] = useState<ReviewDecision | null>(null);
  const [reason, setReason] = useState("");

  const refusal = failure instanceof ApiFailure ? failure : null;
  const conflicted = refusal?.code === "VERSION_CONFLICT";
  const needsReason = chosen === null ? false : REVIEW_DECISION_REQUIRES_REASON[chosen];
  const reasonMissing = needsReason && reason.trim() === "";

  return (
    <section aria-labelledby="review-decision-heading" data-review-decisions={reviewId}>
      <h2 id="review-decision-heading" className="text-lg font-semibold">
        Review decision
      </h2>
      <p className={`mt-1 ${HINT}`}>
        A review can be accepted only once every human-authored finding has reached a final
        disposition. The control plane checks that and names the one that has not.
      </p>
      {decisions.length === 0 ? (
        <p className="mt-2 text-sm" data-review-decisions-empty={reviewId}>
          No decision is available on this review from its current status.
        </p>
      ) : (
        <div role="group" aria-label="Review decision" className="mt-2 flex flex-wrap gap-2">
          {decisions.map((decision) => (
            <button
              key={decision}
              type="button"
              data-review-decision={decision}
              aria-pressed={chosen === decision}
              disabled={conflicted}
              onClick={() => {
                setChosen(decision);
              }}
              className={
                chosen === decision
                  ? `${CONTROL} border-sky-700 bg-sky-50 dark:border-sky-500 dark:bg-sky-950`
                  : CONTROL
              }
            >
              {REVIEW_DECISION_LABEL[decision]}
            </button>
          ))}
        </div>
      )}

      {chosen === null ? null : (
        <div className="mt-3 flex flex-col gap-2">
          <label htmlFor="review-decision-reason" className="text-sm font-medium">
            {needsReason ? "Reason (required)" : "Reason (optional)"}
          </label>
          <textarea
            id="review-decision-reason"
            data-review-decision-reason={reviewId}
            required={needsReason}
            rows={3}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            className={FIELD}
          />
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-review-decision-submit={reviewId}
              disabled={conflicted || reasonMissing || pending !== null}
              onClick={() => {
                onDecide(chosen, reason);
              }}
              className={PRIMARY}
            >
              {pending === null ? REVIEW_DECISION_LABEL[chosen] : "Recording your decision"}
            </button>
            <p className={HINT}>Sending version {expectedVersion}</p>
          </div>
          {reasonMissing ? (
            <p className="text-sm" role="status">
              This decision requires a reason before it can be sent.
            </p>
          ) : null}
        </div>
      )}

      {refusal === null ? null : (
        <>
          <RefusalPanel
            code={refusal.code}
            message={refusal.message}
            attribute="data-refusal"
            table={DECISION_REFUSALS}
            surface="review-decision"
          />
          {conflicted ? (
            <p className="mt-2">
              <button
                type="button"
                data-review-decision-reload={reviewId}
                onClick={onReload}
                className={CONTROL}
              >
                Reload this review
              </button>
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
