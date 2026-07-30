package connectorv1

import (
	"errors"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"
)

// ErrNotFinite is returned when an encoder is handed a NaN or infinity, which
// JSON cannot represent.
var ErrNotFinite = errors.New("connectorv1: number is not finite")

// errUnknownPayload is returned when a Payload implementation is not one of the
// generated payload types.
var errUnknownPayload = errors.New("connectorv1: unknown payload type")

// canonicalWriter builds a canonical JSON document.
//
// The TypeScript package builds byte-identical output: properties appear in
// schema order, absent optional properties are omitted, strings use the same
// escape set (no HTML escaping, U+2028 and U+2029 escaped) and numbers use the
// ECMAScript number-to-string algorithm.
type canonicalWriter struct {
	buf   []byte
	first []bool
	err   error
}

func (w *canonicalWriter) beginObject() {
	w.buf = append(w.buf, '{')
	w.first = append(w.first, true)
}

func (w *canonicalWriter) endObject() {
	w.buf = append(w.buf, '}')
	w.pop()
}

func (w *canonicalWriter) beginArray() {
	w.buf = append(w.buf, '[')
	w.first = append(w.first, true)
}

func (w *canonicalWriter) endArray() {
	w.buf = append(w.buf, ']')
	w.pop()
}

func (w *canonicalWriter) pop() {
	if len(w.first) > 0 {
		w.first = w.first[:len(w.first)-1]
	}
}

func (w *canonicalWriter) separate() {
	if len(w.first) == 0 {
		return
	}
	if w.first[len(w.first)-1] {
		w.first[len(w.first)-1] = false
		return
	}
	w.buf = append(w.buf, ',')
}

func (w *canonicalWriter) key(name string) {
	w.separate()
	w.buf = appendJSONString(w.buf, name)
	w.buf = append(w.buf, ':')
}

func (w *canonicalWriter) item() {
	w.separate()
}

func (w *canonicalWriter) string(value string) {
	w.buf = appendJSONString(w.buf, value)
}

func (w *canonicalWriter) integer(value int64) {
	w.buf = strconv.AppendInt(w.buf, value, 10)
}

func (w *canonicalWriter) number(value float64) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		w.err = ErrNotFinite
		w.buf = append(w.buf, '0')
		return
	}
	w.buf = append(w.buf, formatECMANumber(value)...)
}

func (w *canonicalWriter) boolean(value bool) {
	if value {
		w.buf = append(w.buf, "true"...)
		return
	}
	w.buf = append(w.buf, "false"...)
}

func (w *canonicalWriter) raw(value []byte) {
	w.buf = append(w.buf, value...)
}

func (w *canonicalWriter) result() ([]byte, error) {
	if w.err != nil {
		return nil, w.err
	}
	return w.buf, nil
}

const hexDigits = "0123456789abcdef"

// appendJSONString escapes exactly the characters ECMAScript's JSON.stringify
// escapes, plus U+2028 and U+2029, which JSON.stringify leaves raw but the
// TypeScript encoder escapes for parity.
func appendJSONString(dst []byte, value string) []byte {
	dst = append(dst, '"')
	for index := 0; index < len(value); {
		char := value[index]
		if char < utf8.RuneSelf {
			switch {
			case char == '"':
				dst = append(dst, '\\', '"')
			case char == '\\':
				dst = append(dst, '\\', '\\')
			case char == '\b':
				dst = append(dst, '\\', 'b')
			case char == '\f':
				dst = append(dst, '\\', 'f')
			case char == '\n':
				dst = append(dst, '\\', 'n')
			case char == '\r':
				dst = append(dst, '\\', 'r')
			case char == '\t':
				dst = append(dst, '\\', 't')
			case char < 0x20:
				dst = append(dst, '\\', 'u', '0', '0', hexDigits[char>>4], hexDigits[char&0xF])
			default:
				dst = append(dst, char)
			}
			index++
			continue
		}
		runeValue, size := utf8.DecodeRuneInString(value[index:])
		if runeValue == utf8.RuneError && size == 1 {
			// Invalid UTF-8 cannot survive a round trip. Emit the replacement
			// character, which is what a JSON decoder would have produced.
			dst = append(dst, "\uFFFD"...)
			index++
			continue
		}
		if runeValue == '\u2028' || runeValue == '\u2029' {
			dst = append(dst, '\\', 'u', '2', '0', '2', hexDigits[runeValue&0xF])
			index += size
			continue
		}
		dst = append(dst, value[index:index+size]...)
		index += size
	}
	return append(dst, '"')
}

// formatECMANumber renders a finite float64 the way ECMAScript's
// Number::toString renders it, which is what JSON.stringify emits. Go's own
// formatting differs in exponent form (1e-07 rather than 1e-7), so a shared
// implementation is required for byte-identical output across the two
// languages.
func formatECMANumber(value float64) string {
	if value == 0 {
		return "0"
	}

	shortest := strconv.FormatFloat(value, 'e', -1, 64)
	sign := ""
	body := shortest
	if body[0] == '-' {
		sign = "-"
		body = body[1:]
	}
	mantissa, exponentText, found := strings.Cut(body, "e")
	if !found {
		return shortest
	}
	exponent, err := strconv.Atoi(exponentText)
	if err != nil {
		return shortest
	}
	digits := mantissa[:1]
	if len(mantissa) > 2 {
		digits += mantissa[2:]
	}

	// ECMAScript Number::toString: k is the digit count and n is the position
	// of the decimal point relative to the digit string.
	k := len(digits)
	n := exponent + 1

	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	}

	exponentSign := "+"
	exponentValue := n - 1
	if exponentValue < 0 {
		exponentSign = "-"
		exponentValue = -exponentValue
	}
	if k == 1 {
		return sign + digits + "e" + exponentSign + strconv.Itoa(exponentValue)
	}
	return sign + digits[:1] + "." + digits[1:] + "e" + exponentSign + strconv.Itoa(exponentValue)
}
