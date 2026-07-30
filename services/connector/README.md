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

## Not implemented at this stage

Workspace discovery and Git context (so `workspaces[].id` is configured rather
than discovered), the local MCP bridge, local notifications, self-update, and
systemd unit packaging. WebSockets, server-sent events, HTTP streaming and hot
reload over a route belong to the issue that owns tunnel compatibility.
