/**
 * `@reviewplane/protocol/review` — the version 1 review domain of
 * `docs/DOMAIN_MODEL.md` sections 14 to 20, the request bodies of
 * `docs/API.md` sections 12 to 15 and the audit events of `docs/EVENTS.md`
 * section 7.
 *
 * It is a separate entry point from the package root, from `/browser` and from
 * `/live-view` for the same reason those are separate from one another: every
 * protocol declares an `Envelope`, a `MessageType` and a `LIMITS` block, and
 * one namespace would make them indistinguishable at a call site.
 *
 * Everything under `generated/review/v1/` is produced from
 * `schemas/review/v1.schema.json` by `pnpm protocol:generate`. Do not
 * hand-maintain a structurally equivalent type in `apps/server` or `apps/web`,
 * per `docs/DEVELOPMENT.md` section 3.
 *
 * This entry point runs in a browser as well as in Node, because `apps/web`
 * renders annotation overlays with `annotation-geometry.ts`.
 */

export * from "./generated/review/v1/index.ts";
export * from "./review-event.ts";
export * from "./review-transitions.ts";
export * from "./annotation-geometry.ts";
