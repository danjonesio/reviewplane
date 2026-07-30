// Package metrics is the gateway's counter set and its Prometheus text
// exposition.
//
// docs/ARCHITECTURE.md section 4.6 requires the gateway to record bytes,
// errors and route lifecycle, and docs/ARCHITECTURE.md section 15 requires
// every service to expose metrics. It is written here rather than taken from a
// client library because the exposition format is a few lines and the service
// otherwise has no third-party dependency (docs/SECURITY.md section 19).
//
// No metric carries a capability, a header value or any other credential.
// Route identifiers do appear as labels, but only for routes that are
// registered now: a route is short-lived, so keeping a series per route for
// ever would be an unbounded cardinality leak. Lifetime totals are label-free
// or labelled by a closed set.
package metrics

import (
	"sort"
	"strconv"
	"strings"
	"sync"
)

// Registry holds the gateway's counters and gauges.
type Registry struct {
	mu       sync.Mutex
	counters map[string]*counterVec
	gauges   map[string]*gaugeVec
	help     map[string]string
}

type counterVec struct {
	values map[string]float64
	labels map[string][]string
	name   string
}

type gaugeVec struct {
	values map[string]float64
	labels map[string][]string
	name   string
}

// New builds an empty registry with the gateway's metric documentation.
func New() *Registry {
	registry := &Registry{
		counters: map[string]*counterVec{},
		gauges:   map[string]*gaugeVec{},
		help: map[string]string{
			ConnectorChannels:     "Connector data channels terminated, by outcome.",
			ConnectorChannelsOpen: "Connector data channels open now.",
			RouteLifecycle:        "Published-service lifecycle transitions observed by the gateway.",
			RoutesActive:          "Routes registered now.",
			Streams:               "Tunnel streams, by outcome.",
			StreamsActive:         "Tunnel streams open now.",
			Upgrades:              "HTTP upgrade requests carried by the tunnel, by outcome.",
			UpgradesActive:        "Upgraded connections open now.",
			Bytes:                 "Tunnel bytes transferred, by direction.",
			Requests:              "Browser requests, by the stable code the gateway answered with.",
			Denials:               "Browser requests refused, by the stable reason recorded in the audit trail.",
			RouteBytes:            "Bytes transferred on each route registered now, by direction.",
			RouteStreams:          "Streams opened on each route registered now.",
		},
	}
	return registry
}

// Metric names. They are constants so that a dashboard and a test refer to the
// same string.
const (
	ConnectorChannels     = "reviewplane_tunnel_connector_channels_total"
	ConnectorChannelsOpen = "reviewplane_tunnel_connector_channels_open"
	RouteLifecycle        = "reviewplane_tunnel_route_lifecycle_total"
	RoutesActive          = "reviewplane_tunnel_routes_active"
	Streams               = "reviewplane_tunnel_streams_total"
	StreamsActive         = "reviewplane_tunnel_streams_active"
	Upgrades              = "reviewplane_tunnel_upgrades_total"
	UpgradesActive        = "reviewplane_tunnel_upgrades_open"
	Bytes                 = "reviewplane_tunnel_bytes_total"
	Requests              = "reviewplane_tunnel_requests_total"
	Denials               = "reviewplane_tunnel_denied_total"
	RouteBytes            = "reviewplane_tunnel_route_bytes"
	RouteStreams          = "reviewplane_tunnel_route_streams"
)

// Direction labels for byte counters.
const (
	DirectionToDestination   = "to_destination"
	DirectionFromDestination = "from_destination"
)

// Count adds one to a counter.
func (r *Registry) Count(name string, labels ...string) { r.Add(name, 1, labels...) }

// Add increases a counter.
func (r *Registry) Add(name string, delta float64, labels ...string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	vec, ok := r.counters[name]
	if !ok {
		vec = &counterVec{values: map[string]float64{}, labels: map[string][]string{}, name: name}
		r.counters[name] = vec
	}
	key := labelKey(labels)
	vec.values[key] += delta
	vec.labels[key] = labels
}

// SetGauge records the current value of a gauge.
func (r *Registry) SetGauge(name string, value float64, labels ...string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	vec, ok := r.gauges[name]
	if !ok {
		vec = &gaugeVec{values: map[string]float64{}, labels: map[string][]string{}, name: name}
		r.gauges[name] = vec
	}
	key := labelKey(labels)
	vec.values[key] = value
	vec.labels[key] = labels
}

// ClearGauge drops every series of a gauge, so that a per-route gauge does not
// keep reporting a route that no longer exists.
func (r *Registry) ClearGauge(name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.gauges, name)
}

// Value reads one counter or gauge series, for assertions.
func (r *Registry) Value(name string, labels ...string) float64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	key := labelKey(labels)
	if vec, ok := r.counters[name]; ok {
		return vec.values[key]
	}
	if vec, ok := r.gauges[name]; ok {
		return vec.values[key]
	}
	return 0
}

func labelKey(labels []string) string {
	if len(labels) == 0 {
		return ""
	}
	return strings.Join(labels, "\x00")
}

func renderLabels(labels []string) string {
	if len(labels) < 2 {
		return ""
	}
	pairs := make([]string, 0, len(labels)/2)
	for index := 0; index+1 < len(labels); index += 2 {
		pairs = append(pairs, labels[index]+"=\""+escapeLabelValue(labels[index+1])+"\"")
	}
	return "{" + strings.Join(pairs, ",") + "}"
}

func escapeLabelValue(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`)
	return replacer.Replace(value)
}

// Expose renders the registry in the Prometheus text exposition format.
func (r *Registry) Expose() string {
	r.mu.Lock()
	defer r.mu.Unlock()

	names := make([]string, 0, len(r.counters)+len(r.gauges))
	for name := range r.counters {
		names = append(names, name)
	}
	for name := range r.gauges {
		names = append(names, name)
	}
	sort.Strings(names)

	var out strings.Builder
	for _, name := range names {
		if help, ok := r.help[name]; ok {
			out.WriteString("# HELP " + name + " " + help + "\n")
		}
		if vec, ok := r.counters[name]; ok {
			out.WriteString("# TYPE " + name + " counter\n")
			writeSeries(&out, name, vec.values, vec.labels)
			continue
		}
		vec := r.gauges[name]
		out.WriteString("# TYPE " + name + " gauge\n")
		writeSeries(&out, name, vec.values, vec.labels)
	}
	return out.String()
}

func writeSeries(out *strings.Builder, name string, values map[string]float64, labels map[string][]string) {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		out.WriteString(name + renderLabels(labels[key]) + " " +
			strconv.FormatFloat(values[key], 'g', -1, 64) + "\n")
	}
}
