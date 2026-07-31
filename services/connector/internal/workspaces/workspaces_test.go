package workspaces_test

import (
	"bytes"
	"context"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	connectorv1 "github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/connector/internal/config"
	"github.com/danjonesio/reviewplane/services/connector/internal/gitcontext"
	"github.com/danjonesio/reviewplane/services/connector/internal/logging"
	"github.com/danjonesio/reviewplane/services/connector/internal/workspaces"
)

// fakeSource stands in for a repository on disk. The lifecycle being tested is
// when an observation is sent and when it is suppressed, which a real checkout
// would make slow to arrange and no more convincing.
type fakeSource struct {
	mu sync.Mutex
	// contexts maps a workspace path to what git would report for it. A path
	// with no entry is not a checkout.
	contexts map[string]gitcontext.Context
	// observed counts calls, so a test can prove nothing was looked at.
	observed map[string]int
}

func newFakeSource() *fakeSource {
	return &fakeSource{contexts: map[string]gitcontext.Context{}, observed: map[string]int{}}
}

func (f *fakeSource) Observe(_ context.Context, path string) (gitcontext.Context, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.observed[path]++
	state, present := f.contexts[path]
	if !present {
		return gitcontext.Context{}, &gitcontext.UnavailableError{Reason: gitcontext.NotACheckout}
	}
	return state, nil
}

func (f *fakeSource) set(path string, state gitcontext.Context) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.contexts[path] = state
}

func (f *fakeSource) remove(path string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.contexts, path)
}

func (f *fakeSource) calls(path string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.observed[path]
}

const (
	firstPath  = "/home/dan/projects/refresh-surplus"
	secondPath = "/home/dan/projects/api"
)

func newSet(t *testing.T, source *fakeSource, entries ...config.Workspace) (*workspaces.Set, *bytes.Buffer) {
	t.Helper()
	logs := &bytes.Buffer{}
	instant := time.Date(2026, 7, 30, 10, 59, 58, 0, time.UTC)
	return workspaces.New(workspaces.Options{
		Workspaces: entries,
		Source:     source,
		Logger:     logging.New(logs, "debug"),
		Now:        func() time.Time { return instant },
	}), logs
}

// docs/CONNECTOR_PROTOCOL.md section 9: an observation carries the repository
// identity, branch, head commit, dirty state, display label and path hash.
func TestReportCarriesEveryObservedField(t *testing.T) {
	source := newFakeSource()
	source.set(firstPath, gitcontext.Context{
		Branch:             "feat/checkout-tidy",
		HeadCommit:         "4f3a9c1d2e8b7a6053f4e3d2c1b0a9f8e7d6c5b4",
		Dirty:              true,
		RepositoryIdentity: "github.com/example/refresh-surplus",
	})
	set, _ := newSet(t, source,
		config.Workspace{ID: "wsp_first", Path: firstPath, Project: "prj_first"})

	set.Refresh(context.Background())
	report := set.Report()
	if len(report) != 1 {
		t.Fatalf("the report carries %d observations, want 1", len(report))
	}
	observation := report[0]
	if observation.WorkspaceID != "wsp_first" || observation.ProjectID != "prj_first" {
		t.Fatalf("observation names %s/%s", observation.WorkspaceID, observation.ProjectID)
	}
	if observation.Branch != "feat/checkout-tidy" || !observation.Dirty {
		t.Fatalf("observation = %+v", observation)
	}
	if observation.PathHash != gitcontext.PathHash(firstPath) {
		t.Fatalf("path_hash = %q", observation.PathHash)
	}
	if observation.DisplayLabel != "refresh-surplus" {
		t.Fatalf("display_label = %q, want the directory's own name", observation.DisplayLabel)
	}
	if observation.RepositoryIdentity == nil || *observation.RepositoryIdentity != "github.com/example/refresh-surplus" {
		t.Fatalf("repository_identity = %v", observation.RepositoryIdentity)
	}
	if observation.ObservedAt != "2026-07-30T10:59:58Z" {
		t.Fatalf("observed_at = %q", observation.ObservedAt)
	}

	// The full path must not appear anywhere in what is sent. The path hash and
	// the display label exist so that it does not have to.
	frame, err := connectorv1.EncodeControlFrame(connectorv1.Frame{
		Envelope: connectorv1.Envelope{
			ProtocolVersion: connectorv1.ProtocolVersion,
			MessageID:       "msg_workspaces",
			Type:            connectorv1.MessageTypeWorkspaceObserved,
			SentAt:          "2026-07-30T11:00:00Z",
			ConnectorID:     stringPointer("con_workspaces"),
		},
		Payload: observation,
	})
	if err != nil {
		t.Fatalf("the observation does not satisfy the schema: %v", err)
	}
	if strings.Contains(string(frame), firstPath) || strings.Contains(string(frame), "/home/dan") {
		t.Fatalf("the observation frame carries a filesystem path: %s", frame)
	}
}

// A checkout with no remote reports an absent identity rather than a guessed
// one, and the schema omits the member entirely.
func TestAnAbsentRemoteIsOmittedRatherThanEmpty(t *testing.T) {
	source := newFakeSource()
	source.set(firstPath, gitcontext.Context{Branch: "HEAD", HeadCommit: "0123456"})
	set, _ := newSet(t, source, config.Workspace{ID: "wsp_first", Path: firstPath, Project: "prj_first"})

	set.Refresh(context.Background())
	report := set.Report()
	if len(report) != 1 || report[0].RepositoryIdentity != nil {
		t.Fatalf("repository_identity = %v; an absent remote is absent", report[0].RepositoryIdentity)
	}
}

// Only a change in branch, head commit or dirty state is worth a frame. A
// connector on an untouched machine says nothing.
func TestChangedReportsOnlyWhatMoved(t *testing.T) {
	source := newFakeSource()
	source.set(firstPath, gitcontext.Context{Branch: "main", HeadCommit: "aaaaaaa"})
	source.set(secondPath, gitcontext.Context{Branch: "main", HeadCommit: "bbbbbbb"})
	set, _ := newSet(t, source,
		config.Workspace{ID: "wsp_first", Path: firstPath, Project: "prj_first"},
		config.Workspace{ID: "wsp_second", Path: secondPath, Project: "prj_first"})

	set.Refresh(context.Background())
	if len(set.Report()) != 2 {
		t.Fatal("the initial report carries every observed workspace")
	}
	if changed := set.Changed(context.Background()); len(changed) != 0 {
		t.Fatalf("nothing moved, and %d observations were sent: %+v", len(changed), changed)
	}

	source.set(secondPath, gitcontext.Context{Branch: "feat/tidy", HeadCommit: "bbbbbbb"})
	changed := set.Changed(context.Background())
	if len(changed) != 1 || changed[0].WorkspaceID != "wsp_second" {
		t.Fatalf("changed = %+v, want only wsp_second", changed)
	}
	if again := set.Changed(context.Background()); len(again) != 0 {
		t.Fatalf("the same change was sent twice: %+v", again)
	}

	// Dirtiness alone is a change: it is what tells a supervising human that the
	// evidence they are looking at may not match the commit.
	source.set(secondPath, gitcontext.Context{Branch: "feat/tidy", HeadCommit: "bbbbbbb", Dirty: true})
	if changed := set.Changed(context.Background()); len(changed) != 1 {
		t.Fatalf("a newly dirty working tree must be reported: %+v", changed)
	}
}

// A control plane that restarted has no memory of the last report, so a
// reconnect sends the whole set again.
func TestForgetMakesTheNextReportAFullOne(t *testing.T) {
	source := newFakeSource()
	source.set(firstPath, gitcontext.Context{Branch: "main", HeadCommit: "aaaaaaa"})
	set, _ := newSet(t, source, config.Workspace{ID: "wsp_first", Path: firstPath, Project: "prj_first"})

	set.Refresh(context.Background())
	set.Report()
	if changed := set.Changed(context.Background()); len(changed) != 0 {
		t.Fatal("an unchanged workspace is not resent within one channel")
	}

	set.Forget()
	if changed := set.Changed(context.Background()); len(changed) != 1 {
		t.Fatalf("after a lost channel the workspace must be reported again: %+v", changed)
	}
}

// A workspace that stops being a checkout is forgotten rather than reported
// stale: the connector says nothing rather than asserting a branch it can no
// longer see.
func TestAWorkspaceThatDisappearsIsNotReportedStale(t *testing.T) {
	source := newFakeSource()
	source.set(firstPath, gitcontext.Context{Branch: "main", HeadCommit: "aaaaaaa"})
	set, logs := newSet(t, source, config.Workspace{ID: "wsp_first", Path: firstPath, Project: "prj_first"})

	set.Refresh(context.Background())
	if len(set.HeadState()) != 1 {
		t.Fatal("an observed workspace is claimed")
	}

	source.remove(firstPath)
	set.Refresh(context.Background())
	if state := set.HeadState(); len(state) != 0 {
		t.Fatalf("head state = %+v; a workspace that is no longer a checkout is not claimed", state)
	}
	if len(set.Report()) != 0 {
		t.Fatal("a workspace that is no longer a checkout is not reported")
	}
	if !strings.Contains(logs.String(), string(gitcontext.NotACheckout)) {
		t.Fatalf("the reason was not logged: %s", logs.String())
	}
}

// docs/CONNECTOR_PROTOCOL.md section 11: a publication names both a workspace
// and a project, so an entry missing either is skipped rather than guessed at,
// and the operator is told which one.
func TestWorkspacesWithoutAnIdentifierOrProjectAreSkipped(t *testing.T) {
	source := newFakeSource()
	source.set(firstPath, gitcontext.Context{Branch: "main", HeadCommit: "aaaaaaa"})
	source.set(secondPath, gitcontext.Context{Branch: "main", HeadCommit: "bbbbbbb"})
	set, logs := newSet(t, source,
		config.Workspace{Path: firstPath, Project: "prj_first"},
		config.Workspace{ID: "wsp_second", Path: secondPath},
	)

	if set.Len() != 0 {
		t.Fatalf("%d workspaces were kept; both entries are incomplete", set.Len())
	}
	set.Refresh(context.Background())
	if len(set.Report()) != 0 {
		t.Fatal("a skipped workspace must not be reported")
	}
	if source.calls(firstPath)+source.calls(secondPath) != 0 {
		t.Fatal("a skipped workspace must not even be looked at")
	}
	output := logs.String()
	if !strings.Contains(output, "no identifier") || !strings.Contains(output, "no project") {
		t.Fatalf("both skips must name their cause: %s", output)
	}
}

// The reconnect claim is bounded by the schema at eight entries, and the same
// eight are claimed each time: a claim that varied between attempts would look
// like workspaces appearing and disappearing.
func TestHeadStateIsBoundedAndStable(t *testing.T) {
	source := newFakeSource()
	entries := make([]config.Workspace, 0, workspaces.MaxHeadState+3)
	for index := range workspaces.MaxHeadState + 3 {
		path := "/home/dan/projects/repo" + strconv.Itoa(index)
		source.set(path, gitcontext.Context{Branch: "main", HeadCommit: "aaaaaa" + strconv.Itoa(index)})
		entries = append(entries, config.Workspace{
			ID:      "wsp_" + strconv.Itoa(index),
			Path:    path,
			Project: "prj_first",
		})
	}
	set, logs := newSet(t, source, entries...)
	set.Refresh(context.Background())

	state := set.HeadState()
	if len(state) != workspaces.MaxHeadState {
		t.Fatalf("head state carries %d entries, want the schema's %d",
			len(state), workspaces.MaxHeadState)
	}
	for index, head := range state {
		if head.WorkspaceID != "wsp_"+strconv.Itoa(index) {
			t.Fatalf("head state entry %d is %s; the claim is in configuration order",
				index, head.WorkspaceID)
		}
	}
	if !strings.Contains(logs.String(), "more workspaces are configured") {
		t.Fatal("an operator configuring more workspaces than the claim can carry must be told")
	}

	// Every workspace is still reported, because only the claim is bounded.
	if got := len(set.Report()); got != workspaces.MaxHeadState+3 {
		t.Fatalf("the report carries %d observations, want all %d",
			got, workspaces.MaxHeadState+3)
	}
}

// Broad filesystem scanning is disabled (section 9). The rule is asserted
// mechanically, because a directory walk added here would be a privacy change
// no reviewer could be relied upon to notice.
func TestPackageWalksNoDirectory(t *testing.T) {
	forbidden := []string{
		"filepath.Walk",
		"filepath.WalkDir",
		"filepath.Glob",
		"fs.WalkDir",
		"os.ReadDir",
		"Readdir",
		"os.ReadFile",
		"os.Open(",
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
				t.Errorf("%s references %s; this package looks only at explicitly "+
					"configured paths (docs/CONNECTOR_PROTOCOL.md section 9)", name, needle)
			}
		}
	}
	if inspected == 0 {
		t.Fatal("no package source was inspected")
	}
}

// Only the configured paths are ever looked at, whatever else exists beside
// them on the machine.
func TestOnlyConfiguredPathsAreObserved(t *testing.T) {
	source := newFakeSource()
	source.set(firstPath, gitcontext.Context{Branch: "main", HeadCommit: "aaaaaaa"})
	source.set(secondPath, gitcontext.Context{Branch: "main", HeadCommit: "bbbbbbb"})
	set, _ := newSet(t, source, config.Workspace{ID: "wsp_first", Path: firstPath, Project: "prj_first"})

	set.Refresh(context.Background())
	set.Refresh(context.Background())
	if source.calls(firstPath) != 2 {
		t.Fatalf("the configured workspace was observed %d times, want 2", source.calls(firstPath))
	}
	if source.calls(secondPath) != 0 {
		t.Fatalf("a workspace nobody configured was observed %d times", source.calls(secondPath))
	}
}

func TestIntervalDefaultsAndOverrides(t *testing.T) {
	source := newFakeSource()
	set, _ := newSet(t, source)
	if set.Interval() != workspaces.DefaultInterval {
		t.Fatalf("interval = %s, want the %s default", set.Interval(), workspaces.DefaultInterval)
	}
	overridden := workspaces.New(workspaces.Options{Source: source, Interval: 90 * time.Second})
	if overridden.Interval() != 90*time.Second {
		t.Fatalf("interval = %s", overridden.Interval())
	}
}

// A cancelled context stops the sweep rather than running every workspace to
// its own timeout.
func TestRefreshStopsOnACancelledContext(t *testing.T) {
	source := newFakeSource()
	source.set(firstPath, gitcontext.Context{Branch: "main", HeadCommit: "aaaaaaa"})
	set, _ := newSet(t, source, config.Workspace{ID: "wsp_first", Path: firstPath, Project: "prj_first"})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	set.Refresh(ctx)
	if source.calls(firstPath) != 0 {
		t.Fatal("a cancelled sweep must observe nothing")
	}
	if len(set.HeadState()) != 0 {
		t.Fatal("a cancelled sweep must claim nothing")
	}
}

func stringPointer(value string) *string { return &value }
