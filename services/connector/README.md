# `reviewplane-connector`

The ReviewPlane development-environment connector: a statically linked Go binary
that enrols a development VM or workstation with the control plane and then
holds one outbound, mutually authenticated channel open.

`docs/CONNECTOR_PROTOCOL.md` is normative. This file covers only how to build
and run what is here.

## What it is not

A remote shell, a VPN, a filesystem synchronisation service, a source-code
uploader, a general process-management agent or an unrestricted proxy
(`docs/CONNECTOR_PROTOCOL.md` §2). It uploads no repository contents.

**It opens no listening socket.** That is the mechanism behind the Stage 0 exit
criterion "No public inbound port is required on the development VM" (ADR-0002),
and it is directly verifiable:

```bash
ss -ltnp    # before and after enrolment: no new listener
```

A test walks the binary's own dependency graph and fails if any linked package
references a listen call, so the property cannot regress silently.

## Build

```bash
cd services/connector
go build ./cmd/reviewplane-connector
go test ./...
go vet ./...
```

There are no third-party dependencies. Wire types come from
`packages/protocol` (ADR-0013); the RFC 6455 client and the small YAML subset
the configuration file uses are implemented here rather than taken from a
dependency, each bounded and each refusing what it cannot enforce.

## Enrol

An administrator issues a one-time token
(`POST /api/v1/connectors/enrolment-tokens`), then:

```bash
sudo reviewplane-connector enrol \
  --control-plane https://agents.example.internal \
  --token <one-time-token>
```

The token may also be supplied by `--token-file` or the
`REVIEWPLANE_ENROLMENT_TOKEN` environment variable, either of which keeps it out
of the process table and shell history. Exactly one form must be used.

Enrolment generates an ECDSA P-256 key pair locally and sends only the public
half. The private key is written owner-only to `<data_dir>/device.key` and never
leaves the environment.

Useful flags: `--data-dir`, `--ca-file` (an additional trust anchor for the
control plane's server certificate), `--environment-name`, `--labels`,
`--max-attempts`, and `--force` to re-enrol with a new identity.

## Run

```bash
reviewplane-connector run
```

Holds the control channel open, sends a heartbeat every 15 seconds by default,
and reconnects with jittered bounded backoff. It refuses to start when the
private key is readable by anyone but its owner.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success, or a clean shutdown on SIGINT or SIGTERM |
| 1 | A failure that may resolve on its own, such as `CONTROL_PLANE_UNAVAILABLE` |
| 2 | A malformed command line or invalid configuration |
| 3 | A refusal an operator must act on: `ENROLMENT_TOKEN_INVALID`, `IDENTITY_REVOKED`, `PROTOCOL_UNSUPPORTED`, `UPGRADE_REQUIRED`, or a private key with permissions that are too wide |

## Configuration

`/etc/reviewplane-connector/config.yaml` by default; see
`docs/CONNECTOR_PROTOCOL.md` §20 for the full example and the supported YAML
subset. Every setting is validated at startup and an unknown setting is an
error, not a value that is quietly ignored.

## Route publication

A `route.publish` on the control channel is validated against this connector's
own configuration and answered on the same channel
(`docs/CONNECTOR_PROTOCOL.md` §11). The checks are the connector's, not a
restatement of the control plane's: project authorisation, workspace
association, the destination allow-list, a bounded startup grace on the
destination port, the expiry bound and the concurrent-route limit. A refusal
carries a stable class from §21 and no free text.

The destination policy and the stream multiplexer are imported from
`services/tunnel-gateway` (`policy` and `datachannel`) rather than
reimplemented. Both ends of the data channel must agree exactly on framing, on
the 256 KiB initial window and on which side may open a stream, and all three
components must agree on which destinations are allowed; one implementation
held to one corpus is how that is kept true.

Streams are served over a second outbound connection to the tunnel gateway,
supervised beside the control channel so that one peer restarting does not take
the other's connection down. Nothing listens: the only socket the connector
opens towards a service is the loopback dial to the destination fixed at
publication.

## Reconnect and reconciliation

The route table is in memory, so a restarted connector holds nothing, and a
connector that has been disconnected may hold routes the control plane has since
closed. Both are settled the same way (`docs/CONNECTOR_PROTOCOL.md` §17,
ADR-0018): on **every** established control channel, before anything else, the
connector withdraws every route from service, sends
`connector.reconnect.request` describing what it withdrew, and serves again only
what the control plane's `connector.reconnect.response` continues.

The ordering is the safety property. Between the request and the answer the
connector serves nothing, so a response that names no route, an answer that
never arrives, and a control plane that refuses the build all leave the same
state: no route carrying traffic that nobody has re-authorised. The wait is
bounded; on timeout the connector says so, drops the channel and retries under
the backoff below.

A continued route is restated in full by the control plane, so it resumes under
the same `route_id` against the same destination with no second publication
exchange — which is what makes a development VM reboot cost a pause rather than
a manual re-publication. The connector still runs its own §11 validation on that
restatement, because being told to serve something is not the same as being
allowed to.

Reconnect delays are jittered and bounded (`reconnect` in the configuration).
The attempt counter that grows the delay bounds consecutive failures, not the
connector's lifetime: a channel that stayed up longer than `max_delay` ends the
incident, while a channel accepted and immediately dropped does not, so a
flapping peer is still backed off from.

`services/connector/internal/protocolsim` is the protocol-simulation harness for
all of this (`docs/DEVELOPMENT.md` §4): a control plane, the gateway role of the
data channel, this connector and two loopback development services in one
process, with the channels severed deterministically and no browser involved.

## The local MCP bridge

`reviewplane-connector mcp` is the local stdio bridge of
`docs/CONNECTOR_PROTOCOL.md` §14. It resolves the workspace and project for the
working directory, exchanges this connector's device identity for a short-lived
agent credential bound to that one project (ADR-0023), reports newly assigned
work as a local notification (§16), and then proxies newline-delimited JSON-RPC
between the agent's stdin and stdout and the control plane's `/mcp/v1` endpoint.

No agent token is written to disk. It lives in the bridge process's memory for
the life of the command; a restart requests a fresh one.

stdout carries JSON-RPC and nothing else. Diagnostics and notifications go to
stderr — journald under the shipped unit — and, with `--status-file`, to a file
written 0600 and replaced atomically. `--describe` prints what was resolved and
exits without proxying, which is the form to run by hand.

## Not implemented at this stage

Workspace discovery beyond configured paths (so `workspaces[].id` is configured
rather than discovered), agent-session **re-establishment** across a reconnect
(so `known_agent_sessions` is sent empty), desktop notifications, self-update —
an `upgrade_required` classification is reported and the connector stops. The
systemd unit under `packaging/systemd/` is shipped but is not installed by any
packaging step. WebSockets, server-sent
events, HTTP streaming and hot reload over a route belong to the issue that owns
tunnel compatibility.
