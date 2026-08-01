# Operations

## 1. Operational goals

A self-hosted administrator must be able to determine:

- Whether the platform is healthy
- Which component is failing
- Whether data is safe
- Whether a connector, tunnel or worker can recover
- How much storage and browser capacity remains
- How to back up, upgrade and restore

## 2. Health endpoints

Every service exposes:

```text
/health/live
/health/ready
/version
```

### Liveness

Answers whether the process should be restarted.

### Readiness

Answers whether it can safely receive new work.

Examples:

- API not ready when database migrations are missing
- Browser worker not ready when Chromium cannot launch
- Tunnel gateway not ready when connector registry is unavailable
- MCP not ready when authorisation backend is unavailable

### Implemented today

The `api`, `mcp` and `jobs` process roles answer all three routes from one
implementation, so a dashboard reads the same thing for every container. The
`api` and `mcp` roles serve them on their own listeners; the `jobs` role has no
other listener and opens one for them alone, on
`REVIEWPLANE_JOBS_HEALTH_PORT`. A background role that exposed nothing would
give an operator no way to ask whether work is being done.

Each role's readiness is the shared set — the database is reachable and every
committed migration is applied — plus whatever that role owns. The `jobs` role
adds one check: whether the runner is claiming jobs.

`/health/live` touches nothing outside the process. A database outage MUST NOT
make liveness fail: restarting would not fix it and would remove the process
that is about to recover.

`/health/ready` returns `200` with `{"status": "ready", ...}` or `503` with
`{"status": "not_ready", ...}`. Its report names each check and, when
migrations are pending, the file names — which is what an operator deciding
whether to run `reviewplane migrate` will look for in the repository. A failure
detail never carries a connection string, a credential or a stack trace
(`docs/SECURITY.md` section 18).

`/version` reports the version, the git revision, the build time, the process
role and the protocol version. The build values are stamped into the image at
build time and read from the environment, because the image is what carries the
answer.

`/healthz` and `/readyz` remain as the Stage 0 names the Compose health checks
and the edge gateway use. They answer from the same state.

## 3. Service status command

```bash
reviewplane status          # one screen, for a human over SSH
reviewplane status --json   # the automation shape
```

In the Compose stack it is `./reviewplane status`, which runs the command inside
the `api` container (`docs/DEPLOYMENT.md` §11).

Output includes, and the `--json` object carries a key for each:

| Field | JSON key | What it reports |
|---|---|---|
| Version | `version` | Version, git revision, build time and protocol version, from the image |
| Database connectivity and schema | `database` | Reachability, schema version and pending migration count |
| Artefact store availability | `artefact_store` | Driver, path, and whether a **write** succeeds |
| Active connectors | `connectors` | Active, degraded, disconnected and total enrolled |
| Browser worker capacity | `browser_capacity` | Live workers, workers gone quiet, total slots, slots in use, slots free, sandboxed workers, and the silence threshold the counts were computed with |
| Active sessions | `sessions` | Sessions that have not ended |
| Queue depth | `queue` | Pending, running and failed durable jobs |
| Storage use | `storage` | Available artefact count and bytes, database size, volume free and total |
| Backup | `backup` | When this installation last recorded a backup, in what mode, how long ago, and how many reviews it holds |
| Certificate expiry warnings | `certificate` | The expiry of the certificate the configured TLS listener actually serves |

Two properties are deliberate.

**Availability is a bounded write probe, not a directory listing.** The artefact
failure an operator meets is a volume that mounted read-only or filled up, and a
read succeeds against both. The probe is also raced against a timer, because a
wedged network mount blocks in the kernel and a status command that hung on the
store it was asked about would be useless in exactly the outage it exists for.

**Capacity is what a worker has been heard from about.** A browser worker
heartbeats every 15 seconds, and one that has been silent for **45 seconds** —
three missed heartbeats, the margin
`REVIEWPLANE_CONNECTOR_DEGRADED_AFTER_SECONDS` gives a connector — has its slots
excluded from `capacity`, `available` and `in_use`, and is counted in
`stale_workers` instead. A worker that has registered and not yet reached its
first heartbeat counts from its registration, so a stack coming up does not
report a false shortage for fifteen seconds.

This is a reporting rule and nothing more. No process reaps a stopped worker's
row: it stays `active` in `browser_workers` until something marks it otherwise,
which is worker-lifecycle work `status` does not do. What `status` must not do
is answer "four slots free" about a container that is gone, because an operator
asking why a session will not start would read that as the scheduler's problem
and look in the wrong place. The stale row is still reported, because "a worker
registered and went quiet" is a container to restart while "no worker ever
registered" is a stack that never came up.

**Zero is not a failure.** A fresh installation has no connectors, no sessions
and no queued work, and reporting that as unhealthy would train an operator to
ignore the command. Only the database, the schema and the artefact store make
the report `degraded`; no browser capacity, a worker gone quiet, a worker
reporting the Chromium sandbox disabled, an installation holding reviews it has
never backed up, and a certificate near expiry are `warnings`.

**Backup is read from the audit trail, not from a disk.** The section reports
the newest `backup.created` event: what a status command can answer truthfully
is whether a backup was taken *from this installation*, not whether a file
somewhere else still exists. An operator whose archives are produced by their own
tooling therefore sees "never recorded", which is the honest answer to "can this
installation prove it is backed up". The warning is raised only when the
installation holds at least one review, because a fresh installation has nothing
to lose and warning about it would be the noise this section exists to avoid.

The exit code is the automation interface: `0` when every check passes, `4` when
one that the deployment cannot work without has failed. `4` rather than `1`
because `1` is "the command failed" and this is "the command succeeded and the
answer is bad" (`docs/DEPLOYMENT.md` §11).

A failure detail never carries a connection string, a credential or a network
address (§18 of `docs/SECURITY.md`): status output is pasted into issues.

`REVIEWPLANE_STATUS_TLS_ENDPOINT` names the listener whose certificate expiry is
reported, as `host:port`. In the Compose stack it is the edge gateway, which the
`api` role reaches over the `edge` network. A deployment that terminates TLS in
front of the stack clears it, and the section reports "not configured" rather
than inventing a failure.

The schema is read before the artefact figures, and the figures are not read at
all while migrations are pending: against a database nobody has migrated the
artefact table does not exist, and the operator needs to be told to run
`reviewplane migrate` rather than shown a raw error from PostgreSQL.

Artefact-store availability is a real round trip — a write, a read back and a
removal, in a directory outside the content-addressed tree — rather than a check
that a directory exists, because a read-only volume would pass the second and
fail every upload. Storage use comes from PostgreSQL rather than from the
driver, because application metadata is authoritative for availability
(ADR-0012) and a driver total would also count objects belonging to deleted
artefacts. Each content-addressed key is counted once: two artefacts with
identical bytes are one stored object. Bytes declared by intents that have not
completed verification are reported separately, because they are not evidence
and may never become any.

Connectors, browser capacity, sessions, queue depth and certificate expiry are
reported alongside these. Where a figure is genuinely absent — no connector
enrolled, no TLS endpoint configured — the section says so rather than printing a
zero that reads as a measurement.

## 4. Structured logs

JSON logs in production.

Required fields:

- Timestamp
- Level
- Service
- Version
- Message
- Error code
- Request ID
- Project ID where safe
- Session or review correlation IDs

Do not log raw secrets, cookies or request bodies by default.

## 5. Metrics

### API and MCP

- Request count and latency
- Error count by stable code
- Authentication failures
- Active WebSocket connections
- Event replay lag

### Connector and tunnel

- Connected connectors
- Reconnects
- Active routes and streams
- Bytes transferred
- Tunnel establishment latency
- Route failures

### Browser worker

- Registered workers
- Capacity slots
- Active contexts
- Browser launch time
- Crash count
- Frame production and drop rate
- Screenshot latency
- Trace finalisation failures
- Memory and CPU use

### Reviews

- Reviews created
- Findings by state
- Time to first claim
- Time to verification
- Reopen rate

### Storage

- PostgreSQL size
- Object count and bytes by artefact class
- Pending deletion
- Failed retention jobs
- Upload failures

## 6. Tracing

Use distributed tracing for control-plane calls across:

- Gateway
- API or MCP
- Browser scheduler
- Browser worker
- Tunnel gateway
- Connector

Trace data must avoid page body and secret values.

## 7. Alerts

Initial recommended alerts:

- Database unavailable
- Artefact store unavailable
- No browser capacity
- Browser crash rate above threshold
- Connector fleet disconnected unexpectedly
- Retention backlog increasing
- Artefact integrity failure
- Certificate near expiry
- Backup failure
- Disk space low
- Migration mismatch

## 8. Browser capacity

Capacity model considers:

- Worker memory
- Worker CPU
- Maximum browser contexts
- Per-project limits
- Session duration
- Live-view load
- Video or trace overhead

The scheduler should reject or queue new sessions explicitly rather than overcommit silently.

### 8.1 Worker liveness

A browser worker heartbeats every
`REVIEWPLANE_BROWSER_WORKER_HEARTBEAT_INTERVAL_SECONDS` (default 15). Silence
past two thresholds moves it through a lifecycle, and each transition emits its
event (`EVENTS.md` §7):

| Silence | Status | Event | Effect |
|---|---|---|---|
| — | `active` | `browser_worker.registered` | Schedulable, counted as capacity |
| > `REVIEWPLANE_BROWSER_WORKER_DEGRADED_AFTER_SECONDS` (45) | `degraded` | `browser_worker.degraded` | Not counted as capacity, not scheduled onto |
| > `REVIEWPLANE_BROWSER_WORKER_LOST_AFTER_SECONDS` (90) | `lost` | `browser_worker.lost` | As above, and its sessions are failed by reconciliation |

A worker that heartbeats again returns to `active` and the recovery is recorded.
The sweep runs every `REVIEWPLANE_BROWSER_WORKER_MONITOR_INTERVAL_SECONDS`
(default 5). `lost` is evaluated before `degraded`, so a worker silent for a long
time lands in `lost` rather than being degraded now and only concluded next pass.

`degraded` remains in the schedulable status set deliberately: a worker that
missed one heartbeat has not necessarily gone, and removing it from the pool the
instant it is late would make a momentary delay indistinguishable from a crash.
What excludes it in practice is the **liveness predicate**, which a degraded
worker fails by definition. The status is the audit record; the predicate is the
decision.

That predicate — `greatest(last_heartbeat_at, registered_at)` inside the degraded
budget — is applied in **every** query that decides something: scheduling,
capacity accounting, `reviewplane status` and reconciliation, from one definition
(ADR-0027). Both halves are needed. The background sweep is what makes the stored
state honest and auditable; the term in the query is what makes the decision safe
when a worker dies between two passes. Until RVP-30 neither existed except in
`reviewplane status`, so `reviewplane status` could report `1 worker(s), 4 of 4
slot(s) free` about a container that had been stopped for over two minutes, and
the scheduler would dispatch to it.

When no live worker has a free slot, a session request is refused with
`BROWSER_CAPACITY_EXHAUSTED` and the UI shows the state `UX_FLOWS.md` §18
requires. That refusal is the point of the whole mechanism: a session that hangs
in `ALLOCATING` sends an operator looking at the worker's logs, and there are
none, because the worker is gone.

## 9. Session reconciliation

Periodic reconciliation compares:

- Control-plane session state
- Worker-reported contexts
- Connector routes
- Active control leases

Actions:

- Terminate orphan worker contexts
- Revoke orphan routes
- Expire stale leases
- Mark missing sessions degraded
- Emit audit events

### 9.1 What reconciliation does

It runs in the same pass as the liveness sweep of §8.1, on the same interval,
because both answer one question: what does the control plane still believe that
is no longer true?

For each **live** worker the control plane asks what browser contexts it is
holding (`worker.contexts.request` / `worker.contexts` on the internal channel)
and compares:

- a context **no live session claims** is an orphan. It is terminated on the
  worker and recorded as `browser_session.reconciled` — an orphan holds a browser
  slot and page state nobody owns.
- a session the control plane believes is live that the worker **no longer
  holds** is marked `DEGRADED`, not terminated. `DOMAIN_MODEL.md` §12 requires
  the session and its metadata to be retained and to remain diagnosable.
- a session on a worker that has gone (`lost`, or removed from the schedulable
  set) is marked `FAILED`. Evidence already uploaded stays exactly where it is
  (`ARCHITECTURE.md` §14).

Control leases past `expires_at` are revoked in the same pass. `SECURITY.md` §8
requires leases to expire, and until RVP-30 `expires_at` was written and never
read. Expiry does **not** move the control epoch: the epoch moves when a
controller changes, and an expiry is nobody taking control.

The sweep runs in the API process and not in `reviewplane jobs`. A deployment
running only the jobs role therefore keeps a correct *decision* — the liveness
predicate is in the queries — while its stored worker status goes stale. That is
a known limitation recorded in ADR-0027.

## 10. Data retention jobs

Retention runs should:

1. Select eligible artefacts
2. Mark pending deletion
3. Delete object
4. Confirm deletion
5. Tombstone metadata
6. Emit event

Failures retry and surface operationally. Metadata must not claim deletion before object confirmation.

## 11. Backup operations

- Daily database backup recommended
- Filesystem artefact volume included in bundled backup tooling; external S3 artefact storage protected by versioning or backup according to operator risk
- Backup status visible in UI or status command
- Restore test scheduled regularly
- Backup encryption documented

Under the `filesystem` driver a complete backup is a database dump plus the
`artefact-data` volume's `sha256/` directory. Nothing in that directory depends
on a name a user chose, and every file in it is named by the digest of its own
contents, so a restore can be verified by recomputing digests without consulting
the database. `reviewplane status` reports how many bytes there are to copy.

The two halves must be restored together. PostgreSQL is authoritative for
availability (ADR-0012): a database restored ahead of the volume names artefacts
whose bytes are not there yet, and a volume restored ahead of the database holds
objects nothing references.

### The commands

```bash
cd deploy/compose
./reviewplane backup --output - > "reviewplane-$(date +%F).tar.zst"
./reviewplane restore --input - --dry-run < reviewplane-2026-07-28.tar.zst
```

`backup` takes both halves in one archive and `restore` puts both back in one
operation, which is what makes "restored together" a property of the tooling
rather than an instruction. `docs/DEPLOYMENT.md` §16 and §17 give the modes, the
archive layout, the key-material rules and the restore refusals in full.

A daily database backup is the recommendation; the schedule is the operator's,
and this release ships no scheduler. `reviewplane status` reports when the last
one was recorded (§3), and `reviewplane migrate --preflight` refuses an upgrade
when there is none (§12).

Both operations write an audit event — `backup.created` and `backup.restored`
(`docs/EVENTS.md` §7) — which is what `docs/SECURITY.md` §16 requires of export
and backup operations, and what the status and preflight answers are read from.

Backup encryption is the operator's: the archive is not encrypted by the command
(`docs/SECURITY.md` §20).

## 12. Upgrade operations

Preflight checks:

- Supported source version
- Database backup freshness
- Disk space
- Connector compatibility
- Worker compatibility
- Migration lock availability

Rolling compatibility SHOULD permit old connectors within a documented support window.

### `reviewplane migrate --preflight`

The six checks above, in that order, every one of them reported — including the
ones that passed, because a check that is silently omitted reads as a check that
passed. `--json` carries the `compatibility_report` shape of
`packages/protocol`. The command reads and reports; it applies nothing, and
exits `4` when a check fails.

| Check | `fail` | `warn` |
|---|---|---|
| `source_version` | The database is at a schema this build does not have — it was written by a newer release | — |
| `backup_freshness` | No `backup.created` event has ever been recorded | The newest is older than 24 hours |
| `disk_space` | Free space on the artefact volume is under 1 GiB, or under the database's own size | Free space is under three times the database's size |
| `connector_compatibility` | The connector table could not be read | An enrolled connector is below the configured minimum and will be refused with `UPGRADE_REQUIRED`, or below the recommended version and will keep running with a recommendation |
| `worker_compatibility` | The worker table could not be read | A registered browser worker reports a build other than the control plane's |
| `migration_lock` | Another process holds the migration lock | — |

A check that could not run at all reports `fail`, whatever the row above says:
"the connector table could not be read" is not a check that passed. The detail
carries no connection string, credential or address (`docs/SECURITY.md` §18),
because preflight output is pasted into issues.

Two distinctions are deliberate. A connector that will be refused does **not**
fail the preflight: the control plane's upgrade is not what has to move, and
`docs/CONNECTOR_PROTOCOL.md` §19 already gives that connector a terminal
classification it reports and stops on. The classification here comes from the
same function the reconnect exchange uses, against the same configured policy
(`REVIEWPLANE_CONNECTOR_MINIMUM_VERSION` and
`REVIEWPLANE_CONNECTOR_RECOMMENDED_VERSION`), so the preflight cannot say a
connector is fine and the control plane then refuse it.

A missing backup **does** fail it. The migrations in this release declare no
downgrade (`docs/DEPLOYMENT.md` §15), so an upgrade without a backup is an
upgrade with no way back, and that is the one thing a preflight exists to
prevent.

The migration lock is taken and released rather than held: the preflight must
not become the process that blocks the migration it is clearing the way for. The
window between the check and the migration is real and is not pretended away —
the runner takes the same lock, so two concurrent upgrades still cannot both
apply a file. The check exists so the second one is told why it is waiting.

## 13. Incident categories

### Control-plane unavailable

- Stop new state-changing work
- Browser workers pause or terminate after grace period
- Preserve existing artefacts

### Connector compromise

- Revoke connector
- Close routes
- Identify sessions and secrets used
- Rotate affected project credentials
- Review audit history

### Browser-worker compromise

- Remove worker from scheduling
- Revoke worker identity
- Terminate sessions
- Treat artefacts and session credentials as potentially exposed

### Cross-project access suspicion

- Disable affected service or installation
- Preserve logs and events
- Rotate credentials
- Conduct data-scope review
- Notify affected operators according to policy

## 14. Administrative maintenance commands

Planned commands:

```text
reviewplane status
reviewplane doctor
reviewplane backup
reviewplane restore
reviewplane migrate
reviewplane rotate-keys
reviewplane connector list
reviewplane worker list
reviewplane session reconcile
reviewplane retention run
reviewplane export-review
```

Commands support `--json` for automation.

### Implemented today

| Command | State |
|---|---|
| `reviewplane status [--json]` | Shipped (§3) |
| `reviewplane backup --output FILE\|- [--mode full\|database] [--include-key-material] [--json]` | Shipped (§11, `docs/DEPLOYMENT.md` §16) |
| `reviewplane restore --input FILE\|- [--dry-run] [--hostname HOST] [--json]` | Shipped (§11, `docs/DEPLOYMENT.md` §17) |
| `reviewplane migrate [--status] [--preflight] [--json]` | Shipped (§12, `docs/DEPLOYMENT.md` §11) |
| `reviewplane connector list` | Shipped |
| `reviewplane export-review --project P --review R [--out FILE]` | Shipped |
| `reviewplane doctor` | Not implemented (§15) |
| `reviewplane rotate-keys` | Not implemented. Envelope encryption is unimplemented, so there is no data key to rotate (`docs/SECURITY.md` §15); the connector authority is generated when its row is absent, and the identities it signed are replaced by re-enrolment (`docs/DEPLOYMENT.md` §13) |
| `reviewplane worker list` | Not implemented. `status` reports browser capacity |
| `reviewplane session reconcile` | Not implemented. Reconciliation runs on reconnect (§9) |
| `reviewplane retention run` | Not implemented. Retention is Stage 2 (§10) |

## 15. Doctor command

`reviewplane doctor` should test:

- DNS and TLS
- Database
- Artefact store read and write
- Browser launch
- WebSocket upgrade
- Connector handshake
- Tunnel loopback route
- MCP authentication
- Artefact upload and retrieval

The command must avoid destructive tests unless explicitly requested.

### Implemented today

`reviewplane doctor` does not exist yet. Four of the checks above are answered
by `reviewplane status` (§3), which is what an operator diagnosing an
installation runs today:

| Check | Answered by |
|---|---|
| TLS | `certificate`: the expiry of the certificate the gateway actually serves |
| Database | `database`: reachability, schema version and pending migrations |
| Artefact store read and write | `artefact_store`: a bounded write probe |
| Browser launch | `browser_capacity`: a registered worker has launched Chromium and reported its capacity and sandbox posture |

The remaining checks — DNS, WebSocket upgrade, connector handshake, tunnel
loopback route, MCP authentication, artefact upload and retrieval — are actions
rather than readings, and belong to a command that may perform them. They are
exercised end to end by `pnpm test:e2e` and `pnpm test:integration`, not by an
operator command.

## 16. Storage planning

Report storage by:

- Project
- Artefact kind
- Retention class
- Review
- Age

Administrators should be able to identify why storage is growing.

## 17. Support bundle

Generate a redacted support bundle containing:

- Versions
- Configuration summary without secrets
- Health results
- Recent error logs
- Metrics snapshot
- Database schema version
- Connector and worker capability matrix

It must not include screenshots, source code, cookies or raw review comments by default.
