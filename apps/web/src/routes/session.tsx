/**
 * One session's live view.
 *
 * This is the seed of the session room of `docs/UX_FLOWS.md` section 7. Stage
 * 0 deliberately omits the activity, findings, approvals, console, network,
 * Git and trace panels; what is here is the browser surface and the session
 * facts a human needs to decide whether what they are looking at is worth
 * annotating.
 */

import { Link, createRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState, type ReactElement } from "react";

import { api, ApiFailure } from "../api/client.ts";
import { LiveSurface } from "../components/LiveSurface.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { rootRoute } from "./root.tsx";

function SessionView(): ReactElement {
  const { sessionId } = sessionRoute.useParams();
  const [liveStatus, setLiveStatus] = useState<{ status: string; url: string | null } | null>(null);

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
          <dd className="font-mono">{record.control_epoch}</dd>
        </div>
        <div>
          <dt className="text-slate-600 dark:text-slate-400">Started</dt>
          <dd>{new Date(record.created_at).toLocaleString()}</dd>
        </div>
      </dl>

      <LiveSurface session={record} onSessionStatus={onSessionStatus} />
    </section>
  );
}

export const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$sessionId",
  component: SessionView,
});
