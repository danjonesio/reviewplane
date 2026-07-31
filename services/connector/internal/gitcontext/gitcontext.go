// Package gitcontext derives bounded Git context for one workspace directory.
//
// docs/CONNECTOR_PROTOCOL.md section 9 fixes exactly what a connector may
// report about a workspace: the normalised repository remote identity, the
// branch, the HEAD commit, dirty status and a display label. This package
// produces those five values and nothing else.
//
// What it MUST NOT do is as much of the specification as what it does. It never
// reads, hashes or transmits any file's contents, and it never returns a
// changed-file list: section 2 says the connector is not a source-code uploader
// and not a filesystem synchronisation service, and section 9 says source file
// contents are not reported. The version 1 workspace_observation payload has no
// member capable of carrying either, so the rule is a property of the schema as
// well as of this code — but the code is where it would first be broken, and
// "dirty" is deliberately a boolean derived from whether git printed anything
// rather than from what git printed.
//
// Three further rules follow from docs/SECURITY.md and are enforced here rather
// than trusted to a caller:
//
//   - No shell. Every invocation is a fixed argument vector passed to
//     exec.CommandContext, so nothing in a repository's name, path or
//     configuration can become a command.
//   - Bounded output. A hostile or merely enormous repository must not make the
//     connector allocate without limit, so stdout is captured through a writer
//     that stops storing after a few kilobytes while still draining the pipe.
//   - Bounded time. Each invocation carries its own deadline, so a repository on
//     a stalled network filesystem delays one observation rather than the
//     connector.
//
// The environment handed to git is minimal and deterministic for the same
// reason: GIT_TERMINAL_PROMPT=0 and GIT_ASKPASS= mean no invocation can wait for
// a credential, GIT_OPTIONAL_LOCKS=0 and gc.auto=0 mean an observation never
// writes to somebody's checkout, and core.fsmonitor=false means a repository's
// own configuration cannot name a program for git to run on the connector's
// behalf.
package gitcontext

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	platformv1 "github.com/danjonesio/reviewplane/packages/protocol/platformv1"
)

// DefaultTimeout bounds one git invocation. It is generous for a local
// repository and short enough that a checkout on an unresponsive mount does not
// hold up the observation of the others.
const DefaultTimeout = 5 * time.Second

// maxCapturedBytes bounds what one invocation's stdout may hold in memory. The
// values read here are a branch name, a 40-character object name and a remote
// URL, all of which the schema bounds far below this; the margin exists so that
// a diagnosable value is captured rather than a truncated one.
const maxCapturedBytes = 8 << 10

// maxDisplayLabelRunes is the workspace_display_label bound from
// schemas/connector/v1.schema.json, counted in code points as the generated
// validator counts it.
const maxDisplayLabelRunes = 128

// fallbackDisplayLabel names a checkout whose directory name survives
// sanitisation as nothing at all — a path of "/" being the only realistic case.
// A label is required by the schema and must never be a path, so a stable
// literal is reported rather than a fragment of somebody's directory layout.
const fallbackDisplayLabel = "workspace"

// Context is the bounded Git state of one workspace.
//
// There is deliberately no field for a changed-path list, a file count or a
// diff: adding one would be a protocol change requiring an ADR
// (docs/CONNECTOR_PROTOCOL.md section 9, AGENTS.md "Architecture changes").
type Context struct {
	// Branch is the checked-out branch, or the literal "HEAD" when the checkout
	// is detached. A detached HEAD is reported as itself rather than as an
	// invented branch name.
	Branch string
	// HeadCommit is the HEAD object name in lowercase hexadecimal.
	HeadCommit string
	// Dirty reports that the working tree has uncommitted changes. Which files
	// changed is not recorded, here or on the wire.
	Dirty bool
	// RepositoryIdentity is the canonical provider-agnostic identity of the
	// checkout's origin remote, or empty when the checkout has no remote this
	// connector could normalise. An absent value is reported as absent rather
	// than guessed at.
	RepositoryIdentity string
}

// Unavailability is why a directory yielded no Git context. The vocabulary is
// stable so that a caller can branch on it and an operator can be told which of
// the four quite different situations they are in.
type Unavailability string

const (
	// GitNotInstalled reports that no git executable was found. The connector
	// still runs: publishing a development service does not need one.
	GitNotInstalled Unavailability = "git_not_installed"
	// NotACheckout reports a directory that is not inside a Git repository.
	NotACheckout Unavailability = "not_a_git_checkout"
	// NoCommit reports an initialised repository whose HEAD names no commit
	// yet, which has a branch but no head_commit the schema would accept.
	NoCommit Unavailability = "no_commit"
	// Unreadable reports a directory the connector could not enter or a git
	// invocation that failed for a reason it cannot classify.
	Unreadable Unavailability = "unreadable"
	// TimedOut reports an invocation that exceeded its deadline.
	TimedOut Unavailability = "timed_out"
)

// UnavailableError reports that a workspace has no Git context to observe.
//
// It is an ordinary error rather than a zero-valued Context so that a caller
// cannot mistake "nothing to report" for "reported as empty": an observation
// carrying an empty branch would fail the schema, and one carrying a guessed
// branch would be worse.
type UnavailableError struct {
	Reason Unavailability
	// Detail is a local diagnostic. It may name a path, because the connector's
	// log is on the development machine; it never travels on the wire, where
	// only the path hash and the display label do.
	Detail string
}

func (e *UnavailableError) Error() string {
	if e == nil {
		return "<nil>"
	}
	if e.Detail == "" {
		return "gitcontext: " + string(e.Reason)
	}
	return "gitcontext: " + string(e.Reason) + ": " + e.Detail
}

// Unavailable reports whether err is a typed "no context" result and, if so,
// why.
func Unavailable(err error) (Unavailability, bool) {
	var unavailable *UnavailableError
	if errors.As(err, &unavailable) {
		return unavailable.Reason, true
	}
	return "", false
}

// Options configure a Reader.
type Options struct {
	// GitPath is the git executable. Empty resolves "git" on PATH once, at
	// construction, so that a PATH change under a running connector cannot
	// redirect an invocation.
	GitPath string
	// Timeout bounds one invocation. Zero means DefaultTimeout.
	Timeout time.Duration
}

// Reader observes workspaces. It holds no state about any of them: the caller
// owns what was last reported.
type Reader struct {
	git     string
	timeout time.Duration
	// missing records that no git executable was found, so every observation
	// reports GitNotInstalled rather than a resolution error.
	missing bool
	env     []string
}

// New resolves the git executable and prepares the invocation environment.
//
// A missing executable is not an error here. A connector on a machine without
// git still publishes development services, which is the product loop's first
// step; it simply reports no workspace context.
func New(options Options) *Reader {
	reader := &Reader{timeout: options.Timeout}
	if reader.timeout <= 0 {
		reader.timeout = DefaultTimeout
	}
	reader.git = options.GitPath
	if reader.git == "" {
		resolved, err := exec.LookPath("git")
		if err != nil {
			reader.missing = true
		}
		reader.git = resolved
	}
	reader.env = invocationEnvironment()
	return reader
}

// invocationEnvironment is the minimal deterministic environment git is given.
//
// HOME and PATH are inherited deliberately. Git refuses to operate on a
// repository owned by another account unless safe.directory says otherwise, and
// that setting lives in the invoking account's global configuration; a connector
// that discarded HOME would report "not a git checkout" for every workspace an
// operator had explicitly allowed. The system configuration is left in place for
// the same reason. What is removed instead is every route by which an
// observation could prompt, fetch or write.
func invocationEnvironment() []string {
	environment := []string{
		// No invocation may wait for a human. A prompt on a service with no
		// terminal is a hang, not a question.
		"GIT_TERMINAL_PROMPT=0",
		"GIT_ASKPASS=",
		"SSH_ASKPASS=",
		// An observation must not write to somebody's checkout: no index
		// refresh, no automatic garbage collection.
		"GIT_OPTIONAL_LOCKS=0",
		// Output is parsed, so it must not follow a locale.
		"LC_ALL=C",
		"LANG=C",
		// Never page. A pager on a pipe would be an extra process for nothing.
		"GIT_PAGER=cat",
	}
	// GIT_CEILING_DIRECTORIES is forwarded with them: it is git's own control
	// over how far upwards the search for an enclosing repository may go, and an
	// operator who has bounded it has bounded it for a reason.
	for _, name := range []string{"HOME", "PATH", "XDG_CONFIG_HOME", "SYSTEMROOT", "GIT_CEILING_DIRECTORIES"} {
		if value, present := os.LookupEnv(name); present {
			environment = append(environment, name+"="+value)
		}
	}
	return environment
}

// configuration is applied to every invocation, before the subcommand.
//
// core.fsmonitor is the one setting a repository's own configuration can use to
// name a program for git to run, so it is overridden rather than trusted; gc.auto
// keeps an observation from triggering maintenance in somebody's repository.
var configuration = []string{"-c", "core.fsmonitor=false", "-c", "gc.auto=0"}

// Observe reports the Git context of the checkout at absolutePath.
//
// git resolves the enclosing repository, so a workspace path naming a
// subdirectory of a checkout reports that checkout. That is what an operator who
// configured the path means, and it is the only interpretation available: the
// connector does not scan for repositories (section 9, and the workspaces
// package asserts that no directory walk exists anywhere).
func (r *Reader) Observe(ctx context.Context, absolutePath string) (Context, error) {
	if r.missing {
		return Context{}, &UnavailableError{
			Reason: GitNotInstalled,
			Detail: "no git executable was found on PATH, so no workspace context is reported",
		}
	}
	directory := filepath.Clean(absolutePath)
	if info, err := os.Stat(directory); err != nil || !info.IsDir() {
		return Context{}, &UnavailableError{
			Reason: Unreadable,
			Detail: fmt.Sprintf("%s is not a readable directory", directory),
		}
	}

	inside, err := r.capture(ctx, directory, "rev-parse", "--is-inside-work-tree")
	if err != nil {
		if reason, ok := Unavailable(err); ok && reason == Unreadable {
			// git exits non-zero outside a repository, which is the ordinary
			// case rather than a fault.
			return Context{}, &UnavailableError{
				Reason: NotACheckout,
				Detail: fmt.Sprintf("%s is not inside a Git checkout", directory),
			}
		}
		return Context{}, err
	}
	if inside != "true" {
		return Context{}, &UnavailableError{
			Reason: NotACheckout,
			Detail: fmt.Sprintf("%s is inside a bare repository or a Git directory, not a work tree", directory),
		}
	}

	branch, err := r.capture(ctx, directory, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return Context{}, unbornOr(err, directory)
	}
	if branch == "" {
		// git prints the literal "HEAD" for a detached checkout, so an empty
		// branch means something unexpected rather than a detached one, and a
		// substitute would be an invention.
		return Context{}, &UnavailableError{
			Reason: Unreadable,
			Detail: fmt.Sprintf("%s reported no branch for HEAD", directory),
		}
	}
	commit, err := r.capture(ctx, directory, "rev-parse", "HEAD")
	if err != nil {
		return Context{}, unbornOr(err, directory)
	}
	if !isObjectName(commit) {
		// A repository initialised but never committed to has a branch and no
		// commit. There is no head_commit the schema would accept, and an
		// invented one would be a lie about what is checked out.
		return Context{}, &UnavailableError{
			Reason: NoCommit,
			Detail: fmt.Sprintf("%s has no commit on HEAD yet", directory),
		}
	}

	dirty, err := r.dirty(ctx, directory)
	if err != nil {
		return Context{}, err
	}

	observed := Context{Branch: branch, HeadCommit: commit, Dirty: dirty}
	// A checkout with no origin remote is ordinary — a scratch repository, or
	// one whose remote is named something else — so the failure is not
	// propagated. The identity is reported as absent rather than guessed at.
	if remote, err := r.capture(ctx, directory, "remote", "get-url", "origin"); err == nil && remote != "" {
		if canonical, err := platformv1.CanonicaliseCloneURL(remote); err == nil {
			observed.RepositoryIdentity = canonical
		}
	}
	return observed, nil
}

// unbornOr classifies a rev-parse failure. An unborn HEAD is the ordinary state
// of a freshly initialised repository and is reported as such.
func unbornOr(err error, directory string) error {
	if reason, ok := Unavailable(err); ok && reason == Unreadable {
		return &UnavailableError{
			Reason: NoCommit,
			Detail: fmt.Sprintf("%s has no commit on HEAD yet", directory),
		}
	}
	return err
}

// dirty reports whether the working tree carries uncommitted changes.
//
// The output is deliberately thrown away as it arrives. Which paths changed is
// not reportable at this protocol version, and a connector that held the list in
// memory in order to count it would be one refactor away from sending it.
func (r *Reader) dirty(ctx context.Context, directory string) (bool, error) {
	sink := &presenceWriter{}
	if err := r.run(ctx, directory, sink, "status", "--porcelain"); err != nil {
		return false, err
	}
	return sink.wrote, nil
}

// capture runs git and returns its trimmed, bounded stdout.
func (r *Reader) capture(ctx context.Context, directory string, args ...string) (string, error) {
	out := &boundedWriter{limit: maxCapturedBytes}
	if err := r.run(ctx, directory, out, args...); err != nil {
		return "", err
	}
	return strings.TrimRight(out.String(), "\r\n"), nil
}

// run executes one git invocation with a fixed argument vector.
//
// The working directory is set rather than passed as "-C <path>", so an
// operator-configured path never appears in an argument vector at all and
// cannot be read as an option.
func (r *Reader) run(ctx context.Context, directory string, stdout io.Writer, args ...string) error {
	invocation, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()

	// #nosec G204 -- the executable is resolved once at construction and every
	// argument is a compile-time constant; no caller-supplied text reaches the
	// argument vector.
	command := exec.CommandContext(invocation, r.git, append(append([]string(nil), configuration...), args...)...)
	command.Dir = directory
	command.Env = r.env
	command.Stdout = stdout
	stderr := &boundedWriter{limit: 1 << 10}
	command.Stderr = stderr
	// A child that outlives the deadline must not hold Wait open behind it.
	command.WaitDelay = time.Second

	err := command.Run()
	if err == nil {
		return nil
	}
	if invocation.Err() != nil && ctx.Err() == nil {
		return &UnavailableError{
			Reason: TimedOut,
			Detail: fmt.Sprintf("git %s did not finish within %s", strings.Join(args, " "), r.timeout),
		}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return &UnavailableError{
			Reason: Unreadable,
			Detail: fmt.Sprintf("git %s exited %d: %s",
				strings.Join(args, " "), exitErr.ExitCode(), firstLine(stderr.String())),
		}
	}
	return &UnavailableError{
		Reason: Unreadable,
		Detail: fmt.Sprintf("git %s could not be run: %v", strings.Join(args, " "), err),
	}
}

// PathHash is the stable digest of a checkout's absolute path
// (docs/DOMAIN_MODEL.md section 9).
//
// The digest is reported instead of the path so that the control plane can
// recognise the same checkout across observations without storing somebody
// else's directory layout. It is not a secret and is not treated as one: a
// digest of a guessable path is guessable, and it is used for identity rather
// than for concealment.
func PathHash(absolutePath string) string {
	digest := sha256.Sum256([]byte(filepath.Clean(absolutePath)))
	return "sha256:" + hex.EncodeToString(digest[:])
}

// DisplayLabel is the checkout directory's own name, never its full path.
//
// The schema refuses control characters and both path separators in this field,
// so a full path cannot be smuggled through it; sanitising here means the
// connector never builds a frame the control plane would have to refuse.
func DisplayLabel(absolutePath string) string {
	base := filepath.Base(filepath.Clean(absolutePath))
	var label strings.Builder
	for _, r := range base {
		switch {
		case r == '/' || r == '\\':
			// A separator is dropped rather than replaced: the label is a name,
			// and a name that reads like a path fragment invites being read as
			// one.
		case r < 0x20 || r == 0x7f:
		case r == utf8.RuneError:
			// Invalid bytes in a file name would produce a value the schema's
			// UTF-8 assumptions do not hold for.
		default:
			label.WriteRune(r)
		}
	}
	sanitised := strings.TrimSpace(label.String())
	if sanitised == "" || sanitised == "." || sanitised == ".." {
		return fallbackDisplayLabel
	}
	return truncateRunes(sanitised, maxDisplayLabelRunes)
}

func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	count := 0
	for index := range value {
		if count == limit {
			return value[:index]
		}
		count++
	}
	return value
}

// isObjectName reports whether text is the lowercase hexadecimal object name the
// schema's git_commit definition accepts.
func isObjectName(text string) bool {
	if len(text) < 7 || len(text) > 64 {
		return false
	}
	for index := 0; index < len(text); index++ {
		b := text[index]
		if (b < '0' || b > '9') && (b < 'a' || b > 'f') {
			return false
		}
	}
	return true
}

func firstLine(text string) string {
	if index := strings.IndexAny(text, "\r\n"); index >= 0 {
		return text[:index]
	}
	return text
}

// boundedWriter stores at most limit bytes and discards the rest while still
// consuming everything, so that a process writing more than expected is neither
// blocked on a full pipe nor able to grow the connector's heap.
type boundedWriter struct {
	limit int
	data  []byte
}

func (w *boundedWriter) Write(p []byte) (int, error) {
	if remaining := w.limit - len(w.data); remaining > 0 {
		if len(p) < remaining {
			remaining = len(p)
		}
		w.data = append(w.data, p[:remaining]...)
	}
	return len(p), nil
}

func (w *boundedWriter) String() string { return string(w.data) }

// presenceWriter records only that something was written. It is what makes
// "dirty" a boolean derived from whether git printed anything rather than from
// what git printed: no path ever enters the connector's memory.
type presenceWriter struct{ wrote bool }

func (w *presenceWriter) Write(p []byte) (int, error) {
	if len(p) > 0 {
		w.wrote = true
	}
	return len(p), nil
}
