package platformv1

import (
	"bytes"
	"encoding/json"
	"slices"
	"strconv"
)

// Platform event and stream-message entry points: the only supported way to
// turn bytes into protocol values.
//
// The order of the checks is a security property, not an implementation
// detail. The byte bound is applied to the raw message before any
// deserialisation happens; only then is the message parsed, and only then are
// the schema version and type inspected. An unknown version or type is refused
// outright rather than best-effort parsed. connectorv1 applies the same order
// for the same reason, and the two are held together by their corpora.

// ProtocolError describes a refused message. ErrorClass is empty unless the
// protocol defines an error class for the reason.
type ProtocolError struct {
	Reason     ViolationReason
	ErrorClass ErrorClass
	Msg        string
	Violations []SchemaViolation
}

func (e *ProtocolError) Error() string {
	if e == nil {
		return "<nil>"
	}
	return "platformv1: " + string(e.Reason) + ": " + e.Msg
}

func refuse(reason ViolationReason, message string, violations []SchemaViolation) *ProtocolError {
	return &ProtocolError{
		Reason:     reason,
		ErrorClass: ViolationErrorClass[reason],
		Msg:        message,
		Violations: violations,
	}
}

func parseBounded(raw []byte, maxBytes int, what string) (map[string]any, *ProtocolError) {
	if len(raw) > maxBytes {
		// Refused before deserialisation: nothing has been allocated for the
		// body.
		return nil, refuse(
			ReasonFrameTooLarge,
			what+" of "+strconv.Itoa(len(raw))+" bytes exceeds the "+strconv.Itoa(maxBytes)+" byte bound",
			nil,
		)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, refuse(ReasonMalformedJSON, what+" is not well-formed JSON: "+err.Error(), nil)
	}
	if decoder.More() {
		return nil, refuse(ReasonMalformedJSON, what+" carries trailing data after the JSON value", nil)
	}
	source, ok := value.(map[string]any)
	if !ok {
		return nil, refuse(ReasonSchemaViolation, what+" is not a JSON object", []SchemaViolation{
			{Path: "$", Code: SchemaViolationType, Message: "expected an object"},
		})
	}
	return source, nil
}

// IsPlatformEventType reports whether an event type is one this source owns.
// An event of another type is decoded by the schema source that owns it.
func IsPlatformEventType(value string) bool { return IsKnownMessageType(value) }

// IsKnownEventType reports whether a name appears in the Stage 1 catalogue of
// docs/EVENTS.md section 7. It is documentation rather than validation: a
// consumer that meets a name it does not know MUST ignore the event rather than
// fail, because adding a name is additive within a schema version.
func IsKnownEventType(value string) bool { return slices.Contains(EventTypes, value) }

// DecodePlatformEvent decodes one platform event.
//
// Checks run in this order: byte bound, JSON well-formedness, schema version,
// event type, envelope schema, payload schema, payload byte bound.
func DecodePlatformEvent(raw []byte) (Frame, *ProtocolError) {
	source, failure := parseBounded(raw, MaxEventBytes, "event")
	if failure != nil {
		return Frame{}, failure
	}

	version, ok := asInt64(source["schema_version"])
	if !ok || version != ProtocolVersion {
		return Frame{}, refuse(
			ReasonUnsupportedSchemaVersion,
			"schema_version "+describe(source["schema_version"])+" is not supported; this build accepts "+strconv.FormatInt(ProtocolVersion, 10),
			nil,
		)
	}

	messageTypeText, ok := source["type"].(string)
	if !ok || !IsKnownMessageType(messageTypeText) {
		return Frame{}, refuse(
			ReasonUnknownMessageType,
			"event type "+describe(source["type"])+" is not a version "+strconv.FormatInt(ProtocolVersion, 10)+" platform event type",
			nil,
		)
	}
	messageType := MessageType(messageTypeText)

	var violations []SchemaViolation
	validateEnvelope(source, "$", &violations)
	if len(violations) > 0 {
		return Frame{}, refuse(ReasonSchemaViolation, "envelope does not satisfy the schema", violations)
	}

	payloadValue := source["payload"]
	validatePayload(messageType, payloadValue, "$.payload", &violations)
	if len(violations) > 0 {
		return Frame{}, refuse(
			ReasonSchemaViolation,
			"payload does not satisfy the schema for "+messageTypeText,
			violations,
		)
	}

	frame := Frame{Envelope: DecodeEnvelope(source), Payload: decodePayload(messageType, payloadValue)}
	encodedPayload, err := EncodePayload(frame.Payload)
	if err != nil {
		return Frame{}, refuse(ReasonSchemaViolation, "payload cannot be canonically encoded: "+err.Error(), nil)
	}
	bound := PayloadMaxBytes[messageType]
	if len(encodedPayload) > bound {
		return Frame{}, refuse(
			ReasonPayloadTooLarge,
			"payload of "+strconv.Itoa(len(encodedPayload))+" canonical bytes exceeds the "+strconv.Itoa(bound)+" byte bound for "+messageTypeText,
			nil,
		)
	}
	return frame, nil
}

// EncodePlatformEvent canonically encodes one platform event.
func EncodePlatformEvent(frame Frame) ([]byte, error) {
	if frame.Payload == nil {
		return nil, errUnknownPayload
	}
	if frame.Envelope.Type != frame.Payload.MessageType() {
		return nil, &ProtocolError{
			Reason: ReasonSchemaViolation,
			Msg: "envelope type " + string(frame.Envelope.Type) + " does not match payload type " +
				string(frame.Payload.MessageType()),
		}
	}
	payloadJSON, err := EncodePayload(frame.Payload)
	if err != nil {
		return nil, err
	}
	bound := PayloadMaxBytes[frame.Envelope.Type]
	if len(payloadJSON) > bound {
		return nil, &ProtocolError{
			Reason: ReasonPayloadTooLarge,
			Msg:    "payload exceeds the " + strconv.Itoa(bound) + " byte bound for " + string(frame.Envelope.Type),
		}
	}
	encoded, err := EncodeEnvelope(frame.Envelope, payloadJSON)
	if err != nil {
		return nil, err
	}
	if len(encoded) > MaxEventBytes {
		return nil, &ProtocolError{
			Reason: ReasonFrameTooLarge,
			Msg:    "event exceeds the " + strconv.Itoa(MaxEventBytes) + " byte bound",
		}
	}
	return encoded, nil
}

// StreamMessage is any project event-stream control message. The channel
// carries event envelopes and these five, and one member tells them apart: an
// event's type is an event name, a control message's type is a stream.
// discriminator. A reader therefore never has to guess, and a message that is
// neither is refused rather than ignored.
type StreamMessage struct {
	Type            string
	Subscribe       *StreamSubscribe
	Subscribed      *StreamSubscribed
	RefreshRequired *StreamRefreshRequired
	Heartbeat       *StreamHeartbeat
	Error           *StreamError
}

// DecodeStreamMessage decodes one project event-stream control message.
func DecodeStreamMessage(raw []byte) (StreamMessage, *ProtocolError) {
	source, failure := parseBounded(raw, MaxStreamMessageBytes, "stream message")
	if failure != nil {
		return StreamMessage{}, failure
	}
	messageType, _ := source["type"].(string)
	var violations []SchemaViolation

	switch messageType {
	case "stream.subscribe":
		validateStreamSubscribe(source, "$", &violations)
		if len(violations) > 0 {
			return StreamMessage{}, refuse(ReasonSchemaViolation, "stream.subscribe does not satisfy the schema", violations)
		}
		decoded := DecodeStreamSubscribe(source)
		return StreamMessage{Type: messageType, Subscribe: &decoded}, nil
	case "stream.subscribed":
		validateStreamSubscribed(source, "$", &violations)
		if len(violations) > 0 {
			return StreamMessage{}, refuse(ReasonSchemaViolation, "stream.subscribed does not satisfy the schema", violations)
		}
		decoded := DecodeStreamSubscribed(source)
		return StreamMessage{Type: messageType, Subscribed: &decoded}, nil
	case "stream.refresh_required":
		validateStreamRefreshRequired(source, "$", &violations)
		if len(violations) > 0 {
			return StreamMessage{}, refuse(ReasonSchemaViolation, "stream.refresh_required does not satisfy the schema", violations)
		}
		decoded := DecodeStreamRefreshRequired(source)
		return StreamMessage{Type: messageType, RefreshRequired: &decoded}, nil
	case "stream.heartbeat":
		validateStreamHeartbeat(source, "$", &violations)
		if len(violations) > 0 {
			return StreamMessage{}, refuse(ReasonSchemaViolation, "stream.heartbeat does not satisfy the schema", violations)
		}
		decoded := DecodeStreamHeartbeat(source)
		return StreamMessage{Type: messageType, Heartbeat: &decoded}, nil
	case "stream.error":
		validateStreamError(source, "$", &violations)
		if len(violations) > 0 {
			return StreamMessage{}, refuse(ReasonSchemaViolation, "stream.error does not satisfy the schema", violations)
		}
		decoded := DecodeStreamError(source)
		return StreamMessage{Type: messageType, Error: &decoded}, nil
	}
	return StreamMessage{}, refuse(
		ReasonUnknownMessageType,
		"stream message type "+describe(source["type"])+" is not a version "+strconv.FormatInt(ProtocolVersion, 10)+" control message",
		nil,
	)
}

// EncodeStreamMessage canonically encodes one control message.
func EncodeStreamMessage(message StreamMessage) ([]byte, error) {
	var encoded []byte
	var err error
	switch {
	case message.Subscribe != nil:
		encoded, err = EncodeStreamSubscribe(*message.Subscribe)
	case message.Subscribed != nil:
		encoded, err = EncodeStreamSubscribed(*message.Subscribed)
	case message.RefreshRequired != nil:
		encoded, err = EncodeStreamRefreshRequired(*message.RefreshRequired)
	case message.Heartbeat != nil:
		encoded, err = EncodeStreamHeartbeat(*message.Heartbeat)
	case message.Error != nil:
		encoded, err = EncodeStreamError(*message.Error)
	default:
		return nil, errUnknownPayload
	}
	if err != nil {
		return nil, err
	}
	if len(encoded) > MaxStreamMessageBytes {
		return nil, &ProtocolError{
			Reason: ReasonFrameTooLarge,
			Msg:    "stream message exceeds the " + strconv.Itoa(MaxStreamMessageBytes) + " byte bound",
		}
	}
	return encoded, nil
}

// DecodeAPIErrorBody decodes the refusal body of docs/API.md section 5.
//
// It is here rather than in a service because three surfaces answer with it —
// the control-plane API, the MCP server and any later integration — and a
// refusal that reached a caller in a different shape depending on which process
// produced it would be worse than no shared vocabulary at all.
func DecodeAPIErrorBody(raw []byte) (ApiErrorResponse, *ProtocolError) {
	source, failure := parseBounded(raw, MaxAPIErrorBytes, "error response")
	if failure != nil {
		return ApiErrorResponse{}, failure
	}
	var violations []SchemaViolation
	validateAPIErrorResponse(source, "$", &violations)
	if len(violations) > 0 {
		return ApiErrorResponse{}, refuse(ReasonSchemaViolation, "error response does not satisfy the schema", violations)
	}
	return DecodeApiErrorResponse(source), nil
}

// EncodeAPIErrorBody canonically encodes the refusal body of docs/API.md
// section 5.
func EncodeAPIErrorBody(body ApiErrorResponse) ([]byte, error) {
	encoded, err := EncodeApiErrorResponse(body)
	if err != nil {
		return nil, err
	}
	if len(encoded) > MaxAPIErrorBytes {
		return nil, &ProtocolError{
			Reason: ReasonFrameTooLarge,
			Msg:    "error response exceeds the " + strconv.Itoa(MaxAPIErrorBytes) + " byte bound",
		}
	}
	return encoded, nil
}

// describe renders an untrusted value for an error message without echoing an
// unbounded amount of it back to the sender.
func describe(value any) string {
	if value == nil {
		return "absent"
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "unreadable"
	}
	const maximum = 64
	if len(encoded) > maximum {
		return string(encoded[:maximum]) + "..."
	}
	return string(encoded)
}
