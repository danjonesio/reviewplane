/**
 * One session's live view.
 *
 * This is the seed of the session room of `docs/UX_FLOWS.md` section 7. The
 * activity, findings, approvals, console, network and trace panels are still
 * absent; what is here is the browser surface, the session facts a human needs
 * to decide whether what they are looking at is worth annotating, and the Git
 * panel — which arrived with the connector-reported workspaces of
 * `docs/DOMAIN_MODEL.md` section 9.
 */

import { Link, createRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useState, type ReactElement } from "react";

import { api, ApiFailure, type BrowserSession } from "../api/client.ts";
import { GitContextPanel } from "../components/GitContext.tsx";
import { LiveSurface } from "../components/LiveSurface.tsx";
import { BROWSER_SESSION_REFUSALS, RefusalPanel } from "../components/refusals.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { rootRoute } from "./root.tsx";

const CONTROL =
  "rounded border border-slate-400 px-3 py-2 text-sm font-medium disabled:opacity-60 dark:border-slate-600";

/** Statuses a running browser can be paused from (`docs/DOMAIN_MODEL.md` §12). */
const PAUSABLE: readonly string[] = ["READY", "ACTIVE"];

/** What a control action left behind, as a sentence rather than a state change. */
function controlSentence(session: BrowserSession, verb: string): string {
  return `The browser session was ${verb}. It is now ${session.status}, at control epoch ${String(session.control_epoch)}.`;
}

function SessionView(): ReactElement {
  const { sessionId } = sessionRoute.useParams();
  const [liveStatus, setLiveStatus] = useState<{ status: string; url: string | null } | null>(null);
  const [activity, setActivity] = useState("");

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
      return api.terminateBrowserSession(sessionId);
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
          {code === "RESOURCE_NOT_FOUND"
            ? "That browser session no longer exists"
            : code === "PROJECT_CONTEXT_MISMATCH"
              ? "This project is not yours to view"
              : "The browser session could not be loaded"}
        </h1>
        <p className="mt-2 text-sm">
          {failure instanceof Error ? failure.message : "The control plane refused the request."}
        </p>
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

  return (
    <section aria-labelledby="session-heading" className="flex flex-col gap-6">
      <div>
        <p className="text-sm">
          <Link to="/" className="underline underline-offset-4">
            Live sessions
          </Link>
        </p>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <h1 id="session-heading" className="min-w-0 break-all font-mono text-lg font-semibold">
            {record.id}
          </h1>
          <StatusBadge
            tone={status === "FAILED" ? "failed" : status === "ACTIVE" ? "live" : "neutral"}
            label={`Session ${status}`}
          />
        </div>
      </div>

      {/*
        Pause, resume and end (`docs/UX_FLOWS.md` section 7). What is offered is
        decided by the record rather than by the live stream: the control plane
        is authoritative for a session's lifecycle, and a stream reporting a
        status it observed a moment ago would otherwise offer an action the
        control plane is about to refuse.
      */}
      <div className="flex flex-col gap-3">
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
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        <div className="sm:col-span-2">
          <dt className="text-slate-600 dark:text-slate-400">Current URL</dt>
          {/*
            Page-derived (ADR-0010). It is displayed as text, never as an
            anchor the page could aim at the control-plane origin.
          */}
          <dd className="break-all font-mono">{url ?? "no application published"}</dd>
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
            words rather than left blank.
          */}
          <dt className="text-slate-600 dark:text-slate-400">Controller</dt>
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

      <LiveSurface session={record} onSessionStatus={onSessionStatus} />

      {/*
        The Git panel of `docs/UX_FLOWS.md` section 7, after the browser surface
        rather than beside it: at 390 px the layout is one column, and the
        picture is what a person opened this page for.
      */}
      <GitContextPanel projectId={record.project_id} />
    </section>
  );
}

export const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$sessionId",
  component: SessionView,
});
