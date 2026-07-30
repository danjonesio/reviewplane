package datachannel

import (
	"bytes"
	"errors"
	"testing"

	"github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
)

// The framing is refused, never best-effort parsed: the same rule
// docs/CONNECTOR_PROTOCOL.md section 7 applies to the control channel.

func TestFramesRoundTrip(t *testing.T) {
	for _, testCase := range []struct {
		frameType FrameType
		payload   []byte
	}{
		{FrameOpen, []byte(`{"route_id":"svc_a"}`)},
		{FrameAccept, nil},
		{FrameData, bytes.Repeat([]byte("d"), 4096)},
		{FrameEnd, nil},
		{FrameReset, []byte(connectorv1.ErrorClassPortNotListening)},
		{FrameReset, nil},
	} {
		encoded := EncodeFrame(testCase.frameType, 7, testCase.payload)
		decoded, err := DecodeFrame(encoded)
		if err != nil {
			t.Fatalf("%s: %v", testCase.frameType, err)
		}
		if decoded.Type != testCase.frameType || decoded.Stream != 7 {
			t.Fatalf("decoded %s on stream %d", decoded.Type, decoded.Stream)
		}
		if !bytes.Equal(decoded.Payload, testCase.payload) && len(decoded.Payload)+len(testCase.payload) != 0 {
			t.Fatalf("%s payload did not round-trip", testCase.frameType)
		}
	}
}

func TestWindowFramesCarryCredit(t *testing.T) {
	decoded, err := DecodeFrame(EncodeWindowFrame(3, 65536))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if WindowCredit(decoded) != 65536 {
		t.Fatalf("credit %d", WindowCredit(decoded))
	}
}

func TestMalformedFramesAreRefused(t *testing.T) {
	for _, testCase := range []struct {
		name string
		raw  []byte
	}{
		{"empty", nil},
		{"shorter than the header", []byte{1, 0, 0}},
		{"stream zero is reserved", []byte{byte(FrameData), 0, 0, 0, 0}},
		{"unknown frame type", []byte{200, 0, 0, 0, 1}},
		{"end with a payload", []byte{byte(FrameEnd), 0, 0, 0, 1, 120}},
		{"accept with a payload", []byte{byte(FrameAccept), 0, 0, 0, 1, 120}},
		{"window that is not four bytes", []byte{byte(FrameWindow), 0, 0, 0, 1, 1, 2, 3}},
		{"reset carrying free text", append([]byte{byte(FrameReset), 0, 0, 0, 1}, []byte("something went wrong")...)},
		{"reset beyond its bound", append([]byte{byte(FrameReset), 0, 0, 0, 1}, bytes.Repeat([]byte("x"), 128)...)},
		{"open beyond the header bound", append([]byte{byte(FrameOpen), 0, 0, 0, 1}, bytes.Repeat([]byte("x"), connectorv1.MaxDataStreamHeaderBytes+1)...)},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := DecodeFrame(testCase.raw); err == nil {
				t.Fatal("the frame was accepted")
			} else if !errors.Is(err, ErrMalformedFrame) {
				t.Fatalf("refused with %v, want a malformed-frame error", err)
			}
		})
	}
}

func TestAResetMayOnlyCarryAProtocolErrorClass(t *testing.T) {
	// docs/SECURITY.md section 18 requires stable codes rather than free text,
	// and docs/CONNECTOR_PROTOCOL.md section 21 is the closed vocabulary.
	for _, class := range connectorv1.ErrorClassValues {
		if _, err := DecodeFrame(EncodeFrame(FrameReset, 1, []byte(class))); err != nil {
			t.Fatalf("a reset carrying %q was refused: %v", class, err)
		}
	}
	if _, err := DecodeFrame(EncodeFrame(FrameReset, 1, []byte("ROUTE_REVOKED"))); err == nil {
		t.Fatal("a reset carrying a class outside the protocol vocabulary was accepted")
	}
}

func TestFrameTypesRender(t *testing.T) {
	for _, testCase := range []struct {
		frameType FrameType
		want      string
	}{
		{FrameOpen, "open"},
		{FrameAccept, "accept"},
		{FrameData, "data"},
		{FrameEnd, "end"},
		{FrameReset, "reset"},
		{FrameWindow, "window"},
		{FrameType(200), "unknown(200)"},
	} {
		if testCase.frameType.String() != testCase.want {
			t.Fatalf("%d renders as %q", testCase.frameType, testCase.frameType.String())
		}
	}
}
