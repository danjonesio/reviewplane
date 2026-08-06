/**
 * The session room (`docs/UX_FLOWS.md` section 7).
 *
 * ```text
 * ┌──────────────────────────────────────────────────────────────┐
 * │ Project / Agent / Branch / Status                    Pause   │
 * ├───────────────────────────────────┬──────────────────────────┤
 * │           Live browser            │ Activity                 │
 * ├───────────────────────────────────┴──────────────────────────┤
 * │            Git | Screenshots | Session data                  │
 * └──────────────────────────────────────────────────────────────┘
 * ```
 *
 * Two differences from the drawing in section 7, both deliberate and both
 * recorded there:
 *
 * **Take control is absent.** Section 7 draws it beside Pause. It belongs to
 * human takeover, which is Stage 2: there is no control WebSocket, no pointer
 * or keyboard input and no "you are controlling this browser" state. The header
 * therefore states who holds the browser and reads it as a fact, and the room
 * says in words that watching is read-only. An affordance that could not take
 * control would leave a reader believing they had input authority they do not
 * have, which is the one failure this surface must not permit.
 *
 * **Console, Network, Trace and Approvals are absent rather than empty.**
 * Section 7 draws six tabs; three of them are Stage 2 evidence surfaces and
 * Approvals is Stage 4. `docs/UX_FLOWS.md` section 18 forbids showing a panel
 * as empty without explanation, so the tab strip names what is here and a note
 * beside it names what is not and when it arrives.
 *
 * The Activity panel reads the project event stream and shows only this
 * session's rows. It resumes from the last sequence it applied and refetches
 * when the server says the replay window has been exceeded; that machinery is
 * in `src/live/use-project-events.ts` because it is policy rather than layout.
 */

import { Link, createRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState, type ReactElement } from "react";

import { api, ApiFailure, type BrowserSession } from "../api/client.ts";
import { ActivityPanel, ActivityProvenanceNote } from "../components/ActivityPanel.tsx";
import { CaptureFinding } from "../components/CaptureFinding.tsx";
import type { BrowserOverlay } from "../components/BrowserOverlays.tsx";
import { GitContextPanel } from "../components/GitContext.tsx";
import { LiveSurface } from "../components/LiveSurface.tsx";
import { BROWSER_SESSION_REFUSALS, RefusalPanel } from "../components/refusals.tsx";
import { StatusBadge, type Tone } from "../components/StatusBadge.tsx";
import type { StreamedEvent } from "../live/events.ts";
import { statusLabel } from "../live/timeline.ts";
import { useProjectEvents } from "../live/use-project-events.ts";
import { rootRoute } from "./root.tsx";

const CONTROL =
  "rounded border border-slate-400 px-3 py-2 text-sm font-medium disabled:opacity-60 dark:border-slate-600";

const TAB = "rounded px-3 py-2 text-sm font-medium";
const ACTIVE_TAB = `${TAB} bg-slate-200 dark:bg-slate-800`;

const TONE_FOR_FLEET: Readonly<Record<string, Tone>> = {
  active: "live",
  waiting: "waiting",
  paused: "warning",
  blocked: "failed",
  disconnected: "neutral",
};

/** Statuses a running browser can be paused from (`docs/DOMAIN_MODEL.md` §12). */
const PAUSABLE: readonly string[] = ["READY", "ACTIVE"];

/** The bottom tabs this stage can fill. */
type RoomTab = "git" | "screenshots" | "data";

/** What a control action left behind, as a sentence rather than a state change. */
function controlSentence(session: BrowserSession, verb: string): string {
  return `The browser session was ${verb}. It is now ${session.status}, at control epoch ${String(session.control_epoch)}.`;
}

/**
 * Marks for the picture, derived from what the record actually holds.
 *
 * Agent pointer and intended-target messages are reserved in the live protocol
 * and are not sent (`docs/API.md` section 18.2), so nothing here can invent
 * them. What *is* recorded is a command policy refused, and that is worth a mark
 * even without a position: a reader watching a browser that will not do what the
 * agent asked deserves to see why on the surface rather than only in a list.
 */
function overlaysFrom(
  events: readonly { readonly type: string; readonly id: string; readonly summary: string }[],
  details: ReadonlyMap<string, readonly { label: string; value: string; pageDerived: boolean }[]>,
): readonly BrowserOverlay[] {
  const marks: BrowserOverlay[] = [];
  for (const event of events) {
    if (event.type !== "browser.command_rejected") continue;
    const rows = details.get(event.id) ?? [];
    const reason = rows.find((row) => row.label === "Reason" || row.label === "Refused as");
    const selector = rows.find((row) => row.label === "Selector");
    marks.push({
      id: event.id,
      kind: "policy_blocked",
      detail:
        selector === undefined
          ? (reason?.value ?? "A browser command was refused.")
          : `${reason?.value ?? "Refused"} — ${selector.value}`,
      ...(selector === undefined ? {} : { pageDerived: true }),
    });
    if (marks.length >= 5) break;
  }
  return marks;
}

function SessionView(): ReactElement {
  const { sessionId } = sessionRoute.useParams();
  const [liveStatus, setLiveStatus] = useState<{ status: string; url: string | null } | null>(null);
  const [activity, setActivity] = useState("");
  const [tab, setTab] = useState<RoomTab>("git");

  const session = useQuery({
    queryKey: ["browser-session", sessionId],
    queryFn: () => api.browserSession(sessionId),
    // The client refreshes session state on its own, which is what a viewer
    // that reconnects after a control-plane restart needs (docs/TESTING.md
    // section 11).
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
    retry: 3,
  });

  const projectId = session.data?.project_id;

  /**
   * Only this session's rows.
   *
   * The correlation carries the browser session an event belongs to
   * (`docs/EVENTS.md` section 5), so the filter is exact rather than a guess
   * from the payload. Events with no browser session — a review named, a
   * connector reconnecting — are the project's business and not this room's.
   */
  const belongsHere = useCallback(
    (event: StreamedEvent) => event.correlation["browser_session_id"] === sessionId,
    [sessionId],
  );

  const stream = useProjectEvents(projectId, { filter: belongsHere });

  const workspaces = useQuery({
    queryKey: ["session-workspaces", projectId],
    queryFn: async () => {
      const environments = await api.environments(projectId ?? "");
      return environments.flatMap((environment) => environment.workspaces);
    },
    enabled: projectId !== undefined,
    refetchInterval: 15_000,
  });

  const overlays = useMemo(() => {
    const details = new Map(stream.entries.map((entry) => [entry.id, entry.details]));
    return overlaysFrom(stream.entries, details);
  }, [stream.entries]);

  const onSessionStatus = useCallback((status: string, url: string | null) => {
    setLiveStatus({ status, url });
  }, []);

  /**
   * Pause, resume and end, as one mutation.
   *
   * All three answer with the session as it now is, and all three fail in the
   * same vocabulary, so one refusal panel and one live region serve them. Both
   * failures that mean "what this page believes is out of date" read the record
   * again before the reader is asked to act on it: leaving a stale control
   * epoch on screen would invite a second request refused for the same reason
   * (`docs/DESIGN_PRINCIPLES.md` §6).
   */
  const control = useMutation({
    mutationFn: async (action: "paused" | "resumed" | "ended") => {
      const epoch = session.data?.control_epoch ?? 0;
      if (action === "paused") return api.pauseBrowserSession(sessionId, epoch);
      if (action === "resumed") return api.resumeBrowserSession(sessionId, epoch);
      return api.terminateBrowserSession(sessionId, epoch);
    },
    onSuccess: async (record, action) => {
      setActivity(controlSentence(record, action));
      await session.refetch();
    },
    onError: async (error) => {
      if (!(error instanceof ApiFailure)) return;
      if (error.code !== "CONTROL_EPOCH_STALE" && error.code !== "BROWSER_SESSION_NOT_ACTIVE") {
        return;
      }
      await session.refetch();
    },
  });

  if (session.isPending) {
    return <p role="status">Loading the browser session.</p>;
  }

  if (session.isError) {
    const failure = session.error;
    const code = failure instanceof ApiFailure ? failure.code : "INTERNAL_ERROR";
    return (
      <section aria-labelledby="session-error-heading">
        <h1 id="session-error-heading" className="text-xl font-semibold">
          The browser session could not be opened
        </h1>
        <RefusalPanel
          code={code}
          message={
            failure instanceof Error ? failure.message : "The control plane refused the request."
          }
          attribute="data-failure"
          table={BROWSER_SESSION_REFUSALS}
          surface="session-room"
        />
        <p className="mt-4">
          <Link to="/" className="rounded border border-slate-400 px-3 py-2 text-sm font-medium">
            Back to live sessions
          </Link>
        </p>
      </section>
    );
  }

  const record = session.data;
  const status = liveStatus?.status ?? record.status;
  const url = liveStatus?.url ?? record.service_origin;
  // The checkout a capture is interpreted against. A review names a branch and
  // a commit, and this project's registered workspace is the only place the
  // control plane knows them from; where there is none, the capture surface
  // says so rather than inventing a branch.
  const workspace = workspaces.data?.[0] ?? null;
  const label = statusLabel(status);

  return (
    <section aria-labelledby="session-heading" className="flex flex-col gap-6">
      {/* ── Header: project, agent, branch, status, and Pause ───────────── */}
      <header className="flex flex-col gap-3">
        <p className="text-sm">
          <Link to="/" className="underline underline-offset-4">
            Live sessions
          </Link>
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 id="session-heading" className="min-w-0 break-all text-lg font-semibold">
            <Link
              to="/projects/$projectId"
              params={{ projectId: record.project_id }}
              className="underline-offset-4 hover:underline"
            >
              {record.project_id}
            </Link>
            <span className="ml-2 font-mono text-sm font-normal">{record.id}</span>
          </h1>
          <StatusBadge
            tone={TONE_FOR_FLEET[label.status] ?? "neutral"}
            label={label.word}
            detail={label.domainStatus}
          />
        </div>
        <p className="text-xs text-slate-600 dark:text-slate-400">{label.explanation}</p>

        <div className="flex flex-wrap gap-2">
          {PAUSABLE.includes(record.status) ? (
            <button
              type="button"
              id="session-pause"
              disabled={control.isPending}
              onClick={() => {
                control.mutate("paused");
              }}
              className={CONTROL}
            >
              {control.isPending && control.variables === "paused" ? "Pausing…" : "Pause"}
            </button>
          ) : null}
          {record.status === "PAUSED" ? (
            <button
              type="button"
              id="session-resume"
              disabled={control.isPending}
              onClick={() => {
                control.mutate("resumed");
              }}
              className={CONTROL}
            >
              {control.isPending && control.variables === "resumed" ? "Resuming…" : "Resume"}
            </button>
          ) : null}
          {record.ended_at === null ? (
            <button
              type="button"
              id="session-end"
              disabled={control.isPending}
              onClick={() => {
                control.mutate("ended");
              }}
              className="rounded border border-red-700 px-3 py-2 text-sm font-medium text-red-800 disabled:opacity-60 dark:border-red-500 dark:text-red-300"
            >
              {control.isPending && control.variables === "ended" ? "Ending…" : "End session"}
            </button>
          ) : null}
        </div>

        {/* Outcomes are announced here without moving focus. */}
        <p
          id="session-control-activity"
          role="status"
          aria-live="polite"
          className="text-sm text-slate-700 dark:text-slate-300"
        >
          {activity}
        </p>

        {control.error === null ? null : (
          <RefusalPanel
            code={control.error instanceof ApiFailure ? control.error.code : "INTERNAL_ERROR"}
            message={
              control.error instanceof ApiFailure
                ? control.error.message
                : "The browser session could not be changed."
            }
            attribute="data-refusal"
            table={BROWSER_SESSION_REFUSALS}
            surface="session-control"
          />
        )}

        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          <div className="sm:col-span-2 min-w-0">
            <dt className="text-slate-600 dark:text-slate-400">Current route</dt>
            {/*
              Page-derived (ADR-0010). It is displayed as text, never as an
              anchor the page could aim at the control-plane origin.
            */}
            <dd className="break-all font-mono" data-session-route={url ?? ""}>
              {url ?? "no application published"}
            </dd>
          </div>
          <div>
            <dt className="text-slate-600 dark:text-slate-400">Viewport</dt>
            <dd className="font-mono">
              {record.viewport.width}x{record.viewport.height} @{" "}
              {record.viewport.device_scale_factor}x
            </dd>
          </div>
          <div>
            <dt className="text-slate-600 dark:text-slate-400">Browser</dt>
            <dd className="font-mono">chromium {record.browser_version ?? "unknown"}</dd>
          </div>
          <div>
            <dt className="text-slate-600 dark:text-slate-400">Control epoch</dt>
            <dd id="session-control-epoch" className="font-mono">
              {record.control_epoch}
            </dd>
          </div>
          <div className="min-w-0">
            {/*
              Exactly one controller drives a browser at a time, and the epoch
              above is meaningless without knowing whose it is. Nobody holding
              control is a real state, not a missing value, so it is written as
              words rather than left blank. This is read-only: Stage 1 offers no
              way to take the lease, and the sentence below says so rather than
              leaving the absence of a button to imply it.
            */}
            <dt className="text-slate-600 dark:text-slate-400">Controller (read-only)</dt>
            <dd id="session-controller" className="break-all font-mono">
              {record.current_controller === null || record.current_controller === undefined
                ? "nobody holds control"
                : `${record.current_controller.type} ${record.current_controller.id}`}
            </dd>
          </div>
          <div>
            <dt className="text-slate-600 dark:text-slate-400">Started</dt>
            <dd>{new Date(record.created_at).toLocaleString()}</dd>
          </div>
        </dl>

        <p
          data-readonly-notice="control"
          className="rounded border border-slate-300 p-3 text-sm text-slate-700 dark:border-slate-700 dark:text-slate-300"
        >
          You are watching this browser, not driving it. Taking interactive control is not offered
          at this stage, so nothing you do here sends a pointer or a keystroke to the page. Pause,
          Resume and End act on the session itself and are recorded against the control epoch above.
        </p>
      </header>

      {/* ── Live browser, and Activity beside it at desktop widths ───────── */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <LiveSurface session={record} onSessionStatus={onSessionStatus} overlays={overlays} />
          <CaptureFinding session={record} workspace={workspace} currentUrl={url} />
        </div>

        <ActivityPanel
          stream={stream}
          heading="Activity"
          headingId="session-activity-heading"
          surface="session-activity"
          emptyMessage="Nothing has been recorded for this browser session yet. Agent actions, findings and comments appear here in the order the control plane recorded them."
        />
      </div>

      <ActivityProvenanceNote />

      {/* ── Bottom tabs ─────────────────────────────────────────────────── */}
      <section aria-labelledby="session-tabs-heading">
        <h2 id="session-tabs-heading" className="sr-only">
          Session detail
        </h2>
        <div
          role="tablist"
          aria-label="Session detail"
          className="flex flex-wrap gap-1 border-b border-slate-300 pb-2 dark:border-slate-700"
        >
          {(
            [
              ["git", "Git"],
              ["screenshots", "Screenshots"],
              ["data", "Session data"],
            ] as const
          ).map(([value, text]) => (
            <button
              key={value}
              type="button"
              role="tab"
              id={`session-tab-${value}`}
              aria-selected={tab === value}
              aria-controls={`session-panel-${value}`}
              className={tab === value ? ACTIVE_TAB : TAB}
              onClick={() => {
                setTab(value);
              }}
            >
              {text}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
          Console, Network and Trace are not tabs here yet. They arrive with console and network
          evidence and trace capture; an empty tab would say less than this sentence does. Approvals
          arrive later still.
        </p>

        <div
          role="tabpanel"
          id={`session-panel-${tab}`}
          aria-labelledby={`session-tab-${tab}`}
          className="mt-4"
        >
          {tab === "git" ? (
            <GitContextPanel projectId={record.project_id} />
          ) : tab === "screenshots" ? (
            <SessionScreenshots sessionId={record.id} />
          ) : (
            <SessionData session={record} />
          )}
        </div>
      </section>
    </section>
  );
}

/**
 * Screenshots captured from this session.
 *
 * A live frame is not a screenshot and never becomes one (ADR-0009). What
 * appears here is what somebody explicitly captured, which is what "evidence"
 * means; saying so is the difference between a reader who understands the empty
 * state and one who thinks the recording failed.
 */
function SessionScreenshots({ sessionId }: { readonly sessionId: string }): ReactElement {
  const timeline = useQuery({
    queryKey: ["browser-session-timeline", sessionId],
    queryFn: () => api.browserSessionTimeline(sessionId, 100),
  });
  const captures = (timeline.data ?? []).filter(
    (entry) => entry.type === "screenshot.captured" || entry.type === "artefact.upload_completed",
  );

  return (
    <div>
      <h3 className="text-base font-semibold">Screenshots</h3>
      {timeline.isPending ? <p role="status">Reading the session timeline.</p> : null}
      {captures.length === 0 && !timeline.isPending ? (
        <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
          Nothing has been captured from this session. Live frames are never stored, so this list is
          empty until an agent or a human captures a screenshot; the picture above is not evidence
          and is not kept.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2 text-sm">
          {captures.map((entry) => (
            <li key={entry.id} className="flex flex-wrap gap-x-3">
              <span className="font-mono">{entry.type}</span>
              <span className="text-slate-600 dark:text-slate-400">
                {new Date(entry.occurred_at).toLocaleString()}
              </span>
              <span className="text-slate-600 dark:text-slate-400">
                {entry.actor.display ?? entry.actor.type}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The session record, as facts. Nothing here is page-derived except the route. */
function SessionData({ session }: { readonly session: BrowserSession }): ReactElement {
  return (
    <div>
      <h3 className="text-base font-semibold">Session data</h3>
      <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Session</dt>
          <dd className="break-all font-mono">{session.id}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Project</dt>
          <dd className="break-all font-mono">{session.project_id}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Organisation</dt>
          <dd className="break-all font-mono">{session.organisation_id}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Published route</dt>
          <dd className="break-all font-mono">{session.published_service_id ?? "none"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Domain status</dt>
          <dd className="font-mono">{session.status}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Ended</dt>
          <dd>{session.ended_at === null ? "still running" : new Date(session.ended_at).toLocaleString()}</dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-slate-600 dark:text-slate-400">
        Chromium runs on a browser worker in this deployment, not on your machine, and reaches the
        application through a private connector route rather than over the public internet.
      </p>
    </div>
  );
}

export const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$sessionId",
  component: SessionView,
});
