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
```

Artefacts default to the filesystem driver on the `artefact_data` volume; no object-storage service is bundled (ADR-0012).

Production files must pin exact supported versions or immutable digests. Examples may use placeholders until release automation exists.

The stack in `deploy/compose/` implements the `gateway`, `server`, `mcp-server`,
`browser-worker`, `tunnel-gateway` and `postgres` rows today, plus the
`dev-fixture` development environment the end-to-end scenario publishes. `mcp-server` is the `mcp` row: it is
built from `apps/mcp-server/Dockerfile` as its own image rather than a second
command on the server image, so the two processes can be scaled, restarted and
read in logs independently (ADR-0020). It joins `data` and `browser` because it
translates MCP tools into domain commands and sends captures to the worker, and
`edge` so that the gateway can route `/mcp/*` to it,
mounts the artefact volume read-only because it serves evidence and never writes
it, and is not given the bootstrap token because an agent-facing process has no
administrative work to do. The gateway routes `/mcp/*` to it and `/api/*` to the
server; neither route reaches the other process.

Its gateway image builds
`apps/web` and serves the result, because ADR-0011 removed the server-rendering
process and left static assets as the gateway's responsibility
(`docs/ARCHITECTURE.md` §4.1). It publishes one host port, defaulting to 8443
with TLS from Caddy's internal certificate authority so that a fresh install is
HTTPS before an operator has obtained a certificate.

## 4. Networks

Recommended:

```text
edge     gateway, api, mcp
auth     gateway, api, mcp
data     api, jobs, postgres
control  api, mcp, jobs, tunnel-gateway, browser-worker
browser  browser-worker, tunnel-gateway
```

Only the gateway publishes host ports by default, on the one non-internal
network, and `REVIEWPLANE_GATEWAY_DOMAIN` MUST name the host it is served under:
a site address that names no host gives the certificate authority no subject to
issue for and fails every TLS handshake (`docs/CONFIGURATION.md` §3.2).

PostgreSQL, browser debugging ports and tunnel internals remain private.

`deploy/compose/` collapses this to five internal networks — `edge`, `data`,
`browser`, `tunnel` and `devnet` — plus `frontend`, which is the only one that
is not internal and whose only member is the gateway. Docker publishes a host
port by translating it into the container's address on a bridge that has a
gateway, and `internal: true` is the absence of one, so a container on internal
networks only gets no port mapping and gets none silently. The component whose
job is to be reachable from outside is the one that has a route off the host.
Stage 0 has no separate authentication or control service to separate. `mcp-server` sits on `edge` so
the gateway can reach it, `data` for the domain it commands, and `browser` for
captures. `tunnel` carries the browser worker's route to the tunnel gateway and
the control plane's route to its admin API; `devnet` carries the development
environment's outbound connections. The browser worker is on `browser` and
`tunnel` only, so it reaches a published service through a gateway route and by
no other path.

## 5. Volumes

```text
postgres_data
artefact_data
gateway_data
```

`deploy/compose/` names these `postgres-data`, `artefact-data` and `caddy-data`,
and adds one more for the development fixture's own sources.

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

### The migration command

`reviewplane` is the operator command line, and it ships in the application
image so the schema a deployment applies always matches the code that will read
it.

```bash
reviewplane migrate            # apply every pending migration
reviewplane migrate --status   # report the schema version and what is pending
reviewplane serve              # the api role
reviewplane jobs [--once]      # the jobs role
reviewplane install-token      # mint the one-time administrator bootstrap token
reviewplane version            # the build this image carries
```

### First run: claiming the installation

An installation cannot ship with a password, and it cannot ask a human to invent
one before the software exists to ask. So the operator mints a one-time token at
the console and the first-run screen exchanges it for an account:

```bash
reviewplane install-token [--ttl-seconds 86400]
```

It prints the token **once** — the control plane stores only its digest — and
the token expires whether or not it is used, because a token that waited
indefinitely on a console scrollback would be a permanent way in. Opening the
web application then presents "Set up this installation", which takes the token,
an email address and a password, and signs the administrator in
(`docs/API.md` section 4.0).

The command refuses to mint a second token for an account that already has a
credential. Re-bootstrapping is a password reset, and it takes an explicit
`--force` so that it is a decision rather than an accident.

The token never appears in a log line: `docs/SECURITY.md` section 18 forbids
credential material in logs, which is why the token is printed by a command an
operator runs rather than emitted by the server at startup.

`reviewplane jobs` serves `/health/live`, `/health/ready` and `/version` on
`REVIEWPLANE_JOBS_HEALTH_PORT` (default `8081`, bound to
`REVIEWPLANE_JOBS_HEALTH_HOST`, default `0.0.0.0`). A background role that
exposed nothing would give an operator no way to ask whether work is being
done, which is the question readiness exists to answer. Its readiness adds one
check to the shared set: whether the runner is claiming jobs.

Started against a schema that is behind its code, the role **starts and reports
itself not ready** rather than exiting, and begins claiming when the schema
catches up. Exiting would leave an orchestrator restarting it in a loop while a
separate migration step ran; claiming would run handlers against a database
their code does not match. `reviewplane jobs --once` is the exception: a
one-shot run has nothing to wait for, so a pending schema is an error.

It reads `REVIEWPLANE_DATABASE_URL` or `REVIEWPLANE_DATABASE_URL_FILE` and
nothing else, because an operator applying a schema has no gateway, no worker
and no capability key.

In a source checkout the same command runs as
`pnpm --filter @reviewplane/server run cli migrate`, which needs no build.
There is no `--` separator: pnpm passes one through to the script, and the
command line would then be asked to run a subcommand called `--`.

Exit codes are the interface: `0` success, `1` failure, `2` a configuration
error the process cannot start with, and `3` from `migrate --status` when
migrations are pending — so a deployment script can branch on "needs migrating"
without parsing output.

Migrations are forward-only, applied in file-name order, each in its own
transaction, and recorded in `schema_migrations`. A PostgreSQL advisory lock
serialises concurrent starts, so two processes coming up together cannot apply
the same file twice. The reported **schema version** is the highest applied
file name, because a file name is what an operator finds in the repository.

`reviewplane serve` migrates before it opens its listener. A deployment that
prefers to migrate separately — a Kubernetes job, an operator running the
command by hand — is supported by the readiness gate below, which is what keeps
traffic away from a process whose schema is behind its code. `reviewplane jobs`
answers the same gate rather than migrating: it starts, reports itself not
ready, and claims nothing until the schema catches up, as described above.

### The readiness gate

`/health/ready` reports `not_ready` while any committed migration is
unapplied, and its body names the pending files (`docs/OPERATIONS.md` section
2). A process serving requests against a schema older than its code would fail
request by request, which is worse than being left out of the rotation.

## 12. External object storage (`s3` artefact driver)

The default installation stores artefacts on a local volume through the `filesystem` driver. Operators may configure the `s3` driver instead. Requirements:

- S3-compatible API
- Private bucket
- Server-side encryption recommended
- Lifecycle rules coordinated with application retention
- Multipart upload support for large traces and videos
- CORS configured only when direct browser upload is used

Application metadata remains authoritative for artefact availability.

## 13. Connector installation

The unit and an example configuration ship in the source tree at
`services/connector/packaging/`. Linux example:

```bash
sudo useradd --system --home-dir /var/lib/reviewplane-connector \
  --shell /usr/sbin/nologin reviewplane-connector
sudo install -m 0755 reviewplane-connector /usr/local/bin/reviewplane-connector
sudo install -m 0644 services/connector/packaging/systemd/reviewplane-connector.service \
  /etc/systemd/system/reviewplane-connector.service
sudo install -d -m 0750 -o reviewplane-connector -g reviewplane-connector \
  /etc/reviewplane-connector
sudo install -m 0640 -o reviewplane-connector -g reviewplane-connector \
  services/connector/packaging/config.example.yaml \
  /etc/reviewplane-connector/config.yaml
sudo systemctl daemon-reload
```

Edit `/etc/reviewplane-connector/config.yaml` before starting: the control-plane
URL, the environment name and the `workspaces` block are deployment-specific,
and the example carries placeholders for all three. Every setting is validated at
startup and an unknown one is an error rather than a value silently ignored
(`CONFIGURATION.md` §1), so a mistake here fails immediately and names the
setting.

The service account is created by hand rather than by `DynamicUser=`, and this
is deliberate. The connector reads the developer's checkouts to report branch
and head commit (`CONNECTOR_PROTOCOL.md` §9), which needs a stable identity: the
checkouts must grant it read access, and Git refuses to operate on a repository
owned by another account unless `safe.directory` names it, which is
configuration written against a specific user. Grant that access explicitly —

```bash
sudo systemctl edit reviewplane-connector   # [Service] / SupplementaryGroups=dan
```

— or run the connector as the developer, which on a single-developer machine is
the honest arrangement. Widening the account instead is not the alternative it
appears to be.

`/var/lib/reviewplane-connector` is created by systemd's `StateDirectory=` at
mode 0700. Do not relax it: the device private key lives there and the connector
refuses to start when it is readable by group or other, on every start rather
than only at enrolment (`SECURITY.md` §6.2).

Enrol:

```bash
sudo reviewplane-connector enrol \
  --control-plane https://connect.agents.example.internal \
  --token-file /root/reviewplane-enrolment-token
sudo systemctl enable --now reviewplane-connector
```

The token is read from a file rather than from the command line, because a
command line is in the process table and in shell history. The token file should
be deleted after successful enrolment. The exact command, with this
deployment's URL already in it, is shown by the enrolment screen and returned by
`API.md` §9 as `connector_command`.

Enrolment is separate from `systemctl enable --now` because it is a one-time
exchange that establishes an identity, and the unit's `Restart=` deliberately
excludes exit code 3 — the refusals an operator must act on, such as an invalid
token or a revoked identity — so that the service does not retry a credential
the control plane has already refused (`CONNECTOR_PROTOCOL.md` §18).

Verify from the control plane rather than only from the machine:

```bash
reviewplane connector list
```

It reports each enrolled connector with its environment, platform, project,
version, capabilities, connection and heartbeat instants, revocation instant
where there is one, and how many workspaces the environment holds. It reads and
never revokes: revocation is an authorised, audited action, and a command taking
no credential could not record who performed it (`API.md` §9 is where revocation
lives).

On the machine itself, the claim worth checking is that nothing listens:

```bash
ss -ltnp | grep reviewplane-connector   # expected: no output
```

Every connection the connector makes is outbound (`CONNECTOR_PROTOCOL.md` §5),
so no inbound port needs opening on the development VM and none should appear.

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
- S3-compatible artefact storage via the `s3` driver
- NetworkPolicies
- Pod security controls
- Explicit upgrade and backup documentation

Kubernetes must not become the only supported deployment.

## 20. Unsupported deployment patterns

- Exposing browser CDP ports publicly
- Mounting Docker socket into the API service
- Sharing one unrestricted browser profile across projects
- Publishing PostgreSQL or artefact storage publicly without explicit operator configuration
- Running Chromium with sandbox disabled by default
- Using the connector as a general VPN
