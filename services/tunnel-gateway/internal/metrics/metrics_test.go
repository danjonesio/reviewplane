package metrics

import (
	"strings"
	"testing"
)

func TestExpositionIsStableAndEscaped(t *testing.T) {
	registry := New()
	registry.Count(Streams, "outcome", "opened")
	registry.Count(Streams, "outcome", "opened")
	registry.Count(Streams, "outcome", "reset")
	registry.Add(Bytes, 4096, "direction", DirectionFromDestination)
	registry.SetGauge(RoutesActive, 3)
	registry.SetGauge(RouteBytes, 12, "route_id", `svc_"quoted"`, "direction", DirectionToDestination)

	exposition := registry.Expose()
	for _, required := range []string{
		"# TYPE " + Streams + " counter",
		Streams + `{outcome="opened"} 2`,
		Streams + `{outcome="reset"} 1`,
		Bytes + `{direction="from_destination"} 4096`,
		"# TYPE " + RoutesActive + " gauge",
		RoutesActive + " 3",
		RouteBytes + `{route_id="svc_\"quoted\"",direction="to_destination"} 12`,
	} {
		if !strings.Contains(exposition, required) {
			t.Fatalf("exposition does not carry %q:\n%s", required, exposition)
		}
	}
	if exposition != registry.Expose() {
		t.Fatal("the exposition is not stable between calls")
	}
}

func TestClearingAGaugeDropsEverySeries(t *testing.T) {
	// A per-route series must not outlive its route: routes are short-lived, so
	// keeping one for ever is an unbounded cardinality leak.
	registry := New()
	registry.SetGauge(RouteBytes, 1, "route_id", "svc_a", "direction", DirectionToDestination)
	registry.SetGauge(RouteBytes, 2, "route_id", "svc_b", "direction", DirectionToDestination)
	registry.ClearGauge(RouteBytes)
	if strings.Contains(registry.Expose(), "svc_a") || strings.Contains(registry.Expose(), "svc_b") {
		t.Fatal("clearing a gauge left a series behind")
	}
}

func TestValueReadsCountersAndGauges(t *testing.T) {
	registry := New()
	registry.Add(Requests, 5, "code", "ok")
	registry.SetGauge(StreamsActive, 2)
	if registry.Value(Requests, "code", "ok") != 5 {
		t.Fatal("a counter did not read back")
	}
	if registry.Value(StreamsActive) != 2 {
		t.Fatal("a gauge did not read back")
	}
	if registry.Value("reviewplane_tunnel_nothing") != 0 {
		t.Fatal("an unknown metric read back non-zero")
	}
}

func TestEveryGatewayMetricIsDocumented(t *testing.T) {
	// docs/ARCHITECTURE.md section 15 requires metrics; an undocumented one is
	// an operator's problem rather than a developer's.
	registry := New()
	for _, name := range []string{
		ConnectorChannels, ConnectorChannelsOpen, RouteLifecycle, RoutesActive,
		Streams, StreamsActive, Bytes, Requests, Denials, RouteBytes, RouteStreams,
	} {
		registry.Count(name, "label", "value")
		if !strings.Contains(registry.Expose(), "# HELP "+name+" ") {
			t.Fatalf("%s has no HELP line", name)
		}
	}
}
