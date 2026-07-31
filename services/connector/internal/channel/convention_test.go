package channel_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
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
// The rule is therefore mechanical: every deadline is derived from time.Now().
//
// It covers the sibling packages as well as this one, and that scope is the
// point. This package has no injected clock; `internal/workspaces` does — it
// schedules re-observation on an interval and its tests drive that interval
// directly — so it is the package where the hazard is now live. A guard that
// only watched the package without a clock would have watched the wrong one.
func TestDeadlinesAreDerivedFromRealTime(t *testing.T) {
	deadlineSetters := map[string]bool{
		"SetReadDeadline":  true,
		"SetWriteDeadline": true,
		"SetDeadline":      true,
		// The route manager's own policy deadline is the same hazard.
		"SetPolicyDeadline": true,
	}

	// Every package that *computes* a deadline, which is where the hazard lives.
	//
	// `internal/ws` is deliberately absent. It is the transport wrapper, and its
	// whole job is to forward a deadline its caller worked out — `SetReadDeadline`
	// there is a one-line pass-through of its own parameter, and the handshake
	// forwards `ctx.Deadline()` and clears with the zero time. Holding it to this
	// rule would flag the forwarding rather than the decision, and the decisions
	// are all in the packages below.
	packages := []string{".", "../workspaces", "../gitcontext", "../routes", "../transport"}

	// Two forms that are real time without saying `time.Now()`. A context's
	// deadline is wall-clock — it came from `context.WithTimeout`, which used the
	// real clock — and the zero time clears a deadline rather than setting one.
	realTimeForms := []string{"time.Now()", "ctx.Deadline()", "time.Time{}"}

	checked := 0
	for _, directory := range packages {
		entries, err := os.ReadDir(directory)
		if err != nil {
			t.Fatalf("reading %s: %v", directory, err)
		}
		for _, entry := range entries {
			name := entry.Name()
			if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
				continue
			}
			path := filepath.Join(directory, name)
			source, err := os.ReadFile(path) // #nosec G304 -- this module's own source
			if err != nil {
				t.Fatalf("reading %s: %v", path, err)
			}
			// One FileSet per file. A position is an offset into the *set*, not
			// into the file, so a shared set makes the second file's positions
			// run past the end of its own source — which this test then slices
			// with, and panicked on as soon as it read more than one package.
			fileSet := token.NewFileSet()
			parsed, err := parser.ParseFile(fileSet, path, source, 0)
			if err != nil {
				t.Fatalf("parsing %s: %v", path, err)
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
					real := false
					for _, form := range realTimeForms {
						if strings.Contains(text, form) {
							real = true
							break
						}
					}
					if !real {
						t.Errorf("%s:%d passes %q to %s; a deadline must be derived from real time "+
							"(%s), never from an injected clock (RVP-61)",
							path, fileSet.Position(argument.Pos()).Line, text, selector.Sel.Name,
							strings.Join(realTimeForms, ", "))
					}
				}
				return true
			})
		}
	}
	if checked == 0 {
		t.Fatal("no deadline was inspected; this test no longer guards anything")
	}
	t.Logf("inspected %d deadline call(s) across %d packages", checked, len(packages))
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
