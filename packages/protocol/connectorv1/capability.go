package connectorv1

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"strconv"
	"strings"
)

// Session-scoped route capability codec.
//
// The capability is the bearer credential a browser session presents to the
// tunnel gateway when it opens a stream on a published route
// (docs/SECURITY.md section 9, docs/ARCHITECTURE.md section 7.3). The schema
// already types the field: session_capability, x-sensitive, 16 to 512
// characters of [A-Za-z0-9._~+/=-]. What the schema cannot express is the
// token's internal encoding, because the control plane mints it and the
// tunnel gateway verifies it, in two different languages.
//
// This codec therefore lives beside the schema rather than in either service,
// next to the other hand-written protocol runtime (frames, redaction,
// canonical JSON). packages/protocol/fixtures/capability/v1/manifest.json is
// the golden corpus, and both language implementations assert against it, so a
// change made in one language alone cannot land.
//
// Properties the product documents require, and where they are enforced:
//
//   - Opaque to its bearer. The token is an authenticated blob; nothing but a
//     holder of the signing key can read or forge its claims.
//   - Short-lived. ExpiresAt is inside the signed payload, so a verifier does
//     not need a lookup to reject a stale capability.
//   - Bound to route, project and browser session. All three identifiers are
//     signed, and the gateway compares each against the route it resolved from
//     the request Host, which is what makes cross-project and route-confusion
//     use a rejection rather than an audit note.
//   - Revocable immediately. CapabilityID is signed so that the control plane
//     can revoke one capability by identity without waiting for its expiry;
//     revoking the route revokes every capability bound to it.
//
// The signing key is symmetric because Stage 0 runs one control plane and one
// gateway inside a single trust zone (docs/ARCHITECTURE.md section 13, stage
// 1). KeyID is signed so that a deployment can rotate keys, and so a
// multi-instance deployment can move to asymmetric signing by adding a scheme
// without changing the token's shape.

const (
	// CapabilityScheme prefixes every route-capability token. A token that does
	// not start with it is refused before any decoding work.
	CapabilityScheme = "rp1"

	// CapabilityMACDomain separates this MAC from any other use of the same key.
	CapabilityMACDomain = "reviewplane/route-capability/v1"

	// CapabilityPayloadVersion is the only payload layout this build accepts.
	CapabilityPayloadVersion = 1

	// MaxCapabilityKeyIDLength bounds the key identifier so that the worst-case
	// token stays inside the schema's 512-character bound.
	MaxCapabilityKeyIDLength = 32

	// MaxCapabilityIdentifierLength mirrors the schema's identifier bound.
	MaxCapabilityIdentifierLength = 64

	// MinCapabilitySigningKeyBytes is the shortest key this codec will use. A
	// shorter key is a configuration error, not a weaker capability.
	MinCapabilitySigningKeyBytes = 32

	// MaxCapabilityTokenLength is the schema bound on session_capability.
	MaxCapabilityTokenLength = 512
)

// CapabilityClaims is the signed content of a route capability.
type CapabilityClaims struct {
	// KeyID selects the signing key. It is read before the MAC is checked, so
	// it is untrusted until verification succeeds; it selects a key and nothing
	// else.
	KeyID string
	// CapabilityID identifies this capability so that it can be revoked
	// individually and referenced in audit events.
	CapabilityID string
	// RouteID is the published service this capability authorises.
	RouteID string
	// ProjectID is the owning project. A capability presented against a route in
	// another project is refused (docs/SECURITY.md section 9).
	ProjectID string
	// BrowserSessionID is the single browser session allowed to use it.
	BrowserSessionID string
	// IssuedAt is Unix seconds.
	IssuedAt int64
	// ExpiresAt is Unix seconds. Capabilities always expire.
	ExpiresAt int64
}

// CapabilityRejection classifies a refused capability. The values are stable
// and appear in metrics and audit payloads; they are never returned to the
// bearer, which receives only the documented HTTP error code.
type CapabilityRejection string

const (
	CapabilityRejectionMalformed          CapabilityRejection = "malformed"
	CapabilityRejectionUnsupportedVersion CapabilityRejection = "unsupported_version"
	CapabilityRejectionUnknownKey         CapabilityRejection = "unknown_key"
	CapabilityRejectionBadSignature       CapabilityRejection = "bad_signature"
	CapabilityRejectionExpired            CapabilityRejection = "expired"
)

// CapabilityError reports why a capability was refused.
type CapabilityError struct {
	Rejection CapabilityRejection
	Msg       string
}

func (e *CapabilityError) Error() string {
	if e == nil {
		return "<nil>"
	}
	return "connectorv1: capability " + string(e.Rejection) + ": " + e.Msg
}

func rejectCapability(rejection CapabilityRejection, message string) *CapabilityError {
	return &CapabilityError{Rejection: rejection, Msg: message}
}

// CapabilityKeyring holds the symmetric signing keys a verifier accepts,
// keyed by key identifier. A minting service holds exactly one active key; a
// verifier may hold several so that a key can be rotated without invalidating
// capabilities already in flight.
type CapabilityKeyring map[string][]byte

var capabilityEncoding = base64.RawURLEncoding

// MintCapability produces the wire token for a set of claims.
//
// The result is a SensitiveString: it is a bearer credential, so every default
// representation of it is redacted (docs/SECURITY.md section 18). Only the
// caller that puts it on the wire calls Reveal.
func MintCapability(key []byte, claims CapabilityClaims) (SensitiveString, error) {
	if len(key) < MinCapabilitySigningKeyBytes {
		return "", errors.New("connectorv1: capability signing key must be at least " +
			strconv.Itoa(MinCapabilitySigningKeyBytes) + " bytes")
	}
	payload, err := encodeCapabilityPayload(claims)
	if err != nil {
		return "", err
	}
	token := CapabilityScheme + "." + capabilityEncoding.EncodeToString(payload) +
		"." + capabilityEncoding.EncodeToString(capabilityMAC(key, payload))
	if len(token) > MaxCapabilityTokenLength {
		return "", errors.New("connectorv1: capability token of " + strconv.Itoa(len(token)) +
			" characters exceeds the " + strconv.Itoa(MaxCapabilityTokenLength) + " character schema bound")
	}
	return SensitiveString(token), nil
}

// VerifyCapability authenticates a token and returns its claims.
//
// The order of the checks is a security property. Nothing in the payload is
// returned to the caller until the MAC has been verified, so a forged token
// cannot influence a routing or authorisation decision by being partially
// parsed. Expiry is checked last, on claims that are already authentic.
//
// nowUnix is supplied by the caller rather than read from the clock so that
// expiry arithmetic is testable and so a single request evaluates every
// deadline against one instant.
func VerifyCapability(keys CapabilityKeyring, token string, nowUnix int64) (CapabilityClaims, *CapabilityError) {
	if len(token) > MaxCapabilityTokenLength {
		return CapabilityClaims{}, rejectCapability(CapabilityRejectionMalformed,
			"token of "+strconv.Itoa(len(token))+" characters exceeds the "+
				strconv.Itoa(MaxCapabilityTokenLength)+" character bound")
	}
	scheme, rest, found := strings.Cut(token, ".")
	if !found || scheme != CapabilityScheme {
		return CapabilityClaims{}, rejectCapability(CapabilityRejectionMalformed, "token does not carry the "+CapabilityScheme+" scheme")
	}
	encodedPayload, encodedMAC, found := strings.Cut(rest, ".")
	if !found || strings.Contains(encodedMAC, ".") {
		return CapabilityClaims{}, rejectCapability(CapabilityRejectionMalformed, "token is not scheme.payload.signature")
	}
	payload, err := capabilityEncoding.DecodeString(encodedPayload)
	if err != nil {
		return CapabilityClaims{}, rejectCapability(CapabilityRejectionMalformed, "payload is not base64url")
	}
	mac, err := capabilityEncoding.DecodeString(encodedMAC)
	if err != nil {
		return CapabilityClaims{}, rejectCapability(CapabilityRejectionMalformed, "signature is not base64url")
	}
	claims, failure := decodeCapabilityPayload(payload)
	if failure != nil {
		return CapabilityClaims{}, failure
	}
	key, known := keys[claims.KeyID]
	if !known || len(key) < MinCapabilitySigningKeyBytes {
		// An unknown key identifier is refused without computing a MAC, so a
		// caller cannot use the timing of this path to probe for key material.
		return CapabilityClaims{}, rejectCapability(CapabilityRejectionUnknownKey, "no signing key for the token's key identifier")
	}
	if subtle.ConstantTimeCompare(mac, capabilityMAC(key, payload)) != 1 {
		return CapabilityClaims{}, rejectCapability(CapabilityRejectionBadSignature, "signature does not verify")
	}
	if nowUnix >= claims.ExpiresAt {
		return CapabilityClaims{}, rejectCapability(CapabilityRejectionExpired, "capability expired")
	}
	return claims, nil
}

func capabilityMAC(key, payload []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(CapabilityMACDomain))
	mac.Write(payload)
	return mac.Sum(nil)
}

func encodeCapabilityPayload(claims CapabilityClaims) ([]byte, error) {
	if err := boundCapabilityField("key_id", claims.KeyID, MaxCapabilityKeyIDLength); err != nil {
		return nil, err
	}
	for name, value := range map[string]string{
		"capability_id":      claims.CapabilityID,
		"route_id":           claims.RouteID,
		"project_id":         claims.ProjectID,
		"browser_session_id": claims.BrowserSessionID,
	} {
		if err := boundCapabilityField(name, value, MaxCapabilityIdentifierLength); err != nil {
			return nil, err
		}
	}
	if claims.IssuedAt < 0 || claims.ExpiresAt < 0 {
		return nil, errors.New("connectorv1: capability timestamps must not be negative")
	}
	if claims.ExpiresAt <= claims.IssuedAt {
		return nil, errors.New("connectorv1: capability must expire after it is issued")
	}
	payload := make([]byte, 0, 320)
	payload = append(payload, CapabilityPayloadVersion)
	payload = appendCapabilityField(payload, claims.KeyID)
	payload = binary.BigEndian.AppendUint64(payload, uint64(claims.IssuedAt))
	payload = binary.BigEndian.AppendUint64(payload, uint64(claims.ExpiresAt))
	payload = appendCapabilityField(payload, claims.CapabilityID)
	payload = appendCapabilityField(payload, claims.RouteID)
	payload = appendCapabilityField(payload, claims.ProjectID)
	payload = appendCapabilityField(payload, claims.BrowserSessionID)
	return payload, nil
}

func decodeCapabilityPayload(payload []byte) (CapabilityClaims, *CapabilityError) {
	cursor := 0
	if len(payload) < 1 {
		return CapabilityClaims{}, rejectCapability(CapabilityRejectionMalformed, "payload is empty")
	}
	if payload[0] != CapabilityPayloadVersion {
		return CapabilityClaims{}, rejectCapability(CapabilityRejectionUnsupportedVersion,
			"payload version "+strconv.Itoa(int(payload[0]))+" is not supported")
	}
	cursor++
	keyID, cursor, ok := readCapabilityField(payload, cursor)
	if !ok {
		return CapabilityClaims{}, rejectCapability(CapabilityRejectionMalformed, "payload is truncated at key_id")
	}
	if cursor+16 > len(payload) {
		return CapabilityClaims{}, rejectCapability(CapabilityRejectionMalformed, "payload is truncated at the timestamps")
	}
	issuedAt := int64(binary.BigEndian.Uint64(payload[cursor : cursor+8]))
	expiresAt := int64(binary.BigEndian.Uint64(payload[cursor+8 : cursor+16]))
	cursor += 16
	capabilityID, cursor, ok := readCapabilityField(payload, cursor)
	if !ok {
		return CapabilityClaims{}, rejectCapability(CapabilityRejectionMalformed, "payload is truncated at capability_id")
	}
	routeID, cursor, ok := readCapabilityField(payload, cursor)
	if !ok {
		return CapabilityClaims{}, rejectCapability(CapabilityRejectionMalformed, "payload is truncated at route_id")
	}
	projectID, cursor, ok := readCapabilityField(payload, cursor)
	if !ok {
		return CapabilityClaims{}, rejectCapability(CapabilityRejectionMalformed, "payload is truncated at project_id")
	}
	browserSessionID, cursor, ok := readCapabilityField(payload, cursor)
	if !ok {
		return CapabilityClaims{}, rejectCapability(CapabilityRejectionMalformed, "payload is truncated at browser_session_id")
	}
	if cursor != len(payload) {
		return CapabilityClaims{}, rejectCapability(CapabilityRejectionMalformed, "payload carries trailing bytes")
	}
	if issuedAt < 0 || expiresAt < 0 {
		return CapabilityClaims{}, rejectCapability(CapabilityRejectionMalformed, "payload timestamps are out of range")
	}
	return CapabilityClaims{
		KeyID:            keyID,
		CapabilityID:     capabilityID,
		RouteID:          routeID,
		ProjectID:        projectID,
		BrowserSessionID: browserSessionID,
		IssuedAt:         issuedAt,
		ExpiresAt:        expiresAt,
	}, nil
}

func boundCapabilityField(name, value string, maximum int) error {
	if value == "" {
		return errors.New("connectorv1: capability " + name + " must not be empty")
	}
	if len(value) > maximum {
		return errors.New("connectorv1: capability " + name + " exceeds " + strconv.Itoa(maximum) + " bytes")
	}
	return nil
}

func appendCapabilityField(payload []byte, value string) []byte {
	payload = append(payload, byte(len(value)))
	return append(payload, value...)
}

func readCapabilityField(payload []byte, cursor int) (string, int, bool) {
	if cursor >= len(payload) {
		return "", cursor, false
	}
	length := int(payload[cursor])
	cursor++
	if cursor+length > len(payload) {
		return "", cursor, false
	}
	return string(payload[cursor : cursor+length]), cursor + length, true
}
