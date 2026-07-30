/**
 * Live-view message entry points: the only supported way to turn bytes of the
 * live channel into protocol values.
 *
 * The order of the checks mirrors `frame.ts` and `browser-frame.ts` exactly:
 * the byte bound is applied to the raw message before any deserialisation, and
 * only then are the version and type inspected. An unknown version or type is
 * refused outright rather than best-effort parsed. This channel carries
 * messages from a viewer's browser as well as from the worker, so the refusal
 * order matters here for the same reason it does on the worker channel.
 *
 * The binary frame payload is not decoded here. It is a separate transport
 * message whose only description is the `live.frame` metadata that precedes it
 * (`docs/API.md` section 18.2); `live-view-stream.ts` carries the framing that
 * keeps the two associated on the internal leg.
 */

import { byteLength } from "./canonical.ts";
import {
  decodeFrame,
  encodeFramePayload,
  validatePayload,
} from "./generated/live_view/v1/dispatch.ts";
import { encodeEnvelope } from "./generated/live_view/v1/encode.ts";
import {
  LIMITS,
  MESSAGE_TYPE_VALUES,
  PAYLOAD_MAX_BYTES,
  PROTOCOL_VERSION,
  PROTOCOL_VIOLATION_ERROR_CLASS,
  type Envelope,
  type ErrorClass,
  type LiveViewFrame,
  type MessageType,
  type ProtocolViolationReason,
  type SchemaViolation,
} from "./generated/live_view/v1/types.ts";
import { validateEnvelope } from "./generated/live_view/v1/validate.ts";

/** A refused message. `errorClass` is set only where the protocol defines one. */
export interface LiveViewProtocolError {
  readonly reason: ProtocolViolationReason;
  readonly errorClass: ErrorClass | null;
  readonly message: string;
  readonly violations: readonly SchemaViolation[];
}

export type LiveViewDecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: LiveViewProtocolError };

export class LiveViewFrameEncodeError extends Error {}

function refuse(
  reason: ProtocolViolationReason,
  message: string,
  violations: readonly SchemaViolation[] = [],
): LiveViewDecodeResult<never> {
  return {
    ok: false,
    error: {
      reason,
      errorClass: PROTOCOL_VIOLATION_ERROR_CLASS[reason],
      message,
      violations,
    },
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
): LiveViewDecodeResult<Record<string, unknown>> {
  const size = byteLength(raw);
  if (size > maxBytes) {
    // Refused before deserialisation: nothing has been allocated for the body.
    return refuse(
      "frame_too_large",
      `message of ${String(size)} bytes exceeds the ${String(maxBytes)} byte bound`,
    );
  }
  const text =
    typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: false }).decode(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return refuse("malformed_json", `message is not well-formed JSON: ${String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuse("schema_violation", "message is not a JSON object", [
      { path: "$", code: "type", message: "expected an object" },
    ]);
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * Decodes one live-view message.
 *
 * Checks run in this order: byte bound, JSON well-formedness, protocol
 * version, message type, envelope schema, payload schema, payload byte bound.
 */
export function decodeLiveViewFrame(
  raw: string | Uint8Array,
): LiveViewDecodeResult<LiveViewFrame> {
  const parsed = parseBounded(raw, LIMITS.MAX_LIVE_MESSAGE_BYTES);
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
      `message type ${describe(type)} is not a version ${String(PROTOCOL_VERSION)} message type`,
    );
  }
  const messageType = type as MessageType;

  const violations: SchemaViolation[] = [];
  validateEnvelope(source, "$", violations);
  if (violations.length > 0) {
    return refuse("schema_violation", "envelope does not satisfy the schema", violations);
  }

  const payloadValue = source["payload"];
  validatePayload(messageType, payloadValue, "$.payload", violations);
  if (violations.length > 0) {
    return refuse(
      "schema_violation",
      `payload does not satisfy the schema for ${messageType}`,
      violations,
    );
  }

  const envelope: Envelope = {
    protocol_version: PROTOCOL_VERSION,
    message_id: source["message_id"] as string,
    type: messageType,
    sent_at: source["sent_at"] as string,
    ...(source["browser_session_id"] === undefined
      ? {}
      : { browser_session_id: source["browser_session_id"] as string }),
    ...(source["stream_id"] === undefined ? {} : { stream_id: source["stream_id"] as string }),
  };

  const frame = decodeLiveViewPayload(envelope, payloadValue);
  const payloadBound = PAYLOAD_MAX_BYTES[messageType];
  const payloadSize = byteLength(encodeFramePayload(frame));
  if (payloadSize > payloadBound) {
    return refuse(
      "payload_too_large",
      `payload of ${String(payloadSize)} canonical bytes exceeds the ${String(payloadBound)} byte bound for ${messageType}`,
    );
  }
  return { ok: true, value: frame };
}

function decodeLiveViewPayload(envelope: Envelope, payload: unknown): LiveViewFrame {
  return decodeFrame(envelope, payload);
}

/** Canonically encodes one live-view message. */
export function encodeLiveViewFrame(frame: LiveViewFrame): string {
  if (frame.envelope.type !== frame.type) {
    throw new LiveViewFrameEncodeError(
      `envelope type ${frame.envelope.type} does not match payload type ${frame.type}`,
    );
  }
  const payloadJson = encodeFramePayload(frame);
  const payloadBound = PAYLOAD_MAX_BYTES[frame.type];
  if (byteLength(payloadJson) > payloadBound) {
    throw new LiveViewFrameEncodeError(
      `payload exceeds the ${String(payloadBound)} byte bound for ${frame.type}`,
    );
  }
  const encoded = encodeEnvelope(frame.envelope, payloadJson);
  if (byteLength(encoded) > LIMITS.MAX_LIVE_MESSAGE_BYTES) {
    throw new LiveViewFrameEncodeError(
      `message exceeds the ${String(LIMITS.MAX_LIVE_MESSAGE_BYTES)} byte bound`,
    );
  }
  return encoded;
}
