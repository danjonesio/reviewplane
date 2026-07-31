package gitcontext_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/danjonesio/reviewplane/services/connector/internal/gitcontext"
)

// These tests build real repositories rather than stubbing git. What is being
// asserted is a claim about what git prints and what this package does with it,
// and a stub would assert only that the parser agrees with its own author.

// repository is a temporary checkout a test can shape.
type repository struct {
	t    *testing.T
	path string
}

func requireGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed; the connector reports no workspace context on such a machine")
	}
}

func newRepository(t *testing.T) *repository {
	t.Helper()
	requireGit(t)
	repo := &repository{t: t, path: t.TempDir()}
	repo.git("init", "--initial-branch=main")
	// Identity and signing are set locally so that the test does not depend on
	// the machine's global configuration, and cannot be derailed by it.
	repo.git("config", "user.email", "connector@example.internal")
	repo.git("config", "user.name", "Connector Test")
	repo.git("config", "commit.gpgsign", "false")
	return repo
}

func (r *repository) git(args ...string) string {
	r.t.Helper()
	command := exec.Command("git", args...)
	command.Dir = r.path
	command.Env = append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"GIT_AUTHOR_DATE=2026-07-30T10:00:00Z",
		"GIT_COMMITTER_DATE=2026-07-30T10:00:00Z",
	)
	output, err := command.CombinedOutput()
	if err != nil {
		r.t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, output)
	}
	return strings.TrimSpace(string(output))
}

func (r *repository) write(name, contents string) {
	r.t.Helper()
	if err := os.WriteFile(filepath.Join(r.path, name), []byte(contents), 0o600); err != nil {
		r.t.Fatalf("writing %s: %v", name, err)
	}
}

func (r *repository) commit(message string) string {
	r.t.Helper()
	r.git("add", "-A")
	r.git("commit", "-m", message)
	return r.git("rev-parse", "HEAD")
}

func observe(t *testing.T, path string) gitcontext.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	observed, err := gitcontext.New(gitcontext.Options{}).Observe(ctx, path)
	if err != nil {
		t.Fatalf("Observe(%s): %v", path, err)
	}
	return observed
}

// docs/CONNECTOR_PROTOCOL.md section 9: branch, HEAD commit, dirty status and
// the normalised remote identity, and nothing else.
func TestObserveReportsEveryFieldOfACleanCheckout(t *testing.T) {
	repo := newRepository(t)
	repo.write("README.md", "# fixture\n")
	head := repo.commit("first")
	repo.git("remote", "add", "origin", "git@github.com:example/refresh-surplus.git")

	observed := observe(t, repo.path)
	if observed.Branch != "main" {
		t.Errorf("branch = %q, want main", observed.Branch)
	}
	if observed.HeadCommit != head {
		t.Errorf("head_commit = %q, want %q", observed.HeadCommit, head)
	}
	if observed.Dirty {
		t.Error("a committed checkout with no further edits is not dirty")
	}
	if observed.RepositoryIdentity != "github.com/example/refresh-surplus" {
		t.Errorf("repository_identity = %q; the scp-like remote must reduce to the canonical form",
			observed.RepositoryIdentity)
	}
}

// The remote is normalised through the shared normaliser in packages/protocol,
// so the connector and the control plane cannot disagree about what one
// repository is.
func TestObserveNormalisesEverySpellingOfTheRemote(t *testing.T) {
	for _, remote := range []string{
		"git@github.com:example/refresh-surplus.git",
		"https://github.com/example/refresh-surplus.git",
		"ssh://git@github.com:22/example/refresh-surplus.git",
		"https://GitHub.com/example/refresh-surplus/",
	} {
		t.Run(remote, func(t *testing.T) {
			repo := newRepository(t)
			repo.write("file.txt", "contents\n")
			repo.commit("first")
			repo.git("remote", "add", "origin", remote)
			if got := observe(t, repo.path).RepositoryIdentity; got != "github.com/example/refresh-surplus" {
				t.Fatalf("repository_identity = %q, want github.com/example/refresh-surplus", got)
			}
		})
	}
}

// docs/SECURITY.md section 18: a token pasted into a remote must not travel to
// the control plane, and the canonical form is what travels.
func TestObserveDropsACredentialInTheRemote(t *testing.T) {
	repo := newRepository(t)
	repo.write("file.txt", "contents\n")
	repo.commit("first")
	repo.git("remote", "add", "origin", "https://ghp_SUPERSECRETTOKEN1234@github.com/example/api.git")

	observed := observe(t, repo.path)
	if observed.RepositoryIdentity != "github.com/example/api" {
		t.Fatalf("repository_identity = %q", observed.RepositoryIdentity)
	}
	if strings.Contains(observed.RepositoryIdentity, "SUPERSECRETTOKEN") {
		t.Fatal("the token in the remote reached the reported identity")
	}
}

func TestObserveReportsADirtyWorkingTree(t *testing.T) {
	repo := newRepository(t)
	repo.write("file.txt", "contents\n")
	repo.commit("first")
	if observe(t, repo.path).Dirty {
		t.Fatal("the checkout is clean immediately after a commit")
	}

	repo.write("file.txt", "edited\n")
	if !observe(t, repo.path).Dirty {
		t.Fatal("an edited tracked file makes the working tree dirty")
	}

	// An untracked file is a change git reports, so it counts too. Which file it
	// is must not be recoverable from anything this package returns.
	repo.git("checkout", "--", "file.txt")
	repo.write("secret-plan.txt", "not for the wire\n")
	observed := observe(t, repo.path)
	if !observed.Dirty {
		t.Fatal("an untracked file makes the working tree dirty")
	}
	if strings.Contains(observed.Branch+observed.HeadCommit+observed.RepositoryIdentity, "secret-plan") {
		t.Fatal("a changed path reached an observed field")
	}
}

// A detached HEAD reports the literal "HEAD" rather than an invented branch
// name, which is what the schema's git_branch definition says.
func TestObserveReportsDetachedHeadAsHead(t *testing.T) {
	repo := newRepository(t)
	repo.write("file.txt", "one\n")
	first := repo.commit("first")
	repo.write("file.txt", "two\n")
	repo.commit("second")
	repo.git("checkout", "--detach", first)

	observed := observe(t, repo.path)
	if observed.Branch != "HEAD" {
		t.Fatalf("branch = %q, want the literal HEAD", observed.Branch)
	}
	if observed.HeadCommit != first {
		t.Fatalf("head_commit = %q, want %q", observed.HeadCommit, first)
	}
}

// A remote is optional. An absent one is reported as absent rather than guessed
// at, because a wrong identity associates a project with code it does not hold.
func TestObserveReportsNoIdentityWithoutARemote(t *testing.T) {
	repo := newRepository(t)
	repo.write("file.txt", "contents\n")
	repo.commit("first")
	if got := observe(t, repo.path).RepositoryIdentity; got != "" {
		t.Fatalf("repository_identity = %q; a checkout with no remote has none", got)
	}
}

// A remote nothing can normalise is the same case: absent, not invented.
func TestObserveReportsNoIdentityForAnUnnormalisableRemote(t *testing.T) {
	repo := newRepository(t)
	repo.write("file.txt", "contents\n")
	repo.commit("first")
	repo.git("remote", "add", "origin", "/srv/git/mirror.git")
	if got := observe(t, repo.path).RepositoryIdentity; got != "" {
		t.Fatalf("repository_identity = %q; a local path is not a provider-agnostic identity", got)
	}
}

// A branch name with a slash is ordinary and must survive intact.
func TestObserveReportsASlashedBranchName(t *testing.T) {
	repo := newRepository(t)
	repo.write("file.txt", "contents\n")
	repo.commit("first")
	repo.git("checkout", "-b", "feat/checkout-tidy")
	if got := observe(t, repo.path).Branch; got != "feat/checkout-tidy" {
		t.Fatalf("branch = %q", got)
	}
}

// A directory that is not a checkout yields a typed result, never a panic and
// never a guess.
func TestObserveRefusesADirectoryThatIsNotACheckout(t *testing.T) {
	requireGit(t)
	directory := t.TempDir()
	// git walks upwards, so a temporary directory inside a repository would
	// report that repository. A ceiling makes the test about this directory.
	t.Setenv("GIT_CEILING_DIRECTORIES", filepath.Dir(directory))

	_, err := gitcontext.New(gitcontext.Options{}).Observe(context.Background(), directory)
	if err == nil {
		t.Fatal("a directory that is not a checkout must not yield a context")
	}
	reason, typed := gitcontext.Unavailable(err)
	if !typed {
		t.Fatalf("error %v is not a typed no-context result", err)
	}
	if reason != gitcontext.NotACheckout {
		t.Fatalf("reason = %s, want %s", reason, gitcontext.NotACheckout)
	}
}

func TestObserveRefusesAMissingDirectory(t *testing.T) {
	requireGit(t)
	absent := filepath.Join(t.TempDir(), "never-created")
	_, err := gitcontext.New(gitcontext.Options{}).Observe(context.Background(), absent)
	reason, typed := gitcontext.Unavailable(err)
	if !typed || reason != gitcontext.Unreadable {
		t.Fatalf("Observe on a missing directory returned %v (%s)", err, reason)
	}
}

// An initialised repository with no commit has a branch and no HEAD, so there is
// no observation the schema would accept. Reporting one anyway would be a claim
// about a commit that does not exist.
func TestObserveRefusesARepositoryWithNoCommit(t *testing.T) {
	requireGit(t)
	directory := t.TempDir()
	command := exec.Command("git", "init", "--initial-branch=main")
	command.Dir = directory
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, output)
	}
	_, err := gitcontext.New(gitcontext.Options{}).Observe(context.Background(), directory)
	reason, typed := gitcontext.Unavailable(err)
	if !typed || reason != gitcontext.NoCommit {
		t.Fatalf("Observe on an unborn HEAD returned %v (%s), want %s", err, reason, gitcontext.NoCommit)
	}
}

// A machine without git still runs a connector: publishing a development service
// does not need one. It simply reports no workspace context.
func TestObserveReportsAMissingGitExecutable(t *testing.T) {
	reader := gitcontext.New(gitcontext.Options{GitPath: filepath.Join(t.TempDir(), "no-such-git")})
	_, err := reader.Observe(context.Background(), t.TempDir())
	if err == nil {
		t.Fatal("a missing git executable must not yield a context")
	}
	if _, typed := gitcontext.Unavailable(err); !typed {
		t.Fatalf("error %v is not a typed no-context result", err)
	}
}

// The bound is per invocation, so a git that never returns delays one
// observation rather than the connector.
func TestObserveBoundsAGitThatNeverReturns(t *testing.T) {
	script := filepath.Join(t.TempDir(), "slow-git")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nexec sleep 30\n"), 0o700); err != nil { // #nosec G306 -- test fixture must be executable
		t.Fatalf("writing the stub: %v", err)
	}
	reader := gitcontext.New(gitcontext.Options{GitPath: script, Timeout: 200 * time.Millisecond})

	started := time.Now()
	_, err := reader.Observe(context.Background(), t.TempDir())
	elapsed := time.Since(started)
	reason, typed := gitcontext.Unavailable(err)
	if !typed || reason != gitcontext.TimedOut {
		t.Fatalf("Observe returned %v (%s), want %s", err, reason, gitcontext.TimedOut)
	}
	if elapsed > 10*time.Second {
		t.Fatalf("the invocation took %s; the deadline did not bound it", elapsed)
	}
}

// A hostile repository must not be able to make the connector allocate without
// limit. The stub prints far more than any real invocation would.
func TestObserveBoundsAllocationOnAFloodOfOutput(t *testing.T) {
	script := filepath.Join(t.TempDir(), "flooding-git")
	source := "#!/bin/sh\nexec yes reviewplane | head -c 5000000\n"
	if err := os.WriteFile(script, []byte(source), 0o700); err != nil { // #nosec G306 -- test fixture must be executable
		t.Fatalf("writing the stub: %v", err)
	}
	reader := gitcontext.New(gitcontext.Options{GitPath: script, Timeout: 20 * time.Second})

	// The first invocation is rev-parse --is-inside-work-tree, whose flood of
	// output is not "true", so the observation is refused rather than believed.
	_, err := reader.Observe(context.Background(), t.TempDir())
	if err == nil {
		t.Fatal("five megabytes of output must not be accepted as a Git context")
	}
	if _, typed := gitcontext.Unavailable(err); !typed {
		t.Fatalf("error %v is not a typed no-context result", err)
	}
}

// docs/DOMAIN_MODEL.md section 9: the digest identifies the same checkout across
// observations without disclosing the path.
func TestPathHashIsStableAndSchemaShaped(t *testing.T) {
	const path = "/home/dan/projects/refresh-surplus"
	hash := gitcontext.PathHash(path)
	if hash != gitcontext.PathHash(path) {
		t.Fatal("the digest of one path must not vary between calls")
	}
	if hash != gitcontext.PathHash(path+"/") {
		t.Fatal("a trailing separator names the same checkout and must produce the same digest")
	}
	if hash == gitcontext.PathHash("/home/dan/projects/other") {
		t.Fatal("two checkouts must not share a digest")
	}
	if len(hash) != 71 || !strings.HasPrefix(hash, "sha256:") {
		t.Fatalf("path_hash = %q, which is not the schema's sha256:<64 hex> form", hash)
	}
	for _, r := range hash[len("sha256:"):] {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			t.Fatalf("path_hash carries %q, which is outside lowercase hexadecimal", r)
		}
	}
	if strings.Contains(hash, "refresh-surplus") || strings.Contains(hash, "dan") {
		t.Fatal("the digest disclosed part of the path")
	}
}

// The schema refuses control characters and both path separators in a display
// label, so a full path cannot be smuggled through it.
func TestDisplayLabelIsANameAndNeverAPath(t *testing.T) {
	cases := []struct {
		name string
		path string
		want string
	}{
		{"ordinary checkout", "/home/dan/projects/refresh-surplus", "refresh-surplus"},
		{"trailing separator", "/home/dan/projects/refresh-surplus/", "refresh-surplus"},
		{"unclean path", "/home/dan/projects/../projects/api", "api"},
		{"root", "/", "workspace"},
		{"backslash in the name", "/srv/we\\ird", "weird"},
		{"control character in the name", "/srv/od\x01d", "odd"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			label := gitcontext.DisplayLabel(test.path)
			if label != test.want {
				t.Fatalf("DisplayLabel(%q) = %q, want %q", test.path, label, test.want)
			}
			if strings.ContainsAny(label, "/\\") {
				t.Fatalf("label %q carries a path separator", label)
			}
		})
	}

	long := gitcontext.DisplayLabel("/srv/" + strings.Repeat("n", 400))
	if count := len([]rune(long)); count != 128 {
		t.Fatalf("a long directory name produced a %d-character label; the schema bounds it at 128", count)
	}
}

// The package must never read a file's contents or return a changed-file list.
// The rule is asserted mechanically rather than left to review, because it is
// the one docs/CONNECTOR_PROTOCOL.md section 2 exists to protect.
func TestPackageReadsNoFileContentsAndWalksNoDirectory(t *testing.T) {
	forbidden := []string{
		"os.ReadFile",
		"os.Open(",
		"os.OpenFile",
		"os.ReadDir",
		"filepath.Walk",
		"filepath.WalkDir",
		"filepath.Glob",
		"fs.WalkDir",
		"io.ReadAll",
		"Readdir",
		"exec.Command(",
		"sh -c",
		"/bin/sh",
	}
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("reading the package directory: %v", err)
	}
	inspected := 0
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		contents, err := os.ReadFile(name) // #nosec G304 -- this package's own source
		if err != nil {
			t.Fatalf("reading %s: %v", name, err)
		}
		inspected++
		for _, needle := range forbidden {
			if strings.Contains(string(contents), needle) {
				t.Errorf("%s references %s; this package reports Git metadata only "+
					"(docs/CONNECTOR_PROTOCOL.md sections 2 and 9)", name, needle)
			}
		}
	}
	if inspected == 0 {
		t.Fatal("no package source was inspected")
	}
}
