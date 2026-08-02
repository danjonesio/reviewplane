/**
 * Tool argument schemas, derived from the one source.
 *
 * `docs/DEVELOPMENT.md` section 3 and ADR-0013 forbid a hand-maintained type
 * that is structurally equivalent to a generated one. The MCP SDK's convenience
 * wrapper wants a Zod schema per tool, which would be exactly that: a second
 * declaration of `finding_submit_verification`'s arguments, free to drift from
 * `packages/protocol/schemas/mcp/v1.schema.json`.
 *
 * So this server registers low-level request handlers instead, and takes both
 * halves from the schema package:
 *
 * * `tools/list` advertises the JSON Schema extracted here, pruned to the
 *   definitions each tool actually references so the listing stays bounded
 *   (`docs/MCP_SPEC.md` section 13);
 * * `tools/call` validates arguments with the **generated validator** for that
 *   tool, so what the client was told and what the server enforces are produced
 *   from the same file.
 *
 * The pruning walks `$ref` transitively. A tool that gains an argument gains
 * its definitions automatically; there is no list to keep in step.
 */

import source from "@reviewplane/protocol/schemas/mcp/v1.schema.json" with { type: "json" };

import type { MessageType } from "@reviewplane/protocol/mcp";

interface SchemaDocument {
  readonly $defs: Record<string, Record<string, unknown>>;
}

const document = source as unknown as SchemaDocument;

const REF_PREFIX = "#/$defs/";

/**
 * Tools whose argument definition is not named after them.
 *
 * Most tools have a `${tool}_input` of their own. The browser tools of
 * `docs/MCP_SPEC.md` sections 7.3 and 7.4 do not, because several of them take
 * *exactly* the same arguments and the schema declares that once: pausing,
 * resuming and ending a session are all "a session and the epoch you believe is
 * current", and clicking is "a session, an epoch and one element of the current
 * snapshot". Sharing the definition is what makes it impossible for one of them
 * to drift into accepting an argument the others refuse.
 *
 * The map is here rather than in the schema because the schema already says it
 * — `x-protocol.messages` names each tool's *result* — and adding a parallel
 * input pointer for the fifteen tools that do not need one would be a second
 * declaration to keep in step. This is the exception list, and
 * `assertToolSetMatchesSchema` plus the contract test mean an entry that stops
 * resolving fails loudly rather than silently advertising nothing.
 */
const INPUT_DEFINITION: Partial<Record<MessageType, string>> = {
  browser_session_status: "browser_session_reference_input",
  browser_session_pause: "browser_session_control_input",
  browser_session_resume: "browser_session_control_input",
  browser_session_end: "browser_session_control_input",
  browser_click: "browser_element_input",
};

/** Every `$defs` name reachable from a node, including the node's own refs. */
function collectReferences(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const member of node) collectReferences(member, into);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "$ref" && typeof value === "string" && value.startsWith(REF_PREFIX)) {
      const name = value.slice(REF_PREFIX.length);
      if (!into.has(name)) {
        into.add(name);
        collectReferences(document.$defs[name], into);
      }
      continue;
    }
    collectReferences(value, into);
  }
}

/**
 * The JSON Schema for one tool's arguments, self-contained.
 *
 * `x-max-bytes` is stripped: it is this package's own bound annotation and
 * means nothing to a client, and leaving a private keyword in a published
 * schema invites somebody to depend on it.
 */
export function toolInputSchema(tool: MessageType): Record<string, unknown> {
  const definitionName = INPUT_DEFINITION[tool] ?? `${tool}_input`;
  const definition = document.$defs[definitionName];
  if (definition === undefined) {
    throw new Error(`the MCP schema declares no ${definitionName}`);
  }
  const referenced = new Set<string>();
  collectReferences(definition, referenced);
  const defs: Record<string, unknown> = {};
  for (const name of [...referenced].sort()) {
    defs[name] = strip(document.$defs[name] as Record<string, unknown>);
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...strip(definition),
    ...(Object.keys(defs).length === 0 ? {} : { $defs: defs }),
  };
}

function strip(node: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("x-")) continue;
    copy[key] =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? strip(value as Record<string, unknown>)
        : value;
  }
  return copy;
}

/** The human-facing description of a tool, taken from the schema's own text. */
export function toolResultDescription(tool: MessageType): string {
  const messages = (source as unknown as {
    "x-protocol": { messages: Record<string, { description: string }> };
  })["x-protocol"].messages;
  return messages[tool]?.description ?? "";
}

/** The argument description a client sees, taken from the input definition. */
export function toolInputDescription(tool: MessageType): string {
  const definition = document.$defs[INPUT_DEFINITION[tool] ?? `${tool}_input`];
  return (definition?.["description"] as string | undefined) ?? "";
}
