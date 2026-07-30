// Package yamlmin parses the small YAML subset the connector configuration
// file uses (docs/CONNECTOR_PROTOCOL.md section 20).
//
// The connector ships as a statically linked binary with no third-party
// dependencies (docs/CONNECTOR_PROTOCOL.md section 3, docs/SECURITY.md section
// 19), and the standard library has no YAML parser. Rather than take a
// dependency for one configuration file, this package implements exactly the
// constructs the documented configuration uses and refuses everything else with
// a line-numbered error. That mirrors the rule packages/protocol already
// applies to its schema subset: refuse what cannot be enforced rather than
// silently accept it.
//
// Supported:
//
//	comments introduced by '#'
//	block mappings              key: value
//	nested mappings             key: followed by a more-indented block
//	block sequences             - scalar   and   - key: value
//	flow sequences              key: [a, b]
//	plain, single- and double-quoted scalars
//	an optional leading document marker '---'
//
// Refused: tabs for indentation, anchors, aliases, tags, multi-line scalars,
// flow mappings, multiple documents, and duplicate keys.
package yamlmin

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// Kind distinguishes the three node shapes this subset produces.
type Kind int

const (
	// KindScalar is a single value. An absent value is a scalar with Null set.
	KindScalar Kind = iota
	// KindMapping is a block mapping.
	KindMapping
	// KindSequence is a block or flow sequence.
	KindSequence
)

// MaxInputBytes bounds the configuration file this parser will accept. A
// configuration file is operator-supplied rather than attacker-supplied, but
// the connector parser is bounded everywhere else (docs/DEVELOPMENT.md section
// 10) and this keeps that property uniform.
const MaxInputBytes = 1 << 20

// Node is one parsed value.
type Node struct {
	Kind   Kind
	Line   int
	Scalar string
	// Null reports a key written with no value at all, such as "logging:" with
	// no indented block beneath it.
	Null bool
	// Keys preserves mapping key order so that errors report keys in the order
	// the operator wrote them.
	Keys   []string
	Fields map[string]*Node
	Items  []*Node
}

// Error is a parse or decode failure located in the source file.
type Error struct {
	Line   int
	Detail string
}

func (e *Error) Error() string {
	if e.Line <= 0 {
		return e.Detail
	}
	return "line " + strconv.Itoa(e.Line) + ": " + e.Detail
}

func errorAt(line int, format string, args ...any) *Error {
	return &Error{Line: line, Detail: fmt.Sprintf(format, args...)}
}

type sourceLine struct {
	indent int
	text   string
	number int
}

// Parse reads the supported subset and returns the document's root node. An
// empty document yields an empty mapping.
func Parse(data []byte) (*Node, error) {
	if len(data) > MaxInputBytes {
		return nil, &Error{Detail: "configuration exceeds the " + strconv.Itoa(MaxInputBytes) + " byte bound"}
	}
	lines, err := scan(string(data))
	if err != nil {
		return nil, err
	}
	if len(lines) == 0 {
		return &Node{Kind: KindMapping, Fields: map[string]*Node{}}, nil
	}
	if lines[0].indent != 0 {
		return nil, errorAt(lines[0].number, "document must start at column 1")
	}
	node, next, err := parseBlock(lines, 0, 0)
	if err != nil {
		return nil, err
	}
	if next != len(lines) {
		return nil, errorAt(lines[next].number, "unexpected indentation")
	}
	return node, nil
}

// scan strips comments and blank lines and records each remaining line's
// indentation.
func scan(text string) ([]sourceLine, error) {
	var out []sourceLine
	for index, raw := range strings.Split(text, "\n") {
		number := index + 1
		raw = strings.TrimSuffix(raw, "\r")
		if strings.IndexByte(raw, '\t') >= 0 && strings.TrimLeft(raw, " ") != strings.TrimLeft(raw, " \t") {
			return nil, errorAt(number, "tabs may not be used for indentation")
		}
		body, err := stripComment(raw, number)
		if err != nil {
			return nil, err
		}
		trimmed := strings.TrimRight(body, " ")
		if strings.TrimSpace(trimmed) == "" {
			continue
		}
		indent := len(trimmed) - len(strings.TrimLeft(trimmed, " "))
		content := trimmed[indent:]
		if content == "---" {
			if len(out) > 0 {
				return nil, errorAt(number, "multiple documents are not supported")
			}
			continue
		}
		if content == "..." {
			return nil, errorAt(number, "document end markers are not supported")
		}
		if indent%2 != 0 {
			return nil, errorAt(number, "indentation must be a multiple of two spaces, found %d", indent)
		}
		out = append(out, sourceLine{indent: indent, text: content, number: number})
	}
	return out, nil
}

// stripComment removes a '#' comment while respecting quoted scalars.
func stripComment(raw string, number int) (string, error) {
	var quote byte
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		switch {
		case quote == '"' && c == '\\':
			i++
		case quote != 0 && c == quote:
			quote = 0
		case quote != 0:
		case c == '"' || c == '\'':
			quote = c
		case c == '#' && (i == 0 || raw[i-1] == ' '):
			return raw[:i], nil
		}
	}
	if quote != 0 {
		return "", errorAt(number, "unterminated quoted scalar")
	}
	return raw, nil
}

func parseBlock(lines []sourceLine, start, indent int) (*Node, int, error) {
	if start >= len(lines) {
		return &Node{Kind: KindScalar, Null: true}, start, nil
	}
	if strings.HasPrefix(lines[start].text, "- ") || lines[start].text == "-" {
		return parseSequence(lines, start, indent)
	}
	return parseMapping(lines, start, indent)
}

func parseMapping(lines []sourceLine, start, indent int) (*Node, int, error) {
	node := &Node{Kind: KindMapping, Line: lines[start].number, Fields: map[string]*Node{}}
	i := start
	for i < len(lines) && lines[i].indent == indent {
		line := lines[i]
		if strings.HasPrefix(line.text, "- ") || line.text == "-" {
			return nil, 0, errorAt(line.number, "sequence item found where a mapping key was expected")
		}
		key, rest, err := splitKey(line)
		if err != nil {
			return nil, 0, err
		}
		if _, seen := node.Fields[key]; seen {
			return nil, 0, errorAt(line.number, "duplicate key %q", key)
		}
		i++
		var value *Node
		switch {
		case rest != "":
			value, err = parseInlineValue(rest, line.number)
			if err != nil {
				return nil, 0, err
			}
		case i < len(lines) && lines[i].indent > indent:
			value, i, err = parseBlock(lines, i, lines[i].indent)
			if err != nil {
				return nil, 0, err
			}
		default:
			value = &Node{Kind: KindScalar, Line: line.number, Null: true}
		}
		node.Keys = append(node.Keys, key)
		node.Fields[key] = value
	}
	if i < len(lines) && lines[i].indent > indent {
		return nil, 0, errorAt(lines[i].number, "unexpected indentation")
	}
	return node, i, nil
}

func parseSequence(lines []sourceLine, start, indent int) (*Node, int, error) {
	node := &Node{Kind: KindSequence, Line: lines[start].number}
	i := start
	for i < len(lines) && lines[i].indent == indent &&
		(strings.HasPrefix(lines[i].text, "- ") || lines[i].text == "-") {
		line := lines[i]
		rest := strings.TrimPrefix(strings.TrimPrefix(line.text, "-"), " ")
		i++
		switch {
		case rest == "":
			if i >= len(lines) || lines[i].indent <= indent {
				return nil, 0, errorAt(line.number, "sequence item has no value")
			}
			item, next, err := parseBlock(lines, i, lines[i].indent)
			if err != nil {
				return nil, 0, err
			}
			node.Items = append(node.Items, item)
			i = next
		case isKeyLine(rest):
			// "- key: value" opens a mapping whose keys sit two columns in.
			nested := make([]sourceLine, 0, len(lines)-i+1)
			nested = append(nested, sourceLine{indent: indent + 2, text: rest, number: line.number})
			nested = append(nested, lines[i:]...)
			item, next, err := parseMapping(nested, 0, indent+2)
			if err != nil {
				return nil, 0, err
			}
			node.Items = append(node.Items, item)
			i += next - 1
		default:
			item, err := parseInlineValue(rest, line.number)
			if err != nil {
				return nil, 0, err
			}
			node.Items = append(node.Items, item)
		}
	}
	if i < len(lines) && lines[i].indent > indent {
		return nil, 0, errorAt(lines[i].number, "unexpected indentation")
	}
	return node, i, nil
}

// isKeyLine reports whether text opens a mapping rather than a plain scalar.
func isKeyLine(text string) bool {
	_, _, err := splitKey(sourceLine{text: text})
	return err == nil
}

func splitKey(line sourceLine) (string, string, error) {
	text := line.text
	if strings.HasPrefix(text, "\"") || strings.HasPrefix(text, "'") {
		return "", "", errorAt(line.number, "quoted mapping keys are not supported")
	}
	colon := -1
	for i := 0; i < len(text); i++ {
		if text[i] != ':' {
			continue
		}
		if i+1 == len(text) || text[i+1] == ' ' {
			colon = i
			break
		}
	}
	if colon < 0 {
		return "", "", errorAt(line.number, "expected \"key: value\", found %q", text)
	}
	key := strings.TrimRight(text[:colon], " ")
	if key == "" {
		return "", "", errorAt(line.number, "mapping key is empty")
	}
	if strings.ContainsAny(key, "{}[]&*!|>%@`") {
		return "", "", errorAt(line.number, "mapping key %q uses an unsupported YAML construct", key)
	}
	return key, strings.TrimSpace(text[colon+1:]), nil
}

func parseInlineValue(text string, number int) (*Node, error) {
	if strings.HasPrefix(text, "[") {
		return parseFlowSequence(text, number)
	}
	if strings.HasPrefix(text, "{") {
		return nil, errorAt(number, "flow mappings are not supported")
	}
	if strings.HasPrefix(text, "|") || strings.HasPrefix(text, ">") {
		return nil, errorAt(number, "multi-line scalars are not supported")
	}
	if strings.HasPrefix(text, "&") || strings.HasPrefix(text, "*") || strings.HasPrefix(text, "!") {
		return nil, errorAt(number, "anchors, aliases and tags are not supported")
	}
	scalar, err := parseScalar(text, number)
	if err != nil {
		return nil, err
	}
	return scalar, nil
}

func parseFlowSequence(text string, number int) (*Node, error) {
	if !strings.HasSuffix(text, "]") {
		return nil, errorAt(number, "flow sequence is not closed")
	}
	inner := strings.TrimSpace(text[1 : len(text)-1])
	node := &Node{Kind: KindSequence, Line: number}
	if inner == "" {
		return node, nil
	}
	for _, part := range splitFlowItems(inner) {
		item, err := parseScalar(strings.TrimSpace(part), number)
		if err != nil {
			return nil, err
		}
		node.Items = append(node.Items, item)
	}
	return node, nil
}

func splitFlowItems(inner string) []string {
	var parts []string
	var quote byte
	start := 0
	for i := 0; i < len(inner); i++ {
		c := inner[i]
		switch {
		case quote == '"' && c == '\\':
			i++
		case quote != 0 && c == quote:
			quote = 0
		case quote != 0:
		case c == '"' || c == '\'':
			quote = c
		case c == ',':
			parts = append(parts, inner[start:i])
			start = i + 1
		}
	}
	return append(parts, inner[start:])
}

func parseScalar(text string, number int) (*Node, error) {
	node := &Node{Kind: KindScalar, Line: number}
	switch {
	case text == "" || text == "~" || text == "null":
		node.Null = true
		return node, nil
	case strings.HasPrefix(text, "\""):
		value, err := unquoteDouble(text, number)
		if err != nil {
			return nil, err
		}
		node.Scalar = value
		return node, nil
	case strings.HasPrefix(text, "'"):
		if !strings.HasSuffix(text, "'") || len(text) < 2 {
			return nil, errorAt(number, "unterminated single-quoted scalar")
		}
		node.Scalar = strings.ReplaceAll(text[1:len(text)-1], "''", "'")
		return node, nil
	default:
		if strings.ContainsAny(text, "\"'") {
			return nil, errorAt(number, "plain scalar %q contains a quote; quote the whole value instead", text)
		}
		node.Scalar = text
		return node, nil
	}
}

func unquoteDouble(text string, number int) (string, error) {
	if !strings.HasSuffix(text, "\"") || len(text) < 2 {
		return "", errorAt(number, "unterminated double-quoted scalar")
	}
	var out strings.Builder
	body := text[1 : len(text)-1]
	for i := 0; i < len(body); i++ {
		if body[i] != '\\' {
			out.WriteByte(body[i])
			continue
		}
		i++
		if i >= len(body) {
			return "", errorAt(number, "double-quoted scalar ends with an incomplete escape")
		}
		switch body[i] {
		case 'n':
			out.WriteByte('\n')
		case 't':
			out.WriteByte('\t')
		case 'r':
			out.WriteByte('\r')
		case '"':
			out.WriteByte('"')
		case '\\':
			out.WriteByte('\\')
		default:
			return "", errorAt(number, "unsupported escape \\%c", body[i])
		}
	}
	return out.String(), nil
}

// ErrNotFound reports a missing key. Callers use it to apply a default.
var ErrNotFound = errors.New("yamlmin: key not found")
