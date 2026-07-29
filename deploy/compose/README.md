# Docker Compose Deployment

This directory will contain the supported single-host deployment.

Planned files:

```text
compose.yaml
compose.override.example.yaml
.env.example
Caddyfile
configure
reviewplane
backup
restore
upgrade
secrets/
```

Requirements and security constraints are defined in:

- `../../docs/DEPLOYMENT.md`
- `../../docs/CONFIGURATION.md`
- `../../docs/SECURITY.md`
- `../../docs/OPERATIONS.md`

The initial implementation must preserve these rules:

- Only the gateway publishes host ports by default.
- Chromium runs in `browser-worker`, not the API container.
- The API container does not mount the Docker socket.
- PostgreSQL and object storage are private services.
- Secrets are mounted as files where possible.
- Images are pinned to release versions or digests.
