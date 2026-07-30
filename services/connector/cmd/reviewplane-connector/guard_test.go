package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const modulePrefix = "github.com/danjonesio/reviewplane/services/connector"

// binaryPackages lists the repository packages the connector binary actually
// links, by asking the toolchain rather than by walking directories. Test-only
// helpers such as internal/controlplanetest are therefore excluded
// automatically: they are not in the binary.
func binaryPackages(t *testing.T) []string {
	t.Helper()
	command := exec.Command("go", "list", "-deps", ".")
	command.Dir = "."
	output, err := command.Output()
	if err != nil {
		t.Fatalf("go list -deps: %v", err)
	}
	var packages []string
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if strings.HasPrefix(line, modulePrefix) {
			packages = append(packages, line)
		}
	}
	if len(packages) < 5 {
		t.Fatalf("go list -deps reported only %d connector packages: %v", len(packages), packages)
	}
	return packages
}

// packageDirectory maps an import path in this module to its directory.
func packageDirectory(t *testing.T, importPath string) string {
	t.Helper()
	relative := strings.TrimPrefix(importPath, modulePrefix)
	relative = strings.TrimPrefix(relative, "/")
	if relative == "" {
		return "."
	}
	return filepath.Join("..", "..", relative)
}

func sourceFiles(t *testing.T, directory string) []string {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatalf("reading %s: %v", directory, err)
	}
	var files []string
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		files = append(files, filepath.Join(directory, name))
	}
	return files
}

// The connector must not open a listening socket for control or data purposes.
// That is the mechanism behind the Stage 0 exit criterion "No public inbound
// port is required on the development VM" (ADR-0002, docs/ROADMAP.md section 2),
// and the "ss -ltnp" evidence on the development VM is its observable form.
// This test is the same claim checked at build time, so a future change cannot
// reintroduce a listener without failing here.
func TestConnectorBinaryOpensNoListeningSocket(t *testing.T) {
	forbidden := []string{
		"net.Listen",
		"net.ListenTCP",
		"net.ListenUDP",
		"net.ListenIP",
		"net.ListenPacket",
		"net.ListenUnix",
		"net.ListenUnixgram",
		"net.ListenMulticastUDP",
		"tls.Listen",
		"tls.NewListener",
		"http.ListenAndServe",
		"http.ListenAndServeTLS",
		"http.Serve",
		"httptest.NewServer",
		"httptest.NewTLSServer",
		"ListenConfig",
	}
	for _, importPath := range binaryPackages(t) {
		directory := packageDirectory(t, importPath)
		for _, file := range sourceFiles(t, directory) {
			contents, err := os.ReadFile(file) // #nosec G304 -- repository source
			if err != nil {
				t.Fatalf("reading %s: %v", file, err)
			}
			for _, needle := range forbidden {
				if strings.Contains(string(contents), needle) {
					t.Fatalf("%s references %s; the connector must open no listening socket", file, needle)
				}
			}
		}
	}
}

// protocolTypeNames are the wire types generated from
// packages/protocol/schemas/connector/v1.schema.json. ADR-0013 and
// docs/DEVELOPMENT.md section 3 forbid a structurally equivalent type in a
// service, and this test is what makes the rule mechanical rather than a
// review habit.
var protocolTypeNames = map[string]bool{
	"Envelope":              true,
	"RegistrationRequest":   true,
	"RegistrationResponse":  true,
	"SignedIdentity":        true,
	"ControlPlaneEndpoints": true,
	"EnvironmentDescriptor": true,
	"ConnectorDescriptor":   true,
	"Heartbeat":             true,
	"ResourceSummary":       true,
	"RoutePublish":          true,
	"RoutePublishAck":       true,
	"DataStreamHeader":      true,
	"Frame":                 true,
}

func TestConnectorDeclaresNoWireTypes(t *testing.T) {
	fileSet := token.NewFileSet()
	for _, importPath := range binaryPackages(t) {
		directory := packageDirectory(t, importPath)
		for _, path := range sourceFiles(t, directory) {
			parsed, err := parser.ParseFile(fileSet, path, nil, 0)
			if err != nil {
				t.Fatalf("parsing %s: %v", path, err)
			}
			ast.Inspect(parsed, func(node ast.Node) bool {
				spec, ok := node.(*ast.TypeSpec)
				if !ok {
					return true
				}
				if _, isStruct := spec.Type.(*ast.StructType); !isStruct {
					return true
				}
				if protocolTypeNames[spec.Name.Name] {
					t.Fatalf("%s declares type %s, which packages/protocol already generates (ADR-0013)",
						path, spec.Name.Name)
				}
				return true
			})
		}
	}
}

// The wire path must go through the generated canonical encoder. Using
// encoding/json there would ship a redacted enrolment token, because
// connectorv1.SensitiveString.MarshalJSON returns the redacted form.
func TestWirePathDoesNotUseEncodingJSON(t *testing.T) {
	wirePackages := []string{
		modulePrefix + "/internal/protocolio",
		modulePrefix + "/internal/enrol",
		modulePrefix + "/internal/channel",
		modulePrefix + "/internal/transport",
	}
	fileSet := token.NewFileSet()
	for _, importPath := range wirePackages {
		directory := packageDirectory(t, importPath)
		for _, path := range sourceFiles(t, directory) {
			parsed, err := parser.ParseFile(fileSet, path, nil, parser.ImportsOnly)
			if err != nil {
				t.Fatalf("parsing %s: %v", path, err)
			}
			for _, spec := range parsed.Imports {
				if spec.Path.Value == `"encoding/json"` {
					t.Fatalf("%s imports encoding/json; wire frames must go through the generated canonical encoder", path)
				}
			}
		}
	}
}
