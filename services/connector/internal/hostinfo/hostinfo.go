// Package hostinfo reports the bounded, non-sensitive facts about the
// development environment that the connector is allowed to send.
//
// docs/CONNECTOR_PROTOCOL.md section 2 rules out the connector acting as a
// general process-management agent, and section 8 limits the heartbeat resource
// summary to load and available memory. Nothing here reads process detail,
// command lines, environment variables or repository contents.
package hostinfo

import (
	"os"
	"runtime"
	"strconv"
	"strings"
)

// EnvironmentName is the default operator-visible environment name: the host
// name, which is what docs/CONNECTOR_PROTOCOL.md section 4.3 shows
// ("dev-ai-03").
func EnvironmentName() string {
	name, err := os.Hostname()
	if err != nil || strings.TrimSpace(name) == "" {
		return "unknown-environment"
	}
	return name
}

// Platform is the operating system, matching the known values of the protocol
// schema's x-protocol.known_platforms.
func Platform() string { return runtime.GOOS }

// Architecture is the CPU architecture, matching x-protocol.known_architectures.
func Architecture() string { return runtime.GOARCH }

// Resources is the coarse report permitted by
// docs/CONNECTOR_PROTOCOL.md section 8. A field is nil when it cannot be read
// on this platform.
type Resources struct {
	Load                 *float64
	MemoryAvailableBytes *int64
}

// ReadResources reads the two permitted values. It never fails: a value
// that cannot be read is simply absent, because a heartbeat is more useful than
// an error.
func ReadResources() Resources {
	summary := Resources{}
	if load, ok := readNormalisedLoad(); ok {
		summary.Load = &load
	}
	if available, ok := readAvailableMemoryBytes(); ok {
		summary.MemoryAvailableBytes = &available
	}
	return summary
}

// loadAverageSource and memoryInfoSource are variables so that tests can point
// them at fixtures instead of the live procfs.
var (
	loadAverageSource = "/proc/loadavg"
	memoryInfoSource  = "/proc/meminfo"
)

// readNormalisedLoad reports the one-minute load average divided by the CPU
// count, which is the "normalised system load average" the schema bounds to
// [0, 1024].
func readNormalisedLoad() (float64, bool) {
	data, err := os.ReadFile(loadAverageSource)
	if err != nil {
		return 0, false
	}
	fields := strings.Fields(string(data))
	if len(fields) == 0 {
		return 0, false
	}
	one, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || one < 0 {
		return 0, false
	}
	cpus := runtime.NumCPU()
	if cpus < 1 {
		cpus = 1
	}
	normalised := one / float64(cpus)
	if normalised > 1024 {
		normalised = 1024
	}
	// Two decimal places keeps the heartbeat payload small and stable; the
	// schema bounds the payload to 1024 bytes.
	rounded, err := strconv.ParseFloat(strconv.FormatFloat(normalised, 'f', 2, 64), 64)
	if err != nil {
		return 0, false
	}
	return rounded, true
}

// readAvailableMemoryBytes reports MemAvailable, the kernel's own estimate of
// memory available to new work.
func readAvailableMemoryBytes() (int64, bool) {
	data, err := os.ReadFile(memoryInfoSource)
	if err != nil {
		return 0, false
	}
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "MemAvailable:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return 0, false
		}
		kilobytes, err := strconv.ParseInt(fields[1], 10, 64)
		if err != nil || kilobytes < 0 || kilobytes > (1<<53)/1024 {
			return 0, false
		}
		return kilobytes * 1024, true
	}
	return 0, false
}
