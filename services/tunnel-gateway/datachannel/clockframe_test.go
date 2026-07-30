package datachannel

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A stream's deadline is policy, read against an injected clock. A socket's
// deadline is enforced by the kernel against the real clock. The two are the
// same Go type and the same method name, which is how one was passed to the
// other and how seven upgrade tests came to fail on every day after the harness
// clock's origin (RVP-61). These tests hold the boundary.

func TestSocketDeadlineCarriesTheRemainingLifetimeRatherThanTheInstant(t *testing.T) {
	// The policy clock sits a decade behind the real one, which is the whole
	// difficulty: the instant it names is long past, and the lifetime it grants
	// is thirty minutes.
	policyNow := time.Date(2016, 3, 1, 9, 0, 0, 0, time.UTC)
	clock := func() time.Time { return policyNow }

	before := time.Now()
	got := SocketDeadline(policyNow.Add(30*time.Minute), clock)
	after := time.Now()

	if !got.After(before.Add(29 * time.Minute)) {
		t.Fatalf("the socket deadline is %v, which does not grant the remaining thirty minutes", got)
	}
	if got.After(after.Add(31 * time.Minute)) {
		t.Fatalf("the socket deadline is %v, which grants more than the policy clock allowed", got)
	}
}

func TestSocketDeadlineKeepsAnExpiredPolicyDeadlineExpired(t *testing.T) {
	// A route that has already expired must produce a socket that is unusable,
	// not one that is renewed by being translated. This is the direction that
	// matters for security: the deadline exists so that an upgraded connection
	// cannot outlive the authorisation that opened it.
	policyNow := time.Date(2031, 6, 1, 9, 0, 0, 0, time.UTC)
	clock := func() time.Time { return policyNow }

	got := SocketDeadline(policyNow.Add(-time.Second), clock)

	if !got.Before(time.Now()) {
		t.Fatalf("an expired policy deadline translated to %v, which is still in the future", got)
	}
}

func TestSocketDeadlineIsTheIdentityWhenThePolicyClockIsTheRealClock(t *testing.T) {
	// Every deployment injects time.Now, so the translation must be a no-op
	// there. A conversion that drifted in production would be a worse defect
	// than the one it replaced.
	deadline := time.Now().Add(90 * time.Minute)

	got := SocketDeadline(deadline, time.Now)

	if drift := got.Sub(deadline); drift > time.Second || drift < -time.Second {
		t.Fatalf("translating under the real clock moved the deadline by %v", drift)
	}
}

// TestNoPolicyInstantReachesASocketDeadline is the standing guard.
//
// RVP-61's acceptance criteria ask that no code in this repository apply an
// injected clock's absolute instant to a net.Conn deadline. That is decidable
// here because the policy method is no longer called SetDeadline: after the
// rename to SetPolicyDeadline, every Set*Deadline call in this module is a
// socket deadline, so every one of them must name the real clock — through
// time.Now, through SocketDeadline, or by clearing the deadline with a zero
// time.Time.
//
// The check is syntactic on purpose. A type-checked version would need a
// dependency this module does not have (docs/SECURITY.md section 19 keeps it on
// the standard library), and the syntactic form fails closed: an argument the
// walker cannot recognise is a failure, not a pass.
func TestNoPolicyInstantReachesASocketDeadline(t *testing.T) {
	moduleRoot, err := filepath.Abs("..")
	if err != nil {
		t.Fatalf("resolve the module root: %v", err)
	}

	deadlineSetters := map[string]bool{
		"SetDeadline":      true,
		"SetReadDeadline":  true,
		"SetWriteDeadline": true,
	}
	// The expressions that are evidence of the real clock. SocketDeadline is
	// the sanctioned translation; time.Now is the real clock directly; a zero
	// time.Time clears a deadline and names no clock at all.
	realClock := []string{"time.Now(", "SocketDeadline(", "time.Time{}"}

	fset := token.NewFileSet()
	checked := 0
	walkErr := filepath.WalkDir(moduleRoot, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if entry.Name() == "testdata" || entry.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}
		file, parseErr := parser.ParseFile(fset, path, nil, 0)
		if parseErr != nil {
			return parseErr
		}
		source, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}

		ast.Inspect(file, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || !deadlineSetters[selector.Sel.Name] || len(call.Args) != 1 {
				return true
			}
			// A method declaration that forwards its own argument is a
			// pass-through, not a decision about which clock to use; the
			// caller is what this test is about, and the caller is checked
			// wherever it lives.
			if identifier, isIdentifier := call.Args[0].(*ast.Ident); isIdentifier && identifier.Obj != nil {
				if _, isParameter := identifier.Obj.Decl.(*ast.Field); isParameter {
					return true
				}
			}

			checked++
			argument := string(source[fset.Position(call.Args[0].Pos()).Offset:fset.Position(call.Args[0].End()).Offset])
			for _, evidence := range realClock {
				if strings.Contains(argument, evidence) {
					return true
				}
			}
			relative, _ := filepath.Rel(moduleRoot, path)
			t.Errorf(
				"%s:%d: %s(%s) puts an instant on a socket without naming the real clock.\n"+
					"A socket deadline is compared against the real clock. If this instant comes from an\n"+
					"injected clock, translate it with datachannel.SocketDeadline; if it is already real,\n"+
					"derive it from time.Now so that this is visible at the call site.",
				relative, fset.Position(call.Pos()).Line, selector.Sel.Name, argument)
			return true
		})
		return nil
	})
	if walkErr != nil {
		t.Fatalf("walk the module: %v", walkErr)
	}
	if checked == 0 {
		t.Fatal("the guard examined no deadline calls at all, so it is proving nothing")
	}
}
