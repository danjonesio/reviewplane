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

Provide:

```bash
reviewplane status
```

Output should include:

- Version
- Database connectivity and schema
- Artefact store availability
- Active connectors
- Browser worker capacity
- Active sessions
- Queue depth
- Storage use
- Certificate expiry warnings

The command exists and reports the version, the schema version and the count of
pending migrations, the artefact driver, artefact-store availability and
storage use. `--json` prints the same values for automation. It exits `1` when
the store is unreachable or migrations are pending.

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

The remaining figures — connectors, worker capacity, sessions, queue depth,
certificate expiry — are not yet reported. They arrive with the stages that own
them, and the command prints what it can measure rather than a zero that reads
as a measurement.

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

## 12. Upgrade operations

Preflight checks:

- Supported source version
- Database backup freshness
- Disk space
- Connector compatibility
- Worker compatibility
- Migration lock availability

Rolling compatibility should permit old connectors within a documented support window.

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
