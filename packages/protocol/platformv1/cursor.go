package platformv1

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
)

// Opaque pagination cursors (docs/API.md section 6).
//
// A cursor is base64url text carrying the canonical encoding of CursorClaims:
// the sort key and the identifier of the last row of the previous page. Both
// languages encode through the generated canonical encoder, so the same page
// produces the same bytes — the property the committed corpus asserts.
//
// "Opaque" is a contract on the client, not an encryption claim: the value is
// readable by anyone who base64-decodes it, and carries nothing a caller could
// not already see in the page it came from. What the opacity buys is freedom to
// change the pagination key without breaking a client, and the right to refuse a
// cursor this server did not produce rather than to interpret it charitably.

// CursorVersion is the only cursor format this build produces or accepts.
const CursorVersion int64 = 1

// MaxCursorLength bounds the encoded cursor, from $defs.cursor in the schema.
const MaxCursorLength = 512

// CursorRejection is the stable reason a cursor was refused.
type CursorRejection string

const (
	CursorRejectionMalformedEncoding CursorRejection = "malformed_encoding"
	CursorRejectionMalformedJSON     CursorRejection = "malformed_json"
	CursorRejectionSchemaViolation   CursorRejection = "schema_violation"
	CursorRejectionUnsupportedVer    CursorRejection = "unsupported_version"
	CursorRejectionTooLong           CursorRejection = "too_long"
)

// CursorError reports a refused or unencodable cursor.
type CursorError struct {
	Rejection CursorRejection
	Msg       string
}

func (e *CursorError) Error() string {
	if e == nil {
		return "<nil>"
	}
	return "platformv1: cursor " + string(e.Rejection) + ": " + e.Msg
}

var cursorEncoding = base64.RawURLEncoding

// ErrCursorClaimsInvalid is returned when claims do not satisfy the schema.
var ErrCursorClaimsInvalid = errors.New("platformv1: cursor claims do not satisfy the schema")

// EncodeCursor encodes the position after the last row of a page.
func EncodeCursor(claims CursorClaims) (string, error) {
	if claims.Version != CursorVersion {
		return "", &CursorError{
			Rejection: CursorRejectionUnsupportedVer,
			Msg:       "version " + strconv.FormatInt(claims.Version, 10) + " is not " + strconv.FormatInt(CursorVersion, 10),
		}
	}
	var violations []SchemaViolation
	validateCursorClaims(cursorTree(claims), "$", &violations)
	if len(violations) > 0 {
		return "", ErrCursorClaimsInvalid
	}
	canonical, err := EncodeCursorClaims(claims)
	if err != nil {
		return "", err
	}
	encoded := cursorEncoding.EncodeToString(canonical)
	if len(encoded) > MaxCursorLength {
		return "", &CursorError{
			Rejection: CursorRejectionTooLong,
			Msg:       "cursor of " + strconv.Itoa(len(encoded)) + " characters exceeds the bound",
		}
	}
	return encoded, nil
}

// DecodeCursor decodes a cursor a caller presented.
//
// Every failure is a refusal rather than a fallback to the first page: a caller
// that sends a cursor this server did not produce is asking for a page nobody
// can define, and silently answering with a different one would make pagination
// lose rows without saying so.
func DecodeCursor(text string) (CursorClaims, *CursorError) {
	if len(text) > MaxCursorLength {
		return CursorClaims{}, &CursorError{Rejection: CursorRejectionTooLong, Msg: "cursor is longer than the bound"}
	}
	raw, err := cursorEncoding.DecodeString(text)
	if err != nil {
		return CursorClaims{}, &CursorError{Rejection: CursorRejectionMalformedEncoding, Msg: err.Error()}
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return CursorClaims{}, &CursorError{Rejection: CursorRejectionMalformedJSON, Msg: err.Error()}
	}
	if decoder.More() {
		return CursorClaims{}, &CursorError{Rejection: CursorRejectionMalformedJSON, Msg: "trailing data after the JSON value"}
	}
	source, ok := value.(map[string]any)
	if !ok {
		return CursorClaims{}, &CursorError{Rejection: CursorRejectionSchemaViolation, Msg: "cursor is not a JSON object"}
	}
	version, ok := asInt64(source["version"])
	if !ok || version != CursorVersion {
		return CursorClaims{}, &CursorError{Rejection: CursorRejectionUnsupportedVer, Msg: "unsupported cursor version"}
	}
	var violations []SchemaViolation
	validateCursorClaims(source, "$", &violations)
	if len(violations) > 0 {
		return CursorClaims{}, &CursorError{Rejection: CursorRejectionSchemaViolation, Msg: violations[0].Message}
	}
	return DecodeCursorClaims(source), nil
}

// cursorTree renders claims as the generic tree the generated validator reads,
// so that encoding runs the same checks decoding does.
func cursorTree(claims CursorClaims) map[string]any {
	return map[string]any{
		"version":  json.Number(strconv.FormatInt(claims.Version, 10)),
		"sort_key": claims.SortKey,
		"id":       claims.ID,
	}
}
