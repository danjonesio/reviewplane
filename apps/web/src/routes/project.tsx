/**
 * The within-project shell and its surfaces (`docs/UX_FLOWS.md` section 2).
 *
 * ```text
 * Overview   Live   Reviews   Environments   Settings
 * ```
 *
 * That is the documented information architecture minus Policies, which
 * `docs/UX_FLOWS.md` section 2 permits the first release to hide and
 * `docs/DOMAIN_MODEL.md` section 22 defers to Stage 4. Hiding it is not the
 * same as forgetting it: the order and the naming are the documented ones, so
 * the tab appears between Environments and Settings when policies exist rather
 * than being designed again.
 *
 * Every surface here reads through the project-scoped API, so what a session
 * may see is decided by the control plane. Navigation reflects authorisation;
 * it never grants it (`docs/SECURITY.md` section 7).
 *
 * Environments is the exception to "one file": it owns connector enrolment and
 * connector health as well, and lives in `environments.tsx`.
 */

import { Link, Outlet, createRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactElement } from "react";

import { ApiFailure, api, isActive, type Project } from "../api/client.ts";
import { ActivityPanel, ActivityProvenanceNote } from "../components/ActivityPanel.tsx";
import { PublishedServices } from "../components/PublishedServices.tsx";
import { StartBrowserSession } from "../components/StartBrowserSession.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { useProjectEvents } from "../live/use-project-events.ts";
import { formatViewport } from "./projects.tsx";
import { rootRoute } from "./root.tsx";

const TAB = "rounded px-3 py-2 text-sm font-medium underline-offset-4 hover:underline";
const ACTIVE_TAB = `${TAB} bg-slate-200 dark:bg-slate-800`;

function useProject(): { readonly projectId: string; readonly project: Project | undefined } {
  const { projectId } = projectRoute.useParams();
  const query = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.project(projectId),
  });
  return { projectId, project: query.data };
}

function ProjectShell(): ReactElement {
  const { projectId } = projectRoute.useParams();
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.project(projectId),
    retry: false,
  });

  if (project.isPending) return <p role="status">Loading the project.</p>;
  if (project.isError) {
    return (
      <section aria-labelledby="project-error-heading">
        <h1 id="project-error-heading" className="text-xl font-semibold">
          No such project
        </h1>
        <p className="mt-2 text-sm">
          {project.error instanceof ApiFailure && project.error.status === 404
            ? "This project does not exist, or this session is not authorised for it."
            : "The project could not be loaded."}
        </p>
        <p className="mt-4">
          <Link to="/projects" className="underline-offset-4 hover:underline">
            All projects
          </Link>
        </p>
      </section>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{project.data.name}</h1>
        {project.data.status === "archived" ? (
          <StatusBadge tone="neutral" label="ARCHIVED" />
        ) : null}
      </div>
      <nav aria-label="Project" className="mt-4 flex flex-wrap gap-1 border-b border-slate-300 pb-2 dark:border-slate-700">
        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          activeOptions={{ exact: true }}
          className={TAB}
          activeProps={{ className: ACTIVE_TAB }}
        >
          Overview
        </Link>
        <Link
          to="/projects/$projectId/live"
          params={{ projectId }}
          className={TAB}
          activeProps={{ className: ACTIVE_TAB }}
        >
          Live
        </Link>
        <Link
          to="/projects/$projectId/reviews"
          params={{ projectId }}
          className={TAB}
          activeProps={{ className: ACTIVE_TAB }}
        >
          Reviews
        </Link>
        <Link
          to="/projects/$projectId/environments"
          params={{ projectId }}
          className={TAB}
          activeProps={{ className: ACTIVE_TAB }}
        >
          Environments
        </Link>
        <Link
          to="/projects/$projectId/settings"
          params={{ projectId }}
          className={TAB}
          activeProps={{ className: ACTIVE_TAB }}
        >
          Settings
        </Link>
      </nav>
      <div className="mt-6">
        <Outlet />
      </div>
    </div>
  );
}

function Overview(): ReactElement {
  const { projectId, project } = useProject();
  /*
    The project's own event timeline (`docs/EVENTS.md` section 10). It is the
    same record the session room reads, unfiltered: the exit criterion is that a
    user can read what happened without database access, and a page showing only
    the ten newest rows with no live delivery would send them back to `psql` the
    moment anything moved.
  */
  const stream = useProjectEvents(projectId);

  return (
    <section aria-labelledby="overview-heading">
      <h2 id="overview-heading" className="text-lg font-semibold">
        Overview
      </h2>
      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Repository</dt>
          <dd className="truncate font-mono">
            {project?.repository_identity?.canonical ?? "not associated"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Default branch</dt>
          <dd className="truncate font-mono">{project?.default_branch ?? ""}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Validation viewports</dt>
          <dd className="font-mono">
            {(project?.settings.default_validation_viewports ?? [])
              .map((viewport) => formatViewport(viewport))
              .join(", ")}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Address</dt>
          <dd className="truncate font-mono">{project?.slug ?? ""}</dd>
        </div>
      </dl>

      <div className="mt-8">
        <ActivityPanel
          stream={stream}
          heading="Activity"
          headingId="project-activity-heading"
          surface="project-activity"
          emptyMessage="Nothing has happened in this project yet. Every meaningful change is recorded here as it occurs."
        />
        <div className="mt-3">
          <ActivityProvenanceNote />
        </div>
      </div>
    </section>
  );
}

function ProjectLive(): ReactElement {
  const { projectId } = projectRoute.useParams();
  const sessions = useQuery({
    queryKey: ["browser-sessions", projectId],
    queryFn: () => api.browserSessions(projectId),
    refetchInterval: 5000,
  });
  const active = (sessions.data ?? []).filter((session) => isActive(session));

  return (
    <div>
      <section aria-labelledby="project-live-heading">
        <h2 id="project-live-heading" className="text-lg font-semibold">
          Live
        </h2>
        {/*
          Starting comes before the list it adds to, and before publication:
          `docs/UX_FLOWS.md` section 6 puts the human flow on this page, and the
          capacity state its refusals name sends a reader to the list below.
        */}
        <StartBrowserSession projectId={projectId} />
        <h3 className="mt-10 text-base font-semibold">Sessions running now</h3>
        {active.length === 0 ? (
          <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
            No browser session is running in this project. One appears here as soon as an agent or
            an operator starts one.
          </p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {active.map((session) => (
              <li
                key={session.id}
                className="rounded border border-slate-300 p-3 dark:border-slate-700"
              >
                <Link
                  to="/sessions/$sessionId"
                  params={{ sessionId: session.id }}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  Open live view
                </Link>
                <p className="mt-1 break-all font-mono text-xs text-slate-600 dark:text-slate-400">
                  {session.id}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
      {/*
        Publication sits beside the sessions it exists for: a session reaches an
        application only through a route (`docs/UX_FLOWS.md` section 6).
      */}
      <PublishedServices projectId={projectId} />
    </div>
  );
}

function ProjectReviews(): ReactElement {
  const { projectId } = projectRoute.useParams();
  const reviews = useQuery({
    queryKey: ["reviews", projectId],
    queryFn: () => api.reviews(projectId),
  });

  return (
    <section aria-labelledby="project-reviews-heading">
      <h2 id="project-reviews-heading" className="text-lg font-semibold">
        Reviews
      </h2>
      {reviews.data !== undefined && reviews.data.length === 0 ? (
        <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
          No review has been created in this project yet. A review appears once a human annotates a
          live session and names the result.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {(reviews.data ?? []).map((review) => (
            <li key={review.id} className="rounded border border-slate-300 p-3 dark:border-slate-700">
              <Link
                to="/reviews/$reviewId"
                params={{ reviewId: review.id }}
                className="font-medium underline-offset-4 hover:underline"
              >
                {review.title}
              </Link>
              <p className="mt-1 break-all font-mono text-xs text-slate-600 dark:text-slate-400">
                {review.slug}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProjectSettings(): ReactElement {
  const queryClient = useQueryClient();
  const { projectId, project } = useProject();
  const [name, setName] = useState<string | null>(null);
  const [repository, setRepository] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () =>
      api.updateProject(projectId, {
        ...(name === null ? {} : { name }),
        ...(repository === null || repository.trim() === ""
          ? {}
          : { repository_identity: repository.trim() }),
        ...(branch === null ? {} : { default_branch: branch }),
        ...(project === undefined ? {} : { expected_version: project.version }),
      }),
    onSuccess: async () => {
      setName(null);
      setRepository(null);
      setBranch(null);
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  const archive = useMutation({
    mutationFn: async () => api.archiveProject(projectId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  const failure = save.error ?? archive.error;
  const message =
    failure instanceof ApiFailure
      ? failure.message
      : failure === null || failure === undefined
        ? null
        : "The change could not be saved.";

  return (
    <section aria-labelledby="project-settings-heading" className="max-w-2xl">
      <h2 id="project-settings-heading" className="text-lg font-semibold">
        Settings
      </h2>
      <form
        className="mt-4 flex flex-col gap-5"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <div className="flex flex-col gap-2">
          <label htmlFor="settings-name" className="text-sm font-medium">
            Project name
          </label>
          <input
            id="settings-name"
            type="text"
            value={name ?? project?.name ?? ""}
            onChange={(event) => {
              setName(event.target.value);
            }}
            className="rounded border border-slate-400 bg-white px-3 py-2 text-base dark:border-slate-600 dark:bg-slate-900"
          />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="settings-repository" className="text-sm font-medium">
            Repository
          </label>
          <input
            id="settings-repository"
            type="text"
            value={repository ?? project?.repository_identity?.canonical ?? ""}
            onChange={(event) => {
              setRepository(event.target.value);
            }}
            className="rounded border border-slate-400 bg-white px-3 py-2 font-mono text-base dark:border-slate-600 dark:bg-slate-900"
            aria-describedby="settings-repository-hint"
          />
          <p id="settings-repository-hint" className="text-xs text-slate-600 dark:text-slate-400">
            Changing this is audited: a review captured before the change was interpreted against
            the previous repository.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="settings-branch" className="text-sm font-medium">
            Default branch
          </label>
          <input
            id="settings-branch"
            type="text"
            value={branch ?? project?.default_branch ?? ""}
            onChange={(event) => {
              setBranch(event.target.value);
            }}
            className="rounded border border-slate-400 bg-white px-3 py-2 font-mono text-base dark:border-slate-600 dark:bg-slate-900"
          />
        </div>
        <button
          type="submit"
          className="self-start rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-60"
          disabled={save.isPending}
        >
          {save.isPending ? "Saving…" : "Save changes"}
        </button>
        {message === null ? null : (
          <p role="alert" className="text-sm font-medium text-red-800 dark:text-red-300">
            {message}
          </p>
        )}
      </form>

      <h3 className="mt-10 text-base font-semibold">Archive</h3>
      <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
        Archiving hides the project from the list and stops new work. Nothing is deleted: its
        reviews, evidence and audit trail remain.
      </p>
      <button
        type="button"
        className="mt-3 rounded border border-red-700 px-4 py-2 text-sm font-medium text-red-800 disabled:opacity-60 dark:text-red-300"
        disabled={archive.isPending || project?.status === "archived"}
        onClick={() => {
          archive.mutate();
        }}
      >
        {project?.status === "archived" ? "Already archived" : "Archive project"}
      </button>
    </section>
  );
}

export const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
  component: ProjectShell,
});

export const projectOverviewRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/",
  component: Overview,
});

export const projectLiveRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "live",
  component: ProjectLive,
});

export const projectReviewsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "reviews",
  component: ProjectReviews,
});

export const projectSettingsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "settings",
  component: ProjectSettings,
});
