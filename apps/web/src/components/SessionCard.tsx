/**
 * One fleet card (`docs/UX_FLOWS.md` section 3).
 *
 * Section 3 lists ten facts a card shows, and this component shows all ten —
 * including the ones the control plane cannot yet answer, which are stated as
 * "not recorded" rather than omitted. A card that silently drops a row a reader
 * was told to expect is worse than one that says the deployment does not know:
 * the first looks complete and is not.
 *
 * Two of the ten are honest absences at this stage:
 *
 * - **Agent type and session.** A browser session records its current
 *   controller, and in Stage 1 a human acts through the `system` controller
 *   (`apps/server/src/modules/browser-sessions/routes.ts`). When an agent
 *   session holds the browser the card names it; when nothing does, it says so.
 * - **Current task summary.** No domain object carries an agent's current task
 *   in Stage 1. The card shows the most recent agent action from the event
 *   record instead, which is the nearest true answer, and labels it as such.
 *
 * This component fetches nothing. A list of twenty cards each issuing four
 * queries is twenty times the traffic for the same four answers, so the list
 * reads once and passes down.
 */

import { Link } from "@tanstack/react-router";
import type { ReactElement } from "react";

import type { BrowserSession, Project, WorkspaceSummary } from "../api/client.ts";
import { statusLabel } from "../live/timeline.ts";
import type { TimelineEntry } from "../live/timeline.ts";
import { LiveThumbnail } from "./LiveThumbnail.tsx";
import { StatusBadge, type Tone } from "./StatusBadge.tsx";

const TONE_FOR_FLEET: Readonly<Record<string, Tone>> = {
  active: "live",
  waiting: "waiting",
  paused: "warning",
  blocked: "failed",
  disconnected: "neutral",
};

const ACTION =
  "rounded border border-slate-400 px-3 py-2 text-sm font-medium disabled:opacity-60 dark:border-slate-600";

export interface SessionCardCounts {
  /** Reviews this project has that are waiting on a human. */
  readonly awaitingHuman: number;
  /** Reviews that are neither accepted, cancelled nor archived. */
  readonly open: number;
}

export interface SessionCardEnvironment {
  readonly name: string;
  readonly workspace: WorkspaceSummary | undefined;
}

function Fact({
  label,
  children,
  wide,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
  readonly wide?: boolean;
}): ReactElement {
  return (
    <div className={wide === true ? "col-span-2 min-w-0" : "min-w-0"}>
      <dt className="text-slate-600 dark:text-slate-400">{label}</dt>
      <dd className="mt-0.5 break-words">{children}</dd>
    </div>
  );
}

export function SessionCard({
  session,
  project,
  environment,
  counts,
  lastEvent,
  lastAgentAction,
  onPause,
  onEnd,
  busy,
}: {
  readonly session: BrowserSession;
  readonly project: Project | undefined;
  readonly environment: SessionCardEnvironment | undefined;
  readonly counts: SessionCardCounts | undefined;
  /** The newest event of any kind for this project, as "last meaningful event". */
  readonly lastEvent: TimelineEntry | undefined;
  /** The newest agent action, standing in for a task summary this stage lacks. */
  readonly lastAgentAction: TimelineEntry | undefined;
  readonly onPause: (session: BrowserSession) => void;
  readonly onEnd: (session: BrowserSession) => void;
  /** Which action, if any, is in flight for this card. */
  readonly busy: "pause" | "end" | null;
}): ReactElement {
  const label = statusLabel(session.status);
  const projectName = project?.name ?? session.project_id;
  const controller = session.current_controller;
  const agent =
    controller === null
      ? "no controller holds this browser"
      : controller.type === "agent_session"
        ? `agent session ${controller.id}`
        : `${controller.type.replaceAll("_", " ")} ${controller.id}`;
  const workspace = environment?.workspace;
  const pausable = session.status === "READY" || session.status === "ACTIVE";

  return (
    <li
      data-session-card={session.id}
      data-fleet-status={label.status}
      className="rounded border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold">
            <Link
              to="/sessions/$sessionId"
              params={{ sessionId: session.id }}
              className="underline-offset-4 hover:underline"
            >
              {projectName}
            </Link>
          </h3>
          <p className="mt-1 break-all font-mono text-xs text-slate-600 dark:text-slate-400">
            {session.id}
          </p>
        </div>
        {/*
          The word, the mark and the domain status together. Section 3's five
          supervision statuses are a summary of nine domain ones, so hiding the
          domain status behind the summary would cost a reader the difference
          between a session that ended and a worker that stopped reporting.
        */}
        <StatusBadge
          tone={TONE_FOR_FLEET[label.status] ?? "neutral"}
          label={label.word}
          detail={label.domainStatus}
        />
      </div>

      <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">{label.explanation}</p>

      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,18rem)_1fr]">
        <LiveThumbnail sessionId={session.id} label={`${projectName} browser session`} />

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <Fact label="Agent">{agent}</Fact>
          <Fact label="Environment">{environment?.name ?? "not reported"}</Fact>
          <Fact label="Branch">
            {workspace === undefined ? (
              <span className="text-slate-600 dark:text-slate-400">no checkout reported</span>
            ) : (
              <span className="font-mono" data-card-branch={workspace.branch}>
                {workspace.branch}
                <span className="ml-2 font-sans text-xs">
                  {workspace.dirty ? "· uncommitted changes" : "· clean"}
                </span>
              </span>
            )}
          </Fact>
          <Fact label="Viewport">
            <span className="font-mono">
              {session.viewport.width}x{session.viewport.height} @{" "}
              {session.viewport.device_scale_factor}x
            </span>
          </Fact>
          <Fact label="Current route" wide>
            {/* Page-derived, so it is text and never an anchor (ADR-0010). */}
            <span className="break-all font-mono">
              {session.service_origin ?? "no application published"}
            </span>
          </Fact>
          <Fact label="Latest agent action" wide>
            {lastAgentAction === undefined ? (
              <span className="text-slate-600 dark:text-slate-400">
                no agent action recorded yet — this stage records actions, not a task summary
              </span>
            ) : (
              lastAgentAction.summary
            )}
          </Fact>
          <Fact label="Last event" wide>
            {lastEvent === undefined ? (
              <span className="text-slate-600 dark:text-slate-400">nothing recorded yet</span>
            ) : (
              <>
                {lastEvent.summary}
                <span className="ml-2 text-xs text-slate-600 dark:text-slate-400">
                  {new Date(lastEvent.occurredAt).toLocaleTimeString()}
                </span>
              </>
            )}
          </Fact>
          <Fact label="Reviews" wide>
            {counts === undefined ? (
              <span className="text-slate-600 dark:text-slate-400">not read</span>
            ) : (
              <span data-pending-reviews={counts.awaitingHuman}>
                {counts.awaitingHuman} awaiting you, {counts.open} open
              </span>
            )}
          </Fact>
        </dl>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId: session.id }}
          className={`${ACTION} inline-block`}
        >
          Open session
        </Link>
        {pausable ? (
          <button
            type="button"
            data-card-action="pause"
            disabled={busy !== null}
            onClick={() => {
              onPause(session);
            }}
            className={ACTION}
          >
            {busy === "pause" ? "Pausing…" : "Pause agent browser input"}
          </button>
        ) : null}
        {/*
          The entry point rather than the act. Naming a review needs a captured
          branch, commit and workspace, and the capture flow arrives with the
          annotation canvas; offering a button that could only fail here would be
          worse than saying where the flow lives.
        */}
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId: session.id }}
          hash="capture"
          data-card-action="capture"
          className={`${ACTION} inline-block`}
        >
          Create review from latest frame
        </Link>
        {session.ended_at === null ? (
          <button
            type="button"
            data-card-action="end"
            disabled={busy !== null}
            onClick={() => {
              onEnd(session);
            }}
            className="rounded border border-red-700 px-3 py-2 text-sm font-medium text-red-800 disabled:opacity-60 dark:border-red-500 dark:text-red-300"
          >
            {busy === "end" ? "Ending…" : "End browser session"}
          </button>
        ) : null}
      </div>
    </li>
  );
}
