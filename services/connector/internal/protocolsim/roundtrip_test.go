package protocolsim_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	connectorv1 "github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/connector/internal/config"
	"github.com/danjonesio/reviewplane/services/connector/internal/protocolsim"
)

// The Stage 0 exit criterion "Protocol round trip survives connector reconnect"
// is a specific assertion, and this file is where it is made:
//
//  1. a request issued before the interruption succeeds;
//  2. a request issued during it fails with a stable code and does not hang;
//  3. an equivalent request issued afterwards succeeds over the same route
//     identifier, against the same destination, with no operator action.
//
// A fourth thing is asserted throughout: no request is ever answered by a
// different development environment. The harness runs two, so "the right one"
// is a claim with a way to be wrong.

func TestProtocolRoundTripSurvivesConnectorReconnect(t *testing.T) {
	harness := protocolsim.Start(t, protocolsim.Options{})
	transcript := make([]string, 0, 3)

	before := harness.Get("/before")
	if before.Status != 200 || before.Environment != "authorised" {
		t.Fatalf("the pre-disconnect request did not reach the authorised environment: %+v", before)
	}
	transcript = append(transcript, fmt.Sprintf(
		"pre-disconnect   route=%s status=%d environment=%s body=%q",
		protocolsim.RouteID, before.Status, before.Environment, before.Body))

	harness.Partition()
	harness.WaitUntil("the data channel to drop", 5*time.Second, func() bool {
		return !harness.DataChannelLive()
	})

	// The request must fail, and it must fail quickly with a code. A hang here
	// is the failure mode the acceptance criteria name explicitly.
	started := time.Now()
	during := harness.Get("/during")
	elapsed := time.Since(started)
	if during.Code != protocolsim.CodeConnectorOffline {
		t.Fatalf("the mid-disconnect request reported %q, want %s: %+v",
			during.Code, protocolsim.CodeConnectorOffline, during)
	}
	if during.Status != 0 {
		t.Fatalf("the mid-disconnect request was answered by something: %+v", during)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("the mid-disconnect request took %s; it must fail rather than hang", elapsed)
	}
	transcript = append(transcript, fmt.Sprintf(
		"mid-disconnect   route=%s code=%s elapsed=%s", protocolsim.RouteID, during.Code, elapsed.Round(time.Millisecond)))

	// No operator action: the harness only stops refusing the connection.
	harness.Heal()
	harness.WaitForRoute(20 * time.Second)

	after := harness.Get("/after")
	if after.Status != 200 || after.Environment != "authorised" {
		t.Fatalf("the post-reconnect request did not reach the authorised environment: %+v", after)
	}
	transcript = append(transcript, fmt.Sprintf(
		"post-reconnect   route=%s status=%d environment=%s body=%q",
		protocolsim.RouteID, after.Status, after.Environment, after.Body))

	// The same route identifier served both requests, without a republication:
	// nothing in this test calls the publication exchange at all.
	route, carried := harness.Manager.Table().Get(protocolsim.RouteID)
	if !carried {
		t.Fatal("the connector is not carrying the route it just served")
	}
	if route.Destination() != harness.Authorised.Destination() {
		t.Fatalf("the resumed route points at %s, want %s",
			route.Destination(), harness.Authorised.Destination())
	}
	if harness.Decoy.Requests.Load() != 0 {
		t.Fatalf("the decoy environment served %d requests; traffic was redirected",
			harness.Decoy.Requests.Load())
	}
	if got := harness.Authorised.Requests.Load(); got != 2 {
		t.Fatalf("the authorised environment served %d requests, want 2", got)
	}

	writeEvidence(t, "round-trip.txt", strings.Join(transcript, "\n")+"\n")
	for _, line := range transcript {
		t.Log(line)
	}
}

// The six fields of docs/CONNECTOR_PROTOCOL.md section 17 are always present,
// and the two Stage 1 collections are empty rather than absent.
func TestReconnectPayloadCarriesAllSixFields(t *testing.T) {
	harness := protocolsim.Start(t, protocolsim.Options{})
	harness.WaitUntil("a reconnect payload", 10*time.Second, func() bool {
		return len(harness.ControlPlane.ReconnectRequests()) > 0
	})
	request := harness.ControlPlane.ReconnectRequests()[0]

	if request.ConnectorVersion == "" {
		t.Error("connector_version is empty")
	}
	if len(request.Capabilities) == 0 {
		t.Error("capabilities is empty; this build advertises tunnel capabilities")
	}
	if request.ActiveRoutes == nil {
		t.Error("active_routes is absent, not empty")
	}
	if request.ActiveStreams == nil {
		t.Error("active_streams is absent, not empty")
	}
	if request.KnownAgentSessions == nil || len(request.KnownAgentSessions) != 0 {
		t.Errorf("known_agent_sessions is %v; Stage 0 sends it present and empty", request.KnownAgentSessions)
	}
	if request.WorkspaceHeadState == nil || len(request.WorkspaceHeadState) != 0 {
		t.Errorf("workspace_head_state is %v; Stage 0 sends it present and empty", request.WorkspaceHeadState)
	}

	// It must also be a frame the schema accepts, encoded by the real encoder.
	if _, err := connectorv1.EncodeControlFrame(connectorv1.Frame{
		Envelope: connectorv1.Envelope{
			ProtocolVersion: connectorv1.ProtocolVersion,
			MessageID:       "msg_roundtrip",
			Type:            connectorv1.MessageTypeConnectorReconnectRequest,
			SentAt:          time.Now().UTC().Format(time.RFC3339),
			ConnectorID:     &harness.ConnectorID,
		},
		Payload: request,
	}); err != nil {
		t.Fatalf("the reconnect payload does not satisfy the schema: %v", err)
	}
}

// A route the connector claims and the control plane will not continue is
// closed, and stays closed: reconnecting is not a way to extend access.
func TestUnknownRouteIsClosedOnReconnect(t *testing.T) {
	harness := protocolsim.Start(t, protocolsim.Options{})

	harness.SetReconciler(func(string, connectorv1.ReconnectRequest) connectorv1.ReconnectResponse {
		return connectorv1.ReconnectResponse{
			ReconciledAt: time.Now().UTC().Format(time.RFC3339),
			Upgrade:      connectorv1.UpgradeClassificationCompatible,
			Routes: []connectorv1.RouteDecision{{
				RouteID:  protocolsim.RouteID,
				Decision: connectorv1.RouteReconciliationDecisionRevoke,
				Reason:   connectorv1.RouteReconciliationReasonUnknownRoute,
			}},
			Sessions: []connectorv1.SessionDecision{{
				BrowserSessionID: protocolsim.SessionID,
				Decision:         connectorv1.SessionReconciliationDecisionEnd,
				Reason:           connectorv1.SessionReconciliationReasonRouteRevoked,
			}},
		}
	})

	claimed := len(harness.ControlPlane.ReconnectRequests())
	harness.Partition()
	harness.Heal()
	harness.WaitUntil("a second reconciliation", 20*time.Second, func() bool {
		return len(harness.ControlPlane.ReconnectRequests()) > claimed
	})
	harness.WaitUntil("the data channel to return", 20*time.Second, harness.DataChannelLive)

	// The connector claimed the route it was serving, and the control plane did
	// not recognise it.
	requests := harness.ControlPlane.ReconnectRequests()
	last := requests[len(requests)-1]
	if len(last.ActiveRoutes) != 1 || last.ActiveRoutes[0].RouteID != protocolsim.RouteID {
		t.Fatalf("the connector did not claim the route it was serving: %+v", last.ActiveRoutes)
	}

	harness.WaitUntil("the route to be withdrawn", 10*time.Second, func() bool {
		_, carried := harness.Manager.Table().Get(protocolsim.RouteID)
		return !carried
	})
	response := harness.Get("/after-revocation")
	if response.Code != protocolsim.CodeRouteExpired {
		t.Fatalf("a revoked route answered %q, want %s: %+v",
			response.Code, protocolsim.CodeRouteExpired, response)
	}
	if harness.Authorised.Requests.Load() != 0 {
		t.Fatal("a revoked route still reached the development environment")
	}

	decisions := harness.LogsContaining("reconciliation decision", protocolsim.RouteID, "unknown_route")
	if len(decisions) == 0 {
		t.Fatal("no reconciliation decision was logged with the route identifier and its reason")
	}
	if !strings.Contains(decisions[0], harness.ConnectorID) {
		t.Fatalf("the reconciliation log line does not carry the connector identity: %s", decisions[0])
	}
	writeEvidence(t, "reconciliation-log.txt", strings.Join(decisions, "\n")+"\n")
}

// A desired state that never arrives leaves the connector serving nothing.
func TestDesiredStateTimeoutLeavesRoutesClosed(t *testing.T) {
	harness := protocolsim.Start(t, protocolsim.Options{
		WithholdDesiredState: true,
		DesiredStateTimeout:  500 * time.Millisecond,
		SkipWaitForRoute:     true,
	})

	harness.WaitUntil("the connector to ask for a desired state", 15*time.Second, func() bool {
		return len(harness.ControlPlane.ReconnectRequests()) > 0
	})
	harness.WaitUntil("the reconciliation to be abandoned", 15*time.Second, func() bool {
		return len(harness.LogsContaining("reconciliation abandoned")) > 0
	})

	if harness.Manager.Table().Len() != 0 {
		t.Fatalf("the connector is serving %d routes without a desired state",
			harness.Manager.Table().Len())
	}
	// The data channel may still be up — it is a separate connection with its own
	// supervisor — and a request on it must still reach nothing.
	if harness.DataChannelLive() {
		response := harness.Get("/unreconciled")
		if response.Status != 0 {
			t.Fatalf("an unreconciled route served a request: %+v", response)
		}
	}
	// And the connector keeps trying rather than giving up quietly.
	harness.WaitUntil("a further reconnect attempt", 20*time.Second, func() bool {
		return len(harness.ControlPlane.ReconnectRequests()) > 1
	})
}

// Repeated reconnects must not duplicate a route or leak a stream.
func TestFlappingReconnectsDoNotDuplicateRoutesOrLeakStreams(t *testing.T) {
	harness := protocolsim.Start(t, protocolsim.Options{
		Reconnect: shortBackoff(),
	})

	for attempt := 1; attempt <= 6; attempt++ {
		harness.Partition()
		harness.Heal()
		harness.WaitForRoute(20 * time.Second)
		if got := harness.Manager.Table().Len(); got != 1 {
			t.Fatalf("after flap %d the connector carries %d routes, want 1", attempt, got)
		}
		if got := harness.Manager.ActiveStreams(); got != 0 {
			t.Fatalf("after flap %d the connector still holds %d streams", attempt, got)
		}
		response := harness.Get("/flap")
		if response.Status != 200 || response.Environment != "authorised" {
			t.Fatalf("after flap %d the route did not serve: %+v", attempt, response)
		}
	}
	if harness.Decoy.Requests.Load() != 0 {
		t.Fatal("flapping redirected traffic to a different environment")
	}
}

// A reconnect that classifies the build as upgrade_required stops the connector
// rather than retrying, and leaves no route being served.
func TestUpgradeRequiredIsTerminal(t *testing.T) {
	harness := protocolsim.Start(t, protocolsim.Options{SkipWaitForRoute: true})
	harness.SetReconciler(func(string, connectorv1.ReconnectRequest) connectorv1.ReconnectResponse {
		return connectorv1.ReconnectResponse{
			ReconciledAt: time.Now().UTC().Format(time.RFC3339),
			Upgrade:      connectorv1.UpgradeClassificationUpgradeRequired,
			Routes:       []connectorv1.RouteDecision{},
			Sessions:     []connectorv1.SessionDecision{},
		}
	})
	harness.SeverControlOnly()

	harness.WaitUntil("the connector to stop on UPGRADE_REQUIRED", 20*time.Second, func() bool {
		return len(harness.LogsContaining("channel refused", "UPGRADE_REQUIRED")) > 0
	})
	if harness.Manager.Table().Len() != 0 {
		t.Fatal("a connector the control plane refused is still serving a route")
	}
}

// A control-channel drop on its own must not tear down traffic that is already
// flowing: the two channels have different lifetimes and different peers.
func TestControlChannelDropDoesNotStopTraffic(t *testing.T) {
	harness := protocolsim.Start(t, protocolsim.Options{Reconnect: slowBackoff()})
	if response := harness.Get("/before"); response.Status != 200 {
		t.Fatalf("the route did not serve before the drop: %+v", response)
	}
	harness.SeverControlOnly()
	response := harness.Get("/during-control-drop")
	if response.Status != 200 || response.Environment != "authorised" {
		t.Fatalf("a control-channel drop stopped data-channel traffic: %+v", response)
	}
	harness.WaitForRoute(20 * time.Second)
}

// The measured evidence for "bounded jittered backoff": ten forced disconnects,
// each timed from the partition to the first request the resumed route serves.
func TestReconnectTimeDistributionOverTenForcedDisconnects(t *testing.T) {
	harness := protocolsim.Start(t, protocolsim.Options{Reconnect: shortBackoff()})

	const disconnects = 10
	durations := make([]time.Duration, 0, disconnects)
	for attempt := 1; attempt <= disconnects; attempt++ {
		started := time.Now()
		harness.Partition()
		harness.Heal()
		harness.WaitForRoute(30 * time.Second)
		response := harness.Get("/recovered")
		if response.Status != 200 || response.Environment != "authorised" {
			t.Fatalf("disconnect %d did not recover: %+v", attempt, response)
		}
		durations = append(durations, time.Since(started))
	}

	sorted := append([]time.Duration(nil), durations...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	median := sorted[len(sorted)/2]
	// The bound: no recovery may take longer than a handful of maximum delays.
	// An unbounded or un-jittered loop fails this by construction, and so does a
	// reconnect that needs an operator.
	const ceiling = 15 * time.Second
	for index, duration := range durations {
		if duration > ceiling {
			t.Fatalf("recovery %d took %s, beyond the %s bound", index+1, duration, ceiling)
		}
	}

	report := &strings.Builder{}
	fmt.Fprintf(report, "forced disconnects: %d\n", disconnects)
	for index, duration := range durations {
		fmt.Fprintf(report, "  %2d  recovery=%s\n", index+1, duration.Round(time.Millisecond))
	}
	fmt.Fprintf(report, "min=%s median=%s max=%s\n",
		sorted[0].Round(time.Millisecond), median.Round(time.Millisecond),
		sorted[len(sorted)-1].Round(time.Millisecond))

	// The backoff the connector actually used, read out of its own log rather
	// than recomputed: these are the delays that prove the jitter and the bound.
	delays := retryDelays(harness.LogsContaining("reconnecting"))
	fmt.Fprintf(report, "observed backoff delays (%d): %v\n", len(delays), delays)
	if len(delays) == 0 {
		t.Fatal("the connector logged no reconnect delay")
	}
	distinct := map[time.Duration]struct{}{}
	for _, delay := range delays {
		if delay > shortBackoff().MaxDelay {
			t.Fatalf("a reconnect delay of %s exceeded the configured maximum %s",
				delay, shortBackoff().MaxDelay)
		}
		distinct[delay] = struct{}{}
	}
	if len(delays) > 3 && len(distinct) == 1 {
		t.Fatalf("every reconnect delay was %v; the backoff is not jittered", delays)
	}

	t.Log("\n" + report.String())
	writeEvidence(t, "reconnect-distribution.txt", report.String())
}

// shortBackoff keeps the delays small enough to observe the bound and the
// jitter without waiting a minute for them.
func shortBackoff() config.Reconnect {
	return config.Reconnect{
		InitialDelay: 100 * time.Millisecond,
		MaxDelay:     800 * time.Millisecond,
		Factor:       2,
		Jitter:       0.3,
	}
}

// slowBackoff makes the reconnect window wide enough that a test can act inside
// it deterministically rather than racing it.
func slowBackoff() config.Reconnect {
	return config.Reconnect{
		InitialDelay: 3 * time.Second,
		MaxDelay:     3 * time.Second,
		Factor:       1,
		Jitter:       0,
	}
}

// retryDelays reads the retry_in field out of the connector's structured log.
func retryDelays(lines []string) []time.Duration {
	delays := make([]time.Duration, 0, len(lines))
	for _, line := range lines {
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			continue
		}
		raw, ok := record["retry_in"]
		if !ok {
			continue
		}
		switch value := raw.(type) {
		case float64:
			delays = append(delays, time.Duration(value))
		case string:
			if parsed, err := time.ParseDuration(value); err == nil {
				delays = append(delays, parsed)
			}
		}
	}
	return delays
}

// writeEvidence records a transcript under docs/evidence/rvp-18 when the run
// asks for it, so that the pull request's evidence is produced by the test
// rather than transcribed by hand.
func writeEvidence(t *testing.T, name, content string) {
	t.Helper()
	directory := os.Getenv("REVIEWPLANE_EVIDENCE_DIR")
	if directory == "" {
		return
	}
	if err := os.MkdirAll(directory, 0o750); err != nil {
		t.Fatalf("creating the evidence directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(directory, name), []byte(content), 0o600); err != nil {
		t.Fatalf("writing %s: %v", name, err)
	}
}
