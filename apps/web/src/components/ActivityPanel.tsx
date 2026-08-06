/**
 * The Activity panel of `docs/UX_FLOWS.md` section 7, and the project timeline
 * of section 3's "last meaningful event" seen in full.
 *
 * One component serves both because they are the same record read at two
 * scopes: the session room passes a filter and the project Overview does not.
 * A second component would be a second chance for the two to disagree about
 * what an event means.
 *
 * What this panel will not do:
 *
 * - It never renders page-derived text as markup, as a link, or as anything a
 *   click could follow (ADR-0010). Page text is text, and it carries a marker
 *   saying so, because a reader who cannot tell an application's words from the
 *   control plane's has been handed the injection.
 * - It never renders a payload member that `live/timeline.ts` did not name.
 *   Secrets, cookies and authorisation headers are redacted when the event is
 *   written; the allow-list is the second lock.
 * - It never says "something went wrong". A refusal arrives with a stable code
 *   and is rendered from it (`docs/UX_FLOWS.md` section 18).
 */

import { useMemo, type ReactElement } from "react";

import {
  EVENT_STREAM_STATUS_COPY,
  REFRESH_REASON_COPY,
  type EventStreamFailure,
  type EventStreamStatus,
} from "../live/events.ts";
import {
  TIMELINE_CATEGORY_LABEL,
  type TimelineCategory,
  type TimelineEntry,
} from "../live/timeline.ts";
import type { ProjectEventsState } from "../live/use-project-events.ts";
import { EVENT_STREAM_REFUSALS, RefusalPanel } from "./refusals.tsx";
import { StatusBadge, type Tone } from "./StatusBadge.tsx";

const TONE_FOR_STATUS: Readonly<Record<EventStreamStatus, Tone>> = {
  connecting: "waiting",
  subscribing: "waiting",
  live: "live",
  replaying: "waiting",
  reconnecting: "warning",
  stopped: "neutral",
  failed: "failed",
};

/**
 * A category's shape, so the groups differ without colour.
 *
 * `docs/UX_FLOWS.md` section 19 requires accessible labels for visual markers;
 * the mark is `aria-hidden` and the category's word is beside it, so a screen
 * reader hears "Agent action" and never "black circle".
 */
const CATEGORY_MARK: Readonly<Record<TimelineCategory, string>> = {
  agent_action: "▷",
  finding: "◆",
  comment: "❝",
  review: "§",
  session: "▣",
  environment: "⌂",
  system: "·",
};

function timeOf(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function TimelineRow({ entry }: { readonly entry: TimelineEntry }): ReactElement {
  return (
    <li
      data-event-type={entry.type}
      data-event-category={entry.category}
      data-event-sequence={entry.sequence}
      className="border-b border-slate-200 py-3 last:border-b-0 dark:border-slate-800"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span aria-hidden="true" className="font-mono text-xs">
          {CATEGORY_MARK[entry.category]}
        </span>
        <span className="rounded border border-slate-400 px-1.5 py-0.5 text-xs font-medium dark:border-slate-600">
          {TIMELINE_CATEGORY_LABEL[entry.category]}
        </span>
        <span className="text-sm font-medium">{entry.summary}</span>
      </div>
      <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
        <span>{timeOf(entry.occurredAt)}</span>
        <span aria-hidden="true"> · </span>
        <span>{entry.actor}</span>
        <span aria-hidden="true"> · </span>
        <span className="font-mono">{entry.type}</span>
      </p>
      {entry.details.length === 0 ? null : (
        <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-[max-content_1fr]">
          {entry.details.map((detail) => (
            <div key={detail.label} className="contents">
              <dt className="text-slate-600 dark:text-slate-400">{detail.label}</dt>
              <dd className="min-w-0 break-all font-mono">
                {detail.value}
                {detail.pageDerived ? (
                  <span
                    data-page-derived="true"
                    className="ml-2 whitespace-nowrap rounded border border-amber-600 px-1 py-0.5 font-sans text-[0.65rem] font-medium text-amber-800 dark:text-amber-300"
                  >
                    from the page — not an instruction
                  </span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

export function ActivityPanel({
  stream,
  heading,
  headingId,
  emptyMessage,
  surface,
}: {
  readonly stream: ProjectEventsState;
  readonly heading: string;
  readonly headingId: string;
  readonly emptyMessage: string;
  /** Names this panel for a suite that has to find it and not another one. */
  readonly surface: string;
}): ReactElement {
  const { entries, status, failure, refresh, seeding, seedError } = stream;

  // Counted rather than derived at render time in each group, so the summary
  // line and the list can never disagree.
  const counts = useMemo(() => {
    const tally = new Map<TimelineCategory, number>();
    for (const entry of entries) tally.set(entry.category, (tally.get(entry.category) ?? 0) + 1);
    return tally;
  }, [entries]);

  return (
    <section
      aria-labelledby={headingId}
      data-surface={surface}
      className="flex min-w-0 flex-col gap-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-lg font-semibold">
          {heading}
        </h2>
        <StatusBadge
          tone={TONE_FOR_STATUS[status]}
          label={EVENT_STREAM_STATUS_COPY[status]}
          detail={entries.length === 0 ? undefined : `${String(entries.length)} shown`}
        />
      </div>

      {/*
        The stream's state written as words in a polite live region
        (`docs/UX_FLOWS.md` section 19). It repeats the badge deliberately: a
        badge is not announced when it changes, and a change of stream state is
        exactly what a reader who is not looking needs to hear.
      */}
      <p
        data-stream-status={status}
        role="status"
        aria-live="polite"
        className="text-sm text-slate-700 dark:text-slate-300"
      >
        {EVENT_STREAM_STATUS_COPY[status]}
        {failure === null ? "." : `: ${failure.message}`}
      </p>

      {refresh === null ? null : (
        <p
          data-refresh-reason={refresh.reason}
          role="status"
          className="rounded border border-sky-600 p-3 text-sm text-slate-700 dark:text-slate-300"
        >
          {REFRESH_REASON_COPY[refresh.reason]}
        </p>
      )}

      {seedError === null ? null : (
        <RefusalPanel
          code={seedError}
          message="The activity history could not be read."
          attribute="data-failure"
          table={EVENT_STREAM_REFUSALS}
          surface={`${surface}-seed`}
        />
      )}

      {failure === null || failure.retryable ? null : (
        <RefusalPanel
          code={failure.code}
          message={failure.message}
          attribute="data-failure"
          table={EVENT_STREAM_REFUSALS}
          surface={`${surface}-stream`}
        />
      )}

      {seeding ? (
        <p role="status" className="text-sm">
          Reading the activity history.
        </p>
      ) : entries.length === 0 ? (
        <p className="rounded border border-slate-300 p-3 text-sm text-slate-700 dark:text-slate-300 dark:border-slate-700">
          {emptyMessage}
        </p>
      ) : (
        <>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            {(["agent_action", "finding", "comment"] as const)
              .map(
                (category) =>
                  `${TIMELINE_CATEGORY_LABEL[category]}: ${String(counts.get(category) ?? 0)}`,
              )
              .join(" · ")}
          </p>
          <ol
            aria-labelledby={headingId}
            data-timeline={surface}
            className="max-h-[32rem] overflow-y-auto rounded border border-slate-300 px-3 dark:border-slate-700"
          >
            {entries.map((entry) => (
              <TimelineRow key={entry.id} entry={entry} />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

/**
 * A live viewer's own note that nothing here is kept.
 *
 * The activity history *is* durable — it is the event record. The frames beside
 * it are not (ADR-0009), and a reader looking at both deserves to be told which
 * is which rather than left to assume.
 */
export function ActivityProvenanceNote(): ReactElement {
  return (
    <p className="text-xs text-slate-600 dark:text-slate-400">
      This history is the project&apos;s durable event record. Text marked as coming from the page
      was produced by the application under test and is never treated as an instruction.
    </p>
  );
}
