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
| `REVIEWPLANE_CONTROL_PLANE_URL` | `http://server:8080` | Control-plane API base URL |
| `REVIEWPLANE_WORKER_CREDENTIAL` | none | Credential the worker presents to the control plane |
| `REVIEWPLANE_WORKER_COMMAND_CREDENTIAL` | none | Credential the control plane must present to the worker |
| `REVIEWPLANE_WORKER_DEFAULT_TIMEOUT_MS` | `30000` | Timeout for a command that states none |
| `REVIEWPLANE_WORKER_MAX_COMMAND_TIMEOUT_MS` | `120000` | Upper bound on any command timeout |
| `REVIEWPLANE_WORKER_SESSION_DURATION_SECONDS` | `7200` | Wall-clock session lifetime the worker enforces itself |
| `REVIEWPLANE_WORKER_SCREENSHOT_MAX_BYTES` | `20971520` | Largest capture the worker will upload |
| `REVIEWPLANE_WORKER_SNAPSHOT_MAX_NODES` | `400` | Largest number of elements a snapshot may describe |
| `REVIEWPLANE_WORKER_SNAPSHOT_MAX_BYTES` | `32768` | Largest rendered snapshot before truncation |
| `REVIEWPLANE_WORKER_HEARTBEAT_SECONDS` | `15` | Heartbeat interval |

The two credentials have no defaults: the worker refuses to start without them. `disabled_high_risk` is the only way to disable the Chromium sandbox, and it logs the unsupported-configuration warning at startup. Limits requested by the control plane are clamped to these values rather than widening them, so a session cannot ask the worker to exceed what the operator configured.

The control plane reads `REVIEWPLANE_WORKER_CREDENTIAL`, `REVIEWPLANE_WORKER_COMMAND_CREDENTIAL`, `REVIEWPLANE_WORKER_ENDPOINT`, `REVIEWPLANE_ARTEFACT_PATH`, `REVIEWPLANE_ARTEFACT_MAX_BYTES` and `REVIEWPLANE_WORKER_REQUEST_TIMEOUT_MS` alongside the settings of §2, each with the same `*_FILE` support. Its listen address is `REVIEWPLANE_HOST`, which is the name §2 gives it; there is no separate `REVIEWPLANE_LISTEN_ADDRESS`.

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
  stream_ttl: 60s
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

Settings are supplied as `REVIEWPLANE_TUNNEL_`-prefixed environment variables, with the `_FILE` form of §7 for the control-plane token, the capability signing keys and the TLS material. Every setting is validated at startup and every problem is reported together.

It must not contain a setting that trivially enables unrestricted proxying without an explicit high-risk mode and warning. Two settings widen the destination policy — `allow_non_loopback_destinations` and `allow_link_local_destinations` — and both default to false, are named for what they do and produce a startup warning naming what was widened. Neither lifts the bar on cloud metadata endpoints, which are refused ahead of the allow-list so that naming one in `allowed_hosts` cannot re-enable it.

The control listener defaults to loopback: `SECURITY.md` §4 lists administrator misconfiguration exposing internal services as a primary threat, and the route-registration API is the most valuable thing the gateway exposes.

## 5. Connector configuration

See `CONNECTOR_PROTOCOL.md` for the full example.

Key areas:

- Control-plane URL
- Identity storage
- Explicit workspaces
- Allowed local hosts and ports
- Privacy reporting
- Logging
- Proxy and certificate trust

### 5.1 Publication settings

The `publication` block is what the connector enforces on a `route.publish`, independently of the control plane and of the tunnel gateway (`CONNECTOR_PROTOCOL.md` §11).

| Setting | Default | Meaning |
|---|---|---|
| `publication.allowed_hosts` | `127.0.0.1`, `::1` | Literal addresses a route may target. A host name is refused at load, never resolved at publication. |
| `publication.allowed_ports` | `3000-3999`, `4321`, `5173` | Port ranges a route may target |
| `publication.max_routes` | `10` | Concurrent routes this connector will carry |
| `publication.allowed_projects` | the projects named in `workspaces` | Projects a publication may name |
| `workspaces[].id` | none | The workspace identifier a publication may name. Discovery is Stage 1, so it is configured until then. |

Omitting a setting selects the default, which is the narrowest option — never the widest. `SECURITY.md` §9 requires deny by default, and a configuration file that leaves a block out MUST NOT be the most permissive configuration of the connector.

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

Preferred:

```text
/run/secrets/database_url
/run/secrets/session_signing_key
/run/secrets/s3_access_key    # s3 artefact driver only
/run/secrets/s3_secret_key    # s3 artefact driver only
```

Services should support `*_FILE` settings for secret material.

## 8. Configuration compatibility

- Additive settings receive safe defaults
- Removed settings produce explicit startup errors for at least one major release
- `reviewplane config validate` checks configuration without starting services
- `reviewplane config effective` prints redacted resolved configuration
