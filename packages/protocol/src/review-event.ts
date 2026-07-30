/**
 * Review-domain event entry points: the only supported way to turn bytes of a
 * review event into protocol values.
 *
 * The order of the checks mirrors `frame.ts`, `browser-frame.ts` and
 * `live-view-frame.ts` exactly: the byte bound is applied to the raw event
 * before any deserialisation, and only then are the schema version and type
 * inspected. An unknown version or type is refused outright rather than
 * best-effort parsed.
 *
 * These events are the audit record of `docs/EVENTS.md`, so they are written
 * by the control plane and read by anything that replays a project stream —
 * the web application, an integration, and the operator reading the table by
 * hand. Encoding them through one canonical encoder is what makes a replay
 * comparable with what was written.
 */

import { byteLength } from "./canonical.ts";
import {
  decodeFrame,
  encodeFramePayload,
  validatePayload,
} from "./generated/review/v1/dispatch.ts";
import { encodeEnvelope } from "./generated/review/v1/encode.ts";
import {
  LIMITS,
  MESSAGE_TYPE_VALUES,
  PAYLOAD_MAX_BYTES,
  PROTOCOL_VERSION,
  PROTOCOL_VIOLATION_ERROR_CLASS,
  type Actor,
  type Correlation,
  type Envelope,
  type ErrorClass,
  type MessageType,
  type ProtocolViolationReason,
  type ReviewFrame,
  type SchemaViolation,
} from "./generated/review/v1/types.ts";
import { validateEnvelope } from "./generated/review/v1/validate.ts";

/** A refused event. `errorClass` is set only where the protocol defines one. */
export interface ReviewProtocolError {
  readonly reason: ProtocolViolationReason;
  readonly errorClass: ErrorClass | null;
  readonly message: string;
  readonly violations: readonly SchemaViolation[];
}

export type ReviewDecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ReviewProtocolError };

export class ReviewEventEncodeError extends Error {}

function refuse(
  reason: ProtocolViolationReason,
  message: string,
  violations: readonly SchemaViolation[] = [],
): ReviewDecodeResult<never> {
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
): ReviewDecodeResult<Record<string, unknown>> {
  const size = byteLength(raw);
  if (size > maxBytes) {
    // Refused before deserialisation: nothing has been allocated for the body.
    return refuse(
      "frame_too_large",
      `event of ${String(size)} bytes exceeds the ${String(maxBytes)} byte bound`,
    );
  }
  const text =
    typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: false }).decode(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return refuse("malformed_json", `event is not well-formed JSON: ${String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuse("schema_violation", "event is not a JSON object", [
      { path: "$", code: "type", message: "expected an object" },
    ]);
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * Decodes one review-domain event.
 *
 * Checks run in this order: byte bound, JSON well-formedness, schema version,
 * event type, envelope schema, payload schema, payload byte bound.
 */
export function decodeReviewEvent(raw: string | Uint8Array): ReviewDecodeResult<ReviewFrame> {
  const parsed = parseBounded(raw, LIMITS.MAX_REVIEW_EVENT_BYTES);
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
  if (typeof type !== "string" || !(MESSAGE_TYPE_VALUES as readonly string[]).includes(type)) {
    return refuse(
      "unknown_message_type",
      `event type ${describe(type)} is not a version ${String(PROTOCOL_VERSION)} event type`,
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
    id: source["id"] as string,
    schema_version: PROTOCOL_VERSION,
    sequence: source["sequence"] as number,
    type: messageType,
    occurred_at: source["occurred_at"] as string,
    ...(source["recorded_at"] === undefined
      ? {}
      : { recorded_at: source["recorded_at"] as string }),
    organisation_id: source["organisation_id"] as string,
    project_id: source["project_id"] as string,
    actor: source["actor"] as Actor,
    ...(source["correlation"] === undefined
      ? {}
      : { correlation: source["correlation"] as Correlation }),
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

/** Canonically encodes one review-domain event. */
export function encodeReviewEvent(frame: ReviewFrame): string {
  if (frame.envelope.type !== frame.type) {
    throw new ReviewEventEncodeError(
      `envelope type ${frame.envelope.type} does not match payload type ${frame.type}`,
    );
  }
  const payloadJson = encodeFramePayload(frame);
  const payloadBound = PAYLOAD_MAX_BYTES[frame.type];
  if (byteLength(payloadJson) > payloadBound) {
    throw new ReviewEventEncodeError(
      `payload exceeds the ${String(payloadBound)} byte bound for ${frame.type}`,
    );
  }
  const encoded = encodeEnvelope(frame.envelope, payloadJson);
  if (byteLength(encoded) > LIMITS.MAX_REVIEW_EVENT_BYTES) {
    throw new ReviewEventEncodeError(
      `event exceeds the ${String(LIMITS.MAX_REVIEW_EVENT_BYTES)} byte bound`,
    );
  }
  return encoded;
}
