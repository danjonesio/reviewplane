// Package protocolio builds the connector's outbound frames.
//
// Every wire type comes from packages/protocol (ADR-0013). Nothing here defines
// a message shape; it only fills in the envelope fields the connector owns and
// calls the generated canonical encoder. Encoding a frame with encoding/json
// instead would silently redact the enrolment token, because
// connectorv1.SensitiveString.MarshalJSON returns the redacted form on purpose.
package protocolio

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"time"

	connectorv1 "github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
)

// NewMessageID returns a sender-assigned message identifier. The conventional
// msg_ prefix is documentation only: docs/DOMAIN_MODEL.md section 3 requires
// receivers to treat the value as opaque and to bound length and character
// class alone.
func NewMessageID() (string, error) {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("protocolio: generating message id: %w", err)
	}
	return "msg_" + base64.RawURLEncoding.EncodeToString(buffer), nil
}

// Timestamp formats an RFC 3339 UTC timestamp in the form the schema's
// timestamp definition requires, including the mandatory trailing Z.
func Timestamp(at time.Time) string {
	return at.UTC().Format("2006-01-02T15:04:05Z")
}

// carriesConnectorID reports whether a message type may name a connector.
//
// The schema's envelope x-requires block forbids connector_id on the
// registration exchange, because the identity is still being established, and
// requires it everywhere else (docs/CONNECTOR_PROTOCOL.md section 7). The
// generated validator is the authority; this function simply declines to build
// a frame that validator would refuse.
func carriesConnectorID(messageType connectorv1.MessageType) bool {
	switch messageType {
	case connectorv1.MessageTypeConnectorRegistrationRequest,
		connectorv1.MessageTypeConnectorRegistrationResponse:
		return false
	default:
		return true
	}
}

// NewFrame assembles an envelope around a payload. connectorID is applied only
// to message types that may carry one; the registration exchange never does.
func NewFrame(payload connectorv1.Payload, connectorID string, at time.Time) (connectorv1.Frame, error) {
	messageID, err := NewMessageID()
	if err != nil {
		return connectorv1.Frame{}, err
	}
	messageType := payload.MessageType()
	envelope := connectorv1.Envelope{
		ProtocolVersion: connectorv1.ProtocolVersion,
		MessageID:       messageID,
		Type:            messageType,
		SentAt:          Timestamp(at),
	}
	if connectorID != "" && carriesConnectorID(messageType) {
		envelope.ConnectorID = &connectorID
	}
	if connectorID == "" && carriesConnectorID(messageType) {
		return connectorv1.Frame{}, fmt.Errorf(
			"protocolio: %s requires a connector_id, which is assigned by enrolment", messageType)
	}
	return connectorv1.Frame{Envelope: envelope, Payload: payload}, nil
}

// Encode canonically encodes a frame for the wire.
func Encode(frame connectorv1.Frame) ([]byte, error) {
	return connectorv1.EncodeControlFrame(frame)
}
