/**
 * `@reviewplane/protocol/mcp` — the version 1 agent-facing contract of
 * `docs/MCP_SPEC.md`.
 *
 * It is a separate entry point from the package root, from `/browser`, from
 * `/live-view` and from `/review` for the same reason those are separate from
 * one another: every protocol declares an `Envelope`, a `MessageType` and a
 * `LIMITS` block, and one namespace would make them indistinguishable at a call
 * site.
 *
 * Everything under `generated/mcp/v1/` is produced from
 * `schemas/mcp/v1.schema.json` by `pnpm protocol:generate`. Do not
 * hand-maintain a structurally equivalent type in `apps/mcp-server`, per
 * `docs/DEVELOPMENT.md` section 3.
 *
 * Three generated values carry rules rather than shapes, and callers are
 * expected to read them rather than restate them:
 *
 * * `MESSAGE_TYPE_VALUES` is the Stage 0 tool availability set of
 *   `docs/MCP_SPEC.md` section 14. The server registers exactly these, so a
 *   tool cannot be advertised without a result schema and a bound.
 * * `PAYLOAD_MAX_BYTES` is the per-tool response bound of section 13.
 * * `AGENT_TRANSITIONS` is the section 7.7 transition list, and
 *   `AgentFindingStatus` is an enumeration from which every final disposition
 *   is absent. That absence is the structural half of the `AGENTS.md` authority
 *   rule; the domain layer beneath is the second half.
 */

export * from "./generated/mcp/v1/index.ts";
export * from "./mcp-response.ts";
