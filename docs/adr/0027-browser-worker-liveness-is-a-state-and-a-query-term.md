# ADR-0027: Browser-worker liveness is both a swept state and a term in every query that decides something

- Status: Accepted
- Date: 2026-08-01

## Context

`browser_workers.last_heartbeat_at` has been written on every heartbeat since
migration `0042`. Until RVP-30 it was read by nothing, and the `status` column's
`CHECK` constraint has admitted `'degraded'` and `'lost'` since the same
migration without any code path ever writing either. A browser worker whose
container had stopped stayed `active` for ever.

The observed symptom (RVP-70): stopping the `browser-worker` container and
waiting 2m18s left `reviewplane status` reporting `1 worker(s), 4 of 4 slot(s)
free`, `status: ok`.

RVP-15 fixed the **reporting** half by adding a staleness predicate inside
`modules/operations/status.ts`, and its own comment said the fix went no
further: "It is applied here, in the reporting, and nowhere else. Nothing reaps
a stopped worker's row."

That leaves the worse half. The session scheduler reads the same rows. With no
liveness term it dispatches a session to a container that no longer exists, and
the caller sees a session that never becomes ready — rather than
`BROWSER_CAPACITY_EXHAUSTED`, which is the diagnosable answer `docs/UX_FLOWS.md`
§18 and `docs/OPERATIONS.md` §8 promise. The reconciler of §9 has the same
problem one level up: it cannot reason correctly about a worker the control
plane still believes is alive.

Connectors already solve this — a heartbeat interval, a degraded threshold, a
disconnected threshold, each transition emitting its event
(`modules/connectors/monitor.ts`). Browser workers had the field and none of the
machinery.

The question this ADR settles is not *whether* to reap but **where the liveness
decision lives**, because a background job alone and a query term alone are each
insufficient in a different way.

## Decision

### Both halves, from one definition

**A background sweep makes the state honest.** `BrowserWorkerMonitor` runs on a
timer with the server and moves a silent worker `active → degraded → lost`,
emitting `browser_worker.degraded` and `browser_worker.lost`. `lost` is
evaluated before `degraded`, so a worker silent for a long time lands in `lost`
rather than being degraded now and only concluded next pass — the same ordering
and the same reason as the connector sweep. A worker that heartbeats again
recovers to `active` and the recovery is recorded, because "it came back" and
"it never went" are different facts to an operator reading a timeline.

**A term in the query makes the decision safe.** A worker can die between two
sweeps. Every read that *decides* something therefore carries the liveness
predicate itself:

```sql
greatest(last_heartbeat_at, registered_at) > now() - make_interval(secs => $N::double precision)
```

`greatest` ignores nulls, so a worker that has registered and not yet reached
its first heartbeat counts from its registration — without which a freshly
started deployment would report no capacity for the first heartbeat interval, a
false alarm in exactly the minute an operator is watching the installation come
up.

The four deciding readers are scheduling (`WorkerRegistry.active`), capacity
accounting, `reviewplane status`, and the session reconciler. All four import
`workerLivePredicate` from `modules/browser-sessions/liveness.ts`. RVP-15's copy
in `status.ts` is replaced by that import rather than joined by two more: three
copies of one expression is how the report and the reaper come to disagree, and
a capacity figure that is wrong in the optimistic direction sends an operator
looking in the wrong place.

### `degraded` stays schedulable; the term excludes it in practice

`SCHEDULABLE_WORKER_STATUSES` is `['active', 'degraded']`. A worker that missed
a heartbeat has not necessarily gone, and removing it from the pool the instant
it is late would make a momentary delay indistinguishable from a crash. What
excludes it is the liveness term, which a degraded worker fails by definition.
The status is the audit record; the term is the decision. `lost` and `revoked`
are excluded outright, because those are conclusions rather than suspicions.

### The thresholds are configuration, in the module

`modules/browser-sessions/config.ts` declares
`REVIEWPLANE_BROWSER_WORKER_HEARTBEAT_INTERVAL_SECONDS` (15),
`REVIEWPLANE_BROWSER_WORKER_DEGRADED_AFTER_SECONDS` (45),
`REVIEWPLANE_BROWSER_WORKER_LOST_AFTER_SECONDS` (90) and
`REVIEWPLANE_BROWSER_WORKER_MONITOR_INTERVAL_SECONDS` (5), mirroring the
connector's shape and cross-validating at load: lost must exceed degraded, and
degraded must exceed the heartbeat interval, or a worker heartbeating exactly on
time would be degraded between two heartbeats.

`WORKER_STALE_AFTER_SECONDS` in `status.ts` becomes a re-export of the degraded
default rather than an independent constant.

### The reconciler acts on what it finds

In the same pass, for each live worker the control plane asks what contexts it
holds (`worker.contexts.request` / `worker.contexts`) and compares:

- a context no live session claims is an **orphan** and is terminated on the
  worker, recorded as `browser_session.reconciled`;
- a session the control plane believes is live on a worker that no longer holds
  it is marked `DEGRADED`, not terminated — `docs/DOMAIN_MODEL.md` §12 requires
  the session and its metadata to be retained and to stay diagnosable;
- a session on a worker that has gone (`lost` or `revoked`) is marked `FAILED`,
  and evidence already uploaded stays exactly where it is
  (`docs/ARCHITECTURE.md` §14).

Control leases past `expires_at` are revoked in the same pass. `docs/SECURITY.md`
§8 requires leases to expire and nothing enforced it: `expires_at` was written
and never read. Expiry does **not** move the control epoch — the epoch moves
when a controller changes, and nobody has taken control.

## Consequences

### Positive

- A stopped worker is visible as stopped, in the row, in the timeline and in
  `reviewplane status`, rather than only in the absence of working sessions.
- A session requested with no live worker is refused with
  `BROWSER_CAPACITY_EXHAUSTED`, which is a diagnosable answer with a documented
  UI state, instead of hanging in `ALLOCATING`.
- A worker that dies between two sweeps still cannot be scheduled onto, because
  the predicate is in the scheduler's own query.
- One definition of "live". A test that removes the term from any decision path
  fails.

### Negative

- The sweep is a timer in the API process, not a durable job, so it does not run
  in a deployment that runs only `reviewplane jobs`. The query term still holds
  there, so decisions stay safe and only the *state* goes stale — but the state
  is what an operator reads, so a jobs-only deployment would show `active` rows
  for gone workers. Stage 2's multi-process work should move the sweep to the
  job runner.
- Reconciliation adds a periodic control-plane-to-worker request per live
  worker. At one worker and a five-second interval this is negligible; at Stage
  2's worker count it becomes a fan-out that wants batching.
- `browser_worker.*` events are recorded against the deployment's first
  organisation, because a worker belongs to the deployment rather than to an
  organisation and an event needs a stream. That is the same compromise the
  backup events make, and it will need revisiting if a deployment ever holds
  more than one organisation.

## Alternatives considered

**Only the background sweep.** Rejected: a worker that dies between two passes
is still `active` in the row, so the scheduler would use it. The failure would
surface as a session that never becomes ready — the exact symptom RVP-70 was
filed about, merely narrowed to a five-second window.

**Only the query term.** Rejected: the decision would be safe and the stored
state would be permanently wrong, so `reviewplane status`, the timeline and any
future audit would describe a fleet that does not exist. It would also leave
`browser_workers.status` with two values nothing writes, which is what produced
this defect.

**A durable job (`JobKind`) instead of a timer.** It would survive an API
restart mid-pass and be visible in the job table. Rejected for Stage 1 because
`job_kind` is a protocol enumeration and the handler map must be registered in
two composition roots, so the change is wider than the connector-shaped timer
that already exists two files away — and the sweep is idempotent, so a missed
pass costs one interval. Worth revisiting with the jobs-process split.

**Reuse the connector's uppercase status vocabulary
(`ACTIVE`/`DEGRADED`/`DISCONNECTED`).** Rejected: `browser_workers.status`
already has a lowercase `CHECK` constraint with `active`/`degraded`/`lost`/
`revoked`, and changing stored values to unify spelling is a data migration in
exchange for nothing an operator can see. The *shape* is unified; the spelling
is not, and `docs/OPERATIONS.md` §8 names both.

## Follow-up

- `docs/OPERATIONS.md` §8 documents the thresholds and the transitions; §9
  documents what reconciliation does.
- `docs/CONFIGURATION.md` documents the four settings.
- RVP-70 is closed by the change that accepts this ADR.
- Move the sweep to the durable job runner when the API and jobs processes are
  separated in earnest.
