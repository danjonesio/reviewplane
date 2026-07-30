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

Every browser request runs these in order. Nothing about a route is read before
the origin resolves to one, and nothing in a capability is trusted before it is
authenticated.

| # | Check | Refusal |
|---|---|---|
| 1 | Not `CONNECT`; origin-form target | `UNSUPPORTED_CAPABILITY` |
| 2 | Exactly one `Host`, resolving to one alias | `PUBLISHED_SERVICE_UNAVAILABLE` |
| 3 | Exactly one capability header | `AUTHENTICATION_REQUIRED` |
| 4 | Capability signature verifies | `AUTHORISATION_DENIED` |
| 5 | Capability not expired | `ROUTE_EXPIRED` |
| 6 | Route registered and not past its expiry | `PUBLISHED_SERVICE_UNAVAILABLE` |
| 7 | Capability route, project and browser session match the route | `AUTHORISATION_DENIED` |
| 8 | Capability not individually revoked | `ROUTE_EXPIRED` |
| 9 | Not an HTTP upgrade (a later issue owns those) | `UNSUPPORTED_CAPABILITY` |
| 10 | Connector has a live data channel | `CONNECTOR_OFFLINE` |
| 11 | Route and connector stream limits | `STREAM_LIMIT_EXCEEDED` |

The code a caller receives is coarser than the reason recorded in the audit
trail: an unknown route, a route in another project and a capability naming
another session all answer the same way, because a caller that can tell them
apart has an enumeration oracle.

Expiry and revocation share `ROUTE_EXPIRED`. `docs/CONNECTOR_PROTOCOL.md` §21 is
a closed vocabulary and adding a class needs an ADR; which of the two occurred
is recorded in the audit trail and the metrics, not on the wire.

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

Transport: one WebSocket (`internal/wsx`, subprotocol
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

Every stream carries an absolute deadline, the earlier of the configured stream
lifetime and the route's expiry. A stream past its deadline, or idle beyond the
idle timeout, is reset and counted.

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
| `STREAM_TTL` | `60s` | |
| `STREAM_IDLE_TIMEOUT` | `60s` | |
| `MAX_REQUEST_BODY_BYTES` | `8388608` | |
| `MAX_DATA_CHANNEL_MESSAGE_BYTES` | `65536` | |
| `SWEEP_INTERVAL` | `5s` | Expiry and deadline enforcement |
| `ADMIN_TOKEN`(`_FILE`) | — | Required, at least 32 characters |
| `CAPABILITY_KEYS`(`_FILE`) | — | Required, `key-id:base64[,…]` |
| `CONNECTOR_CA_FILE` | — | Required, PEM roots |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | — | Required |
| `IDENTITY_SOURCE` | `subject_common_name` | or `uri_san` |
| `IDENTITY_URI_PREFIX` | `reviewplane:connector:` | |
| `LOG_LEVEL`, `LOG_FORMAT` | `info`, `json` | |

Neither high-risk setting lifts the bar on cloud metadata endpoints: those are
refused whatever the allow-list says.

## Control API

Bearer-authenticated with `ADMIN_TOKEN`, compared in constant time and never
logged. Served on the control listener only.

```text
PUT    /internal/v1/routes/{routeId}
GET    /internal/v1/routes
GET    /internal/v1/routes/{routeId}
DELETE /internal/v1/routes/{routeId}
DELETE /internal/v1/connectors/{connectorId}
DELETE /internal/v1/capabilities/{capabilityId}
GET    /metrics
GET    /healthz  /readyz          (unauthenticated)
```

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
reviewplane_tunnel_bytes_total{direction}
reviewplane_tunnel_requests_total{code}
reviewplane_tunnel_denied_total{reason}
reviewplane_tunnel_route_bytes{route_id,direction}
reviewplane_tunnel_route_streams{route_id,state}
```

Route lifecycle is also emitted as structured audit records using the
`docs/EVENTS.md` §7 names — `published_service.ready`, `.failed`, `.expired`,
`.revoked` — and retained in a bounded ring. The durable event rows belong to
the control plane, which owns the database and the project event sequence;
giving the gateway a database connection would put the most exposed component
inside the control plane's persistence boundary.

No log line, metric label or audit payload carries a capability, a cookie, an
authorisation header or the control-plane token. There is a test for it.

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
