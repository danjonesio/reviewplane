package routes

import (
	"log/slog"
	"sort"
	"time"

	connectorv1 "github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/connector/internal/buildinfo"
	"github.com/danjonesio/reviewplane/services/tunnel-gateway/datachannel"
)

// Reconciliation is the connector's half of docs/CONNECTOR_PROTOCOL.md
// section 17.
//
// Its shape follows from one rule: the control plane is the authority, and the
// connector must not assume its own view is correct. So the connector reports
// what it believes it holds, stops serving all of it, and then serves again only
// what the control plane's answer names. That ordering is what makes a timeout
// safe — a reconciliation that never completes leaves nothing being served,
// rather than leaving routes carrying traffic nobody has re-authorised.
//
// Identity survives a reconnect; routes do not automatically. The channel is
// already mutually authenticated by the time any of this runs (section 5.2), and
// each individual route is re-authorised explicitly here.

// RouteOutcome records what the connector did with one route decision, for the
// log line docs/ARCHITECTURE.md section 15 requires.
type RouteOutcome struct {
	RouteID  string
	Decision connectorv1.RouteReconciliationDecision
	Reason   connectorv1.RouteReconciliationReason
	// Resumed reports whether the route is being served again.
	Resumed bool
	// ErrorClass is set when the connector's own validation refused a route the
	// control plane told it to continue. The route is not served in that case:
	// the connector fails closed.
	ErrorClass connectorv1.ErrorClass
	// StreamsReset counts in-flight streams the decision ended.
	StreamsReset int
}

// SessionOutcome records what the connector did with one session decision.
type SessionOutcome struct {
	BrowserSessionID string
	Decision         connectorv1.SessionReconciliationDecision
	Reason           connectorv1.SessionReconciliationReason
	StreamsReset     int
}

// ReconciliationResult summarises one exchange.
type ReconciliationResult struct {
	Routes   []RouteOutcome
	Sessions []SessionOutcome
	// Continued, Revoked and Refused count route outcomes.
	Continued int
	Revoked   int
	Refused   int
}

// BeginReconciliation withdraws every route from service and returns the
// section 17 reconnect payload describing what was withdrawn.
//
// All six fields are always present. Stage 0 reports no agent sessions and no
// workspace head state, because agent-session re-establishment and workspace
// discovery are Stage 1; the fields are sent empty rather than omitted so that
// the message shape does not change when they arrive.
func (m *Manager) BeginReconciliation() connectorv1.ReconnectRequest {
	withdrawn := m.table.Drain()
	claimed := make([]connectorv1.ReconnectRoute, 0, len(withdrawn))
	for _, route := range withdrawn {
		claimed = append(claimed, connectorv1.ReconnectRoute{
			RouteID:             route.RouteID,
			ProjectID:           route.ProjectID,
			WorkspaceID:         route.WorkspaceID,
			ObservedDestination: route.Destination(),
			ExpiresAt:           route.ExpiresAt.UTC().Format(time.RFC3339),
		})
	}
	if len(claimed) > maxReportedRoutes {
		// The payload is bounded by the schema. Reporting the first routes by
		// identifier rather than a truncated arbitrary set keeps the claim
		// deterministic; anything not claimed is simply a route the control plane
		// decides about on its own authority, which it does for every route it
		// holds regardless of what the connector claimed.
		claimed = claimed[:maxReportedRoutes]
	}

	streams := make([]connectorv1.ReconnectStream, 0)
	for _, header := range m.streamHeaders() {
		streams = append(streams, connectorv1.ReconnectStream{
			// The header's session capability is deliberately not copied. It is a
			// bearer credential and reconciliation has no use for it
			// (docs/SECURITY.md section 18).
			StreamID:         header.StreamID,
			RouteID:          header.RouteID,
			BrowserSessionID: header.BrowserSessionID,
			Deadline:         header.Deadline,
		})
	}
	sort.Slice(streams, func(i, j int) bool { return streams[i].StreamID < streams[j].StreamID })
	if len(streams) > maxReportedStreams {
		streams = streams[:maxReportedStreams]
	}

	return connectorv1.ReconnectRequest{
		ConnectorVersion: buildinfo.Version,
		Capabilities:     append([]connectorv1.ConnectorCapability(nil), buildinfo.Capabilities...),
		ActiveRoutes:     claimed,
		ActiveStreams:    streams,
		// Stage 1 capabilities. Present and empty, never absent.
		KnownAgentSessions: []string{},
		WorkspaceHeadState: []connectorv1.WorkspaceHead{},
	}
}

// Schema bounds on the reconnect payload, mirrored here so that a connector
// carrying more than the protocol can describe truncates deterministically
// rather than emitting a frame the control plane must refuse.
const (
	maxReportedRoutes  = 16
	maxReportedStreams = 32
)

// AbandonReconciliation leaves the connector in the closed-route safe state.
//
// It is called when the desired state does not arrive: no route is served, so
// nothing is carrying traffic the control plane has not re-authorised. The
// channel is then dropped and retried, because a connector that cannot reconcile
// cannot serve.
func (m *Manager) AbandonReconciliation(reason string) {
	m.logger.Warn("reconciliation abandoned; no route is being served",
		slog.String("reason", reason),
		slog.Int("active_routes", m.table.Len()),
	)
}

// ApplyDesiredState obeys the control plane's answer.
//
// Every disagreement is resolved the control plane's way. A route it continues
// is admitted again under the same route identifier, without a second
// publication exchange, after the connector has re-run its own section 11
// validation — schema acceptance is not authorisation, and a control plane that
// had been persuaded to name a destination this connector does not allow is
// still refused here. A route it revokes is dropped and its in-flight streams
// are reset, so revocation reaches traffic that is already moving.
func (m *Manager) ApplyDesiredState(
	connectorID string,
	response connectorv1.ReconnectResponse,
	logger *slog.Logger,
) ReconciliationResult {
	if logger == nil {
		logger = m.logger
	}
	result := ReconciliationResult{
		Routes:   make([]RouteOutcome, 0, len(response.Routes)),
		Sessions: make([]SessionOutcome, 0, len(response.Sessions)),
	}

	for _, decision := range response.Routes {
		outcome := RouteOutcome{
			RouteID:  decision.RouteID,
			Decision: decision.Decision,
			Reason:   decision.Reason,
		}
		switch decision.Decision {
		case connectorv1.RouteReconciliationDecisionContinue:
			if decision.Route == nil {
				// The schema requires the publication on a continue, so this is a
				// peer that passed validation and still answered incoherently.
				// Refusing is safer than inventing the route.
				outcome.ErrorClass = connectorv1.ErrorClassProtocolUnsupported
				result.Refused++
				break
			}
			ack := datachannel.ValidateResumption(m.table, *decision.Route, m.publish)
			if ack.Status == connectorv1.RoutePublishAckStatusReady {
				outcome.Resumed = true
				result.Continued++
				break
			}
			outcome.ErrorClass = derefClass(ack.ErrorClass)
			result.Refused++
		case connectorv1.RouteReconciliationDecisionRevoke:
			m.table.Remove(decision.RouteID)
			outcome.StreamsReset = m.resetRoute(decision.RouteID)
			result.Revoked++
		default:
			outcome.ErrorClass = connectorv1.ErrorClassProtocolUnsupported
			result.Refused++
		}
		result.Routes = append(result.Routes, outcome)

		// One line per route, carrying the connector identity and the route
		// identifier: this is the path operators debug most often
		// (docs/ARCHITECTURE.md section 15).
		attributes := []any{
			slog.String("connector_id", connectorID),
			slog.String("route_id", outcome.RouteID),
			slog.String("decision", string(outcome.Decision)),
			slog.String("reason", string(outcome.Reason)),
			slog.Bool("resumed", outcome.Resumed),
			slog.Int("streams_reset", outcome.StreamsReset),
		}
		if outcome.ErrorClass != "" {
			attributes = append(attributes, slog.String("error_class", string(outcome.ErrorClass)))
			logger.Warn("reconciliation refused a route the control plane continued", attributes...)
			continue
		}
		logger.Info("reconciliation decision", attributes...)
	}

	for _, decision := range response.Sessions {
		outcome := SessionOutcome{
			BrowserSessionID: decision.BrowserSessionID,
			Decision:         decision.Decision,
			Reason:           decision.Reason,
		}
		if decision.Decision == connectorv1.SessionReconciliationDecisionEnd {
			// Ending a session means the connector stops carrying what it still
			// holds for it. Re-establishment needs nothing from this side: the
			// gateway opens a fresh stream against the resumed route.
			outcome.StreamsReset = m.resetSession(decision.BrowserSessionID)
		}
		result.Sessions = append(result.Sessions, outcome)
		logger.Info("reconciliation session decision",
			slog.String("connector_id", connectorID),
			slog.String("browser_session_id", outcome.BrowserSessionID),
			slog.String("decision", string(outcome.Decision)),
			slog.String("reason", string(outcome.Reason)),
			slog.Int("streams_reset", outcome.StreamsReset),
		)
	}

	logger.Info("reconciliation complete",
		slog.String("connector_id", connectorID),
		slog.String("upgrade", string(response.Upgrade)),
		slog.String("reconciled_at", response.ReconciledAt),
		slog.Int("continued", result.Continued),
		slog.Int("revoked", result.Revoked),
		slog.Int("refused", result.Refused),
		slog.Int("active_routes", m.table.Len()),
	)
	return result
}

// streamHeaders reports the headers of streams open on the current data channel.
func (m *Manager) streamHeaders() []connectorv1.DataStreamHeader {
	m.sessionMu.Lock()
	session := m.session
	m.sessionMu.Unlock()
	if session == nil {
		return nil
	}
	return session.StreamHeaders()
}

func (m *Manager) resetRoute(routeID string) int {
	m.sessionMu.Lock()
	session := m.session
	m.sessionMu.Unlock()
	if session == nil {
		return 0
	}
	return session.ResetRoute(routeID, connectorv1.ErrorClassRouteExpired)
}

func (m *Manager) resetSession(browserSessionID string) int {
	m.sessionMu.Lock()
	session := m.session
	m.sessionMu.Unlock()
	if session == nil {
		return 0
	}
	return session.ResetSession(browserSessionID, connectorv1.ErrorClassRouteExpired)
}
