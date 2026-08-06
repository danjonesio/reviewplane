/**
 * Route table (ADR-0011: TanStack Router).
 *
 * Routes are declared in code rather than generated from the file system, so
 * the tree is one readable value and a build needs no code generator. The tree
 * mirrors the information architecture of `docs/UX_FLOWS.md` section 2: the
 * primary surfaces at the top level, and the within-project surfaces as
 * children of the project they belong to.
 */

import { createRouter } from "@tanstack/react-router";

import {
  projectConnectorRoute,
  projectEnrolConnectorRoute,
  projectEnvironmentsRoute,
} from "./routes/environments.tsx";
import {
  projectLiveRoute,
  projectOverviewRoute,
  projectReviewsRoute,
  projectRoute,
  projectSettingsRoute,
} from "./routes/project.tsx";
import { projectNewRoute } from "./routes/project-new.tsx";
import { projectsRoute } from "./routes/projects.tsx";
import { findingRoute } from "./routes/finding.tsx";
import { reviewRoute } from "./routes/review.tsx";
import { reviewsRoute } from "./routes/reviews.tsx";
import { rootRoute } from "./routes/root.tsx";
import { sessionRoute } from "./routes/session.tsx";
import { sessionsRoute } from "./routes/sessions.tsx";

const routeTree = rootRoute.addChildren([
  sessionsRoute,
  sessionRoute,
  reviewsRoute,
  reviewRoute,
  findingRoute,
  projectsRoute,
  projectNewRoute,
  projectRoute.addChildren([
    projectOverviewRoute,
    projectLiveRoute,
    projectReviewsRoute,
    projectEnvironmentsRoute,
    projectEnrolConnectorRoute,
    projectConnectorRoute,
    projectSettingsRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: false,
  defaultNotFoundComponent: () => (
    <section aria-labelledby="not-found-heading">
      <h1 id="not-found-heading" className="text-xl font-semibold">
        No such page
      </h1>
      <p className="mt-2 text-sm">The address does not match a ReviewPlane surface.</p>
    </section>
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
