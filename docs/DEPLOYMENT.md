# Deployment

## 1. Supported deployment order

1. Single-host Docker Compose
2. Docker Compose with external PostgreSQL and object storage
3. Dedicated remote browser-worker nodes
4. Helm chart and Kubernetes
5. Air-gapped enterprise bundle

Docker Compose is the first-class deployment and must remain fully supported.

## 2. Packaging

Publish versioned OCI images:

```text
ghcr.io/<org>/reviewplane-server:<version>
ghcr.io/<org>/reviewplane-browser-worker:<version>
ghcr.io/<org>/reviewplane-tunnel-gateway:<version>
ghcr.io/<org>/reviewplane-connector:<version>
```

The server image may run different commands:

```text
reviewplane-server api
reviewplane-server mcp
reviewplane-server jobs
```

Connector releases should also include signed native binaries and packages.

## 3. Default Compose stack

```yaml
services:
  gateway:
    image: caddy:<pinned>
    ports:
      - "80:80"
      - "443:443"

  api:
    image: ghcr.io/example/reviewplane-server:${REVIEWPLANE_VERSION}
    command: ["reviewplane-server", "api"]

  mcp:
    image: ghcr.io/example/reviewplane-server:${REVIEWPLANE_VERSION}
    command: ["reviewplane-server", "mcp"]

  jobs:
    image: ghcr.io/example/reviewplane-server:${REVIEWPLANE_VERSION}
    command: ["reviewplane-server", "jobs"]

  tunnel-gateway:
    image: ghcr.io/example/reviewplane-tunnel-gateway:${REVIEWPLANE_VERSION}

  browser-worker:
    image: ghcr.io/example/reviewplane-browser-worker:${REVIEWPLANE_VERSION}

  postgres:
    image: postgres:<supported-pinned-version>

  minio:
    image: minio/minio:<supported-pinned-version>
```

Production files must pin exact supported versions or immutable digests. Examples may use placeholders until release automation exists.

## 4. Networks

Recommended:

```text
edge     gateway, api, mcp
auth     gateway, api, mcp
data     api, jobs, postgres, minio
control  api, mcp, jobs, tunnel-gateway, browser-worker
browser  browser-worker, tunnel-gateway
```

Only the gateway publishes host ports by default.

PostgreSQL, MinIO administrative ports, browser debugging ports and tunnel internals remain private.

## 5. Volumes

```text
postgres_data
object_data
gateway_data
```

Browser profiles use ephemeral container storage unless project policy enables reusable authentication state.

## 6. Compose profiles

Recommended profiles:

- `observability`
- `antivirus`
- `development`
- `external-storage`
- `remote-worker`

The default installation must not require optional profiles.

## 7. Configuration

Configuration priority:

1. Command-line flags for one-off administrative commands
2. Mounted configuration file
3. Secret files
4. Environment variables for non-secret deployment values
5. Built-in defaults

Secrets should be mounted as files where possible.

Example:

```yaml
secrets:
  database_password:
    file: ./secrets/database_password
  session_signing_key:
    file: ./secrets/session_signing_key
```

## 8. Initial installation

### Manual path

```bash
git clone <release-or-deployment-repository>
cd deploy/compose
cp .env.example .env
./configure
docker compose config
docker compose pull
docker compose up -d
./reviewplane status
```

### Installer path

A convenience installer may:

1. Validate Docker Engine and Compose
2. Create installation directory
3. Generate keys and secret files
4. Write pinned version configuration
5. Pull images
6. Start services
7. Wait for readiness
8. Print setup URL and one-time administrator token

The manual path remains fully documented.

## 9. Resource guidance

Initial guidance for a personal deployment:

- 4 vCPU minimum
- 8 vCPU recommended with active browser sessions
- 8 GB RAM minimum
- 16 GB RAM recommended
- SSD storage
- Additional memory per concurrent Chromium session

Exact browser capacity must be measured and published per release.

## 10. TLS and DNS

Supported modes:

- Bundled Caddy with internal or public certificate automation
- Existing reverse proxy terminating TLS
- Private PKI

Required hostnames may include:

```text
app.agents.example.internal
mcp.agents.example.internal
connect.agents.example.internal
```

Internal browser-route origins should not require public DNS.

## 11. External PostgreSQL

Requirements:

- Supported major version
- TLS recommended
- Dedicated database and role
- Migration permission
- Connection pool sized to deployment
- Backups managed by operator or included tooling

The application must expose a migration command and readiness must fail when required migrations are missing.

## 12. External object storage

Requirements:

- S3-compatible API
- Private bucket
- Server-side encryption recommended
- Lifecycle rules coordinated with application retention
- Multipart upload support for large traces and videos
- CORS configured only when direct browser upload is used

Application metadata remains authoritative for artefact availability.

## 13. Connector installation

Linux example:

```bash
sudo install -m 0755 reviewplane-connector /usr/local/bin/reviewplane-connector
sudo mkdir -p /etc/reviewplane-connector /var/lib/reviewplane-connector
sudo install -m 0644 packaging/systemd/reviewplane-connector.service \
  /etc/systemd/system/reviewplane-connector.service
sudo systemctl daemon-reload
sudo systemctl enable --now reviewplane-connector
```

Enrol:

```bash
sudo reviewplane-connector enrol \
  --control-plane https://connect.agents.example.internal \
  --token-file /root/reviewplane-enrolment-token
```

The token file should be deleted after successful enrolment.

## 14. Remote browser workers

Later deployment:

```text
Control-plane host
  <- outbound worker registration
Dedicated browser host
  - browser-worker service
  - no database credentials
  - session-scoped object upload credentials
```

Workers advertise labels and capacity. The control plane schedules sessions and issues short-lived credentials.

## 15. Upgrades

Required sequence:

1. Read release notes
2. Create backup
3. Validate free storage
4. Pull pinned images
5. Run preflight compatibility check
6. Apply database migration
7. Restart services in documented order
8. Verify health and migration status
9. Retain rollback artefacts until validation completes

Database migrations must state whether downgrade is supported.

## 16. Backups

Supported command concept:

```bash
./reviewplane backup --output /backup/reviewplane-2026-07-28.tar.zst
```

Backup manifest contains:

- Product version
- Schema version
- PostgreSQL dump
- Object inventory or object data according to mode
- Configuration excluding secret values where possible
- Encryption key references
- Checksums

A portable backup that includes key material must require explicit opt-in and strong warning.

## 17. Restore

Restore must support:

- Empty installation
- Compatibility validation
- Integrity check
- Dry run
- New hostname configuration
- Re-encryption or key-reference remapping where supported

Production restore should be tested periodically.

## 18. Air-gapped deployment

Bundle:

- OCI images
- Native connector packages
- Compose files
- Checksums and signatures
- SBOMs
- Documentation
- Migration and backup tools

No runtime UI asset may require an external CDN, font provider or analytics service.

## 19. Kubernetes

Deferred until later stages.

When implemented:

- Helm chart
- API, MCP and job processes as Deployments
- Browser workers with dedicated resources and isolation
- External or operator-managed PostgreSQL
- S3-compatible object storage
- NetworkPolicies
- Pod security controls
- Explicit upgrade and backup documentation

Kubernetes must not become the only supported deployment.

## 20. Unsupported deployment patterns

- Exposing browser CDP ports publicly
- Mounting Docker socket into the API service
- Sharing one unrestricted browser profile across projects
- Publishing PostgreSQL or MinIO publicly without explicit operator configuration
- Running Chromium with sandbox disabled by default
- Using the connector as a general VPN
