# ADR-0026: A browser worker's project assignment is restated on every heartbeat, and a revocation ends the sessions it covered

- Status: Accepted
- Date: 2026-08-01

## Context

`docs/SECURITY.md` §6.4 restricts a browser worker to the projects an
administrator has assigned to it, and `docs/ARCHITECTURE.md` §11 makes the
control plane the authority for that assignment. The Stage 0 implementation
delivered the set **once**, in the registration acknowledgement
(`worker.register.ack`), and the worker cached it in memory for the life of the
process. The heartbeat carried capacity upwards and returned `204 No Content`.

That is two defects wearing one shape (RVP-60).

- In the **grant** direction it is an availability problem. A project assigned
  while the worker was running was refused with `PROJECT_CONTEXT_MISMATCH` until
  the worker restarted. The Stage 0 end-to-end scenario worked around it by
  restarting the container after assignment, with a comment in
  `deploy/compose/e2e/run.sh` pointing at this gap.
- In the **revoke** direction it is an authorisation problem, and it is the one
  that matters. An administrator who unassigned a project had no way to make
  that true: the worker went on accepting sessions for it, and any session
  already running went on running, until something unrelated restarted the
  process. "Restricted to its assigned projects" was a description of the
  worker's startup, not of its behaviour.

Nothing detected this. The worker's assignment cache and the control plane's
`browser_worker_projects` table are two representations of one fact with no
mechanism that made them converge, and no test asserted that they did.

Two shapes were available: tell the worker when the set *changes*, or restate
the set on a message that already exists.

## Decision

### The heartbeat answers with the whole current assignment

`worker.heartbeat` is answered with `worker.heartbeat.ack`, a new
control-plane-to-worker message carrying `assigned_projects`,
`heartbeat_interval_seconds` and `observed_at`. `assigned_projects` is the
**complete current set**, not a change list.

Restating rather than diffing is the load-bearing choice. A change notification
has to be delivered exactly once to be correct, and the worker channel is
request/response over an internal network where a response can be lost. A worker
that missed a "you no longer serve project X" message would keep serving it
indefinitely, which is the failure this ADR exists to remove. A restatement
converges from any starting point, needs no acknowledgement of its own, and lets
either side restart without a resynchronisation step.

The staleness of an assignment is therefore bounded by one heartbeat interval —
15 seconds by default, configurable through
`REVIEWPLANE_BROWSER_WORKER_HEARTBEAT_INTERVAL_SECONDS`.

### A heartbeat that fails does not clear the assignment

A heartbeat the control plane could not answer leaves the worker's assignment
exactly as it was. Losing an answer is not being told the set is empty, and
treating the two alike would take a working worker out of service every time the
control plane restarted — turning an availability blip into an outage, in the
name of a security property that a control plane in that state cannot be
enforcing anyway.

### A revocation ends the sessions it covered

When a project leaves the set, every browser session the worker is running for
that project is **terminated**, with reason `policy`. It is not left to finish.

A browser session is a live window into a development machine held open by an
authorisation an administrator has just withdrawn. Letting it run to its
duration limit would mean the withdrawal took up to two hours to become true,
which is indistinguishable from the defect this ADR fixes. Evidence already
uploaded is untouched — it belongs to the artefact store and to the review, not
to the session — and the termination is reported to the control plane like any
other, so the timeline records why.

This is the "documented policy" RVP-60's acceptance criteria require for
in-flight sessions.

### The control plane keeps the authority

The worker's copy remains a cache and never a source. `BrowserSessionService`
refuses to allocate a session for a project the worker is not assigned to before
the worker is contacted, and the worker refuses it again on arrival. Both checks
stay: the control plane's is the authoritative one, and the worker's is what
protects the browser if a session ever reaches it by another path.

## Consequences

### Positive

- A revocation takes effect within one heartbeat interval, on new allocations
  and on running sessions, without a restart.
- The end-to-end scenario's restart workaround is removable.
- One message type carries the fact instead of two, and the fact converges from
  any state rather than depending on delivery of a change.
- The acknowledgement carries the heartbeat interval too, so an operator can
  change the cadence without restarting workers.

### Negative

- Every heartbeat now carries an assignment list rather than nothing. The list
  is bounded at 256 identifiers and the message at 32 KiB, and at one heartbeat
  per worker per 15 seconds the cost is negligible — but it is not zero, and it
  scales with assignment size rather than with change.
- Revocation is enforced at the worker rather than at the control plane's next
  decision, so it is bounded by the heartbeat interval rather than immediate. A
  deployment that needs immediacy needs a push channel, which Stage 1 does not
  have.
- Terminating in-flight sessions on revocation is destructive and irreversible
  from the user's point of view: an administrator who unassigns a project by
  mistake ends the reader's live session. That is the correct trade for an
  authorisation withdrawal, and it is stated in `docs/SECURITY.md` §6.4 so it is
  not a surprise.

## Alternatives considered

**Push the change on a control channel.** Immediate, and the right answer once a
persistent worker channel exists. Stage 1's worker channel is request/response
initiated by whichever side has something to say, so a push would need a new
connection type with its own reconnection and backpressure semantics —
substantial machinery for a property a 15-second bound already delivers.

**Have the worker poll a dedicated assignment endpoint.** Equivalent in effect
and worse in shape: a second periodic call with a second failure mode, when the
existing heartbeat already runs on the cadence the answer needs.

**Make the control plane re-validate on every allocation and leave the worker's
cache stale.** This is already true and is not sufficient: it fixes new
allocations and does nothing about a session already running, which is exactly
the half a revocation is about.

**Let in-flight sessions finish.** Considered and rejected above. It would make
the revocation's effective time the session duration limit, which is not a
bound an administrator can reason about.

## Follow-up

- `docs/SECURITY.md` §6.4 and `docs/ARCHITECTURE.md` §11 state the bound and the
  in-flight policy.
- `docs/CONFIGURATION.md` documents
  `REVIEWPLANE_BROWSER_WORKER_HEARTBEAT_INTERVAL_SECONDS`.
- RVP-60 is closed by the change that accepts this ADR.
- Stage 2's multi-worker work (RVP-17) inherits this shape unchanged; a
  per-worker assignment restated on that worker's own heartbeat needs no
  coordination between workers.
