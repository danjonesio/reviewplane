package yamlmin

import (
	"sort"
	"strconv"
	"strings"
	"time"
)

// Mapping asserts that the node is a mapping and reports its named location on
// failure. name is the dotted configuration path, used verbatim in errors so
// that docs/DEVELOPMENT.md section 6's "fail with specific errors" holds.
func (n *Node) Mapping(name string) (*Node, error) {
	if n == nil || n.Null {
		return &Node{Kind: KindMapping, Fields: map[string]*Node{}}, nil
	}
	if n.Kind != KindMapping {
		return nil, errorAt(n.Line, "%s must be a mapping", name)
	}
	return n, nil
}

// Child returns the named child of a mapping, or nil when it is absent.
func (n *Node) Child(key string) *Node {
	if n == nil || n.Kind != KindMapping {
		return nil
	}
	return n.Fields[key]
}

// RejectUnknownKeys fails when the mapping carries a key outside allowed.
// docs/CONFIGURATION.md section 1 requires configuration to fail clearly on an
// unknown setting rather than ignore it.
func (n *Node) RejectUnknownKeys(name string, allowed ...string) error {
	if n == nil || n.Kind != KindMapping {
		return nil
	}
	permitted := make(map[string]bool, len(allowed))
	for _, key := range allowed {
		permitted[key] = true
	}
	for _, key := range n.Keys {
		if permitted[key] {
			continue
		}
		known := append([]string(nil), allowed...)
		sort.Strings(known)
		return errorAt(n.Fields[key].Line, "unknown setting %s.%s; known settings are %s",
			name, key, strings.Join(known, ", "))
	}
	return nil
}

// String reads a scalar string.
func (n *Node) String(name string) (string, error) {
	if n == nil {
		return "", ErrNotFound
	}
	if n.Kind != KindScalar || n.Null {
		return "", errorAt(n.Line, "%s must be a string", name)
	}
	return n.Scalar, nil
}

// Bool reads a scalar boolean.
func (n *Node) Bool(name string) (bool, error) {
	if n == nil {
		return false, ErrNotFound
	}
	if n.Kind != KindScalar || n.Null {
		return false, errorAt(n.Line, "%s must be true or false", name)
	}
	switch strings.ToLower(n.Scalar) {
	case "true", "yes", "on":
		return true, nil
	case "false", "no", "off":
		return false, nil
	default:
		return false, errorAt(n.Line, "%s must be true or false, found %q", name, n.Scalar)
	}
}

// Int reads a scalar integer.
func (n *Node) Int(name string) (int, error) {
	if n == nil {
		return 0, ErrNotFound
	}
	if n.Kind != KindScalar || n.Null {
		return 0, errorAt(n.Line, "%s must be an integer", name)
	}
	value, err := strconv.Atoi(n.Scalar)
	if err != nil {
		return 0, errorAt(n.Line, "%s must be an integer, found %q", name, n.Scalar)
	}
	return value, nil
}

// Float reads a scalar number.
func (n *Node) Float(name string) (float64, error) {
	if n == nil {
		return 0, ErrNotFound
	}
	if n.Kind != KindScalar || n.Null {
		return 0, errorAt(n.Line, "%s must be a number", name)
	}
	value, err := strconv.ParseFloat(n.Scalar, 64)
	if err != nil {
		return 0, errorAt(n.Line, "%s must be a number, found %q", name, n.Scalar)
	}
	return value, nil
}

// Duration reads a Go duration such as 15s or 2m.
func (n *Node) Duration(name string) (time.Duration, error) {
	if n == nil {
		return 0, ErrNotFound
	}
	if n.Kind != KindScalar || n.Null {
		return 0, errorAt(n.Line, "%s must be a duration such as 15s", name)
	}
	value, err := time.ParseDuration(n.Scalar)
	if err != nil {
		return 0, errorAt(n.Line, "%s must be a duration such as 15s, found %q", name, n.Scalar)
	}
	return value, nil
}

// StringSlice reads a sequence of scalar strings.
func (n *Node) StringSlice(name string) ([]string, error) {
	if n == nil || n.Null {
		return nil, ErrNotFound
	}
	if n.Kind != KindSequence {
		return nil, errorAt(n.Line, "%s must be a list", name)
	}
	out := make([]string, 0, len(n.Items))
	for index, item := range n.Items {
		value, err := item.String(name + "[" + strconv.Itoa(index) + "]")
		if err != nil {
			return nil, err
		}
		out = append(out, value)
	}
	return out, nil
}

// Sequence asserts that the node is a sequence.
func (n *Node) Sequence(name string) ([]*Node, error) {
	if n == nil || n.Null {
		return nil, ErrNotFound
	}
	if n.Kind != KindSequence {
		return nil, errorAt(n.Line, "%s must be a list", name)
	}
	return n.Items, nil
}
