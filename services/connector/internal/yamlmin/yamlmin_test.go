package yamlmin

import (
	"strings"
	"testing"
)

func TestParseDocumentedConfiguration(t *testing.T) {
	// The example from docs/CONNECTOR_PROTOCOL.md section 20, verbatim.
	source := `control_plane:
  url: https://agents.example.internal

identity:
  data_dir: /var/lib/reviewplane-connector

workspaces:
  - path: /home/dan/projects/refresh-surplus
    project: refresh-surplus

publication:
  allowed_hosts:
    - 127.0.0.1
    - ::1
  allowed_ports:
    - 3000-3999
    - 4321
    - 5173
  max_routes: 10

privacy:
  report_changed_paths: true
  report_process_details: false
  discover_workspaces: false

logging:
  level: info
  format: json
`
	root, err := Parse([]byte(source))
	if err != nil {
		t.Fatalf("parsing the documented configuration: %v", err)
	}

	url, err := root.Child("control_plane").Child("url").String("control_plane.url")
	if err != nil {
		t.Fatalf("reading control_plane.url: %v", err)
	}
	if url != "https://agents.example.internal" {
		t.Fatalf("control_plane.url = %q", url)
	}

	workspaces, err := root.Child("workspaces").Sequence("workspaces")
	if err != nil {
		t.Fatalf("reading workspaces: %v", err)
	}
	if len(workspaces) != 1 {
		t.Fatalf("workspaces has %d entries, want 1", len(workspaces))
	}
	project, err := workspaces[0].Child("project").String("workspaces[0].project")
	if err != nil {
		t.Fatalf("reading workspaces[0].project: %v", err)
	}
	if project != "refresh-surplus" {
		t.Fatalf("workspaces[0].project = %q", project)
	}

	ports, err := root.Child("publication").Child("allowed_ports").StringSlice("publication.allowed_ports")
	if err != nil {
		t.Fatalf("reading publication.allowed_ports: %v", err)
	}
	if len(ports) != 3 || ports[0] != "3000-3999" || ports[2] != "5173" {
		t.Fatalf("publication.allowed_ports = %v", ports)
	}

	details, err := root.Child("privacy").Child("report_process_details").Bool("privacy.report_process_details")
	if err != nil {
		t.Fatalf("reading privacy.report_process_details: %v", err)
	}
	if details {
		t.Fatal("privacy.report_process_details parsed as true")
	}
}

func TestParseScalarForms(t *testing.T) {
	root, err := Parse([]byte(`plain: value # trailing comment
quoted: "a: b # not a comment"
single: 'it''s fine'
escaped: "line\nbreak"
empty:
flow: [one, two, "three, four"]
emptyflow: []
`))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	cases := map[string]string{
		"plain":   "value",
		"quoted":  "a: b # not a comment",
		"single":  "it's fine",
		"escaped": "line\nbreak",
	}
	for key, want := range cases {
		got, err := root.Child(key).String(key)
		if err != nil {
			t.Fatalf("reading %s: %v", key, err)
		}
		if got != want {
			t.Fatalf("%s = %q, want %q", key, got, want)
		}
	}
	if node := root.Child("empty"); node == nil || !node.Null {
		t.Fatal("empty should parse as a null scalar")
	}
	flow, err := root.Child("flow").StringSlice("flow")
	if err != nil {
		t.Fatalf("reading flow: %v", err)
	}
	if len(flow) != 3 || flow[2] != "three, four" {
		t.Fatalf("flow = %v", flow)
	}
	empty, err := root.Child("emptyflow").StringSlice("emptyflow")
	if err != nil {
		t.Fatalf("reading emptyflow: %v", err)
	}
	if len(empty) != 0 {
		t.Fatalf("emptyflow = %v", empty)
	}
}

func TestParseRefusesUnsupportedConstructs(t *testing.T) {
	cases := []struct {
		name    string
		source  string
		wantsub string
	}{
		{"tab indentation", "root:\n\tkey: value\n", "tabs"},
		{"odd indentation", "root:\n   key: value\n", "multiple of two"},
		{"duplicate key", "key: one\nkey: two\n", "duplicate key"},
		{"anchor", "key: &anchor value\n", "anchors"},
		{"alias", "key: *anchor\n", "anchors"},
		{"flow mapping", "key: {a: b}\n", "flow mappings"},
		{"multi-line scalar", "key: |\n  text\n", "multi-line"},
		{"missing colon", "just a line\n", "expected"},
		{"unterminated quote", "key: \"open\n", "unterminated"},
		{"second document", "a: 1\n---\nb: 2\n", "multiple documents"},
		{"unclosed flow", "key: [a, b\n", "not closed"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			_, err := Parse([]byte(test.source))
			if err == nil {
				t.Fatal("expected a refusal")
			}
			if !strings.Contains(err.Error(), test.wantsub) {
				t.Fatalf("error %q does not mention %q", err, test.wantsub)
			}
		})
	}
}

func TestParseReportsLineNumbers(t *testing.T) {
	_, err := Parse([]byte("first: 1\n\n# comment\nsecond: {bad}\n"))
	if err == nil {
		t.Fatal("expected a refusal")
	}
	if !strings.HasPrefix(err.Error(), "line 4:") {
		t.Fatalf("error %q does not start at line 4", err)
	}
}

func TestRejectUnknownKeys(t *testing.T) {
	root, err := Parse([]byte("known: 1\nsurprise: 2\n"))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	err = root.RejectUnknownKeys("configuration", "known")
	if err == nil {
		t.Fatal("expected an unknown-setting refusal")
	}
	if !strings.Contains(err.Error(), "unknown setting configuration.surprise") {
		t.Fatalf("error %q does not name the unknown setting", err)
	}
}

func TestParseBoundsInputSize(t *testing.T) {
	_, err := Parse(make([]byte, MaxInputBytes+1))
	if err == nil || !strings.Contains(err.Error(), "byte bound") {
		t.Fatalf("oversized input error = %v", err)
	}
}
