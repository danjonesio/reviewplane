package gatewayhttp

// Authority on the gateway control API.
//
// The control API used to take one bearer token, and any holder of it could do
// everything: register a route for any project, delete any connector, withdraw
// any capability, and list every route in the deployment across every
// organisation. docs/ARCHITECTURE.md section 4.4 and ADR-0021 both described
// the MCP process as one that "withdraws, and registers no route" — true of the
// code and not of the credential it held, which is the difference this file
// exists to remove (ADR-0038).
//
// A control credential therefore names three things:
//
//   - who it is, so that an audit record can say which process acted;
//   - what it may do, as a set of operations rather than as a role;
//   - which organisations it may act for, so that enumeration and revocation
//     carry a tenancy term.
//
// The set is configuration and not a signed token. Stage 0 runs one control
// plane, one gateway and one trust zone (docs/ARCHITECTURE.md section 13), the
// gateway already holds a shared symmetric key for capabilities, and a second
// signing scheme would add key custody and rotation to close nothing this does
// not. What matters is that authority is stated where it is enforced.

import (
	"crypto/subtle"
	"errors"
	"sort"
	"strings"

	"github.com/danjonesio/reviewplane/services/tunnel-gateway/internal/registry"
)

// ControlOperation names one thing a control credential may do. The set is
// closed: an operation the gateway does not know is a configuration error
// rather than something quietly ignored.
type ControlOperation string

const (
	// OperationRouteRegister admits a route to the gateway.
	OperationRouteRegister ControlOperation = "route:register"
	// OperationRouteRead reads or enumerates routes.
	OperationRouteRead ControlOperation = "route:read"
	// OperationRouteRevoke withdraws a route.
	OperationRouteRevoke ControlOperation = "route:revoke"
	// OperationConnectorRevoke withdraws a connector identity and its routes.
	OperationConnectorRevoke ControlOperation = "connector:revoke"
	// OperationCapabilityRevoke withdraws one route capability.
	OperationCapabilityRevoke ControlOperation = "capability:revoke"
	// OperationMetricsRead reads the gateway's metrics exposition.
	OperationMetricsRead ControlOperation = "metrics:read"
)

// ControlOperations is every operation the gateway defines, in a stable order.
func ControlOperations() []ControlOperation {
	return []ControlOperation{
		OperationRouteRegister, OperationRouteRead, OperationRouteRevoke,
		OperationConnectorRevoke, OperationCapabilityRevoke, OperationMetricsRead,
	}
}

// ParseControlOperation resolves a configured name.
func ParseControlOperation(name string) (ControlOperation, error) {
	candidate := ControlOperation(strings.TrimSpace(name))
	for _, known := range ControlOperations() {
		if candidate == known {
			return known, nil
		}
	}
	return "", errors.New("gatewayhttp: unknown control operation " + name)
}

// OrganisationWildcard is the configured spelling of "every organisation".
const OrganisationWildcard = "*"

// MinControlSecretLength is the shortest control secret the gateway accepts. A
// shorter one is a configuration error and not a weaker credential.
const MinControlSecretLength = 32

// ControlCredential is one named principal on the gateway control API.
type ControlCredential struct {
	// ID is the credential's name. It is not a secret, it appears in every
	// audit record the credential produces, and it is how an operator answers
	// "which process did this".
	ID string
	// Secret is the bearer value. It is compared in constant time and never
	// logged, echoed or used as a metric label.
	Secret string
	// Operations is what this credential may do. An empty set is refused: a
	// credential that may do nothing is a configuration mistake, not a control.
	Operations []ControlOperation
	// Organisations bounds the tenancy it may act for. Empty means every
	// organisation, which is what the deployment's own control plane holds.
	Organisations []string
}

// Scope is the credential's organisation bound as the registry reads it.
func (c ControlCredential) Scope() registry.OrganisationScope {
	return registry.OrganisationScope{Organisations: c.Organisations}
}

// Permits reports whether the credential may perform an operation.
func (c ControlCredential) Permits(operation ControlOperation) bool {
	for _, granted := range c.Operations {
		if granted == operation {
			return true
		}
	}
	return false
}

// Describe renders the credential's authority for a startup log line. It names
// the identifier, the operations and the tenancy, and never the secret.
func (c ControlCredential) Describe() string {
	operations := make([]string, 0, len(c.Operations))
	for _, operation := range c.Operations {
		operations = append(operations, string(operation))
	}
	sort.Strings(operations)
	organisations := OrganisationWildcard
	if len(c.Organisations) > 0 {
		organisations = strings.Join(c.Organisations, "+")
	}
	return c.ID + " [" + strings.Join(operations, " ") + "] " + organisations
}

// ControlCredentials is the configured set.
type ControlCredentials []ControlCredential

// Validate refuses a set the gateway must not run with.
func (set ControlCredentials) Validate() error {
	if len(set) == 0 {
		return errors.New("gatewayhttp: at least one control credential must be configured")
	}
	identifiers := map[string]struct{}{}
	secrets := map[string]struct{}{}
	for _, credential := range set {
		if strings.TrimSpace(credential.ID) == "" {
			return errors.New("gatewayhttp: every control credential must carry an identifier")
		}
		if _, taken := identifiers[credential.ID]; taken {
			return errors.New("gatewayhttp: two control credentials are named " + credential.ID)
		}
		identifiers[credential.ID] = struct{}{}
		if len(credential.Secret) < MinControlSecretLength {
			return errors.New("gatewayhttp: the control secret for " + credential.ID +
				" must be at least 32 characters")
		}
		if _, taken := secrets[credential.Secret]; taken {
			// Two principals sharing a secret is one principal with two names,
			// and it would make the audit trail's attribution a guess.
			return errors.New("gatewayhttp: two control credentials share a secret")
		}
		secrets[credential.Secret] = struct{}{}
		if len(credential.Operations) == 0 {
			return errors.New("gatewayhttp: the control credential " + credential.ID +
				" is granted no operation")
		}
		for _, operation := range credential.Operations {
			if _, err := ParseControlOperation(string(operation)); err != nil {
				return err
			}
		}
		for _, organisation := range credential.Organisations {
			if strings.TrimSpace(organisation) == "" {
				return errors.New("gatewayhttp: the control credential " + credential.ID +
					" names an empty organisation")
			}
		}
	}
	return nil
}

// Authenticate resolves a presented bearer secret to a credential.
//
// Every credential is compared, and the comparison is constant time, so neither
// the number of comparisons nor their duration depends on which credential
// matched or on how much of a secret was right.
func (set ControlCredentials) Authenticate(presented string) (ControlCredential, bool) {
	matched := -1
	for index := range set {
		if subtle.ConstantTimeCompare([]byte(presented), []byte(set[index].Secret)) == 1 {
			matched = index
		}
	}
	if matched < 0 {
		return ControlCredential{}, false
	}
	return set[matched], true
}
