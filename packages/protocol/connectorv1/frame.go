package connectorv1

import (
	"bytes"
	"encoding/json"
	"strconv"
)

// Frame entry points: the only supported way to turn bytes into protocol
// values.
//
// The order of the checks is a security property, not an implementation
// detail. docs/CONNECTOR_PROTOCOL.md section 22 and docs/DEVELOPMENT.md
// section 10 require bounded allocation in the parser, so the byte bound is
// applied to the raw frame before any deserialisation happens. Only then is the
// frame parsed, and only then are the version and type inspected. An unknown
// version or type is refused outright rather than best-effort parsed.

// ProtocolError describes a refused frame. ErrorClass is empty unless the
// protocol defines a wire error class for the reason.
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
	return "connectorv1: " + string(e.Reason) + ": " + e.Msg
}

func refuse(reason ViolationReason, message string, violations []SchemaViolation) *ProtocolError {
	return &ProtocolError{
		Reason:     reason,
		ErrorClass: ViolationErrorClass[reason],
		Msg:        message,
		Violations: violations,
	}
}

func parseBounded(raw []byte, maxBytes int) (map[string]any, *ProtocolError) {
	if len(raw) > maxBytes {
		// Refused before deserialisation: nothing has been allocated for the
		// body.
		return nil, refuse(
			ReasonFrameTooLarge,
			"frame of "+strconv.Itoa(len(raw))+" bytes exceeds the "+strconv.Itoa(maxBytes)+" byte bound",
			nil,
		)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, refuse(ReasonMalformedJSON, "frame is not well-formed JSON: "+err.Error(), nil)
	}
	if decoder.More() {
		return nil, refuse(ReasonMalformedJSON, "frame carries trailing data after the JSON value", nil)
	}
	source, ok := value.(map[string]any)
	if !ok {
		return nil, refuse(ReasonSchemaViolation, "frame is not a JSON object", []SchemaViolation{
			{Path: "$", Code: SchemaViolationType, Message: "expected an object"},
		})
	}
	return source, nil
}

// DecodeControlFrame decodes one control-channel frame.
//
// Checks run in this order: byte bound, JSON well-formedness, protocol version,
// message type, envelope schema, payload schema, payload byte bound.
func DecodeControlFrame(raw []byte) (Frame, *ProtocolError) {
	source, failure := parseBounded(raw, MaxControlFrameBytes)
	if failure != nil {
		return Frame{}, failure
	}

	version, ok := asInt64(source["protocol_version"])
	if !ok || version != ProtocolVersion {
		return Frame{}, refuse(
			ReasonUnsupportedProtocolVersion,
			"protocol_version "+describe(source["protocol_version"])+" is not supported; this build accepts "+strconv.FormatInt(ProtocolVersion, 10),
			nil,
		)
	}

	messageTypeText, ok := source["type"].(string)
	if !ok || !IsKnownMessageType(messageTypeText) {
		return Frame{}, refuse(
			ReasonUnknownMessageType,
			"message type "+describe(source["type"])+" is not a version "+strconv.FormatInt(ProtocolVersion, 10)+" message type",
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

// EncodeControlFrame canonically encodes one control-channel frame.
func EncodeControlFrame(frame Frame) ([]byte, error) {
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
	if len(encoded) > MaxControlFrameBytes {
		return nil, &ProtocolError{
			Reason: ReasonFrameTooLarge,
			Msg:    "frame exceeds the " + strconv.Itoa(MaxControlFrameBytes) + " byte control-channel bound",
		}
	}
	return encoded, nil
}

// DecodeDataStreamHeaderFrame decodes the header that opens one data-channel
// stream.
func DecodeDataStreamHeaderFrame(raw []byte) (DataStreamHeader, *ProtocolError) {
	source, failure := parseBounded(raw, MaxDataStreamHeaderBytes)
	if failure != nil {
		return DataStreamHeader{}, failure
	}
	var violations []SchemaViolation
	validateDataStreamHeader(source, "$", &violations)
	if len(violations) > 0 {
		return DataStreamHeader{}, refuse(
			ReasonSchemaViolation,
			"data-stream header does not satisfy the schema",
			violations,
		)
	}
	return DecodeDataStreamHeader(source), nil
}

// EncodeDataStreamHeaderFrame canonically encodes the header that opens one
// data-channel stream.
func EncodeDataStreamHeaderFrame(header DataStreamHeader) ([]byte, error) {
	encoded, err := EncodeDataStreamHeader(header)
	if err != nil {
		return nil, err
	}
	if len(encoded) > MaxDataStreamHeaderBytes {
		return nil, &ProtocolError{
			Reason: ReasonFrameTooLarge,
			Msg:    "header exceeds the " + strconv.Itoa(MaxDataStreamHeaderBytes) + " byte bound",
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
