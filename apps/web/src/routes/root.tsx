/**
 * The application shell.
 *
 * A skip link, one landmark per region and a heading that names the page: the
 * `docs/UX_FLOWS.md` section 19 baseline, applied at the shell so every route
 * inherits it rather than each remembering.
 */

import { Link, Outlet, createRootRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { api, ApiFailure } from "../api/client.ts";

function Shell(): ReactElement {
  const queryClient = useQueryClient();
  const viewer = useQuery({
    queryKey: ["viewer"],
    queryFn: () => api.currentViewer(),
    retry: false,
  });
  const signOut = useMutation({
    mutationFn: () => api.signOut(),
    onSuccess: () => queryClient.invalidateQueries(),
  });

  const signedIn = viewer.data !== undefined;

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
          <nav aria-label="Primary" className="flex items-center gap-4 text-sm">
            <Link to="/" className="underline-offset-4 hover:underline">
              Live sessions
            </Link>
            <Link to="/reviews" className="underline-offset-4 hover:underline">
              Reviews
            </Link>
            {signedIn ? (
              <button
                type="button"
                onClick={() => {
                  signOut.mutate();
                }}
                className="rounded border border-slate-400 px-2 py-1 font-medium"
              >
                Sign out
              </button>
            ) : null}
          </nav>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
        <Outlet />
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
