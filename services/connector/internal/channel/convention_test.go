package channel_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
	"testing"
)

// RVP-61: a test clock's instant must never reach a real net.Conn deadline.
//
// The defect it guards against is specific and quiet. A package that injects a
// clock for its own scheduling, and then passes that clock's instant to
// SetReadDeadline or SetWriteDeadline, hands the operating system an absolute
// time that has nothing to do with the machine's. A test clock set in the past
// makes every deadline already expired, so the connection fails instantly; one
// set in the future makes deadlines effectively infinite, so a wedged channel
// hangs rather than timing out. Neither shows up as a clock bug — the first
// looks like a flaky network and the second like a hung test.
//
// The rule is therefore mechanical: every deadline in this package is derived
// from time.Now(). This package deliberately has no injected clock at all; the
// assertion exists so that adding one later cannot silently reach a deadline.
func TestDeadlinesAreDerivedFromRealTime(t *testing.T) {
	deadlineSetters := map[string]bool{
		"SetReadDeadline":  true,
		"SetWriteDeadline": true,
		"SetDeadline":      true,
		// The route manager's own policy deadline is the same hazard.
		"SetPolicyDeadline": true,
	}

	fileSet := token.NewFileSet()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("reading the package directory: %v", err)
	}
	checked := 0
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		source, err := os.ReadFile(name) // #nosec G304 -- this package's own source
		if err != nil {
			t.Fatalf("reading %s: %v", name, err)
		}
		parsed, err := parser.ParseFile(fileSet, name, source, 0)
		if err != nil {
			t.Fatalf("parsing %s: %v", name, err)
		}
		ast.Inspect(parsed, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || !deadlineSetters[selector.Sel.Name] {
				return true
			}
			checked++
			for _, argument := range call.Args {
				text := string(source[argument.Pos()-1 : argument.End()-1])
				if !strings.Contains(text, "time.Now()") {
					t.Errorf("%s:%d passes %q to %s; a deadline must be derived from time.Now(), "+
						"never from an injected clock (RVP-61)",
						name, fileSet.Position(argument.Pos()).Line, text, selector.Sel.Name)
				}
			}
			return true
		})
	}
	if checked == 0 {
		t.Fatal("no deadline was inspected; this test no longer guards anything")
	}
}

// The connector must not hand-maintain a type packages/protocol generates
// (ADR-0013). The binary-wide guard in cmd/reviewplane-connector already says
// so; this one names the two types this change introduced, so that a future
// workspace struct declared here fails in the package that would declare it.
func TestChannelDeclaresNoWorkspaceWireTypes(t *testing.T) {
	generated := map[string]bool{
		"WorkspaceObservation": true,
		"WorkspaceHead":        true,
	}
	fileSet := token.NewFileSet()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("reading the package directory: %v", err)
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		parsed, err := parser.ParseFile(fileSet, name, nil, 0)
		if err != nil {
			t.Fatalf("parsing %s: %v", name, err)
		}
		ast.Inspect(parsed, func(node ast.Node) bool {
			spec, ok := node.(*ast.TypeSpec)
			if !ok {
				return true
			}
			if _, isStruct := spec.Type.(*ast.StructType); isStruct && generated[spec.Name.Name] {
				t.Errorf("%s declares %s, which packages/protocol already generates", name, spec.Name.Name)
			}
			return true
		})
	}
}
