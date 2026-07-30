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

// Capabilities are the Stage 0 capabilities advertised in the registration
// request. docs/CONNECTOR_PROTOCOL.md section 4.3 shows the full version 1 set;
// this build advertises only the tunnel capabilities, because Git context and
// the local MCP bridge are later stages.
var Capabilities = []connectorv1.ConnectorCapability{"http-tunnel", "websocket-tunnel"}
