/**
 * The session list: "what browsers are running, and which do I want to watch?"
 *
 * It is the reduced form of the fleet dashboard of `docs/UX_FLOWS.md` section
 * 3 — no thumbnails, no agent activity, no actions beyond opening a session —
 * but the same information architecture, so the dashboard grows here rather
 * than replacing this.
 */

import { Link, createRoute } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { api, isActive, type BrowserSession, type Project } from "../api/client.ts";
import { useSession } from "../auth/session.ts";
import { StatusBadge, type Tone } from "../components/StatusBadge.tsx";
import { rootRoute } from "./root.tsx";

const TONE_FOR_SESSION: Readonly<Record<string, Tone>> = {
  REQUESTED: "waiting",
  ALLOCATING: "waiting",
  READY: "live",
  ACTIVE: "live",
  PAUSED: "warning",
  DEGRADED: "warning",
  TERMINATING: "neutral",
  TERMINATED: "neutral",
  FAILED: "failed",
};

function SessionRow({
  session,
  project,
}: {
  readonly session: BrowserSession;
  readonly project: Project | undefined;
}): ReactElement {
  return (
    <li className="rounded border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold">
            <Link
              to="/sessions/$sessionId"
              params={{ sessionId: session.id }}
              className="underline-offset-4 hover:underline"
            >
              {project?.name ?? session.project_id}
            </Link>
          </h3>
          <p className="mt-1 break-all font-mono text-xs text-slate-600 dark:text-slate-400">
            {session.id}
          </p>
        </div>
        <StatusBadge tone={TONE_FOR_SESSION[session.status] ?? "neutral"} label={session.status} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-slate-600 dark:text-slate-400">Viewport</dt>
          <dd className="font-mono">
            {session.viewport.width}x{session.viewport.height} @{" "}
            {session.viewport.device_scale_factor}x
          </dd>
        </div>
        <div className="col-span-2 min-w-0 sm:col-span-1">
          <dt className="text-slate-600 dark:text-slate-400">Application</dt>
          {/* Page-derived, so it is text and never a link the page controls. */}
          <dd className="truncate font-mono">{session.service_origin ?? "not published"}</dd>
        </div>
        <div>
          <dt className="text-slate-600 dark:text-slate-400">Started</dt>
          <dd>{new Date(session.created_at).toLocaleTimeString()}</dd>
        </div>
      </dl>
      <p className="mt-3">
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId: session.id }}
          className="inline-block rounded border border-slate-400 px-3 py-2 text-sm font-medium"
        >
          Open live view
        </Link>
      </p>
    </li>
  );
}

function Sessions(): ReactElement {
  // The shell has already established that somebody is signed in; this page
  // reads the same session rather than asking again, so a sign-out clears every
  // surface at once.
  const session = useSession();
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.projects(),
    enabled: session.data !== undefined,
  });
  const projectIds = projects.data?.map((project) => project.id) ?? [];
  const sessionQueries = useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: ["browser-sessions", projectId],
      queryFn: () => api.browserSessions(projectId),
      // A restarted control plane must not leave a stale list behind: the
      // list refreshes on its own and on every window focus.
      refetchInterval: 5000,
    })),
  });

  if (session.isPending) return <p role="status">Loading.</p>;

  const sessions = sessionQueries
    .flatMap((query) => query.data ?? [])
    .filter((browserSession) => isActive(browserSession))
    .sort((left, right) => right.created_at.localeCompare(left.created_at));

  const byId = new Map((projects.data ?? []).map((project) => [project.id, project]));

  return (
    <section aria-labelledby="sessions-heading">
      <h1 id="sessions-heading" className="text-xl font-semibold">
        Live sessions
      </h1>
      <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
        Signed in as {session.data?.user?.email ?? session.data?.session.display ?? "this session"}.
        Chromium runs centrally; each session reaches its application through a private route.
      </p>

      {projects.isPending ? <p role="status">Loading projects.</p> : null}

      {sessions.length === 0 && !projects.isPending ? (
        <div className="mt-6 rounded border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
          <h2 className="text-base font-semibold">No browser session is running</h2>
          <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
            A session appears here as soon as an agent or an operator starts one. Nothing is wrong:
            this list is empty because no browser has been allocated yet.
          </p>
        </div>
      ) : (
        <ul className="mt-6 flex flex-col gap-4">
          {sessions.map((session) => (
            <SessionRow key={session.id} session={session} project={byId.get(session.project_id)} />
          ))}
        </ul>
      )}
    </section>
  );
}

export const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Sessions,
});
