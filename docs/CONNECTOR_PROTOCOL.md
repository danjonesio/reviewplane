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

The systemd unit and a complete example configuration are shipped in the source
tree at `services/connector/packaging/systemd/reviewplane-connector.service` and
`services/connector/packaging/config.example.yaml`, and `DEPLOYMENT.md` §13
installs them from there. The example is not a menu: the connector's own test
suite parses it, so a setting that drifted from the parser fails the build, and
an operator can copy it whole rather than assembling one from this document.

Three properties of the unit are requirements rather than preferences.

It opens **no listening socket**. Every connection the connector makes is
outbound (§5), which is what makes "no public inbound port is required on the
development VM" observable with `ss -ltnp` rather than merely intended. No
socket unit accompanies it, and adding one would be an architecture change
requiring an ADR.

It does **not** use `DynamicUser=`. The connector reads the developer's
checkouts to report branch and head commit (§9), which needs a stable account
in two ways a per-boot UID cannot supply: the checkouts must grant it read
access, and Git refuses to operate on a repository owned by another account
unless `safe.directory` names it, which is configuration written against a
specific user. The unit therefore runs as a named service account, and the
operator grants that account read access explicitly — through
`SupplementaryGroups=`, or by running the connector as the developer, which on a
single-developer machine is the honest arrangement.

It sets `ProtectHome=read-only` rather than `ProtectHome=yes`. Workspace
checkouts commonly live under `/home`, and hiding it would make every workspace
report as "not a Git checkout" and silently disable the whole of §9. Read-only
still means an observation cannot write to somebody's repository, which the
connector also enforces from its own side (§9).

Exit code 3 is a refusal an operator must act on — an invalid enrolment token, a
revoked identity, an unsupported protocol version or a required upgrade — and
the unit excludes it from `Restart=`, because restarting would retry a credential
the control plane has already refused (§18).

Signed release artefacts and multi-platform builds are deferred: the binary is
built from source (`services/connector`) at Stage 1.

## 4. Identity and enrolment

### 4.1 Enrolment token

Created by an administrator with:

- Organisation scope
- Optional project scope
- Expiry
- Maximum uses, default one
- Optional environment labels

The token is minted through `API.md` §9, which is also where the one-time
`reviewplane-connector enrol` command an operator runs is assembled. The token
value appears in that one response and nowhere else: the control plane stores
only its digest and cannot reproduce it, and it is never written to a log or to
an event payload — `connector.enrolled` records the token's **identifier**
(`EVENTS.md` §7).

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

One endpoint on that same listener is an ordinary HTTPS request rather than a channel: `POST /connector/v1/agent-credentials`, the local MCP bridge's credential exchange of §14 (ADR-0023). It is authenticated by the same verified client certificate the control channel is, and the bridge derives its URL from `control_url` so that the two cannot be pointed at different hosts. It is not a message type: the bridge is a separate, per-session process, and one connector holds one control channel.

A verifier — the control plane on the control channel, the tunnel gateway on the data channel — MUST:

1. require a client certificate whose chain verifies against the control-plane certificate authority;
2. compute the sha256 fingerprint of the presented leaf certificate;
3. resolve it to a connector record, and refuse when no record matches or the record is revoked.

An unauthenticated connection and a connection presenting a certificate from another authority are both refused before any frame is exchanged.

Stage 0 terminates the connector channels on a dedicated mutually authenticated listener owned by the control-plane server, rather than behind the shared gateway of `ARCHITECTURE.md` §4.1, because the human API does not request client certificates and the two authentication models must not share a listener. The topology may change without changing this protocol.

### 5.3 Refusal signalling

Version 1 defines no error message type. A control plane refuses a connector by closing the WebSocket with code 1008 and a reason equal to a §21 error class. A connector MUST treat `ENROLMENT_TOKEN_INVALID`, `IDENTITY_REVOKED`, `PROTOCOL_UNSUPPORTED`, `PROJECT_NOT_AUTHORISED` and `UPGRADE_REQUIRED` as terminal: it reports the class and stops, and MUST NOT retry with the refused credential or configuration (§18). Any other close is a transport event, and the reconnect behaviour of §17 applies.

`PROJECT_NOT_AUTHORISED` is terminal for the same reason the other four are: a connector configured to report or serve a project it may not touch is a misconfiguration only an operator can fix, so retrying with the same configuration cannot succeed and would loop until somebody noticed. It stops with the class named instead, which is what `UX_FLOWS.md` §18 means by an actionable cause.

This governs a **close reason** and nothing else. A `route.publish.ack` carrying `PROJECT_NOT_AUTHORISED` in its payload (§11) refuses one publication, not the channel, and the connector MUST keep serving everything else it was authorised for.

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
| `connector.reconnect.request` | `control` | connector to control plane |
| `connector.reconnect.response` | `control` | control plane to connector |
| `workspace.observed` | `events` | connector to control plane |

The data-stream header of §12 travels on the `data` channel and is not carried in a control envelope. The `upgrade` channel is reserved at version 1: no message type is defined for it. The reconnect exchange of §17 travels on `control` rather than on `upgrade`, because it reconciles state and only reports a version classification as part of doing so.

The `events` channel carries one message type, `workspace.observed` (§9, ADR-0022). It is an observation about the development environment rather than a command or an acknowledgement, which is why it is not on `control`, and it is context rather than liveness, which is why it is not folded into the heartbeat. The agent-session observations this channel is also named for are not defined at version 1; they arrive as a further message type rather than by widening this one.

A logical channel is a property of the message type rather than of a separate connection. Stage 1 carries `control`, `heartbeat`, `routes` and `events` over the one mutually authenticated WebSocket of §5.2; only `data` is a second connection, because it terminates at the tunnel gateway rather than at the control plane.

Version 1 defines no message by which the control plane withdraws a single route from a connector that is still connected. Revocation reaches the tunnel through the gateway (§18, `ARCHITECTURE.md` §7.3) and reaches the connector's own route table at the next reconnection (§17). A `route.revoke` message would remove that gap and is a protocol change requiring an ADR.

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

`connector_id` MUST be absent on `connector.registration.request` and `connector.registration.response`, and MUST be present on every other message type, `workspace.observed` included: an observation about a development machine that named no connector could not be attributed to the environment it describes. The control plane additionally refuses a frame whose `connector_id` is not the identity the TLS handshake authenticated, so the envelope's attribution cannot disagree with the certificate that carried it. `correlation_id` is optional and identifies the message or command being answered.

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
| `connector.reconnect.request` payload | 32 768 bytes |
| `connector.reconnect.response` payload | 57 344 bytes |
| `workspace.observed` payload | 2 048 bytes |

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

"Resume and reconcile" is one thing, not two: a channel is established and then §17 runs before the connector serves anything on it. The connector's first frame on every established control channel is `connector.reconnect.request`, including the first channel after a start, because a restarted process and a restarted network are indistinguishable from the control plane's side and both need the same answer.

The thresholds are the control plane's, not the connector's: `DEGRADED` and `DISCONNECTED` are conclusions drawn from silence, so a connector cannot report them about itself. Stage 0 defaults are a 15-second heartbeat interval, `ACTIVE` to `DEGRADED` after 45 seconds of silence, and `DEGRADED` to `DISCONNECTED` after 90 seconds; all three are configurable. A heartbeat arriving in either degraded state returns the connector to `ACTIVE`. Every transition produces an event (`EVENTS.md` §7), so a connector that goes quiet leaves an audit trail rather than merely ceasing to appear.

The connector also sends a WebSocket ping alongside each heartbeat and bounds its own read wait, so that a control plane with nothing to say still proves the channel is alive.

### Flood limiting

A heartbeat costs the control plane two database writes, and a connector is the one peer that can send them as fast as a socket allows. The control plane therefore applies a floor: a heartbeat arriving less than a third of the configured interval after the last admitted one is counted and dropped, and a connector that exceeds 32 dropped heartbeats on one channel is refused with `PROTOCOL_UNSUPPORTED` and the channel ends. Without it a faulty or hostile connector turns its own heartbeat loop into load on the control plane's database, which is a denial of service dressed as liveness. §22 requires bounded allocations of a protocol implementation, and a bound on what one message may allocate is not a bound on how often it may be sent.

The floor is derived from the configured interval rather than fixed, so an operator who shortens the interval does not also have to remember to widen the limit.

Dropping rather than refusing on the first offence is deliberate. A connector that reconnects immediately after a network blip legitimately sends a heartbeat close behind its last one, and ending its channel for that would turn a recovered outage into a longer one. A dropped heartbeat is not an error the connector is told about: it is simply not counted as liveness, and the connector's next one on the interval is.

## 9. Workspace discovery and Git context

The decision behind this section is ADR-0022.

### Discovery modes

1. Explicit configured paths
2. Agent-session supplied working directory
3. Optional bounded root scanning

Default is explicit paths or agent-supplied context. **Broad filesystem scanning is disabled**, and this build performs none: the only paths a connector ever looks at are the ones an operator wrote in the `workspaces` block of §20, and there is no directory walk anywhere in the connector. Mode 3 is unimplemented and `privacy.discover_workspaces: true` is refused at startup rather than accepted and ignored, so an operator cannot believe scanning is on when nothing scans.

A workspace entry missing an `id` or a `project` is skipped with a warning naming which entry it was. A publication names both (§11), and an observation the control plane could not attribute to a project is one it must refuse.

### What is reported

| Field | Meaning |
|---|---|
| `workspace_id` | The identifier a publication names (§11), chosen by the connector |
| `project_id` | The project the connector believes the checkout belongs to — a claim, re-checked before anything is stored |
| `path_hash` | `sha256:<hex>` digest of the checkout's absolute path |
| `display_label` | The checkout directory's own name |
| `repository_identity` | Canonical provider-agnostic identity of the checkout's remote, when it has one that could be normalised |
| `branch` | Checked-out branch; a detached HEAD is reported as the literal `HEAD` |
| `head_commit` | HEAD commit, lowercase hexadecimal |
| `dirty` | Whether the working tree carries uncommitted changes |
| `observed_at` | When the connector observed this state |

The control plane records its own instant beside `observed_at`, because a development machine's clock is not authoritative.

An absent value is reported as absent rather than guessed at. A checkout with no remote the connector could normalise carries no `repository_identity`; a repository with no commit on `HEAD` yet, a directory that is not a checkout, and a machine with no `git` executable each yield no observation at all rather than an observation with invented fields.

### What is never reported

- **Source file contents.** Not by default and not by configuration: the version 1 `workspace_observation` payload has no member capable of carrying them.
- **A changed-path list.** `dirty` is a boolean derived from whether `git` printed anything, not from what it printed. `privacy.report_changed_paths: true` is refused at startup, because accepting it would tell an operator their policy had been applied when nothing about what is sent had changed. Carrying paths would be a protocol change requiring an ADR, not a configuration option.
- **The full filesystem path.** The digest identifies the same checkout across observations without disclosing the directory layout; `display_label` is bounded and refuses `/`, `\` and control characters, so a path cannot be smuggled through the field that exists precisely so that one is not stored.
- **Process detail.** §8 keeps it out of the heartbeat and nothing here reintroduces it.

These are properties of the schema rather than of the code that fills it in, which is what makes them stable: `packages/protocol/schemas/connector/v1.schema.json` sets `additionalProperties: false` on the payload, and both languages' validators are generated from it.

### How it is reported

Each observation is one `workspace.observed` message on the `events` channel (§6), bounded at 2 048 bytes. One observation is one message: the schema binds one payload to one envelope and version 1 defines no batch form.

Observations are sent at three moments:

- **on connect** — the whole set, once per established channel, after §17 reconciliation has completed. It follows the reconciliation rather than interleaving with it, because a connector describing workspaces to a control plane that has not yet said which routes it authorises would be answering a question nobody asked;
- **on change** — only the workspaces whose branch, head commit or dirty state moved since they were last reported. A path hash and a display label cannot change without the configuration changing, and `observed_at` changes every interval by construction, so neither triggers a report. A connector on a machine nobody is working on is silent;
- **on reconnect** — the full set again, because a control plane that restarted has no memory of the last one. A workspace suppressed as unchanged would otherwise stay invisible until it happened to change.

The re-observation interval is `git_context.interval`, default 30 seconds (`CONFIGURATION.md` §5.2).

A workspace that stops yielding context — the directory was removed, or is no longer a checkout — is forgotten rather than reported stale. The connector says nothing about it instead of continuing to assert a branch on its behalf.

### How the observation is bounded on the development machine

Observing runs `git`, on somebody's working machine, against directories the connector did not choose. Four rules apply and are enforced by the connector rather than trusted to a caller:

- **No shell.** Every invocation is a fixed argument vector, so nothing in a repository's name, path or configuration can become a command. The working directory is set rather than passed as an argument, so a configured path never appears in an argument vector at all.
- **Bounded output and bounded time.** Each invocation captures a few kilobytes and carries its own deadline, so an enormous repository cannot grow the connector's heap and a checkout on a stalled network mount delays one observation rather than the connector.
- **No prompt.** The invocation environment disables terminal prompts and askpass helpers, so no observation can block waiting for a credential on a service that has no terminal. The subcommands used read local state only — the enclosing work tree, `HEAD`, the porcelain status and the origin remote's configured URL — so an observation contacts no remote.
- **No write to somebody's repository.** Optional locks and automatic garbage collection are disabled, and `core.fsmonitor` is overridden, so a repository's own configuration cannot name a program for `git` to run on the connector's behalf.

### The claim is not an authorisation

`project_id` is what the connector believes. The control plane re-derives whether this identity may act for that project — the identifier, the organisation the client certificate resolved to and the project the identity was enrolled for are one predicate — and refuses a project outside that scope with `PROJECT_NOT_AUTHORISED`, closing the channel per §5.3. The refusal is terminal.

The connector also chooses `workspace_id`, because it is the value a publication names. What bounds that is ownership: a workspace record belongs to the environment that reported it, and a connector may create or update only its own records, or one belonging to no environment — a workspace an operator registered (`API.md` §4.3).

Adopting an unowned record requires the **paths to match**. An operator named a path, the connector observes a path, and the two hash to the same digest, so they are the same checkout. An identifier match alone is not enough and is refused: an identifier naming a record for a different checkout is the same "identifier already held" collision as a record owned by another environment, and a connector that could adopt by identifier alone would inherit the `root_path` an operator gave that record while replacing its branch and head commit. A record owned by **another environment** is refused likewise, so claiming another environment's workspace, claiming another project's, and naming a project outside the enrolled scope are one outcome rather than three.

Refusals are byte-identical whichever of those it was, so a connector can learn that an identifier is taken — it has to, since it chooses one — but never where it is held (ADR-0022).

A record's identity is `(project_id, environment_id, path_hash)`. The environment is part of it because the same path on two development machines is two checkouts: without it, two machines with the same layout share one record and overwrite each other's branch and head commit every interval.

For a reported workspace the **checkout is the identity and the identifier is the label**. When an observation names an identifier held by one record and a path held by another of this environment's, the record at that path is the one updated. That is what makes swapping two `workspaces:` entries in `config.yaml` an ordinary act: each record is updated where it stands, none moves onto another's path, and nothing collides. Moving a checkout still works — an identifier reported at a path no record holds moves that record's path.

An environment may hold at most 32 workspaces in one project. Without a bound, an environment that chooses its own identifiers could fill the table with identifiers nothing will ever use.

### What the control plane records

A first observation creates the workspace record and writes `workspace.observed`. A change to branch, head commit or dirty state writes `workspace.head_changed` carrying **both** sides. An observation that moved nothing refreshes `last_observed_at` and writes no event: `EVENTS.md` §7 requires a high-frequency signal to be sampled rather than evented, and a connector reports on an interval whether or not anything happened.

Nothing here computes staleness. `DOMAIN_MODEL.md` §24 compares a review's captured context against a current workspace, and this section supplies only the current side; a freshness claim this layer cannot support would be worse than no claim at all.

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

**Who sends the request.** A connector dials the control plane (ADR-0002), so
its control channel terminates in the process serving the API and nowhere else.
Publication is therefore two phases, split exactly there (ADR-0021). Any
control-plane process may write a route as `requested` — that phase runs the
browser-session rule above, the lifetime bound, the destination policy of
`SECURITY.md` §9 and the per-connector route limit, and touches nothing outside
the database, so a refused destination still never reaches the connector. The
process holding the channel then performs this exchange and moves the record to
`ready` or `failed`. It does so inline for its own callers and on a short
interval for a route another process requested, which is what makes the sentence
above true for the agent surface as well: the sweep reaches an abandoned
`requested` row, the exchange fails with `CONNECTOR_OFFLINE`, and the record
becomes `failed` carrying that class.

Revocation is **not** split this way. The tunnel gateway verifies a route
capability from its signature without a database read, so a record marked
revoked while the gateway still carried the route would be a revocation of
nothing; every process that can revoke reaches the gateway directly (§18).

The same checks are applied independently by the control plane before it publishes and by the tunnel gateway before it registers a route. Three implementations of one policy is the defence in depth `SECURITY.md` §9 requires: a control plane that had been persuaded to publish an unauthorised destination must still be refused by the gateway, and a gateway that had been misconfigured must still be refused by the connector. They are held to one shared corpus so that they cannot drift apart.

## 12. Data stream protocol

Each tunnelled connection is opened by a bounded header carrying exactly:

- Route ID
- Browser session ID
- Session capability
- Stream ID
- Destination protocol
- Deadline
- Stream mode, optional; absent means `request_response` (§13.3)

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

Every stream carries an absolute deadline. A stream past its deadline, or one that has made no progress for its idle timeout, MUST be closed and recorded rather than left open. A stream MUST NOT outlive the route it belongs to: its deadline is the earlier of the configured maximum stream lifetime and the route's expiry.

The absolute lifetime is a backstop, not the working control. `stream_max_lifetime` defaults to `route_ttl_max`, so what normally bounds a stream is its route's expiry; what ends an ordinary stream is the exchange finishing, and what ends a stalled or silent one is the idle timeout. The idle timeout is not one number: §13.3 gives a request/response stream and an upgraded stream different windows, because the two mean different things by silence. A short absolute lifetime would cut a server-sent-event stream or a hot-reload WebSocket in the middle of working correctly, and MUST NOT be used in place of an idle timeout.

Both ends enforce this. The tunnel gateway sweeps the streams it opened and the connector sweeps the streams it accepted, each on its own timer, because a data channel that dies mid-stream would otherwise leave the development machine holding sockets nothing is going to close. A stream that terminates for any reason closes its local socket immediately rather than waiting for the absolute deadline.

Concurrent streams per channel, bytes per stream and the size of one data-channel message are all bounded. Exceeding a stream bound resets that stream with `STREAM_LIMIT_EXCEEDED`. Exceeding the message bound ends the channel, because the bound is applied to the declared length before anything is allocated. An upgraded connection occupies a stream for as long as it lives, so the per-route stream bound is also the bound on concurrent long-lived connections for that route.

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

Those twenty are the plain request/response portion of the scenario, captured before it goes on to open a WebSocket and a stream. An upgrade handshake is normalised by the same rules and is proven separately (§13.3): the gateway's own forwarded headers reach the development service, the caller's do not, and the capability never does.

### 13.2 Absolute URLs emitted by the development service

An absolute URL in a response body that names `localhost`, `127.0.0.1` or the development port is an expected failure mode and MUST NOT be repaired by rewriting response bodies. The browser resolves it against nothing the route can reach, so the sub-resource fails; body rewriting would mean parsing untrusted content in the request path and would break any application that emits an absolute URL for a legitimate reason.

The supported repairs are, in order of preference: emit root-relative URLs; configure the application's public base URL to the internal origin; or set the `Host` mode to `original` so the application derives the right base itself. `examples/dev-fixture` serves a page that exhibits the failure so that it can be recognised rather than guessed at.

Observed: the end-to-end scenario navigates to that page and records the outcome in `evidence/absolute-url-finding.txt`. The document loads — `200`, correct title — and the stylesheet it names by absolute URL never reaches the development service at all. It does not appear in that service's request log, because the browser resolves `http://127.0.0.1:4321/` against the browser container rather than the development machine, and the session's egress policy refuses every origin but its own before the request leaves. The failure is therefore silent in the page and visible in the evidence, which is exactly why the fixture serves the case.

### 13.3 Upgrades and streaming

The route layer preserves:

- HTTP upgrade
- Bidirectional frames
- Connection closure semantics in both directions
- Idle timeout suitable for hot reload
- Origin and forwarded headers according to the modes above

The decision behind this section is ADR-0017.

**Which upgrades are carried.** `websocket` and nothing else. `h2c` is refused because HTTP/2 is deferred (§5, `ARCHITECTURE.md` §7.4), and any other token is refused because relaying a framing the gateway has never seen is indistinguishable from being the raw forwarder `SECURITY.md` §9 excludes permanently. A refusal answers `UNSUPPORTED_CAPABILITY`.

An upgrade MUST present both halves of RFC 9110 §7.8: an `Upgrade` header and a `Connection` header nominating it. One without the other is refused rather than guessed at, so a caller cannot change how a request is framed by adding a single header. A handshake MUST be a `GET` and MUST carry no body.

**Authorisation is unchanged.** The upgrade path runs the same checks in the same order as §13.1's ordinary path: headers are normalised before the origin is resolved, the capability is verified before any claim in it is read, and route, project and browser session are all checked. An upgrade is never an authorisation bypass, and each denial returns its documented stable code — `AUTHENTICATION_REQUIRED`, `AUTHORISATION_DENIED`, `PUBLISHED_SERVICE_UNAVAILABLE`, `ROUTE_EXPIRED`, `CONNECTOR_OFFLINE` or `STREAM_LIMIT_EXCEEDED`.

**What the gateway does with the handshake.** It re-serialises the request as it does any other, replacing `Host` per the configured mode, adding the forwarded headers per the configured mode, removing the route-confusion set and the whole `X-ReviewPlane-` namespace, and writing `Connection: Upgrade` and `Upgrade: websocket` from the upgrade it validated rather than from what the caller framed. No `Content-Length` is emitted. `Sec-WebSocket-Key` and any offered sub-protocol or extension reach the development service unchanged, so `Sec-WebSocket-Accept` is computed by the development service and validated by the browser against it; the gateway computes nothing.

A development service that answers anything other than `101` has refused the upgrade, and its own response is delivered to the browser unchanged. A gateway that replaced it with an error of its own would hide which end said no.

After `101` the gateway stops being an HTTP server on that connection and relays bytes in both directions. Frames on an upgraded connection are browser-adjacent untrusted content (ADR-0010) and MUST NOT influence routing or destination selection. The connector never learns that a connection was switched by looking at what flows through it — §12 forbids parsing relayed bytes — so the mode is declared in the stream header instead.

**Closure propagates both ways.** A browser-side close half-closes the stream, which the connector turns into a close of its local socket; a development-service close ends the stream, which closes the browser's connection. A close frame is application data and is relayed like any other byte, so its code and reason arrive intact.

**Stream mode.** `data_stream_header.stream_mode` is `request_response` or `upgrade`; absent means `request_response`. It selects the stream's idle window and nothing else. It does not change which destination is opened — that is fixed at publication and the header carries no host or port — and it relaxes no check.

**Timeout and buffer values.** These are the implemented Stage 0 defaults, each configurable through the settings of `CONFIGURATION.md` §4:

| Value | Default | Setting | What it governs |
|---|---|---|---|
| Request/response idle timeout | `60s` | `stream_idle_timeout` | no progress on an ordinary exchange |
| Upgrade idle timeout | `15m` | `upgrade_idle_timeout` | no progress on an upgraded connection |
| Maximum stream lifetime | `8h` | `stream_max_lifetime` | absolute bound, clipped to the route's expiry |
| Sweep interval | `5s` | `sweep_interval` | how often the two above are enforced |
| Per-direction flow-control window | `256 KiB` | fixed by the protocol (§12.2) | bytes in flight before credit must return |
| Relay buffer, per direction | `32 KiB` | `relay_buffer_bytes` | the only per-connection allocation the relay makes |
| Bytes per stream, per direction | `64 MiB` | `max_stream_bytes` | exceeded resets the stream `STREAM_LIMIT_EXCEEDED` |
| Concurrent streams per route | `64` | `max_streams_per_route` | also the bound on concurrent upgraded connections |

Fifteen minutes is chosen against the failure it prevents. A developer reading code sends nothing over a hot-reload socket, and neither Chromium nor the development servers this fixture targets close an idle one; a window shorter than a plausible reading pause would make the tunnel the thing that broke hot reload. Sixty seconds remains right for a request/response stream, where silence means a stalled exchange.

In Stage 0 only the gateway's windows are configurable. The connector applies the same defaults from the shared data-channel implementation both ends import, and where the two differ the shorter window applies. Making the connector's windows configurable is follow-up work recorded in ADR-0017.

**Route expiry and revocation close upgraded connections.** A route that expires or is revoked resets its in-flight streams, including upgraded ones, and the browser sees the connection close. `ARCHITECTURE.md` §7.3 requires a route to be revocable immediately, and a persistent WebSocket that survived its route would make that only a revocation of future requests. A long-lived connection MUST NOT extend the lifetime of the access that authorised it: an upgraded stream's absolute deadline is clipped to the route's expiry, and the gateway sets the same deadline on the browser-facing socket.

**Streaming responses.** A `text/event-stream` response, a chunked response and any other response the development service produces incrementally are forwarded incrementally: each part is written and flushed to the browser as it arrives, and no hop accumulates the response. A `Content-Length` is emitted only when the development service declared one.

**Backpressure.** An upgraded or streaming connection is relayed with one bounded copy buffer per direction. Everything beyond that is the per-stream credit window of §12.2, returned only as bytes are consumed. A browser that stops reading stops the development service rather than filling a queue in the tunnel, and a development service that floods stops itself. Frames are never queued without bound at either end.

**Accounting.** The gateway counts upgrade requests by outcome — `requested`, `switched`, `declined_by_destination`, `refused`, `failed`, `closed`, `reset` — and reports the number of upgraded connections open now as a gauge. Bytes carried after the switch are recorded against the route in both directions, like any other stream's.

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

`reviewplane-connector mcp` implements all four.

**Resolve local workspace and project.** The resolution matches configured paths only. Nothing is discovered: a directory inside no configured workspace is reported as such rather than registered on the spot, because a publication names a workspace the operator authorised (§11). Where workspaces nest, the longest matching path wins, so an agent in a nested checkout resolves to the nearer one. A workspace may also be named explicitly with `--workspace`. `--describe` prints what was resolved — connector identity, workspace, project and checkout — and exits without proxying, which is the form an operator runs by hand.

**Request short-lived agent-session credentials.** The connector presents its device identity to `POST /connector/v1/agent-credentials` on the control plane's mutually authenticated listener and names the workspace by its path hash. The control plane resolves that workspace inside the connector's own environment **and** inside the project the identity was enrolled for, and issues a credential bound to **that workspace's project and no other**, living one hour and carrying the workflow capabilities of `docs/MCP_SPEC.md` §14.1 (ADR-0023). A workspace belonging to another environment, and one carrying a project outside the enrolment, both answer exactly as an unknown one does. An organisation-scoped enrolment names no project, and the second term is inert for it — the same rule §9 applies to a reported workspace.

A credential the exchange issued lives its hour unless something ends it, and revoking the connector identity is what does: §18 revokes every live credential the identity minted.

**Proxy MCP traffic to the control plane.** The command reads newline-delimited JSON-RPC from stdin, forwards each message to `/mcp/v1` with the credential in an `Authorization` header, and writes each response back to stdout. The MCP session identifier the endpoint mints is captured and echoed, so the exchange is one session. **stdout carries JSON-RPC and nothing else**: everything an operator reads goes to stderr, because a diagnostic on stdout would corrupt the stream the client is parsing. A control plane that becomes unreachable mid-session is reported to the agent as a JSON-RPC error naming neither a host nor a credential, rather than by the pipe closing under it.

**Avoid storing long-lived agent tokens.** The credential lives in the bridge process's memory and is written nowhere — not to the identity directory, not to a cache, not to a log line. A connector restart ends the bridge, and the next one requests a fresh credential; there is no stored token for it to replay.

It cannot grant the agent connector-administrator privileges, because the agent capability vocabulary of `docs/SECURITY.md` §6.3 contains no administrative capability for one to be granted. The bridge holds no listening socket: it speaks over stdin and stdout, so no port is opened on the development machine.

The connector advertises `local-mcp-bridge` in its capabilities.

## 15. Agent-session association

Association methods, in priority order:

1. Local MCP bridge creates the session (implemented: the bridge's credential is bound to one project, so the session it opens resolves that project unambiguously)
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

`reviewplane-connector mcp` emits it. The credential exchange of §14 answers with the project's pending agent work — the review's slug, its finding count and its priority, bounded at five with a count of the remainder — so the bridge learns what is waiting without a second round trip and without opening an MCP session first. Nothing carrying page-derived content reaches that shape: no finding text, no captured URL.

Delivery is to the connector's log, which is journald under the shipped systemd unit, to the command's own **stderr**, and to the file named by `--status-file` when one is given. The status file is written 0600 and replaced atomically, because a shell prompt may read it at any moment and a half-written file is a prompt showing a truncated line.

Nothing is written to a terminal the command does not own. Its stderr is its own; there is no `write(2)` to another process's pseudo-terminal and no shell injection, and the rendered line is stripped of control characters and of the product marker so that a value cannot forge a second line in an operator's log.

A desktop notification is not implemented. A notification that could not be delivered is logged and does not stop the session: the work is still retrievable through `agent_inbox_list`.

## 17. Reconnection and reconciliation

On reconnect, the connector sends `connector.reconnect.request`, whose payload carries six fields, all of them always present:

- `connector_version`
- `capabilities`
- `active_routes`
- `active_streams`
- `known_agent_sessions`
- `workspace_head_state`

`workspace_head_state` carries the connector's real observed state: one entry per configured workspace it has been able to observe, each naming the workspace, its branch, its head commit and its dirty state. Those scalars are the same schema definitions `workspace_observation` uses (§9), so the claim and the observation cannot drift apart.

The claim is answered from the **last** observation rather than by observing afresh. It is the first frame on an established channel and nothing may delay it: a workspace on a stalled network mount would otherwise hold up reconciliation, during which the connector serves no route at all. What the control plane receives is therefore genuinely observed state that may be one interval old, followed within milliseconds by the fresh full report of §9. The control plane's answer wins in every disagreement in any case, so a claim is never authority.

The claim is bounded at eight workspaces while the observation stream is not. A connector serving more claims the first eight in configuration order rather than an arbitrary subset, so two consecutive reconnects from an unchanged connector claim the same eight; a claim that varied between attempts would look like a connector whose workspaces kept appearing and disappearing. Every workspace is still observed and still reported.

`known_agent_sessions` is still sent as an empty array, because agent-session re-establishment is not implemented. It is sent empty rather than omitted, so that the message shape does not change when that capability arrives; a payload omitting it is refused by the schema.

The claim is a claim, never an authorisation. The payload carries no credential: the identity is the mutually authenticated client certificate the channel already presented (§5.2).

The control plane responds with `connector.reconnect.response`, correlated to the request by the envelope's `correlation_id`, carrying its authoritative desired state:

- `routes`, one decision each: **continue route** or **revoke route**
- `sessions`, one decision each: **re-establish session** or end it
- `upgrade`, the §19 classification, of which **upgrade required** is one value
- `reconciled_at`, the control plane's own instant, which is authoritative for expiry arithmetic so that clock skew on the development machine cannot extend a route

Reconciliation is a three-way comparison: what the connector believes it is serving, what the control plane has authorised, and what has expired in the meantime. **The control plane's answer wins in every disagreement.** Where the two disagree about a route that is still within its TTL, is still authorised for this connector and still points at the destination the record names, the answer is continue; in every other case it is revoke.

| Connector's claim | Control-plane record | Decision | `reason` |
|---|---|---|---|
| claimed | no such route | revoke | `unknown_route` |
| claimed | belongs to another connector | revoke | `not_authorised` |
| claimed | project or workspace differs from the record | revoke | `not_authorised` |
| claimed | already revoked or failed | revoke | `revoked` |
| claimed | expiry has passed | revoke | `expired` |
| claimed | destination differs from the record | revoke | `destination_mismatch` |
| claimed | ready, unexpired, same destination | continue | `authorised` |
| not claimed | ready and unexpired | continue | `authorised` |
| not claimed | expiry has passed | revoke | `expired` |

The last two rows are what makes a connector restart survivable: the route table is in memory, a restarted connector claims nothing, and the control plane restores what it still authorises. A continued decision therefore restates the whole publication, so the route resumes under the **same `route_id` and the same destination without a second publication exchange**. The connector still applies its own §11 validation to that restatement — schema acceptance is not authorisation, and a control plane that had been persuaded to name a destination this connector does not allow is still refused. It does not re-run the §11 startup probe: the control plane has already decided the route is worth carrying, and a destination that has gone away is reported per stream as `PORT_NOT_LISTENING`, which is a diagnosis rather than a silent disappearance.

Unknown or expired routes are closed. The connector enforces that by withdrawing **every** route from service before it sends the request, and serving again only what the response continues. Three consequences follow, and each is a requirement:

- a route the response does not name is not served, so a truncated or partial answer fails closed;
- a reconciliation that times out leaves the connector serving nothing, rather than serving traffic nobody has re-authorised — the connector reports the timeout, drops the channel and retries under the backoff of §5;
- reconnecting is never a way to extend an authorisation that had lapsed.

The connector MUST accept a desired state only as the answer to the request it sent, matched on `correlation_id`. An unsolicited or duplicate response is refused, because reinstating a route outside the exchange would be a way to grant one without a claim to answer.

Identity survives a reconnect; routes do not automatically. A reconnect with a valid mutually authenticated identity resumes and reconciles (§8), and each individual route is re-authorised explicitly. A reconnect from a different identity inherits no routes: a claim on a route another connector owns is answered `revoke` with `not_authorised`, and that other connector's record is left exactly as it was. A revoked identity never reaches this exchange at all — it is refused before the channel is established (§18).

Every reconnect and every reconciliation decision produces a log line carrying the connector ID and the route IDs affected (`ARCHITECTURE.md` §15), on both sides. Decisions are audited (`SECURITY.md` §16); the payloads carry no credential, and the reasons above are a closed vocabulary, so an audit record needs no free text.

Closing a route on reconciliation produces the lifecycle event its cause names (`EVENTS.md` §7): `published_service.expired` where the expiry had passed, `published_service.revoked` otherwise. Both carry the reason and the trigger `reconnect_reconciliation`.

Streams do not survive the channel that carried them. A revoked route's in-flight streams are reset by the connector as the decision is applied, so revocation reaches traffic that is already moving (§12.3).

## 18. Revocation

Revoking a connector:

- Invalidates its identity
- Closes control and data channels
- Revokes active routes
- Marks associated browser sessions `DEGRADED`
- Revokes the agent credentials that identity minted (§14)
- Produces audit events

Re-enrolment creates a new connector identity.

### Why the minted credentials are part of it

A connector mints short-lived agent credentials for the local MCP bridge
(§14, ADR-0023), and refusing the exchange to a revoked identity closes only the
**next** one. A credential already handed out is a bearer token in another
process, and it carries `review:write` and `finding:write` for the rest of its
hour whatever happened to the identity that obtained it.

Revocation MUST therefore revoke every live credential the identity minted.
ADR-0023 accepts that a compromised connector can mint credentials for its own
projects "for as long as its identity is valid" on the explicit ground that
revoking the identity is what ends that; a revocation that left them live would
make the accepted risk larger than the one that was accepted.

Each revoked credential produces its own `session.revoked` audit event, per
project it reached, with the reason `connector_revoked` — the same event an
administrative revocation writes, so that an auditor asking what a project's
agent credentials did reads one event type whichever path ended them
(`SECURITY.md` §16).

A credential that has already expired is left as it is. It resolves to nothing
already, so revoking it would record a permission change that had in fact ended
by itself.

### What "marks associated sessions" means

A browser session that lost its connector is marked `DEGRADED`. `DOMAIN_MODEL.md` §12 defines no `DISCONNECTED` browser-session status and requires that a connector outage move a session to `DEGRADED` and never to `TERMINATED` or `FAILED`: the session and its metadata are retained and remain diagnosable, so a human can still read what happened in it.

Revocation is where that rule bites hardest, because nothing returns such a session to `READY`. An outage is repaired by reconciliation continuing the route the session was allocated against (§17); a revoked route is not continued, and a re-enrolled environment is a **new** identity with new routes rather than the same one returning. The session therefore stays `DEGRADED` and diagnosable rather than being resurrected or destroyed.

### Ordering

The five effects are ordered, and the order is a requirement rather than an implementation detail:

1. active routes are revoked and their in-flight streams reset, and the affected browser sessions are marked `DEGRADED`;
2. the live agent credentials the identity minted are revoked;
3. the connector record is marked `REVOKED`;
4. the live control channel is closed with code 1008 and the reason `IDENTITY_REVOKED`.

The record flips **before** the close. The pre-upgrade guard on the control channel reads that record, so a connector that reconnected in the gap between closing its socket and marking its row would be admitted again; closing afterwards makes the refusal immediate rather than merely eventual. Routes, sessions and credentials are ended before the record flips, so that the counts the audit event reports are counts of work that actually happened, and a failure part-way leaves the connector usable rather than revoked with its routes still carried — which is the direction that is safe to be wrong in.

What the flip adds for the credentials is that the set cannot grow back: the exchange of §14 resolves the connector record on every request, so once it says `REVOKED` no further credential can be minted for that identity.

It does not close the window **before** the flip, and this document says so rather than implying otherwise. A credential minted between the sweep and the flip survives the revocation that was meant to end it — milliseconds wide, and only reachable by a concurrent exchange on the same identity. Closing it properly means the flip and the sweep committing together, which is a change to how the transition is recorded rather than a second sweep: a second sweep would catch the race and then leave `connector.revoked` reporting a lower count than the API response, which is the same two-numbers-for-one-fact defect the channel count was repaired for. It is tracked as a follow-up. The accurate-count argument above is about reporting and does not extend to a security sweep, so this is a known gap rather than a decision.

### What the audit record carries

The `connector.revoked` event and the API response of `API.md` §9 both report `routes_revoked`, `sessions_disconnected`, `channels_closed` and `agent_credentials_revoked`. Revocation is several things at once and an auditor needs to see that all of them happened; a revocation that closed a channel and left a route carried, or left a minted credential live, would be a revocation in name. `channels_closed` is zero when the connector held no live channel and `agent_credentials_revoked` is zero when it had minted none, both of which are ordinary outcomes rather than failures.

The counts say how much each effect reached; they do not identify what it reached. The individual records are the per-effect events — `published_service.revoked` for each route, `browser_session.degraded` for each session and `session.revoked` for each credential — which is where an auditor goes for the identifiers.

Revoking an already-revoked connector is not an error. It reports `already_revoked` and changes nothing, so a retried request cannot produce a second set of counts for work that happened once.

## 19. Upgrades

The connector reports version and protocol range. The control plane classifies:

- Compatible
- Upgrade recommended
- Upgrade required
- Blocked as unsupported

The classification is carried by the `upgrade` field of the §17 desired state, which is the one exchange in which the connector states its version on an established channel. `compatible` and `upgrade_recommended` continue; the connector logs the recommendation and keeps running. `upgrade_required` and `unsupported` are terminal: the connector reports the classification, stops, and MUST NOT retry with the refused build (§5.3). Stage 0 does not self-update.

A build that cannot speak this protocol version never reaches the classification, because the frame decoder refuses it as `PROTOCOL_UNSUPPORTED` first (§7 "Rejection"). The classification is therefore about the release, not about the wire format.

Stage 0 defaults are permissive: `REVIEWPLANE_CONNECTOR_MINIMUM_VERSION` and `REVIEWPLANE_CONNECTOR_RECOMMENDED_VERSION` both default to `0.0.0`, so every build is `compatible` until an administrator says otherwise. Refusing a connector is an operator decision, not a default (`CONFIGURATION.md` §4).

Automatic self-update is deferred. Signed packages and explicit administrator action are preferred initially.

## 20. Configuration example

```yaml
control_plane:
  url: https://agents.example.internal
  # Optional. Defaults to /connector/v1/enrol.
  enrolment_path: /connector/v1/enrol
  # Optional. The agent endpoint the local MCP bridge posts JSON-RPC to
  # (`MCP_SPEC.md` §3.2). Absent, it is derived from `url` above with the path
  # replaced, which is correct wherever one origin serves both the connector
  # endpoints and `/mcp/v1` — the deployment this example describes.
  #
  # A deployment MAY separate them, and the shipped Docker Compose stack does:
  # the connector listener is a port on the control plane and `/mcp/v1` is a
  # route on the edge gateway. Naming it here is the only way the bridge can
  # know (ADR-0039). It MUST use `https`: the bridge sends a short-lived agent
  # credential in an `Authorization` header on every message, so a plaintext
  # value is refused rather than downgraded.
  mcp_url: https://agents.example.internal
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
  # These are the only paths the connector ever looks at (section 9). id is the
  # workspace identifier a publication names, and a publication naming an
  # unknown workspace is refused with WORKSPACE_NOT_FOUND; project is what an
  # observation is attributed to. An entry missing either is skipped with a
  # warning, because a publication names both.
  - id: wsp_refresh_surplus
    path: /home/dan/projects/refresh-surplus
    project: refresh-surplus

git_context:
  # How often the connector re-reads the branch, head commit and dirty state of
  # the checkouts above (section 9). Only a change is reported, so a machine
  # nobody is working on is silent. Between 5s and 1h; default 30s.
  interval: 30s

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
  # All three must be false in this build, and each is refused with a message
  # naming what is missing rather than a blanket "unsupported".
  report_changed_paths: false
  report_process_details: false
  discover_workspaces: false

logging:
  level: info
  format: json
```

Configuration MUST be validated at startup and every failure MUST name the setting and the line it was read from (`DEVELOPMENT.md` §6). An unknown setting is an error, never a value that is silently ignored (`CONFIGURATION.md` §1).

The connector accepts a deliberately small YAML subset — comments, block mappings, block and flow sequences, and plain or quoted scalars — and refuses anything outside it, including tabs for indentation, anchors, aliases, tags, multi-line scalars, flow mappings and multiple documents. That keeps the statically linked binary of §3 free of a YAML dependency and keeps the parser bounded.

The same example is maintained as a file, `services/connector/packaging/config.example.yaml`, which the connector's own test suite parses, so that a setting which drifted from the parser fails the build. An operator installs from that file (`DEPLOYMENT.md` §13); the block above documents the same settings.

All three `privacy` settings are refused rather than accepted when set to `true`, because no configuration of this build can honour them. Each refusal names precisely what is missing, because "not supported" would leave an operator unable to tell a missing feature from a rejected one:

| Setting | Why `true` is refused |
|---|---|
| `privacy.report_process_details` | §8 permits only `load` and `memory_available_bytes` in a heartbeat's resource summary, and the schema refuses any other property |
| `privacy.discover_workspaces` | The `workspaces` block is observed either way; what this setting turns on is discovery mode 3 of §9 — bounded scanning of a configured root for checkouts nobody listed — which is not implemented |
| `privacy.report_changed_paths` | The version 1 `workspace_observation` payload reports `dirty` as a boolean and has no member that can carry a changed-path list (§9). Accepting it would tell an operator their policy had been applied when nothing about what is sent had changed |

`git_context.interval` is validated at load and must be between 5 seconds and 1 hour. Below the minimum the connector would run `git` more or less continuously on somebody's development machine; above the maximum an operator has effectively turned §9 off and should say so by removing the `workspaces` block instead.

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

Five of these classes are terminal **as a close reason** — `ENROLMENT_TOKEN_INVALID`, `IDENTITY_REVOKED`, `PROTOCOL_UNSUPPORTED`, `PROJECT_NOT_AUTHORISED` and `UPGRADE_REQUIRED` — and a connector that receives one stops rather than reconnecting (§5.3). Terminality attaches to the close, not to the class in every context: `PROJECT_NOT_AUTHORISED` and `WORKSPACE_NOT_FOUND` also appear in a `route.publish.ack` payload, where each refuses one publication and leaves the channel and every other route untouched (§11).

## 22. Security requirements

See `SECURITY.md`. Protocol implementations require fuzzing, malformed-frame handling, bounded allocations, stream deadlines and negative authorisation tests.

The bounds of §7 are the mechanism behind the bounded-allocation requirement, and are declared once in `packages/protocol/schemas/connector/v1.schema.json`. The generator refuses a schema in which any string, array, numeric field or payload lacks an explicit bound, so a new field cannot be added without one.
