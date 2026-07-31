/**
 * The project switcher (`docs/UX_FLOWS.md` section 2).
 *
 * A project is the working boundary, so "which project am I in?" is a question
 * every screen has to answer and every screen has to let you change. It is a
 * native `<select>` rather than a custom menu: it is reachable and operable by
 * keyboard on every platform without a line of key handling, it is announced
 * correctly by screen readers, and on a 390px viewport the platform gives it a
 * usable picker for free.
 */

import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { api } from "../api/client.ts";

export function ProjectSwitcher({
  projectId,
  enabled,
}: {
  readonly projectId: string | null;
  readonly enabled: boolean;
}): ReactElement | null {
  const navigate = useNavigate();
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.projects(), enabled });

  if (!enabled) return null;
  const options = projects.data ?? [];

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="project-switcher" className="text-sm font-medium">
        Project
      </label>
      <select
        id="project-switcher"
        name="project-switcher"
        className="max-w-[14rem] truncate rounded border border-slate-400 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-900"
        value={projectId ?? ""}
        onChange={(event) => {
          const next = event.target.value;
          if (next === "new") {
            void navigate({ to: "/projects/new" });
            return;
          }
          if (next === "") return;
          void navigate({ to: "/projects/$projectId", params: { projectId: next } });
        }}
      >
        {projectId === null ? <option value="">Choose a project</option> : null}
        {options.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
        <option value="new">New project…</option>
      </select>
    </div>
  );
}
