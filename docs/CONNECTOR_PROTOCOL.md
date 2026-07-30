# Connector Protocol

## 1. Purpose

The connector links development environments to the control plane without exposing inbound management ports. It publishes selected local development services, reports bounded project context and provides local identity for agent sessions.

The machine-readable definition of this protocol is `packages/protocol/schemas/connector/v1.schema.json`. TypeScript and Go models, validators and canonical encoders are generated from it (ADR-0013). Where this document and that schema describe the same field, the schema is the implementable form; a change to one MUST be made in the other in the same change. No service may hand-maintain an equivalent type.

## 2. Non-goals

The connector is not:

- A remote shell
- A general VPN
- A filesystem synchronisation service
- A source-code uploader
- A general process-management agent
- An unrestricted proxy

Any future expansion into these areas requires an ADR and explicit security review.

## 3. Packaging

Preferred form:

- Statically linked Go binary
- systemd service on Linux
- Launch daemon or service equivalent on other platforms later
- Container option for advanced users

Default paths:

```text
/usr/local/bin/reviewplane-connector
/etc/reviewplane-connector/config.yaml
/var/lib/reviewplane-connector/
/var/log/reviewplane-connector/ or journald
```

## 4. Identity and enrolment

### 4.1 Enrolment token

Created by an administrator with:

- Organisation scope
- Optional project scope
- Expiry
- Maximum uses, default one
- Optional environment labels

Stage 0 status: the connector is built and run from source (`services/connector`). systemd unit packaging, signed release artefacts and multi-platform builds are deferred.

### 4.2 Key generation

The connector generates a key pair locally. The private key never leaves the environment.

The key is an ECDSA key on P-256, stored PKCS#8 PEM-encoded at `<identity.data_dir>/device.key`. The connector MUST write it with owner-only permissions and MUST validate those permissions on every start, not only at enrolment; it MUST refuse to start when the file is readable or writable by group or other, or is owned by another account (`DEVELOPMENT.md` §10, `SECURITY.md` §6.2). The control plane accepts a device key on P-256 or P-384 and refuses any other key type or curve rather than certifying a key it cannot classify.

Enrolment interrupted after key generation and before identity issuance is safe to retry: the connector reuses the existing key, because the control plane never saw it and no identity was orphaned. Re-enrolment (`--force`) generates a new key pair, because it creates a new connector identity (§18).

### 4.3 Registration request

```json
{
  "protocol_version": 1,
  "enrolment_token": "redacted",
  "public_key": "...",
  "environment": {
    "name": "dev-ai-03",
    "platform": "linux",
    "architecture": "amd64",
    "labels": ["proxmox", "development"]
  },
  "connector": {
    "version": "0.1.0",
    "capabilities": [
      "http-tunnel",
      "websocket-tunnel",
      "git-context",
      "local-mcp-bridge"
    ]
  }
}
```

`protocol_version` is carried by the message envelope of §7 and is not repeated inside the payload. The envelope's `connector_id` MUST be absent on the registration exchange, because the identity is still being established.

The enrolment token is a credential. It is marked sensitive in the schema, and generated models redact it in every default log, debug and JSON representation; only the canonical wire encoder reveals it (`SECURITY.md` §18).

The response provides connector ID, signed identity, control-plane endpoints and organisation policy digest:

```json
{
  "connector_id": "con_...",
  "signed_identity": {
    "certificate": "...",
    "certificate_fingerprint": "sha256:...",
    "expires_at": "2027-07-28T10:59:13Z"
  },
  "control_plane_endpoints": {
    "control_url": "wss://agents.example.internal/connector/control",
    "data_url": "wss://agents.example.internal/connector/data"
  },
  "policy_digest": "sha256:..."
}
```

Endpoints MUST use the `wss` scheme; a plaintext endpoint is refused by the schema.

The registration exchange is carried on the `control` channel, over a WebSocket the connector opens to the control plane's enrolment endpoint, by default `wss://<control-plane>/connector/v1/enrol`. That endpoint requires no client certificate — the identity is what enrolment establishes — and the enrolment token is the only credential presented on it. The connector MUST refuse a plaintext control-plane URL rather than downgrade, because the token would otherwise travel unencrypted (`SECURITY.md` §15).

## 5. Transport

Initial transport:

- Outbound TLS connection
- Mutual authentication after enrolment
- WebSocket-based control and multiplexed data streams
- Application-level stream identifiers
- Heartbeats and reconnect support

A future HTTP/2 or QUIC transport may replace the stream layer without changing published-service semantics.

### 5.1 Signed device identity

The signed identity of §4.3 is an X.509 client certificate issued by a control-plane certificate authority (ADR-0014). The authority is generated once at bootstrap and persisted server-side; its private key never leaves the control plane and is returned by no API.

The certificate binds the connector's locally generated public key to its connector ID:

- subject `CN=<connector_id>, O=ReviewPlane`
- `basicConstraints` critical, `cA` false
- `keyUsage` critical, `digitalSignature`
- `extKeyUsage` `clientAuth`
- `notAfter` equal to `signed_identity.expires_at`

`signed_identity.certificate` carries the base64 DER certificate and `signed_identity.certificate_fingerprint` its `sha256:<hex>` digest, which is the value recorded on the connector record (`DOMAIN_MODEL.md` §8) and the key by which a verified peer certificate is resolved to a connector.

### 5.2 Channel endpoints and verification

Post-enrolment channels are the `control_url` and `data_url` of the registration response, by default `wss://<control-plane>/connector/v1/control` and `.../connector/v1/data`.

A verifier — the control plane on the control channel, the tunnel gateway on the data channel — MUST:

1. require a client certificate whose chain verifies against the control-plane certificate authority;
2. compute the sha256 fingerprint of the presented leaf certificate;
3. resolve it to a connector record, and refuse when no record matches or the record is revoked.

An unauthenticated connection and a connection presenting a certificate from another authority are both refused before any frame is exchanged.

Stage 0 terminates the connector channels on a dedicated mutually authenticated listener owned by the control-plane server, rather than behind the shared gateway of `ARCHITECTURE.md` §4.1, because the human API does not request client certificates and the two authentication models must not share a listener. The topology may change without changing this protocol.

### 5.3 Refusal signalling

Version 1 defines no error message type. A control plane refuses a connector by closing the WebSocket with code 1008 and a reason equal to a §21 error class. A connector MUST treat `ENROLMENT_TOKEN_INVALID`, `IDENTITY_REVOKED`, `PROTOCOL_UNSUPPORTED` and `UPGRADE_REQUIRED` as terminal: it reports the class and stops, and MUST NOT retry with the refused credential (§18). Any other close is a transport event, and the reconnect behaviour of §17 applies.

A frame that is oversized, malformed or schema-invalid is refused with the close code that matches its reason — 1009 for a bound violation, 1008 for an unknown version or type, 1007 otherwise — and ends the connection rather than being skipped.

## 6. Channels

Logical channels:

```text
control     commands, acknowledgements, policy and registration
heartbeat   health and capacity
routes      published-service lifecycle
data        multiplexed route traffic
events      local project and agent-session observations
upgrade     version and compatibility notices
```

Version 1 defines these message types, each bound to one channel:

| Type | Channel | Direction |
|---|---|---|
| `connector.registration.request` | `control` | connector to control plane |
| `connector.registration.response` | `control` | control plane to connector |
| `heartbeat` | `heartbeat` | connector to control plane |
| `route.publish` | `routes` | control plane to connector |
| `route.publish.ack` | `routes` | connector to control plane |

The data-stream header of §12 travels on the `data` channel and is not carried in a control envelope. The `events` and `upgrade` channels are reserved at version 1: no message type is defined for them yet.

## 7. Message envelope

```json
{
  "protocol_version": 1,
  "message_id": "msg_...",
  "type": "route.publish.ack",
  "sent_at": "2026-07-28T11:00:00Z",
  "connector_id": "con_...",
  "correlation_id": "cmd_...",
  "payload": {}
}
```

Messages must have bounded size. Large payloads are not transferred through the control channel.

`message_id`, `connector_id` and `correlation_id` are opaque identifiers (`DOMAIN_MODEL.md` §3). Their conventional prefixes are documentation: implementations MUST bound length and character class only, and MUST NOT require a prefix.

`connector_id` MUST be absent on `connector.registration.request` and `connector.registration.response`, and MUST be present on every other message type. `correlation_id` is optional and identifies the message or command being answered.

### Bounds

Version 1 bounds, all enforced by the schema:

| Bound | Value |
|---|---|
| Control-channel frame | 65 536 bytes |
| Data-stream header | 4 096 bytes |
| `connector.registration.request` payload | 4 096 bytes |
| `connector.registration.response` payload | 8 192 bytes |
| `heartbeat` payload | 1 024 bytes |
| `route.publish` payload | 2 048 bytes |
| `route.publish.ack` payload | 1 024 bytes |

Every string, array and numeric field additionally carries its own explicit bound in the schema. The frame bound MUST be applied to the raw bytes before deserialisation; the payload bound is measured on the canonical encoding.

### Rejection

A receiver MUST refuse, never best-effort parse:

| Condition | Result |
|---|---|
| Frame exceeds its byte bound | Refused before deserialisation |
| Frame is not well-formed JSON, is truncated, or carries trailing data | Refused |
| `protocol_version` absent or not an accepted version | Refused with error class `PROTOCOL_UNSUPPORTED` |
| `type` absent or not a version 1 message type | Refused with error class `PROTOCOL_UNSUPPORTED` |
| Envelope or payload fails its schema, including any unknown property | Refused |
| Payload exceeds the bound for its type | Refused |

Unknown message types are rejected rather than ignored. Refusals report a stable reason; only the two conditions above carry a §21 wire error class.

## 8. Heartbeats

Default interval: configurable, approximately 15 seconds.

Payload:

```json
{
  "status": "healthy",
  "uptime_seconds": 8132,
  "version": "0.1.0",
  "active_routes": 2,
  "active_streams": 5,
  "resource_summary": {
    "load": 0.42,
    "memory_available_bytes": 8200000000
  }
}
```

`status` is the connector's self-report and is one of `healthy` or `degraded`; delayed and disconnected are conclusions the control plane draws, not values a connector sends.

Resource reporting is optional and must avoid sensitive process details. The `resource_summary` object permits only `load` and `memory_available_bytes`; any other property is refused, so process detail cannot ride along.

State guidance:

- Missing a small number of heartbeats: delayed
- Exceeding disconnect threshold: disconnected
- Reconnection with valid identity: resume and reconcile

The thresholds are the control plane's, not the connector's: `DEGRADED` and `DISCONNECTED` are conclusions drawn from silence, so a connector cannot report them about itself. Stage 0 defaults are a 15-second heartbeat interval, `ACTIVE` to `DEGRADED` after 45 seconds of silence, and `DEGRADED` to `DISCONNECTED` after 90 seconds; all three are configurable. A heartbeat arriving in either degraded state returns the connector to `ACTIVE`. Every transition produces an event (`EVENTS.md` §7), so a connector that goes quiet leaves an audit trail rather than merely ceasing to appear.

The connector also sends a WebSocket ping alongside each heartbeat and bounds its own read wait, so that a control plane with nothing to say still proves the channel is alive.

## 9. Workspace discovery

Discovery modes:

1. Explicit configured paths
2. Agent-session supplied working directory
3. Optional bounded root scanning

Default should be explicit paths or agent-supplied context. Broad filesystem scanning is disabled.

Reported data:

- Normalised repository remote identity
- Branch
- HEAD commit
- Dirty status
- Changed file paths where policy permits
- Workspace display label

Source file contents are not reported by default.

## 10. Development-service detection

The connector may detect listening development services through:

- Explicit agent request
- Configured command and port
- Process-owned listening socket correlation where permitted
- Framework output adapter later

Detection is advisory. Publication requires an explicit command or project policy.

## 11. Route publication

### Request from control plane

```json
{
  "route_id": "svc_...",
  "project_id": "prj_...",
  "workspace_id": "wsp_...",
  "local_host": "127.0.0.1",
  "local_port": 4321,
  "protocol": "http",
  "expires_at": "2026-07-28T12:00:00Z",
  "allowed_browser_session_ids": ["brs_..."]
}
```

### Connector validation

The connector must confirm:

- Project is authorised
- Workspace association is valid
- Local destination matches policy
- Port is listening or may become available within bounded startup grace
- Expiry is acceptable
- Concurrent-route limit is not exceeded

### Acknowledgement

```json
{
  "route_id": "svc_...",
  "status": "ready",
  "observed_destination": "127.0.0.1:4321"
}
```

`status` is `ready` or `rejected`. A `ready` acknowledgement carries `observed_destination` and no error class. A `rejected` acknowledgement carries an `error_class` from §21 and no destination, and carries no free-text message: stable error codes are used instead (`SECURITY.md` §18).

`allowed_browser_session_ids` must name at least one browser session. A route with no authorised session is not published.

The startup grace exists because agents commonly publish before the development server has finished booting. It is bounded — 10 seconds by default — and it ends in `PORT_NOT_LISTENING`, never in an indefinite wait. A destination that begins listening inside the grace is accepted. Each of the checks above has one class: `PROJECT_NOT_AUTHORISED`, `WORKSPACE_NOT_FOUND`, `DESTINATION_NOT_ALLOWED`, `PORT_NOT_LISTENING`, `ROUTE_EXPIRED` and `ROUTE_LIMIT_EXCEEDED` respectively, and the control plane passes that class through to its caller unchanged (`API.md` §10).

The control plane's wait for an acknowledgement is bounded too. A connector holding no control channel is `CONNECTOR_OFFLINE` before anything is sent; a connector that holds one and never answers is `CONTROL_PLANE_UNAVAILABLE` when the wait expires. Neither leaves a published service in `requested` for ever.

The same checks are applied independently by the control plane before it publishes and by the tunnel gateway before it registers a route. Three implementations of one policy is the defence in depth `SECURITY.md` §9 requires: a control plane that had been persuaded to publish an unauthorised destination must still be refused by the gateway, and a gateway that had been misconfigured must still be refused by the connector. They are held to one shared corpus so that they cannot drift apart.

## 12. Data stream protocol

Each tunnelled connection is opened by a bounded header carrying exactly:

- Route ID
- Browser session ID
- Session capability
- Stream ID
- Destination protocol
- Deadline

The connector opens only the pre-authorised local destination. It does not accept a host or port supplied by the browser request. The header schema has no host or port field and rejects unknown properties, so a destination cannot be smuggled into it. The connector MUST NOT parse a destination out of the relayed request bytes either: the gateway never forwards a client-supplied destination and the connector independently ignores one, so neither side relies on the other.

The session capability is a bearer credential. It is marked sensitive in the schema and is redacted in every default log, debug and JSON representation. Its wire encoding is defined by `packages/protocol` (see that package's README, "Route capabilities"): the control plane mints, the gateway verifies, and verification checks the signature before it reads any claim.

### 12.1 Multiplexing

The data channel is one WebSocket connection carrying binary messages, each one frame:

```text
byte 0     frame type
bytes 1-4  stream number, big endian, never zero
bytes 5..  payload
```

| Type | Value | Payload | Sender |
|---|---|---|---|
| `open` | 1 | Canonical encoding of the data-stream header | Control plane |
| `accept` | 2 | Empty | Connector |
| `data` | 3 | Application bytes | Both |
| `end` | 4 | Empty; the sender's direction is complete | Both |
| `reset` | 5 | A §21 error class, or empty | Both |
| `window` | 6 | `uint32` bytes the receiver has consumed | Both |

Only the control-plane side opens a stream: a connector that could open one would be initiating traffic into the control-plane zone, which the trust boundary of `SECURITY.md` §3 does not allow.

A frame type this version does not define, a stream number of zero, a `reset` carrying anything but a §21 class, or a payload outside its bound MUST be refused and MUST end the channel. After a malformed frame the stream numbering can no longer be trusted, so best-effort recovery would be guessing.

### 12.2 Flow control

Flow control must prevent one stream from exhausting connector memory. Each direction of each stream starts with a credit window of 262 144 bytes. A sender MUST NOT have more unacknowledged bytes in flight than its remaining credit, and a receiver returns credit through a `window` frame only once the bytes have been consumed by the application, not when they arrive. That is what turns a slow consumer into backpressure rather than into buffering. A receiver sent more than its window MUST refuse the frame rather than honour it.

Both ends use the same initial window, because a sender may spend it before any credit has been returned.

### 12.3 Deadlines and limits

Every stream carries an absolute deadline. A stream past its deadline, or one that has made no progress for the configured idle timeout, MUST be closed and recorded rather than left open. A stream MUST NOT outlive the route it belongs to: its deadline is the earlier of the configured stream lifetime and the route's expiry.

Concurrent streams per channel, bytes per stream and the size of one data-channel message are all bounded. Exceeding a stream bound resets that stream with `STREAM_LIMIT_EXCEEDED`. Exceeding the message bound ends the channel, because the bound is applied to the declared length before anything is allocated.

Route expiry and revocation both terminate streams that are already in flight, and both report `ROUTE_EXPIRED`. §21 is a closed vocabulary, so which of the two occurred is recorded in the audit trail and the metrics rather than on the wire.

## 13. Header handling, WebSocket and hot-reload support

### 13.1 Header rewriting

Header rewriting is deterministic and is configured once, not decided per request. Every rule below is applied by the tunnel gateway; the connector relays the bytes it is given and parses none of them, so no header can change which socket the connector opens (§12).

The browser sees `https://<public_alias>.internal.invalid/`. The development service believes it is serving `127.0.0.1:<port>`. Those two facts are irreconcilable in general, so the deployment chooses which one the application is told.

**`Host`** is replaced, never forwarded. `REVIEWPLANE_TUNNEL_HOST_HEADER_MODE` selects:

| Mode | `Host` the development service receives | Use it when |
|---|---|---|
| `upstream` (default) | the observed destination, for example `127.0.0.1:5173` | the development server has host or DNS-rebinding protection that accepts loopback and refuses an unfamiliar name. Vite and Next.js both do. |
| `original` | `<public_alias>.internal.invalid` | the application generates absolute URLs from `Host` and must generate ones the browser can resolve. |

The client's own `Host` is dropped before the request is forwarded, because it is the value the gateway resolved the route from and must not also be an instruction to the far end.

**`Origin`** is forwarded unchanged. Chromium sets it from the internal origin, so a development service that checks it sees `https://<public_alias>.internal.invalid`. An application enforcing a same-origin or CSRF check against a configured origin MUST be configured with that value; the gateway MUST NOT rewrite it, because rewriting it would defeat the check it exists for.

**Forwarded headers** are set by the gateway according to `REVIEWPLANE_TUNNEL_FORWARDED_HEADER_MODE`:

| Mode | Added |
|---|---|
| `standard` (default) | `X-Forwarded-Proto: https` and `X-Forwarded-Host: <public_alias>.internal.invalid` |
| `none` | nothing |

No `X-Forwarded-For` is ever added. The client is a browser worker inside the control-plane zone, and its address is internal topology the development service has no use for.

**Headers the gateway removes unconditionally**, whatever the mode:

- the hop-by-hop headers of RFC 9110 §7.6.1, plus anything a `Connection` header nominates;
- `Content-Length`, which the gateway recomputes;
- the route-confusion set — `X-Forwarded-Host`, `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Port`, `X-Forwarded-Server`, `Forwarded`, `X-Real-IP`, `X-Original-Host`, `X-Original-URL`, `X-Rewrite-URL`, `X-HTTP-Host-Override`, `Host-Override` — so that a caller cannot persuade either the gateway or the development service that the request was for a different origin;
- everything in the `X-ReviewPlane-` namespace, which is how the session capability is carried and why it never reaches the development service.

A header value containing CR, LF or NUL is dropped rather than escaped.

### 13.1.1 Observed behaviour

The end-to-end scenario (`deploy/compose/e2e/run.sh`) records what the development service actually received, in `evidence/header-behaviour.txt` and `evidence/network-summary.txt`. With the default modes, twenty requests through the route — one document, three sub-resources, repeated across four pages — produced:

| Header | Value the development service received |
|---|---|
| `Host` | `127.0.0.1:4321`, on every request |
| `X-Forwarded-Host` | `svc-<alias>.internal.invalid`, on every request |
| `X-Forwarded-Proto` | `https`, on every request |
| `X-Forwarded-For` | absent |

Zero requests answered `>= 400`. The development service is told it is itself, which is what satisfies its own host check; the internal origin reaches it only through `X-Forwarded-Host`.

### 13.2 Absolute URLs emitted by the development service

An absolute URL in a response body that names `localhost`, `127.0.0.1` or the development port is an expected failure mode and MUST NOT be repaired by rewriting response bodies. The browser resolves it against nothing the route can reach, so the sub-resource fails; body rewriting would mean parsing untrusted content in the request path and would break any application that emits an absolute URL for a legitimate reason.

The supported repairs are, in order of preference: emit root-relative URLs; configure the application's public base URL to the internal origin; or set the `Host` mode to `original` so the application derives the right base itself. `examples/dev-fixture` serves a page that exhibits the failure so that it can be recognised rather than guessed at.

Observed: the end-to-end scenario navigates to that page and records the outcome in `evidence/absolute-url-finding.txt`. The document loads — `200`, correct title — and the stylesheet it names by absolute URL never reaches the development service at all. It does not appear in that service's request log, because the browser resolves `http://127.0.0.1:4321/` against the browser container rather than the development machine, and the session's egress policy refuses every origin but its own before the request leaves. The failure is therefore silent in the page and visible in the evidence, which is exactly why the fixture serves the case.

### 13.3 Upgrades and streaming

The route layer must preserve:

- HTTP upgrade
- Bidirectional frames
- Connection closure semantics
- Idle timeout suitable for hot reload
- Origin and forwarded headers according to the modes above

The Stage 0 gateway refuses an HTTP upgrade with `UNSUPPORTED_CAPABILITY`; WebSockets, server-sent events, HTTP streaming and hot reload arrive with the issue that owns them.

## 14. Local MCP bridge

The connector may expose a local stdio command:

```bash
reviewplane-connector mcp
```

Responsibilities:

- Resolve local workspace and project
- Request short-lived agent-session credentials
- Proxy MCP traffic to the control plane
- Avoid storing long-lived agent tokens
- Surface connection and project errors clearly

It must not grant the agent connector-administrator privileges.

## 15. Agent-session association

Association methods, in priority order:

1. Local MCP bridge creates the session
2. Explicit CLI wrapper supplies process and workspace identity
3. User selects an active session in the UI
4. Heuristic process association, only as an optional degraded mode

The connector should not scrape terminal contents by default.

## 16. Local notifications

Supported initial notification:

```text
[ReviewPlane] New review assigned: bugs-on-homepage (3 findings, high priority)
```

Delivery may be through:

- Journald/log
- Desktop notification when available
- Optional terminal status file or shell hook

The connector must not inject text into an active terminal or pseudo-terminal in the initial release.

## 17. Reconnection and reconciliation

On reconnect, the connector sends:

- Connector version and capabilities
- Active local routes
- Active streams
- Known agent sessions
- Workspace head state

The control plane responds with authoritative desired state:

- Continue route
- Revoke route
- Re-establish session
- Upgrade required

Unknown or expired routes are closed.

## 18. Revocation

Revoking a connector:

- Invalidates its identity
- Closes control and data channels
- Revokes active routes
- Marks associated sessions disconnected
- Produces audit events

Re-enrolment creates a new connector identity.

## 19. Upgrades

The connector reports version and protocol range. The control plane classifies:

- Compatible
- Upgrade recommended
- Upgrade required
- Blocked as unsupported

Automatic self-update is deferred. Signed packages and explicit administrator action are preferred initially.

## 20. Configuration example

```yaml
control_plane:
  url: https://agents.example.internal
  # Optional. Defaults to /connector/v1/enrol.
  enrolment_path: /connector/v1/enrol
  tls:
    # Optional additional trust anchor for the control-plane server
    # certificate. Absent means the system trust store.
    ca_file: /etc/reviewplane-connector/control-plane-ca.pem

identity:
  data_dir: /var/lib/reviewplane-connector

heartbeat:
  interval: 15s

reconnect:
  initial_delay: 1s
  max_delay: 60s
  factor: 2
  jitter: 0.3
  # 0 means unbounded, which is the default for the long-running channel.
  max_attempts: 0

environment:
  # Defaults to the host name.
  name: dev-ai-03
  labels: [proxmox, development]

workspaces:
  # id is the workspace identifier a publication names. Workspace discovery is
  # Stage 1 (section 9), so until it lands the identifier is configured, and a
  # publication naming an unknown workspace is refused with WORKSPACE_NOT_FOUND.
  - id: wsp_refresh_surplus
    path: /home/dan/projects/refresh-surplus
    project: refresh-surplus

publication:
  allowed_hosts:
    - 127.0.0.1
    - ::1
  allowed_ports:
    - 3000-3999
    - 4321
    - 5173
  max_routes: 10
  # Optional. Defaults to the projects named in the workspaces block, so an
  # operator who has declared their workspaces does not declare them twice.
  allowed_projects:
    - refresh-surplus

privacy:
  report_changed_paths: true
  report_process_details: false
  discover_workspaces: false

logging:
  level: info
  format: json
```

Configuration MUST be validated at startup and every failure MUST name the setting and the line it was read from (`DEVELOPMENT.md` §6). An unknown setting is an error, never a value that is silently ignored (`CONFIGURATION.md` §1).

The connector accepts a deliberately small YAML subset — comments, block mappings, block and flow sequences, and plain or quoted scalars — and refuses anything outside it, including tabs for indentation, anchors, aliases, tags, multi-line scalars, flow mappings and multiple documents. That keeps the statically linked binary of §3 free of a YAML dependency and keeps the parser bounded.

Two settings are refused rather than accepted at Stage 0, because no configuration of this build can honour them: `privacy.report_process_details: true`, since §8 permits only `load` and `memory_available_bytes` in a heartbeat, and `privacy.discover_workspaces: true`, since workspace discovery (§9) is not implemented.

The `publication` block is enforced. An omitted `allowed_hosts` or `allowed_ports` means the Stage 0 default of `SECURITY.md` §9 — loopback only, on the development-server ports above — never "everything"; a configuration file that omits a setting MUST NOT be the widest one. A host name is refused at load rather than resolved at publication, because resolving one is a rebinding surface: the name that passed the check need not be the address the connector later opens.

The `enrol` command reads its one-time token from `--token`, `--token-file` or `REVIEWPLANE_ENROLMENT_TOKEN`, exactly one of which must be supplied. A file or environment variable keeps the credential out of the process table and shell history.

## 21. Errors

Stable connector error classes. This list is the complete wire vocabulary; adding a class is a protocol change requiring an ADR. It is generated into both languages from `packages/protocol`, which fails to build if the two lists disagree.

- `ENROLMENT_TOKEN_INVALID`
- `IDENTITY_REVOKED`
- `PROTOCOL_UNSUPPORTED`
- `PROJECT_NOT_AUTHORISED`
- `WORKSPACE_NOT_FOUND`
- `DESTINATION_NOT_ALLOWED`
- `PORT_NOT_LISTENING`
- `ROUTE_LIMIT_EXCEEDED`
- `ROUTE_EXPIRED`
- `STREAM_LIMIT_EXCEEDED`
- `CONTROL_PLANE_UNAVAILABLE`
- `UPGRADE_REQUIRED`

These classes describe authorisation, identity and lifecycle outcomes. A frame that is oversized, malformed or schema-invalid is refused with a local reason and no wire error class, except for an unknown `protocol_version` or `type`, which report `PROTOCOL_UNSUPPORTED` (§7 "Rejection").

On the wire a class is carried by a WebSocket close reason (§5.3), not by a message: version 1 defines no error message type, and adding one would be a protocol change. `CONTROL_PLANE_UNAVAILABLE` is the connector's own classification of a control plane it cannot reach, and is reported locally rather than received.

## 22. Security requirements

See `SECURITY.md`. Protocol implementations require fuzzing, malformed-frame handling, bounded allocations, stream deadlines and negative authorisation tests.

The bounds of §7 are the mechanism behind the bounded-allocation requirement, and are declared once in `packages/protocol/schemas/connector/v1.schema.json`. The generator refuses a schema in which any string, array, numeric field or payload lacks an explicit bound, so a new field cannot be added without one.
