# ADR-0011: Vite React SPA for the web application

- Status: Accepted
- Date: 2026-07-29

## Context

The original technology baseline selected Astro with React islands for the web application. Astro's strengths are content-heavy, mostly static sites with small interactive islands. ReviewPlane's web application is the opposite shape: every surface sits behind authentication, there is no SEO or anonymous first-paint requirement, and the primary surfaces — live session room, annotation canvas, review and finding workflows, fleet dashboard — are highly interactive clients of the HTTP API and WebSocket channels. The architecture already anticipated that these surfaces would be client-rendered React applications mounted inside Astro, leaving Astro as a thin shell around a SPA. The marketing site lives at `reviewplane.dev` outside this repository, so no public content surface exists here.

## Decision

Build the web application as a client-rendered React single-page application:

- Vite build tooling
- React with TypeScript strict mode
- TanStack Router for type-safe routing
- TanStack Query for server-state management
- Tailwind CSS (unchanged)
- HTTP and WebSocket access through the shared `packages/protocol` types

The build output is static assets served by the gateway. The web application has no server-side rendering process.

## Consequences

### Positive

- One fewer runtime process; the gateway serves static assets directly
- No Astro/React island boundary; one client architecture
- Smaller, slower-moving framework surface
- Route-level code splitting is the only bundle-management mechanism required

### Negative

- No server rendering path if a public unauthenticated surface is ever added to this repository
- Initial bundle size must be actively managed with route-based code splitting

### Unchanged requirements

- Accessibility, keyboard navigation and visible focus
- Responsive behaviour at 390x844 and 1440x900
- Annotation geometry correctness under zoom, resize and device-pixel-ratio changes
- No runtime dependency on external CDNs, fonts or analytics

## Alternatives considered

- Astro with React islands: previous default; shell adds a framework boundary without benefit behind authentication
- Next.js: server-rendering and hosting assumptions misaligned with self-hosted deployment
- Remix / React Router framework mode: reintroduces a rendering server without benefit
- TanStack Start: too early-stage for a long-lived baseline
