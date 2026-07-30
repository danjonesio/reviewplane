package hostinfo

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestEnvironmentNameIsNeverEmpty(t *testing.T) {
	if EnvironmentName() == "" {
		t.Fatal("EnvironmentName returned an empty string")
	}
}

func TestPlatformAndArchitecture(t *testing.T) {
	if Platform() != runtime.GOOS {
		t.Fatalf("Platform = %q", Platform())
	}
	if Architecture() != runtime.GOARCH {
		t.Fatalf("Architecture = %q", Architecture())
	}
}

// docs/CONNECTOR_PROTOCOL.md section 8 bounds the resource summary to load and
// available memory, and the schema bounds load to [0, 1024].
func TestReadResourcesStaysInsideTheSchemaBounds(t *testing.T) {
	directory := t.TempDir()
	loadPath := filepath.Join(directory, "loadavg")
	memoryPath := filepath.Join(directory, "meminfo")
	if err := os.WriteFile(loadPath, []byte("1.23 0.98 0.77 2/512 4242\n"), 0o600); err != nil {
		t.Fatalf("writing loadavg fixture: %v", err)
	}
	if err := os.WriteFile(memoryPath, []byte("MemTotal:       16000000 kB\nMemAvailable:    8007812 kB\n"), 0o600); err != nil {
		t.Fatalf("writing meminfo fixture: %v", err)
	}
	restore := swapSources(loadPath, memoryPath)
	defer restore()

	resources := ReadResources()
	if resources.Load == nil {
		t.Fatal("load was not reported")
	}
	if *resources.Load < 0 || *resources.Load > 1024 {
		t.Fatalf("load %v is outside the schema bounds", *resources.Load)
	}
	if resources.MemoryAvailableBytes == nil {
		t.Fatal("available memory was not reported")
	}
	if want := int64(8007812) * 1024; *resources.MemoryAvailableBytes != want {
		t.Fatalf("available memory = %d, want %d", *resources.MemoryAvailableBytes, want)
	}
}

func TestReadResourcesOmitsUnreadableValues(t *testing.T) {
	restore := swapSources(filepath.Join(t.TempDir(), "absent"), filepath.Join(t.TempDir(), "absent"))
	defer restore()

	resources := ReadResources()
	if resources.Load != nil || resources.MemoryAvailableBytes != nil {
		t.Fatalf("unreadable sources produced %+v", resources)
	}
}

func TestReadResourcesRefusesMalformedInput(t *testing.T) {
	directory := t.TempDir()
	loadPath := filepath.Join(directory, "loadavg")
	memoryPath := filepath.Join(directory, "meminfo")
	if err := os.WriteFile(loadPath, []byte("not-a-number rest\n"), 0o600); err != nil {
		t.Fatalf("writing loadavg fixture: %v", err)
	}
	if err := os.WriteFile(memoryPath, []byte("MemAvailable: nonsense kB\n"), 0o600); err != nil {
		t.Fatalf("writing meminfo fixture: %v", err)
	}
	restore := swapSources(loadPath, memoryPath)
	defer restore()

	resources := ReadResources()
	if resources.Load != nil || resources.MemoryAvailableBytes != nil {
		t.Fatalf("malformed sources produced %+v", resources)
	}
}

func swapSources(load, memory string) func() {
	previousLoad, previousMemory := loadAverageSource, memoryInfoSource
	loadAverageSource, memoryInfoSource = load, memory
	return func() { loadAverageSource, memoryInfoSource = previousLoad, previousMemory }
}
