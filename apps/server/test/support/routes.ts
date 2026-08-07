/**
 * The server's own route table, parsed from Fastify's `printRoutes`.
 *
 * Shared because more than one gate needs it, and because two copies of a
 * parser are two things that can disagree about what a route is.
 *
 * Reading Fastify's table rather than listing routes is the point, and it is
 * the same technique `backup-security.test.ts` uses for the same reason: a
 * route added under any prefix, by any plugin, is in scope. A list only ever
 * covers the routes somebody remembered, and the routes somebody forgot are
 * what a coverage check is for.
 */

export interface RegisteredRoute {
  readonly method: string;
  /** The Fastify template, parameters and all: `/api/v1/reviews/:reviewId`. */
  readonly route: string;
}

/**
 * Parses `app.printRoutes({ commonPrefix: false })`.
 *
 * The tree concatenates path fragments along each branch — `/api/v1/organisation`
 * with a child `s` is `/api/v1/organisations` — so the parser tracks depth and
 * joins ancestors rather than reading a path off each line.
 *
 * `HEAD` is dropped: Fastify registers one beside every `GET` and it runs the
 * same handler, so carrying it would double every matrix that uses this and
 * prove nothing twice.
 *
 * A caller MUST assert that the result is non-empty and contains a route it
 * knows about. A parser that silently returned nothing would make every
 * coverage check built on it vacuous, which is the failure these checks exist
 * to prevent.
 */
export function registeredRoutes(printed: string): RegisteredRoute[] {
  const segments: string[] = [];
  const routes: RegisteredRoute[] = [];
  for (const line of printed.split("\n")) {
    const match = /^((?:[│ ] {3})*)(?:├──|└──) (.*)$/u.exec(line);
    if (match === null) continue;
    const depth = (match[1] as string).length / 4;
    const rest = match[2] as string;
    const methods = / \(([A-Z, ]+)\)$/u.exec(rest);
    segments.length = depth;
    segments.push(methods === null ? rest : rest.slice(0, rest.length - methods[0].length));
    if (methods === null) continue;
    const route = segments.join("");
    for (const method of (methods[1] as string).split(",").map((entry) => entry.trim())) {
      if (method === "HEAD") continue;
      routes.push({ method, route });
    }
  }
  return routes;
}

/** `METHOD /path`, the key both gates compare against. */
export function routeKey(route: RegisteredRoute): string {
  return `${route.method} ${route.route}`;
}
