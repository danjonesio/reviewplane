# Deployment

## 1. Supported deployment order

1. Single-host Docker Compose
2. Docker Compose with external PostgreSQL and object storage
3. Dedicated remote browser-worker nodes
4. Helm chart and Kubernetes
5. Air-gapped enterprise bundle

Docker Compose is the first-class deployment and must remain fully supported.

## 2. Packaging

Versioned OCI images, published by `.github/workflows/release-images.yml` from a
`v<version>` tag:

```text
ghcr.io/danjonesio/reviewplane-server:<version>
ghcr.io/danjonesio/reviewplane-mcp-server:<version>
ghcr.io/danjonesio/reviewplane-browser-worker:<version>
ghcr.io/danjonesio/reviewplane-tunnel-gateway:<version>
ghcr.io/danjonesio/reviewplane-connector:<version>
ghcr.io/danjonesio/reviewplane-gateway:<version>
```

The version is the tag with its leading `v` removed. It is stamped into every
image as `REVIEWPLANE_VERSION`, reported by `/version` and by
`reviewplane status`, and pinned in `deploy/compose/.env` as
`REVIEWPLANE_VERSION`, which is what `compose.yaml` interpolates into every
`image:`. There is no `latest` tag: a floating tag is what "pin an exact version
or an immutable digest" exists to forbid. The workflow prints the immutable
digest of each pushed image in its run summary, for an operator who prefers to
pin that instead.

The server image runs the roles of `docs/ARCHITECTURE.md` §4.2 through the
operator command line it carries:

```text
reviewplane serve   the api role
reviewplane jobs    the jobs role
```

The MCP server is a separate image rather than a third command on this one
(ADR-0020): a separate process behind a separate route, so that the two can be
scaled, restarted and read in logs independently, and so a gateway rule written
for the human API cannot expose the agent one as a side effect.

**Until a release is published, `./configure` builds the images from the
checkout** and says so. Image signing and SBOM publication are Stage 2
(`docs/SECURITY.md` §19), and an installation that cannot verify a signature is
better served by a build it performed itself than by an unsigned pull. Builds
are `linux/amd64` today; multi-architecture release testing is Stage 2.

Connector releases should also include signed native binaries and packages.

## 3. Default Compose stack

`deploy/compose/compose.yaml` is the supported installation, not an example. It
starts seven services:

| Service | Image | Role |
|---|---|---|
| `gateway` | `reviewplane-gateway:${REVIEWPLANE_VERSION}` | TLS, routing, WebSocket upgrades, the web application's static assets. The only service that publishes a host port. |
| `api` | `reviewplane-server:${REVIEWPLANE_VERSION}`, `reviewplane serve` | HTTP API, authentication, domain logic, connector listener. Applies migrations before it opens its listener. |
| `jobs` | `reviewplane-server:${REVIEWPLANE_VERSION}`, `reviewplane jobs` | Durable background work. Reaches PostgreSQL and nothing else. |
| `mcp` | `reviewplane-mcp-server:${REVIEWPLANE_VERSION}` | The agent-facing endpoint (ADR-0020). |
| `browser-worker` | `reviewplane-browser-worker:${REVIEWPLANE_VERSION}` | Chromium. |
| `tunnel-gateway` | `reviewplane-tunnel-gateway:${REVIEWPLANE_VERSION}` | Session-scoped route capabilities to connector routes. |
| `postgres` | `postgres:17-alpine`, pinned by digest | Authoritative metadata and events. |

An eighth, `dev-fixture`, stands in for a developer's machine and is in the
`development` profile, so the default installation does not start it (§6).

Artefacts default to the filesystem driver on the `artefact-data` volume; no
object-storage service is bundled (ADR-0012). PostgreSQL is pinned by immutable
digest, and every ReviewPlane image by `${REVIEWPLANE_VERSION}`, which
`./configure` writes into `.env` (§2).

`api` and `jobs` are the same image running two commands, because
`docs/ARCHITECTURE.md` §4.2 makes them two roles of one codebase. Running them
as two containers rather than one is a choice this stack makes and states:
`REVIEWPLANE_SERVE_RUNS_JOBS=false` on `api` turns off the runner that
`reviewplane serve` would otherwise start beside the API, because a `jobs`
container whose logs and readiness describe only some of the background work is
worse than no separation at all.

`mcp` joins `data` and `browser` because it translates MCP tools into domain
commands and sends captures to the worker, and `edge` so that the gateway can
route `/mcp/*` to it. It mounts the artefact volume read-only because it serves
evidence and never writes it, and it is not given the bootstrap token because an
agent-facing process has no administrative work to do. The gateway routes
`/mcp/*` to `mcp` and `/api/*` and `/ws/*` to `api`; neither route reaches the
other process.

The gateway image builds `apps/web` and serves the result, because ADR-0011
removed the server-rendering process and left static assets as the gateway's
responsibility (`docs/ARCHITECTURE.md` §4.1). It publishes one host port,
defaulting to 8443 with TLS from Caddy's internal certificate authority so that
a fresh install is HTTPS before an operator has obtained a certificate.

### Start-up order

Two orderings are enforced by `depends_on` rather than left to a restart loop:

- `tunnel-gateway` and `browser-worker` wait for `api` to be **healthy**. The
  gateway trusts connector identities against a certificate authority the
  control plane generates on its own first start (ADR-0014), and the worker
  registers with the control plane as it starts.
- `jobs` waits for `api` to be healthy, because `reviewplane serve` is what
  applies the schema. Started earlier the role reports itself not ready and
  waits rather than exiting (§11), so this is a convenience rather than a
  correctness requirement.

`api` publishes the connector authority's **certificate** to the `connector-ca`
volume at startup, where `tunnel-gateway` reads it. The private key stays in
PostgreSQL and is never written to a volume: signing happens in the control
plane, and a CA key one container away from the process that terminates
untrusted connections would be a key in the wrong place.

## 4. Networks

`deploy/compose/compose.yaml` declares six, of which exactly one is not
`internal: true`:

| Network | Members | Why |
|---|---|---|
| `data` | postgres, api, jobs, mcp | The database is reachable by the three processes that own domain state and nothing else. |
| `browser` | api, mcp, browser-worker | The control plane and the agent endpoint command the worker. |
| `tunnel` | api, tunnel-gateway, browser-worker | The worker reaches published services only through the tunnel gateway; the control plane reaches the gateway's admin API. |
| `devnet` | api, tunnel-gateway, dev-fixture | The development environment dials out to enrol and to open its data channel. Nothing dials in. |
| `edge` | gateway, api, mcp | The edge gateway reaches the two HTTP processes over this network rather than over the host, and neither gains a route anywhere else by being on it. |
| `frontend` | gateway | **Not** internal, and the only one here that is not. |

Only the gateway publishes host ports by default, on that one non-internal
network, and `REVIEWPLANE_GATEWAY_DOMAIN` MUST name the host it is served under:
a site address that names no host gives the certificate authority no subject to
issue for and fails every TLS handshake (`docs/CONFIGURATION.md` §3.2).

PostgreSQL, browser debugging ports and tunnel internals remain private.

`frontend` exists because a published host port requires it. Docker publishes a
port by translating it into the container's address on a bridge that has a
gateway, and `internal: true` is precisely the absence of one, so a container on
internal networks only gets no port mapping and gets none silently. The
component whose job is to be reachable from outside is the one that has a route
off the host.

`jobs` is on `data` alone. Background work is domain work: it needs no gateway,
no worker and no tunnel, and an outage of every other component leaves it able
to do its job. It holds no worker, capability or tunnel credential either.

The browser worker is on `browser` and `tunnel` only, so it reaches a published
service through a gateway route and by no other path.

Stage 1 has no separate authentication or control service, so the `auth` and
`control` networks earlier drafts of this document recommended are not
separately declared: `edge` carries what `auth` would, and `browser`, `tunnel`
and `data` between them carry what `control` would, each to the narrowest set of
members that need it.

## 5. Volumes

| Volume | Written by | Contents |
|---|---|---|
| `postgres-data` | postgres | The database. |
| `artefact-data` | api (read-only in mcp) | Artefacts, through the filesystem driver (ADR-0012). |
| `caddy-data` | gateway | Caddy's internal certificate authority and its issued certificates. |
| `connector-ca` | api (read-only in tunnel-gateway) | The connector authority's certificate, published at startup (ADR-0014). Never the key. |
| `dev-fixture-vite-src` | dev-fixture | The `development` profile fixture's own sources. |

Browser profiles use ephemeral container storage — tmpfs, per session, removed
on termination — unless project policy enables reusable authentication state.

## 6. Compose profiles

| Profile | State |
|---|---|
| `development` | Implemented: the `dev-fixture` development environment the end-to-end scenario publishes. |
| `observability` | Reserved. Stage 2. |
| `antivirus` | Reserved. |
| `external-storage` | Reserved. Stage 2, with the `s3` artefact driver and external PostgreSQL. |
| `remote-worker` | Reserved. Stage 2. |

The default installation MUST NOT require any profile, and does not: the flow in
§8 names none.

## 7. Configuration

Configuration priority:

1. Command-line flags for one-off administrative commands
2. Mounted configuration file
3. Secret files
4. Environment variables for non-secret deployment values
5. Built-in defaults

Secret material MUST be mounted as a file and MUST NOT be passed as an
environment value. `deploy/compose/compose.yaml` declares nine, all created by
`./configure` and none committed:

```yaml
secrets:
  postgres_password:            { file: ./secrets/postgres_password }
  database_url:                 { file: ./secrets/database_url }
  bootstrap_token:              { file: ./secrets/bootstrap_token }
  worker_credential:            { file: ./secrets/worker_credential }
  worker_command_credential:    { file: ./secrets/worker_command_credential }
  capability_signing_key:       { file: ./secrets/capability_signing_key }
  capability_keys:              { file: ./secrets/capability_keys }
  tunnel_control_token:         { file: ./secrets/tunnel_control_token }
  enrolment_token:              { file: ./secrets/enrolment_token }   # development profile
```

Eight of the nine are generated values. `enrolment_token` is not: an enrolment
token is issued by the running control plane, and only the `development`
profile's `dev-fixture` mounts it. `./configure` creates the file **empty**,
because Compose refuses to start a stack whose declared secret file is missing
whether or not anything reads it, and a run that needs a real token writes one
into it.

Every service reads its secrets through a `*_FILE` setting. A missing file makes
Compose refuse to start the service that needs it, naming the file: a control
plane that started without its signing key would mint capabilities nothing could
verify.

There is no `session_signing_key`. Human sessions are opaque random identifiers
whose digests live in PostgreSQL (`docs/SECURITY.md` §6.1), so nothing signs a
session and a key for it would be a secret with no reader.

`secrets/` is mode 0700 and the files inside it are 0644. That needs stating
rather than hiding: `uid`, `gid` and `mode` on a Compose secret reference are
honoured by Docker Swarm only, and plain Compose bind-mounts the file with the
permissions it has on the host, while every service runs as uid 10001. The
directory is the boundary. A deployment with more than one administrator on the
host SHOULD deliver these through Swarm or Kubernetes secrets, or pre-create the
files owned by uid 10001.

## 8. Initial installation

### Manual path

This is the exit-criterion flow, and every command in it is run verbatim by
`pnpm test:install` from a clean checkout.

```bash
git clone https://github.com/danjonesio/reviewplane.git
cd reviewplane/deploy/compose
cp .env.example .env
./configure
docker compose config
docker compose pull
docker compose up -d
./reviewplane status
./reviewplane install-token
```

Then open the setup URL `./configure` printed — `https://localhost:8443/` for a
single-host installation that changed nothing — and complete "Set up this
installation" with the token, an email address and a password.

What each step does:

| Command | What it does |
|---|---|
| `cp .env.example .env` | The non-secret settings. Nothing in it needs editing for a `localhost` installation. |
| `./configure` | Checks Docker Engine and Compose, creates `secrets/`, `tls/` and `ca/`, generates every secret and the tunnel certificate authority, records the browser worker's certificate pin, and writes the pinned version and image source. Prints the setup URL. |
| `docker compose config` | Renders the resolved configuration, so an operator sees the exact images, ports and mounts before anything starts. |
| `docker compose pull` | Fetches the pinned images. Services that are built from the checkout are skipped, so the command is the same either way. |
| `docker compose up -d` | Starts the stack. `reviewplane serve` applies the migrations before it opens its listener. |
| `./reviewplane status` | Reports version, database and schema, artefact store, connectors, browser capacity, sessions, queue depth, storage and certificate expiry (`docs/OPERATIONS.md` §3). |
| `./reviewplane install-token` | Prints the one-time administrator token, once. |

The token is the last step rather than part of `./configure` because it is
minted from the database and stored only as a digest (§11), so it does not exist
until the control plane is running. Re-running `./configure` after the stack is
up prints it too, and `./configure` is safe to re-run: it regenerates no
existing secret and does not change the pin the browser worker was started with.

`./reviewplane` runs the operator command line inside the `api` container, which
is the process with the artefact volume mounted and a route to the gateway —
two of the things `status` reports.

### Installer path

A convenience installer that wraps the above may be added later. The manual path
remains the documented one and MUST remain fully documented.

## 9. Resource guidance

Guidance published with this release, for a personal deployment:

- 4 vCPU minimum
- 8 vCPU recommended with active browser sessions
- 8 GB RAM minimum
- 16 GB RAM recommended
- SSD storage
- Roughly 1 GB of additional memory per concurrent Chromium session, on top of
  the base installation

`REVIEWPLANE_WORKER_CAPACITY` (default 4) is the number of concurrent sessions
the single worker accepts, and `REVIEWPLANE_WORKER_MEMORY_LIMIT` (default `4g`)
is the ceiling that actually bounds it. Raising one without the other produces a
worker that accepts sessions its container cannot run.

Exact browser capacity must be measured and published per release. The figures
above are the guidance this release publishes; they have not been measured at
the recommended end of the range.

## 10. TLS and DNS

Supported modes, all selected by `REVIEWPLANE_GATEWAY_TLS`:

| Value | Mode |
|---|---|
| `internal` (default) | Caddy's own certificate authority. A fresh installation is HTTPS before an operator has obtained a certificate; the browser will not trust it until the authority is imported. |
| an email address | ACME with that account, for a publicly resolvable name. |
| two paths separated by a space | An operator-supplied certificate and key, mounted into the container. Private PKI is this mode. |

An operator who terminates TLS in a reverse proxy in front of the stack leaves
this alone and points their proxy at `REVIEWPLANE_GATEWAY_PORT`.

`REVIEWPLANE_GATEWAY_DOMAIN` MUST name the host the site is served under, and
`REVIEWPLANE_PUBLIC_ORIGIN` MUST agree with it and with the published port: the
second is the origin the control plane accepts a live-view WebSocket upgrade
from, so a deployment where they disagree serves a page the API then refuses.

Hostnames may be split across the deployment domain:

```text
app.agents.example.internal
mcp.agents.example.internal
connect.agents.example.internal
```

The shipped stack serves all three surfaces from one name on separate paths —
`/`, `/mcp/*` and the connector listener — because a single-host installation
that needed three DNS records to start would fail its own exit criterion.

Internal browser-route origins MUST NOT require public DNS. They are
`*.internal.invalid`, a reserved TLD with no DNS at all: the browser worker is
given a static mapping to the tunnel gateway and a pin for exactly its public
key (ADR-0015).

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
reviewplane status [--json]    # the deployment's health, capacity and storage
reviewplane version            # the build this image carries
```

In the Compose stack, `deploy/compose/reviewplane` runs these inside the `api`
container: `./reviewplane status` is `docker compose exec -T api reviewplane
status`. With the stack down it falls back to a one-shot container, which can
still answer `migrate` and `version`.

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
error the process cannot start with, `3` from `migrate --status` when migrations
are pending, and `4` from `status` when a check the deployment cannot work
without has failed — so a deployment script can branch on "needs migrating" or
"is unhealthy" without parsing output. `4` is deliberately not `1`: `1` is "the
command failed", and this is "the command succeeded and the answer is bad".

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

These are properties of the shipped default, not advice. `docs/SECURITY.md` §4
names administrator misconfiguration as a threat, so a default that is only safe
after an edit has already failed.

Four of the six are asserted by `pnpm test:install` against a **running**
installation. The other two are asserted, but by the gates that own the
behaviour rather than by the installation gate — the table says which, because
"a gate covers this" is a claim that has to be checkable:

| Pattern | Asserted by | How |
|---|---|---|
| Exposing browser CDP ports publicly | `pnpm test:install` | Enumerates every published port in the project and connects from the host to 5432, 9222, 8090, 8444 and 8445. The gateway's own port is probed alongside them, so a probe that cannot connect to anything is not mistaken for proof. |
| Mounting the Docker socket into the API service | `pnpm test:install` | Inspects the mounts of every container, not only `api`. |
| Sharing one unrestricted browser profile across projects | `pnpm test:browser` | Two tests in `apps/browser-worker/test/browser/worker.browser.test.ts`: "terminating a session destroys its ephemeral data" asserts the profile directory is gone after termination, and "cookies and storage are isolated between sessions and between projects" asserts nothing crosses between them (`docs/SECURITY.md` §10.1). The installation gate allocates no session, so it cannot see either. |
| Publishing PostgreSQL or artefact storage publicly | `pnpm test:install` | PostgreSQL is port-scanned as above. Artefact storage publishes nothing because there is no artefact service to publish: ADR-0012 makes it a volume the control plane owns, and the gate asserts the browser worker holds no artefact volume and no storage credential. |
| Running Chromium with the sandbox disabled by default | `pnpm test:install` | Reads `browser_workers.sandbox_enabled` for the registered worker — what the worker reported about the Chromium it launched, not what a variable claims. |
| Using the connector as a general VPN | `pnpm test`, plus `go test ./...` in `services/tunnel-gateway` and in `services/connector` | The destination policy of `docs/SECURITY.md` §9 is one corpus — `services/tunnel-gateway/testdata/destination-policy.json` — read by all three enforcement points, so a destination only one of them refuses fails the build. The three readers are `apps/server/test/destination-policy.test.ts`, `services/tunnel-gateway/policy/destination_test.go` and `services/connector/internal/routes/routes_test.go`, which is why one command covers one of the three; in continuous integration they are the `pnpm test`, `go (tunnel-gateway)` and `go (connector)` jobs. A published service is a route to one destination, not network reach. |

`pnpm test:install` additionally asserts that no UI asset is loaded from another
host: it fetches the served document through the gateway and checks that every
`src` and `href` is same-origin.
