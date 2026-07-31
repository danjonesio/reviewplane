package protocolsim_test

import (
	"strings"
	"testing"
	"time"

	connectorv1 "github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/connector/internal/protocolsim"
)

// docs/CONNECTOR_PROTOCOL.md section 9 through the whole stack: a real checkout
// on the development machine, observed by a real connector, encoded by the real
// canonical encoder, and decoded by a control plane that speaks the same schema.
//
// The claim being tested is not that the fields are filled in — the workspaces
// package asserts that on its own — but that they survive the wire, arrive after
// the section 17 claim rather than before it, and carry no filesystem path.

func TestWorkspaceObservationRoundTripsToTheControlPlane(t *testing.T) {
	harness := protocolsim.Start(t, protocolsim.Options{ObserveWorkspaces: true})
	harness.WaitUntil("a workspace observation", 20*time.Second, func() bool {
		return len(harness.ControlPlane.Observations()) > 0
	})

	observation := harness.ControlPlane.Observations()[0]
	if observation.WorkspaceID != protocolsim.WorkspaceID {
		t.Errorf("workspace_id = %q, want %q", observation.WorkspaceID, protocolsim.WorkspaceID)
	}
	if observation.ProjectID != protocolsim.ProjectID {
		t.Errorf("project_id = %q, want %q", observation.ProjectID, protocolsim.ProjectID)
	}
	if observation.Branch != "main" {
		t.Errorf("branch = %q, want main", observation.Branch)
	}
	if observation.Dirty {
		t.Error("a freshly committed checkout is not dirty")
	}
	if observation.RepositoryIdentity == nil ||
		*observation.RepositoryIdentity != "github.com/example/refresh-surplus" {
		t.Errorf("repository_identity = %v; the scp-like remote must reduce to the canonical form",
			observation.RepositoryIdentity)
	}
	if !strings.HasPrefix(observation.PathHash, "sha256:") || len(observation.PathHash) != 71 {
		t.Errorf("path_hash = %q", observation.PathHash)
	}
	if observation.DisplayLabel != "workspace" {
		t.Errorf("display_label = %q, want the checkout directory's own name", observation.DisplayLabel)
	}

	// The path the connector observed must not be recoverable from anything the
	// control plane received. That is what the digest and the label are for
	// (docs/DOMAIN_MODEL.md section 9).
	if strings.Contains(observation.PathHash, harness.WorkspacePath) ||
		strings.Contains(observation.DisplayLabel, "/") {
		t.Fatalf("the observation disclosed the checkout's path: %+v", observation)
	}

	// Reconciliation is the first frame on every established channel (section 8),
	// so an observation must not overtake it. The connector's own log records
	// both in the order it wrote them.
	requested, observed := -1, -1
	for index, line := range harness.LogLines() {
		if requested < 0 && strings.Contains(line, "reconciliation requested") {
			requested = index
		}
		if observed < 0 && strings.Contains(line, "workspace observations sent") {
			observed = index
		}
	}
	if requested < 0 || observed < 0 {
		t.Fatalf("the log records reconciliation at %d and observation at %d", requested, observed)
	}
	if observed < requested {
		t.Fatal("an observation was sent before the reconciliation claim")
	}
}

// Only a change is worth a frame. A connector watching a checkout nobody is
// touching must go quiet rather than repeat itself every interval.
func TestOnlyAChangedWorkspaceIsReportedAgain(t *testing.T) {
	harness := protocolsim.Start(t, protocolsim.Options{
		ObserveWorkspaces: true,
		ObserveInterval:   200 * time.Millisecond,
	})
	harness.WaitUntil("the initial workspace report", 20*time.Second, func() bool {
		return len(harness.ControlPlane.Observations()) > 0
	})
	initial := len(harness.ControlPlane.Observations())

	// Several intervals pass with nothing happening on the machine.
	time.Sleep(2 * time.Second)
	if got := len(harness.ControlPlane.Observations()); got != initial {
		t.Fatalf("an untouched checkout produced %d further observations", got-initial)
	}

	harness.DirtyWorkspace()
	harness.WaitUntil("the change to be reported", 20*time.Second, func() bool {
		return len(harness.ControlPlane.Observations()) > initial
	})
	latest := harness.ControlPlane.Observations()
	change := latest[len(latest)-1]
	if !change.Dirty {
		t.Fatalf("the reported change does not carry the dirty state: %+v", change)
	}
	if change.WorkspaceID != protocolsim.WorkspaceID {
		t.Fatalf("the change names %q", change.WorkspaceID)
	}
	// The file that made it dirty is not reportable at this protocol version,
	// and there is no member that could carry it.
	if strings.Contains(change.DisplayLabel, "uncommitted") {
		t.Fatal("a changed path reached the observation")
	}
}

// docs/CONNECTOR_PROTOCOL.md section 17: workspace_head_state was an empty array
// at Stage 0 and is now the connector's real observed state. It is still always
// present, and still bounded by the schema.
func TestReconnectClaimCarriesRealWorkspaceHeadState(t *testing.T) {
	harness := protocolsim.Start(t, protocolsim.Options{
		ObserveWorkspaces: true,
		Reconnect:         shortBackoff(),
	})
	harness.WaitUntil("the first reconnect claim", 20*time.Second, func() bool {
		return len(harness.ControlPlane.ReconnectRequests()) > 0
	})

	first := harness.ControlPlane.ReconnectRequests()[0]
	if len(first.WorkspaceHeadState) != 1 {
		t.Fatalf("the first claim carries %d workspaces; the connector observes one before it dials",
			len(first.WorkspaceHeadState))
	}
	head := first.WorkspaceHeadState[0]
	if head.WorkspaceID != protocolsim.WorkspaceID || head.Branch != "main" {
		t.Fatalf("head state = %+v", head)
	}
	if len(head.HeadCommit) < 7 {
		t.Fatalf("head_commit = %q, which is shorter than the schema permits", head.HeadCommit)
	}

	// A reconnect claims the same state: identity survives, and so does what the
	// connector believes about its checkouts.
	claimed := len(harness.ControlPlane.ReconnectRequests())
	harness.Partition()
	harness.Heal()
	harness.WaitUntil("a second reconnect claim", 30*time.Second, func() bool {
		return len(harness.ControlPlane.ReconnectRequests()) > claimed
	})
	requests := harness.ControlPlane.ReconnectRequests()
	last := requests[len(requests)-1]
	if len(last.WorkspaceHeadState) != 1 || last.WorkspaceHeadState[0].HeadCommit != head.HeadCommit {
		t.Fatalf("the reconnect claim = %+v, want the same head state", last.WorkspaceHeadState)
	}

	// And the claim is still a frame the schema accepts, encoded by the real
	// encoder rather than by the test.
	if _, err := connectorv1.EncodeControlFrame(connectorv1.Frame{
		Envelope: connectorv1.Envelope{
			ProtocolVersion: connectorv1.ProtocolVersion,
			MessageID:       "msg_workspacehead",
			Type:            connectorv1.MessageTypeConnectorReconnectRequest,
			SentAt:          time.Now().UTC().Format(time.RFC3339),
			ConnectorID:     &harness.ConnectorID,
		},
		Payload: last,
	}); err != nil {
		t.Fatalf("the reconnect payload does not satisfy the schema: %v", err)
	}
}

// After a lost channel the whole set is reported again: a control plane that
// restarted has no memory of the last report, and a workspace suppressed as
// unchanged would stay invisible until it happened to change.
func TestAReconnectSendsTheWholeReportAgain(t *testing.T) {
	harness := protocolsim.Start(t, protocolsim.Options{
		ObserveWorkspaces: true,
		ObserveInterval:   500 * time.Millisecond,
		Reconnect:         shortBackoff(),
	})
	harness.WaitUntil("the initial workspace report", 20*time.Second, func() bool {
		return len(harness.ControlPlane.Observations()) > 0
	})
	before := len(harness.ControlPlane.Observations())

	harness.Partition()
	harness.Heal()
	harness.WaitForRoute(30 * time.Second)
	harness.WaitUntil("the workspace to be reported again", 20*time.Second, func() bool {
		return len(harness.ControlPlane.Observations()) > before
	})
}
