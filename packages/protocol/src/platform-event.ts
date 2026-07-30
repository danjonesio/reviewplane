/**
 * Platform event and stream-message entry points: the only supported way to
 * turn bytes of a platform event, or of a project event-stream control message,
 * into protocol values.
 *
 * The order of the checks mirrors `frame.ts`, `browser-frame.ts`,
 * `live-view-frame.ts` and `review-event.ts` exactly: the byte bound is applied
 * to the raw message before any deserialisation, and only then are the schema
 * version and type inspected. An unknown version or type is refused outright
 * rather than best-effort parsed.
 *
 * This source owns the organisation, project and durable-job events. An event
 * of another type — `review.created`, `connector.enrolled` — is decoded by the
 * source that owns it; {@link isPlatformEventType} is how a reader decides which
 * that is without a `try`.
 */

import { byteLength } from "./canonical.ts";
import {
  decodeFrame,
  encodeFramePayload,
  validatePayload,
} from "./generated/platform/v1/dispatch.ts";
import {
  decodeApiErrorResponse,
  decodeStreamError,
  decodeStreamHeartbeat,
  decodeStreamRefreshRequired,
  decodeStreamSubscribe,
  decodeStreamSubscribed,
} from "./generated/platform/v1/decode.ts";
import {
  encodeApiErrorResponse,
  encodeEnvelope,
  encodeStreamError,
  encodeStreamHeartbeat,
  encodeStreamRefreshRequired,
  encodeStreamSubscribe,
  encodeStreamSubscribed,
} from "./generated/platform/v1/encode.ts";
import {
  LIMITS,
  MESSAGE_TYPE_VALUES,
  PAYLOAD_MAX_BYTES,
  PROTOCOL_VERSION,
  PROTOCOL_VIOLATION_ERROR_CLASS,
  type Actor,
  type ApiErrorResponse,
  type Correlation,
  type Envelope,
  type ErrorClass,
  type MessageType,
  type PlatformFrame,
  type ProtocolViolationReason,
  type SchemaViolation,
  type StreamError,
  type StreamHeartbeat,
  type StreamRefreshRequired,
  type StreamSubscribe,
  type StreamSubscribed,
} from "./generated/platform/v1/types.ts";
import {
  validateApiErrorResponse,
  validateEnvelope,
  validateStreamError,
  validateStreamHeartbeat,
  validateStreamRefreshRequired,
  validateStreamSubscribe,
  validateStreamSubscribed,
} from "./generated/platform/v1/validate.ts";

/** A refused message. `errorClass` is set only where the protocol defines one. */
export interface PlatformProtocolError {
  readonly reason: ProtocolViolationReason;
  readonly errorClass: ErrorClass | null;
  readonly message: string;
  readonly violations: readonly SchemaViolation[];
}

export type PlatformDecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PlatformProtocolError };

export class PlatformEncodeError extends Error {}

/** Every stream control message, discriminated by its own `type` member. */
export type StreamMessage =
  | StreamSubscribe
  | StreamSubscribed
  | StreamRefreshRequired
  | StreamHeartbeat
  | StreamError;

function refuse(
  reason: ProtocolViolationReason,
  message: string,
  violations: readonly SchemaViolation[] = [],
): PlatformDecodeResult<never> {
  return {
    ok: false,
    error: { reason, errorClass: PROTOCOL_VIOLATION_ERROR_CLASS[reason], message, violations },
  };
}

/**
 * Renders an untrusted value for a refusal message without echoing an unbounded
 * amount of it back to the sender.
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
  what: string,
): PlatformDecodeResult<Record<string, unknown>> {
  const size = byteLength(raw);
  if (size > maxBytes) {
    // Refused before deserialisation: nothing has been allocated for the body.
    return refuse(
      "frame_too_large",
      `${what} of ${String(size)} bytes exceeds the ${String(maxBytes)} byte bound`,
    );
  }
  const text =
    typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: false }).decode(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return refuse("malformed_json", `${what} is not well-formed JSON: ${String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuse("schema_violation", `${what} is not a JSON object`, [
      { path: "$", code: "type", message: "expected an object" },
    ]);
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** Whether an event type is one this source owns. */
export function isPlatformEventType(value: string): value is MessageType {
  return (MESSAGE_TYPE_VALUES as readonly string[]).includes(value);
}

/**
 * Decodes one platform event.
 *
 * Checks run in this order: byte bound, JSON well-formedness, schema version,
 * event type, envelope schema, payload schema, payload byte bound.
 */
export function decodePlatformEvent(raw: string | Uint8Array): PlatformDecodeResult<PlatformFrame> {
  const parsed = parseBounded(raw, LIMITS.MAX_EVENT_BYTES, "event");
  if (!parsed.ok) return parsed;
  const source = parsed.value;

  const version = source["schema_version"];
  if (version !== PROTOCOL_VERSION) {
    return refuse(
      "unsupported_schema_version",
      `schema_version ${describe(version)} is not supported; this build accepts ${String(PROTOCOL_VERSION)}`,
    );
  }

  const type = source["type"];
  if (typeof type !== "string" || !isPlatformEventType(type)) {
    return refuse(
      "unknown_message_type",
      `event type ${describe(type)} is not a version ${String(PROTOCOL_VERSION)} platform event type`,
    );
  }

  const violations: SchemaViolation[] = [];
  validateEnvelope(source, "$", violations);
  if (violations.length > 0) {
    return refuse("schema_violation", "envelope does not satisfy the schema", violations);
  }

  const payloadValue = source["payload"];
  validatePayload(type, payloadValue, "$.payload", violations);
  if (violations.length > 0) {
    return refuse("schema_violation", `payload does not satisfy the schema for ${type}`, violations);
  }

  const envelope: Envelope = {
    id: source["id"] as string,
    schema_version: PROTOCOL_VERSION,
    sequence: source["sequence"] as number,
    type,
    occurred_at: source["occurred_at"] as string,
    recorded_at: source["recorded_at"] as string,
    organisation_id: source["organisation_id"] as string,
    ...(source["project_id"] === undefined ? {} : { project_id: source["project_id"] as string }),
    actor: source["actor"] as Actor,
    ...(source["correlation"] === undefined
      ? {}
      : { correlation: source["correlation"] as Correlation }),
  };

  const frame = decodeFrame(envelope, payloadValue);
  const payloadBound = PAYLOAD_MAX_BYTES[type];
  const payloadSize = byteLength(encodeFramePayload(frame));
  if (payloadSize > payloadBound) {
    return refuse(
      "payload_too_large",
      `payload of ${String(payloadSize)} canonical bytes exceeds the ${String(payloadBound)} byte bound for ${type}`,
    );
  }
  return { ok: true, value: frame };
}

/** Canonically encodes one platform event. */
export function encodePlatformEvent(frame: PlatformFrame): string {
  if (frame.envelope.type !== frame.type) {
    throw new PlatformEncodeError(
      `envelope type ${frame.envelope.type} does not match payload type ${frame.type}`,
    );
  }
  const payloadJson = encodeFramePayload(frame);
  const payloadBound = PAYLOAD_MAX_BYTES[frame.type];
  if (byteLength(payloadJson) > payloadBound) {
    throw new PlatformEncodeError(
      `payload exceeds the ${String(payloadBound)} byte bound for ${frame.type}`,
    );
  }
  const encoded = encodeEnvelope(frame.envelope, payloadJson);
  if (byteLength(encoded) > LIMITS.MAX_EVENT_BYTES) {
    throw new PlatformEncodeError(`event exceeds the ${String(LIMITS.MAX_EVENT_BYTES)} byte bound`);
  }
  return encoded;
}

/**
 * Decodes one project event-stream control message.
 *
 * The channel carries event envelopes and these five control messages, and one
 * member tells them apart: an event's `type` is an event name, a control
 * message's `type` is one of the `stream.` discriminators. A reader therefore
 * never has to guess, and a message that is neither is refused rather than
 * ignored.
 */
export function decodeStreamMessage(
  raw: string | Uint8Array,
): PlatformDecodeResult<StreamMessage> {
  const parsed = parseBounded(raw, LIMITS.MAX_STREAM_MESSAGE_BYTES, "stream message");
  if (!parsed.ok) return parsed;
  const source = parsed.value;
  const type = source["type"];
  const violations: SchemaViolation[] = [];

  switch (type) {
    case "stream.subscribe":
      validateStreamSubscribe(source, "$", violations);
      return violations.length > 0
        ? refuse("schema_violation", "stream.subscribe does not satisfy the schema", violations)
        : { ok: true, value: decodeStreamSubscribe(source) };
    case "stream.subscribed":
      validateStreamSubscribed(source, "$", violations);
      return violations.length > 0
        ? refuse("schema_violation", "stream.subscribed does not satisfy the schema", violations)
        : { ok: true, value: decodeStreamSubscribed(source) };
    case "stream.refresh_required":
      validateStreamRefreshRequired(source, "$", violations);
      return violations.length > 0
        ? refuse(
            "schema_violation",
            "stream.refresh_required does not satisfy the schema",
            violations,
          )
        : { ok: true, value: decodeStreamRefreshRequired(source) };
    case "stream.heartbeat":
      validateStreamHeartbeat(source, "$", violations);
      return violations.length > 0
        ? refuse("schema_violation", "stream.heartbeat does not satisfy the schema", violations)
        : { ok: true, value: decodeStreamHeartbeat(source) };
    case "stream.error":
      validateStreamError(source, "$", violations);
      return violations.length > 0
        ? refuse("schema_violation", "stream.error does not satisfy the schema", violations)
        : { ok: true, value: decodeStreamError(source) };
    default:
      return refuse(
        "unknown_message_type",
        `stream message type ${describe(type)} is not a version ${String(PROTOCOL_VERSION)} control message`,
      );
  }
}

/** Canonically encodes one project event-stream control message. */
export function encodeStreamMessage(message: StreamMessage): string {
  const encoded = encodeOne(message);
  if (byteLength(encoded) > LIMITS.MAX_STREAM_MESSAGE_BYTES) {
    throw new PlatformEncodeError(
      `stream message exceeds the ${String(LIMITS.MAX_STREAM_MESSAGE_BYTES)} byte bound`,
    );
  }
  return encoded;
}

/**
 * Decodes the refusal body of `docs/API.md` section 5.
 *
 * It is here rather than in a service because three surfaces answer with it —
 * the control-plane API, the MCP server and any later integration — and a
 * refusal that reached a caller in a different shape depending on which process
 * produced it would be worse than no shared vocabulary at all.
 */
export function decodeApiErrorBody(
  raw: string | Uint8Array,
): PlatformDecodeResult<ApiErrorResponse> {
  const parsed = parseBounded(raw, LIMITS.MAX_API_ERROR_BYTES, "error response");
  if (!parsed.ok) return parsed;
  const violations: SchemaViolation[] = [];
  validateApiErrorResponse(parsed.value, "$", violations);
  if (violations.length > 0) {
    return refuse("schema_violation", "error response does not satisfy the schema", violations);
  }
  return { ok: true, value: decodeApiErrorResponse(parsed.value) };
}

/** Canonically encodes the refusal body of `docs/API.md` section 5. */
export function encodeApiErrorBody(body: ApiErrorResponse): string {
  const encoded = encodeApiErrorResponse(body);
  if (byteLength(encoded) > LIMITS.MAX_API_ERROR_BYTES) {
    throw new PlatformEncodeError(
      `error response exceeds the ${String(LIMITS.MAX_API_ERROR_BYTES)} byte bound`,
    );
  }
  return encoded;
}

function encodeOne(message: StreamMessage): string {
  switch (message.type) {
    case "stream.subscribe":
      return encodeStreamSubscribe(message);
    case "stream.subscribed":
      return encodeStreamSubscribed(message);
    case "stream.refresh_required":
      return encodeStreamRefreshRequired(message);
    case "stream.heartbeat":
      return encodeStreamHeartbeat(message);
    case "stream.error":
      return encodeStreamError(message);
  }
}
