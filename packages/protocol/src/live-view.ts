/**
 * `@reviewplane/protocol/live-view` — the version 1 live-view channel of
 * `docs/API.md` section 18.2.
 *
 * It is a separate entry point from the package root and from `/browser` for
 * the same reason those two are separate: all three protocols declare an
 * `Envelope`, a `MessageType` and a `LIMITS` block, and one namespace would
 * make them indistinguishable at a call site.
 *
 * Everything under `generated/live_view/v1/` is produced from
 * `schemas/live_view/v1.schema.json` by `pnpm protocol:generate`. Do not
 * hand-maintain a structurally equivalent type in `apps/server`,
 * `apps/browser-worker` or `apps/web`, per `docs/DEVELOPMENT.md` section 3.
 */

export * from "./generated/live_view/v1/index.ts";
export * from "./live-view-frame.ts";
export * from "./live-view-stream.ts";
