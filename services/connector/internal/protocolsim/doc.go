// Package protocolsim is the protocol-simulation harness of
// docs/DEVELOPMENT.md section 4: it stands up the whole Stage 0 tunnel — a
// control plane, a tunnel gateway, a real connector and a loopback development
// service — in one process, and severs the channels deterministically, without
// launching a browser.
//
// It exists because a distributed protocol that has never been interrupted in a
// test has not been tested. The three-part assertion of RVP-18 needs a request
// before an interruption, a request during it and a request after it, all
// against a route whose destination is known; a browser adds nothing to that and
// makes it slow and flaky.
//
// It is test support, not part of the connector binary. The no-listening-socket
// guard in cmd/reviewplane-connector walks the binary's own dependency graph, so
// a package only the tests import is excluded automatically.
package protocolsim
