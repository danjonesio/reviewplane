# Configuration Reference

## 1. Configuration principles

- Validate at startup
- Fail clearly on unknown or invalid settings
- Keep secrets out of ordinary environment variables where possible
- Support mounted configuration files
- Publish defaults and security implications
- Version configuration when semantics change

## 2. Server configuration areas

Stage 0 status: the server reads environment variables rather than the file below, and validates them at startup. The mounted configuration file arrives with the surfaces that need its remaining sections. `*_FILE` indirection is already supported for every required value, per §7.

| Variable | Default | Meaning |
|---|---|---|
| `REVIEWPLANE_DATABASE_URL` | required | PostgreSQL connection string |
| `REVIEWPLANE_BOOTSTRAP_TOKEN` | required | Bootstrap administrator token, at least 32 characters (`ARCHITECTURE.md` §11) |
| `REVIEWPLANE_HOST` | `0.0.0.0` | HTTP API listen address |
| `REVIEWPLANE_PORT` | `8080` | HTTP API listen port |
| `REVIEWPLANE_LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` |
| `REVIEWPLANE_VERSION` | `0.0.0-dev` | Reported by `/version`; stamped into the image at build time |
| `REVIEWPLANE_REVISION` | `unknown` | Git revision reported by `/version` |
| `REVIEWPLANE_BUILT_AT` | `unknown` | Build instant reported by `/version` |
| `REVIEWPLANE_JOBS_HEALTH_HOST` | `0.0.0.0` | Address the `jobs` role serves its health endpoints on |
| `REVIEWPLANE_JOBS_HEALTH_PORT` | `8081` | Port the `jobs` role serves `/health/live`, `/health/ready` and `/version` on |
| `REVIEWPLANE_ORGANISATION_ID` | `org_default` | The organisation connectors enrol into; a token from another organisation is refused |
| `REVIEWPLANE_ORGANISATION_NAME` | `ReviewPlane` | Display name for that organisation |
| `REVIEWPLANE_CONNECTOR_HOST` | `0.0.0.0` | Connector listener address |
| `REVIEWPLANE_CONNECTOR_PORT` | `8443` | Connector listener port (mutually authenticated) |
| `REVIEWPLANE_CONNECTOR_PUBLIC_URL` | `wss://<first TLS host>:<port>` | Base the registration response advertises |
| `REVIEWPLANE_CONNECTOR_TLS_HOSTS` | `localhost,127.0.0.1` | Names and addresses the listener certificate covers |
| `REVIEWPLANE_CONNECTOR_TLS_CERT_FILE` | issued from the connector CA | Operator-supplied listener certificate; set with the key file |
| `REVIEWPLANE_CONNECTOR_TLS_KEY_FILE` | issued from the connector CA | Operator-supplied listener private key |
| `REVIEWPLANE_CONNECTOR_IDENTITY_TTL_DAYS` | `365` | Lifetime of an issued device identity |
| `REVIEWPLANE_ENROLMENT_TOKEN_TTL_SECONDS` | `3600` | Default enrolment-token expiry |
| `REVIEWPLANE_CONNECTOR_HEARTBEAT_INTERVAL_SECONDS` | `15` | Expected connector heartbeat interval |
| `REVIEWPLANE_CONNECTOR_DEGRADED_AFTER_SECONDS` | `45` | Silence after which `ACTIVE` becomes `DEGRADED` |
| `REVIEWPLANE_CONNECTOR_DISCONNECTED_AFTER_SECONDS` | `90` | Silence after which `DEGRADED` becomes `DISCONNECTED` |
| `REVIEWPLANE_CONNECTOR_MONITOR_INTERVAL_SECONDS` | `5` | How often the heartbeat state machine sweeps |
| `REVIEWPLANE_CONNECTOR_MINIMUM_VERSION` | `0.0.0` | Connector release below which a reconnect is classified `upgrade_required` and refused (`CONNECTOR_PROTOCOL.md` §19) |
| `REVIEWPLANE_CONNECTOR_RECOMMENDED_VERSION` | `0.0.0` | Connector release below which an upgrade is recommended; the connector logs it and keeps running |
| `REVIEWPLANE_BROWSER_WORKER_HEARTBEAT_INTERVAL_SECONDS` | `15` | Expected browser-worker heartbeat interval, advertised to the worker and used as the cadence at which its project assignment is restated (ADR-0026) |
| `REVIEWPLANE_BROWSER_WORKER_DEGRADED_AFTER_SECONDS` | `45` | Silence after which a worker becomes `degraded` and stops being counted as capacity or scheduled onto (ADR-0027) |
| `REVIEWPLANE_BROWSER_WORKER_LOST_AFTER_SECONDS` | `90` | Silence after which a worker becomes `lost` and its sessions are failed by reconciliation |
| `REVIEWPLANE_BROWSER_WORKER_MONITOR_INTERVAL_SECONDS` | `5` | How often the worker liveness sweep and the session reconciler run |

The two version settings default to `0.0.0`, so every build is `compatible` until an administrator raises them. Refusing a connector stops an environment working, which is an operator decision rather than something a default should make.

The four browser-worker settings mirror the connector's shape deliberately: one
concept of liveness in the product, so an operator who has read one has read
both (`OPERATIONS.md` §8.1). They are cross-validated at start-up — lost must
exceed degraded, and degraded must exceed the heartbeat interval, or a worker
heartbeating exactly on time would be degraded between two heartbeats. The
degraded threshold is also what `reviewplane status` uses to decide whether a
worker's capacity counts; there is one definition and the report reads it rather
than holding a second copy.

```yaml
server:
  public_url: https://app.agents.example.internal
  listen_address: 0.0.0.0:8080

authentication:
  mode: local
  session_ttl: 12h

database:
  url_file: /run/secrets/database_url

artefact_store:
  driver: filesystem
  filesystem:
    path: /var/lib/reviewplane/artefacts
  # s3:
  #   endpoint: https://s3.example.internal
  #   bucket: reviewplane
  #   access_key_file: /run/secrets/s3_access_key
  #   secret_key_file: /run/secrets/s3_secret_key

retention:
  action_screenshots: 30d
  traces: 14d
  video: disabled
  audit_events: 365d

browser:
  default_viewports:
    - 390x844
    - 1440x900
  session_ttl: 2h
  max_sessions_per_project: 4

privacy:
  telemetry: false
  persist_live_frames: false
  external_visual_analysis: disabled
```

`persist_live_frames` has no `true`: `docs/SECURITY.md` section 14 sets
`live_frames: never` and there is no code path that writes one, so the setting
records the guarantee rather than selecting between two behaviours.

### 2.1 Settings implemented today

The server reads environment variables, with a `*_FILE` variant for every
credential:

| Setting | Default | Meaning |
|---|---|---|
| `REVIEWPLANE_LISTEN_ADDRESS` | `0.0.0.0` | Listener address |
| `REVIEWPLANE_PORT` | `8080` | Listener port; reached through the gateway only |
| `REVIEWPLANE_DATABASE_URL` | none | PostgreSQL connection string |
| `REVIEWPLANE_BOOTSTRAP_TOKEN` | none | Administrator bootstrap token (`docs/ARCHITECTURE.md` section 11) |
| `REVIEWPLANE_WORKER_CREDENTIAL` | none | Credential the browser worker presents to this server |
| `REVIEWPLANE_WORKER_COMMAND_CREDENTIAL` | none | Credential this server presents to the worker |
| `REVIEWPLANE_WORKER_ENDPOINT` | `http://browser-worker:8090` | Worker's internal listener |
| `REVIEWPLANE_ARTEFACT_DRIVER` | `filesystem` | `filesystem` or `s3` (ADR-0012); anything else fails at startup |
| `REVIEWPLANE_ARTEFACT_PATH` | `/var/lib/reviewplane/artefacts` | Filesystem artefact-store root (ADR-0012) |
| `REVIEWPLANE_ARTEFACT_MAX_BYTES` | `20971520` | Largest artefact accepted |
| `REVIEWPLANE_S3_ENDPOINT` | none | `s3` driver only; required when the driver is `s3` |
| `REVIEWPLANE_S3_BUCKET` | none | `s3` driver only; required |
| `REVIEWPLANE_S3_REGION` | `us-east-1` | `s3` signing region |
| `REVIEWPLANE_S3_ACCESS_KEY` | none | `s3` driver only; required; supports the `_FILE` form |
| `REVIEWPLANE_S3_SECRET_KEY` | none | `s3` driver only; required; supports the `_FILE` form |
| `REVIEWPLANE_S3_PATH_STYLE` | `true` | Path-style addressing, which most self-hosted services need |
| `REVIEWPLANE_S3_PREFIX` | empty | Key prefix inside a shared bucket |
| `REVIEWPLANE_RETENTION_ACTION_SCREENSHOTS_DAYS` | `30` | Window used to compute `expires_at`; `0` sets none |
| `REVIEWPLANE_RETENTION_BROWSER_TRACES_DAYS` | `14` | As above |
| `REVIEWPLANE_RETENTION_SESSION_VIDEO_DAYS` | `0` | As above; `0` is the sample configuration's `video: disabled` |
| `REVIEWPLANE_RETENTION_CONSOLE_AND_NETWORK_LOGS_DAYS` | `14` | As above |
| `REVIEWPLANE_RETENTION_VERIFICATION_EVIDENCE_DAYS` | `365` | As above |

The retention windows are used to record `expires_at` on an artefact when its
upload intent is created. **Nothing deletes an artefact when that date passes**:
retention enforcement is a later stage, so these settings decide what the record
says is due and not what the product removes.
| `REVIEWPLANE_WORKER_REQUEST_TIMEOUT_MS` | `150000` | Bound on one worker request |
| `REVIEWPLANE_ALLOWED_ORIGINS` | empty | Comma-separated origins a browser may use. See below: the two surfaces that read it read it differently |
| `REVIEWPLANE_SECURE_COOKIES` | `true` | Whether the session and CSRF cookies are marked `Secure`. Set to `false` only for plain-HTTP local development |
| `REVIEWPLANE_SERVE_RUNS_JOBS` | `true` | Whether `reviewplane serve` runs the jobs role beside the API. A deployment with its own `jobs` container sets `false` (`docs/ARCHITECTURE.md` section 4.2) |
| `REVIEWPLANE_STATUS_TLS_ENDPOINT` | none | `host:port` whose certificate expiry `reviewplane status` reports. Unset means the section reports "not configured" rather than a failure (`docs/OPERATIONS.md` section 3) |
| `REVIEWPLANE_CONNECTOR_CA_EXPORT_FILE` | none | Where the connector authority's **certificate** is written at startup, for the tunnel gateway to read (ADR-0014). The private key is never written |

#### What `REVIEWPLANE_ALLOWED_ORIGINS` actually does

Two surfaces read it, and an empty value means something different to each.

| Surface | Configured origins | Empty |
|---|---|---|
| Live WebSocket upgrade (`docs/API.md` §18.2) | An `Origin` not on the list is refused | **Any** `Origin` is refused; only a request that sends none — a non-browser client — is accepted |
| Sign-in routes (`docs/API.md` §4.0) | An `Origin` not on the list is refused | **No origin check is applied**; the `SameSite=Strict` session cookie is what stops a forged sign-in being useful |

A deployment that serves the web application should therefore set it to the
origin the application is served from. Leaving it empty leaves the live channel
usable only by non-browser clients, and leaves the sign-in routes relying on
`SameSite` alone.

Local accounts need no configuration. `authentication.mode: local` above describes
what the deployment does, and the administrator's credential is established once
from a token an operator mints with `reviewplane install-token`
(`docs/DEPLOYMENT.md` section 11) rather than from a setting: a password in an
environment variable would be a password in a process listing, a shell history
and every `docker inspect`. `authentication.session_ttl` is twelve hours and is
not yet configurable.

## 3. Browser-worker configuration

```yaml
worker:
  name: browser-worker-01
  capacity: 4
  labels:
    - chromium
    - standard

chromium:
  executable: bundled
  sandbox: required
  default_timeout: 30s

streaming:
  thumbnail_fps: 3
  live_fps_max: 20
  jpeg_quality: 70

limits:
  session_memory_mb: 2048
  session_duration: 2h
  screenshot_max_bytes: 20MB
```

### 3.1 Settings implemented today

The worker reads environment variables, with a `*_FILE` variant for every credential:

| Setting | Default | Meaning |
|---|---|---|
| `REVIEWPLANE_WORKER_NAME` | `browser-worker-01` | Operator-assigned worker name |
| `REVIEWPLANE_WORKER_LISTEN_ADDRESS` | `127.0.0.1` | Internal listener address |
| `REVIEWPLANE_WORKER_PORT` | `8090` | Internal listener port; never published to the host |
| `REVIEWPLANE_WORKER_CAPACITY` | `4` | Concurrent sessions before `BROWSER_CAPACITY_EXHAUSTED` |
| `REVIEWPLANE_WORKER_LABELS` | `chromium` | Comma-separated scheduling labels |
| `REVIEWPLANE_WORKER_SANDBOX` | `required` | `required`, or `disabled_high_risk` to accept the section 10 warning |
| `REVIEWPLANE_WORKER_SESSION_ROOT` | `/var/lib/reviewplane/browser-sessions` | Parent of the per-session ephemeral profile directories |
| `REVIEWPLANE_CONTROL_PLANE_URL` | `http://api:8080` | Control-plane API base URL |
| `REVIEWPLANE_WORKER_CREDENTIAL` | none | Credential the worker presents to the control plane |
| `REVIEWPLANE_WORKER_COMMAND_CREDENTIAL` | none | Credential the control plane must present to the worker |
| `REVIEWPLANE_WORKER_DEFAULT_TIMEOUT_MS` | `30000` | Timeout for a command that states none |
| `REVIEWPLANE_WORKER_MAX_COMMAND_TIMEOUT_MS` | `120000` | Upper bound on any command timeout |
| `REVIEWPLANE_WORKER_SESSION_DURATION_SECONDS` | `7200` | Wall-clock session lifetime the worker enforces itself |
| `REVIEWPLANE_WORKER_SCREENSHOT_MAX_BYTES` | `20971520` | Largest capture the worker will upload |
| `REVIEWPLANE_WORKER_SNAPSHOT_MAX_NODES` | `400` | Largest number of elements a snapshot may describe |
| `REVIEWPLANE_WORKER_SNAPSHOT_MAX_BYTES` | `32768` | Largest rendered snapshot before truncation |
| `REVIEWPLANE_WORKER_HEARTBEAT_SECONDS` | `15` | Heartbeat interval |
| `REVIEWPLANE_INTERNAL_SUFFIX` | `internal.invalid` | Domain the internal origins live under |
| `REVIEWPLANE_TUNNEL_GATEWAY_ADDRESS` | none | `host:port` every `*.<suffix>` name resolves to (ADR-0015) |
| `REVIEWPLANE_TUNNEL_CERTIFICATE_SPKI` | none | Base64 SHA-256 of the gateway certificate's SubjectPublicKeyInfo (ADR-0015) |

The last two are set together or not at all: the worker refuses to start with one and not the other, because a resolver rule without a pin would trust whatever certificate the gateway offered and a pin without a rule would resolve nothing. A worker with neither can reach no published service, which is the correct default. The pin is a digest of a public key and is deployment data rather than a secret; ADR-0015 records how to compute it.

The two credentials have no defaults: the worker refuses to start without them. `disabled_high_risk` is the only way to disable the Chromium sandbox, and it logs the unsupported-configuration warning at startup. Limits requested by the control plane are clamped to these values rather than widening them, so a session cannot ask the worker to exceed what the operator configured.

The control plane reads `REVIEWPLANE_WORKER_CREDENTIAL`, `REVIEWPLANE_WORKER_COMMAND_CREDENTIAL`, `REVIEWPLANE_WORKER_ENDPOINT`, `REVIEWPLANE_ARTEFACT_PATH`, `REVIEWPLANE_ARTEFACT_MAX_BYTES` and `REVIEWPLANE_WORKER_REQUEST_TIMEOUT_MS` alongside the settings of §2, each with the same `*_FILE` support. Its listen address is `REVIEWPLANE_HOST`, which is the name §2 gives it; there is no separate `REVIEWPLANE_LISTEN_ADDRESS`.

| Setting | Default | Meaning |
|---|---|---|
| `REVIEWPLANE_ALLOCATION_DEADLINE_SECONDS` | `120` | How long a browser-session reservation that has asked to be admitted to a route may live before the control plane fails it |

A reservation is `REQUESTED` with `ended_at IS NULL`, which is exactly what the
worker capacity query counts, so one that nothing can complete would hold a
browser slot indefinitely — and four of them fill a default worker. The deadline
is the mechanism and the sweep is only what notices it (ADR-0037). It is measured
from when admission was asked for and never from when the session was reserved: a
reservation waits for a route to be published against it, and a deadline running
from creation would fail the allocation at the moment the agent finally asked.
Raise it only where a browser worker is genuinely slower than two minutes to open
a context; lowering it below the time a Chromium context takes turns a working
allocation into a refusal.

It bounds only reservations this path creates. One made through
`POST /api/v1/projects/:projectId/browser-sessions` with `{"allocate": false}`
and **no** route has no lifetime and holds its slot until a human ends it.

### 3.1 MCP-server environment

The agent-facing process (`docs/ARCHITECTURE.md` section 4.4, ADR-0020) is
configured separately, because it is a separate process:

| Variable | Default | Meaning |
|---|---|---|
| `REVIEWPLANE_MCP_LISTEN_ADDRESS` | `0.0.0.0` | Listener address; reached through the gateway only |
| `REVIEWPLANE_MCP_PORT` | `8081` | Listener port |
| `REVIEWPLANE_MCP_PATH` | `/mcp/v1` | Endpoint route. It must start with `/mcp/` (`docs/API.md` section 3) |
| `REVIEWPLANE_DATABASE_URL` | none | Same database as the control plane |
| `REVIEWPLANE_WORKER_COMMAND_CREDENTIAL` | none | Credential presented to the worker for a capture |
| `REVIEWPLANE_WORKER_ENDPOINT` | `http://browser-worker:8090` | Worker's internal listener |
| `REVIEWPLANE_ARTEFACT_PATH` | `/var/lib/reviewplane/artefacts` | Artefact store, mounted read-only |
| `REVIEWPLANE_API_PATH_PREFIX` | `/api/v1` | Prefix used to build the evidence path an agent fetches |
| `REVIEWPLANE_TUNNEL_CONTROL_URL` | `http://tunnel-gateway:8445` | Gateway control listener, for `development_service_unpublish` |
| `REVIEWPLANE_TUNNEL_CONTROL_TOKEN` | none | This process's own control credential. It carries `route:revoke` and `capability:revoke` and nothing else (§4.1, ADR-0038), so the gateway refuses a registration presented with it. |
| `REVIEWPLANE_INTERNAL_SUFFIX` | `internal.invalid` | Domain the internal origins live under; must match the control plane's |
| `REVIEWPLANE_ROUTE_TTL_MAX_SECONDS` | `28800` | Longest route lifetime `development_service_publish` may request |
| `REVIEWPLANE_MCP_PUBLISH_WAIT_MS` | `15000` | How long `development_service_publish` waits for a requested route to become ready or failed |
| `REVIEWPLANE_MCP_ALLOCATE_WAIT_MS` | `30000` | How long `browser_session_allocate` waits for the control-plane API to finish an allocation it requested |

The tunnel-control pair is what makes `development_service_unpublish` a
revocation rather than a note in the database. The gateway verifies a route
capability from its signature without a database read, so a record marked
revoked while the gateway still carried the route would withdraw nothing. This
process reaches that listener and nothing else on the tunnel network: it holds
no connector control channel, and a publication it requests is completed by the
control-plane API (ADR-0021). `REVIEWPLANE_MCP_PUBLISH_WAIT_MS` bounds the wait
for that completion and never shortens it into a false answer — a route still
`requested` when it expires is reported as `requested`.

`REVIEWPLANE_MCP_ALLOCATE_WAIT_MS` is the same arrangement one layer down
(ADR-0037). Admitting a browser session to a route mints a session-scoped
capability, so the MCP endpoint records the request and the control-plane API
completes it. It is longer than the publication wait because what it waits for is
a Chromium context coming up rather than a connector answering, and it ends in
the record as it stands for the same reason: a session still `REQUESTED` or
`ALLOCATING` when it expires is reported as such and never as ready.

It deliberately does **not** read `REVIEWPLANE_BOOTSTRAP_TOKEN`, and it holds no
capability signing key. The agent-facing process has no administrative work to
do, and a process that cannot read an administrator credential cannot leak one;
minting binds a route to a browser session and this process drives none, so it
cannot mint either (ADR-0021). It does not run migrations either: the
control-plane server owns the schema, and two processes racing to migrate one
database is a failure mode with no upside.

### 3.2 Edge-gateway environment

The edge gateway (`docs/ARCHITECTURE.md` section 4.1) is the only component that
publishes a host port. It holds no credential and reaches no database, so its
whole configuration is where it listens and what it serves TLS with:

| Variable | Default | Meaning |
|---|---|---|
| `REVIEWPLANE_GATEWAY_DOMAIN` | `localhost` | The name the site is served under |
| `REVIEWPLANE_GATEWAY_PORT` | `8443` | Host port the container's 8443 is published on |
| `REVIEWPLANE_GATEWAY_TLS` | `internal` | What terminates TLS |

`REVIEWPLANE_GATEWAY_DOMAIN` MUST name the host the product is reached at. It is
not decoration: a site address that names no host binds the port and gives the
certificate authority no subject to issue for, so every TLS handshake ends in an
internal-error alert and no request is ever routed. The default is `localhost`,
which Caddy's internal authority issues for and which a single-host install
answers on. Set it together with `REVIEWPLANE_PUBLIC_ORIGIN`, which the control
plane reads as the origin a live WebSocket may be opened from (§2): a
deployment where the two disagree serves a page the API then refuses.

`REVIEWPLANE_GATEWAY_TLS` takes one of three forms:

- `internal` — Caddy's own certificate authority. A fresh install is HTTPS
  before an operator has obtained a certificate, at the cost of a warning until
  the authority's root is trusted. This is the Stage 0 default.
- two paths, separated by a space — a certificate and its private key, mounted
  into the container. This is the form a deployment with its own certificate
  uses.
- an email address — an ACME account, for a publicly resolvable host.

An operator who terminates TLS in front of the container puts their own proxy
there instead; nothing in this file has to change for that, because the gateway
is then reached over the internal network rather than the published port.

## 4. Tunnel-gateway configuration

```yaml
tunnel:
  listen_address: 0.0.0.0:8443           # browser-facing; the only published listener
  connector_listen_address: 0.0.0.0:8444 # connector data channels, mutual TLS
  admin_listen_address: 127.0.0.1:8445   # control API and metrics
  internal_suffix: internal.invalid
  route_ttl_max: 8h
  max_routes_per_connector: 10
  max_streams_per_connector: 256
  max_streams_per_route: 64
  max_stream_bytes: 64MB
  stream_max_lifetime: 8h                # absolute bound; always clipped to the route's expiry
  stream_idle_timeout: 60s               # no progress on a request/response stream
  upgrade_idle_timeout: 15m              # no progress on an upgraded connection
  sweep_interval: 5s
  relay_buffer_bytes: 32768
  revocation_journal_path: /var/lib/reviewplane/tunnel/revocations.jsonl
  allowed_hosts:
    - 127.0.0.1
    - ::1
  allowed_ports:
    - 3000-3999
    - 4321
    - 5173
  allowed_protocols:
    - http
  host_header_mode: upstream             # or original
  forwarded_header_mode: standard        # or none
  identity_source: subject_common_name   # or uri_san
```

Settings are supplied as `REVIEWPLANE_TUNNEL_`-prefixed environment variables, with the `_FILE` form of §7 for the control credentials, the capability signing keys and the TLS material. Every setting is validated at startup and every problem is reported together.

### 4.1 Control credentials

`REVIEWPLANE_TUNNEL_CONTROL_CREDENTIALS` (or its `_FILE` form) is a JSON array naming who may call the gateway's control API, what each of them may do, and which organisations each may act for (ADR-0038). There is deliberately **no** single-token form: a shared unscoped token is what RVP-76 recorded as the defect, and a setting that could express one in a line would be used.

```json
[
  { "id": "api", "secret": "…",
    "operations": ["route:register", "route:read", "route:revoke",
                   "connector:revoke", "capability:revoke", "metrics:read"],
    "organisations": ["*"] },
  { "id": "mcp", "secret": "…",
    "operations": ["route:revoke", "capability:revoke"] }
]
```

| Member | Meaning |
|---|---|
| `id` | The credential's name. Not a secret; it appears in every audit record the credential produces, and it is how an operator answers "which process did this". |
| `secret` | The bearer value, at least 32 characters. Compared in constant time, never logged, never echoed in an error body. |
| `operations` | A closed set: `route:register`, `route:read`, `route:revoke`, `connector:revoke`, `capability:revoke`, `metrics:read`. An unknown name is a startup error; an empty set is refused. |
| `organisations` | The tenancy the credential may act for. `["*"]`, or an absent member, means every organisation. |

The gateway MUST refuse to start on a set with no credential, a credential with no operation, a secret shorter than 32 characters, two credentials sharing a name, or two credentials sharing a secret. The last is not fussiness: two principals sharing a secret is one principal with two names, and it would make the audit trail's attribution a guess.

Each calling process reads only its own secret, through `REVIEWPLANE_TUNNEL_CONTROL_TOKEN_FILE`. The set — which states the authority — is read by the gateway alone.

### 4.2 The revocation journal

`revocation_journal_path` is where the gateway records what it has revoked, so that a withdrawal survives the process. It defaults to `/var/lib/reviewplane/tunnel/revocations.jsonl` and MUST be on durable storage that the gateway can write; a gateway that cannot open it does not start, and a revocation it cannot write is refused rather than reported as done (ADR-0038).

It is the only state the gateway keeps. It holds no route registrations — routes are the control plane's to re-register, and a gateway that resurrected them from its own file would carry traffic nobody had asked it to carry.

The three lifetime settings are not interchangeable, and `CONNECTOR_PROTOCOL.md` §13.3 records why. `stream_max_lifetime` is a backstop whose default equals `route_ttl_max`, so a stream is normally bounded by its route rather than by a clock; the idle timeouts are what close a stalled or abandoned stream. There are two of them because a request/response stream and an upgraded connection mean different things by silence: an editing pause on a hot-reload WebSocket is normal, and a minute of silence in the middle of an HTTP exchange is not. Setting `stream_max_lifetime` low is not a substitute for either, and MUST NOT be used as one: it would cut a server-sent-event stream or a working hot-reload connection.

It must not contain a setting that trivially enables unrestricted proxying without an explicit high-risk mode and warning. Two settings widen the destination policy — `allow_non_loopback_destinations` and `allow_link_local_destinations` — and both default to false, are named for what they do and produce a startup warning naming what was widened. Neither lifts the bar on cloud metadata endpoints, which are refused ahead of the allow-list so that naming one in `allowed_hosts` cannot re-enable it.

The control listener defaults to loopback: `SECURITY.md` §4 lists administrator misconfiguration exposing internal services as a primary threat, and the route-registration API is the most valuable thing the gateway exposes.

## 5. Connector configuration

See `CONNECTOR_PROTOCOL.md` for the full example.

Key areas:

- Control-plane URL
- Identity storage
- Explicit workspaces
- Git-context observation interval
- Allowed local hosts and ports
- Privacy reporting
- Logging
- Proxy and certificate trust

The full example is maintained as a file the connector's own test suite parses,
`services/connector/packaging/config.example.yaml`, so it cannot drift from the
parser. `CONNECTOR_PROTOCOL.md` §20 reproduces it.

### 5.1 Publication settings

The `publication` block is what the connector enforces on a `route.publish`, independently of the control plane and of the tunnel gateway (`CONNECTOR_PROTOCOL.md` §11).

| Setting | Default | Meaning |
|---|---|---|
| `publication.allowed_hosts` | `127.0.0.1`, `::1` | Literal addresses a route may target. A host name is refused at load, never resolved at publication. |
| `publication.allowed_ports` | `3000-3999`, `4321`, `5173` | Port ranges a route may target |
| `publication.max_routes` | `10` | Concurrent routes this connector will carry |
| `publication.allowed_projects` | the projects named in `workspaces` | Projects a publication may name |
| `workspaces[].id` | none | The workspace identifier a publication may name, and the identifier an observation reports (`CONNECTOR_PROTOCOL.md` §9). It is configured rather than discovered. |

Omitting a setting selects the default, which is the narrowest option — never the widest. `SECURITY.md` §9 requires deny by default, and a configuration file that leaves a block out MUST NOT be the most permissive configuration of the connector.

### 5.2 Workspace and Git-context settings

The `workspaces` block names the only paths the connector ever looks at, and `git_context` says how often it looks (`CONNECTOR_PROTOCOL.md` §9, ADR-0022).

| Setting | Default | Meaning |
|---|---|---|
| `workspaces[].path` | none | Absolute path to a checkout. Required, and refused if relative. |
| `workspaces[].project` | none | The project an observation of this checkout is attributed to |
| `git_context.interval` | `30s` | How often branch, head commit and dirty state are re-read. Between `5s` and `1h`. |

An entry missing `id` or `project` is skipped with a warning naming which entry it was, rather than being reported under a guess: a publication names both.

Omitting the `workspaces` block entirely means the connector reports no workspace context. It does **not** mean the connector goes looking for checkouts; there is no configuration under which it does.

Bounds rather than quoted requirements: below 5 seconds the connector would run `git` more or less continuously on somebody's development machine, and above an hour an operator has effectively turned the feature off and should say so by removing the `workspaces` block.

### 5.3 Privacy settings

Three settings exist and all three MUST be `false`. Each is refused at startup with a message naming precisely what this build cannot do, because "not supported" would leave an operator unable to tell a missing feature from a rejected one.

| Setting | Default | Why `true` is refused |
|---|---|---|
| `privacy.report_changed_paths` | `false` | The version 1 `workspace_observation` payload reports `dirty` as a boolean and has no member that can carry a changed-path list |
| `privacy.report_process_details` | `false` | A heartbeat's resource summary permits only `load` and `memory_available_bytes` (`CONNECTOR_PROTOCOL.md` §8) |
| `privacy.discover_workspaces` | `false` | The `workspaces` block is observed either way; bounded root scanning for unlisted checkouts is not implemented |

They are refused rather than ignored on the principle of §1: a setting accepted and then not honoured would tell an operator their privacy policy had been applied when nothing about what is reported had changed.

## 6. Feature flags

Feature flags are namespaced:

```yaml
features:
  human_takeover: true
  session_video: false
  external_visual_analysis: false
```

Security controls must not be hidden behind ambiguous flags.

## 7. Secret files

Secret material is mounted as a file and is never passed as an environment
value. Every service reads its secrets through a `*_FILE` setting, and a value
that cannot be read is a startup error naming the setting and the path.

The eleven `deploy/compose/compose.yaml` declares (`docs/DEPLOYMENT.md` §7), all
created by `deploy/compose/configure`:

```text
/run/secrets/database_url
/run/secrets/postgres_password
/run/secrets/bootstrap_token
/run/secrets/worker_credential
/run/secrets/worker_command_credential
/run/secrets/capability_signing_key
/run/secrets/capability_keys
/run/secrets/tunnel_control_token_api          # read by `api`
/run/secrets/tunnel_control_token_mcp          # read by `mcp`
/run/secrets/tunnel_control_credentials        # read by `tunnel-gateway`
/run/secrets/enrolment_token          # development profile; created empty
```

The three tunnel-control files are one arrangement, not three secrets. Each
calling process reads its own bearer value; the gateway reads the set that says
what each of those values may do and which organisations it may act for (§4.1,
ADR-0038). A deployment that gave both processes one file would be back to a
credential whose authority nobody can state and whose actions the audit trail
cannot attribute.

`enrolment_token` is the one that is not a generated value: an enrolment token is
issued by the running control plane, and only the `development` profile's
`dev-fixture` mounts it. The file is created empty because Compose refuses to
start a stack whose declared secret file is missing, whether or not anything
reads it.

With the `s3` artefact driver, which is Stage 2:

```text
/run/secrets/s3_access_key
/run/secrets/s3_secret_key
```

There is no `session_signing_key`. Human sessions are opaque random identifiers
whose digests live in PostgreSQL (`docs/SECURITY.md` §6.1), so nothing signs a
session and a key for it would be a secret with no reader.

## 8. Configuration compatibility

- Additive settings receive safe defaults
- Removed settings produce explicit startup errors for at least one major release
- `reviewplane config validate` checks configuration without starting services
- `reviewplane config effective` prints redacted resolved configuration
