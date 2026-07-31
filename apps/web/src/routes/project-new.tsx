/**
 * Project creation (`docs/UX_FLOWS.md` section 4).
 *
 * The documented flow, in order: name, repository identity, default branch,
 * default validation viewports, save, then the connector enrolment
 * instructions. The last step is why this is a two-state page rather than a
 * form that navigates away — a project with no environment cannot do anything
 * yet, and the next thing the person needs is the command that gives it one.
 *
 * Validation is the server's. The form previews the slug and the normalised
 * repository identity so the outcome is visible before saving, but nothing here
 * decides whether a value is acceptable: a second implementation of the rules
 * would eventually disagree with the one that enforces them.
 */

import { Link, createRoute } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactElement } from "react";

import { ApiFailure, api, type Project, type ValidationViewport } from "../api/client.ts";
import { formatViewport } from "./projects.tsx";
import { rootRoute } from "./root.tsx";

const FIELD =
  "rounded border border-slate-400 bg-white px-3 py-2 text-base dark:border-slate-600 dark:bg-slate-900";

/**
 * The viewports offered. The first two are the defaults `AGENTS.md` requires
 * everything to be checked at; the rest are common enough to be worth a
 * checkbox rather than a settings file.
 */
const VIEWPORT_CHOICES: readonly ValidationViewport[] = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
  { width: 1920, height: 1080 },
];

function previewSlug(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 63);
}

function Created({ project }: { readonly project: Project }): ReactElement {
  return (
    <section aria-labelledby="created-heading">
      <h1 id="created-heading" className="text-xl font-semibold">
        {project.name} is ready
      </h1>
      <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
        Next, give the project a development environment. Run this on the machine the application
        runs on. The token is shown once and expires.
      </p>
      <pre className="mt-4 overflow-x-auto rounded border border-slate-300 bg-slate-50 p-4 text-xs dark:border-slate-700 dark:bg-slate-950">
        <code>{`sudo reviewplane-connector enrol \\
  --control-plane ${globalThis.location.origin} \\
  --project ${project.slug} \\
  --token <one-time-token>`}</code>
      </pre>
      <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
        Mint the enrolment token from the project&apos;s Environments tab. The connector dials out;
        it never opens a port on the development machine.
      </p>
      <p className="mt-6 flex flex-wrap gap-3">
        <Link
          to="/projects/$projectId"
          params={{ projectId: project.id }}
          className="rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800"
        >
          Open {project.name}
        </Link>
        <Link to="/projects" className="rounded border border-slate-400 px-4 py-2 text-sm font-medium">
          All projects
        </Link>
      </p>
    </section>
  );
}

function NewProject(): ReactElement {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("main");
  const [viewports, setViewports] = useState<readonly string[]>([
    formatViewport(VIEWPORT_CHOICES[0] as ValidationViewport),
    formatViewport(VIEWPORT_CHOICES[1] as ValidationViewport),
  ]);
  const [created, setCreated] = useState<Project | null>(null);

  const save = useMutation({
    mutationFn: async () =>
      api.createProject({
        name,
        ...(repository.trim() === "" ? {} : { repository_identity: repository.trim() }),
        default_branch: branch.trim() === "" ? "main" : branch.trim(),
        settings: {
          default_validation_viewports: VIEWPORT_CHOICES.filter((viewport) =>
            viewports.includes(formatViewport(viewport)),
          ),
        },
      }),
    onSuccess: async (project) => {
      setCreated(project);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  if (created !== null) return <Created project={created} />;

  const failure = save.error;
  const message =
    failure instanceof ApiFailure
      ? failure.message
      : failure === null
        ? null
        : "The project could not be created.";
  const slug = previewSlug(name);

  return (
    <section aria-labelledby="new-project-heading" className="max-w-2xl">
      <h1 id="new-project-heading" className="text-xl font-semibold">
        New project
      </h1>
      <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
        A project owns its environments, browser sessions and reviews. Nothing is shared with
        another project.
      </p>

      <form
        className="mt-6 flex flex-col gap-5"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <div className="flex flex-col gap-2">
          <label htmlFor="project-name" className="text-sm font-medium">
            Project name
          </label>
          <input
            id="project-name"
            name="project-name"
            type="text"
            required
            maxLength={200}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            className={FIELD}
            aria-describedby="project-name-hint"
          />
          <p id="project-name-hint" className="text-xs text-slate-600 dark:text-slate-400">
            {slug === ""
              ? "The address for this project is derived from its name."
              : `Address: /projects/${slug}`}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="repository" className="text-sm font-medium">
            Repository (optional)
          </label>
          <input
            id="repository"
            name="repository"
            type="text"
            value={repository}
            onChange={(event) => {
              setRepository(event.target.value);
            }}
            className={`${FIELD} font-mono`}
            placeholder="git@github.com:example/refresh-surplus.git"
            aria-describedby="repository-hint"
          />
          <p id="repository-hint" className="text-xs text-slate-600 dark:text-slate-400">
            An SSH or HTTPS clone URL. It is stored in a provider-agnostic form, so both spellings
            of the same repository are recognised as one.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="default-branch" className="text-sm font-medium">
            Default branch
          </label>
          <input
            id="default-branch"
            name="default-branch"
            type="text"
            value={branch}
            onChange={(event) => {
              setBranch(event.target.value);
            }}
            className={`${FIELD} font-mono`}
          />
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Default validation viewports</legend>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Findings in this project are expected to be validated at these sizes.
          </p>
          {VIEWPORT_CHOICES.map((viewport) => {
            const label = formatViewport(viewport);
            const id = `viewport-${label}`;
            return (
              <div key={label} className="flex items-center gap-2">
                <input
                  id={id}
                  name="viewports"
                  type="checkbox"
                  className="h-4 w-4"
                  checked={viewports.includes(label)}
                  onChange={(event) => {
                    setViewports((current) =>
                      event.target.checked
                        ? [...current, label]
                        : current.filter((entry) => entry !== label),
                    );
                  }}
                />
                <label htmlFor={id} className="text-sm">
                  {label}
                </label>
              </div>
            );
          })}
        </fieldset>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-60"
            disabled={save.isPending || viewports.length === 0}
          >
            {save.isPending ? "Creating…" : "Create project"}
          </button>
          <Link to="/projects" className="text-sm underline-offset-4 hover:underline">
            Cancel
          </Link>
        </div>

        {viewports.length === 0 ? (
          <p role="status" className="text-sm text-slate-700 dark:text-slate-300">
            Choose at least one validation viewport.
          </p>
        ) : null}

        {message === null ? null : (
          <p role="alert" className="text-sm font-medium text-red-800 dark:text-red-300">
            {message}
          </p>
        )}
      </form>
    </section>
  );
}

export const projectNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/new",
  component: NewProject,
});
