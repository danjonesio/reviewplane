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
