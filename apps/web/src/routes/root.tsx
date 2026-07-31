/**
 * The application shell (`docs/UX_FLOWS.md` sections 2 and 19).
 *
 * It holds three things: the primary navigation, the project switcher, and the
 * authentication gate. The gate is here rather than on each page because
 * "signed out" is a property of the application and not of a route — and
 * because a page that rendered its own sign-in form would be a second place for
 * the first-run flow to drift.
 *
 * The navigation is the documented information architecture with the surfaces
 * that do not exist yet left out. `docs/UX_FLOWS.md` section 2 permits exactly
 * that — "the first release may hide unavailable team and policy surfaces while
 * preserving the information architecture" — and the point of preserving it is
 * that adding administration or policies later is a link, not a redesign.
 *
 * Accessibility baseline, applied once so every route inherits it: a skip link,
 * one landmark per region, and a heading that names the page.
 */

import { Link, Outlet, createRootRoute, useLocation } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { ApiFailure, api } from "../api/client.ts";
import { useBootstrapStatus, useSession } from "../auth/session.ts";
import { ProjectSwitcher } from "../components/ProjectSwitcher.tsx";
import { SignIn } from "../components/SignIn.tsx";

/** The project in the address bar, when the current route names one. */
function currentProjectId(pathname: string): string | null {
  const match = /^\/projects\/(?<projectId>[^/]+)/u.exec(pathname);
  const candidate = match?.groups?.["projectId"] ?? null;
  return candidate === "new" ? null : candidate;
}

function Shell(): ReactElement {
  const queryClient = useQueryClient();
  const location = useLocation();
  const session = useSession();
  // `status`, not `data`: a query that has failed keeps the data it last
  // succeeded with, so a signed-out application would go on rendering the
  // signed-in shell — and a page that looks signed in when it is not is how a
  // person ends up believing they have signed out when they have not.
  const signedIn = session.status === "success";
  const bootstrap = useBootstrapStatus(!signedIn && !session.isPending);

  const signOut = useMutation({
    mutationFn: () => api.signOut(),
    // Everything cached was read as this session. Clearing rather than
    // invalidating means no surface can paint another person's project list
    // for the moment before its refetch fails.
    onSuccess: () => {
      queryClient.clear();
    },
  });

  const projectId = currentProjectId(location.pathname);

  return (
    <div className="flex min-h-full flex-col">
      <a
        href="#main"
        className="sr-only absolute left-2 top-2 z-50 rounded bg-white px-3 py-2 text-sm font-medium text-slate-900 focus:not-sr-only dark:bg-slate-900 dark:text-slate-100"
      >
        Skip to main content
      </a>
      <header className="border-b border-slate-300 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
          <Link to="/" className="text-base font-semibold">
            ReviewPlane
          </Link>
          {signedIn ? (
            <>
              <nav aria-label="Primary" className="flex flex-wrap items-center gap-4 text-sm">
                <Link to="/" className="underline-offset-4 hover:underline">
                  Live sessions
                </Link>
                <Link to="/projects" className="underline-offset-4 hover:underline">
                  Projects
                </Link>
                <Link to="/reviews" className="underline-offset-4 hover:underline">
                  Reviews
                </Link>
              </nav>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <ProjectSwitcher projectId={projectId} enabled={signedIn} />
                <span className="text-slate-600 dark:text-slate-400" id="signed-in-as">
                  {session.data?.user?.email ?? session.data?.session.display ?? ""}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    signOut.mutate();
                  }}
                  className="rounded border border-slate-400 px-2 py-1 font-medium"
                >
                  Sign out
                </button>
              </div>
            </>
          ) : null}
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
        {session.isPending ? (
          <p role="status">Loading.</p>
        ) : signedIn ? (
          <Outlet />
        ) : (
          <SignIn status={bootstrap.data} />
        )}
      </main>
      <footer className="border-t border-slate-300 px-4 py-3 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-400">
        <div className="mx-auto max-w-5xl">
          Self-hosted. No frame leaves this deployment, and live frames are never stored.
        </div>
      </footer>
    </div>
  );
}

export const rootRoute = createRootRoute({
  component: Shell,
  errorComponent: ({ error }) => (
    <section aria-labelledby="error-heading" className="mx-auto max-w-5xl px-4 py-6">
      <h1 id="error-heading" className="text-xl font-semibold">
        {error instanceof ApiFailure ? error.code : "Something failed"}
      </h1>
      <p className="mt-2 text-sm">
        {error instanceof Error ? error.message : "The page could not be loaded."}
      </p>
    </section>
  ),
});
