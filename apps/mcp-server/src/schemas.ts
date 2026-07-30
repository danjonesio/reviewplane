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
  const definitionName = `${tool}_input`;
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
  const definition = document.$defs[`${tool}_input`];
  return (definition?.["description"] as string | undefined) ?? "";
}
