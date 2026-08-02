# Event Specification

## 1. Purpose

Events provide immutable audit history, session timelines, realtime updates and integration delivery. They complement current-state tables rather than requiring full event-sourced reconstruction.

## 2. Event envelope

```json
{
  "id": "evt_...",
  "schema_version": 1,
  "sequence": 812,
  "type": "finding.verification_submitted",
  "occurred_at": "2026-07-28T11:24:22.182Z",
  "recorded_at": "2026-07-28T11:24:22.193Z",
  "organisation_id": "org_...",
  "project_id": "prj_...",
  "actor": {
    "type": "agent_session",
    "id": "ags_...",
    "display": "Claude Code on dev-ai-03"
  },
  "correlation": {
    "request_id": "req_...",
    "causation_event_id": "evt_...",
    "browser_session_id": "brs_...",
    "review_id": "rev_...",
    "finding_id": "fin_..."
  },
  "payload": {}
}
```

The envelope's shape is defined once, in
`packages/protocol/schemas/platform/v1.schema.json`, and generated into
TypeScript and Go from there (ADR-0013). `project_id` is optional and absent
only for an occurrence that precedes any project association — a connector
enrolment does — in which case the organisation is the stream.

## 3. Ordering

- `sequence` is monotonically increasing within a project event stream.
- Global ordering across projects is not guaranteed.
- Consumers use event ID for deduplication.
- Realtime reconnect resumes from last acknowledged project sequence.

A sequence is allocated by a row in `event_streams` that the writing
transaction locks and increments, so monotonicity holds under concurrency in a
way a `max() + 1` read would not. A stream key is a project where one exists and
the organisation otherwise. Sequences start at 1 and are never reused; `0` is
the value a subscriber sends to mean "I hold nothing", and is never an event's
position.

Identifiers in an event — its own `id`, and every identifier in `actor`,
`correlation` and the payload — are opaque (`docs/DOMAIN_MODEL.md` section 3).
They encode no tenant, no timestamp and no database sequence, so ordering
events by identifier is meaningless and MUST NOT be attempted; `sequence` is
the only ordering this specification defines.

## 4. Immutability

Events are append-only. Corrections are represented by new events. Sensitive payload fields may be cryptographically erased only under documented deletion policy, while retaining a tombstone audit event.

## 5. Actor types

- `human_user`
- `agent_session`
- `connector`
- `browser_worker`
- `system`
- `integration`

Actor identity must never be inferred only from display text.

## 6. Event naming

Format:

```text
<aggregate>.<past_tense_action>
```

Examples:

- `review.created`
- `finding.claimed`
- `browser.control_transferred`

Names are stable public integration contracts.

## 7. Core event catalogue

### Organisation and identity

- `organisation.created`
- `user.invited`
- `user.credentials_set`
- `membership.role_changed`
- `authentication.login_succeeded`
- `authentication.login_failed`
- `session.revoked`

These are written to the organisation's stream, because a human identity
precedes any project association.

`user.invited` records that a one-time credential-establishing grant was issued.
Stage 1's only form is the installation token an operator mints with
`reviewplane install-token`; the payload names the user and when the grant
closes, and never the token. `user.credentials_set` records that a password was
established or replaced, which `docs/SECURITY.md` section 16 requires of a
permission change; it carries the user and the route the credential arrived by
and nothing derived from the credential.

`authentication.login_failed` carries a stable reason — `unknown_user`,
`invalid_password`, `password_not_set`, `user_suspended`, `rate_limited`, or one
of the install-token reasons — and it never carries the submitted password, nor
the address submitted beside it. People type passwords into email fields, and an
append-only table is the worst place in the system to discover that. Its actor
is `system`: an unauthenticated attempt has not established who made it, and the
payload names a user only when the attempt reached one that exists.

`session.revoked` covers sign-out, rotation on privilege change and
administrative revocation, distinguished by `reason`. Rotation writes it for the
session being replaced, and the replacement records which session it replaced,
so an auditor reading the pair sees one rotation rather than two unrelated
events.

### Project

- `project.created`
- `project.updated`
- `project.repository_changed`
- `project.archived`

`project.updated` names the fields that changed rather than restating the
record: the record is queryable, and the audit question is what moved.

`project.repository_changed` is separate from it, and carries both the previous
and the new canonical identity. A review's captured commit is interpreted
against the repository the project points at, so moving it quietly would
reinterpret history (`docs/DOMAIN_MODEL.md` section 6).

`project.archived` carries the previous and new status. Archival is not
deletion: the project's reviews, evidence and events all outlive it.

### Connector and environment

- `connector.enrolled`
- `connector.connected`
- `connector.degraded`
- `connector.disconnected`
- `connector.revoked`
- `workspace.observed`
- `workspace.head_changed`

These occurrences share a channel of their own, `environment`, because a
connector enrolment can precede any project association: they are neither
organisation lifecycle nor project lifecycle, and the envelope's `project_id` is
absent for the ones that have no project yet (section 2).

`connector.enrolled` records the identity that was issued and the environment it
was issued to — environment name, platform, architecture, connector version,
advertised capabilities, certificate fingerprint and identity expiry. It records
the enrolment token's **identifier** and never the token. An event is
append-only, so a credential written into one cannot be taken out again
(`docs/SECURITY.md` section 18).

The three status events name **both** sides of the transition. `previous_status`
is the status the record was actually in, read under the same lock that changed
it — not the set of statuses the transition was willing to accept. Recording the
willing set was wrong in a way an auditor could not see through: a
`previous_status` reading `PENDING_ENROLMENT|DEGRADED|DISCONNECTED` names three
states the connector was not in and one it was, and no consumer can tell which.

`connector.degraded` and `connector.disconnected` are conclusions the control
plane draws from silence, never self-reports
(`docs/CONNECTOR_PROTOCOL.md` section 8), so their payloads state how long the
silence had lasted as a **lower bound**: a sweep observes silence rather than
measuring it. `connector.disconnected` distinguishes a closed channel from an
exhausted heartbeat budget by `trigger`, so an operator can tell a clean stop
from a network that went away, and carries the silence bound only for the
latter, because a closed channel is observed rather than inferred.

`connector.revoked` reports what the revocation reached: `routes_revoked`,
`sessions_disconnected`, `channels_closed` and `agent_credentials_revoked`.
Revocation is several things at once (`docs/CONNECTOR_PROTOCOL.md` section 18)
and an auditor needs to see that all of them happened; `sessions_disconnected`
counts browser sessions moved to `DEGRADED`, and each of those also writes its
own `browser_session.degraded` with the reason `connector_revoked`.

`agent_credentials_revoked` counts the short-lived agent credentials the
connector had minted for the local MCP bridge (ADR-0023) that were still live.
They are counted here rather than only in their own events because refusing the
exchange to a revoked identity closes the next credential and not the ones
already issued, so "the identity is invalid" and "nothing it issued still works"
are two different facts and only the second one is this count. Each revoked
credential also writes its own `session.revoked`, per project it reached, with
the reason `connector_revoked` — the same event type an administrative
revocation of an agent credential writes, distinguished by that reason.

`workspace.observed` records that a checkout became known — by a connector
reporting a configured path, or by an operator or agent session registering one,
distinguished by `source`. It carries the path hash, the display label, the
canonical repository identity where there is one, the branch, the head commit
and the dirty state, and it has no member capable of carrying file contents, a
changed-path list or a full filesystem path (ADR-0022).

**An unchanged repeat observation writes no event.** A connector re-observes on
an interval whether or not anything happened, and an identical report refreshes
the workspace's `last_observed_at` and stops there. Writing one every interval
would fill the audit trail with the fact that nothing changed, which is the
sampling this section requires of a high-frequency signal — and it would drown
the events that do carry a change.

`workspace.head_changed` is that change: a move in branch, head commit or dirty
state, carrying **both** sides. A review captured before the move was captured
against the previous head, and an auditor reading only the new one could not
tell.

### Published service

- `published_service.requested`
- `published_service.ready`
- `published_service.failed`
- `published_service.expired`
- `published_service.revoked`

These five have their own channel, `published_service`, because a route's
lifecycle is neither environment lifecycle nor project lifecycle: it is
short-lived, it belongs to exactly one project, and every transition of it is an
access decision section 16 of `docs/SECURITY.md` requires to be auditable on its
own.

`published_service.requested` is written **before** the connector or the tunnel
gateway is told anything, so a refusal always has the request it refused to be
read against. Its actor is whoever asked: a human through the API, or an
`agent_session` through `development_service_publish`.

`published_service.ready` covers two occurrences. A route that began carrying
traffic records the destination the connector reported it opened — which is what
it observed, not what the control plane asked for, so the two can be compared —
and a session-scoped capability minted against a live route records the
capability's **identifier**, the browser session it was minted for and the
signing key it was minted with. It never records the token. An event is
append-only, so a credential written into one cannot be taken out again
(section 8), and the corpus refuses a payload that carries one rather than
leaving it to review.

`published_service.failed` carries a stable class from a closed vocabulary and
never free text. A refusal the vocabulary does not name is recorded as
`INTERNAL_ERROR` rather than widening it at write time, because an event no
consumer can decode is worse than a coarse one.

`published_service.expired` and `published_service.revoked` are both terminal
and both close streams already in flight. `docs/CONNECTOR_PROTOCOL.md` §12.3
reports both to the browser as `ROUTE_EXPIRED` because §21 is a closed
vocabulary; which of the two happened is here, and nowhere else. The revocation
event names the capabilities it withdrew, because revoking a route without
withdrawing the credentials minted against it would leave the revocation partial.

### Agent session

- `agent_credential.issued`
- `agent_session.started`
- `agent_session.waiting`
- `agent_session.blocked`
- `agent_session.completed`
- `agent_session.failed`
- `agent_session.disconnected`

`agent_credential.issued` is a permission change and section 16 of
`docs/SECURITY.md` requires an audit record for one. It names the projects and
capabilities granted and the expiry, and never the token. It is recorded once per
project the credential is bound to, because the event stream is per project.

Its **actor** distinguishes the two issuance paths. A credential an
administrator granted is recorded with a `human_user` actor; one a development
machine minted for its own local MCP bridge is recorded with a `connector` actor
and `issued_for: local_mcp_bridge` (ADR-0023). An auditor asking "who let this
agent in" gets a different answer for each, which is the whole reason the second
path is separately audited rather than folded into the first.

`agent_session.completed` and `agent_session.disconnected` are not
interchangeable. A session ends `COMPLETED` when the client closed it and
`DISCONNECTED` when the control plane stopped serving. Recording the first for
the second would tell a human reading a timeline that an agent walked away
satisfied.

`agent_session.started` records the client's self-reported name and version, the
capabilities the session was granted and the client capabilities it declared.
The client's name is description and never an authorisation input.

### Browser worker

- `browser_worker.registered`
- `browser_worker.degraded`
- `browser_worker.lost`

A worker that stops heartbeating is moved `active` → `degraded` → `lost` by the
liveness sweep of `OPERATIONS.md` §8, and each move emits its event with
`previous_status`, `new_status`, the trigger and the silence budget it exceeded.
`browser_worker.registered` also records a **recovery**: a degraded or lost
worker that heartbeats again returns to `active`, with `trigger:
heartbeat_recovered`, because "it came back" and "it never went" are different
facts to somebody reading a timeline.

These events belong to the deployment rather than to a project, so they carry no
`project_id` and are recorded on the organisation stream.

### Browser session

- `browser_session.requested`
- `browser_session.allocated`
- `browser_session.ready`
- `browser_session.navigated`
- `browser_session.paused`
- `browser_session.resumed`
- `browser_session.degraded`
- `browser_session.terminated`
- `browser_session.failed`
- `browser_session.reconciled`

`browser_session.paused` and `browser_session.resumed` record a change of
*authority*, not of the browser: a paused session's context stays open, its live
frames keep flowing and non-interactive system capture continues
(`MCP_SPEC.md` §7.3). `browser_session.reconciled` records an action the
reconciliation of `OPERATIONS.md` §9 took that is not itself a session
transition — currently the termination of an orphan worker context, whose
`browser_session_id` names a session the control plane no longer considers live.

### Control

- `browser.control_requested`
- `browser.control_transferred`
- `browser.control_released`
- `browser.command_rejected`
- `browser.command_executed`
- `browser.live_view_started`
- `browser.live_view_stopped`

Do not emit every pointer movement as a durable event. High-frequency input may be sampled or summarised.

**Every** refused browser command produces `browser.command_rejected`, not only
a stale epoch: a wrong session status, a foreign project, a non-owning
controller, a missing worker, a route that no longer authorises the session and a
policy denial each produce one, carrying the stable error code, a `reason` token,
the presented epoch and the presented controller type. `SECURITY.md` §8 requires
a rejected command to be *logged* as well as refused, and until RVP-30 only one
of the denials in the command path was — so an auditor asking whether anything
had tried to drive a terminated session received the same answer as if nothing
had.

`browser.command_rejected` covers refused **lifecycle acts** as well as refused
browser commands: a pause, resume, end, control request or control release that
is refused writes one, with `kind: "lifecycle"` and `command` naming the act
(`pause`, `resume`, `end`, `control_request`, `control_release`). A browser
command carries `kind: "command"`'s absence — it is the default shape — and
`command` from the browser command vocabulary.

Sharing one type is deliberate. The question an auditor asks is "did anything
try to act on this session and get refused?", and splitting the answer across
two event types would mean an auditor who checked one and not the other got a
confident wrong answer. Until the adversarial review of RVP-30 the lifecycle
half wrote nothing at all, which is the same defect the command path had already
been fixed for, reproduced one layer up.

The payload members are `command`, `reason_code`, `reason`, `interactive`,
`presented_epoch` and `presented_controller_type` on every rejection;
`current_epoch` and `session_status` where the actor was entitled to know them;
and `cross_project` where it was not. They are named without a prefix because
the record is correlated to `browser_session_id`, so every member is about that
one session by construction — which is the opposite of the refusal `details`
object of `API.md` §5, one object serving reviews, findings and sessions, where
a bare `status` would say nothing about which record it described.

A **capacity** refusal is deliberately not one of these. `BROWSER_CAPACITY_EXHAUSTED`
is a scheduling outcome rather than an authority denial: no session exists for
the record to be correlated to, nobody was refused an authority they might have
held, and the operator's trail for it is `browser_worker.degraded` /
`browser_worker.lost` plus `reviewplane status`, which say *why* there was no
capacity. Recording one event per refused attempt would also let a client
retrying in a loop write to an append-only table at request rate.

Nothing validates these names. There is no per-type payload schema for
`browser.command_rejected`, so `pnpm protocol:check` and typecheck are both
blind to a renamed or missing member; only an assertion against the event store
catches one. Tests that read this payload therefore assert the **exact key set**
rather than the absence of a member: "no `session_status`" is satisfied just as
well by a field that has been renamed and is leaking under the new name.

A payload here never carries the command's arguments. A refused `browser_type`
is exactly the command whose argument must not enter an append-only table.

A **cross-project** attempt is recorded on the **actor's** project stream and
never on the named session's. Writing it to the other project's stream would let
a caller with no authority there append rows to a timeline they cannot read. That
record omits the other session's epoch and status for the same reason, and the
refusal the caller receives stays byte-identical to the one an unknown identifier
earns (`API.md` §5).

The live-view pair is per viewer attachment, not per frame. A frame is not an
event, and a payload here never carries frame content: `started` records the
mode, `stopped` records why the viewer left and how many frames it was sent and
had dropped. They exist because a human watching a browser session is an access
to the most sensitive data the product handles (`docs/SECURITY.md` section 14),
and `AGENTS.md` requires that to leave an audit record.

### Evidence

- `screenshot.captured`
- `artefact.upload_started`
- `artefact.upload_completed`
- `artefact.upload_failed`
- `artefact.access_granted`
- `artefact.deleted`
- `artefact.thumbnail_generated`
- `artefact.redacted`
- `artefact.expired`
- `trace.finalised`

`artefact.access_granted` records that a subject was admitted to one artefact's
bytes and until when (ADR-0019). Reading evidence is an access to the most
sensitive data the product holds, and section 16 of `docs/SECURITY.md` requires
it to leave a record.

`artefact.deleted` records a removal. Its `bytes_removed` member says whether
the stored object was actually removed, which is not the same question as
whether the artefact was deleted: keys are content-addressed (ADR-0012), so two
artefacts holding identical bytes are one stored object and the object survives
until the last of them is gone. The metadata row is retained with `deleted_at`
set, so the identifier in this event still resolves.

`artefact.thumbnail_generated` records the outcome of the durable thumbnail job
for **every** result, including the ones that produced no thumbnail.
`docs/UX_FLOWS.md` section 18 requires a surface to be able to say which of
not-yet, not-possible and failed applies, and an event written only on success
would leave the other two indistinguishable.

`artefact.redacted` and `artefact.expired` are not yet produced: no redaction
and no expiry job run.

### Review

- `review.created`
- `review.named`
- `review.assigned`
- `review.claimed`
- `review.status_changed`
- `review.accepted`
- `review.reopened`
- `review.archived`
- `review.comment_added`
- `review.status_change_denied`

### Finding

- `finding.created`
- `finding.annotated`
- `finding.claimed`
- `finding.status_changed`
- `finding.comment_added`
- `finding.verification_submitted`
- `finding.resolved`
- `finding.reopened`
- `finding.status_change_denied`

`review.claimed` and `finding.claimed` are separate from the status change
beside them, because assignment and lifecycle are different facts: a claim says
who is working, and the status says what stage the work is at. A human reading
the timeline needs both.

`review.assigned` is separate from `review.claimed` for the same kind of reason:
a human directing work and a worker taking it are different facts, and an auditor
asking "was this given to the agent, or did it take it?" needs to be able to
tell.

`review.accepted`, `finding.resolved` and `finding.reopened` sit beside the
status change rather than instead of it. The status says the record moved; these
say a **human decided**, and name which human. That is the authority boundary of
`AGENTS.md`, and an audit trail that recorded only a status would not say who
crossed it. `review.accepted` also records how many findings the review held and
how many of them a human authored, because acceptance rests on every one of those
having reached a final disposition and the table will have moved on by the time
anybody reads the event. `finding.reopened` records how many verifications the
finding already holds, because reopening preserves that history rather than
replacing it.

`review.comment_added` is a separate type from `finding.comment_added` so that a
consumer filtering one finding's timeline does not have to inspect a payload to
decide whether an event belongs to it. An edited comment produces another
`*.comment_added` for the new revision: an edit is an append with a
back-reference, not a different kind of occurrence.

`review.status_change_denied` and `finding.status_change_denied` record a
transition a principal asked for and **may not make**. They are the only events
in this catalogue written for something that did not happen, and they exist
because the refusal is the invariant holding: `AGENTS.md` requires that an agent
cannot finally accept a human-authored finding, and a Stage 1 exit criterion
requires that the attempt is audited. The transaction the refusal happened in
rolls back, taking any event written inside it, so these are written afterwards
in their own transaction. They carry the status the record actually held, the
status that was asked for, the finding's `source` where there is one, and the
stable refusal code — and never any part of the request.

`finding.verification_submitted` carries the whole claim — summary, branch,
commit, tested viewports, checks and every artefact identifier — with status
`submitted`. The control plane has already verified that each artefact belongs
to this project and to a browser session of this project before the event is
written, so evidence from elsewhere never reaches the audit trail.
- `finding.verification_accepted`
- `finding.verification_rejected`
- `finding.resolved`
- `finding.reopened`

### Inbox

- `inbox_item.created`
- `inbox_item.acknowledged`
- `inbox_item.completed`
- `inbox_item.dismissed`
- `inbox_item.expired`

`inbox_item.created` is written in the **same transaction** as the act that
caused it — a review assignment or a human reopening a finding — so a delivery
that was recorded is a delivery that happened, and an assignment that rolled
back delivered nothing (§9). A repeated assignment of the same work to the same
recipient creates no second item and therefore no second event.

`inbox_item.acknowledged` and `inbox_item.completed` are separate types on
purpose. `docs/DOMAIN_MODEL.md` §21 says acknowledgement does not imply task
completion, and an auditor asking which of the two happened must not have to
infer it from a payload. The acknowledgement payload carries no completion
member at all, so a consumer cannot treat them as one; no agent-facing tool can
produce `inbox_item.completed`, which is a human's record that the work is done.

`inbox_item.dismissed` is not in the original catalogue and is here because
`docs/DOMAIN_MODEL.md` §21 lists `dismissed` as a status a record can hold:
dismissing delivered feedback is a decision somebody made, and `AGENTS.md`
requires a meaningful state change to produce an audit record.

Every one of the four transition events names **both** sides, carrying
`previous_status` read under the lock that changed it, for the reason the
connector status events state: the set a transition was willing to accept is not
the state the record was in.

`inbox_item.expired` is a conclusion the control plane draws rather than an act
a recipient performed. Nothing produces it yet; the sweep that will arrives with
the retention work of Stage 2, and the status and the column exist so that it is
reachable rather than decorative.

### Policy and approval

- `policy.created`
- `policy.updated`
- `policy.decision_recorded`
- `approval.requested`
- `approval.granted`
- `approval.rejected`
- `approval.expired`

### Secrets

- `secret.reference_created`
- `secret.injection_requested`
- `secret.injection_succeeded`
- `secret.injection_failed`

Never include secret values.

### Durable jobs

- `job.enqueued`
- `job.succeeded`
- `job.failed`

Background work is a state change like any other, and the run that nobody is
watching is exactly the one an operator later needs a record of.
`job.failed` states whether another attempt is scheduled rather than leaving it
to be inferred, so a retry and a dead-lettered job are distinguishable from the
audit trail alone.

### Backup and restore

- `backup.created`
- `backup.restored`

`docs/SECURITY.md` section 16 requires audit coverage of export and backup
operations, and these are it. Both are written to the organisation's stream by
`reviewplane backup` and `reviewplane restore`, whose actor is `system`: the
operator command line runs inside the container with no request and no session,
so attributing it to a human identity would be an invention.

`backup.created` names what the archive carried — `mode`, `schema_version`,
`product_version`, `tables`, `rows`, `artefact_objects`, `artefact_bytes`,
`artefacts_missing`, `archive_sha256` and `key_material_included`. It does
**not** carry the
archive's path: an operator's destination is not something the audit trail
needs, and a path is the field of this operation most likely to name a mount, a
host or a share.

`backup.restored` names the archive it came from — `mode`, `schema_version`,
`backup_created_at`, the rows and objects loaded, how many referenced artefacts
were missing afterwards, and `hostname_changed`. It is written after the load
commits, so its presence means a restore finished rather than started.

`backup.created` is the record `reviewplane status` and
`reviewplane migrate --preflight` read to answer whether an installation is
backed up (`docs/OPERATIONS.md` sections 3 and 12). That is the reason it is an
event rather than a row somewhere: the audit trail is the evidence, and a second
copy of it would be a second thing to keep true.

Both events are written without enqueuing an outbox row when the schema they are
written against predates `event_outbox` (`0056`). That is what upgrading from
Stage 0 begins with — a backup of a `0054` database — and what rolling back to it
ends with, since a restore brings an installation to the archive's schema and
`backup.restored` is written there. The schema has no outbox to enqueue into and
no subscriber to deliver to; the audit record is written either way, because
`docs/SECURITY.md` §16 requires it and the moment a backup matters most is the
moment the schema is old. These are the only cases in which an event is written
without a delivery obligation.

`backup.restored` is written on the load's own transaction, so it commits with
the rows it describes (§9). A restore that failed writes no event and no rows.

## 8. Payload rules

The review-domain events — every `review.*`, `finding.*`, `artefact.*` and
`screenshot.*` type above — have their envelope and payload shapes defined in
`packages/protocol/schemas/review/v1.schema.json`, and are the only source for
them. The organisation, project and durable-job events —
`organisation.created`, `project.created`, `project.updated`,
`project.archived` and the three `job.*` types — have theirs in
`packages/protocol/schemas/platform/v1.schema.json`, which also owns the
envelope of section 2. A payload written by a service and refused by the schema
that owns its type is a defect caught by the contract test of
`docs/TESTING.md` section 2, which replays the stored rows through the
generated decoder.

Event names are a stable public contract, but the catalogue is additive within
a schema version: a consumer that meets a name it does not recognise MUST
ignore that event rather than fail. The names Stage 1 defines are recorded in
the `event_types` vocabulary of the platform schema.

A payload carrying a credential-shaped member — an authorisation header, a
cookie, a token, a password, a private key — is **refused by the writer** rather
than left to review. An event is append-only: a credential written into the
audit trail cannot be taken back out without the cryptographic erasure of
section 4, and by then it is in a backup. Recording the *identifier* of a
credential is correct and expected; recording its value is a defect.

- Payloads are versioned through `schema_version`.
- Include stable IDs and state transitions.
- Avoid duplicating large artefact content.
- Exclude raw secrets and sensitive headers.
- Include reason codes for denial and failure.
- Include previous and new state for state changes where safe.

Example:

```json
{
  "previous_status": "in_progress",
  "new_status": "awaiting_human_review",
  "verification_id": "ver_...",
  "version": 8
}
```

## 9. Transactionality

When a domain command changes authoritative state and creates an event, both
operations MUST commit in one database transaction. No code path may write
domain state without also appending an event.

External delivery occurs after commit through an outbox pattern. Delivery
cannot join the transaction — a socket write inside it would either block the
commit or deliver an event that then rolled back — so the same transaction
enqueues an `event_outbox` row, and a dispatcher discharges that obligation
after commit. A process that dies between commit and delivery loses nothing,
because the row survives it. The dispatcher claims with `FOR UPDATE SKIP
LOCKED`, so several control-plane processes deliver an event exactly once
between them without a broker.

When the database is unavailable a state-changing request MUST be denied rather
than proceed unaudited (`docs/ARCHITECTURE.md` section 14). The transaction
never opens, so there is no partial state and no partial event.

## 10. Realtime delivery

```text
/ws/v1/projects/:projectId/events
```

WebSocket subscribers authorise by organisation and project **before the
upgrade completes**, so an unauthenticated subscriber and a subscriber scoped
to another project never obtain a socket. A project outside the subscriber's
scope is refused with `RESOURCE_NOT_FOUND`, exactly as an unknown identifier
is: a refusal that said `AUTHORISATION_DENIED` would confirm that the project
exists.

The client opens by sending `stream.subscribe` with the last sequence it has
applied. The messages of this channel — `stream.subscribe`,
`stream.subscribed`, `stream.refresh_required`, `stream.heartbeat` and
`stream.error` — are defined in
`packages/protocol/schemas/platform/v1.schema.json`. An event envelope and a
control message are told apart by one member: an event's `type` is an event
name, a control message's `type` is a `stream.` discriminator.

Server response on gap:

- Replay retained events from sequence
- Or instruct client to refresh state when replay window is exceeded

The instruction is explicit — `stream.refresh_required`, carrying why, the
sequence the stream is at and the oldest sequence still replayable. It is sent
when the client's position is below the retained window, when it is ahead of
the stream, and when the gap exceeds the replay bound the client or the server
set. A silent jump would leave the client quietly wrong, which is worse than
telling it to refetch.

The handover from replay to live delivery loses nothing and repeats nothing:
the server attaches to the live stream **before** it reads history, buffers
what arrives meanwhile, and then drains that buffer discarding anything at or
below the last replayed sequence.

The same events are readable as pages at
`GET /api/v1/projects/:projectId/activity`, which is what a client refetches
from after a refresh instruction.

## 11. Webhooks and integrations

Later outbound integrations consume events through a durable delivery table.

Requirements:

- Signed payloads
- Retry with backoff
- Delivery ID for deduplication
- Dead-letter state
- Per-destination event filters
- Secret rotation

## 12. Retention

Audit-event retention is organisation policy. Session-detail events may have shorter retention than security and review events.

Deletion must preserve required referential and audit tombstones.
