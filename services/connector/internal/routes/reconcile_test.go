package routes_test

import (
	"net/http"
	"testing"
	"time"

	connectorv1 "github.com/danjonesio/reviewplane/packages/protocol/connectorv1"
	"github.com/danjonesio/reviewplane/services/connector/internal/config"
	"github.com/danjonesio/reviewplane/services/connector/internal/routes"
)

// docs/CONNECTOR_PROTOCOL.md section 17. The connector's side of reconciliation
// has one rule above the rest: the control plane's answer wins, and anything it
// does not continue is not served.

func reconcileManager(t *testing.T, port int) *routes.Manager {
	t.Helper()
	return newManager(t, config.Publication{
		AllowedHosts: []string{"127.0.0.1"},
		AllowedPorts: []string{strconvItoa(port)},
		MaxRoutes:    4,
	})
}

func strconvItoa(value int) string {
	digits := ""
	if value == 0 {
		return "0"
	}
	for value > 0 {
		digits = string(rune('0'+value%10)) + digits
		value /= 10
	}
	return digits
}

func desiredState(routeDecisions []connectorv1.RouteDecision) connectorv1.ReconnectResponse {
	return connectorv1.ReconnectResponse{
		ReconciledAt: time.Now().UTC().Format(time.RFC3339),
		Upgrade:      connectorv1.UpgradeClassificationCompatible,
		Routes:       routeDecisions,
		Sessions:     []connectorv1.SessionDecision{},
	}
}

func continueRoute(publish connectorv1.RoutePublish) connectorv1.RouteDecision {
	return connectorv1.RouteDecision{
		RouteID:  publish.RouteID,
		Decision: connectorv1.RouteReconciliationDecisionContinue,
		Reason:   connectorv1.RouteReconciliationReasonAuthorised,
		Route:    &publish,
	}
}

func TestBeginReconciliationWithdrawsEveryRouteAndReportsIt(t *testing.T) {
	port := startFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	manager := reconcileManager(t, port)
	ack := manager.Publish(publication("127.0.0.1", port, time.Now().Add(time.Hour)))
	if ack.Status != connectorv1.RoutePublishAckStatusReady {
		t.Fatalf("the fixture route was not published: %+v", ack)
	}

	request := manager.BeginReconciliation()

	if manager.Table().Len() != 0 {
		t.Fatal("a route is still being served while reconciliation is outstanding")
	}
	if len(request.ActiveRoutes) != 1 {
		t.Fatalf("the reconnect payload claimed %d routes, want 1", len(request.ActiveRoutes))
	}
	claim := request.ActiveRoutes[0]
	if claim.RouteID != "svc_test_route" || claim.ProjectID != testProject {
		t.Fatalf("the claim does not describe the route: %+v", claim)
	}
	if claim.ObservedDestination != "127.0.0.1:"+strconvItoa(port) {
		t.Fatalf("the claim names %s, want the destination the connector opened", claim.ObservedDestination)
	}
	if request.KnownAgentSessions == nil || request.WorkspaceHeadState == nil {
		t.Fatal("the Stage 1 collections must be present and empty, never absent")
	}
}

func TestContinueResumesTheSameRouteWithoutRepublication(t *testing.T) {
	port := startFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	manager := reconcileManager(t, port)
	publish := publication("127.0.0.1", port, time.Now().Add(time.Hour))

	// The connector has no route at all: this is the process-restart case.
	manager.BeginReconciliation()
	result := manager.ApplyDesiredState("con_test", desiredState([]connectorv1.RouteDecision{
		continueRoute(publish),
	}), nil)

	if result.Continued != 1 || result.Refused != 0 {
		t.Fatalf("result = %+v, want one continued route", result)
	}
	route, carried := manager.Table().Get(publish.RouteID)
	if !carried {
		t.Fatal("the route was not resumed")
	}
	if route.Destination() != "127.0.0.1:"+strconvItoa(port) {
		t.Fatalf("the resumed route points at %s", route.Destination())
	}
}

func TestRevokeWithdrawsTheRoute(t *testing.T) {
	port := startFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	manager := reconcileManager(t, port)
	manager.Publish(publication("127.0.0.1", port, time.Now().Add(time.Hour)))

	manager.BeginReconciliation()
	result := manager.ApplyDesiredState("con_test", desiredState([]connectorv1.RouteDecision{{
		RouteID:  "svc_test_route",
		Decision: connectorv1.RouteReconciliationDecisionRevoke,
		Reason:   connectorv1.RouteReconciliationReasonExpired,
	}}), nil)

	if result.Revoked != 1 {
		t.Fatalf("result = %+v, want one revoked route", result)
	}
	if manager.Table().Len() != 0 {
		t.Fatal("a revoked route is still being served")
	}
}

// A route the control plane names but this connector's own policy refuses is not
// served. Schema acceptance is not authorisation, and the connector's say over
// its own destinations survives reconciliation (docs/CONNECTOR_PROTOCOL.md
// section 11).
func TestContinueIsStillSubjectToTheConnectorsOwnValidation(t *testing.T) {
	port := startFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	manager := reconcileManager(t, port)

	cases := []struct {
		name     string
		mutate   func(connectorv1.RoutePublish) connectorv1.RoutePublish
		expected connectorv1.ErrorClass
	}{
		{
			name: "another project",
			mutate: func(publish connectorv1.RoutePublish) connectorv1.RoutePublish {
				publish.ProjectID = "prj_somewhere_else"
				return publish
			},
			expected: connectorv1.ErrorClassProjectNotAuthorised,
		},
		{
			name: "an unknown workspace",
			mutate: func(publish connectorv1.RoutePublish) connectorv1.RoutePublish {
				publish.WorkspaceID = "wsp_unknown"
				return publish
			},
			expected: connectorv1.ErrorClassWorkspaceNotFound,
		},
		{
			name: "a destination outside the allow-list",
			mutate: func(publish connectorv1.RoutePublish) connectorv1.RoutePublish {
				publish.LocalPort = int64(port) + 1
				return publish
			},
			expected: connectorv1.ErrorClassDestinationNotAllowed,
		},
		{
			name: "an expiry that has passed",
			mutate: func(publish connectorv1.RoutePublish) connectorv1.RoutePublish {
				publish.ExpiresAt = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)
				return publish
			},
			expected: connectorv1.ErrorClassRouteExpired,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			manager.BeginReconciliation()
			publish := testCase.mutate(publication("127.0.0.1", port, time.Now().Add(time.Hour)))
			result := manager.ApplyDesiredState("con_test", desiredState([]connectorv1.RouteDecision{
				continueRoute(publish),
			}), nil)
			if result.Refused != 1 || result.Continued != 0 {
				t.Fatalf("result = %+v, want the route refused", result)
			}
			if result.Routes[0].ErrorClass != testCase.expected {
				t.Fatalf("error class = %q, want %q", result.Routes[0].ErrorClass, testCase.expected)
			}
			if manager.Table().Len() != 0 {
				t.Fatal("a refused route is being served")
			}
		})
	}
}

// A continue with no publication is incoherent — the schema requires one — and
// the connector refuses rather than inventing the route.
func TestContinueWithoutAPublicationIsRefused(t *testing.T) {
	manager := reconcileManager(t, 1024)
	manager.BeginReconciliation()
	result := manager.ApplyDesiredState("con_test", desiredState([]connectorv1.RouteDecision{{
		RouteID:  "svc_test_route",
		Decision: connectorv1.RouteReconciliationDecisionContinue,
		Reason:   connectorv1.RouteReconciliationReasonAuthorised,
	}}), nil)
	if result.Refused != 1 {
		t.Fatalf("result = %+v, want the decision refused", result)
	}
	if result.Routes[0].ErrorClass != connectorv1.ErrorClassProtocolUnsupported {
		t.Fatalf("error class = %q", result.Routes[0].ErrorClass)
	}
}

// Reconnecting repeatedly must not accumulate routes.
func TestRepeatedReconciliationDoesNotDuplicateRoutes(t *testing.T) {
	port := startFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	manager := reconcileManager(t, port)
	publish := publication("127.0.0.1", port, time.Now().Add(time.Hour))

	for round := 1; round <= 5; round++ {
		manager.BeginReconciliation()
		manager.ApplyDesiredState("con_test", desiredState([]connectorv1.RouteDecision{
			continueRoute(publish),
		}), nil)
		if got := manager.Table().Len(); got != 1 {
			t.Fatalf("after round %d the connector carries %d routes, want 1", round, got)
		}
	}
}

// A route that resumes must not need the destination to be listening at that
// instant: the control plane has already authorised it, and a destination that
// has gone away is reported per stream rather than silently dropping a route the
// control plane believes is live.
func TestResumptionDoesNotWaitForTheDestinationToListen(t *testing.T) {
	port := startFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	manager := reconcileManager(t, port)
	publish := publication("127.0.0.1", port, time.Now().Add(time.Hour))
	// A port inside the allow-list with nothing bound to it would fail the
	// publication probe; the resumption path does not run one.
	manager.BeginReconciliation()

	started := time.Now()
	result := manager.ApplyDesiredState("con_test", desiredState([]connectorv1.RouteDecision{
		continueRoute(publish),
	}), nil)
	elapsed := time.Since(started)

	if result.Continued != 1 {
		t.Fatalf("result = %+v, want the route resumed", result)
	}
	if elapsed > 200*time.Millisecond {
		t.Fatalf("reconciliation took %s; it must not wait on a destination probe", elapsed)
	}
}
