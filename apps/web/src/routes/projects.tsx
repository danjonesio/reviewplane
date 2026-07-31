/**
 * The project list.
 *
 * A project is the principal working boundary (`docs/DOMAIN_MODEL.md` section
 * 6), so this is the page a human uses to run more than one piece of work
 * without their reviews, connectors or browser sessions leaking across.
 */

import { Link, createRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { api, type Project } from "../api/client.ts";
import { rootRoute } from "./root.tsx";

export function formatViewport(viewport: {
  readonly width: number;
  readonly height: number;
  readonly device_scale_factor?: number;
}): string {
  const scale = viewport.device_scale_factor ?? 1;
  const base = `${String(viewport.width)}x${String(viewport.height)}`;
  return scale === 1 ? base : `${base}@${String(scale)}x`;
}

function ProjectRow({ project }: { readonly project: Project }): ReactElement {
  return (
    <li className="rounded border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold">
            <Link
              to="/projects/$projectId"
              params={{ projectId: project.id }}
              className="underline-offset-4 hover:underline"
            >
              {project.name}
            </Link>
          </h3>
          <p className="mt-1 break-all font-mono text-xs text-slate-600 dark:text-slate-400">
            {project.slug}
          </p>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-slate-600 dark:text-slate-400">Repository</dt>
          <dd className="truncate font-mono">
            {project.repository_identity?.canonical ?? "not associated"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">Default branch</dt>
          <dd className="truncate font-mono">{project.default_branch}</dd>
        </div>
      </dl>
    </li>
  );
}

function Projects(): ReactElement {
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.projects() });

  return (
    <section aria-labelledby="projects-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 id="projects-heading" className="text-xl font-semibold">
          Projects
        </h1>
        <Link
          to="/projects/new"
          className="rounded bg-sky-700 px-3 py-2 text-sm font-medium text-white hover:bg-sky-800"
        >
          New project
        </Link>
      </div>
      <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
        Every review, connector and browser session belongs to exactly one project. Two projects
        never see each other&apos;s work.
      </p>

      {projects.isPending ? <p role="status">Loading projects.</p> : null}

      {projects.data !== undefined && projects.data.length === 0 ? (
        <div className="mt-6 rounded border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
          <h2 className="text-base font-semibold">No project yet</h2>
          <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
            Nothing is wrong: a new installation has no projects. Create one to enrol a connector
            and start a browser session.
          </p>
        </div>
      ) : (
        <ul className="mt-6 flex flex-col gap-4">
          {(projects.data ?? []).map((project) => (
            <ProjectRow key={project.id} project={project} />
          ))}
        </ul>
      )}
    </section>
  );
}

export const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
  component: Projects,
});
