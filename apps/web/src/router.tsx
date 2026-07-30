/**
 * Route table (ADR-0011: TanStack Router).
 *
 * Routes are declared in code rather than generated from the file system, so
 * the tree is one readable value and a build needs no code generator.
 */

import { createRouter } from "@tanstack/react-router";

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
