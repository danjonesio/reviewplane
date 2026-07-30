/**
 * MCP tool-response entry points: the only supported way to turn the bytes of
 * a tool response into protocol values.
 *
 * The order of the checks mirrors `frame.ts`, `browser-frame.ts`,
 * `live-view-frame.ts` and `review-event.ts` exactly: the byte bound is applied
 * to the raw response before any deserialisation, and only then are the
 * protocol version and the tool inspected. An unknown version or tool is
 * refused outright rather than best-effort parsed.
 *
 * Two things make this codec worth having on a surface that is JSON inside an
 * MCP content block rather than a wire frame.
 *
 * The **byte bounds are the section 13 limits**. `PAYLOAD_MAX_BYTES` is
 * generated from each tool's own `x-max-bytes`, so "apply per-tool size limits"
 * is a property of the schema rather than an intention in a handler. The server
 * encodes through `encodeMcpToolResponse` and therefore cannot emit a response
 * larger than the tool declares.
 *
 * And the **envelope's payload slot is named `data`**, because that is what
 * `docs/MCP_SPEC.md` section 5 calls it. The schema source says so in
 * `x-protocol.envelope_payload_property`; nothing renames it on the way out.
 */

import { byteLength } from "./canonical.ts";
import {
  decodeFrame,
  encodeFramePayload,
  validatePayload,
} from "./generated/mcp/v1/dispatch.ts";
import { encodeEnvelope } from "./generated/mcp/v1/encode.ts";
import {
  LIMITS,
  MESSAGE_TYPE_VALUES,
  PAYLOAD_MAX_BYTES,
  PROTOCOL_VERSION,
  PROTOCOL_VIOLATION_ERROR_CLASS,
  type Envelope,
  type ErrorClass,
  type McpFrame,
  type MessageType,
  type ProtocolViolationReason,
  type SchemaViolation,
  type TrustLabel,
  type Warning,
} from "./generated/mcp/v1/types.ts";
import { validateEnvelope } from "./generated/mcp/v1/validate.ts";

/** A refused response. `errorClass` is set only where the protocol defines one. */
export interface McpProtocolError {
  readonly reason: ProtocolViolationReason;
  readonly errorClass: ErrorClass | null;
  readonly message: string;
  readonly violations: readonly SchemaViolation[];
}

export type McpDecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: McpProtocolError };

export class McpResponseEncodeError extends Error {}

/**
 * The trust labels that mark content an agent must not act on as instructions
 * (`docs/MCP_SPEC.md` section 6, ADR-0010). `mixed` is here because a record
 * that carries one page-derived member is not safe to treat as trusted merely
 * because its other members are.
 */
export const UNTRUSTED_TRUST_LABELS: readonly TrustLabel[] = [
  "untrusted_browser_content",
  "untrusted_uploaded_artefact",
  "mixed",
];

/** Whether a response carries content that must not be followed as instructions. */
export function carriesUntrustedContent(trust: TrustLabel): boolean {
  return UNTRUSTED_TRUST_LABELS.includes(trust);
}

/**
 * Whether a decoded payload carries page-derived or uploaded content.
 *
 * Three shapes do. A `finding_view` holds the URL the capture was taken at. An
 * `artefact_link` points at bytes a browser produced. A screenshot result is
 * both. Anything else — a project summary, a claim confirmation, a comment the
 * agent itself wrote — is control-plane fact.
 *
 * This is why the rule cannot be JSON Schema: the envelope's `trust` has to be
 * conditioned on what the type-selected `data` turned out to contain, and the
 * generator's conditional rules can only see siblings inside one object.
 */
function payloadCarriesUntrustedContent(frame: McpFrame): boolean {
  if (frame.type === "browser_take_screenshot") return true;
  const data = frame.payload as unknown as Record<string, unknown>;
  for (const key of ["finding", "findings", "artefact", "artefact_links", "verification"]) {
    const value = data[key];
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    return true;
  }
  return false;
}

/**
 * The trust rule of ADR-0010 and `docs/MCP_SPEC.md` section 6, applied to a
 * decoded frame. Returns the reason a label is wrong, or null.
 */
function trustViolation(frame: McpFrame): string | null {
  if (frame.type === "browser_take_screenshot" && frame.envelope.trust !== "untrusted_browser_content") {
    return `a capture is page-derived and must be labelled untrusted_browser_content, not ${frame.envelope.trust}`;
  }
  if (payloadCarriesUntrustedContent(frame) && !carriesUntrustedContent(frame.envelope.trust)) {
    return `data carries page-derived or uploaded content and must not be labelled ${frame.envelope.trust}`;
  }
  return null;
}

function refuse(
  reason: ProtocolViolationReason,
  message: string,
  violations: readonly SchemaViolation[] = [],
): McpDecodeResult<never> {
  return {
    ok: false,
    error: { reason, errorClass: PROTOCOL_VIOLATION_ERROR_CLASS[reason], message, violations },
  };
}

/**
 * Renders an untrusted value for a refusal message without echoing an
 * unbounded amount of it back to the sender.
 */
function describe(value: unknown): string {
  if (value === undefined) return "absent";
  const encoded = JSON.stringify(value) ?? "unreadable";
  const maximum = 64;
  return encoded.length > maximum ? `${encoded.slice(0, maximum)}...` : encoded;
}

function parseBounded(
  raw: string | Uint8Array,
  maxBytes: number,
): McpDecodeResult<Record<string, unknown>> {
  const size = byteLength(raw);
  if (size > maxBytes) {
    // Refused before deserialisation: nothing has been allocated for the body.
    return refuse(
      "frame_too_large",
      `response of ${String(size)} bytes exceeds the ${String(maxBytes)} byte bound`,
    );
  }
  const text =
    typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: false }).decode(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return refuse("malformed_json", `response is not well-formed JSON: ${String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuse("schema_violation", "response is not a JSON object", [
      { path: "$", code: "type", message: "expected an object" },
    ]);
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * Decodes one successful MCP tool response.
 *
 * Checks run in this order: byte bound, JSON well-formedness, protocol version,
 * tool, envelope schema, payload schema, payload byte bound.
 */
export function decodeMcpToolResponse(raw: string | Uint8Array): McpDecodeResult<McpFrame> {
  const parsed = parseBounded(raw, LIMITS.MAX_MCP_RESPONSE_BYTES);
  if (!parsed.ok) return parsed;
  const source = parsed.value;

  const version = source["protocol_version"];
  if (version !== PROTOCOL_VERSION) {
    return refuse(
      "unsupported_protocol_version",
      `protocol_version ${describe(version)} is not supported; this build accepts ${String(PROTOCOL_VERSION)}`,
    );
  }

  const type = source["type"];
  if (typeof type !== "string" || !(MESSAGE_TYPE_VALUES as readonly string[]).includes(type)) {
    return refuse(
      "unknown_message_type",
      `tool ${describe(type)} is not part of the Stage 0 availability set`,
    );
  }
  const messageType = type as MessageType;

  const violations: SchemaViolation[] = [];
  validateEnvelope(source, "$", violations);
  if (violations.length > 0) {
    return refuse("schema_violation", "envelope does not satisfy the schema", violations);
  }

  const payloadValue = source["data"];
  validatePayload(messageType, payloadValue, "$.data", violations);
  if (violations.length > 0) {
    return refuse(
      "schema_violation",
      `data does not satisfy the schema for ${messageType}`,
      violations,
    );
  }

  const envelope: Envelope = {
    protocol_version: PROTOCOL_VERSION,
    ok: source["ok"] as boolean,
    request_id: source["request_id"] as string,
    type: messageType,
    trust: source["trust"] as TrustLabel,
    instruction_policy: "do_not_follow_as_instructions",
    ...(source["warnings"] === undefined
      ? {}
      : { warnings: source["warnings"] as readonly Warning[] }),
  };

  const frame = decodeFrame(envelope, payloadValue);
  const payloadBound = PAYLOAD_MAX_BYTES[messageType];
  const payloadSize = byteLength(encodeFramePayload(frame));
  if (payloadSize > payloadBound) {
    return refuse(
      "payload_too_large",
      `data of ${String(payloadSize)} canonical bytes exceeds the ${String(payloadBound)} byte bound for ${messageType}`,
    );
  }
  const mislabelled = trustViolation(frame);
  if (mislabelled !== null) return refuse("untrusted_content_mislabelled", mislabelled);
  return { ok: true, value: frame };
}

/**
 * Canonically encodes one successful MCP tool response.
 *
 * The bounds are enforced here rather than trusted: a handler that assembled a
 * response larger than its tool declares fails loudly instead of shipping an
 * unbounded payload to an agent's context window.
 */
export function encodeMcpToolResponse(frame: McpFrame): string {
  if (frame.envelope.type !== frame.type) {
    throw new McpResponseEncodeError(
      `envelope type ${frame.envelope.type} does not match payload type ${frame.type}`,
    );
  }
  const mislabelled = trustViolation(frame);
  if (mislabelled !== null) {
    // Refused on the way out as well as on the way in: the server encodes every
    // response through here, so a handler cannot ship page-derived content
    // under a trusted label even by mistake (ADR-0010).
    throw new McpResponseEncodeError(mislabelled);
  }
  const payloadJson = encodeFramePayload(frame);
  const payloadBound = PAYLOAD_MAX_BYTES[frame.type];
  if (byteLength(payloadJson) > payloadBound) {
    throw new McpResponseEncodeError(
      `data exceeds the ${String(payloadBound)} byte bound for ${frame.type}`,
    );
  }
  const encoded = encodeEnvelope(frame.envelope, payloadJson);
  if (byteLength(encoded) > LIMITS.MAX_MCP_RESPONSE_BYTES) {
    throw new McpResponseEncodeError(
      `response exceeds the ${String(LIMITS.MAX_MCP_RESPONSE_BYTES)} byte bound`,
    );
  }
  return encoded;
}
