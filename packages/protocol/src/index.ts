/**
 * `@reviewplane/protocol` — the single versioned source for ReviewPlane
 * protocol schemas.
 *
 * Everything under `generated/` is produced from
 * `schemas/connector/v1.schema.json` by `pnpm protocol:generate`. Do not
 * hand-maintain a structurally equivalent type in a service: update the schema
 * and regenerate, per `docs/DEVELOPMENT.md` section 3.
 */

export * from "./generated/connector/v1/index.ts";
export * from "./canonical.ts";
export * from "./capability.ts";
export * from "./frame.ts";
export * from "./sensitive.ts";
export * from "./validate-runtime.ts";
