package connectorv1

import (
	"strings"
	"testing"
)

// The canonical writer must format numbers and strings exactly as the
// TypeScript encoder does, or the two languages cannot produce byte-identical
// frames. The expectations below are the output of ECMAScript's
// String(value) and JSON.stringify, which the TypeScript encoder uses directly.

func TestFormatECMANumberMatchesECMAScript(t *testing.T) {
	cases := []struct {
		value    float64
		expected string
	}{
		{0, "0"},
		{-0, "0"},
		{1, "1"},
		{-1, "-1"},
		{0.42, "0.42"},
		{1.5, "1.5"},
		{100, "100"},
		{8132, "8132"},
		{8200000000, "8200000000"},
		{9007199254740991, "9007199254740991"},
		{0.000001, "0.000001"},
		{1e-7, "1e-7"},
		{1.25e-8, "1.25e-8"},
		{1e21, "1e+21"},
		{1.5e22, "1.5e+22"},
		{1e20, "100000000000000000000"},
		{0.1, "0.1"},
		{1.0 / 3.0, "0.3333333333333333"},
		{1024, "1024"},
	}
	for _, testCase := range cases {
		if formatted := formatECMANumber(testCase.value); formatted != testCase.expected {
			t.Errorf("formatECMANumber(%v) = %q, want %q", testCase.value, formatted, testCase.expected)
		}
	}
}

func TestAppendJSONStringEscapesLikeECMAScript(t *testing.T) {
	cases := []struct {
		value    string
		expected string
	}{
		{"plain", `"plain"`},
		{`quote"inside`, `"quote\"inside"`},
		{`back\slash`, `"back\\slash"`},
		{"tab\there", `"tab\there"`},
		{"line\nbreak", `"line\nbreak"`},
		{"bell\u0007", `"bell\u0007"`},
		// HTML-significant characters are not escaped, matching JSON.stringify
		// and unlike Go's encoding/json default.
		{"<tag> & 'amp'", `"<tag> & 'amp'"`},
		{"日本語", `"日本語"`},
		{"\U0001f680", "\"\U0001f680\""},
		// U+2028 and U+2029 are escaped for parity with the TypeScript encoder.
		{"line\u2028separator", `"line\u2028separator"`},
		{"paragraph\u2029separator", `"paragraph\u2029separator"`},
	}
	for _, testCase := range cases {
		if formatted := string(appendJSONString(nil, testCase.value)); formatted != testCase.expected {
			t.Errorf("appendJSONString(%q) = %s, want %s", testCase.value, formatted, testCase.expected)
		}
	}
}

func TestCanonicalWriterReportsNonFiniteNumbers(t *testing.T) {
	var writer canonicalWriter
	writer.beginObject()
	writer.key("load")
	writer.number(positiveInfinity())
	writer.endObject()
	if _, err := writer.result(); err == nil {
		t.Fatal("expected a non-finite number to be reported")
	}
}

func positiveInfinity() float64 {
	large := 1e308
	return large * 10
}

// Every generated pattern must compile under RE2 as well as under the
// JavaScript engine. Compilation happens at package initialisation, so reaching
// this test at all proves it; the assertion guards against an empty set.
func TestGeneratedPatternsCompile(t *testing.T) {
	if pattern0 == nil {
		t.Fatal("no generated patterns were compiled")
	}
	if !pattern0.MatchString("con_01JQ8ZR3M4T5V6W7X8Y9Z0A1C2") {
		t.Fatal("the identifier pattern rejects a conventional identifier")
	}
	if pattern0.MatchString("con id") {
		t.Fatal("the identifier pattern accepts whitespace")
	}
	if strings.Contains(pattern0.String(), "con_") {
		t.Fatal("the identifier pattern must not constrain the prefix")
	}
}
