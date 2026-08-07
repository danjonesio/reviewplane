# `services/tunnel-gateway`

The tunnel gateway of `docs/ARCHITECTURE.md` §4.6. It terminates connector data
channels, registers published services, verifies session-scoped route
capabilities, and carries browser requests to the loopback destination fixed
when a route was published.

What it deliberately cannot do is act as a proxy for anything else. There is no
CONNECT handler, no SOCKS listener and no code path that reads a destination
from a request. `docs/SECURITY.md` §9 excludes those permanently, not until a
later release.

## Listeners

| Listener | Default | Published? | Purpose |
|---|---|---|---|
| Proxy | `0.0.0.0:8443` | Yes | Browser requests for `https://<alias>.internal.invalid/` |
| Connector | `0.0.0.0:8444` | To the development network | Connector data channels over mutual TLS |
| Control | `127.0.0.1:8445` | No | Control-plane API, `/metrics`, `/healthz` |

## The internal origin

A browser reaches a published service at:

```text
https://<public_alias>.internal.invalid/
```

The leftmost label is the published service's `public_alias`
(`docs/DOMAIN_MODEL.md` §10), **not** its `route_id`: a route identifier
conventionally carries an underscore and would not be a valid DNS label. The
mapping is total and injective by construction:

1. Any port is dropped, any trailing dot is dropped, the host is lowercased.
2. What remains must be exactly one label followed by the configured suffix.
3. The label must be a DNS label: `[a-z0-9-]`, 1 to 63 characters, not starting
   or ending with a hyphen. An alias that is not is refused **at registration**,
   so no request-time normalisation ever has to guess.

Anything else resolves to no route and is answered `PUBLISHED_SERVICE_UNAVAILABLE`.

## What the development service sees

Header handling is fixed in configuration, never per request
(`docs/CONNECTOR_PROTOCOL.md` §13).

- **Request target** is always origin-form. An absolute-form target or `CONNECT`
  is refused.
- **`Host`** is `host:port` of the upstream by default (`host_header_mode:
  upstream`), which satisfies a development server's DNS-rebinding protection.
  `original` sends the internal origin instead.
- **`Connection: close`**: one stream carries one exchange. That keeps response
  framing unambiguous and stops a stream being reused for a request the gateway
  never authorised.
- **Removed**: every hop-by-hop header, everything a `Connection` header
  nominates, every `X-ReviewPlane-*` header (including the capability), and
  every inbound forwarded header — `X-Forwarded-*`, `Forwarded`, `X-Real-IP`,
  `X-Original-URL`, `X-Rewrite-URL` and friends.
- **Added** (`forwarded_header_mode: standard`): `X-Forwarded-Proto: https` and
  `X-Forwarded-Host: <alias>.internal.invalid`. No `X-Forwarded-For`: the client
  is a browser worker inside the control-plane zone and its address is internal
  topology.

Response headers are filtered the same way, and any `X-ReviewPlane-*` header
from the development service is dropped so that it cannot forge gateway
metadata.

## Authorisation order

Every browser request runs these in order, an upgrade handshake exactly as any
other request. Nothing about a route is read before the origin resolves to one,
and nothing in a capability is trusted before it is authenticated.

| # | Check | Refusal |
|---|---|---|
| 0 | Route-confusion headers removed, before anything resolves a route | — |
| 1 | Not `CONNECT`; origin-form target | `UNSUPPORTED_CAPABILITY` |
| 2 | Exactly one `Host`, resolving to one alias | `PUBLISHED_SERVICE_UNAVAILABLE` |
| 3 | Exactly one capability header | `AUTHENTICATION_REQUIRED` |
| 4 | Capability signature verifies | `AUTHORISATION_DENIED` |
| 5 | Capability not expired | `ROUTE_EXPIRED` |
| 6 | Route registered and not past its expiry | `PUBLISHED_SERVICE_UNAVAILABLE` |
| 7 | Capability route, project and browser session match the route | `AUTHORISATION_DENIED` |
| 8 | Capability not individually revoked | `ROUTE_EXPIRED` |
| 9 | An upgrade, if any, is a well-formed `websocket` `GET` with no body | `UNSUPPORTED_CAPABILITY` |
| 10 | Connector has a live data channel | `CONNECTOR_OFFLINE` |
| 11 | Route and connector stream limits | `STREAM_LIMIT_EXCEEDED` |

Step 0 is ordering, not tidying: `docs/SECURITY.md` §9 names header-based route
confusion as an SSRF vector, and a header removed after a route had already been
chosen would have been removed from the wrong thing.

The code a caller receives is coarser than the reason recorded in the audit
trail: an unknown route, a route in another project and a capability naming
another session all answer the same way, because a caller that can tell them
apart has an enumeration oracle.

Expiry and revocation share `ROUTE_EXPIRED`. `docs/CONNECTOR_PROTOCOL.md` §21 is
a closed vocabulary and adding a class needs an ADR; which of the two occurred
is recorded in the audit trail and the metrics, not on the wire.

Check 10 also applies after the request has started. A connector whose data
channel drops mid-request ends every stream on it with a cause the request path
recognises, so the caller receives `CONNECTOR_OFFLINE` with 503 rather than a
generic upstream failure, and never a hang (`docs/MCP_SPEC.md` §12,
`docs/ARCHITECTURE.md` §14). The route stays registered: it is unavailable, not
gone, and it resumes when the connector reconnects and the control plane
re-authorises it (`docs/CONNECTOR_PROTOCOL.md` §17).

## Connector identity

The data channel is mutually authenticated TLS 1.3 with
`RequireAndVerifyClientCert` against the control plane's Stage 0 certificate
authority, whose root the gateway is given in configuration. The connector
identifier is derived from the **verified** chain, not from what the peer sent.

Where it is read from is configuration, because the issuing side is being built
separately:

- `identity_source: subject_common_name` (default) reads the subject common name.
- `identity_source: uri_san` reads a URI subject alternative name beginning with
  `identity_uri_prefix` (default `reviewplane:connector:`).

A connector may also send `X-ReviewPlane-Connector-Id` on the handshake. If it
does, it must equal the certificate-derived identifier; a mismatch is refused.

## Data channel

`datachannel` implements both halves of `docs/CONNECTOR_PROTOCOL.md` §12 and is
exported so that `services/connector` uses the same code rather than a second
implementation of the same mux.

Transport: one WebSocket (`wsx`, subprotocol
`reviewplane.connector.data.v1`) carrying binary messages, each one frame:

```text
byte 0     frame type
bytes 1-4  stream number, big endian
bytes 5..  payload
```

| Type | Payload | Sender |
|---|---|---|
| `open` | canonical `data_stream_header` (packages/protocol) | gateway |
| `accept` | empty | connector |
| `data` | application bytes | both |
| `end` | empty | both |
| `reset` | a §21 error class, or empty | both |
| `window` | `uint32` consumed bytes | both |

Flow control is credit-based per stream and per direction. The initial window is
256 KiB and a receiver returns credit only once bytes have actually been
consumed, so a slow HTTP client stops the connector's writer instead of filling
a queue. A receiver that is sent more than its window refuses the frame and ends
the session: honouring it would be the unbounded buffering the window exists to
prevent.

Every stream carries an absolute deadline, the earlier of the configured maximum
stream lifetime and the route's expiry. A stream past its deadline, or idle
beyond its idle timeout, is reset and counted. The absolute lifetime is a
backstop whose default equals `ROUTE_TTL_MAX`, so what normally bounds a stream
is its route; the idle timeout is what closes a stalled or abandoned one.

The stream header declares a mode. `request_response` is one bounded HTTP
exchange; `upgrade` is a connection this gateway has switched to another
framing, and it takes the longer idle window of `docs/CONNECTOR_PROTOCOL.md`
§13.3. The connector relays bytes without parsing them, so it cannot see that a
connection was switched — the mode is declared rather than inferred, and it
selects the idle window and nothing else.

Both ends sweep. The gateway enforces deadlines on the streams it opened and the
connector on the streams it accepted, so a data channel that dies mid-stream
does not leave the development machine holding sockets nothing will close.

## Upgrades and streaming

`websocket` is the one upgrade token carried. `h2c` is refused because HTTP/2 is
deferred, and any other token is refused because relaying a framing the gateway
has never seen would be the raw forwarding `docs/SECURITY.md` §9 excludes. An
upgrade must present both an `Upgrade` header and a `Connection` header
nominating it, must be a `GET`, and must carry no body; anything else is
`UNSUPPORTED_CAPABILITY`.

The handshake runs the authorisation order below unchanged — an upgrade is not a
bypass — and is re-serialised with the same header rules as any other request.
`Sec-WebSocket-Key` reaches the development service untouched, so the browser
validates `Sec-WebSocket-Accept` against the development service rather than
against the gateway; the gateway computes nothing. A development service that
answers anything but `101` has refused the upgrade, and its own response is
delivered unchanged.

After `101` the gateway hijacks the browser connection and relays bytes both
ways with one bounded buffer per direction. Closure propagates each way, route
expiry and revocation close the connection, and the connection's deadline is the
route's expiry: a persistent WebSocket is not a way to hold access open.

Streamed responses — `text/event-stream`, chunked, or anything else produced
incrementally — are flushed to the browser as they arrive. No hop accumulates a
response, and a `Content-Length` is emitted only when the development service
declared one.

## Configuration

Every setting is `REVIEWPLANE_TUNNEL_`-prefixed and validated at startup
(`docs/CONFIGURATION.md` §1). Secrets accept a `_FILE` form (§7).

| Setting | Default | Notes |
|---|---|---|
| `LISTEN_ADDRESS` | `0.0.0.0:8443` | Browser-facing |
| `CONNECTOR_LISTEN_ADDRESS` | `0.0.0.0:8444` | Mutual TLS |
| `ADMIN_LISTEN_ADDRESS` | `127.0.0.1:8445` | Control API and metrics |
| `INTERNAL_SUFFIX` | `internal.invalid` | |
| `HOST_HEADER_MODE` | `upstream` | or `original` |
| `FORWARDED_HEADER_MODE` | `standard` | or `none` |
| `ALLOWED_HOSTS` | `127.0.0.1,::1` | Literal addresses only |
| `ALLOWED_PORTS` | `3000-3999,4321,5173` | |
| `ALLOWED_PROTOCOLS` | `http` | |
| `ALLOW_NON_LOOPBACK_DESTINATIONS` | `false` | High-risk; warns at startup |
| `ALLOW_LINK_LOCAL_DESTINATIONS` | `false` | High-risk; warns at startup |
| `ROUTE_TTL_MAX` | `8h` | |
| `MAX_ROUTES_PER_CONNECTOR` | `10` | |
| `MAX_STREAMS_PER_CONNECTOR` | `256` | |
| `MAX_STREAMS_PER_ROUTE` | `64` | |
| `MAX_STREAM_BYTES` | `67108864` | |
| `STREAM_MAX_LIFETIME` | `8h` | Absolute bound; always clipped to the route's expiry |
| `STREAM_IDLE_TIMEOUT` | `60s` | No progress on a request/response stream |
| `UPGRADE_IDLE_TIMEOUT` | `15m` | No progress on an upgraded connection |
| `RELAY_BUFFER_BYTES` | `32768` | Per direction of an upgraded connection |
| `MAX_REQUEST_BODY_BYTES` | `8388608` | |
| `MAX_DATA_CHANNEL_MESSAGE_BYTES` | `65536` | |
| `SWEEP_INTERVAL` | `5s` | Expiry and deadline enforcement |
| `CONTROL_CREDENTIALS`(`_FILE`) | — | Required, a JSON array of `{id, secret, operations, organisations}` |
| `CAPABILITY_KEYS`(`_FILE`) | — | Required, `key-id:base64[,…]` |
| `REVOCATION_JOURNAL_PATH` | `/var/lib/reviewplane/tunnel/revocations.jsonl` | Where withdrawals are kept; must be writable |
| `CONNECTOR_CA_FILE` | — | Required, PEM roots |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | — | Required |
| `IDENTITY_SOURCE` | `subject_common_name` | or `uri_san` |
| `IDENTITY_URI_PREFIX` | `reviewplane:connector:` | |
| `LOG_LEVEL`, `LOG_FORMAT` | `info`, `json` | |

Neither high-risk setting lifts the bar on cloud metadata endpoints: those are
refused whatever the allow-list says.

## Control API

Served on the control listener only, and authorised as well as unpublished. A
caller presents a named control credential from `CONTROL_CREDENTIALS`; the secret
is compared in constant time and never logged, and the credential's identifier
appears in every audit record it produces. Each route names the operation it
requires, and an operation the credential does not carry is
`AUTHORISATION_DENIED` (ADR-0038).

```text
PUT    /internal/v1/routes/{routeId}          route:register
GET    /internal/v1/routes                    route:read
GET    /internal/v1/routes/{routeId}          route:read
DELETE /internal/v1/routes/{routeId}          route:revoke
DELETE /internal/v1/connectors/{connectorId}  connector:revoke
DELETE /internal/v1/capabilities/{capabilityId}  capability:revoke
GET    /metrics                               metrics:read
GET    /healthz  /readyz                      (unauthenticated)
```

A registration carries `organisation_id`. A credential bounded to organisations
may register only into them, enumerates only them, and finds a route outside
them **absent** rather than refused — `docs/API.md` §5 requires a foreign
identifier and an unknown one to be indistinguishable. A credential naming no
organisation acts for all of them, which is what the deployment's own control
plane holds.

## Revocation

The gateway keeps one thing across a restart: what it has revoked. Everything
else it holds is a working copy of a record the control plane owns, and losing it
means it carries nothing; losing a withdrawal means it carries something it was
told to stop carrying.

Revoking a route records the **instant**, and a capability whose signed
`issued_at` is at or before it is refused. That is what makes registering the
same route identifier again — which `docs/DOMAIN_MODEL.md` §10 requires to stay
possible after a connector reconnects — resurrect nothing. Revoking a capability
records it by identity, which is the narrower case.

Withdrawals are appended to `REVOCATION_JOURNAL_PATH` and flushed **before** the
route is removed, and reloaded when the gateway starts. A withdrawal that cannot
be written is answered `503` and not performed: the route keeps carrying traffic
and the caller may retry, which is honest, where a revocation reported as done
and not kept is a closure a restart silently reopens.

It is not yet generated from `packages/protocol`: `docs/DEVELOPMENT.md` §3 says
API schemas belong there, and the generator is built for the connector protocol
only. Until the issue that brings API schemas into the package lands, the Go
handler and the TypeScript client are held together by
`testdata/gateway-api/`, a committed corpus both run.

## Observability

Metrics are exposed in Prometheus text format. Lifetime totals are label-free or
labelled by a closed set; per-route series exist only while the route does,
because a route is short-lived and a permanent series per route would be an
unbounded cardinality leak.

```text
reviewplane_tunnel_connector_channels_total{outcome}
reviewplane_tunnel_connector_channels_open
reviewplane_tunnel_route_lifecycle_total{transition}
reviewplane_tunnel_routes_active
reviewplane_tunnel_streams_total{outcome}
reviewplane_tunnel_streams_active
reviewplane_tunnel_upgrades_total{outcome}
reviewplane_tunnel_upgrades_open
reviewplane_tunnel_bytes_total{direction}
reviewplane_tunnel_requests_total{code}
reviewplane_tunnel_denied_total{reason}
reviewplane_tunnel_route_bytes{route_id,direction}
reviewplane_tunnel_route_streams{route_id,state}
reviewplane_tunnel_control_actions_total{outcome}
reviewplane_tunnel_revocations{subject}
```

`reviewplane_tunnel_revocations` is the size of the withdrawal set. It is worth
watching across a restart: a gateway that came up having forgotten what it
revoked reports zero, which is visible rather than silent.

Route lifecycle is also emitted as structured audit records using the
`docs/EVENTS.md` §7 names — `published_service.ready`, `.failed`, `.expired`,
`.revoked` — and retained in a bounded ring, alongside `tunnel.control_action`,
which names the credential behind every call on the control API. That name is
gateway-local: `docs/EVENTS.md` §7 is the control plane's durable project event
vocabulary, and this is neither durable nor project-scoped. The durable event
rows belong to the control plane, which owns the database and the project event
sequence; giving the gateway a database connection would put the most exposed
component inside the control plane's persistence boundary.

No log line, metric label or audit payload carries a capability, a cookie, an
authorisation header or a control credential's secret. There is a test for it.
A credential's **identifier** appears in every record it produces, because that
is the attribution an operator needs and it is not secret.

## Building and testing

```bash
go build ./...
go test ./...
go test -race ./...
go vet ./...
```

The tests need no network and no container: they stand up a real mutually
authenticated TLS listener, a real WebSocket data channel and a real connector
serving a real loopback development server, all in process.
