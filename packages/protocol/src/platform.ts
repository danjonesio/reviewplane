/**
 * `@reviewplane/protocol/platform` — the Stage 1 platform foundation: opaque
 * entity identifiers (`docs/DOMAIN_MODEL.md` section 3), the API response
 * metadata, stable error codes and refusal body of `docs/API.md` section 5, the
 * opaque pagination cursor of section 6, the event envelope and catalogue of
 * `docs/EVENTS.md`, and the project event-stream messages of `docs/API.md`
 * section 18.1.
 *
 * It is a separate entry point from the package root and from `/browser`,
 * `/live-view`, `/review` and `/mcp` for the same reason those are separate from
 * one another: every protocol declares an `Envelope`, a `MessageType` and a
 * `LIMITS` block, and one namespace would make them indistinguishable at a call
 * site.
 *
 * Everything under `generated/platform/v1/` is produced from
 * `schemas/platform/v1.schema.json` by `pnpm protocol:generate`. Do not
 * hand-maintain a structurally equivalent type in a service, per
 * `docs/DEVELOPMENT.md` section 3.
 *
 * This entry point runs in a browser as well as in Node: `apps/web` subscribes
 * to the project event stream and paginates collections, so nothing here
 * imports a Node built-in.
 */

export * from "./generated/platform/v1/index.ts";
export * from "./entity-id.ts";
export * from "./cursor.ts";
export * from "./platform-event.ts";
