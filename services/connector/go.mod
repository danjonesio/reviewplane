module github.com/danjonesio/reviewplane/services/connector

go 1.26.5

require (
	// The connector ships as a statically linked binary (docs/CONNECTOR_PROTOCOL.md
	// section 3) under the supply-chain rules of docs/SECURITY.md section 19, so it
	// depends on nothing outside the standard library and this repository. Wire
	// types come from packages/protocol; hand-maintaining an equivalent struct is a
	// review failure (ADR-0013).
	github.com/danjonesio/reviewplane/packages/protocol v0.0.0
	github.com/danjonesio/reviewplane/services/tunnel-gateway v0.0.0
)

// The workspace file go.work already resolves this module from the working
// tree. The replace directive repeats it so that the module also builds when it
// is used outside workspace mode.
replace github.com/danjonesio/reviewplane/packages/protocol => ../../packages/protocol
