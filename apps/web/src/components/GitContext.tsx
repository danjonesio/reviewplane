/**
 * The Git context of a checkout a connector reported (`docs/UX_FLOWS.md`
 * section 7, `docs/DOMAIN_MODEL.md` section 9).
 *
 * Stage 1 records and displays what the connector observed and computes no
 * staleness — `docs/DOMAIN_MODEL.md` section 24 leaves that to the stage that
 * can compare a capture against a current workspace. So nothing here says
 * whether a reading is fresh, current or behind: a freshness claim this layer
 * cannot support would be worse than no claim at all.
 *
 * Every value below was reported by another machine, so every value is rendered
 * as text and never as a link (ADR-0010).
 */

import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { ApiFailure, api, type WorkspaceSummary } from "../api/client.ts";
import { StatusBadge } from "./StatusBadge.tsx";

/**
 * How much of a commit is shown. Twelve hexadecimal characters is what a person
 * quotes and what `git log --abbrev-commit` prints at this width; the whole
 * value stays in the title, so nothing is lost by shortening it.
 */
const ABBREVIATED_COMMIT = 12;

export function HeadCommit({ commit }: { readonly commit: string }): ReactElement {
  return (
    <span className="break-all font-mono" title={commit} data-head-commit={commit}>
      {commit.slice(0, ABBREVIATED_COMMIT)}
    </span>
  );
}

/** One checkout's branch, head commit and working-tree state. */
export function WorkspaceFacts({
  workspace,
}: {
  readonly workspace: WorkspaceSummary;
}): ReactElement {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      <div className="min-w-0">
        <dt className="text-slate-600 dark:text-slate-400">Checkout</dt>
        <dd className="break-all font-mono">{workspace.display_path}</dd>
      </div>
      <div className="min-w-0">
        <dt className="text-slate-600 dark:text-slate-400">Repository</dt>
        <dd className="break-all font-mono">
          {workspace.repository_identity ?? "no remote reported"}
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-slate-600 dark:text-slate-400">Branch</dt>
        <dd className="break-all font-mono" data-workspace-branch={workspace.branch}>
          {workspace.branch}
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-slate-600 dark:text-slate-400">Head commit</dt>
        <dd className="min-w-0">
          <HeadCommit commit={workspace.head_commit} />
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-slate-600 dark:text-slate-400">Working tree</dt>
        <dd className="mt-1">
          <StatusBadge
            tone={workspace.dirty ? "warning" : "neutral"}
            label={workspace.dirty ? "Uncommitted changes" : "No uncommitted changes"}
          />
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-slate-600 dark:text-slate-400">Observed</dt>
        {/*
          Absence arrives as `null` from the API and as an absent member in the
          schema; `new Date(null)` is 1970 rather than an error, so both are
          checked before anything is formatted.
        */}
        <dd>
          {workspace.last_observed_at === undefined || workspace.last_observed_at === null
            ? "not yet observed"
            : new Date(workspace.last_observed_at).toLocaleString()}
        </dd>
      </div>
    </dl>
  );
}

/**
 * The session room's Git panel.
 *
 * A browser session belongs to a project, and the checkouts this project's
 * connectors have reported are what the control plane knows about the code
 * behind the application on screen. Where more than one is known, all of them
 * are listed: choosing one would be a guess, and a guessed branch is exactly
 * the value `docs/API.md` section 4.3 says is worse than an absent one.
 */
export function GitContextPanel({ projectId }: { readonly projectId: string }): ReactElement {
  const environments = useQuery({
    queryKey: ["environments", projectId],
    queryFn: () => api.environments(projectId),
    refetchInterval: 5000,
  });

  const workspaces = (environments.data ?? []).flatMap((environment) =>
    environment.workspaces.map((workspace) => ({ environment, workspace })),
  );

  return (
    <section aria-labelledby="git-context-heading" className="flex flex-col gap-3">
      <h2 id="git-context-heading" className="text-lg font-semibold">
        Git context
      </h2>

      {environments.isPending ? <p role="status">Loading the workspace context.</p> : null}

      {environments.isError ? (
        <p role="alert" className="text-sm font-medium text-red-800 dark:text-red-300">
          {environments.error instanceof ApiFailure
            ? `${environments.error.code}: ${environments.error.message}`
            : "The workspace context could not be read."}
        </p>
      ) : null}

      {!environments.isPending && !environments.isError && workspaces.length === 0 ? (
        <div className="rounded border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold">No workspace is known for this project</h3>
          <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
            A connector reports the checkout it runs beside, and no connector has reported one
            here yet. Nothing is wrong with this session: it simply has no branch or commit to
            show.
          </p>
          <p className="mt-3 text-sm">
            <Link
              to="/projects/$projectId/environments"
              params={{ projectId }}
              className="underline underline-offset-4"
            >
              Enrol a connector for this project
            </Link>
          </p>
        </div>
      ) : null}

      {workspaces.map(({ environment, workspace }) => (
        <div
          key={workspace.id}
          className="rounded border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
          data-workspace={workspace.id}
        >
          <h3 className="text-base font-semibold">{environment.name}</h3>
          <div className="mt-3">
            <WorkspaceFacts workspace={workspace} />
          </div>
        </div>
      ))}
    </section>
  );
}
