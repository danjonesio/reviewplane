/**
 * `@reviewplane/protocol/browser` — the version 1 browser-worker protocol.
 *
 * It is a separate entry point from the package root because both protocols
 * declare an `Envelope`, a `MessageType` and a `LIMITS` block; exporting them
 * from one namespace would make the two indistinguishable at a call site.
 *
 * Everything under `generated/browser/v1/` is produced from
 * `schemas/browser/v1.schema.json` by `pnpm protocol:generate`. Do not
 * hand-maintain a structurally equivalent type in `apps/server` or
 * `apps/browser-worker`, per `docs/DEVELOPMENT.md` section 3.
 */

export * from "./generated/browser/v1/index.ts";
export * from "./browser-frame.ts";
