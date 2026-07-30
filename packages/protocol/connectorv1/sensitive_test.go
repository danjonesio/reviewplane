package connectorv1

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"testing"
)

// docs/SECURITY.md section 18 forbids raw credentials in logs. The enrolment
// token and the session capability are the two credentials this protocol
// carries, so every representation other than the deliberate wire encoding must
// redact them.

const secret = "MU5vbmNlLTAxSkFCQ0RFRkdISktMTU5PUFFSU1RVVg"

func decodedRegistrationRequest(t *testing.T) (Frame, RegistrationRequest) {
	t.Helper()
	frame, failure := DecodeControlFrame(readFixture(t, "valid/registration-request.json"))
	if failure != nil {
		t.Fatalf("fixture refused: %v", failure)
	}
	request, ok := frame.Payload.(RegistrationRequest)
	if !ok {
		t.Fatalf("unexpected payload %T", frame.Payload)
	}
	return frame, request
}

func TestEnrolmentTokenIsRedactedInEveryDefaultRepresentation(t *testing.T) {
	_, request := decodedRegistrationRequest(t)
	if request.EnrolmentToken.Reveal() != secret {
		t.Fatalf("fixture no longer carries the expected token")
	}

	representations := map[string]string{
		"String":            request.EnrolmentToken.String(),
		"GoString":          request.EnrolmentToken.GoString(),
		"fmt %v":            fmt.Sprintf("%v", request.EnrolmentToken),
		"fmt %s":            fmt.Sprintf("%s", request.EnrolmentToken),
		"fmt %q":            fmt.Sprintf("%q", request.EnrolmentToken),
		"fmt %x":            fmt.Sprintf("%x", request.EnrolmentToken),
		"fmt %#v":           fmt.Sprintf("%#v", request.EnrolmentToken),
		"struct %v":         fmt.Sprintf("%v", request),
		"struct %+v":        fmt.Sprintf("%+v", request),
		"struct %#v":        fmt.Sprintf("%#v", request),
		"frame %+v":         fmt.Sprintf("%+v", mustDecodedFrame(t)),
		"error interpolate": fmt.Errorf("registration failed for %v", request).Error(),
	}
	for name, representation := range representations {
		if strings.Contains(representation, secret) {
			t.Errorf("%s leaked the enrolment token: %s", name, representation)
		}
		if !strings.Contains(representation, Redacted) {
			t.Errorf("%s did not carry the redaction marker: %s", name, representation)
		}
	}
}

func mustDecodedFrame(t *testing.T) Frame {
	t.Helper()
	frame, _ := decodedRegistrationRequest(t)
	return frame
}

func TestEnrolmentTokenIsRedactedByEncodingJSON(t *testing.T) {
	_, request := decodedRegistrationRequest(t)

	marshalled, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if bytes.Contains(marshalled, []byte(secret)) {
		t.Fatalf("encoding/json leaked the enrolment token: %s", marshalled)
	}
	if !bytes.Contains(marshalled, []byte(Redacted)) {
		t.Fatalf("encoding/json did not redact the enrolment token: %s", marshalled)
	}
}

func TestEnrolmentTokenIsRedactedBySlog(t *testing.T) {
	_, request := decodedRegistrationRequest(t)

	var sink bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&sink, nil))
	logger.Info("connector registration", "token", request.EnrolmentToken, "request", request)
	if strings.Contains(sink.String(), secret) {
		t.Fatalf("slog leaked the enrolment token: %s", sink.String())
	}
	if !strings.Contains(sink.String(), Redacted) {
		t.Fatalf("slog did not redact the enrolment token: %s", sink.String())
	}
}

// The wire encoding is the one place the secret is deliberately revealed.
func TestCanonicalEncodingCarriesTheRealToken(t *testing.T) {
	frame, _ := decodedRegistrationRequest(t)
	encoded, err := EncodeControlFrame(frame)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if !bytes.Contains(encoded, []byte(secret)) {
		t.Fatal("the wire frame must carry the real enrolment token")
	}
}

func TestSessionCapabilityIsRedacted(t *testing.T) {
	header, failure := DecodeDataStreamHeaderFrame(readFixture(t, "valid/data-stream-header.json"))
	if failure != nil {
		t.Fatalf("fixture refused: %v", failure)
	}
	capability := header.SessionCapability.Reveal()
	if capability == "" {
		t.Fatal("fixture no longer carries a capability")
	}

	rendered := fmt.Sprintf("%+v", header)
	if strings.Contains(rendered, capability) {
		t.Fatalf("the data-stream header leaked the session capability: %s", rendered)
	}

	marshalled, err := json.Marshal(header)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if bytes.Contains(marshalled, []byte(capability)) {
		t.Fatalf("encoding/json leaked the session capability: %s", marshalled)
	}

	encoded, err := EncodeDataStreamHeaderFrame(header)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if !bytes.Contains(encoded, []byte(capability)) {
		t.Fatal("the wire header must carry the real capability")
	}
}
