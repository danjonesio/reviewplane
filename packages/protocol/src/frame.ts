/**
 * Frame entry points: the only supported way to turn bytes into protocol
 * values.
 *
 * The order of the checks is a security property, not an implementation
 * detail. `docs/CONNECTOR_PROTOCOL.md` section 22 and `docs/DEVELOPMENT.md`
 * section 10 require bounded allocation in the parser, so the byte bound is
 * applied to the raw frame before any deserialisation happens. Only then is
 * the frame parsed, and only then are the version and type inspected. An
 * unknown version or type is refused outright rather than best-effort parsed.
 */

import { byteLength } from "./canonical.ts";
import {
  decodeFrame,
  encodeFramePayload,
  validatePayload,
} from "./generated/connector/v1/dispatch.ts";
import { decodeDataStreamHeader as decodeHeaderValue } from "./generated/connector/v1/decode.ts";
import {
  encodeDataStreamHeader as encodeHeaderValue,
  encodeEnvelope,
} from "./generated/connector/v1/encode.ts";
import {
  LIMITS,
  MESSAGE_TYPE_VALUES,
  PAYLOAD_MAX_BYTES,
  PROTOCOL_VERSION,
  PROTOCOL_VIOLATION_ERROR_CLASS,
  type ConnectorFrame,
  type DataStreamHeader,
  type Envelope,
  type ErrorClass,
  type MessageType,
  type ProtocolViolationReason,
  type SchemaViolation,
} from "./generated/connector/v1/types.ts";
import {
  validateDataStreamHeader,
  validateEnvelope,
} from "./generated/connector/v1/validate.ts";

/** A refused frame. `errorClass` is set only where the protocol defines one. */
export interface ProtocolError {
  readonly reason: ProtocolViolationReason;
  readonly errorClass: ErrorClass | null;
  readonly message: string;
  readonly violations: readonly SchemaViolation[];
}

export type DecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProtocolError };

export class FrameEncodeError extends Error {}

function refuse(
  reason: ProtocolViolationReason,
  message: string,
  violations: readonly SchemaViolation[] = [],
): DecodeResult<never> {
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
 * unbounded amount of it back to the sender. The Go package truncates at the
 * same point.
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
): DecodeResult<Record<string, unknown>> {
  const size = byteLength(raw);
  if (size > maxBytes) {
    // Refused before deserialisation: nothing has been allocated for the body.
    return refuse(
      "frame_too_large",
      `frame of ${String(size)} bytes exceeds the ${String(maxBytes)} byte bound`,
    );
  }
  const text = typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: false }).decode(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return refuse("malformed_json", `frame is not well-formed JSON: ${String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuse("schema_violation", "frame is not a JSON object", [
      { path: "$", code: "type", message: "expected an object" },
    ]);
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * Decodes one control-channel frame.
 *
 * Checks run in this order: byte bound, JSON well-formedness, protocol
 * version, message type, envelope schema, payload schema, payload byte bound.
 */
export function decodeControlFrame(raw: string | Uint8Array): DecodeResult<ConnectorFrame> {
  const parsed = parseBounded(raw, LIMITS.MAX_CONTROL_FRAME_BYTES);
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
    ...(source["connector_id"] === undefined
      ? {}
      : { connector_id: source["connector_id"] as string }),
    ...(source["correlation_id"] === undefined
      ? {}
      : { correlation_id: source["correlation_id"] as string }),
  };

  const frame = decodeFrame(envelope, payloadValue);
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

/** Canonically encodes one control-channel frame. */
export function encodeControlFrame(frame: ConnectorFrame): string {
  if (frame.envelope.type !== frame.type) {
    throw new FrameEncodeError(
      `envelope type ${frame.envelope.type} does not match payload type ${frame.type}`,
    );
  }
  const payloadJson = encodeFramePayload(frame);
  const payloadBound = PAYLOAD_MAX_BYTES[frame.type];
  if (byteLength(payloadJson) > payloadBound) {
    throw new FrameEncodeError(
      `payload exceeds the ${String(payloadBound)} byte bound for ${frame.type}`,
    );
  }
  const encoded = encodeEnvelope(frame.envelope, payloadJson);
  if (byteLength(encoded) > LIMITS.MAX_CONTROL_FRAME_BYTES) {
    throw new FrameEncodeError(
      `frame exceeds the ${String(LIMITS.MAX_CONTROL_FRAME_BYTES)} byte control-channel bound`,
    );
  }
  return encoded;
}

/** Decodes the header that opens one data-channel stream. */
export function decodeDataStreamHeaderFrame(
  raw: string | Uint8Array,
): DecodeResult<DataStreamHeader> {
  const parsed = parseBounded(raw, LIMITS.MAX_DATA_STREAM_HEADER_BYTES);
  if (!parsed.ok) return parsed;
  const violations: SchemaViolation[] = [];
  validateDataStreamHeader(parsed.value, "$", violations);
  if (violations.length > 0) {
    return refuse("schema_violation", "data-stream header does not satisfy the schema", violations);
  }
  return { ok: true, value: decodeHeaderValue(parsed.value) };
}

/** Canonically encodes the header that opens one data-channel stream. */
export function encodeDataStreamHeaderFrame(header: DataStreamHeader): string {
  const encoded = encodeHeaderValue(header);
  if (byteLength(encoded) > LIMITS.MAX_DATA_STREAM_HEADER_BYTES) {
    throw new FrameEncodeError(
      `header exceeds the ${String(LIMITS.MAX_DATA_STREAM_HEADER_BYTES)} byte bound`,
    );
  }
  return encoded;
}
