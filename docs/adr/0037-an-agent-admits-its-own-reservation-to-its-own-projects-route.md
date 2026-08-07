# ADR-0037: An agent admits a browser session it reserved to a route its own project already publishes, and the reservation is the handoff to the process that mints

- Status: Proposed
- Date: 2026-08-07

## Context

`docs/MCP_SPEC.md` §7.3 gives an agent `browser_session_start` with a
`published_service_id`, and `packages/protocol/schemas/mcp/v1.schema.json`
describes it as "Published service the session may reach. A session started
without one can navigate nowhere." The tool accepts the argument and refuses it
(`apps/mcp-server/src/tools.ts:1624-1634`). The underlying refusal is
`apps/server/src/modules/browser-sessions/service.ts:315-320`, which fires
because `BrowserSessionService` was constructed with no `ServiceBinder`:
`apps/server/src/app.ts:302-307` passes a `PublishedServiceBinder`,
`apps/mcp-server/src/app.ts:145` passes nothing.

That is not an omission. Binding mints a session-scoped route capability, the
control plane is the minting authority (`docs/ARCHITECTURE.md` §7.3), and the
signing key is read only by `apps/server/src/config.ts:211-219`. The MCP process
is deliberately built without it — "a process that cannot mint cannot leak a
minting key" (`apps/server/src/modules/published-services/service.ts:83-97`,
ADR-0020, ADR-0021). So an agent can start a browser and that browser can reach
nothing, and `docs/MCP_SPEC.md` §7.3 tells the agent to "ask a human to bind the
route from the project's Live page."

Two things had to be established before this could be decided.

### The signing key is not the only obstacle. The ordering is.

`PublishedServiceService.mint` refuses unless the route already names the session
(`service.ts:754-761`), and `PublishedServiceBinder` states why the identifier is
reserved before the route is published
(`modules/published-services/session-binder.ts:10-14`). The worker's egress
policy is fixed when its context is created and cannot be widened afterwards
(`modules/browser-sessions/service.ts:180-186`), so a route cannot be attached to
an allocated session either.

A route therefore has to name a session that already exists and is not yet
allocated. `browser_session_start` reserves and allocates in one call
(`service.ts:431-443`), so a route published afterwards names the *old* session,
and a start naming that route is a start for a session the route does not
authorise. **Handing the MCP process a signing key would not have made
`browser_session_start {published_service_id}` work.** It would have moved the
refusal from `UNSUPPORTED_CAPABILITY` to `AUTHORISATION_DENIED`.

The HTTP surface has the shape that does work, and `docs/API.md` §11 documents
it: `{"allocate": false}` reserves, publication names the reservation, and
`POST /api/v1/browser-sessions/:sessionId/allocate` binds. §11 says so in as many
words — the one-request form is "for a session that needs no route, **or whose
route already names it**". `deploy/compose/e2e/run.sh:447-470` is that sequence,
and `apps/server/test/session-service-binding.test.ts` pins it.

**The agent surface has no reserve step, and neither does the web application.**
`apps/web/src/components/StartBrowserSession.tsx:193` offers a route selector on
a one-request start; the web API client has no `allocate: false` and no
`/allocate` call at all. That combination cannot succeed against the real control
plane, and the browser suite does not catch it because
`apps/web/test/ui/stub-control-plane.ts:1510-1522` binds any route to a freshly
minted session identifier without consulting `allowed_browser_session_ids`. The
remedy `docs/MCP_SPEC.md` §7.3 currently offers an agent — ask a human to bind it
from the Live page — is not available to the human either.

### Six authorisation questions, and three of them are not true anywhere yet

`RVP-90` requires each of the following to be explicit in the new path rather
than inherited from a caller: the session's project equals the route's project;
an **organisation** term is present and not only a project term; the route is
published and its connector enrolled, connected and not revoked; an idempotency
key binds one route and consumes one browser slot; a denial is audited; and the
minted capability stays session-scoped and is revoked when the session ends.

Three of them are not currently true anywhere, and a fourth is true in a form no
auditor can query.

`PublishedServiceBinder` reads the route with
`scope = { organisationId: null, projectIds: [input.projectId] }`
(`session-binder.ts:43`). It is sound today only because a project identifier
implies its organisation — an implication a shipped release violated, which is
why `CreatePublishedServiceInput.organisationId` carries the comment at
`modules/published-services/service.ts:100-111`. "Not narrowed" passed into a
scoped read is the shape RVP-91 and RVP-92 were, and a rule that holds because of
a second rule elsewhere is the kind that stops holding silently.

`findPublishableConnector` selects `connectors.status` and no caller reads it;
there is no status predicate (`modules/published-services/repository.ts:434-455`).
`apps/mcp-server/src/development-services.ts:104-123` requires
`status = 'ACTIVE'`. The two publication surfaces disagree, which is RVP-81, and
this decision creates a second agent-originated path that needs the same rule.

Nothing revokes a route capability when a browser session ends.
`terminate` revokes the control lease and stops
(`modules/browser-sessions/service.ts:740-759`);
`revokeCapabilitiesForService` is per route, not per session; and
`HttpTunnelGateway.revokeCapability`
(`modules/published-services/gateway-client.ts:122`) has no production caller at
all. `docs/ARCHITECTURE.md` §7.3 nevertheless states that a capability "is
revocable individually as well as through its route".

RVP-90's sixth check asked for the capability to be "revoked when the session
ends". **That is not achievable inside this change**, and this ADR does not
claim it. The gateway verifies a capability from its signature without a
database read, and RVP-76 records that its revocation set is in-memory and does
not survive a restart, so a revocation this change records is only as durable as
the gateway underneath it. The gap is RVP-99. What *is* achievable here is
bounding the credential's lifetime by the session's, and that is what this
decision does.

Finally, `#failReservation` records its reason as **free text** — the caught
error's `message` (`modules/browser-sessions/service.ts:329-334`) — where
`docs/EVENTS.md` §8 requires a stable class, and where the publication path
already gets it right: "No free text: the class is the diagnosis"
(`modules/published-services/service.ts:512-514`).

## Decision

### The authority the agent path carries

An authenticated agent session may **admit a browser session it reserved itself,
in the project its credential is bound to, to a route that project has already
published and that already names that session.**

It carries no other authority, and the absence is structural rather than
checked. The agent cannot publish a route on this path, cannot widen one, cannot
name a connector, a destination, a workspace, an origin, an organisation or a
project, cannot admit a session it did not reserve, and cannot cause a capability
to be minted for any pair the route does not already authorise. The tool has two
arguments — a reservation and a route — and each is resolved inside the
credential's organisation and the session's project before either is used.

The process that completes the bind acts under **no authority of its own**. It
re-derives every term from records the requesting process did not author — the
route, its connector, the project — and refuses on any disagreement. It cannot
bind anything the route does not already authorise, because the allow-list it
checks was written by `PublishedServiceService.request`, which validates every
session named in it against the route's own project
(`modules/published-services/service.ts:345-362`). **The reservation is a
request, not a grant**, and that distinction is what makes it safe for a process
holding a signing key to act on a row written by the process that does not.

### The agent surface gains the reserve/allocate split the HTTP surface has

`browser_session_start` gains `allocate`, defaulting to `true`, with the meaning
`docs/API.md` §11 already gives it. A new tool `browser_session_allocate` takes
`browser_session_id`, an optional `published_service_id` and an idempotency key.

The two surfaces then describe one mechanism. A reader who has read `docs/API.md`
§11 has read `docs/MCP_SPEC.md` §7.3, and a second shape for one act is not
invented for the agent's benefit.

### `published_service_id` stays on `browser_session_start_input`, deprecated

It is tempting to remove it. It is the one member of that schema no successful
call can carry, and a contract with a member that always fails is a contract that
lies. Two things decide against it.

**The documents do not permit the removal, and this is the reason that decides
it.** `docs/MCP_SPEC.md` §14: "Breaking tool changes require a new major protocol
version **or a parallel tool name**." `protocol_version` is pinned at `1` and any
other value is refused rather than best-effort parsed, and
`browser_session_start_input` is `additionalProperties: false` — so deleting a
member is a breaking tool change inside version 1. This decision already takes
§14's escape hatch by adding the parallel tool `browser_session_allocate`, and
the hatch is "add the parallel tool", not "add the parallel tool **and also**
delete a member of the old one". `docs/API.md` §20 states the equivalent rule for
the HTTP surface: "Removing or changing meaning requires a new major path or
compatibility adapter."

The second reason below is a design judgement and is worth keeping; this one is
a rule, and a reader should meet it first.

**And removing it would route a foreseeable refusal into the one layer this ADR
has just established is unaudited.** `browser_session_start_input` is
`additionalProperties: false`, so a removed member is refused by the generated
validator in `decode` (`apps/mcp-server/src/tools.ts:212-220`) before any domain
code runs. `auditReservedStatusAttempt` fires only for a tool carrying an
`authority` member and only for a human-reserved status, so
`browser_session_start` would record nothing — and the agent would receive the
validator's own text, which names neither the condition nor the way out
(`docs/UX_FLOWS.md` §18). Every agent following the *current* §7.3, a cached tool
description or an older prompt sends this argument. Meeting all of them with an
unrecorded, undiagnosable refusal is choosing the exact shape RVP-49 was.

So the member is retained, its schema description marks it deprecated and names
its replacement, and the tool refuses it **before reserving anything** with
`VALIDATION_FAILED`, `details.field`, and a message that states the condition and
the way out:

> A route cannot authorise a browser session that did not exist when it was
> published. Start this session with `allocate: false`, publish a route with
> `development_service_publish` — it will name this reservation — then call
> `browser_session_allocate`.

The refusal is audited. It precedes `create`, so there is no session to correlate
to and the record goes to the agent's project stream without a
`browser_session_id`, as an unresolvable session's does.

This is **not** the ADR-0020 shape and the difference is worth stating, because
the two look alike. ADR-0020 removed a vocabulary so that an authority could not
be *expressed*: "an agent cannot name a final disposition, so it cannot request
one." Here the authority is grantable and has moved to another tool. A property
naming an act the caller may perform elsewhere is a misrouted request, not an
unauthorised one, and a misrouted request deserves directions rather than
silence.

It is removed at the next major protocol version, and `docs/MCP_SPEC.md` §7.3
records that condition so the removal is a scheduled act rather than something a
later reader has to infer from a member that never worked.

The agent's order is:

```text
browser_session_start {allocate: false}   -> a REQUESTED reservation, in the MCP process
development_service_publish {...}         -> a route naming it (ADR-0021)
browser_session_allocate {browser_session_id, published_service_id}
```

`AUTHORISABLE_SESSION_STATUSES` in
`apps/mcp-server/src/development-services.ts:54` already includes `REQUESTED`
for exactly this, and its comment already says why. Step two needs no change.

### Allocation is two phases, split where the key is

**Phase one — request.** The MCP process resolves the route in the connection's
scope, resolves the reservation as one this agent session owns and has not
allocated, and writes `browser_sessions.requested_published_service_id` and the
`browser_session.requested` amendment in one transaction. It touches nothing
outside PostgreSQL. It mints nothing, contacts no worker and reaches no gateway.

**Phase two — complete.** The process holding the signing key claims the
reservation with a status-guarded `UPDATE ... WHERE status = 'REQUESTED'`, runs
the authorisation read below, mints, allocates on the worker and marks the
session `READY`, or fails the reservation carrying the stable class. `api` does
this inline for its own HTTP callers, and on a short interval for reservations
another process requested.

This is ADR-0021's shape, and it is warranted here for ADR-0021's reason and not
by analogy: the act needs a secret that exists in exactly one process, the
requesting process is deliberately built without it, and the alternatives are a
new network path or a new credential rather than a different arrangement of the
same ones. The grace before the sweep takes a reservation over is what keeps it
from racing the inline path, and the status guard is in the `UPDATE`, so a lost
race costs one wasted claim rather than two allocations for one request.

`browser_session_allocate` waits, bounded, and **the wait ends in the record as
it stands**. A reservation still `REQUESTED` or `ALLOCATING` when the deadline
passes is reported as such and never as ready: an agent that navigated to an
origin nothing was carrying would read the failure as a fault in the application
it is reviewing.

### One joined read is the authorisation, and both surfaces use it

`ServiceBinder.bind` gains `organisationId`, and `PublishedServiceBinder`
replaces its read-then-compare with a single query joining `browser_sessions`,
`projects`, `published_services` and `connectors`, in which the organisation, the
project, the route identifier and the session identifier are **all terms of one
predicate**. A row that satisfies some and not the others is never returned and
then refused by a later branch, and a route outside the caller's tenancy is
absent rather than forbidden (`docs/API.md` §5).

`scope = { organisationId: null, projectIds: [input.projectId] }` is not used.
It is safe by construction today — `findInScope`'s project term is specific and
non-null (`modules/published-services/repository.ts:192-199`), `projects.id` is
a global primary key and `projects.organisation_id` is `NOT NULL`, so the
project implies the organisation — but it is safe **only while `input.projectId`
is caller-derived**, which is a property of every caller rather than of the
binder. `scopeOf(connection)` in `apps/mcp-server/src/development-services.ts:64`
already returns both terms populated; that is the shape both surfaces adopt.

### A browser-session identifier that arrives as an argument is resolved in scope

`BrowserSessionService.allocate` reads through the unscoped
`get()` — `SELECT * FROM browser_sessions WHERE id = $1`
(`modules/browser-sessions/service.ts:466`) — and carries no caller scope at
all. Every authorisation it currently enjoys happens above it, in the route
layer, and it holds because today's callers name a session they have just
created or have already resolved.

`browser_session_allocate` takes a session identifier **as an argument**, so it
inherits none of that. It resolves through `getForScope` (`service.ts:492`),
whose identifier, project scope and organisation are one `WHERE` clause, before
the ownership check runs — and `allocate` itself takes the scope rather than
continuing to trust the caller that reached it.

`browserSessionIfPermitted` (`apps/mcp-server/src/tools.ts:340-354`) is not that
read: it calls the unscoped `get()` and compares `project_id` in an `if`
afterwards. It is corrected to `getForScope` in the same change, because a
second shape for "resolve a session in the caller's scope" is how the wrong one
gets copied.

This is the one place where the safer-looking option was not available. Binding
inside `browser_session_start`, where the session was created by the same call
and its identifier is not attacker-supplied, would have avoided the argument
entirely — and it cannot work, for the ordering reason above.

On the row it returns:

- the route must be `ready`, else `PUBLISHED_SERVICE_UNAVAILABLE` carrying
  `details.status`;
- the connector must be `ACTIVE`, else `IDENTITY_REVOKED` for a revoked identity
  and `CONNECTOR_OFFLINE` for one the deployment has and cannot reach, each
  carrying `details.connector_status`;
- the route must already name the session, else `AUTHORISATION_DENIED`.

`findPublishableConnector` gains the same status predicate, so a revoked
connector is refused before a row or a `published_service.requested` event is
written. Both publication surfaces reach `request()`, so that is one
implementation rather than two that must agree; the `status = 'ACTIVE'` filter in
`development-services.ts` remains as the rule for *which* connector to select and
stops being a second copy of the rule for *whether* one may be used. This is
RVP-81, and it is fixed here because this decision would otherwise be the second
place to write it.

`organisationId: null` is not used on either path. A project identifier implying
its organisation is a fact about other code, and this read does not depend on it.

### A refused allocation is audited, and it consumes no browser slot

Allocation is a lifecycle act. `docs/EVENTS.md` §7 already covers refused
lifecycle acts with `browser.command_rejected`, `kind: "lifecycle"`, and
`LifecycleAct` gains `allocate`. Every refusal writes one against the named
session, carrying the stable code and a reason token — including the capability
denial raised in `callTool` before any domain code runs, which is where RVP-49's
trap lies: a refusal that happens before the domain layer is a refusal the domain
layer cannot record. The MCP process writes the record for what it refuses; `api`
writes it for what it refuses.

Where the named session is not resolvable in the caller's scope there is no
session to correlate to, the refusal is `RESOURCE_NOT_FOUND`, and the record is
written against the agent's project stream with no `browser_session_id` — the
shape `modules/published-services/reconciliation.ts:174-199` already uses for a
route the control plane never had.

No new event type is added. Sharing one type is `docs/EVENTS.md` §7's own
argument: an auditor asks "did anything try to act on this session and get
refused?", and a second type would let an auditor who checked one and not the
other get a confident wrong answer.

`#failReservation` takes a **stable class** rather than the caught error's
message, and `browser_session.failed` carries `reason_code` from that closed
vocabulary. A refusal recorded as free text is not a refusal an auditor can
query for, and the publication path had already established the rule this one
was breaking.

The idempotency machinery is left as it is. `callTool` releases the key on a
refusal, justified in its own comment as "a refused call wrote nothing" — which
is not true here, because `create` has already written a session row, a control
lease and a `browser_session.requested` event. The behaviour is nonetheless
right: a retry re-runs rather than replaying, and re-running is what an agent
that fixed its arguments needs. The row the first attempt left behind is `FAILED`
with `ended_at` set (`service.ts:1350-1354`) and the capacity query excludes
`FAILED` outright (`service.ts:212-221`), so the first attempt costs nothing that
the second one needs. `browser_session_allocate` names a reservation that already
exists, so it cannot create a second one whatever the key does.

**No refusal consumes a browser slot.** `browser_session_allocate` names a
reservation that already exists, so no call on this path creates one; and every
failure between the claim and the worker's answer reaches `#failReservation`
(`modules/browser-sessions/service.ts:454-464`), which ends the reservation so it
stops counting against the worker's capacity. That rule is not new caution: four
refused starts filling a default worker until no session could be started in the
project at all is the incident recorded at `service.ts:305-313`.

### A reservation that nothing completes ends by itself

A reservation carrying a requested route is failed once it is older than the
allocation deadline, whatever state it is in. The sweep runs in `api` beside the
expiry and completion sweeps.

**`api`'s sweep is what releases the slot, and if `api` is down nothing releases
it until `api` returns.** That is a limit rather than a mechanism, and it is
stated here because the arithmetic makes it easy to write a sentence that hides
it: the MCP bounded wait is fifteen seconds and the allocation deadline is a
hundred and twenty, so a call whose wait has just expired can never also be past
the deadline. A failing call cannot release its own reservation, and a design
that read as though it could would be describing unreachable code.

The limit is worse than it first looks and is worth stating in full. During an
`api` outage the MCP process can still start **unbound** sessions — it holds the
worker credential and needs no key for those — so stranded reservations compete
for capacity with work that would otherwise succeed, and four of them fill a
default worker. That is the incident at `service.ts:305-313` reproduced by the
fix for it.

What narrows it, without pretending to close it, is an **opportunistic sweep
scoped to the calling agent session**: `browser_session_start` and
`browser_session_allocate` each fail the caller's *own* expired reservations
before doing anything else. It is one indexed query against rows the caller
already owns, so it stays inside the tenancy discipline the rest of this decision
insists on — the MCP process never performs a deployment-wide write. An agent
that keeps working therefore reclaims the slots it stranded, which is the case
that fills a worker; an agent that stops leaves its reservations for `api`.

This is the half of ADR-0021 that turned out to matter: "nothing stays in
`requested`" was kept by the route's own **lifetime** and not by a one-second
timer. A browser-session reservation had no lifetime, and a `REQUESTED` row with
`ended_at IS NULL` is exactly what the capacity query counts
(`service.ts:212-221`). So the deadline is the mechanism and the sweep is only
what notices.

The sweep touches only reservations that carry a requested route. A reservation
made with `allocate: false` and no route is somebody's in-progress work and is
left alone.

**The record.** Migration 0160 adds two nullable columns to `browser_sessions`,
`requested_published_service_id` and `allocation_requested_at`, and together they
are the whole handoff: the MCP process writes the route it was asked to bind and
the instant it asked, and `api` reads both.

`requested_published_service_id` carries a foreign key to `published_services`
with `ON DELETE SET NULL`. It is not load-bearing — the route identifier is
authorised by the joined read before it is ever written, and a route is ended by
a status transition rather than deleted — so nothing depends on the constraint
firing. It is there because a column that names a route and could hold an
identifier no route ever had is a column a later reader has to be careful about.

The pair's meaning is exact and is what makes each sweep a single predicate:
**non-null means "this reservation asked for a route and has not been bound to
one".** A successful bind writes `published_service_id` and `service_origin` and
**clears** both in the same statement, so a bound session never matches a sweep,
and the agent-facing view's `published_service_id` — "Published service this
session may reach" — stays true rather than becoming an intention. A database
constraint requires the two to be null or non-null together: a row carrying a
route and no timestamp would be invisible to the sweep for ever while still
counting against the worker's capacity.

`published_service_id` is not overloaded to carry the intention while the status
is `REQUESTED`. It would have avoided the first column and made that description
false for every pending reservation.

**The deadline** is
`allocation_requested_at + REVIEWPLANE_ALLOCATION_DEADLINE_SECONDS` (default
120). 120 seconds is comfortably past any legitimate completion — the worker call
is bounded by `workerRequestTimeoutMs`, a Chromium context takes seconds and the
MCP wait is thirty — and far inside a session's own `max_duration_seconds`.

**It is measured from when admission was asked for and never from when the
session was reserved,** and that is why the second column exists rather than the
deadline running off `created_at`. The agent's order is reserve, *then* publish a
route naming the reservation, *then* allocate — and the middle step is the slow
one: `docs/CONNECTOR_PROTOCOL.md` §11 gives a connector a ten-second startup
grace, a human choosing a route on the Live page takes as long as a human takes,
and nothing bounds the gap at all. A deadline measured from `created_at` would
fail the allocation of every reservation that spent longer than the deadline
becoming useful, and would fail it *at the moment the agent finally asked* —
which is the one moment the reservation is provably not abandoned. The sweep
would be at its most destructive exactly where the flow is working.

A reservation that asks for nothing still has no lifetime and still holds a slot;
this decision bounds the ones it creates, and the human `{"allocate": false}`
reservation of `docs/API.md` §11 is its own issue.

**The two states it must reach.** `REQUESTED` past the deadline means nothing
claimed it: `api` was down, or restarted before claiming. `ALLOCATING` past the
deadline means something claimed it and did not finish: `api` crashed mid-bind,
possibly after minting. Both are failed; the second also asks the worker to
terminate a context it may hold.

### A capability minted into a lost race is not left live

The `ALLOCATING` case has a race the guarded `UPDATE` does not close on its own.
`api` claims a reservation, mints, and is slow; the sweep — in another replica,
or in the same one a tick later — fails the row; `api` then calls `markReady`,
whose guard now matches nothing, correctly. **The capability has been minted and
the process that would have withdrawn it has just had its write rejected.**

Two mechanisms close it, because the mint can land on either side of the sweep.

**Mint after the fail: the capability row cannot be written.** `insertCapability`
takes the session's own liveness as a predicate of the insert —
`INSERT INTO route_capabilities (...) SELECT ... FROM browser_sessions WHERE id = $5 AND ended_at IS NULL AND status NOT IN ('TERMINATED', 'FAILED', 'TERMINATING')`
— so an insert for a session already failed writes nothing, `mint` raises, and
`bind` throws before returning. The signed token exists in memory and is
discarded there: it is never returned, never reaches `SessionAllocate`, and never
reaches a worker. This gives the mint the same property `markReady` and
`markFailed` already have — the losing side of a race writes nothing.

The predicate is **"has not ended"** and not the narrower `status = 'ALLOCATING'`,
because `POST /api/v1/published-services/:serviceId/capabilities`
(`docs/API.md` §10) legitimately mints for a `READY` or `ACTIVE` session a human
is already driving, and `ALLOCATING` would have refused every one of them. Ending
is the condition that makes a credential unaccountable; being past allocation is
not.

**Mint before the fail: the sweep withdraws what is there.** The sweep marks the
session `FAILED` and then withdraws the session's live capabilities — the gateway
first and the record second, for the reason revocation and reconnect
reconciliation already give: marking a record closed while the gateway still
carried it turns a closure into a claim. The withdrawal keys on
`route_capabilities.browser_session_id`, which is the leading pair of
`route_capabilities_service_idx` (`migrations/0021_route_capabilities.sql:29-30`),
so zero rows is the ordinary answer and costs an index probe.

**The two are not one transaction, and cannot be.** The gateway call is a network
request; a transaction held open across it would hold a row lock for the
gateway's timeout, and a gateway that is merely slow would stall the sweep. So the
ordering is the mechanism rather than atomicity, and the window it leaves is a
mint that lands between the sweep's `UPDATE` and its withdrawal query. That
window is closed from the other side by the insert predicate above: a mint
landing there finds the session already `FAILED` and writes nothing. Neither
mechanism alone is sufficient and both are present.

**The process that failed the row is the process that withdraws.** Usually that
is `api`. Where the caller-scoped opportunistic sweep failed it, the MCP process
withdraws — which it can do and this ADR has already said why: it withdraws and
does not mint, ADR-0021's carve-out applied to the credential rather than the
route. Nothing here gives the MCP process a minting path.

The residual is the one named above: while `api` is down and the calling agent
has stopped calling, a reservation stays `ALLOCATING` and any capability minted
for it stays live until its own expiry — which the session-lifetime bound above
is what limits.

`DEGRADED` is in the predicate too. `BrowserWorkerMonitor` marks an `ALLOCATING`
session no worker holds as `DEGRADED` (`modules/browser-sessions/monitor.ts`),
which would otherwise move an abandoned reservation out of the sweep's reach and
strand it. Admitting the third status is one predicate; making the two sweeps run
in a particular order would be a dependency between two timers, which is how this
class of defect arrives in the first place.

**Every transition is a status-guarded `UPDATE`,** so a duplicate costs a wasted
read rather than a second allocation or a double failure — the property
`markReady` and `markFailed` already rely on:

```sql
-- claim
UPDATE browser_sessions SET status = 'ALLOCATING'
 WHERE id = $1 AND status = 'REQUESTED'
-- select for the deadline
SELECT * FROM browser_sessions
 WHERE ended_at IS NULL
   AND status IN ('REQUESTED', 'ALLOCATING', 'DEGRADED')
   AND requested_published_service_id IS NOT NULL
   AND allocation_requested_at <= $1
```

The index is partial, on `allocation_requested_at` where
`requested_published_service_id IS NOT NULL AND ended_at IS NULL`.

**The event** is `browser_session.failed` with `trigger: "allocation_deadline"`,
distinguishing it from `allocation_refused`, and `reason_code:
CONTROL_PLANE_UNAVAILABLE` — the honest diagnosis in both states, since a
reservation nobody claimed and one somebody abandoned are both the control plane
not having been there. The payload carries the status the record was actually in,
for the reason the expiry sweep records
(`modules/published-services/service.ts`): a status it was never in is a fact an
auditor cannot see through.

`reason_code` is drawn from a **closed vocabulary named in the domain**
(`AllocationFailureClass`), whose members are the stable codes of
`docs/API.md` §5 and `docs/CONNECTOR_PROTOCOL.md` §21 — the same source
`published_service_failure_class` draws on — and anything unrecognised becomes
`INTERNAL_ERROR` rather than widening it at write time. It is not added to
`packages/protocol`: `browser.command_rejected` and `browser_session.failed` have
no per-type payload schema there, so a member declared for them would be
validated by nothing, and `docs/EVENTS.md` §7 already records that only an
assertion against the event store catches a renamed one. Declaring a vocabulary
the generator cannot enforce would look like a gate and be none.

### A capability may not outlive the session it was minted for

`mint` already refuses to let a capability outlive its route. It gains the
session as a second bound:

```text
expires_at = min(now + requested_ttl,
                 route.expires_at,
                 session.created_at + session.limits.max_duration_seconds)
```

This is the control this decision actually adds, and it is the one that holds
without depending on anything outside the control plane. A session's maximum
duration is already the deployment's statement of how long that browser may
exist (`DEFAULT_SESSION_LIMITS.max_duration_seconds`), and a credential that
outlives the browser it was minted for is a credential nobody is accounting for.

Revocation on top of it is **best effort and is described as such.** `terminate`,
`#failReservation` and a worker-reported `FAILED` or `TERMINATED` mark the
session's live capabilities revoked and tell the gateway, in that order — the
gateway first, for the reason revocation and reconnect reconciliation already
give: marking a record closed while the gateway still carried it turns a closure
into a claim. This gives `HttpTunnelGateway.revokeCapability` its first
production caller.

**What this does not do.** The gateway verifies from a signature without a
database read, and RVP-76 records that its revocation set is in-memory and does
not survive a restart. So a revocation recorded here is durable in the control
plane and not necessarily at the gateway, and this ADR claims nothing stronger.
Closing that is RVP-99. The TTL bound above is what stands in the meantime, and
it stands without the gateway's cooperation.

The port is `SessionCapabilityRevoker`, constructed in both processes. The MCP
process may **withdraw** a capability and still cannot mint one, which is
ADR-0021's existing carve-out for `development_service_unpublish` extended to the
credential rather than only to the route. That the gateway's control token is
unscoped means "withdraws, never registers" is restraint rather than authority —
also RVP-76's, and stated rather than assumed.

### No route is ever amended

The control plane does not add a session to a live route's
`allowed_browser_session_ids`. Doing so would require re-registering the route
with the gateway, and RVP-76 proves by execution that re-registering a route
identifier resurrects capabilities already revoked against it. It would also let
a credential holding `browser:control` but not `service:publish` reach a
development machine it could never have published a route to.

## Consequences

### Positive

- An agent can drive a browser at the application under review without a human
  performing a step for it, and the MCP process still holds no signing key.
- The reserve/allocate split has one description, and `docs/API.md` §11 and
  `docs/MCP_SPEC.md` §7.3 stop describing different mechanisms.
- RVP-81 is fixed at `findPublishableConnector`, where both publication surfaces
  reach it, rather than as a second copy beside the agent path. Putting the term
  in the SQL rather than in the caller also closes a check-then-use window on the
  MCP path, which resolves the connector and then publishes through it.
- A route capability can no longer outlive the browser session it was minted
  for, whatever the gateway does.
- A `REQUESTED` browser session that nothing can complete stops holding a
  worker slot indefinitely.
- The organisation is a term of the binding query on **both** surfaces, so the
  RVP-91 and RVP-92 class is not reachable through the binder.
- A refused allocation is queryable by a stable class instead of by matching an
  exception's text.
- An agent that sends the old argument is told the new flow and the refusal is
  recorded, rather than meeting a validator message nothing wrote down.

### Negative

- An agent's session start becomes three calls where the schema implied one.
  The tool descriptions and the §7.3 text carry the order, and a start that
  names a route without a reservation is refused with a message that states it,
  but an agent that has read neither will get there by refusal.
- `browser_session_start_input` carries a member that can only be refused, until
  the next major protocol version retires it. The schema description says so, and
  a reader who finds it will still have to be told why it is there.
- One migration for **two** nullable columns and a check constraint, on a table
  that needed none. Overloading `published_service_id` as "requested" while the
  status is `REQUESTED` would have avoided the first and would have made the
  agent-facing view's own description — "Published service this session may
  reach" — untrue for a session that may reach nothing yet. The second,
  `allocation_requested_at`, is the price of a deadline that cannot fire on a
  reservation whose agent is still preparing a route for it.
- A second sweep interval in `api`, and a second place a status-guarded `UPDATE`
  has to stay guarded.
- **A stranded reservation is released by `api` and by nothing else.** The
  caller-scoped opportunistic sweep narrows it to agents that keep working; an
  agent that stops calling while `api` is down leaves its slot held, and any
  capability minted into a lost race live, until `api` returns. The MCP process
  can still start unbound sessions during that outage, so the held slots are not
  merely idle bookkeeping — they compete with work that would succeed.
- **The capability revocation this change adds is not durable on its own.** It is
  recorded in the control plane and notified to the gateway, and the gateway's
  revocation set is in-memory (RVP-76). A deployment that restarts its gateway
  between a revocation and a capability's natural expiry has a revoked
  capability the gateway would accept again. The TTL bound is what limits that
  window; RVP-99 is what closes it. Anyone reading this ADR for the guarantee
  should read this paragraph and not the section heading.
- Bounding the mint by the session's maximum duration makes the credential's
  lifetime depend on a `limits` value that an operator can raise. It is a bound
  and not a guarantee of shortness.
- Allocation latency now includes at most one sweep interval when the request
  came from the MCP process. A Chromium context takes longer than the sweep, so
  the sweep is not what dominates it.

## Alternatives considered

- **Document the limitation and stop** (RVP-90 option 1). Rejected by the
  maintainer. It also leaves `docs/MCP_SPEC.md` §7.3 pointing an agent at a
  human path that does not work.
- **Give the MCP process the signing key.** It would not have worked: the
  ordering, not the key, is what refuses `browser_session_start
  {published_service_id}`, and the refusal would have moved from
  `UNSUPPORTED_CAPABILITY` to `AUTHORISATION_DENIED`. It would also undo the one
  property ADR-0020 and ADR-0021 built the agent surface with.
- **An internal HTTP route on `api` that the MCP process calls.** Rejected in
  ADR-0021 for publication and rejected again here for the same reason: a
  credential that can be stolen, added to solve a problem of process topology
  rather than of authority.
- **Have the browser worker fetch its own capability from `api`** over the
  worker channel it already has. It removes the sweep and the wait, and it is the
  most attractive of the rejected options. It puts a credential-issuing route on
  the internal surface reachable with a semi-trusted component's credential, and
  it splits allocation into "origin now, credential later", so a session can
  reach `READY` with nothing that works. The handoff design is only safe because
  `api` re-checks the route's own allow-list; making a **worker** the trigger
  widens who can ask for that check to be run in its favour.
- **A durable job.** The job runner does hold the signing key, so ADR-0021's
  objection does not apply — but a job **retries**, with exponential backoff to
  five minutes, and a reservation must not be retried: it holds a worker slot
  while it waits. Allocation is a single attempt that succeeds or fails the
  reservation. It would also need a new `job_kind` member, which is a protocol
  change for a mechanism whose semantics are wrong.
- **Add the session to the route's `allowed_browser_session_ids` on demand.** It
  is the only design in which `browser_session_start {published_service_id}`
  keeps working unchanged, which is what makes it tempting. It requires
  re-registering the route at the gateway, which RVP-76 shows resurrects revoked
  capabilities; it converts the allow-list from a control into a formality; and
  it grants reach to a credential that could not have published the route.
- **Let `browser_session_start` find the reservation the route names.** One
  fewer argument, and it sources the subject of the act from the record being
  authorised — the shape RVP-30's blocker rules out and ADR-0028 removed from the
  lifecycle routes. An agent holding two reservations could not say which one it
  meant.
- **Remove `published_service_id` from `browser_session_start_input`.** A clean
  schema, and it was this ADR's first draft. `docs/MCP_SPEC.md` §14 forbids it
  inside protocol version 1 without a major bump, and it would meet every agent
  written against the current §7.3 with a validator error that is neither
  actionable nor recorded. The tool description does tell an agent the new flow,
  but a tool description is read by a client that refreshes it and not by a
  prompt that was written last week.
- **Publish a route that authorises no session yet.** It removes the ordering
  problem at source and is refused by `docs/CONNECTOR_PROTOCOL.md` §11, by
  `PublishedServiceService.request` and by the gateway's own registry
  (`RejectNoSession`). Three layers agree; the reservation exists so that none of
  them has to be relaxed.

## Follow-up

- The web application has no reserve step and no allocate call, so
  `StartBrowserSession`'s route selector cannot succeed. It is fixed in this
  change, and `apps/web/test/ui/stub-control-plane.ts` is corrected to enforce
  `allowed_browser_session_ids` so the suite can see the difference.
- A `REQUESTED` reservation created through `POST /projects/:projectId/browser-sessions`
  with `{"allocate": false}` and no route still has no lifetime and still holds a
  worker slot. This decision bounds the reservations it creates; the human one is
  its own issue.
- Every tool's capability denial in `apps/mcp-server/src/tools.ts` `callTool` is
  refused before the domain layer and audited only for the lifecycle acts this
  decision covers. The general case is the same RVP-49 shape and should be
  closed once rather than per tool.
- RVP-99 carries the revocation gap this decision bounds but does not close.
- The two publication surfaces resolve a connector differently in a second way
  this decision does **not** settle: `findPublishableConnector` admits a
  connector attached to neither a project nor a project-bearing environment
  (`repository.ts:448-451`), and `connectorForProject` requires
  `environments.project_id` to match
  (`apps/mcp-server/src/development-services.ts:106-113`). Both columns are
  nullable (`migrations/0003_connectors.sql:12,33,57`), so such a connector is
  representable and the two surfaces disagree about whether it may carry a
  route. That is a question about connector tenancy — may one connector serve
  every project in an organisation? — with its answer in
  `docs/DOMAIN_MODEL.md` §8, not an authorisation defect. Deciding it inside
  this change would settle connector tenancy as a side effect of an agent
  protocol change. It needs its own issue.
- `docs/MCP_SPEC.md` §12's enumeration does not contain several codes the MCP
  server already emits — `ROUTE_EXPIRED`, `DESTINATION_NOT_ALLOWED`,
  `WORKSPACE_NOT_FOUND`, `ROUTE_LIMIT_EXCEEDED`, `VALIDATION_FAILED` — because
  `refusalEnvelope` casts the domain's code rather than validating it. This
  change adds `IDENTITY_REVOKED` to the enumeration and should repair the rest
  with it.
- ADR-0021's consequences describe the `mcp` process's tunnel credential by the
  operation it performs rather than by the authority it carries, which RVP-76
  records as a defect in that ADR. This decision extends that credential's use to
  capability withdrawal and states the authority in the section above; ADR-0021's
  own wording is amended by whichever of the two changes lands first.
