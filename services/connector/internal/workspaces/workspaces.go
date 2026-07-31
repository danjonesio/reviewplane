// Package workspaces owns the connector's configured workspaces and the
// lifecycle of their observations.
//
// docs/CONNECTOR_PROTOCOL.md section 9 lists three discovery modes and says
// which of them a connector may use: explicit configured paths, an
// agent-supplied working directory, and optional bounded root scanning. "Broad
// filesystem scanning is disabled" is the sentence this package exists to
// honour, and it honours it structurally: the only paths it ever looks at are
// the ones an operator wrote in the workspaces block, and there is no directory
// walk anywhere in it or in internal/gitcontext. A test asserts that
// mechanically, because it is a privacy boundary rather than a preference.
//
// An observation is reported on connect, on change and on reconnect:
//
//   - on connect, the whole set goes out once the channel's reconciliation has
//     completed, so the control plane learns what this environment holds;
//   - on change, only the workspaces whose branch, head commit or dirty state
//     actually moved are sent, so a connector idling on an untouched machine is
//     silent rather than repeating itself every interval;
//   - on reconnect, the same full report follows the section 17 claim, because
//     a control plane that restarted has no memory of the last one.
//
// The reconnect claim itself (workspace_head_state) is answered from the last
// observation rather than by observing afresh. The claim is the first frame on
// an established channel and nothing may delay it — a workspace on a stalled
// network mount would otherwise hold up reconciliation, during which the
// connector serves no route at all. What the control plane receives is
// therefore genuinely observed state that may be one interval old, followed
// within milliseconds by the fresh full report; and section 17 already says the
// control plane's answer wins in every disagreement, so a claim is never
// authority.
package workspaces

import (
	"context"
	"log/slog"
	"sync"
	"time"

	connectorv1 "github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/connector/internal/config"
	"github.com/danjonesio/reviewplane/services/connector/internal/gitcontext"
	"github.com/danjonesio/reviewplane/services/connector/internal/protocolio"
)

// DefaultInterval is how often the connector looks for a change. It is a
// compromise: short enough that a branch switch reaches a supervising human
// while they still remember making it, and long enough that a machine with
// several checkouts is not running git continuously.
const DefaultInterval = 30 * time.Second

// MaxHeadState is the reconnect claim's array bound from
// schemas/connector/v1.schema.json. It is mirrored here so that a connector
// serving more workspaces than the protocol can describe truncates
// deterministically rather than emitting a frame the control plane must refuse.
const MaxHeadState = 8

// Source derives Git context for one workspace directory. It is an interface so
// that the lifecycle can be tested without a repository on disk; the production
// implementation is internal/gitcontext.Reader.
type Source interface {
	Observe(ctx context.Context, absolutePath string) (gitcontext.Context, error)
}

// Options configure a Set.
type Options struct {
	// Workspaces are the explicitly configured checkouts. Nothing else is ever
	// looked at.
	Workspaces []config.Workspace
	// Source observes one workspace. Nil means a gitcontext.Reader with its own
	// defaults.
	Source Source
	// Interval is how often Changed is polled. Zero means DefaultInterval.
	Interval time.Duration
	// Logger records skipped workspaces and observation failures.
	Logger *slog.Logger
	// Now supplies the observed_at instant. It is a payload field and never a
	// deadline: an injected clock must not reach a network deadline (RVP-61), and
	// nothing in this package sets one.
	Now func() time.Time
}

// entry is one configured workspace and what was last seen and last sent.
type entry struct {
	workspace config.Workspace
	// observation is the last successful observation, or nil when the workspace
	// has never been observed or has stopped being a checkout.
	observation *connectorv1.WorkspaceObservation
	// reported is the state last sent to a control plane, used to decide whether
	// anything has changed.
	reported *connectorv1.WorkspaceHead
}

// Set is the connector's configured workspaces and their observation state.
//
// It is safe for concurrent use: the channel's reconciliation reads the head
// state while the observation ticker is writing it.
type Set struct {
	source   Source
	interval time.Duration
	logger   *slog.Logger
	now      func() time.Time

	mu      sync.Mutex
	entries []*entry
}

// New builds the set from configuration.
//
// A workspace with no identifier or no project is skipped rather than reported
// under a guess: a publication names both (section 11), and an observation the
// control plane cannot attribute to a project is one it must refuse with
// PROJECT_NOT_AUTHORISED. The operator is told which entry was skipped and why,
// because a silently ignored setting is the failure docs/CONFIGURATION.md
// section 1 exists to prevent.
func New(options Options) *Set {
	set := &Set{
		source:   options.Source,
		interval: options.Interval,
		logger:   options.Logger,
		now:      options.Now,
	}
	if set.source == nil {
		set.source = gitcontext.New(gitcontext.Options{})
	}
	if set.interval <= 0 {
		set.interval = DefaultInterval
	}
	if set.logger == nil {
		set.logger = slog.New(slog.DiscardHandler)
	}
	if set.now == nil {
		set.now = time.Now
	}

	for index, workspace := range options.Workspaces {
		switch {
		case workspace.ID == "":
			set.logger.Warn("skipping a workspace with no identifier; a publication names one",
				slog.Int("index", index),
				slog.String("project", workspace.Project),
			)
			continue
		case workspace.Project == "":
			set.logger.Warn("skipping a workspace with no project; an observation is attributed to one",
				slog.Int("index", index),
				slog.String("workspace_id", workspace.ID),
			)
			continue
		}
		set.entries = append(set.entries, &entry{workspace: workspace})
	}
	if len(set.entries) > MaxHeadState {
		// Every workspace is still observed and still reported: only the
		// reconnect claim is bounded, and a claim is not an authorisation.
		set.logger.Warn("more workspaces are configured than the reconnect claim can carry",
			slog.Int("configured", len(set.entries)),
			slog.Int("claimed", MaxHeadState),
		)
	}
	return set
}

// Interval is how often Changed should be polled.
func (s *Set) Interval() time.Duration { return s.interval }

// Len reports how many workspaces are observed.
func (s *Set) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.entries)
}

// Refresh observes every configured workspace and records what it found.
//
// A workspace that yields no context — not a checkout, no commit yet, git not
// installed — is forgotten rather than reported stale: the connector says
// nothing about it instead of asserting a branch it can no longer see.
func (s *Set) Refresh(ctx context.Context) {
	s.mu.Lock()
	entries := append([]*entry(nil), s.entries...)
	now := s.now()
	s.mu.Unlock()

	observed := make([]*connectorv1.WorkspaceObservation, len(entries))
	for index, item := range entries {
		if ctx.Err() != nil {
			return
		}
		state, err := s.source.Observe(ctx, item.workspace.Path)
		if err != nil {
			reason, typed := gitcontext.Unavailable(err)
			if !typed {
				reason = "cancelled"
			}
			// Debug rather than warn: a configured path that is not a checkout
			// is a normal state on a machine being set up, and a warning every
			// interval would drown the log docs/ARCHITECTURE.md section 15 asks
			// to be diagnosable.
			s.logger.Debug("no Git context for a configured workspace",
				slog.String("workspace_id", item.workspace.ID),
				slog.String("reason", string(reason)),
			)
			continue
		}
		observation := connectorv1.WorkspaceObservation{
			WorkspaceID:  item.workspace.ID,
			ProjectID:    item.workspace.Project,
			PathHash:     gitcontext.PathHash(item.workspace.Path),
			DisplayLabel: gitcontext.DisplayLabel(item.workspace.Path),
			Branch:       state.Branch,
			HeadCommit:   state.HeadCommit,
			Dirty:        state.Dirty,
			ObservedAt:   protocolio.Timestamp(now),
		}
		if state.RepositoryIdentity != "" {
			identity := state.RepositoryIdentity
			observation.RepositoryIdentity = &identity
		}
		observed[index] = &observation
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	for index, item := range entries {
		// A nil entry clears the observation rather than leaving the previous
		// one in place: the connector says nothing about a checkout it can no
		// longer see, instead of continuing to assert a branch on its behalf.
		item.observation = observed[index]
	}
}

// Report is every current observation, and marks them all as reported.
//
// It is the full report sent once per established channel. It observes nothing
// itself, so the caller decides when the cost of running git is paid.
func (s *Set) Report() []connectorv1.WorkspaceObservation {
	s.mu.Lock()
	defer s.mu.Unlock()
	report := make([]connectorv1.WorkspaceObservation, 0, len(s.entries))
	for _, item := range s.entries {
		if item.observation == nil {
			continue
		}
		report = append(report, *item.observation)
		item.reported = headOf(*item.observation)
	}
	return report
}

// Changed observes every workspace and returns those whose branch, head commit
// or dirty state moved since they were last reported.
//
// Only those three members decide. A path hash and a display label cannot change
// without the configuration changing, and observed_at changes every interval by
// construction — reporting on it would make the connector chatty without saying
// anything new.
func (s *Set) Changed(ctx context.Context) []connectorv1.WorkspaceObservation {
	s.Refresh(ctx)

	s.mu.Lock()
	defer s.mu.Unlock()
	changed := make([]connectorv1.WorkspaceObservation, 0, len(s.entries))
	for _, item := range s.entries {
		if item.observation == nil {
			continue
		}
		head := headOf(*item.observation)
		if item.reported != nil && *item.reported == *head {
			continue
		}
		changed = append(changed, *item.observation)
		item.reported = head
	}
	return changed
}

// Forget clears what has been reported, so that the next Report is a full one.
//
// It is called when a channel is lost. A control plane that restarted has no
// memory of what this connector sent, and a connector that suppressed an
// unchanged workspace would leave that workspace invisible until it happened to
// change.
func (s *Set) Forget() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, item := range s.entries {
		item.reported = nil
	}
}

// HeadState is the section 17 reconnect claim, from the last observation.
//
// It is bounded by the schema at eight entries. The workspaces are claimed in
// configuration order rather than by an arbitrary truncation, so two consecutive
// reconnects from an unchanged connector claim the same eight — a claim that
// varied between attempts would look to the control plane like a connector
// whose workspaces kept appearing and disappearing.
func (s *Set) HeadState() []connectorv1.WorkspaceHead {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := make([]connectorv1.WorkspaceHead, 0, min(len(s.entries), MaxHeadState))
	for _, item := range s.entries {
		if item.observation == nil {
			continue
		}
		if len(state) == MaxHeadState {
			break
		}
		state = append(state, *headOf(*item.observation))
	}
	return state
}

// headOf reduces an observation to the three members that decide whether
// anything changed, which are exactly the members the reconnect claim carries.
func headOf(observation connectorv1.WorkspaceObservation) *connectorv1.WorkspaceHead {
	return &connectorv1.WorkspaceHead{
		WorkspaceID: observation.WorkspaceID,
		Branch:      observation.Branch,
		HeadCommit:  observation.HeadCommit,
		Dirty:       observation.Dirty,
	}
}
