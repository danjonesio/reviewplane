# Configuration Reference

## 1. Configuration principles

- Validate at startup
- Fail clearly on unknown or invalid settings
- Keep secrets out of ordinary environment variables where possible
- Support mounted configuration files
- Publish defaults and security implications
- Version configuration when semantics change

## 2. Server configuration areas

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
| `REVIEWPLANE_ARTEFACT_PATH` | `/var/lib/reviewplane/artefacts` | Filesystem artefact-store root (ADR-0012) |
| `REVIEWPLANE_ARTEFACT_MAX_BYTES` | `20971520` | Largest artefact accepted |
| `REVIEWPLANE_WORKER_REQUEST_TIMEOUT_MS` | `150000` | Bound on one worker request |
| `REVIEWPLANE_ALLOWED_ORIGINS` | empty | Comma-separated origins a browser may open the live WebSocket from (ADR-0014). Empty accepts a request with no `Origin`, which is a non-browser client |
| `REVIEWPLANE_SECURE_COOKIES` | `true` | Whether the viewer session cookie is marked `Secure`. Set to `false` only for plain-HTTP local development |

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

The control plane reads `REVIEWPLANE_LISTEN_ADDRESS`, `REVIEWPLANE_PORT`, `REVIEWPLANE_DATABASE_URL`, `REVIEWPLANE_BOOTSTRAP_TOKEN`, `REVIEWPLANE_WORKER_CREDENTIAL`, `REVIEWPLANE_WORKER_COMMAND_CREDENTIAL`, `REVIEWPLANE_WORKER_ENDPOINT`, `REVIEWPLANE_ARTEFACT_PATH` and `REVIEWPLANE_ARTEFACT_MAX_BYTES`, each with the same `*_FILE` support.

## 4. Tunnel-gateway configuration

```yaml
tunnel:
  listen_address: 0.0.0.0:8443
  route_ttl_max: 8h
  max_streams_per_connector: 256
  max_bytes_per_second: 100MB
  allowed_protocols:
    - http
    - https
    - websocket
```

It must not contain a setting that trivially enables unrestricted proxying without an explicit high-risk mode and warning.

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
