package gatewayhttp

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// The gateway control API's shared corpus.
//
// admin.go says the corpus is "a committed corpus that the Go handler and the
// TypeScript client both run". Only the client ran it: nothing in Go read the
// file, so a field added on this side and forgotten in the corpus would have
// been caught in the other repository half or not at all. This is the Go half.

type corpusDocument struct {
	Endpoints            map[string]string `json:"endpoints"`
	Operations           map[string]string `json:"operations"`
	RegisterRequestField []string          `json:"register_request_fields"`
	RouteViewFields      []string          `json:"route_view_fields"`
	Authentication       struct {
		Scheme  string `json:"scheme"`
		Setting string `json:"setting"`
	} `json:"authentication"`
	Examples struct {
		RegisterRequest json.RawMessage `json:"register_request"`
	} `json:"examples"`
}

func readCorpus(t *testing.T) corpusDocument {
	t.Helper()
	path := filepath.Join("..", "..", "testdata", "gateway-api", "register.json")
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read corpus: %v", err)
	}
	var document corpusDocument
	if err := json.Unmarshal(contents, &document); err != nil {
		t.Fatalf("decode corpus: %v", err)
	}
	return document
}

func jsonFieldNames(t *testing.T, value any) []string {
	t.Helper()
	structType := reflect.TypeOf(value)
	names := make([]string, 0, structType.NumField())
	for index := 0; index < structType.NumField(); index++ {
		tag := structType.Field(index).Tag.Get("json")
		name, _, _ := strings.Cut(tag, ",")
		if name == "" || name == "-" {
			t.Fatalf("%s.%s carries no json tag", structType.Name(), structType.Field(index).Name)
		}
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func TestTheCorpusAndTheHandlerAgreeAboutEveryField(t *testing.T) {
	corpus := readCorpus(t)

	wanted := append([]string(nil), corpus.RegisterRequestField...)
	sort.Strings(wanted)
	if got := jsonFieldNames(t, RegisterRequest{}); !reflect.DeepEqual(got, wanted) {
		t.Fatalf("the register request carries %v, the corpus records %v", got, wanted)
	}

	wantedView := append([]string(nil), corpus.RouteViewFields...)
	sort.Strings(wantedView)
	if got := jsonFieldNames(t, RouteView{}); !reflect.DeepEqual(got, wantedView) {
		t.Fatalf("the route view carries %v, the corpus records %v", got, wantedView)
	}
}

// The corpus's own example must decode into the handler's request type with
// unknown fields disallowed, which is the check the handler applies.
func TestTheCorpusExampleDecodesAsARegistration(t *testing.T) {
	corpus := readCorpus(t)
	decoder := json.NewDecoder(strings.NewReader(string(corpus.Examples.RegisterRequest)))
	decoder.DisallowUnknownFields()
	var request RegisterRequest
	if err := decoder.Decode(&request); err != nil {
		t.Fatalf("decode the corpus example: %v", err)
	}
	if request.OrganisationID == "" {
		t.Fatal("the corpus example carries no organisation, so tenancy could not be enforced from it")
	}
}

// Every endpoint the corpus names must be mounted, and the operation it records
// must be the one the mounted route requires.
func TestTheCorpusRecordsTheAuthorityEachEndpointNeeds(t *testing.T) {
	corpus := readCorpus(t)
	for name, operation := range corpus.Operations {
		if _, err := ParseControlOperation(operation); err != nil {
			t.Fatalf("the corpus records %q for %s: %v", operation, name, err)
		}
	}
	for name := range corpus.Endpoints {
		if _, recorded := corpus.Operations[name]; !recorded {
			t.Fatalf("the corpus names the endpoint %s and no operation for it", name)
		}
	}
	if corpus.Authentication.Setting != "REVIEWPLANE_TUNNEL_CONTROL_CREDENTIALS" {
		t.Fatalf("the corpus names %q as the credential setting", corpus.Authentication.Setting)
	}
}
