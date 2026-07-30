// Package datachannel implements the multiplexed data-stream protocol of
// docs/CONNECTOR_PROTOCOL.md section 12: both the gateway side that opens
// streams and the connector side that accepts them.
//
// It is exported rather than internal because services/connector must speak
// the same framing, and two implementations of a mux are two chances to
// disagree about a window update. The JSON that opens a stream is not defined
// here: it is the schema's data_stream_header, encoded and decoded only by
// packages/protocol, so the header's bounds, its refusal of unknown properties
// and the redaction of its session capability all come from one place.
package datachannel

import (
	"encoding/binary"
	"errors"
	"strconv"

	"github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
)

// FrameType identifies a data-channel frame.
//
// The framing is binary because it carries opaque application bytes; the
// control channel's JSON envelope of docs/CONNECTOR_PROTOCOL.md section 7 is
// not used here. Only FrameOpen and FrameReset carry protocol values, and both
// take them from packages/protocol: a canonically encoded data_stream_header
// and a section 21 error class.
type FrameType uint8

const (
	// FrameOpen opens a stream. Its payload is the canonical encoding of a
	// data_stream_header. Only the gateway sends it.
	FrameOpen FrameType = 1
	// FrameAccept reports that the connector opened the pre-authorised local
	// destination for the stream. Only the connector sends it.
	FrameAccept FrameType = 2
	// FrameData carries application bytes and consumes send window.
	FrameData FrameType = 3
	// FrameEnd half-closes the sender's direction: no more data will follow.
	FrameEnd FrameType = 4
	// FrameReset terminates a stream in both directions. Its payload is a
	// docs/CONNECTOR_PROTOCOL.md section 21 error class, or empty for a normal
	// abort.
	FrameReset FrameType = 5
	// FrameWindow returns flow-control credit. Its payload is a big-endian
	// uint32 count of bytes the receiver has consumed.
	FrameWindow FrameType = 6
)

// String renders a frame type for logs and metrics.
func (t FrameType) String() string {
	switch t {
	case FrameOpen:
		return "open"
	case FrameAccept:
		return "accept"
	case FrameData:
		return "data"
	case FrameEnd:
		return "end"
	case FrameReset:
		return "reset"
	case FrameWindow:
		return "window"
	default:
		return "unknown(" + strconv.Itoa(int(t)) + ")"
	}
}

// frameHeaderBytes is the fixed prefix: one type byte and a big-endian stream
// number.
const frameHeaderBytes = 5

// MaxResetPayloadBytes bounds the error class a reset may carry. The longest
// section 21 class is well inside it.
const MaxResetPayloadBytes = 64

// ErrMalformedFrame reports a frame this build will not interpret. Malformed
// frames are refused, never best-effort parsed, exactly as
// docs/CONNECTOR_PROTOCOL.md section 7 requires of the control channel.
var ErrMalformedFrame = errors.New("datachannel: malformed frame")

// Frame is one decoded data-channel frame.
type Frame struct {
	Type    FrameType
	Stream  uint32
	Payload []byte
}

// EncodeFrame renders a frame for the transport.
func EncodeFrame(frameType FrameType, stream uint32, payload []byte) []byte {
	encoded := make([]byte, frameHeaderBytes+len(payload))
	encoded[0] = byte(frameType)
	binary.BigEndian.PutUint32(encoded[1:5], stream)
	copy(encoded[frameHeaderBytes:], payload)
	return encoded
}

// DecodeFrame parses one frame and refuses everything it cannot interpret.
//
// The payload is bounded by the caller's transport message bound before this
// is reached, so no length is trusted from inside the frame.
func DecodeFrame(raw []byte) (Frame, error) {
	if len(raw) < frameHeaderBytes {
		return Frame{}, errors.Join(ErrMalformedFrame, errors.New("frame is shorter than its header"))
	}
	frameType := FrameType(raw[0])
	switch frameType {
	case FrameOpen, FrameAccept, FrameData, FrameEnd, FrameReset, FrameWindow:
	default:
		return Frame{}, errors.Join(ErrMalformedFrame,
			errors.New("unknown frame type "+strconv.Itoa(int(raw[0]))))
	}
	stream := binary.BigEndian.Uint32(raw[1:5])
	if stream == 0 {
		return Frame{}, errors.Join(ErrMalformedFrame, errors.New("stream 0 is reserved"))
	}
	payload := raw[frameHeaderBytes:]
	switch frameType {
	case FrameEnd, FrameAccept:
		if len(payload) != 0 {
			return Frame{}, errors.Join(ErrMalformedFrame,
				errors.New(frameType.String()+" carries a payload"))
		}
	case FrameWindow:
		if len(payload) != 4 {
			return Frame{}, errors.Join(ErrMalformedFrame,
				errors.New("window frame payload is not four bytes"))
		}
	case FrameReset:
		if len(payload) > MaxResetPayloadBytes {
			return Frame{}, errors.Join(ErrMalformedFrame, errors.New("reset payload is too long"))
		}
		if len(payload) > 0 && !isKnownErrorClass(string(payload)) {
			return Frame{}, errors.Join(ErrMalformedFrame,
				errors.New("reset carries a value that is not a protocol error class"))
		}
	case FrameOpen:
		if len(payload) > connectorv1.MaxDataStreamHeaderBytes {
			return Frame{}, errors.Join(ErrMalformedFrame,
				errors.New("open payload exceeds the data-stream header bound"))
		}
	case FrameData:
	}
	return Frame{Type: frameType, Stream: stream, Payload: payload}, nil
}

func isKnownErrorClass(candidate string) bool {
	for _, class := range connectorv1.ErrorClassValues {
		if string(class) == candidate {
			return true
		}
	}
	return false
}

// EncodeWindowFrame renders a flow-control credit return.
func EncodeWindowFrame(stream uint32, credit uint32) []byte {
	return EncodeFrame(FrameWindow, stream, binary.BigEndian.AppendUint32(nil, credit))
}

// WindowCredit reads the credit from a decoded window frame.
func WindowCredit(frame Frame) uint32 { return binary.BigEndian.Uint32(frame.Payload) }
