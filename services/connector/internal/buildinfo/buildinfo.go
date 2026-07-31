// Package buildinfo carries the connector's own release identity.
package buildinfo

import connectorv1 "github.com/danjonesio/reviewplane/packages/protocol/connectorv1"

// Version is the connector release version reported in the registration request
// and in every heartbeat (docs/CONNECTOR_PROTOCOL.md sections 4.3 and 8). It
// must satisfy the schema's semantic_version definition.
const Version = "0.1.0"

// Name is the machine identifier of the binary. docs/PRODUCT.md fixes the
// machine identifier as reviewplane, independent of any display name.
const Name = "reviewplane-connector"

// UserAgent identifies the connector on the enrolment and control connections.
const UserAgent = Name + "/" + Version

// Capabilities are the capabilities advertised in the registration request and
// restated in the section 17 reconnect claim. docs/CONNECTOR_PROTOCOL.md
// section 4.3 fixes the version 1 vocabulary; a capability is advertised only
// when this build actually implements it, because the control plane decides
// what to ask of a connector from this list.
//
// What each means in this build:
//
//   - http-tunnel and websocket-tunnel: a published route carries HTTP requests
//     and upgraded connections to a loopback development service (sections 12
//     and 13).
//   - git-context: the connector observes the branch, head commit, dirty state
//     and normalised remote identity of its explicitly configured workspaces
//     and reports them as workspace.observed (section 9). It does not include
//     workspace discovery, which is still refused by configuration, and it
//     never reports a file's contents or a changed-path list.
//   - local-mcp-bridge: the command surface of section 14 exists —
//     "reviewplane-connector mcp" resolves the local workspace and project and
//     reports its state. The short-lived agent-session credential exchange it
//     will proxy is a separate issue (RVP-49), and until that lands the command
//     refuses rather than pretending: advertising the capability describes the
//     command, not a credential path.
var Capabilities = []connectorv1.ConnectorCapability{
	"http-tunnel",
	"websocket-tunnel",
	"git-context",
	"local-mcp-bridge",
}
